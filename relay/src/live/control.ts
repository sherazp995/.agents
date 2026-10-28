/**
 * FR-ATT-40: live control of an already-running Claude Code session.
 *
 * The operator wants to type in Slack and have it reach the session they are
 * already sitting in. Section 24 answers that with a tmux and pty proxy
 * Relay interposes in front of the session, so remote injection and local
 * typing serialise through one writer. That is phase 2 and a large
 * mechanism, and it inherits a turn-taking race section 24 itself concedes.
 *
 * This module is the small mechanism that works today, and it inverts the
 * design: **the session pulls, Relay does not push.** A running Claude Code
 * session can consume work by running a command that blocks until something
 * arrives. So a thread is marked live-controlled, Relay parks the message
 * rather than running its own loop, and the waiting session picks it up,
 * does the work with all of its own context, and posts the answer back.
 *
 * Nothing ever resumes or writes to a live transcript, so the silent-fork
 * failure that governs the resume path (see section 24's own correction)
 * cannot occur here at all. There is no second writer.
 *
 * Delivery is LISTEN/NOTIFY, so a waiting consumer wakes on the insert
 * rather than on a timer.
 */

import type { Pool, PoolClient } from 'pg'

import { defaultExecFile, hasLiveClaudeProcess } from '../sessions/liveness.js'
import type { ExecFileFn } from '../sessions/liveness.js'

/**
 * Thrown when a session already has a waiter. Distinct from "no message
 * arrived", because the operator's response to each differs: one means wait
 * longer, the other means arming again is pointless.
 */
export class WaiterAlreadyRunningError extends Error {
  readonly sessionId: string
  constructor(sessionId: string) {
    super(`a waiter is already running for session ${sessionId}`)
    this.name = 'WaiterAlreadyRunningError'
    this.sessionId = sessionId
  }
}

/**
 * The command a session runs to answer a message, built in ONE place.
 *
 * Two callers need this string: `relay live drain`, which prints it after a
 * parked message, and the courier, which embeds it in a pushed one. They
 * had drifted immediately: drain substituted "?" for a missing field while
 * the courier substituted an empty string, which produces
 * `--thread  --text ...` and is not a runnable command at all. A session
 * handed that would run it, watch it fail, and the operator would get
 * silence, which is the one outcome this whole subsystem exists to prevent.
 *
 * A missing field is rendered as "?" rather than omitted, so the command
 * visibly cannot be run as-is instead of quietly posting somewhere else.
 */
export function buildReplyCommand(ref: { channel?: string; thread?: string; message?: string }): string {
  const channel = ref.channel ?? '?'
  const thread = ref.thread ?? ref.message ?? '?'
  return `relay live say --channel ${channel} --thread ${thread} --text "<your answer>"`
}

/** The Postgres channel a waiting consumer listens on. One per session, so a consumer is never woken by another thread's traffic. */
export function liveControlChannel(sessionId: string): string {
  // A channel name is an identifier, so a uuid's hyphens are replaced rather
  // than quoted: this string is interpolated into LISTEN, which cannot take
  // a bind parameter.
  return `relay_live_${sessionId.replace(/-/g, '_')}`
}

export type LiveControlMessage = {
  readonly id: string
  readonly sessionId: string
  readonly principalId: string
  readonly body: string
  readonly replyRef: string
  readonly createdAt: Date
}

type MessageRow = {
  id: string
  session_id: string
  principal_id: string
  body: string
  reply_ref: string
  created_at: Date
}

function toMessage(row: MessageRow): LiveControlMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    principalId: row.principal_id,
    body: row.body,
    replyRef: row.reply_ref,
    createdAt: row.created_at,
  }
}

