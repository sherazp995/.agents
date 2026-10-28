/**
 * FR-POL-7's spend caps: per-run, per-session, and per-principal-per-day
 * currency limits. FR-POL-7's full text also names token caps, per-origin
 * request rate limits, per-capability call-count caps, and a
 * global-per-day currency cap; the Task 7 brief scoped this task to the
 * three currency caps it names explicitly (run, session, principal-day),
 * and this module follows that brief rather than the requirement's full
 * text. Stated here as a brief interpretation, not silently assumed; see
 * the task report.
 *
 * Backed by `budget_ledger` (0017_budget.sql), an append-only record of
 * every spend event, summed on read rather than maintained as three
 * separately incremented counters: an append-only ledger can never drift
 * out of sync with itself the way three hand-updated counters could if a
 * caller updated one and forgot another.
 *
 * UNWIRED, STATED PLAINLY, matching src/killswitch.ts's own header comment.
 * Nothing in src/agent/loop.ts calls `recordSpend` after an engine
 * invocation's `total_cost_usd` becomes known, and nothing calls
 * `requestBudgetAuthorization` or `applyBudgetApprovalResolution` from a
 * real Slack interaction. This module is the core mechanism, proven
 * correct on its own; the wiring (a real call from the loop's own cost
 * accumulation, and a real `resolveApprovalInteraction` branch that
 * recognises a `budget.raise_*` capability) is not built here, per the Task
 * 7 brief's file list. See the task report for exactly what is not
 * covered.
 *
 * THE DAY BOUNDARY, decided deliberately rather than accidentally, per the
 * brief's own warning that this is where this kind of code is usually
 * wrong. `utcDayBounds` below fixes the day boundary to UTC midnight, not
 * the operator's local timezone or the database session's own timezone
 * setting. Three reasons, not one: every timestamp this project already
 * stores is `timestamptz`, which Postgres itself always stores in UTC
 * internally regardless of session timezone, so anchoring the day boundary
 * to anything OTHER than UTC would mean the boundary depends on a setting
 * this codebase does not otherwise thread through anywhere (no operator
 * timezone exists in the schema today); UTC has no daylight-saving
 * transition, so a day is always exactly 24 hours, never 23 or 25, which a
 * local-timezone boundary is not guaranteed to be twice a year; and the
 * boundary is computed once, in application code, from a single `now`
 * value, and passed to Postgres as two `timestamptz` parameters, rather
 * than left to `CURRENT_DATE` or `date_trunc`'s own default timezone
 * (`postgresql.conf`'s `timezone` setting, which nothing in this project
 * pins), so the boundary this module uses is the same regardless of which
 * server or connection pool happens to run the query.
 *
 * THE RUN-SCOPED RAISE, per the brief's "approving raises the cap for that
 * run only, never permanently and never for a sibling." `raiseRunCap`
 * writes one row to `budget_run_exemptions`, keyed by (run_id, scope).
 * `recordSpend`'s own cap check for that run reads only its own run's row;
 * it never touches the caller-supplied cap value itself (nothing here
 * mutates a policy-configured number) and never touches another run's row
 * (the table has no query path that could reach across run_id values), so
 * "never permanently" and "never for a sibling" are true by table design,
 * not by caller discipline. See this file's own self-attack tests.
 */

import type { Pool, PoolClient } from 'pg'
import type { RiskTier } from '../capabilities/registry.js'
import type { Approval, ResolveApprovalResult } from '../approvals/store.js'
import { createApproval } from '../approvals/store.js'

