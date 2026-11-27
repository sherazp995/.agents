/**
 * Persistence for autonomous tasks (0021_autonomous_tasks.sql).
 *
 * Two rules hold every write here together:
 *   - Intake is one transaction: the session, the task and its first event
 *     commit together or not at all, so a crash never leaves a session with
 *     no task. Relay posts no acknowledgement: the agent writes its own.
 *   - After intake, every state write is fenced by the lease: it names the
 *     owner and generation it holds, and a write from a superseded holder
 *     changes nothing.
 */

import { taskRunsHereSql, type Placement } from '../failover/ownership.js'
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
  /** Set when a Slackbot reminder sent it; its principal is then the owner the channel's config names. */
  origin?: 'reminder'
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

export type AutonomousTask = {
  id: string
  workspaceId: string
  sessionId: string
  requesterPrincipalId: string
  phase: AutonomousPhase
  cancelRequestedAt: Date | null
  agentPreference: string | null
  accountKey: string | null
  engineSessionId: string | null
  /** The Claude Code chat this task took over (see migration 0025), and its folder. */
  chatSessionId: string | null
  chatCwd: string | null
  /** Started by a Slackbot reminder: reading tools only, for the task's whole life (migration 0029). */
  readOnly: boolean
  pendingEvents: TaskEvent[]
  /** Relay's notes for the next turn, oldest first. */
  pendingNotes: string[]
  files: TaskFile[]
  leaseOwner: string | null
  leaseGeneration: number
  leaseExpiresAt: Date | null
  workerPid: number | null
  workerPgid: number | null
  /** The laptop the recorded worker runs on (0030_failover.sql); null before failover or with it off. */
  workerHost: string | null
  /** A reminder's task runs only on this laptop; null runs anywhere. */
  pinnedHost: string | null
  nextWakeupAt: Date | null
}

type TaskRow = {
  id: string
  workspace_id: string
  session_id: string
  requester_principal_id: string
  phase: AutonomousPhase
  cancel_requested_at: Date | null
  agent_preference: string | null
  account_key: string | null
  engine_session_id: string | null
  chat_session_id: string | null
  chat_cwd: string | null
  read_only: boolean
  pending_events: TaskEvent[]
  pending_notes: string[]
  files: TaskFile[]
  lease_owner: string | null
  lease_generation: string
  lease_expires_at: Date | null
  worker_pid: number | null
  worker_pgid: number | null
  worker_host: string | null
  pinned_host: string | null
  next_wakeup_at: Date | null
}

function toTask(row: TaskRow): AutonomousTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    requesterPrincipalId: row.requester_principal_id,
    phase: row.phase,
    cancelRequestedAt: row.cancel_requested_at,
    agentPreference: row.agent_preference,
    accountKey: row.account_key,
    engineSessionId: row.engine_session_id,
    chatSessionId: row.chat_session_id,
    chatCwd: row.chat_cwd,
    readOnly: row.read_only,
    pendingEvents: row.pending_events,
    pendingNotes: row.pending_notes,
    files: row.files,
    leaseOwner: row.lease_owner,
    // bigint comes back from pg as a string.
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at,
    workerPid: row.worker_pid,
    workerPgid: row.worker_pgid,
    workerHost: row.worker_host,
    pinnedHost: row.pinned_host,
    nextWakeupAt: row.next_wakeup_at,
  }
}

/** The part of Outbox intake needs: enqueueing on the intake's own client, so notifications commit with the task; with no client, on the outbox's own pool. */
export type IntakeOutbox = {
  enqueue(action: ChatAction, workspaceId: string, executor?: PoolClient): Promise<string>
}

export type IntakeMentionParams = FindOrCreateSessionParams & {
  event: TaskEvent
  /** The thread the task replies in. */
  replyRef: ChatRef
  files: TaskFile[]
  /** Turns the thread's governed, attached session into its autonomous task instead of refusing it. */
  adopt?: boolean
  /** The folder a new task's chat runs in; a taken-over chat keeps its own. */
  chatCwd?: string
  /** A Slackbot reminder: it only ever creates a new read-only task, never joins or adopts an existing session. */
  readOnly?: boolean
}