/** Marks a session live-controlled, so `handleChatEvent` parks its messages rather than running a loop. Idempotent. */
export async function claimLiveControl(pool: Pool, workspaceId: string, sessionId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE sessions SET live_control_claimed_at = now() WHERE id = $1 AND workspace_id = $2`,
    [sessionId, workspaceId],
  )
  if (rowCount === 0) throw new Error(`claimLiveControl: no session ${sessionId} in workspace ${workspaceId}`)
}

/** Releases a session back to Relay's own loop. Idempotent, and safe to call on a session that was never claimed. */
export async function releaseLiveControl(pool: Pool, workspaceId: string, sessionId: string): Promise<void> {
  await pool.query(`UPDATE sessions SET live_control_claimed_at = NULL WHERE id = $1 AND workspace_id = $2`, [
    sessionId,
    workspaceId,
  ])
}

/**
 * Whether this session's messages should be parked for a running Claude Code
 * session rather than answered by Relay's own loop.
 *
 * **Attaching a thread is what decides this. There is no separate claim.**
 * An earlier version required the operator to claim a thread explicitly, on
 * top of attaching it, and that was a mistake: it made the operator maintain
 * a distinction Relay invented, and it broke constantly because Slack opens a
 * new thread for every top-level message, so ordinary use produced unclaimed
 * threads faster than anyone could claim them. Each one silently fell through
 * to a cold session that answered without the context the operator had just
 * asked for.
 *
 * So the rule is the operator's own, stated in their words: a chat that is
 * already open and currently running gets the work. A thread attached to a
 * session whose folder has a live Claude process parks. Everything else runs
 * Relay's own loop.
 *
 * `live_control_claimed_at` stays as an explicit override for handing one
 * thread to a consumer that is not otherwise detectable, but nothing the
 * operator does day to day touches it.
 */
export async function isLiveControlled(
  pool: Pool,
  sessionId: string,
  workspaceId?: string,
  // Injected so a test can decide what is running rather than depending on
  // whatever happens to be alive on the machine, which would make this
  // module's central rule pass or fail for reasons unrelated to the rule.
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<boolean> {
  const { rows } = await pool.query<{
    claimed: boolean
    engine_cwd: string | null
    engine_session_id: string | null
  }>(
    `SELECT live_control_claimed_at IS NOT NULL AS claimed, engine_cwd, engine_session_id FROM sessions
       WHERE id = $1 AND ($2::uuid IS NULL OR workspace_id = $2)`,
    [sessionId, workspaceId ?? null],
  )
  const row = rows[0]
  if (row === undefined) return false
  if (row.claimed) return true
  if (row.engine_cwd === null) return false

  // Attached, so the question becomes the operator's own: is that chat
  // actually running right now? If it is, it is the thing they want the work
  // to reach. If it is not, Relay resuming it itself is correct and is what
  // the attachment is for.
  return hasLiveClaudeProcess(execFileFn, row.engine_cwd, row.engine_session_id ?? '')
}

/**
 * Waits until `messageId` is claimed by a consumer, or the grace period
 * expires. Returns true if it was collected.
 *
 * This exists because a live process in a folder proves a session is OPEN,
 * not that anything is blocked on this queue, and those diverge in ordinary
 * use: a session between turns, or one whose waiter died with its process,
 * is live but collecting nothing. Without this the operator gets silence and
 * cannot tell "being worked on" from "swallowed".
 *
 * Polled rather than LISTEN/NOTIFY, deliberately. The claim is an UPDATE by
 * another connection with no notification of its own, and adding one would
 * put a trigger in the path of every claim to serve a case that resolves in
 * a second or two. A short poll is the cheaper and more obvious mechanism.
 */
export async function waitForClaim(pool: Pool, messageId: string, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs
  const intervalMs = 250
  for (;;) {
    try {
      const { rows } = await pool.query<{ claimed: boolean }>(
        `SELECT claimed_at IS NOT NULL AS claimed FROM live_control_messages WHERE id = $1`,
        [messageId],
      )
      if (rows[0]?.claimed === true) return true
    } catch {
      // A transient query failure must not reject the caller. This runs
      // inside the inbound event handler, so throwing would give the
      // operator neither the parked answer nor the fallback: exactly the
      // silence this whole mechanism exists to prevent. Treat it as "not
      // claimed yet" and let the deadline decide.
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Takes every unclaimed message in the workspace, across all its threads,
 * and returns immediately.
 *
 * Workspace-wide rather than per session because the caller is a Stop hook
 * that does not know which threads exist: the operator can start a new Slack
 * thread at any moment, and a per-session drain would silently miss it. That
 * exact gap is what made per-thread waiting unusable.
 *
 * Same erase-on-claim as the single-message form, so text handed over is not
 * also left in the database.
 */
export async function claimAllWorkspaceMessages(
  queryable: Pool | PoolClient,
  workspaceId: string,
): Promise<readonly LiveControlMessage[]> {
  // Joined to sessions and restricted to those still live-controlled. A row
  // parked before the operator released a thread must not be drained into a
  // session that no longer owns it: Relay's own loop is responsible for that
  // thread again, and delivering it here would take work from the party that
  // should now be doing it. The per-session path is implicitly scoped this
  // way already; the workspace-wide one has to say so.
  const { rows } = await queryable.query<MessageRow>(
    `UPDATE live_control_messages AS m
        SET claimed_at = now(), body = ''
       FROM (
         SELECT lcm.id, lcm.body FROM live_control_messages lcm
           JOIN sessions s ON s.id = lcm.session_id
           WHERE lcm.workspace_id = $1
             AND lcm.claimed_at IS NULL
             AND s.state = 'active'
             -- Attached OR explicitly claimed, matching what parked the
             -- message in the first place. Deliberately NOT re-checking
             -- that a process is live: liveness is a per-row probe of the
             -- process table, which cannot be expressed here, and a session
             -- that was live when the message was parked and has since
             -- exited would otherwise leave its message stranded forever.
             --
             -- The caller is itself a running session's hook, so something
             -- IS alive to receive whatever this returns. That is what
             -- makes the looser predicate safe: the drain is workspace
             -- wide by design, and a message reaching a sibling session is
             -- the intended behaviour rather than a leak.
             AND (s.live_control_claimed_at IS NOT NULL OR s.engine_cwd IS NOT NULL)
           ORDER BY lcm.created_at
           FOR UPDATE OF lcm SKIP LOCKED
       ) AS old
      WHERE m.id = old.id
     RETURNING m.id, m.session_id, m.principal_id, old.body AS body, m.reply_ref, m.created_at`,
    [workspaceId],
  )
  return rows.map(toMessage)
}

/**
 * Claims a parked message on Relay's own behalf, so its own loop can answer
 * it. Returns false if a live session got there first.
 *
 * This is what makes the fallback safe. Leaving the row unclaimed and simply
 * answering it would let a waiter arm later, claim the same message, and
 * answer it a second time in the same thread, which reads to the operator as
 * Relay talking to itself. The claim and the check are one statement, so a
 * waiter and this cannot both win.
 */
export async function takeBackMessage(pool: Pool, messageId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE live_control_messages SET claimed_at = now(), body = '' WHERE id = $1 AND claimed_at IS NULL`,
    [messageId],
  )
  return rowCount === 1
}

