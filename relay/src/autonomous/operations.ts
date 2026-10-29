/**
 * Remote writes waiting for approval (0021 `autonomous_operations`): a shell
 * command that writes to a remote, stored exactly, with the approval card
 * that names it.
 *
 * An operation's payload is immutable once stored, and its digest is what
 * the approval receipt signs, so what runs is exactly what was approved.
 * State only moves forward: requested, approved (by resolveApproval), then
 * succeeded once the guard lets that exact command through; or skipped
 * (denied, timed out) and cancelled (Stop). The worker runs the command
 * itself; relay only decides whether it may.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { canonicalise } from '../audit/chain.js'
import { renderApprovalCard } from '../approvals/blockkit.js'
import { verifyApprovalReceipt } from '../approvals/receipt.js'
import { createApprovalInTransaction, expireApproval, getApproval, listOverdueApprovals } from '../approvals/store.js'
import type { ChatRef } from '../chat/contract.js'
import type { RiskTier } from '../capabilities/registry.js'
import { scanText } from '../repos/secrets-gate.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import type { InvocationContext } from '../engine/hook-bridge.js'
import type { ShellWriteAnswer } from './guard.js'
import { addNote, inTransaction, type IntakeOutbox, type Lease } from './store.js'

export const OPERATION_STATES = ['requested', 'approved', 'dispatching', 'succeeded', 'failed', 'uncertain', 'skipped', 'cancelled'] as const
export type OperationState = (typeof OPERATION_STATES)[number]

/** The stored bytes of one operation: the exact command and the folder it runs in. */
export type OperationPayload = { kind: 'shell_write'; workspaceId: string; taskId: string; command: string; cwd: string }

export type Operation = {
  id: string
  workspaceId: string
  taskId: string
  approvalId: string | null
  kind: OperationPayload['kind']
  payload: OperationPayload
  payloadDigest: string
  state: OperationState
  result: unknown
  claimedAt: Date | null
  finishedAt: Date | null
}

type OperationRow = {
  id: string
  workspace_id: string
  task_id: string
  approval_id: string | null
  op_kind: OperationPayload['kind']
  payload: OperationPayload
  payload_digest: string
  state: OperationState
  result: unknown
  claimed_at: Date | null
  finished_at: Date | null
}

function toOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    approvalId: row.approval_id,
    kind: row.op_kind,
    payload: row.payload,
    payloadDigest: row.payload_digest,
    state: row.state,
    result: row.result,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
  }
}

export function digestOf(payload: OperationPayload): string {
  return createHash('sha256').update(canonicalise(payload)).digest('hex')
}

/** Bytes that must never leave relay: a registered secret value, or anything shaped like a credential. */
export function refuseSecretText(text: string, what: string): string | undefined {
  if (scrubSecrets(text) !== text) return `the ${what} contains a value relay holds as a secret, so it is refused.`
  const found = scanText(text)
  if (found.length > 0) {
    return `the ${what} contains ${found.map((match) => `a ${match.kind} (${match.evidence})`).join(', ')}, so it is refused.`
  }
  return undefined
}

export type OperationDeps = {
  outbox: IntakeOutbox
  /** The daemon's approval receipt key; an approval without a valid receipt never runs. */
  receiptKey: Uint8Array
  approvalTimeoutMs: number
}

/** The thread and people an operation belongs to, read from its task and session. */
export type TaskThread = {
  workspaceId: string
  taskId: string
  sessionId: string
  requesterPrincipalId: string
  requesterName: string
  ref: ChatRef
  cancelled: boolean
  leaseGeneration: number
}

export async function loadTaskThread(executor: Pool | PoolClient, taskId: string): Promise<TaskThread | undefined> {
  const { rows } = await executor.query<{
    workspace_id: string
    session_id: string
    requester_principal_id: string
    display_name: string
    thread_ref: string
    cancel_requested_at: Date | null
    lease_generation: string
  }>(
    `SELECT t.workspace_id, t.session_id, t.requester_principal_id, p.display_name, s.thread_ref,
            t.cancel_requested_at, t.lease_generation
     FROM autonomous_tasks t
     JOIN sessions s ON s.id = t.session_id
     JOIN principals p ON p.id = t.requester_principal_id
     WHERE t.id = $1`,
    [taskId],
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    workspaceId: row.workspace_id,
    taskId,
    sessionId: row.session_id,
    requesterPrincipalId: row.requester_principal_id,
    requesterName: row.display_name,
    ref: threadChatRef(row.thread_ref),
    cancelled: row.cancel_requested_at !== null,
    leaseGeneration: Number(row.lease_generation),
  }
}

