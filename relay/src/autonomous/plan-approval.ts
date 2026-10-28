/**
 * The plan gate. A worker's `plan` is stored on the task as a new version
 * with its digest, and posted with a `plan` approval limited to the
 * requester (or an operator), bound to that version's digest. Approving
 * copies exactly that stored payload into the task's approved fields;
 * completion reads only those. Posting a newer version expires the older
 * version's pending approval, so an old card can no longer approve.
 */

import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { canonicalise } from '../audit/chain.js'
import { createApprovalInTransaction, expireApproval, listOverdueApprovals } from '../approvals/store.js'
import { renderApprovalCard } from '../approvals/blockkit.js'
import type { ChatRef } from '../chat/contract.js'
import { approvedPlanFields } from './phases.js'
import { planPayloadSchema, type PlanPayload } from './reply.js'
import { consumeEvents, inTransaction, updateTask, wakeTask, type AutonomousTask, type IntakeOutbox, type Lease } from './store.js'

export const PLAN_CAPABILITY = 'autonomous.plan'

export function planDigest(plan: PlanPayload): string {
  return createHash('sha256').update(canonicalise(plan)).digest('hex')
}

/** `plan:v<version>:<digest>`: what the approval is bound to. */
export function planTarget(version: number, digest: string): string {
  return `plan:v${version}:${digest}`
}

export type PlanApprovalDeps = {
  pool: Pool
  outbox: IntakeOutbox
  approvalTimeoutMs: number
  replyRef: (task: AutonomousTask) => Promise<ChatRef>
  requesterDisplayName: (task: AutonomousTask) => Promise<string>
  isOperator: (principalId: string) => Promise<boolean>
}

export async function postPlanForApproval(
  deps: PlanApprovalDeps,
  task: AutonomousTask,
  lease: Lease,
  plan: PlanPayload,
  repoName: string,
  runId: string,
): Promise<void> {
  const version = task.planVersion + 1
  const digest = planDigest(plan)
  const ref = await deps.replyRef(task)
  const requester = await deps.requesterDisplayName(task)
  await inTransaction(deps.pool, async (client) => {
    const updated = await updateTask(client, lease, { plan, planVersion: version, planDigest: digest, repoName })
    if (!updated) throw new Error('lost the task lease while storing the plan')
    await client.query(
      `UPDATE approvals SET status = 'timed_out', updated_at = now()
       WHERE session_id = $1 AND kind = 'plan' AND status = 'pending'`,
      [task.sessionId],
    )
    await createPlanCard(client, deps, task, { plan, version, digest, runId, ref, requester })
  })
}

async function createPlanCard(
  client: Parameters<typeof createApprovalInTransaction>[0],
  deps: PlanApprovalDeps,
  task: AutonomousTask,
  card: { plan: PlanPayload; version: number; digest: string; runId: string; ref: ChatRef; requester: string },
): Promise<void> {
  const target = planTarget(card.version, card.digest)
  const description = `Plan v${card.version} for ${card.plan.repo}: ${card.plan.summary}`
  const approval = await createApprovalInTransaction(client, {
    workspaceId: task.workspaceId,
    runId: card.runId,
    sessionId: task.sessionId,
    requesterPrincipalId: task.requesterPrincipalId,
    capability: PLAN_CAPABILITY,
    description,
    target,
    tier: 'write',
    escalationReason: 'Nothing changes until the requester approves the plan.',
    requiredRoles: ['operator'],
    timeoutMs: deps.approvalTimeoutMs,
    kind: 'plan',
    allowedPrincipalIds: [task.requesterPrincipalId],
  })
  const rendered = renderApprovalCard({
    approvalId: approval.id,
    capability: PLAN_CAPABILITY,
    description,
    target,
    tier: 'write',
    escalationReason: 'Nothing changes until the requester approves the plan.',
    runId: card.runId,
    sessionId: task.sessionId,
    requesterDisplayName: card.requester,
    requiresTypedConfirmation: false,
    kind: 'plan',
    plan: { summary: card.plan.summary, scope: card.plan.scope, acceptanceCriteria: card.plan.acceptance_criteria, testCommand: card.plan.test_command },
  })
  await deps.outbox.enqueue({ kind: 'post_approval_card', ref: card.ref, text: rendered.text, blocks: rendered.blocks }, task.workspaceId, client)
}

