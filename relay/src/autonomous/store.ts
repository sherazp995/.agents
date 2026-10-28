/**
 * Persistence for autonomous tasks (0021_autonomous_tasks.sql).
 *
 * Two rules hold every write here together:
 *   - Intake is one transaction: the session, the task, its first event and
 *     the 👀 and ack notifications commit together or not at all, so a crash
 *     never leaves a task nobody was told about, or a told thread with no task.
 *   - After intake, every state write is fenced by the lease: it names the
 *     owner and generation it holds, and a write from a superseded holder
 *     changes nothing.
 */

import type { Pool, PoolClient } from 'pg'
import type { ChatAction, ChatRef } from '../chat/contract.js'
import { insertActiveSession, toSession, type FindOrCreateSessionParams, type Session, type SessionRow } from '../sessions/store.js'

export const AUTONOMOUS_PHASES = [
  'intake',
  'interview',
  'awaiting_plan_approval',
  'working',
  'verifying',
  'waiting_on_approval',
  'done',
  'blocked',
  'stopped',
] as const
export type AutonomousPhase = (typeof AUTONOMOUS_PHASES)[number]

/** One inbound message kept for the next worker turn. `text` is the sender's own words: untrusted data. */
export type TaskEvent = {
  id: string
  principalId: string
  text: string
  ref: ChatRef
  fileIds: string[]
  receivedAt: string
}

export type TaskFile = {
  slackFileId: string
  name: string
  /** Slack's url_private; downloaded with the bot token only from files.slack.com. */
  url: string
  sizeBytes: number
  status: 'pending' | 'downloaded' | 'skipped'
  localPath?: string
  reason?: string
}

export type TaskFinding = {
  id: string
  severity: string
  file: string
  line: number | null
  summary: string
  status: string
  inScope?: boolean
}

export type AutonomousTask = {
  id: string
  workspaceId: string
  sessionId: string
  requesterPrincipalId: string
  repoName: string | null
  taskType: 'review' | 'implement' | null
  /** Copied from the approved plan; completion reads only these. */
  changeKind: 'fix' | 'feature' | null
  visible: boolean | null
  acceptanceCriteria: string[] | null
  testCommand: string | null
  approvedScope: string | null
  extensionGrantedBy: string | null
  phase: AutonomousPhase
  planVersion: number
  planDigest: string | null
  plan: unknown
  cancelRequestedAt: Date | null
  agentPreference: string | null
  accountKey: string | null
  engineSessionId: string | null
  worktreePath: string | null
  findings: TaskFinding[]
  progressLog: { at: string; text: string }[]
  pendingEvents: TaskEvent[]
  /** Relay's notes for the next turn, oldest first. */
  pendingNotes: string[]
  qaCheckouts: string[]
  files: TaskFile[]
  reviewRounds: number
  leaseOwner: string | null
  leaseGeneration: number
  leaseExpiresAt: Date | null
  workerPid: number | null
  workerPgid: number | null
  nextWakeupAt: Date | null
}

type TaskRow = {
  id: string
  workspace_id: string
  session_id: string
  requester_principal_id: string
  repo_name: string | null
  task_type: 'review' | 'implement' | null
  change_kind: 'fix' | 'feature' | null
  visible: boolean | null
  acceptance_criteria: string[] | null
  test_command: string | null
  approved_scope: string | null
  extension_granted_by: string | null
  phase: AutonomousPhase
  plan_version: number
  plan_digest: string | null
  plan: unknown
  cancel_requested_at: Date | null
  agent_preference: string | null
  account_key: string | null
  engine_session_id: string | null
  worktree_path: string | null
  findings: TaskFinding[]
  progress_log: { at: string; text: string }[]
  pending_events: TaskEvent[]
  pending_notes: string[]
  qa_checkouts: string[]
  files: TaskFile[]
  review_rounds: number
  lease_owner: string | null
  lease_generation: string
  lease_expires_at: Date | null
  worker_pid: number | null
  worker_pgid: number | null
  next_wakeup_at: Date | null
}

