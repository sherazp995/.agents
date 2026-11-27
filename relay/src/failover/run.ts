/**
 * The daemon side of failover (README, "Failover"). Both laptops run the
 * whole daemon and answer Slack; this runner only decides which one is the
 * default laptop, by claiming and renewing the "default laptop" record, and
 * reacts to three things the shared database tells it:
 *
 * - Losing the record (expired, taken, or handed back to the preferred
 *   laptop) only makes this laptop stop being the default. Slack, running
 *   turns and the schedulers carry on; nothing drains or exits.
 * - A database this laptop cannot reach for the trust window: it closes its
 *   Slack connection, so Slack sends every event to the other laptop instead
 *   of to a socket that cannot save them, and reconnects once the database
 *   answers again.
 * - A database with a migration this build does not know: it closes Slack
 *   and takes no work until Relay here is updated, since its queries may not
 *   match the schema. Another laptop asking to pause before it migrates: it
 *   stops starting work until that request is withdrawn.
 *
 * Trust is kept apart from the record's own expiry: the laptop stops
 * counting itself the default after 40 seconds of its own wall clock
 * without a renewal, while the record only expires after 60 seconds of
 * database time, so two laptops never both count themselves the default.
 */

import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'
import {
  boundedLeaseDb,
  claimLease,
  LEASE_TTL_SECONDS,
  newerAppliedMigration,
  pauseRequestedByOther,
  publishReminderChannels,
  raiseWantsBack,
  registerHost,
  releaseLease,
  renewLease,
  setPausedAt,
  touchHost,
  type HostRegistration,
  type LeaseDb,
} from './lease.js'
import type { FailoverGate } from './types.js'

export type FailoverTimings = {
  /** The wait between rounds: claim or renew, and every check below. */
  readonly renewMs: number
  /** How long after a successful renewal this laptop still counts itself the default, and how long without the database before it leaves Slack. */
  readonly trustMs: number
  readonly ttlSeconds: number
  /** The limit on each failover database request. */
  readonly queryMs: number
}

export const DEFAULT_FAILOVER_TIMINGS: FailoverTimings = {
  renewMs: 15_000,
  trustMs: 40_000,
  ttlSeconds: LEASE_TTL_SECONDS,
  queryMs: 5_000,
}

/**
 * The default wait between rounds. The timer stays referenced on purpose: a
 * laptop that has closed Slack (no database, or an older build) holds no
 * other handle, so an unreferenced timer would let Node exit cleanly and
 * launchd would not restart it. Shutdown is not held up, since every wait
 * races the stop signal.
 */
export function roundSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** What the runner needs from the running daemon, attached once it has started. */
export type RoleHooks = {
  /** Opens (true) or closes (false) the Slack connection. */
  setSlack(connected: boolean): Promise<void>
  /** Stops starting new work (true) or resumes (false), for another laptop's migration. */
  setPaused(paused: boolean): Promise<void>
}

export type FailoverRunnerOptions = HostRegistration & {
  readonly pool: Pool
  readonly log: Logger
  /** The Slack reminder channels this laptop's config lists (README, "Reminders"). */
  readonly reminderChannels?: readonly string[]
  readonly timings?: Partial<FailoverTimings>
  /** Wall clock in milliseconds; injected by tests. */
  readonly now?: () => number
  /** Injected by tests to drive the loop by hand. */
  readonly sleep?: (ms: number) => Promise<void>
}

export class FailoverRunner implements FailoverGate {
  readonly host: string
  readonly #registration: HostRegistration
  readonly #reminderChannels: readonly string[]
  readonly #db: LeaseDb
  readonly #log: Logger
  readonly #timings: FailoverTimings
  readonly #now: () => number
  readonly #sleepFor: (ms: number) => Promise<void>

  #generation: string | null = null
  #renewedAt = Number.NEGATIVE_INFINITY
  /** When a database request last succeeded, by this laptop's clock; startup counts as one. */
  #databaseSeenAt: number
  #slackWanted = true
  #slackOpen = true
  #paused = false
  #olderBuild = false
  #stopped = false
  #loop: Promise<void> | null = null
  #round: Promise<void> | null = null
  readonly #stopSignal: Promise<void>
  #signalStop: () => void = () => {}
  #hooks: RoleHooks | null = null

  constructor(options: FailoverRunnerOptions) {
    this.host = options.name
    this.#registration = { name: options.name, home: options.home, buildMigration: options.buildMigration, preferred: options.preferred }
    this.#reminderChannels = options.reminderChannels ?? []
    this.#log = options.log
    this.#timings = { ...DEFAULT_FAILOVER_TIMINGS, ...options.timings }
    this.#db = boundedLeaseDb(options.pool, this.#timings.queryMs)
    this.#now = options.now ?? Date.now
    this.#sleepFor = options.sleep ?? roundSleep
    this.#databaseSeenAt = this.#now()
    this.#stopSignal = new Promise((resolve) => (this.#signalStop = resolve))
  }

