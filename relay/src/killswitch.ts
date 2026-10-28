/**
 * FR-POL-9's global kill switch: stops all runs, releases locks, aborts
 * in-flight tool calls, and refuses new work until cleared, taking effect
 * mid-action within five seconds.
 *
 * THE P0.3 LESSON THIS DESIGN IS BUILT AROUND. P0.3 shipped a Stop
 * mechanism whose cancellation itself measured two milliseconds, and it
 * still could not be reached from Slack within the five second bound: the
 * Slack adapter's own inbound delivery queue processed messages one at a
 * time, so a Stop sent while a run was active queued BEHIND that run and
 * never got a chance to fire until the run it was meant to interrupt had
 * already finished on its own. The fix was structural: a Stop bypasses the
 * queue entirely rather than joining it. `engage()` below applies the same
 * principle at this seam: the actual stopping effect (cancelling every
 * registered run) is the FIRST thing it does, synchronously, before
 * anything else, so nothing this class does afterward (persisting the
 * engaged state, releasing locks) can ever delay it. See `engage()`'s own
 * comment, and this file's own SELF-ATTACK test, which proves that
 * ordering is load-bearing by reversing it and watching the timing bound
 * break.
 *
 * THE HONEST GUARANTEE, per DEC-1 and src/runs/cancel.ts's own precedent.
 * "Stopped within five seconds," never "stopped cleanly." A run this
 * engages is cancelled the same way a single Stop cancels it
 * (src/runs/cancel.ts's `CancellationToken.cancel`), which is termination
 * of a subprocess, not cooperation: a killed engine can leave a
 * half-finished side effect with no chance to record it. This module
 * inherits that guarantee rather than improving on it; a kill switch is
 * "every run's Stop, fired at once," not a stronger mechanism.
 *
 * UNWIRED, STATED PLAINLY. Nothing in src/agent/loop.ts or
 * src/orchestrator.ts calls into this file yet: both are held by Task 3's
 * session-attachment work. This module is the core mechanism plus its own
 * proof that the mechanism is fast and does not serialise behind anything,
 * using the same CancellationRegistry/CancellationToken primitives P0.3
 * already proved real (a real `CancellationRegistry` instance satisfies
 * `RunCanceller` below with no adapter needed). The actual wiring, a real
 * orchestrator's `CancellationRegistry` passed in as `runCanceller`,
 * `refuseIfEngaged()` called before a new run starts, and a real
 * `LockReleaser` once a lock manager exists, is not built here. On this
 * project an unwired mechanism has twice been mistaken for a working one;
 * this paragraph exists so that does not happen a third time.
 */

import type { Pool } from 'pg'

/**
 * The narrow seam a caller supplies to make `engage()` actually stop
 * something. `src/runs/cancel.ts`'s `CancellationRegistry` already
 * satisfies this exactly (`cancelAll(reason?: string): void`), so a real
 * caller can pass its own `CancellationRegistry` instance directly;
 * nothing here requires a purpose-built adapter. Narrower than
 * `CancellationRegistry`'s full surface deliberately: a kill switch has no
 * business calling `register()` or `release()` on someone else's
 * registry, only `cancelAll()`.
 */
export interface RunCanceller {
  cancelAll(reason?: string): void
}

/**
 * FR-POL-9's "releases locks", for whichever real lock manager eventually
 * exists. No implementation of this interface exists in this codebase
 * yet: the only trace of a machine lock today is the `requiresMachineLock`
 * boolean field Task 1 added to `src/capabilities/registry.ts` per
 * FR-CAP-3, with nothing consuming it. FR-RUN-3, the actual leased-mutex
 * lock manager, is phase 1. This interface exists so a kill switch's shape
 * does not need to change the day that manager lands: `engage()` calls it
 * if one was supplied, and does nothing lock-related if not, which is the
 * honest behaviour today, since there is nothing to release.
 */
export interface LockReleaser {
  releaseAll(): void | Promise<void>
}

/** The engaged/cleared state a KillSwitchStore persists and reports back. `reason`/`engagedAt` are present only while `engaged` is true, mirroring `kill_switch_engaged_consistency`'s own CHECK constraint (0016_kill_switch.sql). */
export type KillSwitchState =
  | { readonly engaged: true; readonly reason: string; readonly engagedAt: Date }
  | { readonly engaged: false }

/**
 * Durable persistence for the engaged/cleared state, per FR-POL-9's "until
 * cleared" outliving a single process. Narrow: a kill switch never issues
 * SQL itself, only calls these three methods, so a test can supply an
 * in-memory fake instead of a real Postgres pool. `PostgresKillSwitchStore`
 * below is the real implementation, backed by `kill_switch`
 * (0016_kill_switch.sql).
 */
