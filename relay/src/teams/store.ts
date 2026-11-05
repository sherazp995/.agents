/**
 * Persistence for running teams (0028_team_runs.sql): team runs, assignments
 * and merge records.
 *
 * The fencing rules:
 *   - A member's writes name its assignment lease (owner and generation); a
 *     write from a superseded holder changes nothing.
 *   - A note to the lead is written in the same transaction as the
 *     assignment change that caused it, and only while the task is not
 *     cancelled, so a stopped task gets no late notes and a crash never
 *     loses one. It does not need the lead's own lease: the lead may be idle
 *     or mid-turn, and a note added mid-turn is kept for its next turn.
 */

import type { Pool, PoolClient } from 'pg'
import type { Assignment, AssignmentKind, AssignmentLease, AssignmentState, RunSnapshot, TeamRun, TeamRunKind, TeamRunStatus } from './types.js'

type Db = Pool | PoolClient

/** A write the database refused for a reason a command can name. */
export class TeamConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamConflict'
  }
}

const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint: name } = error as { code?: unknown; constraint?: unknown }
  return code === PG_UNIQUE_VIOLATION && name === constraint
}

// Team runs

type RunRow = {
  id: string
  workspace_id: string
  task_id: string
  project_id: string
  title: string
  kind: TeamRunKind
  repo_name: string
  repo_path: string
  pr_ref: string | null
  base_commit: string
  worktree_path: string | null
  branch: string | null
  snapshot: RunSnapshot
  status: TeamRunStatus
  created_at: Date
}

function toRun(row: RunRow): TeamRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    projectId: row.project_id,
    title: row.title,
    kind: row.kind,
    repoName: row.repo_name,
    repoPath: row.repo_path,
    prRef: row.pr_ref,
    baseCommit: row.base_commit,
    worktreePath: row.worktree_path,
    branch: row.branch,
    snapshot: row.snapshot,
    status: row.status,
    createdAt: row.created_at,
  }
}

export type NewRun = {
  readonly id: string
  readonly workspaceId: string
  readonly taskId: string
  readonly projectId: string
  readonly title: string
  readonly kind: TeamRunKind
  readonly repoName: string
  readonly repoPath: string
  readonly prRef: string | null
  readonly baseCommit: string
  readonly worktreePath: string | null
  readonly branch: string | null
  readonly snapshot: RunSnapshot
}