function toTask(row: TaskRow): AutonomousTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    requesterPrincipalId: row.requester_principal_id,
    repoName: row.repo_name,
    taskType: row.task_type,
    changeKind: row.change_kind,
    visible: row.visible,
    acceptanceCriteria: row.acceptance_criteria,
    testCommand: row.test_command,
    approvedScope: row.approved_scope,
    extensionGrantedBy: row.extension_granted_by,
    phase: row.phase,
    planVersion: row.plan_version,
    planDigest: row.plan_digest,
    plan: row.plan,
    cancelRequestedAt: row.cancel_requested_at,
    agentPreference: row.agent_preference,
    accountKey: row.account_key,
    engineSessionId: row.engine_session_id,
    worktreePath: row.worktree_path,
    findings: row.findings,
    progressLog: row.progress_log,
    pendingEvents: row.pending_events,
    pendingNotes: row.pending_notes,
    qaCheckouts: row.qa_checkouts,
    files: row.files,
    reviewRounds: row.review_rounds,
    leaseOwner: row.lease_owner,
    // bigint comes back from pg as a string.
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at,
    workerPid: row.worker_pid,
    workerPgid: row.worker_pgid,
    nextWakeupAt: row.next_wakeup_at,
  }
}

/** The part of Outbox intake needs: enqueueing on the intake's own client, so notifications commit with the task; with no client, on the outbox's own pool. */
export type IntakeOutbox = {
  enqueue(action: ChatAction, workspaceId: string, executor?: PoolClient): Promise<string>
}

export type IntakeMentionParams = FindOrCreateSessionParams & {
  event: TaskEvent
  /** The message the 👀 goes on. */
  mentionRef: Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef
  /** The thread the task replies in. */
  replyRef: ChatRef
  files: TaskFile[]
  /** Turns the thread's governed, attached session into its autonomous task instead of refusing it. */
  adopt?: boolean
}

export type IntakeResult =
  | { kind: 'created'; task: AutonomousTask; session: Session }
  | { kind: 'appended'; task: AutonomousTask; duplicate: boolean }
  | { kind: 'not_autonomous' }

/**
 * Takes one mention or thread message into autonomous mode, atomically:
 *   - no active session in the thread: creates the session as autonomous,
 *     the task with this first event, and queues 👀;
 *   - an active autonomous session: appends the event (once per event id)
 *     and any new files;
 *   - an active governed, direct or live-controlled session: changes nothing.
 */