export interface KillSwitchStore {
  loadState(): Promise<KillSwitchState>
  recordEngaged(reason: string, engagedAt: Date, engagedBy?: string): Promise<void>
  recordCleared(clearedAt: Date): Promise<void>
}

/** Thrown by refuseIfEngaged(). Carries the engagement reason so a caller (eventually, a Slack reply) can tell the operator WHY new work is being refused, not just that it was. */
export class KillSwitchEngagedError extends Error {
  /**
   * Exposed as its own field, not only interpolated into the message,
   * because a caller telling the operator why work was refused should not
   * have to parse it back out of prose. The orchestrator's Slack reply
   * reads this directly.
   */
  readonly reason: string

  constructor(reason: string) {
    super(`refused: the kill switch is engaged (${reason})`)
    this.name = 'KillSwitchEngagedError'
    this.reason = reason
  }
}

export interface KillSwitchDeps {
  readonly runCanceller: RunCanceller
  readonly lockReleaser?: LockReleaser
  readonly store?: KillSwitchStore
}

const DEFAULT_REASON = 'operator kill switch'

export class KillSwitch {
  private engagedFlag: boolean
  private reason: string | undefined
  private engagedAt: Date | undefined
  private readonly runCanceller: RunCanceller
  private readonly lockReleaser: LockReleaser | undefined
  private readonly store: KillSwitchStore | undefined

  /**
   * `initialState` defaults to cleared, the only correct default for an
   * instance with nothing to hydrate from. A store-backed instance that
   * must reflect what happened before THIS process started should be
   * built with `createKillSwitch()` below instead of this constructor
   * directly.
   */
  constructor(deps: KillSwitchDeps, initialState: KillSwitchState = { engaged: false }) {
    this.runCanceller = deps.runCanceller
    this.lockReleaser = deps.lockReleaser
    this.store = deps.store
    this.engagedFlag = initialState.engaged
    this.reason = initialState.engaged ? initialState.reason : undefined
    this.engagedAt = initialState.engaged ? initialState.engagedAt : undefined
  }

  state(): KillSwitchState {
    if (this.engagedFlag && this.reason !== undefined && this.engagedAt !== undefined) {
      return { engaged: true, reason: this.reason, engagedAt: this.engagedAt }
    }
    return { engaged: false }
  }

  isEngaged(): boolean {
    return this.engagedFlag
  }

  /**
   * Idempotent: engaging an already-engaged switch is a safe no-op that
   * does not re-cancel or overwrite the original reason, matching
   * `CancellationToken.cancel`'s own idempotency for the same reason (a
   * second Stop must never throw or silently replace the first cause).
   *
   * ORDER IS THE WHOLE POINT, stated because getting this backwards is
   * exactly the P0.3 bug restated at a new seam. `cancelAll()` runs
   * FIRST, synchronously, as the first statement in this function, before
   * anything else happens. Everything after it (marking the in-memory
   * flag, releasing locks, persisting to the store) runs only once the
   * actual stopping signal has already been dispatched, so none of it can
   * delay that signal by so much as a tick, regardless of how slow a real
   * `LockReleaser` or `KillSwitchStore` turns out to be.
   *
   * Returns a Promise a caller MAY await for full durability confirmation
   * (useful for an operator-facing "kill switch engaged" reply that
   * should not claim success before the state has actually been
   * persisted), but does not NEED to: because this function's body runs
   * synchronously up to its first `await`, by the time `engage()` returns
   * control to its caller at all (awaited or not), `cancelAll()` has
   * already executed. See this file's own SELF-ATTACK test for the proof
   * that reversing this order breaks the timing bound.
   */
  async engage(reason: string = DEFAULT_REASON, engagedBy?: string): Promise<void> {
    if (this.engagedFlag) return
    this.runCanceller.cancelAll(reason)
    this.engagedFlag = true
    this.reason = reason
    this.engagedAt = new Date()
    await this.lockReleaser?.releaseAll()
    await this.store?.recordEngaged(reason, this.engagedAt, engagedBy)
  }

  /** Restores service: refuseIfEngaged() stops throwing once this resolves. Safe no-op if already cleared. Deliberately does not clear `reason`/`engagedAt` from the durable store's history; PostgresKillSwitchStore.recordCleared keeps them, so "what was the last engagement about" survives a clear. */
  async clear(): Promise<void> {
    if (!this.engagedFlag) return
    this.engagedFlag = false
    this.reason = undefined
    this.engagedAt = undefined
    await this.store?.recordCleared(new Date())
  }

