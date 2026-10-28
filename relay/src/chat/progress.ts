/**
 * Owns exactly one outbound chat message for the life of a run and edits it
 * as work proceeds, per FR-SL-4: a thirty step run must read as one message
 * on a phone, not thirty. The first call to `update` or `finish` posts; every
 * call after that edits the same message.
 *
 * Throttling is leading edge plus trailing edge. The first `update` after a
 * quiet period sends immediately. Calls that arrive inside the cooldown
 * window are coalesced into at most one pending edit, carrying whatever text
 * was most recent when the cooldown ends, rather than firing once per call.
 * `finish` always preempts the cooldown: it cancels any pending edit and
 * sends its own text right away, because a dropped final state would be a
 * lie about how the run actually ended.
 *
 * Usage contract: one `ProgressReporter` belongs to one run, and its caller
 * awaits each `update`/`finish` call before starting the next, the way a
 * step of work naturally reports its own progress one step at a time. It is
 * not safe to fire multiple `update` calls concurrently without awaiting
 * them: two unawaited calls can both read the elapsed cooldown before
 * either has sent anything and both decide to send immediately, bypassing
 * the throttle this class exists to provide. This is deliberately a
 * documented contract rather than a mutex: a caller that needs genuinely
 * concurrent progress reporting from multiple steps at once
 * should own that fan-in itself (for example, serializing through its own
 * queue before calling `update`) rather than this class silently
 * absorbing a usage pattern it was not designed for.
 *
 * Durability (FR-CA-3, PRE-1): this class only ever calls `adapter.perform`;
 * it never talks to a chat platform directly, and never constructs an
 * `Outbox` itself. Whether a post or edit survives a crash between deciding
 * to send it and actually sending it depends entirely on what `adapter` the
 * caller passes in. A production caller must pass a
 * `src/dispatch/outbound.ts` `OutboundDispatcher`, not a raw `ChatAdapter`:
 * `OutboundDispatcher` implements `ChatAdapter` itself, so it is a drop-in
 * substitute here, and this class needed no further changes to route
 * through it. Passing a raw adapter (as every test in this file still does)
 * skips the outbox entirely and is only appropriate for a test.
 */

import type { Logger } from '../obs/logger.js'
import type { ChatAdapter, ChatRef } from './contract.js'

export type ProgressReporterOptions = {
  minIntervalMs?: number
  log?: Logger
  /**
   * Called when a trailing (throttle coalesced) edit rejects. A trailing
   * send fires off a setTimeout callback, not a caller's own await, so
   * there is nobody left holding that promise to report the failure to;
   * without this, the only options are silently swallowing the rejection or
   * letting it go unhandled and risk taking down the process. This is the
   * explicit channel a caller observes it through instead. Also logged via
   * `log`, when provided, so the failure shows up even if no caller wired
   * this in.
   */
  onTrailingSendError?: (error: unknown) => void
}

/** Default cooldown between real edits. Generous enough that a busy run's updates coalesce into a handful of edits rather than a flood. */
const DEFAULT_MIN_INTERVAL_MS = 3000

/** The ref shape once a message has actually been posted: channel and message are both known to be real, and thread is carried through only when present. */
type PostedRef = ChatRef & { message: string }

/**
 * Renders `text` for an adapter whose `maxMessageBytes` it might exceed. Per
 * FR-RPT-10, oversize text is never silently cut off mid sentence: it is
 * replaced with a short, honest summary and a placeholder for the full
 * content, sized in bytes (not characters) so multi byte text cannot sneak
 * back over the limit after truncation.
 */
export function summarizeForLimit(text: string, maxMessageBytes: number): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxMessageBytes) return text

  const summary =
    `[output truncated: ${bytes} bytes exceeds this chat's ${maxMessageBytes} byte limit] ` +
    'Full output: <link placeholder, artifact upload lands in a later milestone>'
  if (Buffer.byteLength(summary, 'utf8') <= maxMessageBytes) return summary

  // The limit is too small even for the summary line itself. Fall back to a
  // minimal, still honest marker rather than pretending nothing was cut.
  return truncateToBytes(`[output omitted: ${bytes} bytes]`, maxMessageBytes)
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes without producing a string
 * that re-encodes larger than the cut point. A naive
 * `buffer.subarray(0, n).toString('utf8')` can do exactly that: cutting mid
 * codepoint makes Node's decoder emit a three byte U+FFFD replacement
 * character, which can outweigh the bytes it replaced. This shrinks the cut
 * point until the re-encoded result actually fits.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text

  for (let n = maxBytes; n > 0; n -= 1) {
    const decoded = buf.subarray(0, n).toString('utf8')
    if (Buffer.byteLength(decoded, 'utf8') <= maxBytes) return decoded
  }
  return ''
}

export class ProgressReporter {
  readonly #adapter: ChatAdapter
  readonly #ref: ChatRef
  readonly #minIntervalMs: number
  readonly #log: Logger | undefined
  readonly #onTrailingSendError: ((error: unknown) => void) | undefined

