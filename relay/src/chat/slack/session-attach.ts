/**
 * The Slack surface for FR-ATT-5/§24: listing recent Claude Code sessions
 * and attaching the current thread to one. Mirrors src/approvals/blockkit.ts's
 * own split: pure Block Kit rendering plus a couple of real, exported
 * wiring functions here; the listener registration and injected-dependency
 * plumbing live in adapter.ts.
 *
 * FR-SEC-1, AND THE OPERATOR'S OWN STANDING INSTRUCTION, VERBATIM: "Just
 * the response into a message to the user. Nothing else. No other data
 * leaking to any other source." src/sessions/discovery.ts's own doc
 * comment explains why it returns only a session id, a working directory,
 * and a timestamp, never transcript content: a transcript is the most
 * secret-dense artifact on the machine, and the scrubber in
 * src/secrets/scrubber.ts cannot redact a credential Relay never issued.
 * This file is the one place that result reaches a human, so it renders
 * exactly those two safe facts (folder, recency) and adds nothing derived
 * from content. Do not add a label, a preview, or a summary here: doing so
 * would defeat discovery.ts's whole design at its only consumer.
 *
 * FR-ATT-30's unmediated label. §24's own correction states plainly that an
 * attached session executes outside Relay's policy engine, approval gates,
 * budget metering, and worktree isolation, holding the operator's own
 * permissions in their own directory. renderAttachConfirmation states this
 * every time an attachment actually takes effect, not as a one-time notice
 * buried in documentation: a governed thread and an attached one must not
 * look identical in Slack.
 */

import type { SlackBlock } from '../../approvals/blockkit.js'
import type { EngineSession } from '../../sessions/discovery.js'
import { listEngineSessions } from '../../sessions/discovery.js'
import { attachSessionToEngineChat, findOrCreateSession } from '../../sessions/store.js'
import type { Pool } from 'pg'

export const SESSION_ATTACH_ACTION_ID = 'session_attach_pick'

/** How many recent sessions the picker shows. Fixed and small deliberately: FR-ATT-5's own framing is a phone-legible pick, not a full inventory, and discovery.ts's own test found 60 sessions across 20 directories on a real machine, far more than anyone can usefully scan on a phone screen. */
export const MAX_LISTED_SESSIONS = 10

/**
 * What travels in a picker option's `value`: the session id, and nothing
 * else.
 *
 * It used to carry the directory, the channel and the thread as well. All
 * three are now deliberately absent:
 *
 *   - `channel` and `thread` were already ignored by the handler on purpose
 *     (AP-2: taking them from a click payload would let a crafted one bind
 *     ANY thread to a session), so they were dead weight that only made the
 *     payload longer.
 *   - `engineCwd` is looked up from the id at click time instead. That is
 *     both shorter and stricter: a forged payload can now only name a
 *     session that genuinely exists on this machine, where before it could
 *     name a session id paired with any path it liked.
 */
export type SessionAttachValue = {
  readonly engineSessionId: string
}

/**
 * Slack's own hard limit on an interactive element's `value`.
 *
 * Measured against the real API, not read from a doc: posting a
 * `static_select` whose option value was 178 characters came back
 * `invalid_blocks: must be less than 151 characters`. A BUTTON's limit is
 * far higher, which is why the previous renderer got away with encoding the
 * whole payload and the dropdown did not.
 */
export const MAX_SLACK_ACTION_VALUE = 150

/**
 * Only the session id travels in the value.
 *
 * It used to carry the working directory, the channel and the thread too,
 * which was both too long for a dropdown and more trust than the click
 * needed. The handler already ignores the channel and thread from the value
 * on purpose (AP-2: taking them from a click payload would let a crafted one
 * bind ANY thread to a session), so they were dead weight. The directory is
 * now looked up from the id at click time, which means a forged payload can
 * only ever name a session that genuinely exists on this machine, instead of
 * naming a session id and an arbitrary path to attach it to.
 */
export function encodeSessionAttachValue(value: SessionAttachValue): string {
  return JSON.stringify({ engineSessionId: value.engineSessionId })
}

