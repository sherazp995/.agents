/**
 * Persists runs and steps against the `runs` and `steps` tables
 * (0007_agent_runs.sql). src/runs/state.ts owns the legal transition
 * graphs; this module is the only place that turns a transition into a SQL
 * write, so an illegal transition (see IllegalTransitionError) is caught
 * before it ever reaches Postgres, not after.
 *
 * SCOPE DECISION on what "persisted before execution" means for a step,
 * stated because src/agent/loop.ts's AP-5 proof depends on it: beginStep
 * inserts a step row already in state 'running', with started_at set,
 * rather than inserting 'pending' and then writing a second UPDATE to
 * 'running'. The loop always calls beginStep immediately before invoking
 * the corresponding capability, with nothing else happening in between, so
 * "recorded the intent" and "started executing" are the same instant for
 * this synchronous-per-step loop; collapsing them into one INSERT does not
 * lose any ordering guarantee AP-5 actually needs (a row visible before the
 * capability runs, and a second write after it completes), it only avoids
 * a redundant round trip. src/runs/state.ts's STEP_TRANSITIONS still models
 * 'pending' and its 'start' event for completeness and because a future
 * caller with a real queueing delay between "recorded" and "started" may
 * need it; store.ts simply does not exercise that edge today.
 */

import type { Pool, PoolClient } from 'pg'
import { scrubSecrets } from '../secrets/scrubber.js'
import type { RunEvent, RunState, StepEvent, StepState } from './state.js'
import { transitionRun, transitionStep } from './state.js'

export type Run = {
  id: string
  workspaceId: string
  sessionId: string
  principalId: string
  state: RunState
  plan: unknown | null
  deadLetterReason: string | null
  failureReason: string | null
  costUsd: number | null
  /** FR-ORC-1: bumped transactionally by every write this run makes to its own state, run-level or step-level. See 0009_run_transition_seq.sql's header comment. */
  transitionSeq: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
}

/** The policy mediation seam's final verdict for a step, per 0013_steps_policy_decision.sql. `null` for a step from before the seam existed, or (transiently) any step not yet completed: beginStep never sets this, only completeStep does. */
export type StepPolicyDecision = 'proceed' | 'refuse'

export type Step = {
  id: string
  runId: string
  workspaceId: string
  seq: number
  capability: string
  input: unknown
  state: StepState
  output: unknown | null
  error: string | null
  /** Which of the parent run's own transition_seq values this step's completion landed on. Null while the step is still 'running': it has not consumed one yet. */
  runTransitionSeq: number | null
  /** src/policy/engine.ts's MediationVerdict.outcome for this step, persisted per Task 3. See StepPolicyDecision's own doc comment for what `null` means. */
  policyDecision: StepPolicyDecision | null
  /** The human-readable reason behind policyDecision, scrubbed the same way `error` is. `null` exactly when policyDecision is `null`. */
  policyReason: string | null
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}

export type CreateRunParams = {
  workspaceId: string
  sessionId: string
  principalId: string
}

export type BeginStepParams = {
  runId: string
  workspaceId: string
  capability: string
  input: unknown
}

/** What completeStep records once a step has settled, one way or another. */
export type StepOutcome =
  | { event: 'succeed'; output: unknown }
  | { event: 'fail'; error: string }
  | { event: 'timeout'; error: string }
  | { event: 'cancel'; error: string }

type RunRow = {
  id: string
  workspace_id: string
  session_id: string
  principal_id: string
  state: RunState
  plan: unknown | null
  dead_letter_reason: string | null
  failure_reason: string | null
  cost_usd: string | null
  transition_seq: number
  created_at: Date
  updated_at: Date
  started_at: Date | null
  ended_at: Date | null
}

type StepRow = {
  id: string
  run_id: string
  workspace_id: string
  seq: string
  capability: string
  input: unknown
  state: StepState
  output: unknown | null
  error: string | null
  run_transition_seq: number | null
  policy_decision: StepPolicyDecision | null
  policy_reason: string | null
  created_at: Date
  started_at: Date | null
  ended_at: Date | null
}