/**
 * Parks an inbound message for a waiting consumer and wakes it. The NOTIFY
 * rides the same transaction as the INSERT, so a consumer can never be woken
 * for a row it cannot yet see.
 */
export async function enqueueLiveControlMessage(
  pool: Pool,
  params: {
    workspaceId: string
    sessionId: string
    principalId: string
    body: string
    replyRef: string
  },
): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO live_control_messages (workspace_id, session_id, principal_id, body, reply_ref)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [params.workspaceId, params.sessionId, params.principalId, params.body, params.replyRef],
    )
    // pg_notify rather than a literal NOTIFY, because the channel name is a
    // value here and pg_notify takes it as a bind parameter.
    await client.query('SELECT pg_notify($1, $2)', [liveControlChannel(params.sessionId), rows[0]?.id ?? ''])
    await client.query('COMMIT')
    const id = rows[0]?.id
    if (!id) throw new Error('enqueueLiveControlMessage: insert returned no id')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * Takes the oldest unclaimed message for `sessionId`, or null if there is
 * none. A single UPDATE ... RETURNING with SKIP LOCKED, so two consumers
 * racing for one message is resolved by Postgres rather than by discipline:
 * exactly one of them gets it and the other sees nothing.
 */
export async function claimNextMessage(
  queryable: Pool | PoolClient,
  sessionId: string,
  workspaceId?: string,
): Promise<LiveControlMessage | null> {
  // FR-SEC-1: the body is returned and then ERASED in the same statement,
  // not merely marked claimed. This is the one place Relay stores inbound
  // message text, and it stores it only to hand it to exactly one consumer.
  // Once handed over there is no further use for it, and a chat message
  // sitting in a database indefinitely is a store of whatever the operator
  // happened to paste. The row survives with an empty body so the audit
  // trail still records that a message arrived, was claimed, and when.
  // `UPDATE ... RETURNING` yields the NEW row, so erasing and returning the
  // body in one statement needs the old value captured first. Two
  // data-modifying CTEs cannot do it: sub-statements in a WITH share one
  // snapshot, so a second UPDATE cannot see rows the first one touched, and
  // the erase silently does nothing (observed, not assumed: the test that
  // asserts the stored body is empty caught exactly that).
  //
  // The FROM subquery is evaluated before the update applies, so `old.body`
  // is the pre-update text. The caller receives it exactly once and the
  // database keeps none of it.
  const { rows } = await queryable.query<MessageRow>(
    `UPDATE live_control_messages AS m
        SET claimed_at = now(), body = ''
       FROM (
         SELECT id, body FROM live_control_messages
           WHERE session_id = $1
             AND claimed_at IS NULL
             AND ($2::uuid IS NULL OR workspace_id = $2)
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
       ) AS old
      WHERE m.id = old.id
     RETURNING m.id, m.session_id, m.principal_id, old.body AS body, m.reply_ref, m.created_at`,
    [sessionId, workspaceId ?? null],
  )
  const row = rows[0]
  if (row === undefined) return null
  return toMessage(row)
}