/** `undefined` for anything that does not parse: a click carrying a payload this function did not itself encode (a stale message from a redeployed version, a forged payload) must never be trusted implicitly, so the caller treats a decode failure as "ignore this click" rather than proceeding with partial data. */
export function decodeSessionAttachValue(raw: string): SessionAttachValue | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { engineSessionId } = parsed as Record<string, unknown>
  if (typeof engineSessionId !== 'string' || engineSessionId === '') return undefined
  // Extra fields are ignored rather than rejected, so a message rendered by
  // the previous version and still sitting in a channel keeps working after
  // a redeploy. Only the id is read from it either way.
  return { engineSessionId }
}

/**
 * A short "how recently" label computed only from a timestamp, never from
 * transcript content, per this file's own header comment. `now` is
 * injected so a test never depends on the real clock.
 */
/**
 * A transcript's size, which is a useful proxy for how substantial a
 * conversation is when several sessions share one folder and one timestamp.
 * A 9 MB session and a 50 KB one are obviously different things to the
 * operator, and size is a property of the file rather than of its contents,
 * so showing it reveals nothing about what was said.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatRecency(lastModifiedAt: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - lastModifiedAt.getTime())
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export type RenderedSlackMessage = { text: string; blocks: SlackBlock[] }

/**
 * The picker. `sessions` is expected to already be capped and ordered
 * (src/sessions/discovery.ts's listEngineSessions returns most-recent
 * first); this function slices to MAX_LISTED_SESSIONS again defensively,
 * so a caller that forgets to pass a limit still gets a phone-sized list
 * rather than one row per session on the machine.
 *
 * A brief governance reminder appears in the header too, not only on the
 * confirmation: FR-ATT-30 requires the label to be visible "at the moment
 * of attachment," and an operator should not have to tap a button before
 * learning what they are about to opt into.
 */
export function renderSessionList(
  sessions: readonly EngineSession[],
  // Kept in the signature because every caller passes them and a click's
  // channel and thread still matter, but read from the CLICK ENVELOPE rather
  // than from the payload (AP-2). They are deliberately not encoded into the
  // option value: doing so would let a crafted payload bind any thread.
  _channel: string,
  _thread: string,
  now: Date = new Date(),
): RenderedSlackMessage {
  const shown = sessions.slice(0, MAX_LISTED_SESSIONS)
  if (shown.length === 0) {
    const text = 'No Claude Code sessions found on this machine.'
    return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }
  }

  // ONE DROPDOWN, not one section per session.
  //
  // The first version rendered a section and a button per row, which on a
  // phone is a screen and a half of near-identical blocks before the
  // operator reaches the one they want. A picker is the shape this actually
  // is: a single choice from a short list. It also collapses to one line
  // once chosen, so the thread does not keep a wall of options in its
  // history.
  const options = shown.map((session) => ({
    text: { type: 'plain_text' as const, text: truncateForOption(optionLabel(session, now)) },
    // The session id, which is what `claude --resume` takes, so an operator
    // who already knows a session by id can match it here. Safe to show,
    // unlike anything drawn from the transcript: a uuid naming a local file
    // carries none of what was said.
    // Size rides along with the id because two sessions in one folder at one
    // timestamp are otherwise indistinguishable, which is exactly the case
    // an operator with several chats in a project hits.
    description: {
      type: 'plain_text' as const,
      text: truncateForOption(`${session.sessionId} \u00b7 ${formatSize(session.sizeBytes)}`),
    },
    value: encodeSessionAttachValue({ engineSessionId: session.sessionId }),
  }))

  return {
    text: 'Pick a session to attach this thread to.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*Pick a session to attach this thread to.*\n' +
            ':warning: Attaching runs outside Relay\u2019s governance: your own permissions, no policy checks, no budget metering.',
        },
      },
      {
        type: 'actions',
        block_id: 'session_attach_picker',
        elements: [
          {
            type: 'static_select',
            action_id: SESSION_ATTACH_ACTION_ID,
            placeholder: { type: 'plain_text', text: `Choose one of ${shown.length}` },
            options,
          },
        ],
      },
    ],
  }
}

