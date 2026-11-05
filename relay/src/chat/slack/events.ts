/**
 * Inbound Slack event helpers for SlackAdapter: which message subtypes are
 * never a user addressing Relay, the dedupe window, the threadRef identity
 * and the file list a ChatEvent carries.
 */
import type { ChatFile } from '../contract.js'

/**
 * Message subtypes that are not a user saying something to Relay, and so
 * must never become a ChatEvent.
 *
 * `message_changed` and `message_deleted` matter most, because Relay causes
 * them itself: ProgressReporter edits one message repeatedly (FR-SL-4), and
 * every edit makes Slack fire a `message` event with subtype
 * `message_changed`. On that shape the author lives in the nested
 * `event.message`, so there is no top level `user` or `bot_id` for
 * #shouldIgnore to match on, and the envelope would otherwise dispatch as a
 * ChatEvent with empty text: the exact self-loop the self-message filter
 * exists to prevent, but triggered by Relay's own output rather than its own
 * posts. The join/leave/topic subtypes are channel housekeeping with the
 * same "not a message to us" character, listed here so one rule covers them
 * all instead of each one surfacing as an empty prompt later.
 *
 * Deliberately absent: `thread_broadcast` and `file_share`. Both are a real
 * person genuinely addressing Relay (a thread reply also sent to channel, and
 * a message with an attachment), carrying a normal top level `user` and
 * `text`, so both must keep flowing through.
 */
export const IGNORED_MESSAGE_SUBTYPES = new Set([
  'message_changed',
  'message_deleted',
  'message_replied',
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
])

/**
 * A small bounded FIFO membership set: the dedupe window that stops the
 * same underlying Slack message being delivered twice. Slack fires both
 * `app_mention` and the matching `message.channels`/`message.groups` event
 * for one mention in a channel, so both are subscribed (justifying the
 * app_mentions:read scope this app requests) and this is what collapses
 * them back into a single ChatEvent. Bounded rather than growing forever,
 * because a long lived process must not leak memory over a long run; 500
 * recent (channel, ts) pairs is comfortably more than any burst of traffic
 * the throttled progress reporter and outbox could produce between drains.
 */
export class RecentEventWindow {
  readonly #max: number
  readonly #seen = new Set<string>()
  readonly #order: string[] = []

  constructor(max: number) {
    this.#max = max
  }

  has(key: string): boolean {
    return this.#seen.has(key)
  }

  delete(key: string): void {
    if (!this.#seen.delete(key)) return
    const index = this.#order.indexOf(key)
    if (index !== -1) this.#order.splice(index, 1)
  }

  add(key: string): void {
    if (this.#seen.has(key)) return
    this.#seen.add(key)
    this.#order.push(key)
    if (this.#order.length > this.#max) {
      const oldest = this.#order.shift()
      if (oldest !== undefined) this.#seen.delete(oldest)
    }
  }
}

/**
 * Composes the opaque `threadRef` string Task 2's session store keys on,
 * from a channel id and the ts that names a thread: `event.thread_ts` for a
 * reply, or the root message's own `ts` for the message that starts a
 * thread. The two must produce the same string for the same Slack thread,
 * because Slack sets a reply's `thread_ts` to exactly the root message's own
 * `ts`, so composing from either side of that identity with this one
 * function is what makes a reply's threadRef match the threadRef a session
 * created off that thread's root message would have used. See the "composes
 * the same threadRef for a thread reply as for that thread's root message"
 * round trip test in adapter.test.ts, which pins this identity directly
 * rather than assuming it.
 *
 * Exported so a caller wiring a real isKnownSession (Task 8) can compose the
 * same threadRef this adapter will look up, and so findOrCreateSession is
 * called with a value this function actually produced.
 */
export function composeThreadRef(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`
}

export function buildChatFiles(rawFiles: unknown): ChatFile[] {
  if (!Array.isArray(rawFiles)) return []
  const files: ChatFile[] = []
  for (const entry of rawFiles) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : undefined
    const urlPrivate = typeof raw.url_private === 'string' ? raw.url_private : undefined
    if (!id || !urlPrivate) continue
    const name = typeof raw.name === 'string' ? raw.name : typeof raw.title === 'string' ? raw.title : 'file'
    const mimeType = typeof raw.mimetype === 'string' ? raw.mimetype : 'application/octet-stream'
    const sizeBytes = typeof raw.size === 'number' ? raw.size : 0
    files.push({ id, name, mimeType, sizeBytes, urlPrivate })
  }
  return files
}