/**
 * A minimal shape both `Pool` and `PoolClient` satisfy structurally,
 * matching `src/runs/store.ts`'s own identical `Queryable` type and for
 * the same reason: `Pool.query` and `PoolClient.query` are independently
 * overloaded in `@types/pg`, and every function in this module only ever
 * calls `.query(text, values)` and reads `.rows`, never anything else
 * either class offers. Every read helper below (`getRunSpend`,
 * `getSessionSpend`, `getPrincipalDaySpend`, `getRunExemption`) takes this
 * rather than `Pool` specifically, so `recordSpend`'s own transaction can
 * call them against its own locked `PoolClient` (fix round 1, see
 * `recordSpend`'s own doc comment on the race this closes), while every
 * existing external caller (this module's own tests included) keeps
 * passing a plain `Pool` unchanged.
 */
type Queryable = {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>
}

export const BUDGET_SCOPES = ['run', 'session', 'principal_day'] as const
export type BudgetScope = (typeof BUDGET_SCOPES)[number]

/** The three caps a caller supplies for one recordSpend call. All three are checked independently on every call; see this module's own self-attack tests for the proof that each is a real, separate guard. */
export type BudgetCaps = {
  runCapUsd: number
  sessionCapUsd: number
  principalDayCapUsd: number
}

/** One scope's cap check having failed: the cap it was checked against, and the total actually spent (including the run's own exemption, if any, already folded into `capUsd`). */
export type ExceededScope = {
  scope: BudgetScope
  capUsd: number
  spentUsd: number
}

export type RecordSpendParams = {
  workspaceId: string
  runId: string
  sessionId: string
  principalId: string
  /** The real dollar amount this specific spend event cost, e.g. one engine invocation's `total_cost_usd`. Recorded unconditionally: the spend already happened by the time this is called, so there is nothing to refuse, only something to report. */
  amountUsd: number
  caps: BudgetCaps
  now?: Date
  /** An autonomous invocation's id: the ledger holds at most one row per invocation, so a repeated settlement charges nothing. */
  invocationId?: string
}

export type RecordSpendResult = {
  /** Empty when every scope is within its cap. Order matches BUDGET_SCOPES. */
  exceeded: readonly ExceededScope[]
  runSpentUsd: number
  sessionSpentUsd: number
  principalDaySpentUsd: number
}

type SpendRow = { total: string | null }

/**
 * The [start, end) UTC-midnight window `now` falls inside, per this
 * module's own header comment on why UTC. `end` is exclusive (the start of
 * the NEXT day), so a spend at exactly midnight belongs to the day that is
 * starting, never the one that just ended, and a spend one millisecond
 * before midnight belongs to the day that is ending. Pure and exported so
 * it can be unit tested directly against known boundary instants, rather
 * than only indirectly through a database round trip.
 */
export function utcDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

/** Shared by every read helper below; accepts anything Queryable, per that type's own doc comment. */
async function sumSpend(queryable: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await queryable.query<SpendRow>(sql, params)
  const total = rows[0]?.total
  return total === null || total === undefined ? 0 : Number(total)
}

/** Total spend recorded against `runId`, across its entire lifetime (a run has no day boundary of its own; FR-ORC-7's per-run cap is a lifetime total for that run). */
export async function getRunSpend(queryable: Queryable, workspaceId: string, runId: string): Promise<number> {
  return sumSpend(
    queryable,
    'SELECT SUM(amount_usd) AS total FROM budget_ledger WHERE workspace_id = $1 AND run_id = $2',
    [workspaceId, runId],
  )
}

/** Total spend recorded against `sessionId`, across every run that session has ever had, lifetime (a session, like a run, has no day boundary of its own). */
export async function getSessionSpend(queryable: Queryable, workspaceId: string, sessionId: string): Promise<number> {
  return sumSpend(
    queryable,
    'SELECT SUM(amount_usd) AS total FROM budget_ledger WHERE workspace_id = $1 AND session_id = $2',
    [workspaceId, sessionId],
  )
}