/** A Slack thread ref is `<channel>:<thread ts>` (composeThreadRef in the Slack adapter). */
export function threadChatRef(threadRef: string): { channel: string; thread: string } {
  const split = threadRef.indexOf(':')
  if (split <= 0) throw new Error(`autonomous operation: thread ref "${threadRef}" is not <channel>:<thread>`)
  return { channel: threadRef.slice(0, split), thread: threadRef.slice(split + 1) }
}

export async function postInThread(client: PoolClient, deps: Pick<OperationDeps, 'outbox'>, thread: TaskThread, text: string): Promise<void> {
  await deps.outbox.enqueue({ kind: 'post', ref: thread.ref, text: scrubSecrets(text) }, thread.workspaceId, client)
}

export async function loadOperation(executor: Pool | PoolClient, operationId: string): Promise<Operation | undefined> {
  const { rows } = await executor.query<OperationRow>('SELECT * FROM autonomous_operations WHERE id = $1', [operationId])
  return rows[0] ? toOperation(rows[0]) : undefined
}

export async function insertOperation(client: PoolClient, operationId: string, payload: OperationPayload): Promise<Operation> {
  const { rows } = await client.query<OperationRow>(
    `INSERT INTO autonomous_operations (id, workspace_id, task_id, op_kind, payload, payload_digest)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [operationId, payload.workspaceId, payload.taskId, payload.kind, JSON.stringify(payload), digestOf(payload)],
  )
  const row = rows[0]
  if (!row) throw new Error('insertOperation: INSERT ... RETURNING * returned no row')
  return toOperation(row)
}

export function newOperationId(): string {
  return randomUUID()
}

/** How an operation reads on its approval card and in the thread. */
export function describeOperation(payload: OperationPayload): { capability: string; tier: RiskTier; title: string; text: string } {
  const short = payload.command.length > 80 ? `${payload.command.slice(0, 77)}...` : payload.command
  return { capability: 'autonomous.remote_write', tier: 'write', title: `run \`${short}\``, text: `Run in ${payload.cwd}:\n${payload.command}` }
}

/**
 * Creates the `remote_write` approval for a `requested` operation that has
 * none yet, and queues its card, on the caller's transaction. Only the
 * requester (or an operator) may resolve it.
 */
export async function offerApprovalInTransaction(
  client: PoolClient,
  deps: OperationDeps,
  operation: Operation,
  thread: TaskThread,
  runId: string,
): Promise<string> {
  const described = describeOperation(operation.payload)
  const approval = await createApprovalInTransaction(client, {
    workspaceId: thread.workspaceId,
    runId,
    sessionId: thread.sessionId,
    requesterPrincipalId: thread.requesterPrincipalId,
    capability: described.capability,
    description: `Relay asks to ${described.title}.`,
    target: described.title,
    tier: described.tier,
    escalationReason: 'Every remote write from a Slack chat is approved one command at a time.',
    requiredRoles: ['operator'],
    timeoutMs: deps.approvalTimeoutMs,
    // Only an operator approves a push or a GitHub write, never whoever started the thread.
    kind: 'remote_write',
    operationId: operation.id,
  })
  const { rowCount } = await client.query(
    `UPDATE autonomous_operations SET approval_id = $2 WHERE id = $1 AND state = 'requested' AND approval_id IS NULL`,
    [operation.id, approval.id],
  )
  if (rowCount !== 1) throw new Error(`operation ${operation.id} is no longer waiting for an approval`)
  const card = renderApprovalCard({
    approvalId: approval.id,
    capability: approval.capability,
    description: approval.description,
    target: approval.target,
    tier: approval.tier,
    escalationReason: approval.escalationReason,
    runId,
    sessionId: thread.sessionId,
    requesterDisplayName: thread.requesterName,
    requiresTypedConfirmation: false,
    kind: 'remote_write',
    operation: { kind: operation.kind, text: described.text },
  })
  await deps.outbox.enqueue({ kind: 'post_approval_card', ref: thread.ref, text: card.text, blocks: card.blocks }, thread.workspaceId, client)
  return approval.id
}