/** Slack rejects an option whose text exceeds 75 characters, so a long path is trimmed from the LEFT: the end of a path identifies it, the start repeats. */
export function truncateForOption(value: string): string {
  const limit = 75
  if (value.length <= limit) return value
  return `\u2026${value.slice(-(limit - 1))}`
}

/** Folder, then recency. The folder is what an operator recognises; the id is the detail, and lives in the description. */
export function optionLabel(session: EngineSession, now: Date): string {
  return `${session.cwd} \u00b7 ${formatRecency(session.lastModifiedAt, now)}`
}

/**
 * FR-ATT-30's unmediated label, posted the moment an attachment actually
 * takes effect. Deliberately verbose and impossible to miss: a short
 * checkmark would satisfy "state it once" but not "must not look
 * identical" to a governed thread's own confirmations, which this
 * milestone's other Slack surfaces (approval cards, run summaries) render
 * with none of this warning language.
 */
export function renderAttachConfirmation(engineCwd: string): RenderedSlackMessage {
  const text = `Attached: this thread now drives the Claude Code session in ${engineCwd}. Unmediated, not policy-checked.`
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Attached.* This thread now drives the Claude Code session in \`${engineCwd}\`.` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ':warning: *Unmediated session.* This is not a governed run. Work here executes with *your own permissions*, ' +
            'in that folder, outside Relay’s policy engine, approval gates, budget metering, and worktree isolation. ' +
            'Nothing here is policy-checked, budget-metered, or reviewed unless it happens inside the session itself.',
        },
      },
    ],
  }
}

export function renderAttachFailure(reason: string): RenderedSlackMessage {
  const text = `Could not attach this thread: ${reason}`
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }
}

// ---------------------------------------------------------------------------
// Real wiring. Exported so whichever task wires this into production
// (constructing the real SlackAdapter, currently orchestrator.ts, which
// this task does not touch) has a ready-made, already-tested function to
// pass, rather than re-deriving the same two-step database call. Mirrors
// how src/approvals/blockkit.ts stays pure while adapter.ts's own
// production callers bind resolveApprovalInteraction to a real resolver;
// here, both the pure rendering above and this real binding live in the
// same file, since this file is small enough that the split adapter.ts
// keeps for approvals is not worth a second file.
// ---------------------------------------------------------------------------

export type AttachThreadToSessionParams = {
  readonly threadRef: string
  readonly principalId: string | null
  readonly engineSessionId: string
  readonly engineCwd: string
}
export type AttachThreadToSessionResult = { readonly relaySessionId: string }

/**
 * Real implementation for SlackAdapterOptions.attachThreadToSession, bound
 * to a pool and the adapter's own workspace. Fails closed on an unmapped
 * Slack user (`principalId === null`): findOrCreateSession requires a real
 * principal id, and attaching a session under a guessed or default
 * identity would misattribute FR-ATT-33's audit trail to whichever
 * principal happened to be first. Returning `undefined` here is the same
 * "not available" signal adapter.ts's own resolveApprovalInteraction
 * default uses, so the Slack-side failure path is exactly the same
 * whether the cause is "not wired" or "refused."
 */
export function createRealAttachThreadToSession(
  pool: Pool,
  workspaceId: string,
): (params: AttachThreadToSessionParams) => Promise<AttachThreadToSessionResult | undefined> {
  return async ({ threadRef, principalId, engineSessionId, engineCwd }) => {
    if (principalId === null) return undefined
    const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })
    await attachSessionToEngineChat(pool, session.id, engineSessionId, engineCwd)
    return { relaySessionId: session.id }
  }
}

/** Real implementation for SlackAdapterOptions.listRecentSessions: the operator's own terminal chats only (no `claude -p` runs, no subagents), machine-wide (no workspace scoping, since it reads the operator's own filesystem directly, not a Postgres table AP-8 governs). */
export function listRecentEngineSessions(limit: number): Promise<readonly EngineSession[]> {
  return listEngineSessions({ limit, interactiveOnly: true })
}
