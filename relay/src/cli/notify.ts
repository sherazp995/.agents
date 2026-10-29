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
import { composeThreadRef } from '../chat/slack/adapter.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { claimLiveControl } from '../live/control.js'
import { attachSessionToEngineChat, findOrCreateSession } from '../sessions/store.js'
import { listWorkspacesForPlatform } from '../tenancy/workspaces.js'
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
  /** A mapped Slack user id; defaults to every operator in the workspace. */
  to?: string
  /** Skips the lookup of the one Slack workspace. */
  workspaceId?: string
  /** The Claude Code chat to attach each DM thread to, once it is sent. */
  attach?: { engineSessionId: string; cwd: string; peer?: string }
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
  const recipients = params.to !== undefined ? await mappedUser(pool, workspaceId, params.to) : await operators(pool, workspaceId)
  if (recipients.length === 0) throw new NotifyError('No operator is mapped in this workspace; add one with `relay principals add`.')

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

async function attachThread(pool: Pool, workspaceId: string, userId: string, sent: { channel: string; message: string }, attach: NonNullable<NotifyParams['attach']>): Promise<boolean> {
  const { rows: principals } = await pool.query<{ id: string }>(
    'SELECT id FROM principals WHERE workspace_id = $1 AND platform = $2 AND platform_user_id = $3',
    [workspaceId, PLATFORM, userId],
  )
  const principalId = principals[0]?.id
  if (!principalId) return false
  const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: PLATFORM, threadRef: composeThreadRef(sent.channel, sent.message) })
  await attachSessionToEngineChat(pool, session.id, attach.engineSessionId, attach.cwd)
  if (attach.peer !== undefined) {
    // The exact chat is known, so the thread is claimed for it: replies park
    // and the courier pushes them to that chat without a process scan.
    await pool.query('UPDATE sessions SET courier_target = $2 WHERE id = $1', [session.id, attach.peer])
    await claimLiveControl(pool, workspaceId, session.id)
  }
  return true
}

async function slackWorkspaceId(pool: Pool): Promise<string> {
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

async function operators(pool: Pool, workspaceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ platform_user_id: string }>(
    `SELECT platform_user_id FROM principals WHERE workspace_id = $1 AND platform = $2 AND 'operator' = ANY (roles) ORDER BY platform_user_id`,
    [workspaceId, PLATFORM],
  )
  return rows.map((row) => row.platform_user_id)
}
