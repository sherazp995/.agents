/**
 * The daemon side of failover (README, "Failover"): wait as standby until
 * the record is ours, renew it, and step down when it is lost or handed
 * back. This is the FailoverGate the rest of Relay asks before taking work.
 *
 * Trust is kept apart from the record's own expiry: the laptop stops
 * trusting its claim after 40 seconds of its own wall clock without a
 * renewal, while the record only expires after 60 seconds of database time,
 * so the two laptops never both believe they answer.
 */

import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'
import {
  claimLease,
  hostHasRunningWorkers,
  LEASE_TTL_SECONDS,
  newerAppliedMigration,
  raiseWantsBack,
  registerHost,
  releaseLease,
  renewLease,
  stillHolds,
  touchHost,
  type HostRegistration,
} from './lease.js'
import type { FailoverGate } from './types.js'

export type FailoverTimings = {
  /** Standby poll and drain poll. */
  readonly pollMs: number
  readonly renewMs: number
  /** How long after a successful renewal this laptop still trusts its claim, by its own clock. */
  readonly trustMs: number
  readonly ttlSeconds: number
}

export const DEFAULT_FAILOVER_TIMINGS: FailoverTimings = { pollMs: 15_000, renewMs: 15_000, trustMs: 40_000, ttlSeconds: LEASE_TTL_SECONDS }

/**
 * The default wait between polls. The timer stays referenced on purpose: a
 * standby laptop holds no Slack socket and its idle database clients close,
 * so an unreferenced timer would let Node exit cleanly and launchd would not
 * restart it. Shutdown is not held up, since every wait races the stop signal.
 */
export function standbySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** What stepping down needs from the running daemon, attached once it has started. */
export type StepDownHooks = {
  /** Closes the Slack connection so Slack sends events to the laptop that answers. */
  closeSlack(): Promise<void>
  /** True while this process has work in flight that no worker row records. */
  busy(): boolean
  /** Ends the process; a non zero code makes launchd and systemd restart it as standby. */
  exit(code: number): void | Promise<void>
}

export type FailoverRunnerOptions = HostRegistration & {
  readonly pool: Pool
  readonly log: Logger
  readonly timings?: Partial<FailoverTimings>
  /** Wall clock in milliseconds; injected by tests. */
  readonly now?: () => number
  /** Injected by tests to drive the loops by hand. */
  readonly sleep?: (ms: number) => Promise<void>
}

export class FailoverRunner implements FailoverGate {
  readonly host: string
  readonly #registration: HostRegistration
  readonly #pool: Pool
  readonly #log: Logger
  readonly #timings: FailoverTimings
  readonly #now: () => number
  readonly #sleepFor: (ms: number) => Promise<void>

  #generation: string | null = null
  #renewedAt = Number.NEGATIVE_INFINITY
  #released = false
  #steppingDown: Promise<void> | null = null
  #stopped = false
  readonly #stopSignal: Promise<void>
  #signalStop: () => void = () => {}
  #hooks: StepDownHooks | null = null
  #hooksAttached: () => void = () => {}
  readonly #hooksReady: Promise<void>
  #olderBuildLogged = false

  constructor(options: FailoverRunnerOptions) {
    this.host = options.name
    this.#registration = { name: options.name, home: options.home, buildMigration: options.buildMigration, preferred: options.preferred }
    this.#pool = options.pool
    this.#log = options.log
    this.#timings = { ...DEFAULT_FAILOVER_TIMINGS, ...options.timings }
    this.#now = options.now ?? Date.now
    this.#sleepFor = options.sleep ?? standbySleep
    this.#stopSignal = new Promise((resolve) => (this.#signalStop = resolve))
    this.#hooksReady = new Promise((resolve) => (this.#hooksAttached = resolve))
  }

