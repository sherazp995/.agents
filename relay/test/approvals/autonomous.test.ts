import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { createRun, finishRun, startRun } from '../../src/runs/store.js'
import {
  createApproval,
  createApprovalInTransaction,
  getApproval,
  operationDigest,
  resolveApproval,
  type ApprovalKind,
  type CreateApprovalParams,
} from '../../src/approvals/store.js'
import { verifyApprovalReceipt } from '../../src/approvals/receipt.js'
import { renderApprovalCard, APPROVAL_ACTION_IDS } from '../../src/approvals/blockkit.js'
import { inTransaction } from '../../src/autonomous/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

const KEY = new Uint8Array(Buffer.from('a'.repeat(64), 'hex'))

describe('autonomous approvals', () => {
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

  type World = { workspaceId: string; requester: string; member: string; operator: string; sessionId: string; runId: string; taskId: string }

  async function world(): Promise<World> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principal = (roles: string[]) => provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'P', roles)
    const requester = await principal(['member'])
    const member = await principal(['member'])
    const operator = await principal(['operator'])
    const session = await findOrCreateSession(pool, { workspaceId, principalId: requester, adapter: 'slack', threadRef: `C:${randomUUID()}` })
    const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId: requester })
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id) VALUES ($1, $2, $3) RETURNING id`,
      [workspaceId, session.id, requester],
    )
    return { workspaceId, requester, member, operator, sessionId: session.id, runId: run.id, taskId: rows[0]?.id ?? '' }
  }

  async function operation(w: World, digest: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO autonomous_operations (workspace_id, task_id, op_kind, payload, payload_digest)
       VALUES ($1, $2, 'push', '{}', $3) RETURNING id`,
      [w.workspaceId, w.taskId, digest],
    )
    return rows[0]?.id ?? ''
  }

  function params(w: World, kind: ApprovalKind, operationId?: string): CreateApprovalParams {
    return {
      workspaceId: w.workspaceId,
      runId: w.runId,
      sessionId: w.sessionId,
      requesterPrincipalId: w.requester,
      capability: kind === 'plan' ? 'autonomous.plan' : 'autonomous.remote_write',
      description: 'push branch fix-1',
      target: 'origin fix-1 abc123',
      tier: 'irreversible',
      escalationReason: 'remote write',
      requiredRoles: ['operator'],
      timeoutMs: 60_000,
      kind,
      allowedPrincipalIds: [w.requester],
      ...(operationId !== undefined ? { operationId } : {}),
    }
  }

  it('lets the member-role requester and an operator resolve, and refuses another member', async () => {
    const w = await world()
    const a = await createApproval(pool, params(w, 'plan'))
    const b = await createApproval(pool, params(w, 'plan'))
    const c = await createApproval(pool, params(w, 'plan'))
    const resolve = (approvalId: string, resolverPrincipalId: string) =>
      resolveApproval(pool, { workspaceId: w.workspaceId, approvalId, option: 'approve', resolverPrincipalId })

    expect((await resolve(a.id, w.requester)).outcome).toBe('resolved')
    expect((await resolve(b.id, w.member)).outcome).toBe('unauthorized')
    expect((await resolve(c.id, w.operator)).outcome).toBe('resolved')
  })

  it('refuses session grants and edits on plan and remote-write approvals, writing no grant', async () => {
    const w = await world()
    for (const kind of ['plan', 'remote_write'] as const) {
      for (const option of ['approve_all_session', 'edit_and_approve'] as const) {
        const approval = await createApproval(pool, params(w, kind))
        const result = await resolveApproval(pool, {
          workspaceId: w.workspaceId,
          approvalId: approval.id,
          option,
          resolverPrincipalId: w.operator,
          editedArguments: '{}',
        })
        expect(result.outcome).toBe('option_not_allowed')
        expect(result.approval?.status).toBe('pending')
      }
    }
    const { rows } = await pool.query('SELECT 1 FROM session_approval_grants WHERE workspace_id = $1', [w.workspaceId])
    expect(rows).toHaveLength(0)
  })

  it('resolves a duplicate click once and moves its operation to approved', async () => {
    const w = await world()
    const operationId = await operation(w, 'digest-1')
    const approval = await createApproval(pool, params(w, 'remote_write', operationId))
    const click = () =>
      resolveApproval(pool, { workspaceId: w.workspaceId, approvalId: approval.id, option: 'approve', resolverPrincipalId: w.requester, receiptKey: KEY })

    const outcomes = await Promise.all([click(), click()])

    expect(outcomes.map((result) => result.outcome).sort()).toEqual(['already_resolved', 'resolved'])
    const { rows } = await pool.query<{ state: string }>('SELECT state FROM autonomous_operations WHERE id = $1', [operationId])
    expect(rows[0]?.state).toBe('approved')
  })

  it('verifies a genuine approval receipt against its operation digest', async () => {
    const w = await world()
    const operationId = await operation(w, 'digest-2')
    const approval = await createApproval(pool, params(w, 'remote_write', operationId))
    await resolveApproval(pool, { workspaceId: w.workspaceId, approvalId: approval.id, option: 'approve', resolverPrincipalId: w.requester, receiptKey: KEY })

    const stored = await getApproval(pool, w.workspaceId, approval.id)
    if (!stored) throw new Error('missing approval')
    expect(verifyApprovalReceipt(KEY, stored, await operationDigest(pool, operationId))).toBe(true)
    expect(verifyApprovalReceipt(KEY, stored, 'some-other-digest')).toBe(false)
  })

  it('refuses an approval set to approved by SQL with no receipt', async () => {
    const w = await world()
    const operationId = await operation(w, 'digest-3')
    const approval = await createApproval(pool, params(w, 'remote_write', operationId))
    await pool.query(
      `UPDATE approvals SET status = 'approved', selected_option = 'approve', resolved_by_principal_id = $2, resolved_at = now() WHERE id = $1`,
      [approval.id, w.requester],
    )

    const stored = await getApproval(pool, w.workspaceId, approval.id)
    if (!stored) throw new Error('missing approval')
    expect(verifyApprovalReceipt(KEY, stored, 'digest-3')).toBe(false)
  })

  it('refuses a legitimately denied approval edited to approved in the database with the denial receipt kept', async () => {
    const w = await world()
    for (const kind of ['plan', 'remote_write'] as const) {
      const operationId = kind === 'remote_write' ? await operation(w, `digest-${kind}`) : undefined
      const approval = await createApproval(pool, params(w, kind, operationId))
      await resolveApproval(pool, { workspaceId: w.workspaceId, approvalId: approval.id, option: 'deny', resolverPrincipalId: w.requester, receiptKey: KEY })
      await pool.query(`UPDATE approvals SET status = 'approved', selected_option = 'approve' WHERE id = $1`, [approval.id])

      const stored = await getApproval(pool, w.workspaceId, approval.id)
      if (!stored) throw new Error('missing approval')
      expect(stored.receipt).not.toBeNull()
      expect(verifyApprovalReceipt(KEY, stored, await operationDigest(pool, stored.operationId))).toBe(false)
    }
  })

  it('resolves an approval normally after the run that created it has finished', async () => {
    const w = await world()
    const approval = await createApproval(pool, params(w, 'plan'))
    await startRun(pool, w.runId)
    await finishRun(pool, w.runId, 'succeed')

    const result = await resolveApproval(pool, { workspaceId: w.workspaceId, approvalId: approval.id, option: 'approve', resolverPrincipalId: w.requester })
    expect(result.outcome).toBe('resolved')
  })

  it('rolls back the approval and its queued card together when a failure follows createApprovalInTransaction', async () => {
    const w = await world()
    await expect(
      inTransaction(pool, async (client) => {
        const approval = await createApprovalInTransaction(client, params(w, 'plan'))
        await client.query(
          `INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'slack', $2, now())`,
          [w.workspaceId, { kind: 'post_approval_card', ref: { channel: 'C1' }, text: approval.id, blocks: [] }],
        )
        throw new Error('injected')
      }),
    ).rejects.toThrow('injected')

    const approvals = await pool.query('SELECT 1 FROM approvals WHERE workspace_id = $1', [w.workspaceId])
    const outbox = await pool.query('SELECT 1 FROM outbox WHERE workspace_id = $1', [w.workspaceId])
    expect(approvals.rows).toHaveLength(0)
    expect(outbox.rows).toHaveLength(0)
  })
})

