/**
 * The daemon side of failover (README, "Failover"): wait as standby until
 * the record is ours, renew it, recover it after a database blip, and step
 * down when it is lost or handed back. This is the FailoverGate the rest of
 * Relay asks before taking work, and the only code that decides to step down.
 *
 * Trust is kept apart from the record's own expiry: the laptop stops
 * trusting its claim after 40 seconds of its own wall clock without a
 * renewal, while the record only expires after 60 seconds of database time,
 * so the two laptops never both believe they answer.
 *
 * Recovery: once the record is reported gone or trust runs out, this laptop
 * takes no new work and retries. It gets the record back only through the
 * atomic renewal or claim, so a laptop holding the record always wins.
 */

import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'
import {
  boundedLeaseDb,
  claimLease,
  hostHasRunningWorkers,
  LEASE_TTL_SECONDS,
  newerAppliedMigration,
  raiseWantsBack,
  readLease,
  registerHost,
  releaseLease,
  renewLease,
  stillHolds,
  touchHost,
  type HostRegistration,
  type LeaseDb,
} from './lease.js'
import type { FailoverGate } from './types.js'

export type FailoverTimings = {
  /** Standby poll and drain poll. */
  readonly pollMs: number
  readonly renewMs: number
  /** How long after a successful renewal this laptop still trusts its claim, by its own clock. */
  readonly trustMs: number
  readonly ttlSeconds: number
  /** The limit on each failover database request. */
  readonly queryMs: number
  /** The wait between recovery tries. */
  readonly recoverRetryMs: number
  /** How long to try recovering when no other laptop was seen recently. */
  readonly recoverLimitMs: number
  /** The shorter limit when another laptop could be answering. */
  readonly recoverLimitWithOtherMs: number
}