/** Total spend recorded against `principalId` within the UTC day `now` falls in, per `utcDayBounds`. Defaults `now` to the current instant, matching every other optional `now` parameter in this codebase's stores (src/approvals/store.ts's identical convention). */
export async function getPrincipalDaySpend(
  queryable: Queryable,
  workspaceId: string,
  principalId: string,
  now?: Date,
): Promise<number> {
  const { start, end } = utcDayBounds(now ?? new Date())
  return sumSpend(
    queryable,
    `SELECT SUM(amount_usd) AS total FROM budget_ledger
     WHERE workspace_id = $1 AND principal_id = $2 AND occurred_at >= $3 AND occurred_at < $4`,
    [workspaceId, principalId, start, end],
  )
}

type ExemptionRow = { raised_to_usd: string }

/** The run-scoped raised cap for `(runId, scope)`, if `raiseRunCap` has ever been called for it, or null if it has not. Never reads across `runId` values, per this module's own header comment on why a raise cannot reach a sibling run. */
export async function getRunExemption(
  queryable: Queryable,
  workspaceId: string,
  runId: string,
  scope: BudgetScope,
): Promise<number | null> {
  const { rows } = await queryable.query<ExemptionRow>(
    'SELECT raised_to_usd FROM budget_run_exemptions WHERE workspace_id = $1 AND run_id = $2 AND scope = $3',
    [workspaceId, runId, scope],
  )
  const row = rows[0]
  return row ? Number(row.raised_to_usd) : null
}

export type RaiseRunCapParams = {
  workspaceId: string
  runId: string
  scope: BudgetScope
  raisedToUsd: number
  grantedByPrincipalId: string
  now?: Date
}

/**
 * Records a run-scoped cap raise, per FR-POL-7's "approving raises the cap
 * for that run only, never permanently and never for a sibling." Upsert on
 * `(run_id, scope)`: a second raise for the same run and scope (the
 * operator approving again as the run keeps spending) replaces the
 * previous value rather than erroring or accumulating, since only the
 * LATEST raised ceiling for that run/scope pair is ever meaningful; there
 * is no reason to keep the old one once a newer one is granted.
 */
export async function raiseRunCap(pool: Pool, params: RaiseRunCapParams): Promise<void> {
  const now = params.now ?? new Date()
  await pool.query(
    `INSERT INTO budget_run_exemptions
       (workspace_id, run_id, scope, raised_to_usd, granted_by_principal_id, granted_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id, scope) DO UPDATE
       SET raised_to_usd = $4, granted_by_principal_id = $5, granted_at = $6`,
    [params.workspaceId, params.runId, params.scope, params.raisedToUsd, params.grantedByPrincipalId, now],
  )
}

/**
 * The effective cap for one scope: the caller-supplied policy cap, raised
 * to a run's own exemption when one exists and is higher. `Math.max`, not
 * an unconditional overwrite, so a caller cannot accidentally LOWER the
 * cap below what policy already allows by raising to a smaller number than
 * the original cap (raiseRunCap itself does not validate its own input
 * against the original cap, since the operator's chosen new ceiling is a
 * caller-supplied decision this module does not second-guess, per
 * src/approvals/store.ts's own established pattern of accepting
 * caller-supplied governance values rather than inventing its own).
 */
function effectiveCap(baseCapUsd: number, exemptionUsd: number | null): number {
  return exemptionUsd === null ? baseCapUsd : Math.max(baseCapUsd, exemptionUsd)
}