type LatestPlanApproval = { id: string; status: string; target: string; run_id: string }

/**
 * Applies the outcome of the task's latest plan approval while the task
 * waits on it. Approved for the current digest: copy the stored plan's
 * fields and start working. Denied: back to the interview. Expired: say so
 * once; a reply from the requester or an operator posts a fresh card for the
 * same version.
 */
export async function settlePlanApproval(
  deps: PlanApprovalDeps,
  task: AutonomousTask,
  lease: Lease,
): Promise<{ notes: string[]; phase?: AutonomousTask['phase'] } | undefined> {
  if (task.phase !== 'awaiting_plan_approval' || task.planDigest === null) return undefined
  const { rows } = await deps.pool.query<LatestPlanApproval>(
    `SELECT id, status, target, run_id FROM approvals
     WHERE session_id = $1 AND kind = 'plan' ORDER BY created_at DESC LIMIT 1`,
    [task.sessionId],
  )
  const latest = rows[0]
  if (!latest || latest.status === 'pending') return undefined
  const current = planTarget(task.planVersion, task.planDigest)

  if (latest.status === 'approved') {
    if (latest.target !== current) return undefined
    const parsed = planPayloadSchema.safeParse(task.plan)
    if (!parsed.success) throw new Error(`stored plan v${task.planVersion} no longer validates`)
    await updateTask(deps.pool, lease, approvedPlanFields(parsed.data))
    return { notes: [`Plan v${task.planVersion} was approved. Do the work inside the approved scope in the task worktree, commit locally, and say done when finished.`], phase: 'working' }
  }
  if (latest.status === 'denied') {
    return { notes: [`Plan v${task.planVersion} was not approved. Ask the requester what to change, then propose a revised plan.`], phase: 'interview' }
  }
  // Expired: a reply from someone allowed posts a fresh card for the same version and digest.
  if (task.pendingEvents.length > 0) {
    let allowed = task.pendingEvents.some((event) => event.principalId === task.requesterPrincipalId)
    for (const event of task.pendingEvents) allowed ||= await deps.isOperator(event.principalId)
    if (!allowed) {
      await consumeEvents(deps.pool, lease, task.pendingEvents.map((event) => event.id))
      return { notes: [] }
    }
    const parsed = planPayloadSchema.safeParse(task.plan)
    if (!parsed.success) throw new Error(`stored plan v${task.planVersion} no longer validates`)
    const ref = await deps.replyRef(task)
    const requester = await deps.requesterDisplayName(task)
    const digest = task.planDigest
    await inTransaction(deps.pool, async (client) => {
      await createPlanCard(client, deps, task, { plan: parsed.data, version: task.planVersion, digest, runId: latest.run_id, ref, requester })
      // The reply asked for the card again; it is not a message for the worker.
      await consumeEvents(client, lease, task.pendingEvents.map((event) => event.id))
    })
    return { notes: [] }
  }
  return undefined
}

/** Expires every overdue approval and wakes the task it belongs to; an expired plan approval is announced in its thread. */
export async function sweepExpiredApprovals(deps: PlanApprovalDeps, workspaceId: string, post: (taskSessionId: string, text: string) => Promise<void>): Promise<void> {
  for (const approval of await listOverdueApprovals(deps.pool, workspaceId)) {
    const expired = await expireApproval(deps.pool, workspaceId, approval.id)
    if (expired?.status !== 'timed_out') continue
    const { rows } = await deps.pool.query<{ id: string }>('SELECT id FROM autonomous_tasks WHERE session_id = $1', [approval.sessionId])
    const taskId = rows[0]?.id
    if (taskId === undefined) continue
    if (approval.kind === 'plan') await post(approval.sessionId, 'The plan approval expired. Reply here and I will post it again.')
    else await wakeTask(deps.pool, taskId)
  }
}
