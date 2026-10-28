import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import type { ChatAction } from '../../src/chat/contract.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveApproval } from '../../src/approvals/store.js'
import { createRun } from '../../src/runs/store.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { requestShellWrite, settleTaskOperations } from '../../src/autonomous/operations.js'
import { acquireLease, intakeMention, loadTask, type IntakeOutbox } from '../../src/autonomous/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('remote-write approvals', () => {
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

  const outbox: IntakeOutbox = {
    async enqueue(action: ChatAction, workspaceId: string, executor?: PoolClient) {
      await (executor ?? pool).query(`INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'test', $2, now())`, [workspaceId, action])
      return ''
    },
  }
  const deps = { outbox, receiptKey: new Uint8Array(32), approvalTimeoutMs: 60_000 }

  async function newTask() {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Requester', ['member'])
    const result = await intakeMention(pool, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `C1:${randomUUID()}`,
      event: { id: `C1:${randomUUID()}`, principalId, text: 'push it', ref: { channel: 'C1', message: '1.1' }, fileIds: [], receivedAt: new Date().toISOString() },
      replyRef: { channel: 'C1', thread: '1.1' },
      files: [],
    })
    if (result.kind !== 'created') throw new Error('expected a new task')
    const task = result.task
    const lease = await acquireLease(pool, task.id, 'test', 60_000)
    if (!lease) throw new Error('expected a lease')
    const run = await createRun(pool, { workspaceId, sessionId: task.sessionId, principalId })
    const context = { workspaceId, taskId: task.id, runId: run.id, leaseGeneration: lease.generation }
    return { task, lease, context, principalId }
  }

  /** The requester's click in Slack. */
  async function decide(context: { workspaceId: string; taskId: string }, principalId: string, option: 'approve' | 'deny'): Promise<void> {
    const { rows } = await pool.query<{ approval_id: string }>('SELECT approval_id FROM autonomous_operations WHERE task_id = $1', [context.taskId])
    for (const { approval_id } of rows) {
      const result = await resolveApproval(pool, { workspaceId: context.workspaceId, approvalId: approval_id, option, resolverPrincipalId: principalId, receiptKey: deps.receiptKey })
      expect(result.approval?.status).toBe(option === 'approve' ? 'approved' : 'denied')
    }
  }

  it('asks once per command, tells the next turn once about the approval, and lets that command run once', async () => {
    const { task, lease, context, principalId } = await newTask()
    const write = { command: 'git push origin main', cwd: '/repo' }
    expect(await requestShellWrite(pool, deps, context, write)).toEqual({ kind: 'pending' })
    expect(await requestShellWrite(pool, deps, context, write)).toEqual({ kind: 'pending' })
    const { rows } = await pool.query('SELECT id FROM autonomous_operations WHERE task_id = $1', [task.id])
    expect(rows).toHaveLength(1)

    await decide(context, principalId, 'approve')
    await settleTaskOperations(pool, lease)
    await settleTaskOperations(pool, lease)
    expect((await loadTask(pool, task.id))?.pendingNotes).toEqual(['Approved. Run it again now, exactly as before, in /repo:\ngit push origin main'])
    const { rows: states } = await pool.query('SELECT state FROM autonomous_operations WHERE task_id = $1', [task.id])
    expect(states).toEqual([{ state: 'approved' }])

    expect(await requestShellWrite(pool, deps, context, { ...write, command: 'git push origin other' })).toEqual({ kind: 'pending' })
    expect(await requestShellWrite(pool, deps, context, write)).toEqual({ kind: 'approved' })
    expect(await requestShellWrite(pool, deps, context, write)).toEqual({ kind: 'pending' })
  })

  it('tells the next turn once not to run a denied command, and closes it', async () => {
    const { task, lease, context, principalId } = await newTask()
    await requestShellWrite(pool, deps, context, { command: 'gh pr create', cwd: '/repo' })
    await decide(context, principalId, 'deny')
    await settleTaskOperations(pool, lease)
    await settleTaskOperations(pool, lease)
    expect((await loadTask(pool, task.id))?.pendingNotes).toEqual(['Not approved, so do not run it: gh pr create\nThe user did not approve it.'])
    const { rows } = await pool.query('SELECT state FROM autonomous_operations WHERE task_id = $1', [task.id])
    expect(rows).toEqual([{ state: 'skipped' }])
  })
})