/**
 * Serializes concurrent `recordSpend` calls that share any of the three
 * scope keys, closing the read-after-insert race a sequential test cannot
 * catch (fix round 1, an independent review's finding, reproduced directly
 * before this fix: two concurrent calls, each individually under a cap,
 * both computed a SUM that saw only their own row and both reported
 * `exceeded: []`, even though the combined total was over the cap). Each
 * lock is a Postgres advisory lock scoped to the current transaction
 * (`pg_advisory_xact_lock`, auto-released at COMMIT or ROLLBACK, no manual
 * unlock needed, unlike `src/db/migrate.ts`'s session-level lock, which is
 * held across an unrelated, much longer operation and therefore needs one).
 * `hashtextextended` gives a full 64-bit hash of the key text rather than
 * the 32-bit result a bare `hashtext` cast would give, keeping the
 * collision probability between two UNRELATED keys (which would only cost
 * unnecessary serialization, never a correctness bug, since over-locking
 * is always safe) low enough not to matter at this project's real spend
 * cadence.
 *
 * FIXED ACQUISITION ORDER (run, then session, then principal-day) across
 * every call, to prevent a deadlock between two calls whose lock sets
 * overlap differently. Two different runs in the same session need the
 * SAME session lock but DIFFERENT run locks; two different sessions for
 * the same principal on the same day need the SAME principal-day lock but
 * DIFFERENT session locks. Acquiring in the same relative order on every
 * call means no call can ever hold a lock a second call needs while
 * waiting for a lock the second call already holds, the standard
 * consistent-ordering argument against deadlock.
 */
export async function acquireScopeLocks(
  client: PoolClient,
  keys: { runKey: string; sessionKey: string; principalDayKey: string },
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keys.runKey])
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keys.sessionKey])
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keys.principalDayKey])
}

/**
 * Records one spend event and checks it against all three scopes
 * independently, per FR-ORC-7's "every model call... increments... and
 * asks for authorisation rather than failing silently." The spend is
 * always recorded, even when it pushes one or more scopes over their cap:
 * the real dollar cost this call describes has already been incurred by
 * the time anything calls this function (an engine invocation's own
 * `total_cost_usd` is only known after it returns), so there is nothing
 * left to refuse, only something to report. What a caller does with a
 * non-empty `exceeded` (pause the run, call `requestBudgetAuthorization`
 * below) is this function's caller's decision, not this function's.
 *
 * Each of the three checks reads its own independent total and its own
 * independent exemption; none of the three shares a code path with
 * another, deliberately, so that removing any ONE scope's check cannot
 * silently also remove another's. Proven directly in
 * test/budget/meter.test.ts's self-attack tests, one per scope.
 *
 * Runs inside one transaction, locked via `acquireScopeLocks` before the
 * INSERT, per that function's own doc comment on the race this closes.
 * Every read below runs against the SAME locked `client`, never the bare
 * `pool`, so a concurrent call racing on any of the three scope keys is
 * genuinely blocked, not merely likely to lose a timing race.
 */
export async function recordSpend(pool: Pool, params: RecordSpendParams): Promise<RecordSpendResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await recordSpendInTransaction(client, params)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      // The connection may already be broken; discard the secondary error
      // so the caller sees the original failure, matching the pattern
      // every other transactional write in this project uses
      // (src/approvals/store.ts, src/runs/store.ts).
    })
    throw error
  } finally {
    client.release()
  }
}

/** The scope lock keys for one spend, in the fixed order acquireScopeLocks takes them. */
export function scopeLockKeys(params: { runId: string; sessionId: string; principalId: string; now: Date }): {
  runKey: string
  sessionKey: string
  principalDayKey: string
} {
  const { start: dayStart } = utcDayBounds(params.now)
  return {
    runKey: `budget:run:${params.runId}`,
    sessionKey: `budget:session:${params.sessionId}`,
    principalDayKey: `budget:principal_day:${params.principalId}:${dayStart.toISOString()}`,
  }
}

/**
 * recordSpend's body on a caller's open transaction, so autonomous
 * settlement can charge the ledger and mark its invocation charged
 * atomically. With an `invocationId`, a second call for the same invocation
 * inserts nothing (the ledger's unique invocation_id), so a retried
 * settlement charges once.
 */