export const DEFAULT_FAILOVER_TIMINGS: FailoverTimings = {
  pollMs: 15_000,
  renewMs: 15_000,
  trustMs: 40_000,
  ttlSeconds: LEASE_TTL_SECONDS,
  queryMs: 5_000,
  recoverRetryMs: 5_000,
  recoverLimitMs: 120_000,
  recoverLimitWithOtherMs: 75_000,
}

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
  /** The kinds of work in flight in this process that no worker row records; empty when none. */
  waitingOn(): readonly string[]
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
  readonly #db: LeaseDb
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

  /** Set while recovering; the deadline is fixed when the problem was first seen. */
  #recovery: { readonly deadline: number } | null = null
  /** Bumped on entering recovery, so a role check that started earlier cannot pass. */
  #recoveryEpoch = 0
  #firstFailureAt: number | null = null
  /** Unknown counts as seen: the shorter limit is the safe one when another laptop may answer. */
  #otherSeen = true
  /** A reclaim got no answer, so it may have committed; a record under this name may then be that claim. */
  #claimInDoubt = false
  #round: Promise<void> | null = null
  #wakeRenewLoop: () => void = () => {}

  constructor(options: FailoverRunnerOptions) {
    this.host = options.name
    this.#registration = { name: options.name, home: options.home, buildMigration: options.buildMigration, preferred: options.preferred }
    this.#log = options.log
    this.#timings = { ...DEFAULT_FAILOVER_TIMINGS, ...options.timings }
    this.#db = boundedLeaseDb(options.pool, this.#timings.queryMs)
    this.#now = options.now ?? Date.now
    this.#sleepFor = options.sleep ?? standbySleep
    this.#stopSignal = new Promise((resolve) => (this.#signalStop = resolve))
    this.#hooksReady = new Promise((resolve) => (this.#hooksAttached = resolve))
  }

  async register(): Promise<void> {
    await registerHost(this.#db, this.#registration)
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
    await touchHost(this.#db, this.host)
    const newer = await newerAppliedMigration(this.#db, this.#registration.buildMigration)
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
    const generation = await claimLease(this.#db, this.host, this.#timings.ttlSeconds)
    if (generation !== null) {
      this.#generation = generation
      this.#renewedAt = startedAt
      this.#log.info({ host: this.host, generation }, 'failover: this laptop now answers')
      return true
    }
    if (this.#registration.preferred) await raiseWantsBack(this.#db, this.host)
    return false
  }

  /** One renewal, or one recovery try while recovering. Steps down only on a handback, another holder, or the recovery limit. */
  async renew(): Promise<void> {
    if (this.#generation === null || this.#steppingDown !== null) return
    if (this.#recovery !== null) return this.#runRecoveryRound()
    const startedAt = this.#now()
    try {
      const renewal = await renewLease(this.#db, this.host, this.#generation, this.#timings.ttlSeconds)
      if (this.#steppingDown !== null) return
      if (this.#recovery !== null) return this.#runRecoveryRound()
      this.#otherSeen = renewal.otherSeen
      if (!renewal.held) {
        this.#beginRecovery('the failover record is no longer held by this laptop')
        return this.#runRecoveryRound()
      }
      this.#renewedAt = startedAt
      this.#firstFailureAt = null
      if (renewal.wantsBack && !this.#registration.preferred) {
        this.stepDown('the preferred laptop asked for the failover record back')
        return
      }
    } catch (error) {
      this.#firstFailureAt ??= startedAt
      this.#log.error({ err: error }, 'failover: renewing the record failed')
    }
    if (this.#steppingDown === null && !this.holdsFresh()) {
      this.#beginRecovery('the failover record was not renewed within the trust window')
      return this.#runRecoveryRound()
    }
  }

  holdsFresh(): boolean {
    return (
      this.#generation !== null &&
      !this.#released &&
      this.#steppingDown === null &&
      this.#recovery === null &&
      this.#now() - this.#renewedAt <= this.#timings.trustMs
    )
  }

  /** False refuses this work only. A failed check leaves the role alone; the renew loop decides what happens to it. */
  async mayStartWork(): Promise<boolean> {
    if (!this.holdsFresh() || this.#generation === null) return false
    const epoch = this.#recoveryEpoch
    try {
      const held = await stillHolds(this.#db, this.host, this.#generation)
      if (!held) {
        if (epoch === this.#recoveryEpoch) this.#beginRecovery('the failover record is no longer held by this laptop')
        return false
      }
      return epoch === this.#recoveryEpoch && this.holdsFresh()
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

  /** A no-op once stopped: stop() releases the record itself, and the pool closes right after. */
  stepDown(reason: string): void {
    if (this.#steppingDown !== null || this.#stopped) return
    this.#recovery = null
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
   * than making the other laptop wait out the expiry. A recovery try in flight
   * finishes first, so a record it just took is the one released.
   */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#signalStop()
    await this.#round
    if (this.#steppingDown === null) await this.#release()
  }

  async #renewLoop(): Promise<void> {
    while (!this.#stopped && this.#steppingDown === null) {
      const wait = this.#recovery !== null ? this.#timings.recoverRetryMs : this.#timings.renewMs
      await Promise.race([this.#sleep(wait), new Promise<void>((resolve) => (this.#wakeRenewLoop = resolve))])
      if (this.#stopped) return
      await this.renew()
    }
  }

  /** Stops trusting the role at once. The limit counts from the first failure, not from here. */
  #beginRecovery(reason: string): void {
    if (this.#recovery !== null || this.#steppingDown !== null) return
    this.#recoveryEpoch += 1
    const limit = this.#otherSeen ? this.#timings.recoverLimitWithOtherMs : this.#timings.recoverLimitMs
    this.#recovery = { deadline: (this.#firstFailureAt ?? this.#now()) + limit }
    this.#log.warn({ host: this.host, reason, limitMs: limit }, 'failover: recovering the role; new work waits')
    this.#wakeRenewLoop()
  }

  #runRecoveryRound(): Promise<void> {
    this.#round ??= this.#recoveryRound().finally(() => {
      this.#round = null
    })
    return this.#round
  }

  /** One try, always made even past the limit, so a laptop waking from sleep can still take a free record. */
  async #recoveryRound(): Promise<void> {
    try {
      await this.#tryRecover()
    } catch (error) {
      this.#log.error({ err: error }, 'failover: recovering the role failed; trying again')
    }
    const recovery = this.#recovery
    if (recovery !== null && !this.#stopped && this.#now() >= recovery.deadline) {
      this.stepDown('the failover record could not be recovered within the limit')
    }
  }

  /** The standby checks in order: database version, renew if still ours, claim if free, otherwise see who has it. */
  async #tryRecover(): Promise<void> {
    const generation = this.#generation
    if (generation === null) return
    const newer = await newerAppliedMigration(this.#db, this.#registration.buildMigration)
    if (newer !== null) {
      this.stepDown('the database has a migration this build does not know')
      return
    }
    if (this.#stopped || this.#steppingDown !== null) return
    const renewStartedAt = this.#now()
    const renewal = await renewLease(this.#db, this.host, generation, this.#timings.ttlSeconds)
    this.#otherSeen = renewal.otherSeen
    if (renewal.held) {
      if (renewal.wantsBack && !this.#registration.preferred) {
        this.stepDown('the preferred laptop asked for the failover record back')
        return
      }
      this.#resume(generation, renewStartedAt)
      return
    }
    if (this.#stopped || this.#steppingDown !== null) return
    const claimStartedAt = this.#now()
    let claimed: string | null
    try {
      claimed = await claimLease(this.#db, this.host, this.#timings.ttlSeconds)
    } catch (error) {
      this.#claimInDoubt = true
      throw error
    }
    if (claimed !== null) {
      this.#resume(claimed, claimStartedAt)
      return
    }
    const lease = await readLease(this.#db, this.host)
    if (lease.reservedByOther) {
      this.stepDown('another laptop asked for the failover record')
      return
    }
    if (!lease.live || (lease.holder === this.host && lease.generation === generation)) return
    // Laptops can share a name, so this record cannot be proven ours: never adopt it, wait for it to expire and claim again.
    if (lease.holder === this.host && this.#claimInDoubt) return
    this.stepDown('another laptop holds the failover record')
  }

  #resume(generation: string, renewedAt: number): void {
    this.#generation = generation
    this.#renewedAt = renewedAt
    this.#recovery = null
    this.#firstFailureAt = null
    this.#claimInDoubt = false
    this.#log.info({ host: this.host, generation }, 'failover: recovered the role; answering Slack')
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
    while (!this.#stopped) {
      const waiting = [...hooks.waitingOn(), ...(await this.#workerWait())]
      if (waiting.length === 0) break
      // Repeated on purpose: `relay status` reads only the end of the log.
      this.#log.warn({ host: this.host, waitingOn: waiting }, `failover: stepping down, waiting on ${waiting.join(', ')}`)
      await touchHost(this.#db, this.host).catch((error: unknown) => {
        this.#log.error({ err: error }, 'failover: could not update the last seen time of this laptop')
      })
      await this.#sleep(this.#timings.pollMs)
    }
    if (this.#stopped) return
    this.#log.info({ host: this.host }, 'failover: running work finished; exiting so the supervisor restarts Relay as standby')
    await hooks.exit(1)
  }

  async #workerWait(): Promise<string[]> {
    try {
      return (await hostHasRunningWorkers(this.#db, this.host)) ? ['worker processes'] : []
    } catch (error) {
      // Unknown counts as busy: exiting would orphan a worker that is still posting.
      this.#log.error({ err: error }, 'failover: could not check for running workers')
      return ['the database, to check for running workers']
    }
  }

  async #release(): Promise<void> {
    const generation = this.#generation
    if (generation === null || this.#released) return
    this.#released = true
    await releaseLease(this.#db, this.host, generation).catch((error: unknown) => {
      // The record then expires on its own after the TTL.
      this.#log.error({ err: error }, 'failover: releasing the record failed')
    })
  }

  #sleep(ms: number): Promise<void> {
    return Promise.race([this.#sleepFor(ms), this.#stopSignal])
  }
}
