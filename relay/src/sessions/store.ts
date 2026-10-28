/**
 * Sessions bind a chat thread to a durable conversation, per FR-SES-1 and
 * FR-SL-3: the reply thread IS the session. This is the boundary Task 3's
 * "is this thread a known session" question, and the whole rest of P0.3,
 * hang off. Backed by the `sessions` table (0004_sessions.sql).
 */

import type { Pool, PoolClient } from 'pg'
import { SESSION_MODES, type SessionMode } from '../live/session-mode.js'

export type SessionState = 'active' | 'archived'

/**
 * `threadRef` is the design decision this task made deliberately: an
 * opaque string the adapter composes, not a structured (channel, thread)
 * pair split across two columns. See 0004_sessions.sql's header comment
 * for the full rationale; in short, a single comparable value is what a
 * single unique index and a single equality lookup need, and the platform
 * specific composition (Slack's channel and thread ts, joined) belongs at
 * the adapter boundary that already knows the platform's own id shapes,
 * not repeated at every call site that needs to compare two refs.
 */
export type Session = {
  id: string
  workspaceId: string
  principalId: string
  adapter: string
  threadRef: string
  state: SessionState
  createdAt: string
  lastActiveAt: string
  /**
   * The engine's own session id from the most recent run this Relay
   * session recorded one for, per FR-SES-1 and 0011_session_engine_session_id.sql.
   * Null for a session that has never completed a run whose engine call
   * returned one, which is the honest starting state, not a placeholder.
   * src/agent/loop.ts's runAgentLoop reads this back as `resumeSessionId`
   * to give the engine `--resume`, so the model sees the thread's prior
   * conversation instead of starting cold on every message.
   */
  engineSessionId: string | null
  /**
   * The folder this session's engine chat belongs to, per
   * 0015_session_engine_cwd.sql. With `threadRef` and `engineSessionId` it
   * completes the mapping a Slack thread needs: which chat to resume, and
   * where to resume it. The working directory is what gives a resumed
   * session that project's own skills, agents, and settings, including
   * gitignored ones, so resuming the right chat in the wrong directory
   * yields a session that looks correct and behaves differently.
   *
   * Null for a session that runs in Relay's own working directory, which is
   * every session predating attachment. That is the honest state rather
   * than a backfilled guess.
   */
  engineCwd: string | null
  /**
   * Whether this thread is DIRECT (a plain Claude Code session Relay carries
   * messages to) or GOVERNED (Relay's own loop, under policy). Decided once,
   * when the thread is created, and never re-derived per message: a
   * conversation whose execution model can change halfway through is the one
   * thing a conversation must not be. See 0020_session_mode.sql and
   * 0021_autonomous_tasks.sql.
   */
  mode: SessionMode
  /** The exact chat (ListAgents "name [ref]") the courier pushes this thread's messages to; null means match by engineCwd. */
  courierTarget: string | null
}

export type FindOrCreateSessionParams = {
  workspaceId: string
  principalId: string
  adapter: string
  threadRef: string
}

export type SessionRow = {
  id: string
  workspace_id: string
  principal_id: string
  adapter: string
  thread_ref: string
  state: SessionState
  created_at: Date
  last_active_at: Date
  engine_session_id: string | null
  engine_cwd: string | null
  mode: string
  courier_target?: string | null
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    adapter: row.adapter,
    threadRef: row.thread_ref,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    lastActiveAt: row.last_active_at.toISOString(),
    engineSessionId: row.engine_session_id,
    engineCwd: row.engine_cwd,
    mode: toSessionMode(row.mode),
    courierTarget: row.courier_target ?? null,
  }
}

/** Exact, never a fallback: reading an unknown mode as governed would silently change how a thread runs. */
function toSessionMode(mode: string): SessionMode {
  const known = SESSION_MODES.find((candidate) => candidate === mode)
  if (known === undefined) throw new Error(`sessions.mode holds an unknown value "${mode}"`)
  return known
}

/**
 * The INSERT half of findOrCreateSession, on any query client, so a caller
 * inside its own transaction (src/autonomous/store.ts's intakeMention) can
 * create the session with a given mode atomically with its other writes.
 * Returns undefined when an active session for the thread already exists.
 */
export async function insertActiveSession(
  client: Pool | PoolClient,
  params: FindOrCreateSessionParams,
  mode: SessionMode,
): Promise<Session | undefined> {
  const { rows } = await client.query<SessionRow>(
    `INSERT INTO sessions (workspace_id, principal_id, adapter, thread_ref, mode)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, adapter, thread_ref) WHERE state = 'active' DO NOTHING
     RETURNING *`,
    [params.workspaceId, params.principalId, params.adapter, params.threadRef, mode],
  )
  const row = rows[0]
  return row ? toSession(row) : undefined
}

/**
 * Bounds how many times findOrCreateSession retries its insert-then-lookup
 * cycle before giving up. See the function's doc comment for what a retry
 * means and why three is enough in practice: each retry only happens after
 * a real, observed archiveSession has already committed, and archiving is
 * one-directional, so the interleaving that forces a retry cannot repeat
 * indefinitely against the same caller without an adversarial amount of
 * concurrent archiving.
 */
