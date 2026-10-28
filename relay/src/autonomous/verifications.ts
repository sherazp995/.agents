/**
 * Evidence relay produced itself for one snapshot (0021
 * `autonomous_verifications`). Completion writes a row for every snapshot it
 * checks, passing or not; the remote-write executor reads it before it
 * offers, and again before it runs, a push or a PR. A row counts only for
 * exactly the repository, base and head it names: evidence for another
 * snapshot is stale and never stands in.
 */

import type { Pool, PoolClient } from 'pg'

export type Verification = {
  id: string
  workspaceId: string
  taskId: string
  /** The canonical repository URL (canonicalRepoUrl in remote-write.ts). */
  repo: string
  baseSha: string
  headSha: string
  testsExit: number | null
  reviewRecord: string | null
  reviewVerdict: string | null
  visualQaVerdict: string | null
  videoQaVerdict: string | null
  passed: boolean
  createdAt: Date
}

export type SnapshotKey = { taskId: string; repo: string; baseSha: string; headSha: string }

export type RecordVerificationParams = SnapshotKey & Omit<Verification, 'id' | 'createdAt' | 'taskId' | 'repo' | 'baseSha' | 'headSha'>

type VerificationRow = {
  id: string
  workspace_id: string
  task_id: string
  repo: string
  base_sha: string
  head_sha: string
  tests_exit: number | null
  review_record: string | null
  review_verdict: string | null
  visual_qa_verdict: string | null
  video_qa_verdict: string | null
  passed: boolean
  created_at: Date
}

function toVerification(row: VerificationRow): Verification {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    repo: row.repo,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    testsExit: row.tests_exit,
    reviewRecord: row.review_record,
    reviewVerdict: row.review_verdict,
    visualQaVerdict: row.visual_qa_verdict,
    videoQaVerdict: row.video_qa_verdict,
    passed: row.passed,
    createdAt: row.created_at,
  }
}

/** One row per snapshot: checking the same snapshot again replaces its result. */
export async function recordVerification(executor: Pool | PoolClient, params: RecordVerificationParams): Promise<Verification> {
  const { rows } = await executor.query<VerificationRow>(
    `INSERT INTO autonomous_verifications
       (workspace_id, task_id, repo, base_sha, head_sha, tests_exit, review_record, review_verdict,
        visual_qa_verdict, video_qa_verdict, passed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (task_id, repo, base_sha, head_sha) DO UPDATE SET
       tests_exit = EXCLUDED.tests_exit, review_record = EXCLUDED.review_record,
       review_verdict = EXCLUDED.review_verdict, visual_qa_verdict = EXCLUDED.visual_qa_verdict,
       video_qa_verdict = EXCLUDED.video_qa_verdict, passed = EXCLUDED.passed, created_at = now()
     RETURNING *`,
    [
      params.workspaceId,
      params.taskId,
      params.repo,
      params.baseSha,
      params.headSha,
      params.testsExit,
      params.reviewRecord,
      params.reviewVerdict,
      params.visualQaVerdict,
      params.videoQaVerdict,
      params.passed,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('recordVerification: INSERT ... RETURNING * returned no row')
  return toVerification(row)
}

/** The passing row for exactly this snapshot, or undefined. */
export async function findPassingVerification(executor: Pool | PoolClient, key: SnapshotKey): Promise<Verification | undefined> {
  const { rows } = await executor.query<VerificationRow>(
    `SELECT * FROM autonomous_verifications
     WHERE task_id = $1 AND repo = $2 AND base_sha = $3 AND head_sha = $4 AND passed`,
    [key.taskId, key.repo, key.baseSha, key.headSha],
  )
  return rows[0] ? toVerification(rows[0]) : undefined
}
