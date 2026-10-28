/**
 * Spend for autonomous invocations (0021 `autonomous_invocations`).
 *
 * Admission reserves before a CLI starts; settlement charges once after it
 * ends. Both take the budget meter's scope locks (run, session,
 * principal-day), so an admission racing a settlement in the same scope
 * sees either the other's reservation or its charge, never neither, and two
 * admissions for the last allowance admit exactly one.
 */

import type { Pool, PoolClient } from 'pg'
import {
  acquireScopeLocks,
  effectiveScopeCap,
  getPrincipalDaySpend,
  getRunSpend,
  getSessionSpend,
  recordSpendInTransaction,
  scopeLockKeys,
  utcDayBounds,
  type BudgetCaps,
  type BudgetScope,
  type RecordSpendResult,
} from '../budget/meter.js'
import { inTransaction } from './store.js'

export const INVOCATION_PURPOSES = ['worker', 'review', 'visual_qa', 'video_qa'] as const
export type InvocationPurpose = (typeof INVOCATION_PURPOSES)[number]

export type AdmitParams = {
  workspaceId: string
  taskId: string
  accountKey: string
  purpose: InvocationPurpose
  runId: string
  sessionId: string
  principalId: string
  /** The per-turn fallback: what the invocation itself may spend, and its charge when usage is unknown. */
  fallbackUsd: number
  /** The nested Codex lens allowance for review and visual QA invocations, 0 otherwise. */
  nestedAllowanceUsd: number
  caps: BudgetCaps
  now?: Date
}

export type Admission =
  | { admitted: true; invocationId: string; reservedUsd: number }
  | { admitted: false; scope: BudgetScope; headroomUsd: number; neededUsd: number }

/** Reserves `fallbackUsd + nestedAllowanceUsd` in every scope, or refuses naming the first scope without room. */
export async function admitInvocation(pool: Pool, params: AdmitParams): Promise<Admission> {
  const now = params.now ?? new Date()
  const neededUsd = params.fallbackUsd + params.nestedAllowanceUsd
  return inTransaction(pool, async (client) => {
    await acquireScopeLocks(client, scopeLockKeys({ ...params, now }))
    for (const scope of ['run', 'session', 'principal_day'] as const) {
      const headroomUsd = await headroom(client, params, scope, now)
      if (headroomUsd < neededUsd) return { admitted: false, scope, headroomUsd, neededUsd }
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO autonomous_invocations
         (workspace_id, task_id, account_key, purpose, run_id, session_id, principal_id, reserved_usd, nested_allowance_usd, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        params.workspaceId,
        params.taskId,
        params.accountKey,
        params.purpose,
        params.runId,
        params.sessionId,
        params.principalId,
        neededUsd,
        params.nestedAllowanceUsd,
        now,
      ],
    )
    const invocationId = rows[0]?.id
    if (!invocationId) throw new Error('admitInvocation: INSERT ... RETURNING id returned no row')
    return { admitted: true, invocationId, reservedUsd: neededUsd }
  })
}

const CAP_FOR: Record<BudgetScope, keyof BudgetCaps> = {
  run: 'runCapUsd',
  session: 'sessionCapUsd',
  principal_day: 'principalDayCapUsd',
}

/** Cap minus recorded spend minus what invocations still `started` in that scope have reserved. */
async function headroom(client: PoolClient, params: AdmitParams, scope: BudgetScope, now: Date): Promise<number> {
  const cap = await effectiveScopeCap(client, params.workspaceId, params.runId, scope, params.caps[CAP_FOR[scope]])
  const spent =
    scope === 'run'
      ? await getRunSpend(client, params.workspaceId, params.runId)
      : scope === 'session'
        ? await getSessionSpend(client, params.workspaceId, params.sessionId)
        : await getPrincipalDaySpend(client, params.workspaceId, params.principalId, now)
  const { start, end } = utcDayBounds(now)
  const filter =
    scope === 'run'
      ? { sql: 'run_id = $2', args: [params.runId] }
      : scope === 'session'
        ? { sql: 'session_id = $2', args: [params.sessionId] }
        : { sql: 'principal_id = $2 AND started_at >= $3 AND started_at < $4', args: [params.principalId, start, end] }
  const { rows } = await client.query<{ total: string | null }>(
    `SELECT SUM(reserved_usd) AS total FROM autonomous_invocations
     WHERE workspace_id = $1 AND state = 'started' AND ${filter.sql}`,
    [params.workspaceId, ...filter.args],
  )
  return cap - spent - Number(rows[0]?.total ?? 0)
}

type InvocationRow = {
  id: string
  workspace_id: string
  run_id: string
  session_id: string
  principal_id: string
  reserved_usd: string
  nested_allowance_usd: string
  state: 'started' | 'finished' | 'charged'
}

/**
 * Charges an invocation once: `amountUsd` (its reported cost, or the
 * fallback when unknown) plus its nested allowance, into the ledger and the
 * invocation row in one transaction. A repeat returns `undefined` and
 * charges nothing.
 */
export async function settleInvocation(
  pool: Pool,
  invocationId: string,
  amountUsd: number,
  caps: BudgetCaps,
  now: Date = new Date(),
): Promise<RecordSpendResult | undefined> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<InvocationRow>(
      'SELECT * FROM autonomous_invocations WHERE id = $1 FOR UPDATE',
      [invocationId],
    )
    const row = rows[0]
    if (!row) throw new Error(`settleInvocation: no invocation ${invocationId}`)
    if (row.state === 'charged') return undefined
    const total = amountUsd + Number(row.nested_allowance_usd)
    const result = await recordSpendInTransaction(client, {
      workspaceId: row.workspace_id,
      runId: row.run_id,
      sessionId: row.session_id,
      principalId: row.principal_id,
      amountUsd: total,
      caps,
      now,
      invocationId,
    })
    await client.query(
      `UPDATE autonomous_invocations SET state = 'charged', amount_usd = $2, finished_at = coalesce(finished_at, $3) WHERE id = $1`,
      [invocationId, total, now],
    )
    return result
  })
}

/** Startup recovery: every invocation a crash left `started`, to be charged its fallback once. */
export async function listUnsettledInvocations(pool: Pool, workspaceId: string): Promise<{ id: string; fallbackUsd: number }[]> {
  const { rows } = await pool.query<{ id: string; reserved_usd: string; nested_allowance_usd: string }>(
    `SELECT id, reserved_usd, nested_allowance_usd FROM autonomous_invocations WHERE workspace_id = $1 AND state <> 'charged'`,
    [workspaceId],
  )
  return rows.map((row) => ({ id: row.id, fallbackUsd: Number(row.reserved_usd) - Number(row.nested_allowance_usd) }))
}