const FIND_OR_CREATE_MAX_ATTEMPTS = 3

/**
 * Finds the active session for `(workspaceId, adapter, threadRef)`,
 * creating one if none exists yet. Idempotent under concurrency: two
 * genuinely concurrent calls for the same thread must yield exactly one
 * session row, not two.
 *
 * This is the same trap Task 1 hit, and the fix starts the same shape.
 * `INSERT ... ON CONFLICT (workspace_id, adapter, thread_ref) WHERE state
 * = 'active' DO NOTHING RETURNING *` is what Postgres actually serializes
 * the race against, backed by `sessions_workspace_adapter_thread_active_key`
 * from 0004_sessions.sql; application logic alone cannot make two
 * concurrent check then insert calls agree on one row. The partial unique
 * index, scoped to `state = 'active'`, is why the arbiter clause repeats
 * that same predicate: Postgres only accepts an `ON CONFLICT` target that
 * matches an index's columns and predicate exactly.
 *
 * `DO NOTHING` returns no row for whichever caller loses the race, so this
 * falls back to a lookup, same as `resolveWorkspaceId`
 * (src/tenancy/workspaces.ts). Unlike that lookup, this one is a plain
 * `UPDATE ... RETURNING *` rather than a `SELECT`, so the loser's call
 * still bumps `last_active_at` to the moment it observed the thread, not
 * only the moment the session was first created.
 *
 * Unlike `resolveWorkspaceId`, which resolves a lookup miss against a
 * table nothing else ever mutates mid-flight, a lookup miss here is a real,
 * reachable outcome, not a bug: `archiveSession` mutates the exact row this
 * function just lost its INSERT to, and the reviewer who caught the first
 * version of this comment reproduced it directly, twenty five iterations
 * of one archiveSession call racing two concurrent findOrCreateSession
 * calls on the same thread produced three to five rejections per run.
 * The failure mode was the INSERT losing its conflict against an
 * already-active row, and then, before the fallback UPDATE ran, a
 * concurrent archiveSession call flipping that same row to archived, so
 * the UPDATE's `state = 'active'` filter matched nothing.
 *
 * That interleaving is handled by retrying the whole insert-then-lookup
 * cycle rather than throwing: the row this call lost the conflict against
 * has, by the time the UPDATE misses, already been archived by someone
 * else, so a fresh INSERT for the same key no longer conflicts with
 * anything, because the partial unique index only covers `state =
 * 'active'` rows. That retry is exactly the mechanism that makes a fresh
 * session after archiving safe generally, described below and in
 * archiveSession's own doc comment; this loop only exists to reach it
 * reliably instead of surfacing the intermediate miss as a caller-visible
 * error. Bounded at FIND_OR_CREATE_MAX_ATTEMPTS: only a genuinely
 * adversarial amount of concurrent archiving could keep forcing a retry
 * that many times in a row, and at that point throwing a truthful error is
 * correct, not a claim that the situation is impossible.
 */
export async function findOrCreateSession(
  pool: Pool,
  params: FindOrCreateSessionParams,
): Promise<Session> {
  const { workspaceId, adapter, threadRef } = params

  for (let attempt = 1; attempt <= FIND_OR_CREATE_MAX_ATTEMPTS; attempt++) {
    const inserted = await insertActiveSession(pool, params, 'governed')
    if (inserted) return inserted

    const { rows } = await pool.query<SessionRow>(
      `UPDATE sessions
       SET last_active_at = now()
       WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3 AND state = 'active'
       RETURNING *`,
      [workspaceId, adapter, threadRef],
    )
    const existingRow = rows[0]
    if (existingRow) return toSession(existingRow)

    // Neither statement found a row: the INSERT lost its conflict against
    // an active row that a concurrent archiveSession call then archived
    // before the UPDATE ran. That row no longer occupies the partial
    // unique index, so the next loop iteration's INSERT should succeed
    // outright. Falls through to retry rather than returning or throwing.
  }

  throw new Error(
    `findOrCreateSession: could not find or create an active session for workspace ` +
      `"${workspaceId}", adapter "${adapter}", thread_ref "${threadRef}" after ` +
      `${FIND_OR_CREATE_MAX_ATTEMPTS} attempts. Each attempt lost its INSERT to a concurrent ` +
      'writer and then found no active row to update, meaning a concurrent archiveSession call ' +
      'kept winning the race on every attempt. This is real contention, not an impossible state; ' +
      'retrying again is likely to succeed once the concurrent archiving settles.',
  )
}

export type FindActiveSessionParams = {
  workspaceId: string
  adapter: string
  threadRef: string
}

/**
 * A pure lookup, never a creating act, unlike findOrCreateSession: used by
 * the Stop path (src/orchestrator.ts, gate fix Blocker 1), which must never
 * conjure a session into existence just because a Stop instruction landed
 * in a thread that never had one. Returns null when no active session
 * matches, backed by the same `sessions_workspace_adapter_thread_active_key`
 * index findOrCreateSession and isKnownSessionQuery already use.
 */