export async function intakeMention(pool: Pool, outbox: IntakeOutbox, params: IntakeMentionParams): Promise<IntakeResult> {
  return inTransaction(pool, async (client) => {
    const createTask = async (session: Session): Promise<IntakeResult> => {
      const { rows } = await client.query<TaskRow>(
        `INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id, pending_events, files, seen_event_ids, next_wakeup_at)
         VALUES ($1, $2, $3, $4, $5, ARRAY[$6], now())
         RETURNING *`,
        [params.workspaceId, session.id, params.principalId, JSON.stringify([params.event]), JSON.stringify(params.files), params.event.id],
      )
      await outbox.enqueue({ kind: 'react', ref: params.mentionRef, name: 'eyes' }, params.workspaceId, client)
      return { kind: 'created', task: toTask(requireRow(rows[0])), session }
    }

    const session = await insertActiveSession(client, params, 'autonomous')
    if (session) return createTask(session)

    const { rows: sessions } = await client.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3 AND state = 'active'
       FOR UPDATE`,
      [params.workspaceId, params.adapter, params.threadRef],
    )
    const active = sessions[0]
    // An active session archived between the INSERT and this SELECT is a
    // real race; the caller's retry takes the creation branch next time.
    if (!active) throw new Error('intakeMention: the active session for this thread disappeared mid-intake')
    if (active.mode !== 'autonomous') {
      // An attached thread whose chat closed keeps its session, now as an autonomous task.
      if (!params.adopt || active.mode !== 'governed') return { kind: 'not_autonomous' }
      // The attachment ends with the chat, so later messages go to the task instead of parking again.
      await client.query(
        `UPDATE sessions SET mode = 'autonomous', live_control_claimed_at = NULL, engine_cwd = NULL, engine_session_id = NULL, courier_target = NULL WHERE id = $1`,
        [active.id],
      )
      const existingTask = await client.query('SELECT 1 FROM autonomous_tasks WHERE session_id = $1', [active.id])
      if (existingTask.rows.length === 0) return createTask(toSession({ ...active, mode: 'autonomous', engine_cwd: null, engine_session_id: null, courier_target: null }))
    }

    const appended = await appendEventInTransaction(client, active.id, params.event, params.files)
    return { kind: 'appended', task: appended.task, duplicate: appended.duplicate }
  })
}

async function appendEventInTransaction(
  client: PoolClient,
  sessionId: string,
  event: TaskEvent,
  files: TaskFile[],
): Promise<{ task: AutonomousTask; duplicate: boolean }> {
  const { rows } = await client.query<TaskRow>(
    `UPDATE autonomous_tasks
     SET pending_events = pending_events || $2::jsonb,
         files = files || $3::jsonb,
         seen_event_ids = array_append(seen_event_ids, $4),
         next_wakeup_at = now(),
         updated_at = now()
     WHERE session_id = $1 AND NOT ($4 = ANY (seen_event_ids))
     RETURNING *`,
    [sessionId, JSON.stringify([event]), JSON.stringify(files), event.id],
  )
  if (rows[0]) return { task: toTask(rows[0]), duplicate: false }
  const existing = await client.query<TaskRow>('SELECT * FROM autonomous_tasks WHERE session_id = $1', [sessionId])
  return { task: toTask(requireRow(existing.rows[0])), duplicate: true }
}

export async function loadTaskBySession(pool: Pool | PoolClient, sessionId: string): Promise<AutonomousTask | undefined> {
  const { rows } = await pool.query<TaskRow>('SELECT * FROM autonomous_tasks WHERE session_id = $1', [sessionId])
  return rows[0] ? toTask(rows[0]) : undefined
}

export async function loadTask(pool: Pool | PoolClient, taskId: string): Promise<AutonomousTask | undefined> {
  const { rows } = await pool.query<TaskRow>('SELECT * FROM autonomous_tasks WHERE id = $1', [taskId])
  return rows[0] ? toTask(rows[0]) : undefined
}

/** What a lease holder names on every write. */
export type Lease = { taskId: string; owner: string; generation: number }

/** Takes the lease when it is free or expired and the task is not cancelled. Each grant bumps the generation, fencing out the previous holder. */
export async function acquireLease(pool: Pool, taskId: string, owner: string, ttlMs: number): Promise<Lease | undefined> {
  const { rows } = await pool.query<{ lease_generation: string }>(
    `UPDATE autonomous_tasks
     SET lease_owner = $2, lease_generation = lease_generation + 1,
         lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
     WHERE id = $1 AND (lease_expires_at IS NULL OR lease_expires_at < now()) AND cancel_requested_at IS NULL
     RETURNING lease_generation`,
    [taskId, owner, ttlMs],
  )
  const row = rows[0]
  return row ? { taskId, owner, generation: Number(row.lease_generation) } : undefined
}

/** True when the holder still holds the lease and it was extended. */
export async function renewLease(pool: Pool, lease: Lease, ttlMs: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks SET lease_expires_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, ttlMs],
  )
  return rowCount === 1
}

export async function releaseLease(pool: Pool, lease: Lease): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation],
  )
  return rowCount === 1
}

/** The columns a lease holder may change, by their task field names. */
export type TaskUpdate = Partial<{
  phase: AutonomousPhase
  repoName: string | null
  taskType: 'review' | 'implement' | null
  changeKind: 'fix' | 'feature' | null
  visible: boolean | null
  acceptanceCriteria: string[] | null
  testCommand: string | null
  planVersion: number
  planDigest: string | null
  plan: unknown
  approvedScope: string | null
  agentPreference: string | null
  extensionGrantedBy: string | null
  accountKey: string | null
  engineSessionId: string | null
  worktreePath: string | null
  findings: TaskFinding[]
  pendingEvents: TaskEvent[]
  files: TaskFile[]
  reviewRounds: number
  /** 'now' is the database's clock, so a wakeup is due at once whatever the host clock says. */
  nextWakeupAt: Date | 'now' | null
}>

const UPDATE_COLUMNS: { [K in keyof Required<TaskUpdate>]: { column: string; json: boolean } } = {
  phase: { column: 'phase', json: false },
  repoName: { column: 'repo_name', json: false },
  taskType: { column: 'task_type', json: false },
  changeKind: { column: 'change_kind', json: false },
  visible: { column: 'visible', json: false },
  acceptanceCriteria: { column: 'acceptance_criteria', json: true },
  testCommand: { column: 'test_command', json: false },
  planVersion: { column: 'plan_version', json: false },
  planDigest: { column: 'plan_digest', json: false },
  plan: { column: 'plan', json: true },
  approvedScope: { column: 'approved_scope', json: false },
  agentPreference: { column: 'agent_preference', json: false },
  extensionGrantedBy: { column: 'extension_granted_by', json: false },
  accountKey: { column: 'account_key', json: false },
  engineSessionId: { column: 'engine_session_id', json: false },
  worktreePath: { column: 'worktree_path', json: false },
  findings: { column: 'findings', json: true },
  pendingEvents: { column: 'pending_events', json: true },
  files: { column: 'files', json: true },
  reviewRounds: { column: 'review_rounds', json: false },
  nextWakeupAt: { column: 'next_wakeup_at', json: false },
}

/**
 * Applies `update` only while `lease` is current. Returns the updated task,
 * or undefined when the lease was superseded (the write is then dropped).
 */
export async function updateTask(
  pool: Pool | PoolClient,
  lease: Lease,
  update: TaskUpdate,
): Promise<AutonomousTask | undefined> {
  const sets: string[] = []
  const values: unknown[] = [lease.taskId, lease.owner, lease.generation]
  for (const [key, value] of Object.entries(update) as [keyof TaskUpdate, unknown][]) {
    if (value === undefined) continue
    const { column, json } = UPDATE_COLUMNS[key]
    if (value === 'now' && key === 'nextWakeupAt') {
      sets.push(`${column} = now()`)
      continue
    }
    values.push(json && value !== null ? JSON.stringify(value) : value)
    sets.push(`${column} = $${values.length}`)
  }
  sets.push('updated_at = now()')
  const { rows } = await pool.query<TaskRow>(
    `UPDATE autonomous_tasks SET ${sets.join(', ')}
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3
     RETURNING *`,
    values,
  )
  return rows[0] ? toTask(rows[0]) : undefined
}

/** Appends to the progress log under the lease. */
export async function appendProgress(pool: Pool, lease: Lease, text: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks SET progress_log = progress_log || $4::jsonb, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, JSON.stringify([{ at: new Date().toISOString(), text }])],
  )
  return rowCount === 1
}

/** Recorded before the worker's start gate opens, so a dead daemon's survivor can always be found. */
export async function recordWorker(pool: Pool, lease: Lease, pid: number, pgid: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks SET worker_pid = $4, worker_pgid = $5, worker_started_at = now(), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, pid, pgid],
  )
  return rowCount === 1
}

/** Clears the recorded worker once its process group has exited. Not fenced: whoever confirmed the exit may clear it. */
export async function clearWorker(pool: Pool, taskId: string, pgid: number): Promise<void> {
  await pool.query(
    `UPDATE autonomous_tasks SET worker_pid = NULL, worker_pgid = NULL, worker_started_at = NULL, updated_at = now()
     WHERE id = $1 AND worker_pgid = $2`,
    [taskId, pgid],
  )
}

/**
 * Inbound facts the router records outside any lease: the agent a mention
 * asked for, and who granted the extension. Neither changes the phase.
 */
export async function recordInboundFacts(
  pool: Pool | PoolClient,
  taskId: string,
  facts: { agentPreference?: string; extensionGrantedBy?: string },
): Promise<void> {
  await pool.query(
    `UPDATE autonomous_tasks
     SET agent_preference = COALESCE($2, agent_preference),
         extension_granted_by = COALESCE($3, extension_granted_by),
         updated_at = now()
     WHERE id = $1`,
    [taskId, facts.agentPreference ?? null, facts.extensionGrantedBy ?? null],
  )
}

/** Removes the events a turn consumed, by id, so events appended during the turn stay pending. */
export async function consumeEvents(pool: Pool | PoolClient, lease: Lease, eventIds: readonly string[]): Promise<boolean> {
  if (eventIds.length === 0) return true
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks
     SET pending_events = COALESCE(
           (SELECT jsonb_agg(event) FROM jsonb_array_elements(pending_events) AS event WHERE NOT (event->>'id' = ANY ($4))),
           '[]'::jsonb),
         updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, eventIds],
  )
  return rowCount === 1
}

/** Adds a note for the next turn and wakes the task, under the lease. */
export async function addNote(pool: Pool | PoolClient, lease: Lease, note: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks SET pending_notes = pending_notes || $4::jsonb, next_wakeup_at = now(), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, JSON.stringify([note])],
  )
  return rowCount === 1
}

/** Removes the first `count` notes: the ones a turn read. Notes added during the turn stay. */
export async function consumeNotes(pool: Pool | PoolClient, lease: Lease, count: number): Promise<boolean> {
  if (count === 0) return true
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks
     SET pending_notes = COALESCE(
           (SELECT jsonb_agg(note ORDER BY position) FROM jsonb_array_elements(pending_notes) WITH ORDINALITY AS t(note, position) WHERE position > $4),
           '[]'::jsonb),
         updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, count],
  )
  return rowCount === 1
}

/** Registers a QA checkout relay created for the task; the guard allows its integration merge there only. */
export async function registerQaCheckout(pool: Pool | PoolClient, lease: Lease, path: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks SET qa_checkouts = array_append(qa_checkouts, $4), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3 AND NOT ($4 = ANY (qa_checkouts))`,
    [lease.taskId, lease.owner, lease.generation, path],
  )
  return rowCount === 1
}

/** Every task not yet done, blocked or stopped: the kill switch stops them all. */
export async function listOpenTasks(pool: Pool, workspaceId: string): Promise<AutonomousTask[]> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT * FROM autonomous_tasks WHERE workspace_id = $1 AND phase NOT IN ('done', 'blocked', 'stopped')`,
    [workspaceId],
  )
  return rows.map(toTask)
}

/** Wakes a task now, outside any lease: an approval resolved or a worker exited. */
export async function wakeTask(pool: Pool | PoolClient, taskId: string): Promise<void> {
  await pool.query('UPDATE autonomous_tasks SET next_wakeup_at = now(), updated_at = now() WHERE id = $1', [taskId])
}

/**
 * Stop's final write. Bumps the lease generation and clears the owner, so a
 * holder still running fails every later fenced write and cannot move the
 * task out of `stopped`.
 */
export async function markTaskStopped(pool: Pool | PoolClient, taskId: string): Promise<AutonomousTask | undefined> {
  const { rows } = await pool.query<TaskRow>(
    `UPDATE autonomous_tasks
     SET phase = 'stopped', lease_owner = NULL, lease_expires_at = NULL, lease_generation = lease_generation + 1,
         next_wakeup_at = NULL, cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [taskId],
  )
  return rows[0] ? toTask(rows[0]) : undefined
}

