/**
 * Durable remote-write operations (0021 `autonomous_operations`) and the
 * approvals that name them.
 *
 * An operation's payload is immutable once stored, and its digest is what
 * the approval receipt signs, so what runs is exactly what was approved.
 * State only moves forward: requested, approved (by resolveApproval),
 * dispatching (one durable claim), then succeeded, failed or uncertain; or
 * skipped (denied, timed out, failed verification) and cancelled (Stop).
 * Nothing here talks to git or GitHub: src/autonomous/remote-write.ts runs
 * the effect, and the MCP gateway runs an `mcp_write` it was told to.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { canonicalise } from '../audit/chain.js'
import { renderApprovalCard } from '../approvals/blockkit.js'
import { verifyApprovalReceipt } from '../approvals/receipt.js'
import { createApprovalInTransaction, expireApproval, getApproval } from '../approvals/store.js'
import type { ChatRef } from '../chat/contract.js'
import type { RiskTier } from '../capabilities/registry.js'
import { scanText } from '../repos/secrets-gate.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import {
  mcpCallDigest,
  type InvocationContext,
  type McpCallRequest,
  type McpOperationAnswer,
  type McpOperations,
} from './mcp-protocol.js'
import { inTransaction, type IntakeOutbox } from './store.js'

export const OPERATION_STATES = ['requested', 'approved', 'dispatching', 'succeeded', 'failed', 'uncertain', 'skipped', 'cancelled'] as const
export type OperationState = (typeof OPERATION_STATES)[number]

/** Where a repository write lands. `repo` is the canonical URL; `ghRepo` is what `gh --repo` is given. */
type RepoTarget = { workspaceId: string; taskId: string; repoName: string; repo: string; ghRepo: string; headSha: string }

/** The stored bytes of one operation. Bodies already carry their relay-op marker. */
export type OperationPayload =
  | (RepoTarget & { kind: 'push'; branch: string; baseSha: string; worktree: string })
  | (RepoTarget & { kind: 'pr_create'; base: string; head: string; baseSha: string; title: string; body: string })
  | (RepoTarget & { kind: 'pr_comment'; pr: number; body: string })
  | (RepoTarget & { kind: 'pr_review'; pr: number; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string })
  | (RepoTarget & { kind: 'issue_create'; title: string; body: string })
  | (RepoTarget & { kind: 'issue_comment'; issue: number; body: string })
  | { kind: 'api_write'; workspaceId: string; taskId: string; method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body: string }
  | { kind: 'mcp_write'; workspaceId: string; taskId: string; server: string; tool: string; args: unknown }

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

/** What an `mcp_write` is found and consumed by is the call digest the gateway computes too; every other kind digests its canonical payload. */
export function digestOf(payload: OperationPayload): string {
  if (payload.kind === 'mcp_write') return mcpCallDigest({ server: payload.server, tool: payload.tool, args: payload.args })
  return createHash('sha256').update(canonicalise(payload)).digest('hex')
}