describe('approval card buttons by kind', () => {
  const base = {
    approvalId: 'apr_1',
    capability: 'autonomous.remote_write',
    description: 'push',
    target: 'origin fix-1',
    tier: 'irreversible',
    escalationReason: 'remote write',
    runId: 'run_1',
    sessionId: 'ses_1',
    requesterDisplayName: 'Req',
    requiresTypedConfirmation: false,
  }

  function actionIds(card: ReturnType<typeof renderApprovalCard>): string[] {
    const actions = card.blocks.find((block) => block.type === 'actions') as { elements: { action_id: string }[] }
    return actions.elements.map((element) => element.action_id)
  }

  it('renders approve and deny only for plan and remote-write cards, and all four for a standard card', () => {
    const only = [APPROVAL_ACTION_IDS.approve, APPROVAL_ACTION_IDS.deny]
    expect(actionIds(renderApprovalCard({ ...base, kind: 'remote_write', operation: { kind: 'push', text: 'git push origin abc:refs/heads/fix-1' } }))).toEqual(only)
    expect(
      actionIds(renderApprovalCard({ ...base, kind: 'plan', plan: { summary: 's', scope: 'x', acceptanceCriteria: ['a'], testCommand: 'pnpm test' } })),
    ).toEqual(only)
    expect(actionIds(renderApprovalCard(base))).toHaveLength(4)
  })
})