/**
 * Serialises `value` to a JSON string and runs it through `scrubSecrets`
 * before it is ever written to a `runs` or `steps` row, per FR-SEC-2.
 *
 * DEFENCE IN DEPTH, stated because a reviewer caught this module relying on
 * a single point of failure for a security property before this function
 * existed: `src/agent/loop.ts` already renders outside content through
 * `renderForModel` (src/agent/untrusted.ts), which itself calls
 * `scrubSecrets`, before any of it reaches an engine call. That means a
 * secret embedded in the ORIGINAL task text is already scrubbed by the time
 * it could echo back into a capability's input or output. But this module
 * has no way to verify that invariant holds for every future caller and
 * every future capability; a capability that reads a secret from
 * elsewhere (a future one that calls an external API, for instance, not
 * `echo`) and returns it as output would bypass `renderForModel` entirely,
 * and nothing upstream would catch it. Scrubbing again here, at the actual
 * persistence boundary, is what makes "no secret reaches a step row" true
 * regardless of whether every upstream call site stays correct, which is
 * exactly the shape of gap this project has already been burned by once:
 * redaction present at every construction site but not at the output
 * boundary (see src/secrets/scrubber.ts's own header comment).
 *
 * Returns `null`, not the string `"null"` or `"undefined"`, for a value
 * `JSON.stringify` cannot represent (`undefined` itself, primarily), so a
 * caller can pass the result straight to a `jsonb` column parameter without
 * a second null check.
 */
function serializeAndScrub(value: unknown): string | null {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return null
  return scrubSecrets(serialized)
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    principalId: row.principal_id,
    state: row.state,
    plan: row.plan,
    deadLetterReason: row.dead_letter_reason,
    failureReason: row.failure_reason,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    transitionSeq: row.transition_seq,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    startedAt: row.started_at === null ? null : row.started_at.toISOString(),
    endedAt: row.ended_at === null ? null : row.ended_at.toISOString(),
  }
}

