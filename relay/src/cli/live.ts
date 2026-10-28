/**
 * FR-ATT-40's operator-facing half: the three commands a running Claude Code
 * session uses to take control of a Slack thread, wait for work, and answer.
 *
 * `relay live claim`  marks a thread live-controlled by this session.
 * `relay live wait`   blocks until a message arrives, prints it, exits.
 * `relay live say`    posts an answer back into the thread.
 * `relay live release` hands the thread back to Relay's own loop.
 *
 * `wait` exiting on arrival is the whole design. A blocked command that
 * finishes is an event the surrounding session notices, which is what makes
 * this work without Relay injecting anything into a live process.
 */

import type { Pool } from 'pg'

import type { ChatRef } from '../chat/contract.js'

import {
  buildReplyCommand,
  claimAllWorkspaceMessages,
  claimLiveControl,
  releaseLiveControl,
  waitForMessage,
} from '../live/control.js'
import { findActiveSession } from '../sessions/store.js'
import { composeThreadRef } from '../chat/slack/adapter.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { queueUpload, readUploadFile } from './upload.js'

/** How long `wait` blocks before reporting nothing arrived. Bounded rather than infinite so the caller regains control and can decide whether to wait again. */
export const DEFAULT_WAIT_SECONDS = 1500

export type LiveClaimParams = {
  readonly pool: Pool
  readonly workspaceId: string
  readonly channel: string
  readonly thread: string
}

async function resolveSessionId(params: LiveClaimParams): Promise<string> {
  const threadRef = composeThreadRef(params.channel, params.thread)
  const session = await findActiveSession(params.pool, {
    workspaceId: params.workspaceId,
    adapter: 'slack',
    threadRef,
  })
  if (!session) {
    throw new Error(
      `no active Relay session for thread ${threadRef}. Send one message to the bot in that thread first, ` +
        'so the session exists, then claim it.',
    )
  }
  return session.id
}

export async function runLiveClaim(params: LiveClaimParams): Promise<string> {
  const sessionId = await resolveSessionId(params)
  await claimLiveControl(params.pool, params.workspaceId, sessionId)
  return (
    `claimed ${composeThreadRef(params.channel, params.thread)} for live control (session ${sessionId}).\n` +
    'Relay will park messages from this thread instead of running its own loop.'
  )
}

export async function runLiveRelease(params: LiveClaimParams): Promise<string> {
  const sessionId = await resolveSessionId(params)
  await releaseLiveControl(params.pool, params.workspaceId, sessionId)
  return `released session ${sessionId}. Relay's own loop answers this thread again.`
}

export type LiveWaitParams = LiveClaimParams & { readonly timeoutSeconds?: number }

/**
 * Blocks until a message arrives. Prints the operator's own text, plus the
 * reply ref needed to answer it.
 *
 * The message body is printed to stdout and nowhere else. It is never
 * logged, per FR-SEC-1: this is the one place Relay handles inbound text
 * deliberately, and the whole point is to hand it to one consumer rather
 * than to leave copies behind.
 */
