/**
 * The platform neutral chat contract. Every chat platform (Slack now,
 * Telegram or Discord later) implements this one shape, so an adapter is an
 * implementation detail rather than a special case anywhere else in Relay.
 * Types only, no behaviour, per FR-CA-1 and FR-CA-2.
 */

import type { Untrusted } from '../agent/untrusted.js'
import { unwrapForAudit } from '../agent/untrusted.js'

/** The shapes of inbound activity a platform can produce. */
export type ChatEventKind =
  | 'message'
  | 'command'
  | 'interaction'
  | 'reaction'
  | 'file_share'
  | 'thread_reply'

/**
 * Identifies a location in a platform neutral way: a channel, optionally a
 * thread within it, optionally a specific message. `thread` and `message`
 * are omitted rather than set to undefined when absent, which is what
 * exactOptionalPropertyTypes enforces for this project.
 */
export type ChatRef = {
  channel: string
  thread?: string
  message?: string
}

/** A file attached to an inbound event or an outbound upload result. */
export type ChatFile = {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  urlPrivate: string
}

/**
 * One inbound activity, normalised out of whatever shape the platform sent.
 *
 * `workspaceId` is the Relay tenancy uuid, matching `workspaces.id` from
 * `src/db/migrations/0001_init.sql`: it is what a caller passes into
 * `resolvePrincipal` or `Outbox.enqueue`. It is never the platform's own
 * tenant identifier (Slack's `team_id`, for instance): a raw platform id
 * has no reason to look like a uuid and does not match any `workspaces` row,
 * which is exactly PRE-3's original defect (docs/decisions/open-questions.md).
 * An adapter resolves this uuid at construction, via
 * `src/tenancy/workspaces.ts`'s `resolveWorkspaceId`, before it can emit any
 * event at all.
 *
 * `platformTeamId` is the platform's own raw tenant identifier, kept
 * alongside `workspaceId` rather than folded into it, so mapping to a Relay
 * uuid never loses the value a caller needs to talk back to the platform's
 * own APIs about which team an event came from.
 *
 * `principalId` is `string | null`. Null means the platform user in this
 * event is not mapped to a Relay principal. Per FR-CA-4 that must fail
 * closed: an unmapped user cannot start work, so callers must treat null as
 * "ignore, do not act" rather than throwing and rather than auto-creating a
 * principal on the fly.
 *
 * `raw` and `text` both carry outside content, per AP-2: content Relay did
 * not author, which must reach a model only as data, never as instruction,
 * and never by direct string concatenation into a prompt. Both are typed
 * `Untrusted<T>` (src/agent/untrusted.ts), not a bare `unknown` or `string`,
 * so a comment saying "do not feed this to a model" is backed by a real
 * boundary rather than being the only thing stopping misuse: a wrapped
 * value cannot be interpolated, JSON.stringified, or handed to an
 * `unknown`-typed parameter and still expose its payload by accident. The
 * one way to reach a prompt with either field is
 * `renderForModel(event.text)` / `renderForModel(event.raw)`; the one way
 * to read either for audit or logging is `unwrapForAudit`.
 *
 * `raw` is the untouched platform payload, retained only for audit.
 *
 * `text` is the human-readable message body a real person typed, which is
 * exactly the field the agent loop reaches for as "what the user said" and
 * so exactly the field a prompt-injection attempt travels in. Wrapping
 * `raw` alone and leaving `text` a bare `string` would close the narrow
 * hole an audit-only field represents while leaving the wide one, the field
 * actually destined for a prompt, wide open; see src/agent/untrusted.ts's
 * module doc comment for the fuller reasoning.
 */
export type ChatEvent = {
  kind: ChatEventKind
  adapter: string
  workspaceId: string
  platformTeamId: string
  principalId: string | null
  ref: ChatRef
  text: Untrusted<string>
  files: ChatFile[]
  raw: Untrusted<unknown>
  receivedAt: string
  /** True when the text carries the bot's own mention token, whichever envelope delivered it, so the arrival order of one mention's paired envelopes cannot change it. */
  mentionsBot: boolean
  /** `<channel>:<ts>`: the same key the adapter dedupes on, so the paired envelopes of one mention share it. */
  platformEventId: string
}

/**
 * The ref a reply to this event should be posted or edited against, per
 * FR-SL-3: the reply thread IS the session. A fresh message has no thread of
 * its own yet, so the reply starts one on the message itself; a thread reply
 * continues the thread it already arrived in. Either way the result carries
 * `thread`, never the bare channel, because a caller that threads off this
 * ref must always land in a thread, not the channel root.
 *
 * Throws rather than falling back to an unthreaded ref when `event.ref`
 * carries neither `thread` nor `message`. A platform adapter that builds a
 * ChatEvent without `message` set has already broken the contract this
 * helper exists to serve, and silently returning `{ channel }` here is
 * exactly the failure mode this fix is closing: a caller would thread off
 * that ref, find nothing to thread against, and post to the channel root
 * without ever finding out why. Throwing turns that into a loud, immediate
 * failure at the one place that would otherwise swallow it.
 */