type TakenOverChat = { sessionId: string; cwd: string }

export type IntakeResult =
  | { kind: 'created'; task: AutonomousTask; session: Session }
  | { kind: 'appended'; task: AutonomousTask; duplicate: boolean }
  | { kind: 'not_autonomous' }

/**
 * Takes one mention or thread message into autonomous mode, atomically:
 *   - no active session in the thread: creates the session as autonomous
 *     and the task with this first event (no reaction: the agent picks its
 *     own first reply);
 *   - an active autonomous session: appends the event (once per event id)
 *     and any new files;
 *   - an active governed, direct or live-controlled session: changes nothing;
 *   - a read-only (reminder) intake whose thread already has a session:
 *     changes nothing, so a reminder never joins or adopts another task.
 */
export async function intakeMention(pool: Pool, params: IntakeMentionParams): Promise<IntakeResult> {
  return inTransaction(pool, async (client) => {
    const createTask = async (session: Session, chat: TakenOverChat | null = null, chatCwd: string | null = null): Promise<IntakeResult> => {
      const { rows } = await client.query<TaskRow>(
        `INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id, pending_events, files, seen_event_ids, next_wakeup_at,
                                       chat_session_id, chat_cwd, engine_session_id, read_only)
         VALUES ($1, $2, $3, $4, $5, ARRAY[$6], now(), $7, $8, $7, $9)
         RETURNING *`,
        [params.workspaceId, session.id, params.principalId, JSON.stringify([params.event]), JSON.stringify(params.files), params.event.id, chat?.sessionId ?? null, chat?.cwd ?? chatCwd ?? params.chatCwd ?? null, params.readOnly === true],
      )
      return { kind: 'created', task: toTask(requireRow(rows[0])), session }
    }

    const session = await insertActiveSession(client, params, 'autonomous')
    if (session) return createTask(session)
    // A reminder's thread is new; one that already has a session (a redelivery) starts nothing.
    if (params.readOnly === true) return { kind: 'not_autonomous' }

    const { rows: sessions } = await client.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3 AND state = 'active' AND COALESCE(guest_host, '') = COALESCE($4, '')
       FOR UPDATE`,
      [params.workspaceId, params.adapter, params.threadRef, params.guestHost ?? null],
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
        `UPDATE sessions SET mode = 'autonomous', live_control_claimed_at = NULL, engine_cwd = NULL, engine_session_id = NULL, engine_host = NULL, engine_kind = 'claude', courier_target = NULL WHERE id = $1`,
        [active.id],
      )
      const existingTask = await client.query('SELECT 1 FROM autonomous_tasks WHERE session_id = $1', [active.id])
      const adopted = toSession({ ...active, mode: 'autonomous', engine_cwd: null, engine_session_id: null, engine_kind: 'claude', courier_target: null })
      // A Codex chat cannot be resumed by the task's Claude turns: the task keeps its folder and starts a fresh
      // session that reads the thread.
      if (active.engine_kind === 'codex') {
        if (existingTask.rows.length === 0) return createTask(adopted, null, active.engine_cwd)
        await client.query(
          'UPDATE autonomous_tasks SET chat_session_id = NULL, chat_cwd = COALESCE($2, chat_cwd), engine_session_id = NULL, account_key = NULL, updated_at = now() WHERE session_id = $1',
          [active.id, active.engine_cwd],
        )
      }
      // The task carries the chat on, so its turns resume that same chat id in its folder.
      const chat = active.engine_kind !== 'codex' && active.engine_session_id !== null && active.engine_cwd !== null ? { sessionId: active.engine_session_id, cwd: active.engine_cwd } : null
      if (existingTask.rows.length === 0) return createTask(adopted, chat)
      if (chat !== null) {
        await client.query(
          'UPDATE autonomous_tasks SET chat_session_id = $2, chat_cwd = $3, engine_session_id = $2, account_key = NULL, updated_at = now() WHERE session_id = $1',
          [active.id, chat.sessionId, chat.cwd],
        )
      }
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

/**
 * A daemon's lease owner name. With failover on it ends in `@<host>`, which a
 * host name cannot contain, so the other laptop can tell whose lease a
 * cut-off turn left behind (LEASE_HOST_SQL).
 */
export function leaseOwnerName(pid: number, host: string | null): string {
  return host === null ? `relay-${pid}` : `relay-${pid}@${host}`
}

/** Failover off: every task runs on this laptop. */
export const LOCAL_PLACEMENT: Placement = { host: null, isDefault: true }

/** The host part of a lease_owner column; '' for an owner written without one. */
export const LEASE_HOST_SQL = (column: string): string => `split_part(${column}, '@', 2)`

/** A laptop not seen for this long is gone: its workers are not waited on. */
export const HOST_GONE_MS = 60_000

/**
 * True when `host` may signal and wait on a worker recorded with
 * `workerHost`. With failover off (host null) every worker is this laptop's,
 * as before failover existed; with it on, only its own named ones are.
 */
export function isOwnWorker(workerHost: string | null, host: string | null): boolean {
  return host === null || workerHost === host
}

/**
 * Whether the laptop `other` names has gone quiet: not seen for HOST_GONE_MS
 * by the database clock. A null `other` (a row from before failover) is gone
 * only when every laptop other than `host` is.
 */
export async function hostGone(pool: Pool | PoolClient, other: string | null, host: string | null): Promise<boolean> {
  const { rows } = await pool.query<{ fresh: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM failover_hosts
       WHERE last_seen_at > now() - ($3 * interval '1 millisecond')
         AND (CASE WHEN $1::text IS NULL THEN name IS DISTINCT FROM $2::text ELSE name = $1::text END)
     ) AS fresh`,
    [other, host, HOST_GONE_MS],
  )
  return rows[0]?.fresh !== true
}

/** Takes the lease when it is free or expired and the task is not cancelled. Each grant bumps the generation, fencing out the previous holder. */
/** Takes the task's lease; with `place`, only when the task may run on that laptop (src/failover/ownership.ts), checked in the same statement. */
export async function acquireLease(pool: Pool, taskId: string, owner: string, ttlMs: number, place: Placement = LOCAL_PLACEMENT): Promise<Lease | undefined> {
  const { rows } = await pool.query<{ lease_generation: string }>(
    `UPDATE autonomous_tasks AS t
     SET lease_owner = $2, lease_generation = t.lease_generation + 1,
         lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
     WHERE t.id = $1 AND (t.lease_expires_at IS NULL OR t.lease_expires_at < now()) AND t.cancel_requested_at IS NULL
       AND ${taskRunsHereSql('t', '$4', '$5')}
       -- Never over a worker another laptop recorded: it may be running there offline (README, "Failover").
       AND ($4::text IS NULL OR t.worker_pgid IS NULL OR t.worker_host IS NOT DISTINCT FROM $4::text)
     RETURNING t.lease_generation`,
    [taskId, owner, ttlMs, place.host, place.isDefault],
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
  accountKey: string | null
  engineSessionId: string | null
  /** Moved only when the stored folder is missing on this laptop (runtime.ts placeTurn). */
  chatCwd: string | null
  files: TaskFile[]
  /** 'now' is the database's clock, so a wakeup is due at once whatever the host clock says. */
  nextWakeupAt: Date | 'now' | null
}>

const UPDATE_COLUMNS: { [K in keyof Required<TaskUpdate>]: { column: string; json: boolean } } = {
  accountKey: { column: 'account_key', json: false },
  engineSessionId: { column: 'engine_session_id', json: false },
  chatCwd: { column: 'chat_cwd', json: false },
  files: { column: 'files', json: true },
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

/** Recorded before the worker's start gate opens, so a dead daemon's survivor can always be found, and only by the laptop it runs on. */
export async function recordWorker(pool: Pool, lease: Lease, pid: number, pgid: number, host: string | null = null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks SET worker_pid = $4, worker_pgid = $5, worker_host = $6, worker_started_at = now(), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, pid, pgid, host],
  )
  return rowCount === 1
}

/**
 * Clears the recorded worker once its process group has exited. Not fenced:
 * whoever confirmed the exit may clear it. With `host`, only the record that
 * laptop wrote, so a pgid the other laptop just recorded is never cleared.
 */
export async function clearWorker(pool: Pool, taskId: string, pgid: number, host?: string | null): Promise<void> {
  await pool.query(
    `UPDATE autonomous_tasks SET worker_pid = NULL, worker_pgid = NULL, worker_host = NULL, worker_started_at = NULL, updated_at = now()
     WHERE id = $1 AND worker_pgid = $2 AND ($3::boolean IS FALSE OR worker_host IS NOT DISTINCT FROM $4::text)`,
    [taskId, pgid, host !== undefined, host ?? null],
  )
}

/**
 * A step that runs no turn (it asked the thread for a folder): sleeps until
 * the next message, keeping a wakeup set after `dueAt` like consumeTurnInput.
 */
export async function parkTask(pool: Pool | PoolClient, lease: Lease, dueAt: Date | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks
     SET next_wakeup_at = CASE WHEN next_wakeup_at >= $4::timestamptz + interval '1 millisecond' THEN next_wakeup_at ELSE NULL END, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, dueAt ?? new Date(0)],
  )
  return rowCount === 1
}