/** The marker embedded in every body relay posts, so a restart can find what a crashed dispatch already wrote. */
export function operationMarker(operationId: string): string {
  return `<!-- relay-op:${operationId} -->`
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

/** Stores a `requested` operation under an id chosen before the payload, so bodies can carry its marker. */
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
  switch (payload.kind) {
    case 'push':
      return {
        capability: 'autonomous.remote_write',
        tier: 'irreversible',
        title: `push ${payload.headSha.slice(0, 12)} to ${payload.branch}`,
        text: `Push commit ${payload.headSha} to ${payload.repo} as refs/heads/${payload.branch}. Nothing else: no PR is opened.`,
      }
    case 'pr_create':
      return {
        capability: 'autonomous.remote_write',
        tier: 'write',
        title: `open a draft PR from ${payload.head} into ${payload.base}`,
        text:
          `Open a draft PR in ${payload.ghRepo} from ${payload.head} (which must already hold ${payload.headSha}) into ` +
          `${payload.base}. Nothing is pushed.\nTitle: ${payload.title}\n\n${payload.body}`,
      }
    case 'pr_comment':
      return { capability: 'autonomous.remote_write', tier: 'write', title: `comment on PR #${payload.pr}`, text: `Comment on PR #${payload.pr} in ${payload.ghRepo}:\n\n${payload.body}` }
    case 'pr_review':
      return {
        capability: 'autonomous.remote_write',
        tier: 'write',
        title: `review PR #${payload.pr} (${payload.event})`,
        text: `Submit a ${payload.event} review on PR #${payload.pr} in ${payload.ghRepo}:\n\n${payload.body}`,
      }
    case 'issue_create':
      return { capability: 'autonomous.remote_write', tier: 'write', title: 'open an issue', text: `Open an issue in ${payload.ghRepo}.\nTitle: ${payload.title}\n\n${payload.body}` }
    case 'issue_comment':
      return { capability: 'autonomous.remote_write', tier: 'write', title: `comment on issue #${payload.issue}`, text: `Comment on issue #${payload.issue} in ${payload.ghRepo}:\n\n${payload.body}` }
    case 'api_write':
      return { capability: 'autonomous.remote_write', tier: 'write', title: `${payload.method} ${payload.path}`, text: `GitHub API ${payload.method} ${payload.path} with body:\n${payload.body}` }
    case 'mcp_write':
      return {
        capability: 'autonomous.mcp_write',
        tier: 'write',
        title: `call ${payload.server}.${payload.tool}`,
        text: `Call MCP tool ${payload.server}.${payload.tool} with arguments:\n${JSON.stringify(payload.args, null, 2)}`,
      }
  }
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
    escalationReason: 'Every remote write an autonomous task makes is approved one operation at a time.',
    requiredRoles: ['operator'],
    timeoutMs: deps.approvalTimeoutMs,
    kind: 'remote_write',
    allowedPrincipalIds: [thread.requesterPrincipalId],
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
export async function checkOperationApproval(pool: Pool, deps: Pick<OperationDeps, 'receiptKey'>, operation: Operation): Promise<ApprovalCheck> {
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

/**
 * The one durable claim: only the caller whose update returned the row
 * dispatches it. A Stop that lands after the caller's checks still wins,
 * because the task's cancel flag is read in the same statement.
 * `claimedBy` names the gateway invocation an `mcp_write` was handed to.
 */
export async function claimOperation(executor: Pool | PoolClient, operationId: string, claimedBy?: string): Promise<Operation | undefined> {
  const { rows } = await executor.query<OperationRow>(
    `UPDATE autonomous_operations o SET state = 'dispatching', claimed_at = now(), result = $2
     FROM autonomous_tasks t
     WHERE o.id = $1 AND o.state = 'approved' AND t.id = o.task_id AND t.cancel_requested_at IS NULL
     RETURNING o.*`,
    [operationId, claimedBy === undefined ? null : JSON.stringify({ claimedBy })],
  )
  return rows[0] ? toOperation(rows[0]) : undefined
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

/** Denied, timed out, or its verification failed: the operation never runs. Posts why. False when it had already left requested and approved. */
export async function skipOperation(pool: Pool, deps: Pick<OperationDeps, 'outbox'>, operationId: string, reason: string): Promise<boolean> {
  const skipped = await inTransaction(pool, async (client) => {
    const operation = await loadOperation(client, operationId)
    if (!operation) return false
    if (!(await settleOperation(client, operationId, ['requested', 'approved'], 'skipped', { reason }))) return false
    const thread = await loadTaskThread(client, operation.taskId)
    if (thread) await postInThread(client, deps, thread, `Not done: ${describeOperation(operation.payload).title}. ${reason}`)
    return true
  })
  if (skipped) await expireLinkedApprovals(pool, [operationId])
  return skipped
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
 * The guard's view of `mcp_write` operations (src/autonomous/mcp-protocol.ts).
 * Never executes anything itself: an `execute` answer hands the gateway the
 * stored arguments once, after the claim.
 */
class DeadlineExceeded extends Error {}

export function createMcpOperations(pool: Pool, deps: OperationDeps): McpOperations {
  return {
    async requestMcpOperation(context: InvocationContext, call: McpCallRequest, signal?: AbortSignal): Promise<McpOperationAnswer> {
      const late: McpOperationAnswer = { kind: 'refused', reason: 'the decision exceeded its deadline' }
      // A function, not a narrowed value: the signal can abort between awaits.
      const aborted = (): boolean => signal?.aborted === true
      const refusal = await refuseInvocation(pool, context)
      if (refusal !== undefined) return { kind: 'refused', reason: refusal }
      const digest = mcpCallDigest(call)

      const { rows } = await pool.query<OperationRow>(
        `SELECT * FROM autonomous_operations
         WHERE task_id = $1 AND workspace_id = $2 AND op_kind = 'mcp_write' AND payload_digest = $3
           AND state IN ('requested', 'approved', 'dispatching')
         ORDER BY created_at`,
        [context.taskId, context.workspaceId, digest],
      )
      const open = rows.map(toOperation)
      if (open.some((operation) => operation.state === 'dispatching')) return { kind: 'refused', reason: 'the approved call is already running' }
      const approved = open.find((operation) => operation.state === 'approved')
      if (approved) {
        const check = await checkOperationApproval(pool, deps, approved)
        if (!check.ok) {
          await settleOperation(pool, approved.id, ['approved'], 'failed', { refused: check.reason })
          return { kind: 'refused', reason: check.reason }
        }
        if (aborted()) return late
        const claimed = await claimOperation(pool, approved.id, context.invocationId)
        if (!claimed || claimed.payload.kind !== 'mcp_write') return { kind: 'refused', reason: 'the approved call was already used' }
        if (aborted()) {
          // The gateway was told deny and will not run it: hand the claim back so a retry can use it.
          await pool.query(`UPDATE autonomous_operations SET state = 'approved', result = NULL, claimed_at = NULL WHERE id = $1 AND state = 'dispatching'`, [claimed.id])
          return late
        }
        return { kind: 'execute', operationId: claimed.id, args: claimed.payload.args }
      }
      const waiting = open.find((operation) => operation.state === 'requested')
      if (waiting) return { kind: 'pending', operationId: waiting.id }

      const secret = refuseSecretText(canonicalise(call.args ?? null), 'tool arguments')
      if (secret !== undefined) return { kind: 'refused', reason: secret }
      if (aborted()) return late
      return inTransaction(pool, async (client): Promise<McpOperationAnswer> => {
        // Two identical calls racing must create one operation, not two cards.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`relay-mcp-op:${context.taskId}:${digest}`])
        const { rows: raced } = await client.query<{ id: string }>(
          `SELECT id FROM autonomous_operations
           WHERE task_id = $1 AND op_kind = 'mcp_write' AND payload_digest = $2 AND state = 'requested'`,
          [context.taskId, digest],
        )
        if (raced[0]) return { kind: 'pending', operationId: raced[0].id }
        const thread = await loadTaskThread(client, context.taskId)
        const runId = await invocationRunId(client, context)
        if (!thread || runId === undefined) return { kind: 'refused', reason: 'the task or invocation is gone' }
        const operation = await insertOperation(client, newOperationId(), {
          kind: 'mcp_write',
          workspaceId: context.workspaceId,
          taskId: context.taskId,
          server: call.server,
          tool: call.tool,
          args: call.args ?? null,
        })
        await offerApprovalInTransaction(client, deps, operation, thread, runId)
        // Rolled back when the bridge already answered deny, so no card is posted for a call the worker saw refused.
        if (aborted()) throw new DeadlineExceeded()
        return { kind: 'pending', operationId: operation.id }
      }).catch((error: unknown) => {
        if (error instanceof DeadlineExceeded) return late
        throw error
      })
    },

    /** Settles an `mcp_write` only from the invocation it was handed to, while still dispatching. */
    async recordOperationOutcome(context: InvocationContext, operationId: string, outcome: { ok: boolean; result: unknown }): Promise<void> {
      await inTransaction(pool, async (client) => {
        const { rows } = await client.query<OperationRow>(
          `UPDATE autonomous_operations SET state = $4, result = $5, finished_at = now()
           WHERE id = $1 AND task_id = $2 AND workspace_id = $3 AND op_kind = 'mcp_write' AND state = 'dispatching'
             AND result ->> 'claimedBy' = $6
           RETURNING *`,
          [operationId, context.taskId, context.workspaceId, outcome.ok ? 'succeeded' : 'failed', JSON.stringify(outcome.result ?? null), context.invocationId],
        )
        const row = rows[0]
        if (!row) return
        const thread = await loadTaskThread(client, context.taskId)
        const title = describeOperation(row.payload).title
        if (thread) await postInThread(client, deps, thread, outcome.ok ? `Done: ${title}.` : `Failed: ${title}.`)
      })
    },
  }
}

/** The invocation must be this task's, in this workspace, under the task's current lease generation, and the task not stopped. */
async function refuseInvocation(pool: Pool, context: InvocationContext): Promise<string | undefined> {
  const thread = await loadTaskThread(pool, context.taskId)
  if (!thread || thread.workspaceId !== context.workspaceId) return 'unknown task'
  if (thread.cancelled) return 'the task was stopped'
  if (thread.leaseGeneration !== context.leaseGeneration) return 'the invocation no longer holds the task'
  if ((await invocationRunId(pool, context)) === undefined) return 'unknown invocation'
  return undefined
}

async function invocationRunId(executor: Pool | PoolClient, context: InvocationContext): Promise<string | undefined> {
  const { rows } = await executor.query<{ run_id: string }>(
    'SELECT run_id FROM autonomous_invocations WHERE id = $1 AND task_id = $2 AND workspace_id = $3',
    [context.invocationId, context.taskId, context.workspaceId],
  )
  return rows[0]?.run_id
}
