/**
 * `relay team merge` (teams phase 2, step 6): puts a member's commit on the
 * request branch as a recorded operation, so a bridge timeout followed by a
 * retry, a restart, or Stop mid-merge always ends in "merged" or "not
 * merged" with a clean request worktree.
 *
 * The order: the merge record for (assignment, member commit) is found or
 * made first; a run-wide advisory lock on a dedicated connection keeps two
 * merges of one run apart; inside it, a half-done merge left in the
 * worktree is aborted, a commit the branch already holds is recorded as
 * merged without merging again (git finished before the record was saved),
 * and otherwise git merges with --no-ff. A conflict is aborted and its files
 * named. Never `git reset --hard`.
 */

import type { Pool, PoolClient } from 'pg'
import { findOrCreateMerge, settleMerge } from './store.js'
import type { Assignment, TeamRun } from './types.js'
import { runGit } from './worktrees.js'

export type MergeOutcome =
  | { readonly kind: 'merged'; readonly head: string; readonly already: boolean }
  | { readonly kind: 'conflict'; readonly files: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string }

const MESSAGE_BRIEF_LIMIT = 60

/** Merges the assignment's result commit into the run's request branch. */
export async function mergeAssignment(pool: Pool, run: TeamRun, assignment: Assignment): Promise<MergeOutcome> {
  if (run.kind !== 'build' || run.worktreePath === null) return { kind: 'refused', reason: 'This is a PR review run: nothing is merged in it.' }
  if (assignment.runId !== run.id) return { kind: 'refused', reason: `Assignment ${assignment.id} is not part of this team run.` }
  if (assignment.kind !== 'build') return { kind: 'refused', reason: `Assignment ${assignment.id} is a ${assignment.kind} assignment; only build work is merged.` }
  const commit = assignment.resultCommit
  if (assignment.state !== 'done' || commit === null) return { kind: 'refused', reason: `${assignment.memberName}'s assignment ${assignment.id} is ${assignment.state} with no result commit yet; merge it once it is done.` }

  const closed = await closedReason(pool, run)
  if (closed !== undefined) return { kind: 'refused', reason: closed }
  const record = await findOrCreateMerge(pool, run.workspaceId, assignment.id, commit)
  if (record.state === 'merged' && record.headAfter !== null) return { kind: 'merged', head: record.headAfter, already: true }

  const client = await pool.connect()
  let releaseError: Error | undefined
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [run.id])
    try {
      return await mergeLocked(client, run, assignment, commit)
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [run.id]).catch((error: unknown) => {
        // The lock dies with the connection, so a failed unlock destroys it.
        releaseError = error instanceof Error ? error : new Error(String(error))
      })
    }
  } finally {
    client.release(releaseError)
  }
}

async function mergeLocked(client: PoolClient, run: TeamRun, assignment: Assignment, commit: string): Promise<MergeOutcome> {
  const worktree = run.worktreePath as string
  // Rechecked under the lock: Stop or finish may have landed while it waited.
  const closed = await closedReason(client, run)
  if (closed !== undefined) return { kind: 'refused', reason: closed }
  const record = await findOrCreateMerge(client, run.workspaceId, assignment.id, commit)
  if (record.state === 'merged' && record.headAfter !== null) return { kind: 'merged', head: record.headAfter, already: true }

  if ((await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktree)).code === 0) {
    const aborted = await runGit(['merge', '--abort'], worktree)
    if (aborted.code !== 0) return { kind: 'refused', reason: `A half-done merge in ${worktree} could not be aborted: ${aborted.stderr}` }
  }

  const head = await runGit(['rev-parse', 'HEAD'], worktree)
  if (head.code !== 0) return { kind: 'refused', reason: `The request worktree ${worktree} could not be read: ${head.stderr}` }
  if ((await runGit(['merge-base', '--is-ancestor', commit, 'HEAD'], worktree)).code === 0) {
    await settleMerge(client, record.id, { state: 'merged', headBefore: record.headBefore ?? head.stdout, headAfter: head.stdout })
    return { kind: 'merged', head: head.stdout, already: true }
  }

  const merged = await runGit(['merge', '--no-ff', '-m', mergeMessage(assignment), commit], worktree)
  if (merged.code === 0) {
    const after = await runGit(['rev-parse', 'HEAD'], worktree)
    await settleMerge(client, record.id, { state: 'merged', headBefore: head.stdout, headAfter: after.stdout })
    return { kind: 'merged', head: after.stdout, already: false }
  }

  const unmerged = await runGit(['diff', '--name-only', '--diff-filter=U'], worktree)
  const files = unmerged.stdout === '' ? [] : unmerged.stdout.split('\n')
  if ((await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktree)).code === 0) await runGit(['merge', '--abort'], worktree)
  if (files.length === 0) return { kind: 'refused', reason: `git could not merge ${commit}: ${merged.stderr || merged.stdout}` }
  await settleMerge(client, record.id, { state: 'conflict', headBefore: head.stdout, headAfter: head.stdout, conflictFiles: files })
  return { kind: 'conflict', files }
}

export function mergeMessage(assignment: Pick<Assignment, 'memberName' | 'brief'>): string {
  const firstLine = (assignment.brief.split('\n').find((line) => line.trim() !== '') ?? '').trim()
  const brief = firstLine.slice(0, MESSAGE_BRIEF_LIMIT).trimEnd()
  return `Merge ${assignment.memberName}'s work: ${brief}`
}

/** Why nothing may be merged into this run now, or undefined while its task is live and the run open. */
async function closedReason(db: Pool | PoolClient, run: TeamRun): Promise<string | undefined> {
  const { rows } = await db.query<{ status: string; cancelled: boolean }>(
    `SELECT r.status, (t.cancel_requested_at IS NOT NULL OR t.phase = 'stopped') AS cancelled
     FROM team_runs r JOIN autonomous_tasks t ON t.id = r.task_id WHERE r.id = $1`,
    [run.id],
  )
  const row = rows[0]
  if (row === undefined) return 'This team run no longer exists.'
  if (row.cancelled) return 'This task was stopped; nothing more is merged.'
  if (row.status !== 'open') return `This team run is ${row.status}; nothing more is merged.`
  return undefined
}
