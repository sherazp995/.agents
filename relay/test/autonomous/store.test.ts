import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findActiveSession, findOrCreateSession } from '../../src/sessions/store.js'
import {
  acquireLease,
  intakeMention,
  loadTask,
  renewLease,
  requestCancel,
  updateTask,
  type IntakeMentionParams,
} from '../../src/autonomous/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('autonomous store', () => {
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

  async function setup(): Promise<{ workspaceId: string; principalId: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Requester', ['member'])
    return { workspaceId, principalId }
  }

  /** The test pool, except its clients fail any query containing `match`. */
  function failingPool(match: string): Pool {
    const connect = async (): Promise<PoolClient> => {
      const client = await pool.connect()
      const query = (text: unknown, ...rest: unknown[]) =>
        typeof text === 'string' && text.includes(match)
          ? Promise.reject(new Error(`injected failure on ${match}`))
          : (client.query as (...args: unknown[]) => Promise<unknown>).call(client, text, ...rest)
      return Object.assign(Object.create(client) as PoolClient, { query, release: () => client.release() })
    }
    return { connect } as unknown as Pool
  }

  /** Records queued actions in the caller's transaction, like Outbox.enqueue. */

  function intakeParams(workspaceId: string, principalId: string, threadRef: string, eventId: string): IntakeMentionParams {
    return {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef,
      event: { id: eventId, principalId, text: 'review PR 12', ref: { channel: 'C1', message: '1.1' }, fileIds: [], receivedAt: new Date().toISOString() },
      replyRef: { channel: 'C1', thread: '1.1' },
      files: [],
    }
  }

  async function count(table: string, workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    return Number(rows[0]?.n)
  }

  it('creates the session as autonomous and the task in one transaction, and queues no reaction', async () => {
    const { workspaceId, principalId } = await setup()

    const result = await intakeMention(pool, intakeParams(workspaceId, principalId, 'C1:1.1', 'C1:1.1'))

    expect(result.kind).toBe('created')
    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: 'C1:1.1' })
    expect(session?.mode).toBe('autonomous')
    const reread = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'C1:1.1' })
    expect(reread.mode).toBe('autonomous')
    expect(await count('outbox', workspaceId)).toBe(0)
  })

  it('rolls back the session and task when a failure hits after the session insert, and a retry yields one of each', async () => {
    const { workspaceId, principalId } = await setup()
    const params = intakeParams(workspaceId, principalId, 'C1:2.1', 'C1:2.1')

    await expect(intakeMention(failingPool('INSERT INTO autonomous_tasks'), params)).rejects.toThrow('injected failure')
    expect(await count('sessions', workspaceId)).toBe(0)
    expect(await count('autonomous_tasks', workspaceId)).toBe(0)
    expect(await count('outbox', workspaceId)).toBe(0)

    await intakeMention(pool, params)
    const again = await intakeMention(pool, params)

    expect(again).toMatchObject({ kind: 'appended', duplicate: true })
    expect(await count('sessions', workspaceId)).toBe(1)
    expect(await count('autonomous_tasks', workspaceId)).toBe(1)
  })

  it('appends a new event to an autonomous task once per event id', async () => {
    const { workspaceId, principalId } = await setup()
    await intakeMention(pool, intakeParams(workspaceId, principalId, 'C1:3.1', 'C1:3.1'))

    const reply = intakeParams(workspaceId, principalId, 'C1:3.1', 'C1:3.2')
    const first = await intakeMention(pool, reply)
    const second = await intakeMention(pool, reply)

    expect(first).toMatchObject({ kind: 'appended', duplicate: false })
    expect(second).toMatchObject({ kind: 'appended', duplicate: true })
    if (second.kind !== 'appended') throw new Error('unreachable')
    expect(second.task.pendingEvents.map((event) => event.id)).toEqual(['C1:3.1', 'C1:3.2'])
  })

  it('adopts an attached governed session as the thread\'s autonomous task, in the same session', async () => {
    const { workspaceId, principalId } = await setup()
    const governed = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'C1:5.1' })
    await pool.query(`UPDATE sessions SET engine_cwd = '/p', engine_session_id = 'chat-1', courier_target = 'agents-39 [a1a227]', live_control_claimed_at = now() WHERE id = $1`, [governed.id])

    const result = await intakeMention(pool, { ...intakeParams(workspaceId, principalId, 'C1:5.1', 'C1:5.2'), adopt: true })

    expect(result).toMatchObject({ kind: 'created', session: { id: governed.id, mode: 'autonomous' } })
    // The task carries the chat on: its turns resume chat-1 in /p.
    expect(result).toMatchObject({ task: { chatSessionId: 'chat-1', chatCwd: '/p', engineSessionId: 'chat-1', accountKey: null } })
    // The attachment ends with the chat, so the next message routes to the task instead of parking again.
    expect(await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: 'C1:5.1' })).toMatchObject({ mode: 'autonomous', engineCwd: null, engineSessionId: null, courierTarget: null })
    const { rows } = await pool.query('SELECT 1 FROM sessions WHERE id = $1 AND live_control_claimed_at IS NULL', [governed.id])
    expect(rows).toHaveLength(1)
    expect(await count('sessions', workspaceId)).toBe(1)
  })

  it('changes nothing in a thread that already has a governed session', async () => {
    const { workspaceId, principalId } = await setup()
    const governed = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'C1:4.1' })

    const result = await intakeMention(pool, intakeParams(workspaceId, principalId, 'C1:4.1', 'C1:4.2'))

    expect(result).toEqual({ kind: 'not_autonomous' })
    expect(governed.mode).toBe('governed')
    expect(await count('autonomous_tasks', workspaceId)).toBe(0)
    expect(await count('outbox', workspaceId)).toBe(0)
  })

  it('fences writes by lease generation and refuses to lease a cancelled task', async () => {
    const { workspaceId, principalId } = await setup()
    const created = await intakeMention(pool, intakeParams(workspaceId, principalId, 'C1:5.1', 'C1:5.1'))
    if (created.kind !== 'created') throw new Error('expected a new task')
    const taskId = created.task.id

    const first = await acquireLease(pool, taskId, 'daemon-a', 60_000)
    if (!first) throw new Error('expected a lease')
    expect(await renewLease(pool, first, 60_000)).toBe(true)
    expect(await acquireLease(pool, taskId, 'daemon-b', 60_000)).toBeUndefined()

    // Expire it, let another holder take it, and the first holder's write is dropped.
    await pool.query(`UPDATE autonomous_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [taskId])
    const second = await acquireLease(pool, taskId, 'daemon-b', 60_000)
    if (!second) throw new Error('expected the expired lease to be taken')
    expect(second.generation).toBe(first.generation + 1)
    expect(await updateTask(pool, first, { accountKey: 'claude' })).toBeUndefined()
    expect(await renewLease(pool, first, 60_000)).toBe(false)
    expect((await updateTask(pool, second, { accountKey: 'claude2' }))?.accountKey).toBe('claude2')

    await requestCancel(pool, taskId)
    await pool.query(`UPDATE autonomous_tasks SET lease_expires_at = NULL WHERE id = $1`, [taskId])
    expect(await acquireLease(pool, taskId, 'daemon-c', 60_000)).toBeUndefined()
    expect((await loadTask(pool, taskId))?.cancelRequestedAt).not.toBeNull()
  })

  it('leaves existing approval rows readable with a null receipt and the standard kind', async () => {
    const { rows } = await pool.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
       WHERE table_name = 'approvals' AND column_name IN ('receipt', 'kind', 'allowed_principal_ids', 'operation_id')
       ORDER BY column_name`,
    )
    expect(rows.map((row) => row.column_name)).toEqual(['allowed_principal_ids', 'kind', 'operation_id', 'receipt'])
    expect(rows.find((row) => row.column_name === 'kind')?.column_default).toContain('standard')
  })
})