export async function findActiveSession(
  pool: Pool,
  params: FindActiveSessionParams,
): Promise<Session | null> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT * FROM sessions WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3 AND state = 'active' LIMIT 1`,
    [params.workspaceId, params.adapter, params.threadRef],
  )
  const row = rows[0]
  return row ? toSession(row) : null
}

/**
 * Marks a session archived. Unconditional on the session's current state,
 * so archiving an already archived session is a harmless no-op rather
 * than an error; only a session id that does not exist at all is a bug
 * worth throwing for.
 *
 * Archiving does not delete the row: `findOrCreateSession` never
 * resurrects it silently, because the partial unique index that backs its
 * `ON CONFLICT` target only covers `state = 'active'` rows. A later call
 * for the same thread finds no active row to conflict with and inserts a
 * fresh session instead, with a new id and its own `createdAt`. That is a
 * deliberate choice over refusing: a chat thread is not intrinsically dead
 * once archived, Slack threads get replied to again days later, and there
 * is no unarchive operation in this milestone, so refusing would make an
 * archived thread permanently unusable rather than merely closed.
 */
export async function archiveSession(pool: Pool, sessionId: string): Promise<void> {
  const { rowCount } = await pool.query(`UPDATE sessions SET state = 'archived' WHERE id = $1`, [
    sessionId,
  ])
  if (rowCount === 0) {
    throw new Error(`archiveSession: no session found with id "${sessionId}"`)
  }
}

/**
 * Persists the engine's own session id against `sessionId`, per FR-SES-1
 * and 0011_session_engine_session_id.sql: the mechanism DEC-1 named and
 * Task 6 left unused. Called once per run, after runAgentLoop returns,
 * with whatever engine session id that run last observed, so the NEXT run
 * in this same thread can resume it and see the prior conversation.
 *
 * Unconditional overwrite, never a merge or an append: only one engine
 * session id is ever tracked per Relay session, the freshest one, matching
 * how a resumed engine conversation itself works, continuing from its own
 * latest state rather than replaying every prior one.
 */
export async function setSessionEngineSessionId(
  pool: Pool,
  sessionId: string,
  engineSessionId: string,
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE sessions SET engine_session_id = $2 WHERE id = $1`,
    [sessionId, engineSessionId],
  )
  if (rowCount === 0) {
    throw new Error(`setSessionEngineSessionId: no session found with id "${sessionId}"`)
  }
}

/**
 * Binds a Slack thread to an existing Claude Code chat and the folder it
 * belongs to, per 0015_session_engine_cwd.sql. This is what makes an
 * attachment durable: after this call the thread knows which chat to resume
 * and where, so every later message in it routes to the same place without
 * the operator restating it.
 *
 * Both values are written together, in one statement, because a chat id
 * without its working directory is not a usable attachment. Resuming the
 * right chat in the wrong directory loses that project's own skills,
 * agents, and settings, producing a session that looks correct and behaves
 * differently. Writing them separately would make that half-bound state
 * reachable, so the API does not offer it.
 */
export async function attachSessionToEngineChat(
  pool: Pool,
  sessionId: string,
  engineSessionId: string,
  engineCwd: string,
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE sessions SET engine_session_id = $2, engine_cwd = $3 WHERE id = $1`,
    [sessionId, engineSessionId, engineCwd],
  )
  if (rowCount === 0) {
    throw new Error(`attachSessionToEngineChat: no session found with id "${sessionId}"`)
  }
}

/**
 * The active session already bound to `engineCwd` in this workspace, if
 * there is one. Backs the operator's routing rule: work for a folder that
 * already has a live chat goes to that chat, and only otherwise starts a
 * new one.
 *
 * Scoped by workspace_id per AP-8, and restricted to active sessions
 * because an archived one is not a candidate to route new work into.
 * Returns the most recently active when several qualify, since that is the
 * one the operator was last working in.
 */
export async function findSessionByEngineCwd(
  pool: Pool,
  workspaceId: string,
  engineCwd: string,
): Promise<Session | null> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT * FROM sessions
       WHERE workspace_id = $1 AND engine_cwd = $2 AND state = 'active'
       ORDER BY last_active_at DESC
       LIMIT 1`,
    [workspaceId, engineCwd],
  )
  const row = rows[0]
  return row === undefined ? null : toSession(row)
}

/**
 * Marks a thread as direct, recording the session and directory in one
 * statement.
 *
 * All three together because a direct thread is only usable with all three:
 * a mode with no session id has nothing to resume, and a session id with no
 * directory cannot be resumed at all, since a Claude Code session id is only
 * meaningful alongside the working directory whose transcript holds it.
 */
export async function markSessionDirect(
  pool: Pool,
  sessionId: string,
  engineSessionId: string,
  engineCwd: string,
): Promise<void> {
  await pool.query(
    "UPDATE sessions SET mode = 'direct', engine_session_id = $2, engine_cwd = $3, last_active_at = NOW() WHERE id = $1",
    [sessionId, engineSessionId, engineCwd],
  )
}