export async function runLiveWait(params: LiveWaitParams): Promise<string> {
  const sessionId = await resolveSessionId(params)
  const timeoutMs = (params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000
  const message = await waitForMessage(params.pool, sessionId, timeoutMs)

  if (!message) {
    return `no message arrived within ${Math.round(timeoutMs / 1000)}s. Nothing was claimed.`
  }

  return [
    '=== SLACK MESSAGE ===',
    message.body,
    '=== END ===',
    `reply with: ${buildReplyCommand({ channel: params.channel, thread: params.thread })}`,
  ].join('\n')
}

/**
 * Takes every message waiting for this workspace and returns immediately.
 *
 * The non-blocking counterpart to `wait`, and the better mechanism of the
 * two. `wait` exists because nothing can push into a running Claude Code
 * session, so it converts an arrival into a background command completing.
 * That works, but it costs a whole Node process per session, measured at
 * 102 MB, and it has to be re-armed after every message.
 *
 * A Stop hook has neither problem: it already runs at the end of every turn
 * and its output is already injected into the session. So a hook calling
 * this needs no resident process and no re-arming, and a message that
 * arrives while the session is mid-turn is delivered the moment that turn
 * ends rather than waiting for someone to re-arm a waiter.
 *
 * Returns empty output when nothing is waiting, so a hook can call it every
 * turn and stay silent, which is what makes it cheap enough to always run.
 */
/**
 * Which workspace a drain should take messages from.
 *
 * THE OUTAGE THIS EXISTS FOR, because the previous rule was defensible and
 * still broke live control completely and silently for over a day.
 *
 * The rule was: count the workspaces; if there is more than one, refuse
 * rather than guess. The reasoning was sound, and is kept below: draining
 * the wrong workspace hands one operator's messages to another operator's
 * session, which is worse than not draining.
 *
 * What it did not anticipate is that a workspace row can exist which could
 * never hold a live-control message at all. `relay smoke` provisions its
 * own workspace under a deliberately non-chat platform, precisely so it can
 * "never collide with, or be mistaken for, a real one" (src/cli/smoke.ts).
 * It succeeded at not colliding, and still broke everything: it made the
 * COUNT two, so every drain refused, and the operator's Stop hook ended in
 * `|| true`, so the refusal went to stderr and vanished. Messages were
 * parked, the thread said "queued for the attached session", and the
 * session never received one. Nothing reported it.
 *
 * So ambiguity is now judged by what is actually WAITING rather than by how
 * many workspaces happen to exist. A workspace with no parked message for a
 * live-controlled session cannot be the one this drain wants, whatever its
 * platform is, so it cannot make the answer ambiguous. Two real chat
 * workspaces that both have messages waiting still refuse, which is the
 * case the original rule was written for.
 */
export type DrainWorkspaceResolution =
  | { readonly outcome: 'resolved'; readonly workspaceId: string }
  /** Nothing is parked anywhere. The overwhelmingly common case, and it must stay silent: this runs at the end of every turn. */
  | { readonly outcome: 'nothing_waiting' }
  | { readonly outcome: 'ambiguous'; readonly candidates: readonly string[]; readonly reason: string }

export async function resolveDrainWorkspace(
  pool: Pool,
  explicitWorkspaceId?: string,
): Promise<DrainWorkspaceResolution> {
  if (explicitWorkspaceId !== undefined) return { outcome: 'resolved', workspaceId: explicitWorkspaceId }

  // The same predicate claimAllWorkspaceMessages uses to decide what it
  // would actually claim, so this can never resolve to a workspace that
  // then turns out to have nothing for us.
  const { rows } = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT lcm.workspace_id
       FROM live_control_messages lcm
       JOIN sessions s ON s.id = lcm.session_id
      WHERE lcm.claimed_at IS NULL
        AND s.state = 'active'
        AND (s.live_control_claimed_at IS NOT NULL OR s.engine_cwd IS NOT NULL)`,
  )

  if (rows.length === 0) return { outcome: 'nothing_waiting' }
  const only = rows[0]
  if (rows.length === 1 && only !== undefined) return { outcome: 'resolved', workspaceId: only.workspace_id }

  const candidates = rows.map((row) => row.workspace_id)
  return {
    outcome: 'ambiguous',
    candidates,
    reason:
      `${candidates.length} workspaces have messages waiting for an attached session, so which one this session ` +
      'should take is ambiguous. Draining the wrong one would hand another operator\'s messages to this session. ' +
      `Pass --workspace-id to name it: ${candidates.join(', ')}`,
  }
}

export async function runLiveDrain(pool: Pool, workspaceId: string): Promise<string> {
  const messages = await claimAllWorkspaceMessages(pool, workspaceId)
  if (messages.length === 0) return ''

  const blocks = messages.map((message) => {
    // Guarded, because by the time this runs the row is already claimed and
    // its body erased. An unguarded parse that throws here would destroy the
    // operator's message permanently: it is gone from the database and has
    // not reached anyone. A ref we cannot read costs the reply instructions,
    // which is recoverable, so the text is printed either way.
    let ref: { channel?: string; thread?: string } = {}
    try {
      const parsed: unknown = JSON.parse(message.replyRef)
      if (typeof parsed === 'object' && parsed !== null) ref = parsed as typeof ref
    } catch {
      // Deliberately swallowed: see above. The message itself still gets out.
    }
    return [
      '=== SLACK MESSAGE ===',
      message.body,
      '=== END ===',
      `reply with: ${buildReplyCommand(ref)}`,
    ].join('\n')
  })

  return blocks.join('\n\n')
}

export type LiveSayParams = LiveClaimParams & { readonly text: string; readonly file?: string }

/**
 * Posts an answer back into the thread, and attaches a file when one is
 * given, through relay's outbox: the running daemon sends it within
 * seconds. The CLI never reads the bot token, so a reply raises no Keychain
 * prompt.
 */
export async function runLiveSay(params: LiveSayParams): Promise<string> {
  await resolveSessionId(params)
  const text = scrubSecrets(params.text.trim())
  if (text === '' && params.file === undefined) throw new Error('nothing to post: give --text, --file, or both')
  // Read before anything is queued, so a bad path posts nothing.
  const file = params.file !== undefined ? await readUploadFile(params.file) : undefined
  const ref = { channel: params.channel, thread: params.thread }
  if (text !== '') {
    await params.pool.query(`INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'slack', $2, now())`, [params.workspaceId, { kind: 'post', ref, text }])
  }
  if (file) await queueUpload(params.pool, params.workspaceId, ref, file)
  return `queued for ${composeThreadRef(params.channel, params.thread)}; the relay daemon posts it.`
}