  async register(): Promise<void> {
    await registerHost(this.#pool, this.#registration)
  }

  /**
   * Polls as standby until the record is ours, then starts renewing it.
   * False when stopped first (the daemon is shutting down).
   */
  async waitForClaim(): Promise<boolean> {
    while (!this.#stopped) {
      try {
        if (await this.tryClaim()) {
          void this.#renewLoop()
          return true
        }
      } catch (error) {
        this.#log.error({ err: error }, 'failover: could not check the record; trying again')
      }
      await this.#sleep(this.#timings.pollMs)
    }
    return false
  }

  /** One standby round: stay seen, refuse on an older build, claim, or (preferred) ask for the record back. */
  async tryClaim(): Promise<boolean> {
    await touchHost(this.#pool, this.host)
    const newer = await newerAppliedMigration(this.#pool, this.#registration.buildMigration)
    if (newer !== null) {
      if (!this.#olderBuildLogged) {
        this.#log.error(
          { host: this.host, build: this.#registration.buildMigration, database: newer },
          'failover: the database has a migration this build does not know; staying on standby until Relay is updated',
        )
        this.#olderBuildLogged = true
      }
      return false
    }
    // Read before the query: the database starts its 60 seconds after this, so trust ends first.
    const startedAt = this.#now()
    const generation = await claimLease(this.#pool, this.host, this.#timings.ttlSeconds)
    if (generation !== null) {
      this.#generation = generation
      this.#renewedAt = startedAt
      this.#log.info({ host: this.host, generation }, 'failover: this laptop now answers')
      return true
    }
    if (this.#registration.preferred) await raiseWantsBack(this.#pool, this.host)
    return false
  }

  /** One renewal; steps down when the record is gone, handed back, or not renewed within the trust window. */
  async renew(): Promise<void> {
    if (this.#generation === null || this.#steppingDown !== null) return
    const startedAt = this.#now()
    try {
      const renewal = await renewLease(this.#pool, this.host, this.#generation, this.#timings.ttlSeconds)
      if (!renewal.held) {
        this.stepDown('the failover record is no longer held by this laptop')
        return
      }
      this.#renewedAt = startedAt
      if (renewal.wantsBack && !this.#registration.preferred) {
        this.stepDown('the preferred laptop asked for the failover record back')
        return
      }
    } catch (error) {
      this.#log.error({ err: error }, 'failover: renewing the record failed')
    }
    if (!this.holdsFresh()) this.stepDown('the failover record was not renewed within the trust window')
  }

  holdsFresh(): boolean {
    return (
      this.#generation !== null &&
      !this.#released &&
      this.#steppingDown === null &&
      this.#now() - this.#renewedAt <= this.#timings.trustMs
    )
  }

  async mayStartWork(): Promise<boolean> {
    if (!this.holdsFresh() || this.#generation === null) return false
    try {
      return await stillHolds(this.#pool, this.host, this.#generation)
    } catch (error) {
      this.#log.error({ err: error }, 'failover: could not confirm the record before starting work')
      return false
    }
  }

  /** Gives the running daemon's pieces to stepDown; a step down that began earlier waits for them. */
  attach(hooks: StepDownHooks): void {
    this.#hooks = hooks
    this.#hooksAttached()
  }

  stepDown(reason: string): void {
    if (this.#steppingDown !== null) return
    this.#steppingDown = this.#drain(reason).catch((error: unknown) => {
      this.#log.error({ err: error }, 'failover: stepping down failed')
    })
  }

  /** Resolves once a step down has run to its exit; for tests and shutdown. */
  async steppedDown(): Promise<void> {
    await this.#steppingDown
  }

  /**
   * Clean shutdown: ends the loops and hands the record over at once rather
   * than making the other laptop wait out the expiry.
   */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#signalStop()
    if (this.#steppingDown === null) await this.#release()
  }

  async #renewLoop(): Promise<void> {
    while (!this.#stopped && this.#steppingDown === null) {
      await this.#sleep(this.#timings.renewMs)
      if (this.#stopped) return
      await this.renew()
    }
  }

  /**
   * Stop taking Slack events, release so the other laptop can claim, then
   * let running workers finish and post (their task leases keep renewing on
   * their own) while staying seen, and exit non zero.
   */
  async #drain(reason: string): Promise<void> {
    this.#log.warn({ host: this.host, reason }, 'failover: stepping down; finishing running work, then restarting as standby')
    await Promise.race([this.#hooksReady, this.#stopSignal])
    const hooks = this.#hooks
    if (hooks === null) return
    await hooks.closeSlack().catch((error: unknown) => {
      this.#log.error({ err: error }, 'failover: closing the Slack connection failed')
    })
    await this.#release()
    while (!this.#stopped && (hooks.busy() || (await this.#hasRunningWorkers()))) {
      await touchHost(this.#pool, this.host).catch((error: unknown) => {
        this.#log.error({ err: error }, 'failover: could not update the last seen time of this laptop')
      })
      await this.#sleep(this.#timings.pollMs)
    }
    if (this.#stopped) return
    this.#log.info({ host: this.host }, 'failover: running work finished; exiting so the supervisor restarts Relay as standby')
    await hooks.exit(1)
  }

  async #hasRunningWorkers(): Promise<boolean> {
    try {
      return await hostHasRunningWorkers(this.#pool, this.host)
    } catch (error) {
      // Unknown counts as busy: exiting would orphan a worker that is still posting.
      this.#log.error({ err: error }, 'failover: could not check for running workers')
      return true
    }
  }

  async #release(): Promise<void> {
    const generation = this.#generation
    if (generation === null || this.#released) return
    this.#released = true
    await releaseLease(this.#pool, this.host, generation).catch((error: unknown) => {
      // The record then expires on its own after the TTL.
      this.#log.error({ err: error }, 'failover: releasing the record failed')
    })
  }

  #sleep(ms: number): Promise<void> {
    return Promise.race([this.#sleepFor(ms), this.#stopSignal])
  }
}