/**
 * Takeover: every task whose lease a gone laptop still holds had a turn cut
 * off there. Its lease is fenced (a laptop that comes back writes nothing),
 * its worker record dropped without any signal (the process was on that
 * laptop), and it sleeps until someone mentions it again; its messages stay
 * for that turn. Returns the tasks changed, each exactly once, inside
 * `client`'s transaction so the caller's note commits with it.
 */
export async function markInterruptedTasks(client: PoolClient, workspaceId: string, host: string): Promise<AutonomousTask[]> {
  const leaseHost = LEASE_HOST_SQL('t.lease_owner')
  const { rows } = await client.query<TaskRow>(
    `UPDATE autonomous_tasks AS t
     SET lease_owner = NULL, lease_expires_at = NULL, lease_generation = t.lease_generation + 1, next_wakeup_at = NULL,
         worker_pid = CASE WHEN t.worker_host IS DISTINCT FROM $2 THEN NULL ELSE t.worker_pid END,
         worker_pgid = CASE WHEN t.worker_host IS DISTINCT FROM $2 THEN NULL ELSE t.worker_pgid END,
         worker_started_at = CASE WHEN t.worker_host IS DISTINCT FROM $2 THEN NULL ELSE t.worker_started_at END,
         worker_host = CASE WHEN t.worker_host IS DISTINCT FROM $2 THEN NULL ELSE t.worker_host END,
         updated_at = now()
     WHERE t.workspace_id = $1 AND t.lease_owner IS NOT NULL AND ${leaseHost} <> '' AND ${leaseHost} <> $2
       AND NOT EXISTS (SELECT 1 FROM failover_hosts h WHERE h.name = ${leaseHost} AND h.last_seen_at > now() - ($3 * interval '1 millisecond'))
       -- A worker recorded on the gone laptop may still be running there offline; it reconnects and posts.
       AND (t.worker_pgid IS NULL OR t.worker_host IS NOT DISTINCT FROM $2)
     RETURNING t.*`,
    [workspaceId, host, HOST_GONE_MS],
  )
  return rows.map(toTask)
}