export async function recordSpendInTransaction(client: PoolClient, params: RecordSpendParams): Promise<RecordSpendResult> {
  const now = params.now ?? new Date()
  await acquireScopeLocks(client, scopeLockKeys({ ...params, now }))

  await client.query(
    `INSERT INTO budget_ledger (workspace_id, run_id, session_id, principal_id, amount_usd, occurred_at, invocation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (invocation_id) DO NOTHING`,
    [params.workspaceId, params.runId, params.sessionId, params.principalId, params.amountUsd, now, params.invocationId ?? null],
  )

  const [runSpentUsd, sessionSpentUsd, principalDaySpentUsd] = await Promise.all([
    getRunSpend(client, params.workspaceId, params.runId),
    getSessionSpend(client, params.workspaceId, params.sessionId),
    getPrincipalDaySpend(client, params.workspaceId, params.principalId, now),
  ])

  const [runExemption, sessionExemption, principalDayExemption] = await Promise.all([
    getRunExemption(client, params.workspaceId, params.runId, 'run'),
    getRunExemption(client, params.workspaceId, params.runId, 'session'),
    getRunExemption(client, params.workspaceId, params.runId, 'principal_day'),
  ])

  const exceeded: ExceededScope[] = []

  const runCapUsd = effectiveCap(params.caps.runCapUsd, runExemption)
  if (runSpentUsd > runCapUsd) exceeded.push({ scope: 'run', capUsd: runCapUsd, spentUsd: runSpentUsd })

  const sessionCapUsd = effectiveCap(params.caps.sessionCapUsd, sessionExemption)
  if (sessionSpentUsd > sessionCapUsd) {
    exceeded.push({ scope: 'session', capUsd: sessionCapUsd, spentUsd: sessionSpentUsd })
  }

  const principalDayCapUsd = effectiveCap(params.caps.principalDayCapUsd, principalDayExemption)
  if (principalDaySpentUsd > principalDayCapUsd) {
    exceeded.push({ scope: 'principal_day', capUsd: principalDayCapUsd, spentUsd: principalDaySpentUsd })
  }

  return { exceeded, runSpentUsd, sessionSpentUsd, principalDaySpentUsd }
}

/** A scope's cap after any exemption granted on `runId`, exported for autonomous admission. */
export async function effectiveScopeCap(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  scope: BudgetScope,
  baseCapUsd: number,
): Promise<number> {
  return effectiveCap(baseCapUsd, await getRunExemption(client, workspaceId, runId, scope))
}

// ---------------------------------------------------------------------------
// Approvals integration: FR-POL-7's "asks for authorisation" reuses Task 4's
// existing approvals store and Block Kit surface rather than inventing a
// parallel one, per the Task 7 brief. Neither function below is wired to a
// real caller; see this module's header comment.
// ---------------------------------------------------------------------------

const BUDGET_CAPABILITY_PREFIX = 'budget.raise'

/** The capability name an approval created by `requestBudgetAuthorization` carries, e.g. `budget.raise_run`. Exported so a future `resolveApprovalInteraction` wiring can recognise it (`approval.capability.startsWith(BUDGET_CAPABILITY_PREFIX)`) without hand-constructing the string itself. */
export function budgetCapabilityName(scope: BudgetScope): string {
  return `${BUDGET_CAPABILITY_PREFIX}_${scope}`
}

export type RequestBudgetAuthorizationParams = {
  workspaceId: string
  runId: string
  sessionId: string
  requesterPrincipalId: string
  exceeded: ExceededScope
  /**
   * The new cap this approval proposes, per FR-ORC-7's "budget exhausted,
   * raise limit?" prompt. Caller-supplied, not computed in here: what
   * number to propose (double the cap, round up to the next spend, a fixed
   * policy-configured increment) is a governance/UX decision this module
   * does not invent, matching src/approvals/store.ts's own established
   * pattern of accepting caller-supplied governance values (requiredRoles,
   * requiresTypedConfirmation) rather than deriving them internally.
   */
  suggestedCapUsd: number
  /** Who may approve raising this run's cap. Caller-supplied for the same reason FR-APR-4's role mapping is caller-supplied in src/approvals/store.ts: no tier-to-role mapping for budget governance exists in policy configuration yet. */
  requiredRoles: readonly string[]
  /** Defaults to 'sensitive': a budget overrun is a real governance event, per FR-POL-7, but not necessarily the highest-severity 'irreversible' tier FR-APR-5 reserves for typed confirmation. Overridable, not hard-coded, matching the Task 7 brief's own "make it configurable rather than hard-coded" instruction for a related decision. */
  tier?: RiskTier
  timeoutMs: number
  now?: Date
}