  /** Call before starting any new run. Throws KillSwitchEngagedError, naming the reason, while engaged; a safe no-op otherwise. */
  /**
   * Re-reads the stored state and applies it in memory only, never writing
   * back, so a daemon picks up an engage or clear made by the CLI (or by
   * another process) within one tick. A change to engaged cancels every run,
   * as engage() does. Calls are serialized: a later caller awaits the one in
   * flight and then reads again, so a stale read can delay a change by one
   * call but never overwrite a newer one. A store failure rejects; callers
   * treat that as "deny" for the tick.
   */
  async refresh(): Promise<KillSwitchState> {
    const previous = this.refreshing
    const next = previous.catch(() => undefined).then(() => this.applyStoredState())
    this.refreshing = next
    return next
  }

  private refreshing: Promise<unknown> = Promise.resolve()

  private async applyStoredState(): Promise<KillSwitchState> {
    if (!this.store) return this.state()
    const stored = await this.store.loadState()
    if (stored.engaged && !this.engagedFlag) {
      this.runCanceller.cancelAll(stored.reason)
      this.engagedFlag = true
      this.reason = stored.reason
      this.engagedAt = stored.engagedAt
    } else if (!stored.engaged && this.engagedFlag) {
      this.engagedFlag = false
      this.reason = undefined
      this.engagedAt = undefined
    }
    return this.state()
  }

  refuseIfEngaged(): void {
    if (this.engagedFlag) {
      throw new KillSwitchEngagedError(this.reason ?? 'unknown reason')
    }
  }
}

/**
 * Constructs a KillSwitch hydrated from its durable store, if one is
 * supplied, so a freshly-started process does not silently forget an
 * engagement that happened before it restarted, per FR-POL-9's "until
 * cleared". Equivalent to `new KillSwitch(deps)` when no store is given,
 * which is the only correct default with nothing to hydrate from.
 */
export async function createKillSwitch(deps: KillSwitchDeps): Promise<KillSwitch> {
  const initialState = deps.store ? await deps.store.loadState() : ({ engaged: false } as const)
  return new KillSwitch(deps, initialState)
}

// ---------------------------------------------------------------------------
// The real, Postgres-backed KillSwitchStore. One row per workspace, per
// 0016_kill_switch.sql's own header comment on why this table is scoped by
// workspace_id rather than being a singleton.
// ---------------------------------------------------------------------------

type KillSwitchRow = {
  readonly engaged: boolean
  readonly reason: string | null
  readonly engaged_at: Date | null
}

export class PostgresKillSwitchStore implements KillSwitchStore {
  constructor(
    private readonly pool: Pool,
    private readonly workspaceId: string,
  ) {}

  /** No row at all (a workspace that has never engaged its kill switch) reports cleared, the same as a row with engaged=false; both are "nothing to refuse work over" from a caller's point of view. */
  async loadState(): Promise<KillSwitchState> {
    const { rows } = await this.pool.query<KillSwitchRow>(
      `SELECT engaged, reason, engaged_at FROM kill_switch WHERE workspace_id = $1`,
      [this.workspaceId],
    )
    const row = rows[0]
    if (!row || !row.engaged || row.reason === null || row.engaged_at === null) {
      return { engaged: false }
    }
    return { engaged: true, reason: row.reason, engagedAt: row.engaged_at }
  }

  /**
   * Upsert: a second engagement for a workspace that already has a row
   * (the common case, since KillSwitch.engage() is idempotent and a real
   * caller only reaches this once per genuine engagement, but a store
   * must not assume its own caller's idempotency guard is the only thing
   * protecting it) updates in place rather than violating the primary key.
   * Always clears `cleared_at`, since a fresh engagement supersedes
   * whatever the previous clear recorded.
   */
  async recordEngaged(reason: string, engagedAt: Date, engagedBy?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO kill_switch (workspace_id, engaged, reason, engaged_at, engaged_by, cleared_at, updated_at)
       VALUES ($1, true, $2, $3, $4, NULL, now())
       ON CONFLICT (workspace_id) DO UPDATE
         SET engaged = true, reason = $2, engaged_at = $3, engaged_by = $4, cleared_at = NULL, updated_at = now()`,
      [this.workspaceId, reason, engagedAt, engagedBy ?? null],
    )
  }

  /**
   * Deliberately does NOT null out `reason`/`engaged_at`: KillSwitch.clear's
   * own doc comment states why, the last engagement's history is worth
   * keeping, e.g. for an operator later asking "what was the kill switch
   * last engaged for". A workspace with no row yet (never engaged) has
   * nothing to clear; this UPDATE affects zero rows for one, which is the
   * correct outcome, not an error.
   */
  async recordCleared(clearedAt: Date): Promise<void> {
    await this.pool.query(`UPDATE kill_switch SET engaged = false, cleared_at = $2, updated_at = now() WHERE workspace_id = $1`, [
      this.workspaceId,
      clearedAt,
    ])
  }
}