/** Stop: durable even while the task is parked; the scheduler, guard and executor all check it. */
export async function requestCancel(pool: Pool | PoolClient, taskId: string): Promise<AutonomousTask | undefined> {
  const { rows } = await pool.query<TaskRow>(
    `UPDATE autonomous_tasks SET cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [taskId],
  )
  return rows[0] ? toTask(rows[0]) : undefined
}

/** Tasks whose wakeup time has come, not cancelled and not leased. */
export async function listDueWakeups(pool: Pool, workspaceId: string): Promise<AutonomousTask[]> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT * FROM autonomous_tasks
     WHERE workspace_id = $1 AND next_wakeup_at IS NOT NULL AND next_wakeup_at <= now()
       AND cancel_requested_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < now())
     ORDER BY next_wakeup_at`,
    [workspaceId],
  )
  return rows.map(toTask)
}

/** Startup recovery: every task that still names a worker process group. */
export async function listTasksWithWorker(pool: Pool, workspaceId: string): Promise<AutonomousTask[]> {
  const { rows } = await pool.query<TaskRow>(
    'SELECT * FROM autonomous_tasks WHERE workspace_id = $1 AND worker_pgid IS NOT NULL',
    [workspaceId],
  )
  return rows.map(toTask)
}

function requireRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('autonomous store: a write that must return a row returned none')
  return row
}

export async function inTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
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