/**
 * Creates the approval an operator resolves to raise a run's cap, per
 * FR-ORC-7's "posts a 'budget exhausted, raise limit?' prompt with an
 * Approve button." This is exactly `src/approvals/store.ts`'s
 * `createApproval`, called with budget-specific fields, not a second
 * approval mechanism: the resulting row renders through
 * `src/approvals/blockkit.ts`'s existing `renderApprovalCard` and resolves
 * through the existing `resolveApproval` exactly like any other approval,
 * which is what "make it fit rather than inventing a parallel path" means
 * in practice.
 */
export async function requestBudgetAuthorization(pool: Pool, params: RequestBudgetAuthorizationParams): Promise<Approval> {
  const { scope, capUsd, spentUsd } = params.exceeded
  return createApproval(pool, {
    workspaceId: params.workspaceId,
    runId: params.runId,
    sessionId: params.sessionId,
    requesterPrincipalId: params.requesterPrincipalId,
    capability: budgetCapabilityName(scope),
    description: `Budget cap exceeded for ${scope}: $${spentUsd.toFixed(2)} spent against a $${capUsd.toFixed(2)} cap.`,
    target: `Raise the ${scope} cap to $${params.suggestedCapUsd.toFixed(2)} for this run only`,
    tier: params.tier ?? 'sensitive',
    escalationReason: `${scope} budget cap exceeded ($${spentUsd.toFixed(2)} spent, $${capUsd.toFixed(2)} cap)`,
    requiredRoles: params.requiredRoles,
    timeoutMs: params.timeoutMs,
    ...(params.now !== undefined ? { now: params.now } : {}),
  })
}

export type ApplyBudgetApprovalResolutionParams = {
  workspaceId: string
  runId: string
  scope: BudgetScope
  raisedToUsd: number
  resolution: ResolveApprovalResult
  now?: Date
}

/**
 * The other half of the integration: given the `ResolveApprovalResult` a
 * real `resolveApprovalInteraction` wiring produced for a `budget.raise_*`
 * capability, raises the run's cap if and only if the resolution was
 * genuinely `resolved` with `status === 'approved'`. Every other outcome
 * (denied, unauthorized, expired, already_resolved, or the confirmation/
 * edit outcomes, none of which a budget approval created by
 * `requestBudgetAuthorization` above ever triggers, since it never sets
 * `requiresTypedConfirmation` and never uses `edit_and_approve`) raises
 * nothing, which is the fail-closed default this module inherits from
 * `resolveApproval` itself rather than re-implementing.
 */
export async function applyBudgetApprovalResolution(
  pool: Pool,
  params: ApplyBudgetApprovalResolutionParams,
): Promise<{ raised: boolean }> {
  const { resolution } = params
  if (resolution.outcome !== 'resolved' || !resolution.approval || resolution.approval.status !== 'approved') {
    return { raised: false }
  }
  const grantedByPrincipalId = resolution.approval.resolvedByPrincipalId
  if (!grantedByPrincipalId) {
    // Should be impossible: resolveApproval always sets
    // resolvedByPrincipalId on an 'approved' row. Refuses to raise rather
    // than raising with a fabricated grantor, since budget_run_exemptions'
    // own granted_by_principal_id is NOT NULL and foreign-keyed.
    return { raised: false }
  }
  await raiseRunCap(pool, {
    workspaceId: params.workspaceId,
    runId: params.runId,
    scope: params.scope,
    raisedToUsd: params.raisedToUsd,
    grantedByPrincipalId,
    ...(params.now !== undefined ? { now: params.now } : {}),
  })
  return { raised: true }
}
