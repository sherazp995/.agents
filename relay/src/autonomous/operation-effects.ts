/**
 * The scheduler's side of per-operation approvals: turning a worker's
 * `remote_write` into an operation (verifying the snapshot first for a push
 * or PR without passing evidence), and turning decided operations into
 * notes for the worker's next turn. Execution itself is
 * src/autonomous/remote-write.ts's (and the gateway's, for `mcp_write`).
 */

import type { Pool } from 'pg'
import { executeApprovedOperation, offerOperationApproval, requestRemoteWrite, type RemoteWriteDeps } from './remote-write.js'
import { cancelTaskOperations, skipOperation } from './operations.js'
import type { RemoteWrite } from './reply.js'
import type { Snapshot } from './completion.js'
import type { AutonomousTask } from './store.js'

type DecidedRow = { id: string; state: string; op_kind: string; payload: { server?: string; tool?: string }; approval_status: string | null }

/**
 * Notes for the worker about its decided operations: an approved remote
 * write is executed here (at most once) and its outcome reported; an
 * approved `mcp_write` tells the worker to call again with the same
 * arguments; a denied or expired one is skipped.
 */
export async function settleTaskOperations(pool: Pool, deps: RemoteWriteDeps, task: AutonomousTask): Promise<string[]> {
  const { rows } = await pool.query<DecidedRow>(
    `SELECT o.id, o.state, o.op_kind, o.payload, a.status AS approval_status
     FROM autonomous_operations o LEFT JOIN approvals a ON a.id = o.approval_id
     WHERE o.task_id = $1 AND o.state IN ('requested', 'approved') AND a.status IS NOT NULL AND a.status <> 'pending'
     ORDER BY o.created_at`,
    [task.id],
  )
  const notes: string[] = []
  for (const row of rows) {
    if (row.approval_status === 'denied' || row.approval_status === 'timed_out') {
      const reason = row.approval_status === 'denied' ? 'The requester did not approve it.' : 'Its approval expired without an answer.'
      if (await skipOperation(pool, deps, row.id, reason)) notes.push(`Operation ${row.id} skipped: ${reason}`)
      continue
    }
    if (row.op_kind === 'mcp_write') {
      if (row.state === 'approved') notes.push(`Operation ${row.id} approved: call ${row.payload.server ?? ''} ${row.payload.tool ?? ''} again with the same arguments.`)
      continue
    }
    const result = await executeApprovedOperation(pool, deps, row.id)
    switch (result.kind) {
      case 'succeeded':
      case 'failed':
        notes.push(`Operation ${row.id} ${result.kind}: ${result.summary}`)
        break
      case 'refused':
        notes.push(`Operation ${row.id} was refused at execution: ${result.reason}`)
        break
      case 'not_claimed':
        break
    }
  }
  return notes
}

export type RemoteWriteEffectDeps = RemoteWriteDeps & {
  /** The worktree HEAD and relay's frozen base for the task. */
  snapshot(task: AutonomousTask): Promise<Snapshot>
  /** Relay's verification of a snapshot (completion.ts); writes its verification row. */
  verify(task: AutonomousTask): Promise<{ kind: 'passed' } | { kind: 'gaps'; gaps: readonly string[] } | { kind: 'blocked'; reason: string }>
}

/** Turns a `remote_write` reply into an operation; returns the note for the worker. */
export async function requestTaskRemoteWrite(pool: Pool, deps: RemoteWriteEffectDeps, task: AutonomousTask, write: RemoteWrite, runId: string): Promise<string> {
  const snapshot = await deps.snapshot(task)
  const requested = await requestRemoteWrite(pool, deps, { task, write, headSha: snapshot.headSha, baseSha: snapshot.baseSha, runId })
  if (requested.kind === 'refused') return `The remote write was refused: ${requested.reason}`
  if (requested.kind === 'requested') return `Operation ${requested.operationId} waits for the requester's approval in the thread. Continue other local work; you will be told when it is decided.`

  // A push or PR needs passing evidence for exactly this snapshot first.
  const verification = await deps.verify(task)
  if (verification.kind !== 'passed') {
    const gaps = verification.kind === 'gaps' ? verification.gaps.join('; ') : verification.reason
    await skipOperation(pool, deps, requested.operationId, `Verification of ${snapshot.headSha.slice(0, 12)} did not pass: ${gaps}`)
    return `The ${write.kind} was not offered for approval because verification of this commit did not pass: ${gaps}. Fix the gaps, commit, and ask again.`
  }
  const offered = await offerOperationApproval(pool, deps, requested.operationId, runId)
  if (offered.kind === 'requested') return `Verified. Operation ${offered.operationId} waits for the requester's approval in the thread.`
  return `The ${write.kind} could not be offered: ${offered.kind === 'refused' ? offered.reason : 'verification evidence is missing'}`
}

/** Stop: cancel waiting operations and expire every pending approval of the task's session. */
export async function cancelTaskWork(pool: Pool, deps: Pick<RemoteWriteDeps, 'outbox'>, task: AutonomousTask): Promise<void> {
  await cancelTaskOperations(pool, deps, task.id)
  await pool.query(`UPDATE approvals SET status = 'timed_out', updated_at = now() WHERE session_id = $1 AND status = 'pending'`, [task.sessionId])
}
