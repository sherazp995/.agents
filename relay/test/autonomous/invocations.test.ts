import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { createRun } from '../../src/runs/store.js'
import { getRunSpend, recordSpendInTransaction, type BudgetCaps } from '../../src/budget/meter.js'
import { admitInvocation, settleInvocation, type AdmitParams } from '../../src/autonomous/invocations.js'
import { inTransaction } from '../../src/autonomous/store.js'
import { runKillClear, runKillEngage } from '../../src/cli/kill.js'
import { createKillSwitch, PostgresKillSwitchStore } from '../../src/killswitch.js'
import { getTestDatabaseUrl } from '../support/database.js'

const CAPS: BudgetCaps = { runCapUsd: 10, sessionCapUsd: 10, principalDayCapUsd: 10 }

describe('autonomous invocation spend', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function admitParams(overrides: Partial<AdmitParams> = {}): Promise<AdmitParams> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'P', ['member'])
    const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: `C:${randomUUID()}` })
    const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId })
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, session.id, principalId],
    )
    return {
      workspaceId,
      taskId: rows[0]?.id ?? '',
      accountKey: 'claude',
      purpose: 'worker',
      runId: run.id,
      sessionId: session.id,
      principalId,
      fallbackUsd: 4,
      nestedAllowanceUsd: 0,
      caps: CAPS,
      ...overrides,
    }
  }

  it('refuses without spawning when headroom is below the fallback, naming the scope', async () => {
    const params = await admitParams({ fallbackUsd: 11 })
    const admission = await admitInvocation(pool, params)
    expect(admission).toMatchObject({ admitted: false, scope: 'run', neededUsd: 11 })
    const { rows } = await pool.query('SELECT 1 FROM autonomous_invocations WHERE task_id = $1', [params.taskId])
    expect(rows).toHaveLength(0)
  })

  it('admits exactly one of two simultaneous admissions sharing the last allowance', async () => {
    const params = await admitParams({ fallbackUsd: 6 })
    const results = await Promise.all([admitInvocation(pool, params), admitInvocation(pool, params)])
    expect(results.filter((result) => result.admitted)).toHaveLength(1)
  })

  it('counts the nested allowance in the reservation and in the charge', async () => {
    const params = await admitParams({ purpose: 'review', fallbackUsd: 4, nestedAllowanceUsd: 3 })
    const admission = await admitInvocation(pool, params)
    if (!admission.admitted) throw new Error('expected admission')
    expect(admission.reservedUsd).toBe(7)

    await settleInvocation(pool, admission.invocationId, 1.5, CAPS)
    expect(await getRunSpend(pool, params.workspaceId, params.runId)).toBeCloseTo(4.5)
  })

  it('releases the reservation on settlement, so the freed room can be admitted again', async () => {
    const params = await admitParams({ fallbackUsd: 6 })
    const first = await admitInvocation(pool, params)
    if (!first.admitted) throw new Error('expected admission')
    expect((await admitInvocation(pool, params)).admitted).toBe(false)

    await settleInvocation(pool, first.invocationId, 1, CAPS)

    expect((await admitInvocation(pool, params)).admitted).toBe(true)
  })

  it('charges a retried settlement once, and rolls back a ledger insert whose invocation update never happened', async () => {
    const params = await admitParams()
    const admission = await admitInvocation(pool, params)
    if (!admission.admitted) throw new Error('expected admission')

    await expect(
      inTransaction(pool, async (client) => {
        await recordSpendInTransaction(client, { ...params, amountUsd: 2, invocationId: admission.invocationId })
        throw new Error('crash before the invocation update')
      }),
    ).rejects.toThrow('crash')
    expect(await getRunSpend(pool, params.workspaceId, params.runId)).toBe(0)

    await settleInvocation(pool, admission.invocationId, 2, CAPS)
    expect(await settleInvocation(pool, admission.invocationId, 2, CAPS)).toBeUndefined()
    expect(await getRunSpend(pool, params.workspaceId, params.runId)).toBe(2)
  })

  it('a settlement racing an admission in the same scope is seen as either the reservation or the charge', async () => {
    const params = await admitParams({ fallbackUsd: 6 })
    const first = await admitInvocation(pool, params)
    if (!first.admitted) throw new Error('expected admission')

    // Settling at the full fallback keeps the scope at 6 spent either way, so
    // the racing admission (needing 6 of 10) must be refused in both orders.
    const [, racing] = await Promise.all([settleInvocation(pool, first.invocationId, 6, CAPS), admitInvocation(pool, params)])

    expect(racing.admitted).toBe(false)
  })
})

describe('relay kill CLI writes the store a daemon refreshes from', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  it('engage then clear, observed by a running kill switch, with engaged_by left as the CLI wrote it', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const cancelled: string[] = []
    const daemon = await createKillSwitch({
      runCanceller: { cancelAll: (reason) => cancelled.push(reason ?? '') },
      store: new PostgresKillSwitchStore(pool, workspaceId),
    })

    await runKillEngage(pool, workspaceId, 'maintenance')
    await daemon.refresh()
    expect(daemon.isEngaged()).toBe(true)
    expect(cancelled).toEqual(['maintenance'])
    const { rows } = await pool.query<{ engaged_by: string }>('SELECT engaged_by FROM kill_switch WHERE workspace_id = $1', [workspaceId])
    expect(rows[0]?.engaged_by).toBe('cli')

    await runKillClear(pool, workspaceId)
    await daemon.refresh()
    expect(daemon.isEngaged()).toBe(false)
  })
})
