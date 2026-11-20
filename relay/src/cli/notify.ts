/**
 * `relay notify`: lets a local agent session message the user in Slack.
 * The CLI never holds the bot token: it queues a post in relay's outbox
 * and the running daemon's drain sends it. A Slack user id as the channel
 * posts to that user's DM with the app.
 *
 * Run from a Claude Code chat, the DM thread is attached to that chat once
 * it is sent, the same binding /sessions makes: a reply goes back to the
 * chat while it is open, and becomes the thread's autonomous task after.
 */

import type { Pool } from 'pg'
import { composeThreadRef } from '../chat/slack/events.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { claimLiveControl } from '../live/control.js'
import { attachSessionToEngineChat, findOrCreateSession } from '../sessions/store.js'
import { listWorkspacesForPlatform } from '../tenancy/workspaces.js'
import { OWNER_ROLE_NAMES } from '../tenancy/roles.js'
import { queueUpload, readUploadFile } from './upload.js'

const PLATFORM = 'slack'
/** Notifications are a sentence or two; anything longer belongs in a thread reply. */
export const NOTIFY_MAX_CHARS = 500
/** How long to wait for the daemon to send the DM before attaching gives up. */
const SEND_WAIT_MS = 30_000
const POLL_MS = 500

export class NotifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotifyError'
  }
}

export type NotifyParams = {
  text: string
  /** A mapped Slack user id; defaults to every owner in the workspace. */
  to?: string
  /** Skips the lookup of the one Slack workspace. */
  workspaceId?: string
  /** The Claude Code chat to attach each DM thread to, once it is sent. */
  attach?: { engineSessionId: string; cwd: string; peer?: string; host?: string }
  /** A file to post in the DM's thread once the DM is sent, such as a plan to review. */
  file?: string
  sendWaitMs?: number
}

export type NotifyResult = { userId: string; attached: boolean; fileQueued: boolean }

/** Queues one DM per recipient; with `attach` or `file`, waits for each to be sent, then attaches its thread and posts the file in it. */
export async function runNotify(pool: Pool, params: NotifyParams): Promise<NotifyResult[]> {
  const text = scrubSecrets(params.text.trim())
  if (text === '') throw new NotifyError('Nothing to send: the message is empty.')
  if (text.length > NOTIFY_MAX_CHARS) throw new NotifyError(`Keep it short: the message is ${text.length} characters, and the limit is ${NOTIFY_MAX_CHARS}.`)

  // Read before anything is queued, so a bad path sends nothing.
  const file = params.file !== undefined ? await readUploadFile(params.file).catch((error: Error) => { throw new NotifyError(error.message) }) : undefined
  const workspaceId = params.workspaceId ?? (await slackWorkspaceId(pool))
  const recipients = params.to !== undefined ? await mappedUser(pool, workspaceId, params.to) : await owners(pool, workspaceId)
  if (recipients.length === 0) throw new NotifyError('No owner is mapped in this workspace; add one with `relay principals add --role owner`.')

  const queued: { userId: string; outboxId: string }[] = []
  for (const userId of recipients) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [workspaceId, PLATFORM, { kind: 'post', ref: { channel: userId }, text, markdown: true }],
    )
    queued.push({ userId, outboxId: rows[0]?.id ?? '' })
  }
  const results: NotifyResult[] = []
  for (const { userId, outboxId } of queued) {
    // Both the attachment and the file need the DM's real channel and ts, which only the send names.
    const sent = params.attach !== undefined || file !== undefined ? await waitForSent(pool, outboxId, params.sendWaitMs ?? SEND_WAIT_MS) : null
    const attached = sent !== null && params.attach !== undefined && (await attachThread(pool, workspaceId, userId, sent, params.attach))
    if (sent !== null && file !== undefined) await queueUpload(pool, workspaceId, { channel: sent.channel, thread: sent.message }, file)
    results.push({ userId, attached, fileQueued: sent !== null && file !== undefined })
  }
  return results
}

export type LinkedThreadParams = {
  workspaceId: string
  /** The laptop owner: the thread's session is theirs, and with no `channel` the post goes to their DM. */
  owner: string
  /** A channel id to post in instead of the owner's DM. */
  channel?: string
  text: string
  /** The Claude Code chat to attach the thread to; without it the thread only gets its session. */
  attach?: NonNullable<NotifyParams['attach']>
  sendWaitMs: number
}

/**
 * Posts one message that opens a thread for a terminal chat (src/cli/launch.ts)
 * and gives the thread its session, attached to the chat when `attach` names
 * one. Null when the daemon did not send it within `sendWaitMs`.
 */