export function sessionRefFor(event: ChatEvent): ChatRef {
  const thread = event.ref.thread ?? event.ref.message
  if (thread === undefined) {
    throw new Error(
      'sessionRefFor: event.ref carries neither thread nor message, so there is nothing to thread a reply against',
    )
  }
  return { channel: event.ref.channel, thread }
}

/**
 * Gate fix, Blocker 1: how a Stop instruction is expressed on the inbound
 * side. GT-14 requires a Stop to reach a running run and cancel it within
 * five seconds; nothing in the spec mandates a specific spelling, so this
 * is a deliberate, stated choice, not a discovered requirement: an inbound
 * event whose text, trimmed and case folded, is exactly "stop" is a Stop
 * instruction. Simple on purpose. A slash-command or a button is the
 * natural longer-term shape (FR-CA-2's own buttons capability exists for
 * exactly this kind of control action), but this milestone ships neither,
 * and a plain word a person can type in any thread, DM or channel, needs no
 * platform-specific wiring to reach every adapter this contract already
 * covers.
 *
 * Read via `unwrapForAudit`, the same sanctioned "read this for a control
 * decision, not to build a prompt with it" use already established by
 * src/orchestrator.ts's extractPlatformUserId: matching against a fixed
 * literal never lets the compared text influence anything Relay says or
 * does beyond the yes/no branch this function returns, so it never crosses
 * AP-2's boundary the way handing the text to a model would.
 */
export const STOP_INSTRUCTION_TEXT = 'stop'

export function isStopInstruction(text: Untrusted<string>): boolean {
  return unwrapForAudit(text).trim().toLowerCase() === STOP_INSTRUCTION_TEXT
}

/** Outbound activity a caller wants an adapter to perform. */
export type ChatAction =
  /** `markdown`: the text is standard Markdown an agent wrote; Slack renders it as a markdown block, with `text` as the fallback. */
  | { kind: 'post'; ref: ChatRef; text: string; markdown?: true }
  | {
      kind: 'edit'
      ref: Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef
      text: string
    }
  | { kind: 'upload'; ref: ChatRef; filename: string; bytes: Uint8Array; comment?: string }
  | { kind: 'setStatus'; ref: ChatRef; status: string }
  /** A post carrying Block Kit `blocks` (an approval card), with `text` as the plain fallback. Delivered like `post`. */
  | { kind: 'post_approval_card'; ref: ChatRef; text: string; blocks: Record<string, unknown>[] }
  /** Adds the named emoji reaction (no colons, for example `eyes`) to the message `ref.message` names. */
  | { kind: 'react'; ref: Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef; name: string }

/** What performing a ChatAction produced. A `post` result feeds the `ref` a later `edit` needs. */
export type ChatActionResult = { ref: ChatRef }

/**
 * What an adapter can and cannot do, per FR-CA-2. The reporter degrades
 * gracefully when a capability is absent, for example emitting numbered
 * text prompts instead of buttons when `buttons` is false.
 */
export type AdapterCapabilities = {
  buttons: boolean
  editMessage: boolean
  fileUpload: boolean
  modals: boolean
  threads: boolean
  maxMessageBytes: number
}

/** The seam every chat platform implements. */

/**
 * Thrown by a handler when it could not durably take in an event after its
 * own retries (src/autonomous/router.ts). The adapter alone treats it
 * specially: it releases the event's dedupe key, so a later delivery of the
 * same message is processed, and tells the thread directly. Any other
 * handler error is logged and dropped.
 */
export class IntakeFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'IntakeFailedError'
  }
}

export interface ChatAdapter {
  readonly name: string
  readonly capabilities: AdapterCapabilities
  start(handler: (event: ChatEvent) => Promise<void>): Promise<void>
  stop(): Promise<void>
  perform(action: ChatAction): Promise<ChatActionResult>
}

/**
 * Renders a stable, human readable summary of a capability set, so the
 * reporter can state a degradation (for example "no buttons") instead of
 * silently changing behaviour. Field order matches AdapterCapabilities so
 * the output is deterministic across calls.
 */
export function describeCapabilities(caps: AdapterCapabilities): string {
  return [
    `buttons: ${caps.buttons ? 'yes' : 'no'}`,
    `editMessage: ${caps.editMessage ? 'yes' : 'no'}`,
    `fileUpload: ${caps.fileUpload ? 'yes' : 'no'}`,
    `modals: ${caps.modals ? 'yes' : 'no'}`,
    `threads: ${caps.threads ? 'yes' : 'no'}`,
    `maxMessageBytes: ${caps.maxMessageBytes}`,
  ].join(', ')
}