  #postedRef: PostedRef | undefined
  #lastSentAt = -Infinity
  #pendingText: string | undefined
  #pendingTimer: ReturnType<typeof setTimeout> | undefined
  #sendQueue: Promise<void> = Promise.resolve()
  #finished = false

  constructor(adapter: ChatAdapter, ref: ChatRef, options: ProgressReporterOptions = {}) {
    this.#adapter = adapter
    this.#ref = ref
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.#log = options.log
    this.#onTrailingSendError = options.onTrailingSendError
  }

  /**
   * Reports progress. The first call in a fresh cooldown window sends right
   * away; a call inside the window is coalesced into the one pending edit
   * that fires when the window ends, carrying whichever text was most
   * recent by then. Calling after `finish` is a no-op: the message is
   * already in its terminal state.
   */
  async update(text: string): Promise<void> {
    if (this.#finished) return
    this.#pendingText = text

    // A trailing send is already scheduled; it will pick up this text when
    // it fires, so there is nothing further to do here.
    if (this.#pendingTimer) return

    const elapsed = Date.now() - this.#lastSentAt
    if (elapsed >= this.#minIntervalMs) {
      await this.#dispatch(text)
      return
    }

    this.#scheduleTrailingSend()
  }

  /**
   * Reports the run's final state. Always lands immediately, even inside a
   * throttle window: cancels any pending edit so it can never overwrite
   * this one afterward, then sends this text right away.
   */
  async finish(text: string): Promise<void> {
    this.#finished = true
    this.#cancelPendingTimer()
    this.#pendingText = text
    await this.#dispatch(text)
  }

  #scheduleTrailingSend(): void {
    if (this.#pendingTimer) return
    const wait = Math.max(0, this.#minIntervalMs - (Date.now() - this.#lastSentAt))
    this.#pendingTimer = setTimeout(() => {
      this.#pendingTimer = undefined
      const text = this.#pendingText
      if (text === undefined || this.#finished) return
      // No caller is awaiting this send: it was scheduled by a timer, not a
      // call to update()/finish(). A rejection here must still be caught
      // and reported, not discarded with `void`, which would surface as an
      // unhandled promise rejection able to crash the process outright.
      this.#dispatch(text).catch((error: unknown) => {
        this.#log?.error({ err: error }, 'ProgressReporter: trailing edit failed')
        this.#onTrailingSendError?.(error)
      })
    }, wait)
  }

  #cancelPendingTimer(): void {
    if (this.#pendingTimer) {
      clearTimeout(this.#pendingTimer)
      this.#pendingTimer = undefined
    }
  }

  /**
   * Queues a real send behind whatever is already in flight, so a trailing
   * timer's send and a `finish` call can never race each other out of
   * order. Each call's own await still surfaces its send's failure to its
   * caller; the shared chain absorbs the rejection afterward so one failed
   * send cannot poison every send queued after it.
   */
  async #dispatch(text: string): Promise<void> {
    const send = this.#sendQueue.then(() => this.#send(text))
    this.#sendQueue = send.catch(() => {})
    await send
  }

  /**
   * FR-CA-2: an adapter that honestly declares `editMessage: false` must be
   * degraded gracefully, not simply fail the moment a second send is due.
   * The documented, bounded fallback here is to post a fresh message into
   * the same ref every time instead of ever attempting an edit; "bounded"
   * because it is still governed by the same throttle window as the edit
   * path, so a busy run still produces a handful of messages, never one per
   * update() call. The result is a thread that reads as several short
   * updates instead of one message rewritten in place, which is a real
   * degradation but not a failure.
   */
  async #send(text: string): Promise<void> {
    const rendered = summarizeForLimit(text, this.#adapter.capabilities.maxMessageBytes)
    this.#lastSentAt = Date.now()

    if (this.#postedRef && this.#adapter.capabilities.editMessage) {
      try {
        await this.#adapter.perform({ kind: 'edit', ref: this.#buildEditRef(), text: rendered })
      } catch (error) {
        this.#log?.error({ err: error }, 'ProgressReporter: edit failed')
        throw error
      }
      return
    }

    const result = await this.#adapter.perform({ kind: 'post', ref: this.#ref, text: rendered })
    const message = result.ref.message
    if (!message) {
      throw new Error(
        "ProgressReporter: adapter's post result carried no message id, so no later edit " +
          'can target it; the adapter must return one on every post',
      )
    }
    this.#postedRef = { ...result.ref, message }
  }

  #buildEditRef(): Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef {
    const postedRef = this.#postedRef
    if (!postedRef) {
      throw new Error('ProgressReporter: attempted to edit before any message was posted')
    }
    const ref: Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef = {
      channel: postedRef.channel,
      message: postedRef.message,
    }
    if (postedRef.thread !== undefined) ref.thread = postedRef.thread
    return ref
  }
}