/** Records a started run; a second open run for the task is refused by the database. */
export async function insertRun(db: Db, run: NewRun): Promise<TeamRun> {
  try {
    const { rows } = await db.query<RunRow>(
      `INSERT INTO team_runs (id, workspace_id, task_id, project_id, title, kind, repo_name, repo_path, pr_ref, base_commit, worktree_path, branch, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [run.id, run.workspaceId, run.taskId, run.projectId, run.title, run.kind, run.repoName, run.repoPath, run.prRef, run.baseCommit, run.worktreePath, run.branch, JSON.stringify(run.snapshot)],
    )
    return toRun(requireRow(rows[0]))
  } catch (error) {
    if (isUniqueViolation(error, 'team_runs_one_open')) throw new TeamConflict('This thread already has an open team request; finish it first (relay team finish).')
    throw error
  }
}

export async function loadOpenRun(db: Db, taskId: string): Promise<TeamRun | undefined> {
  const { rows } = await db.query<RunRow>(`SELECT * FROM team_runs WHERE task_id = $1 AND status = 'open'`, [taskId])
  return rows[0] ? toRun(rows[0]) : undefined
}

export async function loadRun(db: Db, runId: string): Promise<TeamRun | undefined> {
  const { rows } = await db.query<RunRow>('SELECT * FROM team_runs WHERE id = $1', [runId])
  return rows[0] ? toRun(rows[0]) : undefined
}

/** The project's latest team run, for the setup page. */
export async function latestRunForProject(db: Db, workspaceId: string, projectId: string): Promise<TeamRun | undefined> {
  const { rows } = await db.query<RunRow>('SELECT * FROM team_runs WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 1', [workspaceId, projectId])
  return rows[0] ? toRun(rows[0]) : undefined
}

/** Closes an open run; its assignments that are still live are cancelled with it. Returns their process groups. */
export async function closeRun(pool: Pool, runId: string, status: Exclude<TeamRunStatus, 'open'>): Promise<number[]> {
  return inTransaction(pool, async (client) => {
    await client.query(`UPDATE team_runs SET status = $2, closed_at = now() WHERE id = $1 AND status = 'open'`, [runId, status])
    return cancelLive(client, 'run_id = $1', [runId])
  })
}

// Assignments

type AssignmentRow = {
  id: string
  workspace_id: string
  run_id: string
  task_id: string
  project_id: string
  member_id: string
  member_name: string
  kind: AssignmentKind
  brief: string
  idem_key: string
  state: AssignmentState
  worktree_path: string | null
  branch: string | null
  start_commit: string | null
  result_text: string | null
  result_commit: string | null
  checked_commit: string | null
  question: string | null
  pending_notes: string[]
  answers: string[]
  engine_session_id: string | null
  account_key: string | null
  lease_owner: string | null
  lease_generation: string
  lease_expires_at: Date | null
  worker_pid: number | null
  worker_pgid: number | null
  attempts: number
  restarts: number
  next_wakeup_at: Date | null
  login_wait_told: boolean
  created_at: Date
}

function toAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    taskId: row.task_id,
    projectId: row.project_id,
    memberId: row.member_id,
    memberName: row.member_name,
    kind: row.kind,
    brief: row.brief,
    idemKey: row.idem_key,
    state: row.state,
    worktreePath: row.worktree_path,
    branch: row.branch,
    startCommit: row.start_commit,
    resultText: row.result_text,
    resultCommit: row.result_commit,
    checkedCommit: row.checked_commit,
    question: row.question,
    pendingNotes: row.pending_notes,
    answers: row.answers,
    engineSessionId: row.engine_session_id,
    accountKey: row.account_key,
    leaseOwner: row.lease_owner,
    // bigint comes back from pg as a string.
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at,
    workerPid: row.worker_pid,
    workerPgid: row.worker_pgid,
    attempts: row.attempts,
    restarts: row.restarts,
    nextWakeupAt: row.next_wakeup_at,
    loginWaitTold: row.login_wait_told,
    createdAt: row.created_at,
  }
}

export type NewAssignment = {
  readonly workspaceId: string
  readonly run: TeamRun
  readonly memberId: string
  readonly memberName: string
  readonly kind: AssignmentKind
  readonly brief: string
  readonly idemKey: string
}

/** Adds an assignment due now; a repeated key returns the one already there. */
export async function insertAssignment(db: Db, input: NewAssignment): Promise<{ assignment: Assignment; created: boolean }> {
  const { rows } = await db.query<AssignmentRow>(
    `INSERT INTO team_assignments (workspace_id, run_id, task_id, project_id, member_id, member_name, kind, brief, idem_key, next_wakeup_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (task_id, idem_key) DO NOTHING
     RETURNING *`,
    [input.workspaceId, input.run.id, input.run.taskId, input.run.projectId, input.memberId, input.memberName, input.kind, input.brief, input.idemKey],
  )
  if (rows[0]) return { assignment: toAssignment(rows[0]), created: true }
  const existing = await db.query<AssignmentRow>('SELECT * FROM team_assignments WHERE task_id = $1 AND idem_key = $2', [input.run.taskId, input.idemKey])
  return { assignment: toAssignment(requireRow(existing.rows[0])), created: false }
}

export async function loadAssignment(db: Db, assignmentId: string): Promise<Assignment | undefined> {
  const { rows } = await db.query<AssignmentRow>('SELECT * FROM team_assignments WHERE id = $1', [assignmentId])
  return rows[0] ? toAssignment(rows[0]) : undefined
}

export async function listRunAssignments(db: Db, runId: string): Promise<Assignment[]> {
  const { rows } = await db.query<AssignmentRow>('SELECT * FROM team_assignments WHERE run_id = $1 ORDER BY created_at, id', [runId])
  return rows.map(toAssignment)
}

/**
 * The lead's answer or follow-up for a member: kept for the member's next
 * turn and in its answers (replayed into a fresh session). A waiting or
 * finished member runs again; a running one reads it next turn.
 */
export async function answerAssignment(db: Db, assignmentId: string, text: string): Promise<Assignment | undefined> {
  const { rows } = await db.query<AssignmentRow>(
    `UPDATE team_assignments
     SET pending_notes = pending_notes || $2::jsonb, answers = answers || $2::jsonb,
         state = CASE WHEN state IN ('waiting', 'done') THEN 'queued' ELSE state END,
         question = CASE WHEN state = 'running' THEN question ELSE NULL END,
         next_wakeup_at = now(), updated_at = now()
     WHERE id = $1 AND state IN ('queued', 'running', 'waiting', 'done')
     RETURNING *`,
    [assignmentId, JSON.stringify([text])],
  )
  return rows[0] ? toAssignment(rows[0]) : undefined
}

/** Assignments due to run, oldest first, whose task is not cancelled and whose run is open. */
export async function listDueAssignments(pool: Pool, workspaceId: string): Promise<(Assignment & { teamId: string; memberLimit: number })[]> {
  const { rows } = await pool.query<AssignmentRow & { team_id: string; member_limit: number }>(
    `SELECT a.*, r.snapshot->>'teamId' AS team_id, (r.snapshot->>'memberLimit')::int AS member_limit
     FROM team_assignments a
     JOIN team_runs r ON r.id = a.run_id AND r.status = 'open'
     JOIN autonomous_tasks t ON t.id = a.task_id AND t.cancel_requested_at IS NULL
     WHERE a.workspace_id = $1 AND a.state = 'queued' AND a.next_wakeup_at IS NOT NULL AND a.next_wakeup_at <= now()
       AND (a.lease_expires_at IS NULL OR a.lease_expires_at < now())
     ORDER BY a.created_at, a.id`,
    [workspaceId],
  )
  return rows.map((row) => ({ ...toAssignment(row), teamId: row.team_id, memberLimit: row.member_limit }))
}

/** Members running now, machine-wide and per team, for the limits. A slot is freed only when its assignment leaves 'running'. */
export async function countRunning(pool: Pool): Promise<{ total: number; byTeam: Map<string, number> }> {
  const { rows } = await pool.query<{ team_id: string; running: string }>(
    `SELECT r.snapshot->>'teamId' AS team_id, count(*) AS running
     FROM team_assignments a JOIN team_runs r ON r.id = a.run_id
     WHERE a.state = 'running'
     GROUP BY 1`,
  )
  const byTeam = new Map(rows.map((row) => [row.team_id, Number(row.running)]))
  return { total: [...byTeam.values()].reduce((sum, count) => sum + count, 0), byTeam }
}

/** Takes a queued assignment's lease and marks it running; each grant bumps the generation. */
export async function acquireAssignmentLease(pool: Pool, assignmentId: string, owner: string, ttlMs: number): Promise<{ lease: AssignmentLease; assignment: Assignment } | undefined> {
  const { rows } = await pool.query<AssignmentRow>(
    `UPDATE team_assignments a
     SET lease_owner = $2, lease_generation = a.lease_generation + 1, lease_expires_at = now() + ($3 * interval '1 millisecond'),
         state = 'running', attempts = a.attempts + 1, next_wakeup_at = NULL, updated_at = now()
     FROM autonomous_tasks t
     WHERE a.id = $1 AND a.state = 'queued' AND (a.lease_expires_at IS NULL OR a.lease_expires_at < now())
       AND t.id = a.task_id AND t.cancel_requested_at IS NULL
     RETURNING a.*`,
    [assignmentId, owner, ttlMs],
  )
  const row = rows[0]
  if (!row) return undefined
  const assignment = toAssignment(row)
  return { lease: { assignmentId, owner, generation: assignment.leaseGeneration }, assignment }
}

export async function renewAssignmentLease(pool: Pool, lease: AssignmentLease, ttlMs: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE team_assignments SET lease_expires_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3 AND state = 'running'`,
    [lease.assignmentId, lease.owner, lease.generation, ttlMs],
  )
  return rowCount === 1
}

/** Recorded before the member's start gate opens, so a dead daemon's survivor can always be found. */
export async function recordAssignmentWorker(pool: Pool, lease: AssignmentLease, pid: number, pgid: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE team_assignments SET worker_pid = $4, worker_pgid = $5, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3 AND state = 'running'`,
    [lease.assignmentId, lease.owner, lease.generation, pid, pgid],
  )
  return rowCount === 1
}

/** Clears the recorded worker once its process group has exited. Not fenced: whoever confirmed the exit may clear it. */
export async function clearAssignmentWorker(db: Db, assignmentId: string, pgid: number): Promise<void> {
  await db.query('UPDATE team_assignments SET worker_pid = NULL, worker_pgid = NULL, updated_at = now() WHERE id = $1 AND worker_pgid = $2', [assignmentId, pgid])
}

/** The columns a member's lease holder may change. */
export type AssignmentUpdate = Partial<{
  state: AssignmentState
  worktreePath: string
  branch: string
  startCommit: string
  resultText: string
  resultCommit: string | null
  checkedCommit: string | null
  question: string | null
  engineSessionId: string | null
  accountKey: string | null
  /** 'now' is the database's clock. */
  nextWakeupAt: Date | 'now' | null
  loginWaitTold: boolean
  /** How many of the pending notes the turn read; they are removed, newer ones kept. */
  notesRead: number
  /** Ends the lease with the write (the turn is over). */
  releaseLease: boolean
}>

const COLUMNS: Record<string, string> = {
  state: 'state',
  worktreePath: 'worktree_path',
  branch: 'branch',
  startCommit: 'start_commit',
  resultText: 'result_text',
  resultCommit: 'result_commit',
  checkedCommit: 'checked_commit',
  question: 'question',
  engineSessionId: 'engine_session_id',
  accountKey: 'account_key',
  nextWakeupAt: 'next_wakeup_at',
  loginWaitTold: 'login_wait_told',
}

function updateSql(lease: AssignmentLease, update: AssignmentUpdate): { sets: string[]; values: unknown[] } {
  const values: unknown[] = [lease.assignmentId, lease.owner, lease.generation]
  const sets: string[] = []
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue
    if (key === 'notesRead') {
      values.push(value)
      sets.push(`pending_notes = COALESCE((SELECT jsonb_agg(note ORDER BY position) FROM jsonb_array_elements(pending_notes) WITH ORDINALITY AS n(note, position) WHERE position > $${values.length}), '[]'::jsonb)`)
      continue
    }
    if (key === 'releaseLease') {
      if (value === true) sets.push('lease_owner = NULL', 'lease_expires_at = NULL')
      continue
    }
    const column = COLUMNS[key]
    if (column === undefined) throw new Error(`team store: unknown assignment field ${key}`)
    if (key === 'nextWakeupAt' && value === 'now') {
      sets.push(`${column} = now()`)
      continue
    }
    values.push(value)
    sets.push(`${column} = $${values.length}`)
  }
  sets.push('updated_at = now()')
  return { sets, values }
}

/** Applies `update` only while `lease` is current; undefined when it was superseded. */
export async function updateAssignment(db: Db, lease: AssignmentLease, update: AssignmentUpdate): Promise<Assignment | undefined> {
  const { sets, values } = updateSql(lease, update)
  const { rows } = await db.query<AssignmentRow>(
    `UPDATE team_assignments SET ${sets.join(', ')}
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3
     RETURNING *`,
    values,
  )
  return rows[0] ? toAssignment(rows[0]) : undefined
}

/**
 * Changes an assignment and adds a note for the lead in one transaction,
 * fenced by the assignment's lease and an uncancelled task; the note wakes
 * the lead. False when either fence failed (nothing is written).
 */
export async function updateAssignmentAndTellLead(pool: Pool, lease: AssignmentLease, update: AssignmentUpdate, note: string): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    // The task row is locked first, so Stop cannot land between the two writes.
    const { rows } = await client.query<{ id: string }>(
      `SELECT t.id FROM autonomous_tasks t JOIN team_assignments a ON a.task_id = t.id
       WHERE a.id = $1 AND t.cancel_requested_at IS NULL FOR UPDATE OF t`,
      [lease.assignmentId],
    )
    const taskId = rows[0]?.id
    if (taskId === undefined) return false
    if ((await updateAssignment(client, lease, update)) === undefined) return false
    return noteLead(client, taskId, note)
  })
}

/** Adds a note to the lead's task and wakes it, unless the task was cancelled. Not fenced by the lead's lease. */
export async function noteLead(db: Db, taskId: string, note: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE autonomous_tasks SET pending_notes = pending_notes || $2::jsonb, next_wakeup_at = now(), updated_at = now()
     WHERE id = $1 AND cancel_requested_at IS NULL`,
    [taskId, JSON.stringify([note])],
  )
  return rowCount === 1
}

/** Cancels one assignment; returns its recorded process group, if any. */
export async function cancelAssignment(pool: Pool, assignmentId: string): Promise<number[]> {
  return cancelLive(pool, 'id = $1', [assignmentId])
}

/** Stop: cancels every live assignment of the task and every open run; returns the process groups to kill. */
export async function cancelTaskAssignments(pool: Pool, taskId: string): Promise<number[]> {
  return inTransaction(pool, async (client) => {
    await client.query(`UPDATE team_runs SET status = 'cancelled', closed_at = now() WHERE task_id = $1 AND status = 'open'`, [taskId])
    return cancelLive(client, 'task_id = $1', [taskId])
  })
}

/** Cancels the live assignments `where` selects: the generation is bumped, so a running holder's writes all fail. */
async function cancelLive(db: Db, where: string, values: unknown[]): Promise<number[]> {
  const { rows } = await db.query<{ worker_pgid: number | null }>(
    `UPDATE team_assignments
     SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, lease_generation = lease_generation + 1,
         next_wakeup_at = NULL, updated_at = now()
     WHERE ${where} AND (state IN ('queued', 'running', 'waiting') OR worker_pgid IS NOT NULL)
     RETURNING worker_pgid`,
    values,
  )
  return rows.flatMap((row) => (row.worker_pgid === null ? [] : [row.worker_pgid]))
}

/** The kill switch: every live assignment in the workspace, whatever its task's phase. */
export async function listLiveAssignments(pool: Pool, workspaceId: string): Promise<Assignment[]> {
  const { rows } = await pool.query<AssignmentRow>(
    `SELECT * FROM team_assignments WHERE workspace_id = $1 AND (state IN ('queued', 'running', 'waiting') OR worker_pgid IS NOT NULL)`,
    [workspaceId],
  )
  return rows.map(toAssignment)
}

/** Startup recovery: every assignment that still names a worker or is marked running. */
export async function listInterruptedAssignments(pool: Pool, workspaceId: string): Promise<Assignment[]> {
  const { rows } = await pool.query<AssignmentRow>(`SELECT * FROM team_assignments WHERE workspace_id = $1 AND (state = 'running' OR worker_pgid IS NOT NULL)`, [workspaceId])
  return rows.map(toAssignment)
}

/**
 * After a restart: a running assignment runs once more, or fails when it
 * already had its second attempt; the lead is told either way. Not fenced by
 * a lease (no holder survives a restart) but by the generation it read.
 */
export async function recoverAssignment(pool: Pool, assignment: Assignment, maxRestarts: number): Promise<'requeued' | 'failed' | 'skipped'> {
  const retry = assignment.restarts < maxRestarts
  return inTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE team_assignments
       SET state = $3, lease_owner = NULL, lease_expires_at = NULL, lease_generation = lease_generation + 1, restarts = restarts + 1,
           next_wakeup_at = CASE WHEN $3 = 'queued' THEN now() ELSE NULL END, updated_at = now()
       WHERE id = $1 AND lease_generation = $2 AND state = 'running'`,
      [assignment.id, assignment.leaseGeneration, retry ? 'queued' : 'failed'],
    )
    if (rowCount !== 1) return 'skipped'
    const note = retry
      ? `Team: Relay restarted while ${assignment.memberName} was working on assignment ${assignment.id}; it runs again.`
      : `Team: ${assignment.memberName}'s assignment ${assignment.id} was interrupted twice by a restart and is marked failed. Assign it again if it is still needed.`
    await noteLead(client, assignment.taskId, note)
    return retry ? 'requeued' : 'failed'
  })
}