function toStep(row: StepRow): Step {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    // bigserial comes back over the wire as a string (pg does not assume a
    // JS number can hold every int8), safe to coerce here since a single
    // run's step count never approaches Number.MAX_SAFE_INTEGER.
    seq: Number(row.seq),
    capability: row.capability,
    input: row.input,
    state: row.state,
    output: row.output,
    error: row.error,
    runTransitionSeq: row.run_transition_seq,
    policyDecision: row.policy_decision,
    policyReason: row.policy_reason,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at === null ? null : row.started_at.toISOString(),
    endedAt: row.ended_at === null ? null : row.ended_at.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Gate fix, Blocker 6: FR-ORC-8's run timeout aborts the engine call and the
// capability call via AbortSignal, but a plain pool.query has no signal of
// its own, and src/db/pool.ts's Pool only bounds how long it takes to
// acquire a connection (connectionTimeoutMillis), never how long a query
// already running on one takes. A blocked statement or a blocked lock can
// therefore keep a run "alive" from Postgres's own point of view well past
// both the step and the run deadline.
//
// Every bounded call below applies its statement_timeout and lock_timeout
// via `SET LOCAL`, issued as the first statements INSIDE an explicit
// transaction, never a bare session-level `SET` before or outside one.
// Two reasons, not one:
//
//   - CORRECTNESS: `SET LOCAL` scopes automatically to the current
//     transaction and reverts the instant that transaction ends (COMMIT or
//     ROLLBACK), with no explicit RESET statement ever needed. A bare `SET`
//     has no such boundary: on a pooled connection, it silently persists as
//     a SESSION-level setting for whatever unrelated query reuses that same
//     connection next, unless the caller remembers to RESET it, which is
//     exactly the class of leak this design avoids by construction rather
//     than by discipline.
//   - A REAL REGRESSION THIS PROJECT HIT WHILE BUILDING THIS FIX, stated so
//     it is not silently rediscovered: an earlier version of this file used
//     `SET` before `BEGIN` and `RESET` after `COMMIT`, which meant a
//     single-statement call's row became visible to OTHER connections
//     (autocommit, immediately after the one INSERT or UPDATE) BEFORE this
//     function's own two RESET round trips had even started, let alone
//     finished. That widened, however slightly, the gap between "a step's
//     row is visible as 'running'" and "the capability call the step
//     describes has actually started", which test/runs/cancel.test.ts's own
//     GT-14 proof (a real subprocess, cancelled the instant its step is
//     observed running) hit directly: under load, a Stop could fire and be
//     fully processed in that gap, aborting the capability call "before it
//     started" rather than genuinely mid-flight, and the test's own proof
//     that a REAL, ALREADY-SPAWNED process gets killed had nothing to
//     observe. Wrapping even a single statement in its own BEGIN/COMMIT
//     closes that gap: the row is not visible to any other connection until
//     COMMIT, which is the very last thing this module does before the
//     call's own promise resolves, matching (not widening) the gap the
//     pre-Blocker-6 bare autocommit INSERT already had.
//
// `timeoutMs` is optional throughout, and when omitted, every function
// below behaves exactly as it did before Blocker 6: every call site in this
// module that is not on the live run-execution path (createRun, listSteps,
// and every test in this project's own suite that calls
// beginStep/completeStep/etc. directly) keeps working unchanged.
// src/agent/loop.ts is the one production caller that supplies a real
// value, derived from the run's own remaining deadline.
// ---------------------------------------------------------------------------

const MIN_DB_TIMEOUT_MS = 1

/**
 * A minimal, purpose-built shape rather than `Pool` or `PoolClient`
 * directly: `Pool.query` and `PoolClient.query` are independently
 * overloaded in `@types/pg`, and this module only ever calls `.query(text,
 * values)` and reads `.rows` / `.rowCount`, never anything else either
 * class offers. Both classes structurally satisfy this narrower shape.
 */
type Queryable = {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>
}

/** Checks out a client from the pool for the duration of `fn`, always releasing it afterward, whether `fn` resolves or throws. Applies no timeout of its own; see applyStatementAndLockTimeout for that, issued by callers that manage their own transaction. */
async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

/**
 * Issues the two `SET LOCAL` statements a timeout-bounded call needs, as
 * the FIRST statements inside a transaction the caller has already opened
 * with `BEGIN`. See this section's own header comment for why `SET LOCAL`
 * inside a transaction, never a bare `SET`.
 */
async function applyStatementAndLockTimeout(client: Queryable, timeoutMs: number): Promise<void> {
  // statement_timeout = 0 means "no timeout" in Postgres, the exact
  // opposite of what this exists to guarantee, so the bound is floored at
  // 1ms rather than allowed to reach zero: a run whose deadline has already
  // passed still gets a real, if vanishingly short, statement timeout
  // instead of accidentally disabling one. Values are computed integers
  // derived from a clock, never user input, so inlining them into the
  // statement is safe; `SET` does not accept a bind parameter the way a
  // normal DML statement does.
  const boundedMs = Math.max(MIN_DB_TIMEOUT_MS, Math.floor(timeoutMs))
  await client.query(`SET LOCAL statement_timeout = ${boundedMs}`)
  await client.query(`SET LOCAL lock_timeout = ${boundedMs}`)
}

/**
 * The single-statement counterpart to applyRunTransition/completeStep's own
 * transaction management, for recordPlan and beginStep: neither is
 * otherwise transactional (one INSERT or one UPDATE), so this only opens a
 * transaction at all when a real `timeoutMs` is supplied; the unscoped path
 * (`timeoutMs === undefined`) delegates straight to `pool.query`, exactly
 * this module's ORIGINAL behaviour for these two functions before Blocker
 * 6, so a caller instrumenting `pool.query` itself (a test proxy, most
 * plausibly; see test/orchestrator.test.ts's own failure-injection tests)
 * still sees every call the way it always could.
 */
async function withOptionalDbTimeoutForSingleQuery<T>(
  pool: Pool,
  timeoutMs: number | undefined,
  fn: (queryable: Queryable) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) return fn(pool)
  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN')
      await applyStatementAndLockTimeout(client, timeoutMs)
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        // The connection may already be broken; discard the secondary
        // error so the caller sees the original failure, matching the
        // pattern every other transactional write in this module uses.
      })
      throw error
    }
  })
}