export type ApprovalCheck = { ok: true } | { ok: false; reason: string }

/**
 * The operation may run only when its stored payload still has its stored
 * digest and its approval is a `remote_write` naming it, approved with a
 * receipt that verifies over that digest.
 */
export async function checkOperationApproval(pool: Pool | PoolClient, deps: Pick<OperationDeps, 'receiptKey'>, operation: Operation): Promise<ApprovalCheck> {
  if (digestOf(operation.payload) !== operation.payloadDigest) return { ok: false, reason: 'the stored operation no longer matches its digest' }
  if (operation.approvalId === null) return { ok: false, reason: 'the operation has no approval' }
  const approval = await getApproval(pool, operation.workspaceId, operation.approvalId)
  if (approval === null || approval.kind !== 'remote_write' || approval.operationId !== operation.id) {
    return { ok: false, reason: 'the approval does not name this operation' }
  }
  if (!verifyApprovalReceipt(deps.receiptKey, approval, operation.payloadDigest)) {
    return { ok: false, reason: 'the approval has no valid receipt for this exact operation' }
  }
  return { ok: true }
}

/** Moves an operation from one of `from` to `to` with its result; false when it was not in `from`. */
export async function settleOperation(
  executor: Pool | PoolClient,
  operationId: string,
  from: readonly OperationState[],
  to: OperationState,
  result: unknown,
): Promise<boolean> {
  const { rowCount } = await executor.query(
    `UPDATE autonomous_operations SET state = $3, result = $4, finished_at = now()
     WHERE id = $1 AND state = ANY ($2::text[])`,
    [operationId, from, to, JSON.stringify(result ?? null)],
  )
  return rowCount === 1
}

/** Stop: every operation of the task still waiting is cancelled, so a later click executes nothing. Returns how many. */
export async function cancelTaskOperations(pool: Pool, deps: Pick<OperationDeps, 'outbox'>, taskId: string): Promise<number> {
  const cancelled = await inTransaction(pool, async (client) => {
    const { rows } = await client.query<OperationRow>(
      `UPDATE autonomous_operations SET state = 'cancelled', result = '{"reason":"the task was stopped"}', finished_at = now()
       WHERE task_id = $1 AND state IN ('requested', 'approved')
       RETURNING *`,
      [taskId],
    )
    if (rows.length === 0) return []
    const thread = await loadTaskThread(client, taskId)
    const titles = rows.map((row) => `• ${describeOperation(row.payload).title}`).join('\n')
    if (thread) await postInThread(client, deps, thread, `Stopped, so these remote writes were cancelled and will not run:\n${titles}`)
    return rows.map((row) => row.id)
  })
  await expireLinkedApprovals(pool, cancelled)
  return cancelled.length
}

/**
 * Closes the still-pending approval of each operation that will never run,
 * so its card stops offering a click. Expired as at its own deadline: the
 * store has no other way to close an approval without a resolver. The
 * operation is already settled first, so a click that wins this race still
 * runs nothing.
 */
async function expireLinkedApprovals(pool: Pool, operationIds: readonly string[]): Promise<void> {
  if (operationIds.length === 0) return
  const { rows } = await pool.query<{ id: string; workspace_id: string; timeout_at: Date }>(
    `SELECT id, workspace_id, timeout_at FROM approvals WHERE operation_id = ANY ($1::uuid[]) AND status = 'pending'`,
    [operationIds],
  )
  for (const row of rows) await expireApproval(pool, row.workspace_id, row.id, row.timeout_at)
}

/**
 * The guard's side: an approved operation for this exact command is used up
 * (it runs once); a waiting one is reported; otherwise a new one is stored
 * and its approval card posted.
 */