/** Pins a reminder's read-only task to the laptop that took it: the person it runs as comes from that laptop's config. */
export async function pinReminderTask(pool: Pool, workspaceId: string, threadRef: string, host: string): Promise<void> {
  await pool.query(
    `UPDATE autonomous_tasks AS t SET pinned_host = $3, updated_at = now()
     FROM sessions s
     WHERE s.id = t.session_id AND s.workspace_id = $1 AND s.thread_ref = $2 AND t.read_only AND t.pinned_host IS NULL`,
    [workspaceId, threadRef, host],
  )
}

/** The agent a mention asked for, recorded by the router outside any lease. */
export async function recordAgentPreference(pool: Pool | PoolClient, taskId: string, agent: string): Promise<void> {
  await pool.query('UPDATE autonomous_tasks SET agent_preference = $2, updated_at = now() WHERE id = $1', [taskId, agent])
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

/**
 * Removes what a turn read, in one statement so a message or note added
 * meanwhile is never lost: the events by id and the first `notesRead` notes.
 * The task runs again at once when anything is left, keeps a wakeup set
 * during the turn (later than `dueAt`, the one that started it, which pg
 * holds to the microsecond and node to the millisecond), and otherwise sleeps.
 */
export async function consumeTurnInput(
  pool: Pool | PoolClient,
  lease: Lease,
  input: { eventIds: readonly string[]; notesRead: number; dueAt: Date | null },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE autonomous_tasks AS task
     SET pending_events = left_over.events,
         pending_notes = left_over.notes,
         next_wakeup_at = CASE
           WHEN jsonb_array_length(left_over.events) > 0 OR jsonb_array_length(left_over.notes) > 0 THEN now()
           WHEN task.next_wakeup_at >= $5::timestamptz + interval '1 millisecond' THEN task.next_wakeup_at
           ELSE NULL END,
         updated_at = now()
     FROM (
       SELECT id,
         COALESCE((SELECT jsonb_agg(event) FROM jsonb_array_elements(pending_events) AS event WHERE NOT (event->>'id' = ANY ($4))), '[]'::jsonb) AS events,
         COALESCE((SELECT jsonb_agg(note ORDER BY position) FROM jsonb_array_elements(pending_notes) WITH ORDINALITY AS t(note, position) WHERE position > $6), '[]'::jsonb) AS notes
       FROM autonomous_tasks WHERE id = $1 FOR UPDATE
     ) AS left_over
     WHERE task.id = left_over.id AND task.id = $1 AND task.lease_owner = $2 AND task.lease_generation = $3`,
    [lease.taskId, lease.owner, lease.generation, [...input.eventIds], input.dueAt ?? new Date(0), input.notesRead],
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

/** The one note a paused task's next turn reads: it resumes the same transcript, which still holds the stopped work. */
export const PAUSED_NOTE = 'The operator stopped your last turn with "stop". Do not continue or redo that work unless a new message asks for it; answer the new messages only.'

export type PauseResult = { kind: 'paused'; task: AutonomousTask } | { kind: 'ended' } | { kind: 'missing' }

/**
 * Stop's final write for a task that stays open (the "relay end" and kill
 * switch path is markTaskStopped). Bumps the lease generation like Stop, so a
 * killed worker's late writes are refused, then clears the stop flag so the
 * next message wakes the task. Messages received up to the "stop" belong to
 * the stopped work and are dropped with their files not yet downloaded;
 * later ones are kept and wake the task. Relay's pending notes are replaced
 * by PAUSED_NOTE. An ended task is never reopened.
 */
export async function markTaskPaused(pool: Pool, taskId: string, stoppedAt: string): Promise<PauseResult> {
  return inTransaction(pool, async (client): Promise<PauseResult> => {
    const { rows } = await client.query<TaskRow>('SELECT * FROM autonomous_tasks WHERE id = $1 FOR UPDATE', [taskId])
    const row = rows[0]
    if (!row) return { kind: 'missing' }
    if (row.phase === 'stopped') return { kind: 'ended' }
    const cutoff = Date.parse(stoppedAt)
    const kept = row.pending_events.filter((event) => Date.parse(event.receivedAt) > cutoff)
    const droppedFileIds = new Set(row.pending_events.filter((event) => !kept.includes(event)).flatMap((event) => event.fileIds))
    const keptFileIds = new Set(kept.flatMap((event) => event.fileIds))
    const files = row.files.filter((file) => !(file.status === 'pending' && droppedFileIds.has(file.slackFileId) && !keptFileIds.has(file.slackFileId)))
    const { rows: updated } = await client.query<TaskRow>(
      `UPDATE autonomous_tasks
       SET lease_owner = NULL, lease_expires_at = NULL, lease_generation = lease_generation + 1,
           cancel_requested_at = NULL, pending_events = $2::jsonb, files = $3::jsonb, pending_notes = $4::jsonb,
           next_wakeup_at = CASE WHEN jsonb_array_length($2::jsonb) > 0 THEN now() ELSE NULL END, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [taskId, JSON.stringify(kept), JSON.stringify(files), JSON.stringify([PAUSED_NOTE])],
    )
    return { kind: 'paused', task: toTask(requireRow(updated[0])) }
  })
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