/** Creates a run in state 'queued'. Nothing has started yet; startRun is the transition that does. */
export async function createRun(pool: Pool, params: CreateRunParams): Promise<Run> {
  const { rows } = await pool.query<RunRow>(
    `INSERT INTO runs (workspace_id, session_id, principal_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.workspaceId, params.sessionId, params.principalId],
  )
  const row = rows[0]
  if (!row) throw new Error('createRun: INSERT ... RETURNING * returned no row')
  return toRun(row)
}

/**
 * Applies a run transition inside its own transaction, locking the row
 * first so two concurrent callers cannot both read the same starting state
 * and both believe their transition is legal. Not expected to race in
 * practice, since one loop instance owns a run, but a real UPDATE guarded
 * by a real lock costs nothing here and removes the need to trust that
 * invariant blindly.
 *
 * `timeoutMs`, per Blocker 6: bounds this whole transaction, statement and
 * lock alike, via a `SET LOCAL` issued right after this function's own
 * `BEGIN` (see applyStatementAndLockTimeout). Optional, so every caller
 * that does not pass one (every test in this project's own suite, and
 * createRun/listSteps elsewhere in this module) keeps its previous,
 * unbounded behaviour.
 */
async function applyRunTransition(
  pool: Pool,
  runId: string,
  event: RunEvent,
  patch: (client: Queryable, current: RunRow, nextState: RunState) => Promise<RunRow>,
  timeoutMs?: number,
): Promise<Run> {
  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN')
      if (timeoutMs !== undefined) await applyStatementAndLockTimeout(client, timeoutMs)
      const { rows } = await client.query<RunRow>('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [
        runId,
      ])
      const current = rows[0]
      if (!current) throw new Error(`applyRunTransition: no run found with id "${runId}"`)
      // Throws IllegalTransitionError before any write happens if the
      // transition is not legal from the run's current state.
      const nextState = transitionRun(current.state, event)
      const updated = await patch(client, current, nextState)
      await client.query('COMMIT')
      return toRun(updated)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        // The connection may already be broken; discard the secondary error
        // so the caller sees the original failure, matching the pattern
        // src/chat/outbox.ts and src/db/migrate.ts already use.
      })
      throw error
    }
  })
}

/**
 * Transitions a run from 'queued' to 'running', per FR-ORC-1: this write
 * must complete before the loop invokes anything. Also bumps
 * transition_seq (Blocker 2): a run-level transition is exactly the kind
 * of write FR-ORC-1's sequence number exists to number.
 */
export async function startRun(pool: Pool, runId: string, timeoutMs?: number): Promise<Run> {
  return applyRunTransition(
    pool,
    runId,
    'start',
    async (client, current, nextState) => {
      const { rows } = await client.query<RunRow>(
        `UPDATE runs
         SET state = $2, started_at = now(), updated_at = now(), transition_seq = transition_seq + 1
         WHERE id = $1
         RETURNING *`,
        [current.id, nextState],
      )
      const row = rows[0]
      if (!row) throw new Error('startRun: UPDATE ... RETURNING * returned no row')
      return row
    },
    timeoutMs,
  )
}

export type FinishRunPatch = {
  deadLetterReason?: string
  failureReason?: string
  costUsd?: number
}

/**
 * Transitions a run to a terminal state ('succeeded', 'failed',
 * 'cancelled', or 'dead_letter'), recording ended_at and whatever patch
 * fields apply, and bumping transition_seq (Blocker 2), same reasoning as
 * startRun above.
 *
 * `timeoutMs` is deliberately NOT derived from "time remaining until the
 * run's own deadline" the way src/agent/loop.ts derives it for the calls
 * made DURING execution: this call is frequently made AFTER that deadline
 * has already passed (the run-timeout branch calls this exactly because
 * the deadline was reached), so a timeout bound on "what's left" would be
 * at or near zero, self-defeating for the one write that has to succeed to
 * record that outcome at all. Callers on that path pass a fixed, generous
 * budget instead (see loop.ts's TERMINAL_WRITE_TIMEOUT_MS); this function
 * itself just accepts whatever value the caller decides is appropriate.
 */
export async function finishRun(
  pool: Pool,
  runId: string,
  event: Extract<RunEvent, 'succeed' | 'fail' | 'cancel' | 'dead_letter'>,
  patch: FinishRunPatch = {},
  timeoutMs?: number,
): Promise<Run> {
  return applyRunTransition(
    pool,
    runId,
    event,
    async (client, current, nextState) => {
      const { rows } = await client.query<RunRow>(
        `UPDATE runs
         SET state = $2, ended_at = now(), updated_at = now(),
             dead_letter_reason = COALESCE($3, dead_letter_reason),
             failure_reason = COALESCE($4, failure_reason),
             cost_usd = COALESCE($5, cost_usd),
             transition_seq = transition_seq + 1
         WHERE id = $1
         RETURNING *`,
        [
          current.id,
          nextState,
          patch.deadLetterReason ?? null,
          patch.failureReason ?? null,
          patch.costUsd ?? null,
        ],
      )
      const row = rows[0]
      if (!row) throw new Error('finishRun: UPDATE ... RETURNING * returned no row')
      return row
    },
    timeoutMs,
  )
}

/**
 * Persists the plan produced by the engine's planning phase, per FR-ORC-2:
 * "the plan is persisted" before execution proceeds. Overwrites any prior
 * plan on this run rather than keeping a history of every replan: a forced
 * replan (FR-ORC-9) calls this again, and only the latest plan is what the
 * rest of the loop actually follows. Prior plans remain reconstructable
 * from the steps table (each step records the capability and input that
 * were actually attempted) even though the intermediate plan documents
 * themselves are not separately retained; see the task report for this
 * named as something not covered.
 */
export async function recordPlan(pool: Pool, runId: string, plan: unknown, timeoutMs?: number): Promise<void> {
  await withOptionalDbTimeoutForSingleQuery(pool, timeoutMs, async (queryable) => {
    const { rowCount } = await queryable.query('UPDATE runs SET plan = $2, updated_at = now() WHERE id = $1', [
      runId,
      serializeAndScrub(plan),
    ])
    if (rowCount === 0) throw new Error(`recordPlan: no run found with id "${runId}"`)
  })
}

/**
 * Inserts a step row already in state 'running', per AP-5: this INSERT
 * must complete, and be committed, before the caller invokes the
 * corresponding capability. See this module's header comment for why
 * 'running' is the insert-time state rather than 'pending'.
 */
export async function beginStep(pool: Pool, params: BeginStepParams, timeoutMs?: number): Promise<Step> {
  return withOptionalDbTimeoutForSingleQuery(pool, timeoutMs, async (queryable) => {
    const { rows } = await queryable.query<StepRow>(
      `INSERT INTO steps (run_id, workspace_id, capability, input, state, started_at)
       VALUES ($1, $2, $3, $4, 'running', now())
       RETURNING *`,
      [params.runId, params.workspaceId, params.capability, serializeAndScrub(params.input)],
    )
    const row = rows[0]
    if (!row) throw new Error('beginStep: INSERT ... RETURNING * returned no row')
    return toStep(row)
  })
}

/**
 * What completeStep persists for the policy mediation seam, per
 * 0013_steps_policy_decision.sql: src/policy/engine.ts's own
 * MediationVerdict, reduced to the two fields worth persisting. `null` for
 * a step this seam never mediated, which today should not happen in
 * practice (src/agent/loop.ts's executeStep always mediates before it ever
 * reaches completeStep) but is not enforced by this module, since a step
 * outside the governed loop (a test calling completeStep directly, for
 * instance) has no mediation to report.
 */
export type StepMediation = { readonly decision: StepPolicyDecision; readonly reason: string } | null

/**
 * Transitions a step to a terminal state and records its outcome, per
 * AP-5: this UPDATE only ever runs after the capability call it describes
 * has settled (resolved, rejected, timed out, or been cancelled).
 *
 * Also bumps the PARENT run's transition_seq, transactionally with the
 * step's own write (Blocker 2): "make step completion increment rather
 * than silently update" is exactly this. The resulting value is stamped
 * onto the step row itself as run_transition_seq, so a reader can tell
 * where in the run's own transition timeline this step's completion landed
 * without a separate ledger table.
 *
 * `mediation`, per Task 3: written in the SAME UPDATE as everything else
 * here, not a second round trip. `mediation.reason` is scrubbed the same
 * way `outcome`'s own error text is, defence in depth matching this
 * module's own stated philosophy (see serializeAndScrub's doc comment)
 * even though src/policy/classify.ts and src/policy/decide.ts's own reason
 * strings are never built from a call's raw arguments in the first place.
 */
export async function completeStep(
  pool: Pool,
  stepId: string,
  outcome: StepOutcome,
  mediation: StepMediation,
  timeoutMs?: number,
): Promise<Step> {
  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN')
      if (timeoutMs !== undefined) await applyStatementAndLockTimeout(client, timeoutMs)
      const { rows: currentRows } = await client.query<StepRow>(
        'SELECT * FROM steps WHERE id = $1 FOR UPDATE',
        [stepId],
      )
      const current = currentRows[0]
      if (!current) throw new Error(`completeStep: no step found with id "${stepId}"`)
      const nextState = transitionStep(current.state, outcome.event as StepEvent)

      const output = outcome.event === 'succeed' ? serializeAndScrub(outcome.output) : null
      const error = outcome.event === 'succeed' ? null : scrubSecrets(outcome.error)
      const policyDecision = mediation ? mediation.decision : null
      const policyReason = mediation ? scrubSecrets(mediation.reason) : null

      const { rows: runRows } = await client.query<{ transition_seq: number }>(
        `UPDATE runs SET transition_seq = transition_seq + 1, updated_at = now() WHERE id = $1 RETURNING transition_seq`,
        [current.run_id],
      )
      const runTransitionSeq = runRows[0]?.transition_seq
      if (runTransitionSeq === undefined) {
        throw new Error(
          `completeStep: no run found with id "${current.run_id}" to bump its transition sequence`,
        )
      }

      const { rows } = await client.query<StepRow>(
        `UPDATE steps
         SET state = $2, output = $3, error = $4, ended_at = now(), run_transition_seq = $5,
             policy_decision = $6, policy_reason = $7
         WHERE id = $1
         RETURNING *`,
        [stepId, nextState, output, error, runTransitionSeq, policyDecision, policyReason],
      )
      const row = rows[0]
      if (!row) throw new Error('completeStep: UPDATE ... RETURNING * returned no row')
      await client.query('COMMIT')
      return toStep(row)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        // See applyRunTransition's identical guard above.
      })
      throw error
    }
  })
}

/**
 * The single run currently 'running' for `sessionId`, or null if none is.
 * Backs the Stop path (src/orchestrator.ts, gate fix Blocker 1): a Stop
 * instruction names a thread, never a run id directly, so this is how it
 * finds the run its own cancellation registry knows how to cancel. Orders
 * by created_at descending and takes one, rather than assuming exactly one
 * running row can ever exist for a session: nothing in this schema
 * prevents two runs from being 'running' for the same session at once (a
 * second message arriving while the first is still in flight starts its
 * own run), so "most recently started" is the deliberate, stated tie
 * break, not an assumption that ties never happen.
 */
export async function findActiveRunForSession(pool: Pool, sessionId: string): Promise<Run | null> {
  const { rows } = await pool.query<RunRow>(
    `SELECT * FROM runs WHERE session_id = $1 AND state = 'running' ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  )
  const row = rows[0]
  return row ? toRun(row) : null
}

/** Every step belonging to `runId`, ordered oldest first by its monotonic seq, exactly the order FR-ORC-9's loop protection needs to read them in. */
export async function listSteps(pool: Pool, runId: string): Promise<Step[]> {
  const { rows } = await pool.query<StepRow>('SELECT * FROM steps WHERE run_id = $1 ORDER BY seq', [
    runId,
  ])
  return rows.map(toStep)
}