  /** Adds or refreshes this laptop's row; run before migrations, so it writes only columns every build has. */
  async register(): Promise<void> {
    await registerHost(this.#db, this.#registration)
  }

  /** Publishes this laptop's reminder channels; run once migrations have added the column. */
  async publish(): Promise<void> {
    await publishReminderChannels(this.#db, this.host, this.#reminderChannels)
  }

  isDefault(): boolean {
    return this.#generation !== null && this.#now() - this.#renewedAt <= this.#timings.trustMs
  }

  /** True while this laptop stopped starting work for another laptop's migration. */
  isPaused(): boolean {
    return this.#paused
  }

  /** Gives the running daemon's Slack and pause controls to the runner, and starts its rounds. */
  attach(hooks: RoleHooks): void {
    this.#hooks = hooks
    this.#loop ??= this.#run()
  }

  /** One round, awaited; rounds never overlap. For tests and the loop. */
  async round(): Promise<void> {
    this.#round ??= this.#doRound().finally(() => {
      this.#round = null
    })
    await this.#round
  }

  /** Clean shutdown: ends the loop and releases the record at once so the other laptop need not wait out its expiry. */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#signalStop()
    await this.#round
    const generation = this.#generation
    this.#generation = null
    if (generation === null) return
    await releaseLease(this.#db, this.host, generation).catch((error: unknown) => {
      this.#log.error({ err: error }, 'failover: could not release the default record on stop; it expires on its own')
    })
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      await this.round()
      await Promise.race([this.#sleepFor(this.#timings.renewMs), this.#stopSignal])
    }
  }

  async #doRound(): Promise<void> {
    if (this.#stopped) return
    const startedAt = this.#now()
    try {
      await touchHost(this.#db, this.host)
      this.#databaseSeenAt = startedAt
      if (await this.#checkBuild()) {
        await this.#checkPause()
        await this.#holdRecord(startedAt)
      }
    } catch (error) {
      this.#log.error({ err: error }, 'failover: a round against the database failed; trying again')
    }
    // Leaving Slack when the database is gone: an event this laptop cannot save would only wait for Slack's few retries.
    const databaseGone = this.#now() - this.#databaseSeenAt > this.#timings.trustMs
    if (databaseGone && this.#slackWanted) this.#log.warn({ host: this.host }, 'failover: the database has not answered for the trust window; leaving Slack until it does')
    if (!databaseGone && !this.#slackWanted && !this.#olderBuild) this.#log.info({ host: this.host }, 'failover: the database answers again; reconnecting to Slack')
    this.#slackWanted = !databaseGone && !this.#olderBuild
    await this.#applySlack()
  }

  /** False once the database has a migration this build does not know: this laptop then stops being the default. */
  async #checkBuild(): Promise<boolean> {
    const newer = await newerAppliedMigration(this.#db, this.#registration.buildMigration)
    if (newer === null) return true
    if (!this.#olderBuild) {
      this.#log.error(
        { host: this.host, build: this.#registration.buildMigration, database: newer },
        'failover: the database has a migration this build does not know; leaving Slack and taking no work until Relay here is updated',
      )
      this.#olderBuild = true
      // Off Slack is not enough: its schedulers and the router would still take this laptop's own threads on a schema it does not know.
      await this.#hooks?.setPaused(true)
      this.#paused = true
    }
    await this.#giveUpRecord()
    return false
  }

  async #checkPause(): Promise<void> {
    const requested = await pauseRequestedByOther(this.#db, this.host)
    if (requested === this.#paused) {
      if (requested) await setPausedAt(this.#db, this.host, true)
      return
    }
    // The daemon stops (or resumes) first, so the acknowledgement is true when the other laptop reads it.
    await this.#hooks?.setPaused(requested)
    await setPausedAt(this.#db, this.host, requested)
    this.#paused = requested
    this.#log.warn({ host: this.host }, requested ? 'failover: another laptop is migrating the database; starting no new work until it finishes' : 'failover: the other laptop withdrew its pause; starting work again')
  }

  /** Renew the record if ours, hand it back to a returning preferred laptop, or claim it when free. */
  async #holdRecord(startedAt: number): Promise<void> {
    if (this.#generation !== null) {
      const renewal = await renewLease(this.#db, this.host, this.#generation, this.#timings.ttlSeconds)
      if (!renewal.held) {
        this.#generation = null
        this.#log.warn({ host: this.host }, 'failover: this laptop is no longer the default; it keeps answering its own threads')
      } else if (renewal.wantsBack && !this.#registration.preferred) {
        await this.#giveUpRecord()
        this.#log.info({ host: this.host }, 'failover: handed the default record back to the preferred laptop')
        return
      } else {
        this.#renewedAt = startedAt
        return
      }
    }
    const generation = await claimLease(this.#db, this.host, this.#timings.ttlSeconds)
    if (generation !== null) {
      this.#generation = generation
      this.#renewedAt = startedAt
      this.#log.info({ host: this.host, generation }, 'failover: this laptop is now the default')
      return
    }
    if (this.#registration.preferred) await raiseWantsBack(this.#db, this.host)
  }

  async #giveUpRecord(): Promise<void> {
    const generation = this.#generation
    this.#generation = null
    if (generation !== null) await releaseLease(this.#db, this.host, generation)
  }

  async #applySlack(): Promise<void> {
    if (this.#hooks === null || this.#slackOpen === this.#slackWanted) return
    try {
      await this.#hooks.setSlack(this.#slackWanted)
      this.#slackOpen = this.#slackWanted
    } catch (error) {
      this.#log.error({ err: error, connect: this.#slackWanted }, 'failover: changing the Slack connection failed; trying again next round')
    }
  }
}