/** Gives back a lease whose turn never started (no worktree, a recorded worker that would not exit). */
export async function requeueAssignment(db: Db, lease: AssignmentLease, delayMs: number): Promise<boolean> {
  const updated = await updateAssignment(db, lease, { state: 'queued', nextWakeupAt: new Date(Date.now() + delayMs), releaseLease: true })
  return updated !== undefined
}

// Merges

export type MergeState = 'started' | 'merged' | 'conflict'
export type MergeRecord = {
  readonly id: string
  readonly assignmentId: string
  readonly memberCommit: string
  readonly headBefore: string | null
  readonly headAfter: string | null
  readonly state: MergeState
  readonly conflictFiles: readonly string[]
}

type MergeRow = { id: string; assignment_id: string; member_commit: string; head_before: string | null; head_after: string | null; state: MergeState; conflict_files: string[] }

function toMerge(row: MergeRow): MergeRecord {
  return { id: row.id, assignmentId: row.assignment_id, memberCommit: row.member_commit, headBefore: row.head_before, headAfter: row.head_after, state: row.state, conflictFiles: row.conflict_files }
}

/** The merge record for this assignment and member commit, made on first use. */
export async function findOrCreateMerge(db: Db, workspaceId: string, assignmentId: string, memberCommit: string): Promise<MergeRecord> {
  await db.query(
    `INSERT INTO team_merges (workspace_id, assignment_id, member_commit) VALUES ($1, $2, $3) ON CONFLICT (assignment_id, member_commit) DO NOTHING`,
    [workspaceId, assignmentId, memberCommit],
  )
  const { rows } = await db.query<MergeRow>('SELECT * FROM team_merges WHERE assignment_id = $1 AND member_commit = $2', [assignmentId, memberCommit])
  return toMerge(requireRow(rows[0]))
}

export async function settleMerge(db: Db, mergeId: string, result: { state: Exclude<MergeState, 'started'>; headBefore: string | null; headAfter: string | null; conflictFiles?: readonly string[] }): Promise<MergeRecord> {
  const { rows } = await db.query<MergeRow>(
    `UPDATE team_merges SET state = $2, head_before = $3, head_after = $4, conflict_files = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [mergeId, result.state, result.headBefore, result.headAfter, [...(result.conflictFiles ?? [])]],
  )
  return toMerge(requireRow(rows[0]))
}

/** Every merge recorded for a run, newest first. */
export async function listRunMerges(db: Db, runId: string): Promise<MergeRecord[]> {
  const { rows } = await db.query<MergeRow>(
    `SELECT m.* FROM team_merges m JOIN team_assignments a ON a.id = m.assignment_id WHERE a.run_id = $1 ORDER BY m.updated_at DESC`,
    [runId],
  )
  return rows.map(toMerge)
}

function requireRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('team store: a write that must return a row returned none')
  return row
}

async function inTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await body(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
