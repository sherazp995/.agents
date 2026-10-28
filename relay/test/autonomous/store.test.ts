import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findActiveSession, findOrCreateSession } from '../../src/sessions/store.js'
import type { ChatAction } from '../../src/chat/contract.js'
import {
  acquireLease,
  intakeMention,
  loadTask,
  renewLease,
  requestCancel,
  updateTask,
  type IntakeMentionParams,
  type IntakeOutbox,
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

  /** Records queued actions in the caller's transaction, like Outbox.enqueue, optionally failing. */
  function recordingOutbox(failOn?: ChatAction['kind']): IntakeOutbox & { queued: () => Promise<ChatAction[]> } {
    const workspaceIds = new Set<string>()
    return {
      async enqueue(action: ChatAction, workspaceId: string, executor: PoolClient) {
        if (action.kind === failOn) throw new Error(`injected failure on ${action.kind}`)
        workspaceIds.add(workspaceId)
        const { rows } = await executor.query<{ id: string }>(
          `INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'test', $2, now()) RETURNING id`,
          [workspaceId, action],
        )
        return rows[0]?.id ?? ''
      },
      async queued() {
        const { rows } = await pool.query<{ action: ChatAction }>(
          `SELECT action FROM outbox WHERE workspace_id = ANY ($1) ORDER BY created_at, id`,
          [[...workspaceIds]],
        )
        return rows.map((row) => row.action)
      },
    }
  }

  function intakeParams(workspaceId: string, principalId: string, threadRef: string, eventId: string): IntakeMentionParams {
    return {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef,
      event: { id: eventId, principalId, text: 'review PR 12', ref: { channel: 'C1', message: '1.1' }, fileIds: [], receivedAt: new Date().toISOString() },
      mentionRef: { channel: 'C1', message: '1.1' },
      replyRef: { channel: 'C1', thread: '1.1' },
      files: [],
    }
  }

  async function count(table: string, workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    return Number(rows[0]?.n)
  }

  it('creates the session as autonomous, the task, and queues only 👀 in one transaction', async () => {
    const { workspaceId, principalId } = await setup()
    const outbox = recordingOutbox()

    const result = await intakeMention(pool, outbox, intakeParams(workspaceId, principalId, 'C1:1.1', 'C1:1.1'))

    expect(result.kind).toBe('created')
    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: 'C1:1.1' })
    expect(session?.mode).toBe('autonomous')
    const reread = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'C1:1.1' })
    expect(reread.mode).toBe('autonomous')
    expect((await outbox.queued()).map((action) => action.kind).sort()).toEqual(['react'])
  })

  it('rolls back the session and task when a failure hits after the session insert, and a retry yields one of each', async () => {
    const { workspaceId, principalId } = await setup()
    const params = intakeParams(workspaceId, principalId, 'C1:2.1', 'C1:2.1')

    await expect(intakeMention(pool, recordingOutbox('react'), params)).rejects.toThrow('injected failure')
    expect(await count('sessions', workspaceId)).toBe(0)
    expect(await count('autonomous_tasks', workspaceId)).toBe(0)
    expect(await count('outbox', workspaceId)).toBe(0)

    const outbox = recordingOutbox()
    await intakeMention(pool, outbox, params)
    const again = await intakeMention(pool, outbox, params)

    expect(again).toMatchObject({ kind: 'appended', duplicate: true })
    expect(await count('sessions', workspaceId)).toBe(1)
    expect(await count('autonomous_tasks', workspaceId)).toBe(1)
    expect((await outbox.queued()).map((action) => action.kind).sort()).toEqual(['react'])
  })

  it('appends a new event to an autonomous task once per event id', async () => {
    const { workspaceId, principalId } = await setup()
    const outbox = recordingOutbox()
    await intakeMention(pool, outbox, intakeParams(workspaceId, principalId, 'C1:3.1', 'C1:3.1'))

    const reply = intakeParams(workspaceId, principalId, 'C1:3.1', 'C1:3.2')
    const first = await intakeMention(pool, outbox, reply)
    const second = await intakeMention(pool, outbox, reply)

    expect(first).toMatchObject({ kind: 'appended', duplicate: false })
    expect(second).toMatchObject({ kind: 'appended', duplicate: true })
    if (second.kind !== 'appended') throw new Error('unreachable')
    expect(second.task.pendingEvents.map((event) => event.id)).toEqual(['C1:3.1', 'C1:3.2'])
  })

  it('adopts an attached governed session as the thread\'s autonomous task, in the same session', async () => {
    const { workspaceId, principalId } = await setup()
    const governed = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'C1:5.1' })
    await pool.query(`UPDATE sessions SET engine_cwd = '/p', engine_session_id = 'chat-1', courier_target = 'agents-39 [a1a227]', live_control_claimed_at = now() WHERE id = $1`, [governed.id])

    const result = await intakeMention(pool, recordingOutbox(), { ...intakeParams(workspaceId, principalId, 'C1:5.1', 'C1:5.2'), adopt: true })

    expect(result).toMatchObject({ kind: 'created', session: { id: governed.id, mode: 'autonomous' } })
    // The attachment ends with the chat, so the next message routes to the task instead of parking again.
    expect(await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: 'C1:5.1' })).toMatchObject({ mode: 'autonomous', engineCwd: null, engineSessionId: null, courierTarget: null })
    const { rows } = await pool.query('SELECT 1 FROM sessions WHERE id = $1 AND live_control_claimed_at IS NULL', [governed.id])
    expect(rows).toHaveLength(1)
    expect(await count('sessions', workspaceId)).toBe(1)
  })

  it('changes nothing in a thread that already has a governed session', async () => {
    const { workspaceId, principalId } = await setup()
    const governed = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'C1:4.1' })

    const result = await intakeMention(pool, recordingOutbox(), intakeParams(workspaceId, principalId, 'C1:4.1', 'C1:4.2'))

    expect(result).toEqual({ kind: 'not_autonomous' })
    expect(governed.mode).toBe('governed')
    expect(await count('autonomous_tasks', workspaceId)).toBe(0)
    expect(await count('outbox', workspaceId)).toBe(0)
  })

  it('fences writes by lease generation and refuses to lease a cancelled task', async () => {
    const { workspaceId, principalId } = await setup()
    const created = await intakeMention(pool, recordingOutbox(), intakeParams(workspaceId, principalId, 'C1:5.1', 'C1:5.1'))
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
    expect(await updateTask(pool, first, { phase: 'working' })).toBeUndefined()
    expect(await renewLease(pool, first, 60_000)).toBe(false)
    expect((await updateTask(pool, second, { phase: 'interview' }))?.phase).toBe('interview')

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