export async function openLinkedThread(pool: Pool, params: LinkedThreadParams): Promise<{ channel: string; thread: string } | null> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, $2, $3, now()) RETURNING id`,
    [params.workspaceId, PLATFORM, { kind: 'post', ref: { channel: params.channel ?? params.owner }, text: scrubSecrets(params.text.trim()), markdown: true }],
  )
  const sent = await waitForSent(pool, rows[0]?.id ?? '', params.sendWaitMs)
  if (sent === null) {
    // Never sent late into a thread no chat is linked to.
    await pool.query(`UPDATE outbox SET status = 'failed', last_error = 'not sent before the launcher gave up' WHERE id = $1 AND status = 'pending'`, [rows[0]?.id ?? ''])
    return null
  }
  const linked = params.attach !== undefined ? await attachThread(pool, params.workspaceId, params.owner, sent, params.attach) : await giveThreadSession(pool, params.workspaceId, params.owner, sent)
  return linked ? { channel: sent.channel, thread: sent.message } : null
}

/**
 * Links a terminal Codex chat to the thread its launcher opened. Done late,
 * once the chat is known: Codex saves a chat only after its first message.
 * Throws TakenOverSessionError when Relay's own loop took the thread over in
 * the meantime, so the thread stays with it.
 */
export async function linkCodexChat(
  pool: Pool,
  params: { workspaceId: string; owner: string; thread: { channel: string; thread: string }; chatId: string; cwd: string; host: string | null },
): Promise<void> {
  const session = await threadSession(pool, params.workspaceId, params.owner, { channel: params.thread.channel, message: params.thread.thread })
  if (session === undefined) throw new NotifyError(`${params.owner} is not a mapped Slack user, so the thread has no session to link.`)
  await attachSessionToEngineChat(pool, session.id, params.chatId, params.cwd, params.host, 'codex')
}

/** Queues a post in a thread; the daemon sends it. */
export async function postInThread(pool: Pool, workspaceId: string, thread: { channel: string; thread: string }, text: string): Promise<void> {
  await pool.query(`INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, $2, $3, now())`, [
    workspaceId,
    PLATFORM,
    { kind: 'post', ref: { channel: thread.channel, thread: thread.thread }, text: scrubSecrets(text.trim()), markdown: true },
  ])
}

/**
 * The laptop owner: `configured` (launcher.dm_to) when it is a mapped user,
 * otherwise the workspace's only owner. Throws when it cannot tell.
 */
export async function laptopOwner(pool: Pool, workspaceId: string, configured: string | undefined): Promise<string> {
  if (configured !== undefined) return (await mappedUser(pool, workspaceId, configured))[0] ?? configured
  const all = await owners(pool, workspaceId)
  if (all.length === 1 && all[0] !== undefined) return all[0]
  throw new NotifyError(
    all.length === 0
      ? 'No owner is mapped in this workspace; add one with `relay principals add --role owner`.'
      : 'This workspace has several owners, so Relay cannot tell whose laptop this is; set launcher.dm_to to your Slack user id in relay.config.yaml.',
  )
}

/** Null when the daemon did not send the DM in time; a reply then starts an autonomous task instead. */
async function waitForSent(pool: Pool, outboxId: string, waitMs: number): Promise<{ channel: string; message: string } | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const { rows } = await pool.query<{ sent_ref: { channel?: string; message?: string } | null }>('SELECT sent_ref FROM outbox WHERE id = $1', [outboxId])
    const sent = rows[0]?.sent_ref
    if (sent?.channel && sent.message) return { channel: sent.channel, message: sent.message }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

async function threadSession(pool: Pool, workspaceId: string, userId: string, sent: { channel: string; message: string }): Promise<{ id: string } | undefined> {
  const { rows: principals } = await pool.query<{ id: string }>(
    'SELECT id FROM principals WHERE workspace_id = $1 AND platform = $2 AND platform_user_id = $3',
    [workspaceId, PLATFORM, userId],
  )
  const principalId = principals[0]?.id
  if (!principalId) return undefined
  return findOrCreateSession(pool, { workspaceId, principalId, adapter: PLATFORM, threadRef: composeThreadRef(sent.channel, sent.message) })
}

/** A thread with a session and no chat: `relay live say` can post in it, and replies go to Relay's own loop. */
async function giveThreadSession(pool: Pool, workspaceId: string, userId: string, sent: { channel: string; message: string }): Promise<boolean> {
  return (await threadSession(pool, workspaceId, userId, sent)) !== undefined
}

async function attachThread(pool: Pool, workspaceId: string, userId: string, sent: { channel: string; message: string }, attach: NonNullable<NotifyParams['attach']>): Promise<boolean> {
  const session = await threadSession(pool, workspaceId, userId, sent)
  if (session === undefined) return false
  await attachSessionToEngineChat(pool, session.id, attach.engineSessionId, attach.cwd, attach.host ?? null)
  if (attach.peer !== undefined) {
    // The exact chat is known, so the thread is claimed for it: replies park
    // and the courier pushes them to that chat without a process scan.
    await pool.query('UPDATE sessions SET courier_target = $2 WHERE id = $1', [session.id, attach.peer])
    await claimLiveControl(pool, workspaceId, session.id)
  }
  return true
}

export async function slackWorkspaceId(pool: Pool): Promise<string> {
  const workspaces = await listWorkspacesForPlatform(pool, PLATFORM)
  const only = workspaces[0]
  if (!only) throw new NotifyError('No Slack workspace yet: start the relay daemon once so it connects.')
  if (workspaces.length > 1) throw new NotifyError('More than one Slack workspace exists; pass --workspace-id.')
  return only.id
}

async function mappedUser(pool: Pool, workspaceId: string, userId: string): Promise<string[]> {
  const { rows } = await pool.query('SELECT 1 FROM principals WHERE workspace_id = $1 AND platform = $2 AND platform_user_id = $3', [workspaceId, PLATFORM, userId])
  if (rows.length === 0) throw new NotifyError(`${userId} is not a mapped principal; relay only messages people it knows.`)
  return [userId]
}

async function owners(pool: Pool, workspaceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ platform_user_id: string }>(
    `SELECT platform_user_id FROM principals WHERE workspace_id = $1 AND platform = $2 AND roles && $3::text[] ORDER BY platform_user_id`,
    [workspaceId, PLATFORM, OWNER_ROLE_NAMES],
  )
  return rows.map((row) => row.platform_user_id)
}