/**
 * Blocks until a message arrives for `sessionId`, or until `timeoutMs`
 * elapses. Returns the message, or null on timeout.
 *
 * LISTEN is established BEFORE the first drain, deliberately: doing it the
 * other way round leaves a window where a message inserted between the drain
 * and the LISTEN is never noticed, and the consumer sleeps through work that
 * is already waiting. Establishing the listener first means the worst case
 * is a redundant wake-up, which costs one query.
 */
export async function waitForMessage(
  pool: Pool,
  sessionId: string,
  timeoutMs: number,
): Promise<LiveControlMessage | null> {
  const client = await pool.connect()
  let timer: NodeJS.Timeout | undefined
  let holdsLock = false
  try {
    // Exactly one waiter per session, enforced by Postgres rather than by
    // remembering to kill the old one. Each waiter is a whole Node process,
    // measured at 102 MB RSS, almost all of it the runtime's own baseline
    // rather than the waiting, which is a single idle connection. Four of
    // them accumulated during development for one session that could only
    // ever consume one message, since claiming is exclusive. A second waiter
    // is not merely wasteful, it is a process that can never do anything.
    //
    // A session-scoped advisory lock is the right tool: it is held by the
    // connection, so it is released when this process exits for any reason,
    // including a kill, with no cleanup path to forget.
    const { rows } = await client.query<{ acquired: boolean }>(
      // Two keys rather than one hashtext: pg_advisory_lock's single-key
      // form is 64-bit but hashtext is only 32, so one hash alone leaves a
      // birthday collision between unrelated session ids, and a collision
      // would silently refuse a legitimate waiter. Hashing two different
      // strings into the two-key form makes that vanishingly unlikely, and
      // the refusal is reported distinctly below so even then it does not
      // masquerade as an ordinary timeout.
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired',
      [`relay_live_wait_${sessionId}`, `relay_live_wait_salt_${sessionId}`],
    )
    if (rows[0]?.acquired !== true) {
      // Reported distinctly rather than as a plain null. A null means "no
      // message arrived", and a caller that cannot tell that apart from
      // "another waiter already holds this session" will report the wrong
      // thing to the operator and, worse, will not know that arming again
      // is pointless.
      throw new WaiterAlreadyRunningError(sessionId)
    }
    holdsLock = true

    const woken = new Promise<void>((resolve) => {
      client.on('notification', () => resolve())
      timer = setTimeout(resolve, timeoutMs)
      // A background timer must not hold the process open on its own: this
      // command is meant to exit as soon as it has an answer.
      timer.unref?.()
    })

    await client.query(`LISTEN ${liveControlChannel(sessionId)}`)

    // Drain first, in case something arrived before this consumer existed.
    const existing = await claimNextMessage(client, sessionId)
    if (existing) return existing

    await woken
    return await claimNextMessage(client, sessionId)
  } finally {
    if (timer) clearTimeout(timer)
    // UNLISTEN before release, so a pooled connection handed to the next
    // caller does not still carry this session's subscription.
    await client.query('UNLISTEN *').catch(() => {})
    // Released explicitly as well as by disconnection, so a pooled
    // connection returning to service does not carry the lock with it and
    // lock out the next waiter.
    if (holdsLock) {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [
          `relay_live_wait_${sessionId}`,
          `relay_live_wait_salt_${sessionId}`,
        ])
        .catch(() => {})
    }
    client.removeAllListeners('notification')
    client.release()
  }
}