export async function requestShellWrite(pool: Pool, deps: OperationDeps, context: InvocationContext, write: { command: string; cwd: string }): Promise<ShellWriteAnswer> {
  const thread = await loadTaskThread(pool, context.taskId)
  if (!thread || thread.workspaceId !== context.workspaceId) return { kind: 'refused', reason: 'unknown task' }
  if (thread.cancelled) return { kind: 'refused', reason: 'the task was stopped' }
  const payload: OperationPayload = { kind: 'shell_write', workspaceId: context.workspaceId, taskId: context.taskId, command: write.command, cwd: write.cwd }
  const digest = digestOf(payload)
  return inTransaction(pool, async (client): Promise<ShellWriteAnswer> => {
    // Two identical calls racing must create one operation, not two cards.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`relay-shell-op:${context.taskId}:${digest}`])
    const { rows } = await client.query<OperationRow>(
      `SELECT * FROM autonomous_operations
       WHERE task_id = $1 AND payload_digest = $2 AND state IN ('requested', 'approved')
       ORDER BY created_at`,
      [context.taskId, digest],
    )
    const approved = rows.map(toOperation).find((operation) => operation.state === 'approved')
    if (approved) {
      const check = await checkOperationApproval(client, deps, approved)
      if (!check.ok) {
        await settleOperation(client, approved.id, ['approved'], 'failed', { refused: check.reason })
        return { kind: 'refused', reason: check.reason }
      }
      await settleOperation(client, approved.id, ['approved'], 'succeeded', { ranBy: context.runId })
      return { kind: 'approved' }
    }
    if (rows.length > 0) return { kind: 'pending' }
    const secret = refuseSecretText(write.command, 'command')
    if (secret !== undefined) return { kind: 'refused', reason: secret }
    const operation = await insertOperation(client, newOperationId(), payload)
    await offerApprovalInTransaction(client, deps, operation, thread, context.runId)
    return { kind: 'pending' }
  })
}

/**
 * Tells the worker's next turn about its decided operations: run an approved
 * one again, drop a denied or expired one. Each note is written with its
 * operation's "told" mark in one transaction under the lease, so it is told
 * exactly once even across a crash.
 */
export async function settleTaskOperations(pool: Pool, lease: Lease): Promise<void> {
  const { rows } = await pool.query<OperationRow & { approval_status: string }>(
    `SELECT o.*, a.status AS approval_status
     FROM autonomous_operations o JOIN approvals a ON a.id = o.approval_id
     WHERE o.task_id = $1 AND o.state IN ('requested', 'approved') AND a.status <> 'pending' AND o.result IS NULL
     ORDER BY o.created_at`,
    [lease.taskId],
  )
  for (const row of rows) {
    const { command, cwd } = row.payload
    const refusal = { denied: 'The user did not approve it.', timed_out: 'Its approval expired without an answer.' }[row.approval_status]
    if (refusal === undefined && row.approval_status !== 'approved') continue
    await inTransaction(pool, async (client) => {
      // An approved operation stays approved until its command runs once (requestShellWrite); the mark only stops a second note.
      const marked = refusal !== undefined
        ? await settleOperation(client, row.id, ['requested', 'approved'], 'skipped', { reason: refusal })
        : (await client.query(
            `UPDATE autonomous_operations SET state = 'approved', result = '{"told":true}' WHERE id = $1 AND state IN ('requested', 'approved') AND result IS NULL`,
            [row.id],
          )).rowCount === 1
      if (!marked) return
      const note = refusal !== undefined ? `Not approved, so do not run it: ${command}\n${refusal}` : `Approved. Run it again now, exactly as before, in ${cwd}:\n${command}`
      if (!(await addNote(client, lease, note))) throw new Error('the task lease was lost while settling an approval')
    })
  }
}

/** Stop: cancel waiting operations and expire every pending approval of the task's session. */
export async function cancelTaskWork(pool: Pool, deps: Pick<OperationDeps, 'outbox'>, task: { id: string; sessionId: string }): Promise<void> {
  await cancelTaskOperations(pool, deps, task.id)
  await pool.query(`UPDATE approvals SET status = 'timed_out', updated_at = now() WHERE session_id = $1 AND status = 'pending'`, [task.sessionId])
}

/** Once per tick: expires overdue approvals and wakes each task waiting on one, so its next turn hears the answer. */
export async function sweepExpiredApprovals(pool: Pool, workspaceId: string): Promise<void> {
  for (const approval of await listOverdueApprovals(pool, workspaceId)) {
    const expired = await expireApproval(pool, workspaceId, approval.id)
    if (expired?.status === 'timed_out') await pool.query('UPDATE autonomous_tasks SET next_wakeup_at = now() WHERE session_id = $1', [approval.sessionId])
  }
}