/** Tasks whose wakeup time has come, not cancelled and not leased; with failover on, only those that may run on this laptop. */
export async function listDueWakeups(pool: Pool, workspaceId: string, place: Placement = LOCAL_PLACEMENT): Promise<AutonomousTask[]> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT * FROM autonomous_tasks AS t
     WHERE t.workspace_id = $1 AND t.next_wakeup_at IS NOT NULL AND t.next_wakeup_at <= now()
       AND t.cancel_requested_at IS NULL AND (t.lease_expires_at IS NULL OR t.lease_expires_at < now())
       AND ${taskRunsHereSql('t', '$2', '$3')}
     ORDER BY t.next_wakeup_at`,
    [workspaceId, place.host, place.isDefault],
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

/**
 * A guest turn's place in its thread (README, "Failover"): the laptop it runs
 * on, the laptop that owns the thread, and whether the owner's own task is
 * mid-turn. Undefined for an ordinary task.
 */
export async function guestPlace(pool: Pool | PoolClient, sessionId: string): Promise<{ guest: string; owner: string; ownerRunning: boolean } | undefined> {
  const { rows } = await pool.query<{ guest: string; owner: string | null; running: boolean }>(
    `SELECT s.guest_host AS guest, th.host AS owner,
            EXISTS (SELECT 1 FROM sessions os JOIN autonomous_tasks ot ON ot.session_id = os.id
                     WHERE os.workspace_id = s.workspace_id AND os.adapter = s.adapter AND os.thread_ref = s.thread_ref
                       AND os.guest_host IS NULL AND os.state = 'active' AND ot.lease_owner IS NOT NULL) AS running
       FROM sessions s
       LEFT JOIN thread_hosts th ON th.workspace_id = s.workspace_id AND th.adapter = s.adapter AND th.thread_ref = s.thread_ref
      WHERE s.id = $1 AND s.guest_host IS NOT NULL`,
    [sessionId],
  )
  const row = rows[0]
  if (!row || row.owner === null) return undefined
  return { guest: row.guest, owner: row.owner, ownerRunning: row.running }
}

/** The line a guest turn's first reply starts with (decision 2). */
export function guestReplyPrefix(place: { guest: string; owner: string; ownerRunning: boolean }): string {
  const where = place.ownerRunning ? `this thread's run is working on \`${place.owner}\`` : `this thread belongs to \`${place.owner}\``
  return `\`${place.guest}\`: ${where}; this answer is from ${place.guest}.`
}

/** What a guest turn's chat is told first: whose thread it is, and that the owner's work is not its to touch. */
export function guestNote(place: { guest: string; owner: string }): string {
  return (
    `You are answering on ${place.guest} as a guest in a Slack thread that belongs to ${place.owner}. ` +
    `Answer what was asked of you here and do the work on this laptop. Do not touch ${place.owner}'s run: not its worktree, its branch, its processes or its files.`
  )
}
