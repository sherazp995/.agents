import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { createRun } from '../../src/runs/store.js'
import { resolveApproval } from '../../src/approvals/store.js'
import type { ChatAction } from '../../src/chat/contract.js'
import { acquireLease, intakeMention, loadTask, updateTask, type AutonomousTask, type IntakeOutbox, type Lease } from '../../src/autonomous/store.js'
import { planDigest, planTarget, postPlanForApproval, settlePlanApproval, sweepExpiredApprovals, type PlanApprovalDeps } from '../../src/autonomous/plan-approval.js'
import type { PlanPayload } from '../../src/autonomous/reply.js'
import { getTestDatabaseUrl } from '../support/database.js'

const PLAN: PlanPayload = { summary: 'fix login', task_type: 'implement', change_kind: 'fix', visible: true, scope: 'login form', acceptance_criteria: ['logs in'], test_command: 'pnpm test', repo: 'web' }

describe('plan approval', () => {
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

  function deps(overrides: Partial<PlanApprovalDeps> = {}): PlanApprovalDeps {
    return {
      pool,
      outbox,
      approvalTimeoutMs: 60_000,
      replyRef: async () => ({ channel: 'C1', thread: '1.1' }),
      requesterDisplayName: async () => 'Requester',
      isOperator: async () => false,
      ...overrides,
    }
  }

  async function setup(): Promise<{ task: AutonomousTask; lease: Lease; runId: string; member: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'R', ['member'])
    const member = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'M', ['member'])
    const result = await intakeMention(pool, outbox, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
      event: { id: `C1:${randomUUID()}`, principalId, text: 'fix login', ref: { channel: 'C1', message: '1.1' }, fileIds: [], receivedAt: new Date().toISOString() },
      mentionRef: { channel: 'C1', message: '1.1' },
      replyRef: { channel: 'C1', thread: '1.1' },
      files: [],
    })
    if (result.kind !== 'created') throw new Error('expected a task')
    const lease = await acquireLease(pool, result.task.id, 'test', 60_000)
    if (!lease) throw new Error('no lease')
    await pool.query(`UPDATE autonomous_tasks SET pending_events = '[]' WHERE id = $1`, [result.task.id])
    const run = await createRun(pool, { workspaceId, sessionId: result.task.sessionId, principalId })
    return { task: result.task, lease, runId: run.id, member }
  }

  async function latestApproval(sessionId: string) {
    const { rows } = await pool.query<{ id: string; status: string; target: string }>(`SELECT id, status, target FROM approvals WHERE session_id = $1 ORDER BY created_at DESC`, [sessionId])
    return rows
  }

  async function park(task: AutonomousTask, lease: Lease): Promise<AutonomousTask> {
    return (await updateTask(pool, lease, { phase: 'awaiting_plan_approval' })) ?? task
  }

  it('posts a plan card bound to the version digest, and approval copies exactly the stored plan', async () => {
    const { task, lease, runId } = await setup()
    await postPlanForApproval(deps(), task, lease, PLAN, 'web', runId)
    const parked = await park(task, lease)

    const [approval] = await latestApproval(task.sessionId)
    expect(approval?.target).toBe(planTarget(1, planDigest(PLAN)))
    const { rows } = await pool.query<{ action: ChatAction }>(`SELECT action FROM outbox WHERE workspace_id = $1 AND action->>'kind' = 'post_approval_card'`, [task.workspaceId])
    expect(rows).toHaveLength(1)

    await resolveApproval(pool, { workspaceId: task.workspaceId, approvalId: approval?.id ?? '', option: 'approve', resolverPrincipalId: task.requesterPrincipalId })
    const settled = await settlePlanApproval(deps(), parked, lease)
    expect(settled?.phase).toBe('working')
    expect(await loadTask(pool, task.id)).toMatchObject({ testCommand: 'pnpm test', changeKind: 'fix', visible: true, approvedScope: 'login form', repoName: 'web' })
  })

  it('a non-requester member cannot approve the plan', async () => {
    const { task, lease, runId, member } = await setup()
    await postPlanForApproval(deps(), task, lease, PLAN, 'web', runId)
    const [approval] = await latestApproval(task.sessionId)
    const result = await resolveApproval(pool, { workspaceId: task.workspaceId, approvalId: approval?.id ?? '', option: 'approve', resolverPrincipalId: member })
    expect(result.outcome).toBe('unauthorized')
  })

  it('a newer plan version expires the earlier card, so approving the earlier one does nothing', async () => {
    const { task, lease, runId } = await setup()
    await postPlanForApproval(deps(), task, lease, PLAN, 'web', runId)
    const v1 = (await loadTask(pool, task.id)) as AutonomousTask
    await postPlanForApproval(deps(), v1, lease, { ...PLAN, test_command: 'pnpm vitest run' }, 'web', runId)
    const [v2Approval, v1Approval] = await latestApproval(task.sessionId)

    expect(v1Approval?.status).toBe('timed_out')
    const click = await resolveApproval(pool, { workspaceId: task.workspaceId, approvalId: v1Approval?.id ?? '', option: 'approve', resolverPrincipalId: task.requesterPrincipalId })
    expect(click.outcome).not.toBe('resolved')
    expect(v2Approval?.status).toBe('pending')
  })

  it('an expired plan approval is announced; a requester reply posts a fresh card that can be approved', async () => {
    const { task, lease, runId } = await setup()
    await postPlanForApproval(deps({ approvalTimeoutMs: 1 }), task, lease, PLAN, 'web', runId)
    await park(task, lease)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const announced: string[] = []
    await sweepExpiredApprovals(deps(), task.workspaceId, async (_session, text) => {
      announced.push(text)
    })
    expect(announced).toEqual([expect.stringContaining('expired')])

    await pool.query(`UPDATE autonomous_tasks SET pending_events = $2 WHERE id = $1`, [task.id, JSON.stringify([{ id: 'e2', principalId: task.requesterPrincipalId, text: 'again please', ref: { channel: 'C1' }, fileIds: [], receivedAt: '' }])])
    const replied = (await loadTask(pool, task.id)) as AutonomousTask
    expect(await settlePlanApproval(deps(), replied, lease)).toEqual({ notes: [] })

    const [fresh] = await latestApproval(task.sessionId)
    expect(fresh?.status).toBe('pending')
    expect((await loadTask(pool, task.id))?.pendingEvents).toEqual([])
    const click = await resolveApproval(pool, { workspaceId: task.workspaceId, approvalId: fresh?.id ?? '', option: 'approve', resolverPrincipalId: task.requesterPrincipalId })
    expect(click.outcome).toBe('resolved')
  })
})
