/**
 * Slack over Socket Mode. This is the one file in the milestone that talks
 * to Slack: everything else works against the platform neutral contract in
 * src/chat/contract.ts. Two seams keep it testable without a workspace:
 * `SlackBoltApp` stands in for a real `@slack/bolt` App (event ingestion),
 * and `SlackApiClient` stands in for a real `@slack/web-api` WebClient
 * (outbound calls). Production code builds both from real Slack packages in
 * createLiveSlackBoltApp and createLiveSlackApiClient; test/chat/slack/
 * adapter.test.ts wires SlackAdapter to hand written stubs instead, so
 * runChatAdapterConformance proves the contract with no network at all.
 */
import { App } from '@slack/bolt'
import { ErrorCode, WebClient } from '@slack/web-api'
import { unwrapForAudit, wrapUntrusted } from '../../agent/untrusted.js'
import type { Untrusted } from '../../agent/untrusted.js'
import type { Logger } from '../../obs/logger.js'
import { SecretNotFoundError } from '../../secrets/provider.js'
import type { SecretProvider } from '../../secrets/provider.js'
import { TransportError } from '../outbox.js'
import type {
  AdapterCapabilities,
  ChatAction,
  ChatActionResult,
  ChatAdapter,
  ChatEvent,
  ChatEventKind,
  ChatFile,
  ChatRef,
} from '../contract.js'
import { IntakeFailedError, isStopInstruction } from '../contract.js'
import type { Approval, ApprovalOption, ResolveApprovalResult, ResolveOutcome } from '../../approvals/store.js'
import {
  APPROVAL_ACTION_IDS,
  CONFIRM_MODAL_ACTION_ID,
  CONFIRM_MODAL_BLOCK_ID,
  CONFIRM_MODAL_CALLBACK_ID,
  EDIT_MODAL_ACTION_ID,
  EDIT_MODAL_BLOCK_ID,
  EDIT_MODAL_CALLBACK_ID,
  confirmationMismatchError,
  editValidationError,
  GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS,
  UNRESOLVED_OUTCOME_DESCRIPTIONS,
  parseModalMetadata,
  renderConfirmationModal,
  renderEditModal,
  renderResolvedCard,
} from '../../approvals/blockkit.js'
import type { ModalMetadata, SlackBlock } from '../../approvals/blockkit.js'
import {
  decodeSessionAttachValue,
  MAX_LISTED_SESSIONS,
  renderAttachConfirmation,
  renderAttachFailure,
  renderSessionList,
  SESSION_ATTACH_ACTION_ID,
} from './session-attach.js'
import type { AttachThreadToSessionParams, AttachThreadToSessionResult } from './session-attach.js'
import type { EngineSession } from '../../sessions/discovery.js'
import { DIRECT_SLASH_COMMAND } from '../../live/session-mode.js'

/** Keychain item names, per Task 1. Exported so the smoke script and tests can name them without repeating the literal. */
export const SLACK_BOT_TOKEN_SECRET = 'relay-slack-bot-token'
export const SLACK_APP_TOKEN_SECRET = 'relay-slack-app-token'

/**
 * Slack's own hard limit: `chat.postMessage`'s `text` field is truncated
 * past 40,000 characters (source:
 * docs.slack.dev/reference/methods/chat.postMessage, "Slack will truncate
 * messages containing more than 40,000 characters"). Buffer.byteLength
 * counts UTF-8 bytes, which is always greater than or equal to the
 * character count, so capping at 40,000 bytes is a conservative proxy for
 * Slack's 40,000 CHARACTER limit: any text within 40,000 bytes has at most
 * 40,000 characters, never more.
 */
const SLACK_MAX_MESSAGE_BYTES = 40_000

/**
 * Capabilities a real Slack app can honestly deliver with the granted
 * SLACK_BOT_SCOPES: chat:write covers post and edit of the bot's own
 * messages, files:write covers upload, interactivity plus block actions
 * covers buttons, and views.open needs no separate scope for modals.
 */
const DEFAULT_SLACK_CAPABILITIES: AdapterCapabilities = {
  buttons: true,
  editMessage: true,
  fileUpload: true,
  modals: true,
  threads: true,
  maxMessageBytes: SLACK_MAX_MESSAGE_BYTES,
}

const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3
/** How many distinct (channel, ts) pairs the self-mention/message dedupe window remembers. See #handleRawEnvelope. */
const DEDUPE_WINDOW_SIZE = 500

/**
 * FR-ATT-5's session picker trigger: the exact word "sessions", matched the
 * same way isStopInstruction matches "stop" (trim, lowercase, exact
 * equality), for the same reason: a fixed, simple word is unambiguous and
 * needs no natural-language parsing. Handled entirely within this file,
 * never routed through #dispatch to the orchestrator's own handler, since
 * the sessions/attach flow is a Slack-side concern with no run to create;
 * see #handleRawEnvelope's own placement of this check right after the
 * Stop check it mirrors.
 */
const SESSIONS_COMMAND_TEXT = 'sessions'
/** The slash command Slack itself dispatches, declared in docs/slack-app-manifest.yaml. */
export const SESSIONS_SLASH_COMMAND = '/sessions'

function isSessionsCommand(text: Untrusted<string>): boolean {
  return unwrapForAudit(text).trim().toLowerCase() === SESSIONS_COMMAND_TEXT
}
/**
 * Bounds how long stop() waits for already-queued inbound deliveries to
 * settle before stopping Bolt anyway. Matches SHUTDOWN_SETTLE_TIMEOUT_MS in
 * src/orchestrator.ts: by the time that caller reaches dispatcher.stop() it
 * has already spent its own bounded wait on the same in-flight work, so
 * this is a backstop for a direct SlackAdapter user, not the primary bound.
 */
const STOP_DELIVERY_SETTLE_TIMEOUT_MS = 15_000

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
const IGNORED_MESSAGE_SUBTYPES = new Set([
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

// ---------------------------------------------------------------------------
// The two seams: SlackBoltApp (inbound) and SlackApiClient (outbound).
// ---------------------------------------------------------------------------

/** The untouched Slack event payload, loosely typed since only a few fields are ever read from it. Retained on ChatEvent.raw for audit, per AP-2, never fed to a model. */
export type SlackRawEvent = Record<string, unknown> & {
  type?: string
  subtype?: string
  channel?: string
  user?: string
  bot_id?: string
  text?: string
  ts?: string
  thread_ts?: string
  files?: unknown
}

/** What a Bolt event listener receives. A subset of Bolt's own middleware args: only `event` and `body` are ever read. */
export type SlackEventEnvelope = {
  event: SlackRawEvent
  body: Record<string, unknown>
}

export type SlackEventListener = (envelope: SlackEventEnvelope) => Promise<void>

/**
 * One button click inside a Block Kit `actions` block, per FR-SL-5 and the
 * Task 4 brief's "receive Block Kit interactions." `action.value` carries
 * whatever JSON src/approvals/blockkit.ts's renderApprovalCard encoded into
 * that button, always at least `{ approvalId }`. `trigger_id` is required
 * to open a modal (views.open) and is only valid for a few seconds after
 * Slack sends it, so it is read and used synchronously, never stored.
 */
export type SlackBlockActionElement = {
  action_id: string
  value?: string
  type: string
  /** A `static_select` carries its value here rather than in `value`, which a button uses. */
  selected_option?: { value?: string }
}
export type SlackBlockActionEnvelope = {
  actions: SlackBlockActionElement[]
  user: { id: string }
  channel?: { id: string }
  message?: { ts: string }
  trigger_id?: string
}
export type SlackActionListener = (envelope: SlackBlockActionEnvelope) => Promise<void>

/**
 * A Block Kit modal submission (`view_submission`), per FR-APR-5's typed
 * confirmation and FR-APR-2's edit-and-approve. `state.values` is keyed by
 * block id then action id, matching how Slack itself shapes a submitted
 * view's collected input; src/approvals/blockkit.ts's exported block/action
 * id constants are what this file reads out of it.
 */
export type SlackViewStateValue = { value?: string | null }
export type SlackViewSubmissionEnvelope = {
  view: {
    callback_id: string
    private_metadata: string
    state: { values: Record<string, Record<string, SlackViewStateValue>> }
  }
  user: { id: string }
}
/**
 * `{ response_action: 'errors', errors }` keeps the modal open with an
 * inline error (Slack's own view_submission contract); `undefined` accepts
 * the submission and closes the modal. Never a bare success object: Slack
 * has no third shape for this response.
 */
export type SlackViewSubmissionResponse = { response_action: 'errors'; errors: Record<string, string> } | undefined
export type SlackViewListener = (envelope: SlackViewSubmissionEnvelope) => Promise<SlackViewSubmissionResponse>

/**
 * The inbound seam. A real `@slack/bolt` App satisfies this structurally
 * once wrapped by createLiveSlackBoltApp; a test stub can implement it
 * directly with no Bolt dependency at all. `action` and `view` are the two
 * additions this task makes, for Block Kit button clicks and modal
 * submissions respectively; both are separate Bolt subscription mechanisms
 * from `event` (`app.action`/`app.view`, not `app.event`), which is why
 * they are their own methods rather than another `event()` eventType.
 */
export interface SlackBoltApp {
  event(eventType: string, listener: SlackEventListener): void
  action(actionId: string, listener: SlackActionListener): void
  view(callbackId: string, listener: SlackViewListener): void
  /**
   * A Slack slash command. Its own method rather than another `event()`
   * type, matching how `action` and `view` are modelled: Bolt dispatches it
   * on a different envelope shape and it must be acked within three
   * seconds, like an interaction and unlike an event.
   */
  command(commandName: string, listener: SlackCommandListener): void
  start(): Promise<unknown>
  stop(): Promise<void>
}

/** What Slack sends for a slash command. `channel_id` and `user_id` are Slack's own, so they are trusted the way a click envelope's are, and never read back out of the command's free text. */
export type SlackCommandEnvelope = {
  channel_id: string
  user_id: string
  text: string
  trigger_id?: string
}
export type SlackCommandListener = (envelope: SlackCommandEnvelope) => Promise<void>

export type SlackAuthIdentity = { botUserId: string; platformTeamId: string }
/** `blocks` is optional on post and update, added by this task: every existing caller (ProgressReporter, reports) posts plain text through src/chat/contract.ts's text-only ChatAction and never sets it; only this file's own approval-card rendering (bypassing ChatAction, since approvals are not wired into the general chat contract yet) ever supplies one. */
export type SlackPostMessageArgs = { channel: string; text: string; thread?: string; blocks?: SlackBlock[] }
export type SlackUpdateMessageArgs = { channel: string; ts: string; text: string; blocks?: SlackBlock[] }
export type SlackUploadFileArgs = {
  channel: string
  filename: string
  bytes: Uint8Array
  comment?: string
  thread?: string
}
export type SlackOpenModalArgs = { triggerId: string; view: Record<string, unknown> }
export type SlackAddReactionArgs = { channel: string; ts: string; name: string }

/**
 * The outbound seam, standing in for a real `@slack/web-api` WebClient.
 * `uploadFile` returns nothing because ChatActionResult only ever carries a
 * `ref`, and MockAdapter's upload path establishes that convention: there
 * is nothing an upload needs to hand back beyond the ref the caller already
 * has. `openModal`, added by this task, is the one call with no
 * ChatActionResult-shaped return at all: views.open does not hand back
 * anything this file needs, since the modal's own eventual view_submission
 * is what carries the result back, not this call's response.
 */
export interface SlackApiClient {
  authTest(): Promise<SlackAuthIdentity>
  postMessage(args: SlackPostMessageArgs): Promise<{ ts: string; channel?: string }>
  updateMessage(args: SlackUpdateMessageArgs): Promise<{ ts: string }>
  uploadFile(args: SlackUploadFileArgs): Promise<void>
  openModal(args: SlackOpenModalArgs): Promise<void>
  /** reactions.add; resolves when the reaction is already there (`already_reacted`), since the caller's intent is then met. */
  addReaction(args: SlackAddReactionArgs): Promise<void>
}

// ---------------------------------------------------------------------------
// Rate limiting. Slack returns HTTP 429 with a Retry-After header; the
// live client is built with rejectRateLimitedCalls so that comes back as a
// WebAPIRateLimitedError (code slack_webapi_rate_limited_error, retryAfter
// in seconds) instead of the library silently retrying on its own schedule.
// #callApi below is what actually waits and retries, so the behaviour is
// identical whether the underlying client is real or a test stub that
// throws the same shaped error.
// ---------------------------------------------------------------------------

type RateLimitedLike = { code: string; retryAfter: number }

function isRateLimitedError(error: unknown): error is RateLimitedLike {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; retryAfter?: unknown }
  return candidate.code === ErrorCode.RateLimitedError && typeof candidate.retryAfter === 'number'
}

// ---------------------------------------------------------------------------
// Gate fix, Blocker 4: distinguishing a retryable transport failure from a
// permanent one, so a connectivity outage does not permanently fail a
// message the platform was always going to accept once it came back.
// ---------------------------------------------------------------------------

/**
 * `@slack/web-api`'s own ErrorCode already distinguishes the platform
 * genuinely rejecting a request (`PlatformError`: Slack answered with
 * `ok: false` and a specific reason, a channel that does not exist, an
 * invalid token) from the request never reaching Slack, or Slack's own
 * infrastructure failing to answer meaningfully at all
 * (`RequestError`: the underlying HTTP request itself failed, a DNS
 * failure, a connection reset, a timeout; `HTTPError`: a non-2xx response
 * with no valid platform JSON body, most plausibly Slack's own edge
 * returning a 5xx during an outage). Only the second pair describes a
 * transport-level failure src/chat/outbox.ts's TransportError classification
 * exists for; a PlatformError is Slack telling Relay plainly that this
 * specific request will never succeed, which is exactly what the ordinary,
 * bounded maxAttempts budget is for.
 */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([ErrorCode.RequestError, ErrorCode.HTTPError])

/**
 * Rewraps a transport-level Slack API error as TransportError before it
 * ever reaches Outbox, so a 60 second Slack outage (TST-C-4) retries
 * indefinitely instead of burning the roughly 18 seconds DEFAULT_MAX_ATTEMPTS
 * with its default backoff allows before terminal failure. Any other error,
 * including a genuine PlatformError, passes through completely unchanged.
 */
function classifyTransportError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || !TRANSPORT_ERROR_CODES.has(code)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new TransportError(
    `SlackAdapter: transport-level failure calling the Slack API (${code}): ${message}`,
    { cause: error },
  )
}

// ---------------------------------------------------------------------------
// Live wiring. Isolated here so adapter.ts's own logic never has to know
// Bolt's or WebClient's real types beyond this construction step.
// ---------------------------------------------------------------------------

function createLiveSlackBoltApp(botToken: string, appToken: string): SlackBoltApp {
  const app = new App({ token: botToken, appToken, socketMode: true })
  return {
    event(eventType, listener) {
      app.event(eventType, async (args) => {
        await listener({
          event: args.event as unknown as SlackRawEvent,
          body: args.body as unknown as Record<string, unknown>,
        })
      })
    },
    action(actionId, listener) {
      // Bolt requires ack() within 3 seconds of delivery; the underlying
      // approval resolution (a database round trip, possibly a Slack
      // views.open call) can legitimately take longer than that, so this
      // acks immediately and lets the listener's own work happen after,
      // exactly like a real button click needs to feel instant even though
      // resolving the approval is not instant.
      app.action(actionId, async ({ ack, action, body }) => {
        await ack()
        const raw = body as unknown as {
          user: { id: string }
          channel?: { id: string }
          message?: { ts: string }
          trigger_id?: string
        }
        // Built conditionally, not as a literal with every key always
        // present: exactOptionalPropertyTypes (this project's own tsconfig)
        // distinguishes an omitted key from one explicitly set to
        // `undefined`, and SlackBlockActionEnvelope's optional fields
        // require the former.
        const envelope: SlackBlockActionEnvelope = {
          actions: [action as unknown as SlackBlockActionElement],
          user: raw.user,
        }
        if (raw.channel !== undefined) envelope.channel = raw.channel
        if (raw.message !== undefined) envelope.message = raw.message
        if (raw.trigger_id !== undefined) envelope.trigger_id = raw.trigger_id
        await listener(envelope)
      })
    },
    command(commandName, listener) {
      app.command(commandName, async ({ ack, command }) => {
        // Acked immediately, per Bolt's three second budget, which can be
        // shorter than the filesystem scan the listener performs.
        await ack()
        const raw = command as unknown as { channel_id: string; user_id: string; text?: string; trigger_id?: string }
        const envelope: SlackCommandEnvelope = {
          channel_id: raw.channel_id,
          user_id: raw.user_id,
          text: raw.text ?? '',
        }
        if (raw.trigger_id !== undefined) envelope.trigger_id = raw.trigger_id
        await listener(envelope)
      })
    },
    view(callbackId, listener) {
      app.view(callbackId, async ({ ack, view, body }) => {
        // Defense in depth, fix round 1: SlackAdapter's own view listener
        // methods (#handleConfirmModalSubmission, #handleEditModalSubmission)
        // already catch everything internally and never reject this
        // promise, but if something upstream of that ever did (decoding
        // `body`, a bug in a future listener), an unacked modal hangs until
        // Slack's own timeout, which is strictly worse than a generic,
        // truthful error. This still acks with one rather than leaving the
        // operator staring at a modal that can never close on its own.
        try {
          const raw = body as unknown as { user: { id: string } }
          const response = await listener({
            view: view as unknown as SlackViewSubmissionEnvelope['view'],
            user: raw.user,
          })
          if (response) await ack(response)
          else await ack()
        } catch {
          const blockId = callbackId === EDIT_MODAL_CALLBACK_ID ? EDIT_MODAL_BLOCK_ID : CONFIRM_MODAL_BLOCK_ID
          await ack({
            response_action: 'errors',
            errors: { [blockId]: 'Something went wrong; your decision was not recorded. Please try again.' },
          }).catch(() => {})
        }
      })
    },
    start: () => app.start(),
    stop: async () => {
      await app.stop()
    },
  }
}

/** Slack writes a user mention as `<@U123>`, or `<@U123|label>` in older payloads. */
function mentionsUser(text: string, userId: string): boolean {
  return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`)
}

function isAlreadyReacted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const data = (error as { data?: { error?: unknown } }).data
  return data?.error === 'already_reacted'
}

export function createLiveSlackApiClient(botToken: string): SlackApiClient {
  // rejectRateLimitedCalls: true means a 429 surfaces as a
  // WebAPIRateLimitedError immediately rather than the library retrying
  // silently on its own undocumented schedule; #callApi is the one place
  // that decides how Relay retries, so its behaviour is provably the same
  // whether this is a real WebClient or a test stub.
  const client = new WebClient(botToken, { rejectRateLimitedCalls: true })

  return {
    async authTest() {
      const result = await client.auth.test()
      const botUserId = typeof result.user_id === 'string' ? result.user_id : undefined
      const platformTeamId = typeof result.team_id === 'string' ? result.team_id : undefined
      if (!botUserId || !platformTeamId) {
        throw new Error('SlackAdapter: auth.test did not return both user_id and team_id')
      }
      return { botUserId, platformTeamId }
    },
    async postMessage(args) {
      const result = await client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        ...(args.thread !== undefined ? { thread_ts: args.thread } : {}),
        ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
      })
      const ts = typeof result.ts === 'string' ? result.ts : undefined
      if (!ts) throw new Error('SlackAdapter: chat.postMessage did not return a ts')
      // A post to a user id lands in that user's DM, whose channel id only the response names.
      return typeof result.channel === 'string' ? { ts, channel: result.channel } : { ts }
    },
    async updateMessage(args) {
      const result = await client.chat.update({
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
      })
      const ts = typeof result.ts === 'string' ? result.ts : undefined
      if (!ts) throw new Error('SlackAdapter: chat.update did not return a ts')
      return { ts }
    },
    async uploadFile(args) {
      // Built as a mutable record rather than a typed literal: uploadV2's
      // argument type is a union keyed on which destination and thread
      // fields are present at all, which exactOptionalPropertyTypes will
      // not accept from a conditionally spread optional key. The cast on
      // the call below is the one place that type gets reasserted.
      const params: Record<string, unknown> = {
        channel_id: args.channel,
        filename: args.filename,
        file: Buffer.from(args.bytes),
      }
      if (args.comment !== undefined) params.initial_comment = args.comment
      if (args.thread !== undefined) params.thread_ts = args.thread
      await client.files.uploadV2(params as unknown as Parameters<typeof client.files.uploadV2>[0])
    },
    async openModal(args) {
      await client.views.open({
        trigger_id: args.triggerId,
        view: args.view as unknown as Parameters<typeof client.views.open>[0]['view'],
      })
    },
    async addReaction(args) {
      try {
        await client.reactions.add({ channel: args.channel, timestamp: args.ts, name: args.name })
      } catch (error) {
        if (isAlreadyReacted(error)) return
        throw error
      }
    },
  }
}

/** Reads a secret by name, converting "not found" into an error that names the secret and never the value, per FR-SLA-6 and the startup error requirement. */
async function readRequiredSecret(secrets: SecretProvider, name: string): Promise<string> {
  try {
    return await secrets.get(name)
  } catch (error) {
    if (error instanceof SecretNotFoundError) {
      throw new Error(
        `SlackAdapter cannot start: secret "${name}" is not configured. Store it in the ` +
          'Keychain (or the configured secret provider) before starting the adapter.',
      )
    }
    throw error
  }
}

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
class RecentEventWindow {
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

function buildChatFiles(rawFiles: unknown): ChatFile[] {
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

/**
 * What a Block Kit approval interaction, decoded, hands to the injected
 * resolver: everything src/approvals/store.ts's resolveApproval needs
 * except `workspaceId` (this adapter always knows its own) and
 * `sessionGrantTtlMs`/`now` (the resolver's own concern, not the
 * interaction's). `resolverPrincipalId` is resolved the same way every
 * other inbound identity in this file is, through `resolvePrincipalId`,
 * so an unmapped Slack user reaches the resolver as `null` and FR-APR-4's
 * authorization check fails it, the same fail-closed shape FR-CA-4 already
 * requires for starting a run.
 */
export type ApprovalInteractionRequest = {
  approvalId: string
  option: ApprovalOption
  resolverPlatformUserId: string
  resolverPrincipalId: string | null
  typedConfirmation?: string
  editedArguments?: string
}

export type SlackAdapterOptions = {
  log?: Logger
  /** Maps a Slack user id to a Relay principal id, per FR-CA-4. Defaults to always-null (unmapped, fail closed), because SlackAdapter itself has no database dependency; a caller that wants real mapping passes principals.ts's resolvePrincipal bound to its own pool and workspace. */
  resolvePrincipalId?: (platformUserId: string) => Promise<string | null>
  /**
   * Maps this adapter's Slack team id to a Relay workspace uuid, per PRE-3.
   * Resolved once, at construction, since one running SlackAdapter always
   * belongs to exactly one Slack workspace for its whole lifetime.
   *
   * There is deliberately no default that resolves anything: the original
   * defect this closes was exactly a default that let the raw Slack team id
   * stand in for a uuid, so `create` throws when this is absent instead of
   * repeating that mistake with a different disguise. Production code
   * passes `src/tenancy/workspaces.ts`'s `resolveWorkspaceId` bound to a
   * pool, for example `(platform, teamId) => resolveWorkspaceId(pool, platform, teamId)`.
   */
  resolveWorkspaceId?: (platform: string, platformTeamId: string) => Promise<string>
  /**
   * Answers whether `threadRef` (see composeThreadRef) names a known Relay
   * session, per PRE-4 and FR-SL-2's "a reply inside an existing Relay
   * thread" entry point. Defaults to a function that always returns false,
   * so until a real implementation is wired (Task 8), a channel thread
   * reply is always ignored: P0.2's narrow interim rule stays the default
   * behaviour. That default is deliberate, not a placeholder to remove
   * later: refusing an unrecognised thread is the safe direction to be
   * wrong in, since accepting one wrongly is the blocker P0.2's gate
   * caught.
   *
   * Never called for a DM or a channel root app_mention: both are already
   * allowed without a lookup, and each call is a database round trip on
   * the inbound path, so #isChannelEntryAllowed only reaches this for a
   * genuine channel thread reply. Production code passes a lookup backed
   * by src/sessions/store.ts, composing the same threadRef this adapter
   * composes.
   */
  isKnownSession?: (threadRef: string) => Promise<boolean>
  /**
   * When true, an `app_mention` reply in a channel thread with no known
   * session is accepted, so a mention under a PR or ticket post reaches the
   * orchestrator (autonomous tasks). Plain thread messages keep the
   * isKnownSession rule. Defaults to false; startOrchestrator sets it from
   * `autonomous.enabled`.
   */
  acceptThreadMentions?: boolean
  /**
   * Resolves a Block Kit approval interaction (a button click or a modal
   * submission), per the Task 4 brief's "receive Block Kit interactions."
   * Defaults to a function that always returns `undefined`, meaning "no
   * approval resolver is wired": every interaction is received and parsed,
   * but nothing acts on it beyond a log line, exactly the same "receive but
   * do not act" shape resolvePrincipalId's and isKnownSession's own
   * defaults already establish above. Wiring this to a real resolver
   * (src/approvals/store.ts's resolveApproval, bound to a pool and
   * workspace) is a later task's job, per the Task 4 brief: "Task 3 is
   * defining the interface the policy seam will call... do not wire the
   * two together." This is that seam's Slack-side half.
   */
  resolveApprovalInteraction?: (request: ApprovalInteractionRequest) => Promise<ResolveApprovalResult | undefined>
  /**
   * Lists recent Claude Code sessions for the "sessions" command, per
   * FR-ATT-5. Defaults to a function that always returns an empty list, the
   * same "receive but do not act" shape every other default in this type
   * establishes: until a real implementation is wired, the picker answers
   * honestly ("no sessions found") rather than throwing or silently doing
   * nothing. Production code passes src/chat/slack/session-attach.js's
   * listRecentEngineSessions, backed by src/sessions/discovery.ts's
   * listEngineSessions.
   */
  listRecentSessions?: (limit: number) => Promise<readonly EngineSession[]>
  /**
   * FR-ATT-30: handles `/direct`, which puts a thread on a plain Claude Code
   * session instead of Relay's governed loop. Injected rather than
   * implemented here for the same reason listRecentSessions is: the adapter
   * carries messages, it does not decide what a session is.
   */
  onDirectCommand?: (request: { channelId: string; userId: string; text: string; post: (text: string, thread?: string) => Promise<{ ts: string }> }) => Promise<void>
  /**
   * Binds the current thread to an existing Claude Code session (a folder
   * plus an engine session id), per FR-ATT-5 and §24's attach flow.
   * Defaults to a function that always returns `undefined`, meaning "not
   * wired": a click is received and parsed, but nothing is attached, and
   * the operator sees an honest failure message rather than a silent
   * no-op. Production code passes
   * src/chat/slack/session-attach.js's createRealAttachThreadToSession,
   * bound to a pool and this adapter's own workspace id.
   */
  attachThreadToSession?: (params: AttachThreadToSessionParams) => Promise<AttachThreadToSessionResult | undefined>
  /** Overrides the declared capabilities. Production code should never need this; it exists for test doubles that must present a capability gap for runChatAdapterConformance's honesty check to exercise, see test/chat/slack/adapter.test.ts. */
  capabilities?: Partial<AdapterCapabilities>
  /** Overrides the wait between rate limited retries. Defaults to a real setTimeout; tests inject an instant resolver so adapter.test.ts never actually sleeps. */
  sleep?: (ms: number) => Promise<void>
  maxRateLimitRetries?: number
  botTokenSecretName?: string
  appTokenSecretName?: string
}

export type SlackAdapterCreateOptions = SlackAdapterOptions & {
  /** Test-only: an already built SlackBoltApp, bypassing @slack/bolt entirely. */
  boltApp?: SlackBoltApp
  /** Test-only: an already built SlackApiClient, bypassing @slack/web-api entirely. */
  apiClient?: SlackApiClient
}

type SlackAdapterDeps = {
  boltApp: SlackBoltApp
  apiClient: SlackApiClient
  botUserId: string
  workspaceId: string
  platformTeamId: string
  capabilities: AdapterCapabilities
  resolvePrincipalId: (platformUserId: string) => Promise<string | null>
  isKnownSession: (threadRef: string) => Promise<boolean>
  acceptThreadMentions: boolean
  resolveApprovalInteraction: (request: ApprovalInteractionRequest) => Promise<ResolveApprovalResult | undefined>
  listRecentSessions: (limit: number) => Promise<readonly EngineSession[]>
  onDirectCommand: (request: { channelId: string; userId: string; text: string; post: (text: string, thread?: string) => Promise<{ ts: string }> }) => Promise<void>
  attachThreadToSession: (params: AttachThreadToSessionParams) => Promise<AttachThreadToSessionResult | undefined>
  sleep: (ms: number) => Promise<void>
  maxRateLimitRetries: number
  log: Logger | undefined
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Bolt over Socket Mode, per FR-SLA-8: nothing here ever opens a public
 * HTTP endpoint. Construction is two steps on purpose. The constructor
 * itself does no I/O and cannot fail; `SlackAdapter.create` is the async
 * factory that reads both tokens from the SecretProvider (never a file,
 * never process.env directly, per FR-SLA-6), resolves the bot's own
 * identity via auth.test, and only then builds a SlackAdapter that already
 * knows enough to filter its own messages. Splitting it this way is what
 * lets a missing token fail with one clear error before anything Slack
 * specific is even constructed.
 */
export class SlackAdapter implements ChatAdapter {
  readonly name = 'slack'
  readonly capabilities: AdapterCapabilities

  readonly #boltApp: SlackBoltApp
  readonly #apiClient: SlackApiClient
  readonly #botUserId: string
  readonly #workspaceId: string
  readonly #platformTeamId: string
  readonly #resolvePrincipalId: (platformUserId: string) => Promise<string | null>
  readonly #isKnownSession: (threadRef: string) => Promise<boolean>
  readonly #acceptThreadMentions: boolean
  readonly #resolveApprovalInteraction: (request: ApprovalInteractionRequest) => Promise<ResolveApprovalResult | undefined>
  readonly #listRecentSessions: (limit: number) => Promise<readonly EngineSession[]>
  readonly #onDirectCommand: (request: { channelId: string; userId: string; text: string; post: (text: string, thread?: string) => Promise<{ ts: string }> }) => Promise<void>
  readonly #attachThreadToSession: (params: AttachThreadToSessionParams) => Promise<AttachThreadToSessionResult | undefined>
  readonly #sleep: (ms: number) => Promise<void>
  readonly #maxRateLimitRetries: number
  readonly #log: Logger | undefined
  readonly #recentEvents = new RecentEventWindow(DEDUPE_WINDOW_SIZE)

  #started = false
  #dispatch: ((event: ChatEvent) => Promise<void>) | undefined
  /**
   * The raw handler start() was given, kept alongside #dispatch (the queued
   * wrapper around it) so a Stop instruction can reach it directly, per gate
   * fix Blocker 1. See #handleRawEnvelope's own comment on why a Stop must
   * bypass #deliveryQueue entirely rather than being queued through
   * #dispatch like every other event.
   */
  #handler: ((event: ChatEvent) => Promise<void>) | undefined
  #deliveryQueue: Promise<void> = Promise.resolve()

  private constructor(deps: SlackAdapterDeps) {
    this.#boltApp = deps.boltApp
    this.#apiClient = deps.apiClient
    this.#botUserId = deps.botUserId
    this.#workspaceId = deps.workspaceId
    this.#platformTeamId = deps.platformTeamId
    this.capabilities = deps.capabilities
    this.#resolvePrincipalId = deps.resolvePrincipalId
    this.#isKnownSession = deps.isKnownSession
    this.#acceptThreadMentions = deps.acceptThreadMentions
    this.#resolveApprovalInteraction = deps.resolveApprovalInteraction
    this.#listRecentSessions = deps.listRecentSessions
    this.#onDirectCommand = deps.onDirectCommand
    this.#attachThreadToSession = deps.attachThreadToSession
    this.#sleep = deps.sleep
    this.#maxRateLimitRetries = deps.maxRateLimitRetries
    this.#log = deps.log
  }

  static async create(secrets: SecretProvider, options: SlackAdapterCreateOptions = {}): Promise<SlackAdapter> {
    const botToken = await readRequiredSecret(secrets, options.botTokenSecretName ?? SLACK_BOT_TOKEN_SECRET)
    const appToken = await readRequiredSecret(secrets, options.appTokenSecretName ?? SLACK_APP_TOKEN_SECRET)

    const apiClient = options.apiClient ?? createLiveSlackApiClient(botToken)
    const boltApp = options.boltApp ?? createLiveSlackBoltApp(botToken, appToken)
    const identity = await apiClient.authTest()

    // Mapped once here, not per event: identity.platformTeamId is fixed for
    // this adapter's whole lifetime, and resolving it here rather than in
    // #buildChatEvent is what "at adapter construction" in PRE-3 means.
    // There is no fallback to identity.platformTeamId itself: that is
    // precisely the bug this closes, a raw Slack team id standing in for a
    // uuid that workspaces.id requires.
    const resolveWorkspaceId = options.resolveWorkspaceId
    if (!resolveWorkspaceId) {
      throw new Error(
        'SlackAdapter cannot start: no resolveWorkspaceId was provided. ChatEvent.workspaceId ' +
          'must carry a Relay workspace uuid, never the raw Slack team id, per PRE-3 ' +
          '(docs/decisions/open-questions.md). Pass src/tenancy/workspaces.ts resolveWorkspaceId, ' +
          'bound to a pool, for example (platform, teamId) => resolveWorkspaceId(pool, platform, teamId).',
      )
    }
    const workspaceId = await resolveWorkspaceId('slack', identity.platformTeamId)

    return new SlackAdapter({
      boltApp,
      apiClient,
      botUserId: identity.botUserId,
      workspaceId,
      platformTeamId: identity.platformTeamId,
      capabilities: { ...DEFAULT_SLACK_CAPABILITIES, ...options.capabilities },
      resolvePrincipalId: options.resolvePrincipalId ?? (async () => null),
      isKnownSession: options.isKnownSession ?? (async () => false),
      acceptThreadMentions: options.acceptThreadMentions ?? false,
      resolveApprovalInteraction: options.resolveApprovalInteraction ?? (async () => undefined),
      listRecentSessions: options.listRecentSessions ?? (async () => []),
      // Refuses rather than silently doing nothing when no handler is
      // wired: a slash command that acknowledges and then ignores you is
      // the worst of both.
      onDirectCommand:
        options.onDirectCommand ??
        (async ({ post }) => {
          await post('Direct sessions are not configured on this Relay installation.')
        }),
      attachThreadToSession: options.attachThreadToSession ?? (async () => undefined),
      sleep: options.sleep ?? defaultSleep,
      maxRateLimitRetries: options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES,
      log: options.log,
    })
  }

  async start(handler: (event: ChatEvent) => Promise<void>): Promise<void> {
    if (this.#started) return

    this.#handler = handler
    // An IntakeFailedError comes back to #handleRawEnvelope, which releases
    // the dedupe key; every other handler error is logged and dropped as in
    // #deliver. The stored tail is always settled, so one failed delivery
    // never blocks the ones after it.
    const dispatch = (event: ChatEvent): Promise<void> => {
      const next = this.#deliveryQueue.then(async () => {
        try {
          await handler(event)
        } catch (error) {
          if (error instanceof IntakeFailedError) throw error
          this.#log?.error({ err: error }, 'SlackAdapter: inbound handler threw')
        }
      })
      this.#deliveryQueue = next.catch(() => undefined)
      return next
    }
    this.#dispatch = dispatch

    // Each subscription is handled by its own listener, rather than one
    // shared listener, because #handleRawEnvelope's channel entry gate
    // (#isChannelEntryAllowed) needs to know which subscription an envelope
    // arrived on: a channel root message is only ever accepted through
    // app_mention, never through the plain message subscription.
    const onAppMention: SlackEventListener = async (envelope) => {
      await this.#handleRawEnvelope(envelope, 'app_mention')
    }
    const onMessage: SlackEventListener = async (envelope) => {
      await this.#handleRawEnvelope(envelope, 'message')
    }
    this.#boltApp.event('app_mention', onAppMention)
    this.#boltApp.event('message', onMessage)

    // Block Kit interactions, per the Task 4 brief. Registered once here,
    // like the two event subscriptions above, with four fixed action ids
    // (the approval id travels in each button's own `value`, never in the
    // action id) and two fixed modal callback ids. Deliberately NOT routed
    // through #deliveryQueue/#dispatch: an approval click is a short,
    // self-contained interaction keyed by its own approvalId, not part of
    // the ordered inbound-message stream #deliveryQueue exists to
    // serialize, and queuing it behind a long-running run's own messages
    // would make a button feel unresponsive for no correctness benefit.
    // Each handler catches and logs its own errors (see their own doc
    // comments) so one bad interaction can never crash the Bolt listener.
    this.#boltApp.action(APPROVAL_ACTION_IDS.approve, async (envelope) => {
      await this.#handleApprovalButton(envelope, 'approve')
    })
    this.#boltApp.action(APPROVAL_ACTION_IDS.deny, async (envelope) => {
      await this.#handleApprovalButton(envelope, 'deny')
    })
    this.#boltApp.action(APPROVAL_ACTION_IDS.approveAllSession, async (envelope) => {
      await this.#handleApprovalButton(envelope, 'approve_all_session')
    })
    this.#boltApp.action(APPROVAL_ACTION_IDS.editAndApprove, async (envelope) => {
      await this.#handleApprovalButton(envelope, 'edit_and_approve')
    })
    this.#boltApp.view(CONFIRM_MODAL_CALLBACK_ID, (envelope) => this.#handleConfirmModalSubmission(envelope))
    this.#boltApp.view(EDIT_MODAL_CALLBACK_ID, (envelope) => this.#handleEditModalSubmission(envelope))

    // FR-ATT-5's session picker button, one fixed action id shared by every
    // row (which session was picked travels in that row's own button
    // value, per SESSION_ATTACH_ACTION_ID's own doc comment), same
    // deliberate bypass of #deliveryQueue/#dispatch as the approval
    // buttons above, for the same reason.
    // FR-ATT-5: `/sessions`, a real Slack slash command, so it appears in
    // Slack's own autocomplete. The plain-text `sessions` trigger stays
    // alongside it: it needs no manifest change and therefore keeps working
    // if the app is ever reinstalled without the command declared.
    //
    // A slash command has no thread of its own, so the list posts at top
    // level and the card's own ts becomes the thread root. That is why the
    // button handler reads channel and thread from the click envelope
    // rather than from the button's value: at render time the thread does
    // not exist yet.
    this.#boltApp.command(SESSIONS_SLASH_COMMAND, async (envelope) => {
      try {
        const sessions = await this.#listRecentSessions(MAX_LISTED_SESSIONS)
        const { text, blocks } = renderSessionList(sessions, envelope.channel_id, '')
        await this.#apiClient.postMessage({ channel: envelope.channel_id, text, blocks })
      } catch (error) {
        this.#log?.error({ err: error }, 'SlackAdapter: /sessions failed')
        const { text, blocks } = renderAttachFailure('could not list sessions right now')
        await this.#apiClient.postMessage({ channel: envelope.channel_id, text, blocks }).catch(() => {})
      }
    })

    // The thread a direct session lives in is the message this posts, so the
    // handler returns text and this posts it: the command envelope has no
    // thread of its own, exactly as /sessions does not.
    this.#boltApp.command(DIRECT_SLASH_COMMAND, async (envelope) => {
      try {
        // The handler posts, because the ts of its FIRST message becomes the
        // thread this session lives in, and only the handler knows what to
        // record against it.
        await this.#onDirectCommand({
          channelId: envelope.channel_id,
          userId: envelope.user_id,
          text: envelope.text ?? '',
          // `thread` is what makes the session's later replies land where
          // its first message did. Without it every reply posts at channel
          // top level, which reads as a broken thread rather than a session.
          post: (text: string, thread?: string) =>
            this.#apiClient.postMessage({
              channel: envelope.channel_id,
              text,
              ...(thread === undefined ? {} : { thread }),
            }),
        })
      } catch (error) {
        this.#log?.error({ err: error }, 'SlackAdapter: /direct failed')
        await this.#apiClient
          .postMessage({ channel: envelope.channel_id, text: 'Could not start a direct session. Check `relay doctor`.' })
          .catch(() => {})
      }
    })

    this.#boltApp.action(SESSION_ATTACH_ACTION_ID, async (envelope) => {
      await this.#handleSessionAttachButton(envelope)
    })

    await this.#boltApp.start()
    this.#started = true
  }

  /**
   * Proves Slack is still reachable, rather than inferring it from the
   * absence of errors.
   *
   * Socket Mode can stop delivering while this process stays alive and logs
   * nothing, and a websocket that has gone deaf is indistinguishable from a
   * quiet workspace. Observed in production: Slack accepted messages, Relay
   * reported no error, and every inbound event was silently dropped. Rejects
   * when Slack is unreachable, so a supervisor can act.
   */
  async checkConnectivity(): Promise<void> {
    await this.#apiClient.authTest()
  }

  async stop(): Promise<void> {
    if (!this.#started) return
    // Gate fix, Medium 1: awaits every inbound delivery already queued
    // through #deliveryQueue before stopping Bolt, so a message already
    // accepted and queued for delivery is not abandoned mid-flight by
    // shutdown. #deliver itself never rejects, it catches and logs a
    // handler error (see its own doc comment), so this await can never
    // itself throw on a rejection.
    //
    // BOUNDED, though, because "never rejects" is not the same as "always
    // settles": a handler that hangs (an engine subprocess that ignores
    // its AbortSignal, a database call wedged past every timeout) leaves
    // #deliveryQueue pending forever, and an unbounded await here would
    // hang shutdown with it. src/orchestrator.ts's own stop() deliberately
    // bounds its wait for in-flight handlers for exactly this reason, then
    // calls this method: leaving this one unbounded would hand back the
    // very guarantee that bound exists to provide. Proceeding on timeout
    // is safe: Bolt's own stop() below closes the socket regardless, and a
    // still-pending handler is already reported by the orchestrator's own
    // bounded wait.
    await this.#settleDeliveryQueue(STOP_DELIVERY_SETTLE_TIMEOUT_MS)
    await this.#boltApp.stop()
    this.#started = false
    this.#dispatch = undefined
    this.#handler = undefined
  }

  async perform(action: ChatAction): Promise<ChatActionResult> {
    this.#assertCapability(action)

    if (action.kind === 'post' || action.kind === 'edit' || action.kind === 'post_approval_card') {
      this.#assertWithinByteLimit(action.text)
    }

    if (action.kind === 'post' || action.kind === 'post_approval_card') {
      const result = await this.#callApi(() =>
        this.#apiClient.postMessage({
          channel: action.ref.channel,
          text: action.text,
          ...(action.ref.thread !== undefined ? { thread: action.ref.thread } : {}),
          ...(action.kind === 'post_approval_card' ? { blocks: action.blocks } : {}),
        }),
      )
      const ref: ChatRef = { channel: result.channel ?? action.ref.channel, message: result.ts }
      if (action.ref.thread !== undefined) ref.thread = action.ref.thread
      return { ref }
    }

    if (action.kind === 'edit') {
      await this.#callApi(() =>
        this.#apiClient.updateMessage({ channel: action.ref.channel, ts: action.ref.message, text: action.text }),
      )
      return { ref: action.ref }
    }

    if (action.kind === 'upload') {
      await this.#callApi(() =>
        this.#apiClient.uploadFile({
          channel: action.ref.channel,
          filename: action.filename,
          bytes: action.bytes,
          ...(action.comment !== undefined ? { comment: action.comment } : {}),
          ...(action.ref.thread !== undefined ? { thread: action.ref.thread } : {}),
        }),
      )
      return { ref: action.ref }
    }

    if (action.kind === 'react') {
      await this.#callApi(() =>
        this.#apiClient.addReaction({ channel: action.ref.channel, ts: action.ref.message, name: action.name }),
      )
      return { ref: action.ref }
    }

    // Slack's Web API has no bot typing indicator (the legacy RTM typing
    // event has no Web API equivalent), so 'setStatus' is an honest no-op
    // success rather than a real platform call. AdapterCapabilities carries
    // no flag for this, so there is nothing to declare false for it either.
    if (action.kind === 'setStatus') return { ref: action.ref }

    const unhandled: never = action
    throw new Error(`SlackAdapter cannot perform an unknown action: ${JSON.stringify(unhandled)}`)
  }

  #assertCapability(action: ChatAction): void {
    if (action.kind === 'edit' && !this.capabilities.editMessage) {
      throw new Error("SlackAdapter cannot perform 'edit': capability editMessage is false")
    }
    if (action.kind === 'upload' && !this.capabilities.fileUpload) {
      throw new Error("SlackAdapter cannot perform 'upload': capability fileUpload is false")
    }
  }

  #assertWithinByteLimit(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.capabilities.maxMessageBytes) {
      throw new Error(
        `text is ${bytes} bytes, which exceeds this adapter's maxMessageBytes of ` +
          `${this.capabilities.maxMessageBytes}; SlackAdapter rejects rather than truncates`,
      )
    }
  }

  /**
   * Waits out a rate limited response and retries, rather than letting the
   * action fail and burn one of the outbox's limited attempts on a purely
   * transient condition. Any other error, or a rate limited error after
   * maxRateLimitRetries attempts, is passed through classifyTransportError
   * (gate fix Blocker 4) on its way out: a transport-level failure is
   * rewrapped as TransportError so Outbox retries it past maxAttempts,
   * and everything else, a genuine PlatformError included, is rethrown
   * completely unchanged.
   */
  async #callApi<T>(call: () => Promise<T>): Promise<T> {
    let attempt = 0
    for (;;) {
      try {
        return await call()
      } catch (error) {
        if (!isRateLimitedError(error) || attempt >= this.#maxRateLimitRetries) {
          throw classifyTransportError(error)
        }
        attempt += 1
        const waitMs = Math.max(0, error.retryAfter) * 1000
        this.#log?.warn({ attempt, waitMs }, 'SlackAdapter: rate limited, waiting before retry')
        await this.#sleep(waitMs)
      }
    }
  }

  /**
   * Turns one raw Slack event into at most one ChatEvent delivered to the
   * handler. Four reasons an envelope produces nothing at all: it is
   * missing the channel or ts every ChatRef needs, #shouldIgnore says it is
   * the app's own message or another bot's (which is what stops Relay
   * looping on itself in a real workspace), #isChannelEntryAllowed says
   * this is not a way FR-SL-2 permits Relay to be addressed, or it has
   * already been seen under a different subscription (the app_mention and
   * message dedupe, see RecentEventWindow).
   */
  async #handleRawEnvelope(envelope: SlackEventEnvelope, eventType: string): Promise<void> {
    const event = envelope.event
    const channel = typeof event.channel === 'string' ? event.channel : undefined
    const ts = typeof event.ts === 'string' ? event.ts : undefined
    if (!channel || !ts) return

    // Ignore, and gate channel entry, BEFORE touching the dedupe key. An
    // envelope we are going to drop must not consume the key, because the
    // key is shared with the genuine message under the same (channel, ts).
    // Slack puts the edited message's own ts at the top level of a
    // `message_changed`, so an edit of a mention carries the very same ts as
    // the `app_mention`/`message` pair for that mention. Claiming the key
    // first meant one housekeeping envelope could burn it and silently drop
    // the real user message that followed, with no error anywhere: a
    // dropped prompt, indistinguishable from Relay ignoring someone.
    if (this.#shouldIgnore(event)) return
    if (!(await this.#isChannelEntryAllowed(event, channel, ts, eventType))) return

    const dedupeKey = `${channel}:${ts}`
    if (this.#recentEvents.has(dedupeKey)) return

    // The dedupe key is claimed only after normalization (principal lookup,
    // inside #buildChatEvent) has actually succeeded, and only right before
    // handing the event off. Claiming it earlier meant a throwing
    // resolvePrincipalId (a database blip, for instance) recorded the key
    // anyway, so Slack's automatic retry of that very same envelope hit the
    // dedupe window and was silently dropped: the message was lost for
    // good, with no error anywhere an operator could see. Leaving the key
    // unclaimed on failure means the retry is treated as a fresh envelope
    // and gets a real attempt.
    const chatEvent = await this.#buildChatEvent(event, channel, ts)

    // Gate fix, Blocker 1: a Stop instruction bypasses #deliveryQueue
    // entirely rather than being queued behind whatever run is already in
    // flight. #deliveryQueue exists to serialize ordinary inbound delivery
    // (see start()'s own comment and the conformance suite's "exactly-once
    // via #deliveryQueue" note), but that same serialization is exactly
    // what made a Stop unreachable before this fix: it would queue BEHIND
    // the very run it is trying to cancel, and a long-running run would
    // never let it through in time to matter. Delivered directly through
    // #deliver instead, racing whatever else is in flight rather than
    // waiting on it, which is the whole point.
    if (isStopInstruction(chatEvent.text)) {
      // The key is claimed only once a handler actually exists to receive
      // this Stop, never before, for the same reason the comment above
      // gives: claiming it first and then returning because #handler was
      // undefined (an envelope arriving in the window between Bolt
      // starting and start() finishing, or after stop() cleared it) would
      // burn the dedupe key on a Stop that was never delivered, so Slack's
      // automatic retry of that same envelope would be silently dropped
      // and the Stop lost for good. That is the exact failure GT-14 makes
      // unacceptable: a Stop is the one message a user cannot simply
      // resend and expect the same effect.
      const handler = this.#handler
      if (!handler) return
      this.#recentEvents.add(dedupeKey)
      await this.#deliver(handler, chatEvent)
      return
    }

    // FR-ATT-5's "sessions" command, handled the same way Stop is: entirely
    // within this file, never routed through #dispatch to the
    // orchestrator's own handler. Unlike Stop this is not time-critical, so
    // bypassing #deliveryQueue is not required for correctness, but it
    // keeps every adapter-level command in one place rather than treating
    // this one differently for no reason. No #handler gate is needed
    // either: this branch never calls the orchestrator's handler at all, so
    // there is nothing for a missing #handler to leave undelivered.
    if (isSessionsCommand(chatEvent.text)) {
      this.#recentEvents.add(dedupeKey)
      await this.#handleSessionsCommand(chatEvent)
      return
    }

    const dispatch = this.#dispatch
    if (!dispatch) return
    // Normalization awaited above, so a concurrent envelope for the same
    // message may have claimed the key meanwhile: recheck and claim with no
    // await between them.
    if (this.#recentEvents.has(dedupeKey)) return
    this.#recentEvents.add(dedupeKey)
    try {
      await dispatch(chatEvent)
    } catch {
      // Only an IntakeFailedError reaches here (see start()).
      this.#recentEvents.delete(dedupeKey)
      await this.#postCouldNotStart(chatEvent)
    }
  }

  /** Posted directly, not through the outbox, which may be the part that failed. */
  async #postCouldNotStart(chatEvent: ChatEvent): Promise<void> {
    const thread = chatEvent.ref.thread ?? chatEvent.ref.message
    if (thread === undefined) return
    await this.#apiClient
      .postMessage({ channel: chatEvent.ref.channel, thread, text: 'I could not start this task, mention me again.' })
      .catch((error: unknown) => this.#log?.error({ err: error }, 'SlackAdapter: could-not-start reply failed'))
  }

  /**
   * FR-SL-2 says channel entry is only through an `@relay` mention or a
   * reply inside an existing Relay thread:
   *
   *   - A DM (channel id starting with 'D') is always accepted, mention or
   *     not, thread reply or not: a DM is inherently addressed to Relay,
   *     there is no "wrong channel" for it to have wandered into.
   *   - A channel root message (no thread_ts, or thread_ts equal to its own
   *     ts) is accepted only when it arrived on the app_mention
   *     subscription, never on the plain message subscription.
   *   - A channel thread reply (thread_ts differs from ts, channel is not a
   *     DM) is accepted only when #isKnownSession says the thread it
   *     replies in is a known Relay session, per PRE-4. This is the rule
   *     P0.2 shipped without, because recognising a Relay thread needed
   *     session storage that did not exist yet; that storage exists now
   *     (src/sessions/store.ts), so this asks it rather than refusing every
   *     thread reply outright.
   *
   * #isKnownSession defaults to always false (see SlackAdapterOptions), so
   * with no predicate injected this behaves exactly like P0.2: every
   * channel thread reply is ignored. It is called only for this third case,
   * never for a DM or a channel root mention, both because those are
   * already decided without it and because each call is a database round
   * trip on the inbound path.
   *
   * Getting the "known" side of this wrong is the blocker P0.2's gate
   * caught: an unrelated channel thread accepted here drives the operator's
   * computer from ordinary office chat. That is why #isKnownSession's
   * default refuses rather than accepts, and why the round trip between
   * composeThreadRef's two call sites (a reply's thread_ts here, a root
   * message's own ts wherever a session is created) is tested explicitly
   * rather than assumed: composing the wrong ref for one side would silently
   * fail every lookup forever, which reads identically to "ignored" and
   * would never surface as an error.
   *
   * A THROWING OR SLOW #isKnownSession, per Task 8. Task 3 shipped this
   * predicate as a fixed boolean in every test; Task 8 wires it to a real
   * database query on the inbound path (src/orchestrator.ts), so a thrown
   * error (a dropped connection, a query timeout) and a slow answer both
   * become real, reachable outcomes rather than a theoretical concern. The
   * call below is wrapped so a throw is caught, logged, and treated as "not
   * known", the same fail closed direction the default already takes: it
   * never reaches #handleRawEnvelope as an uncaught rejection, which would
   * otherwise skip claiming the dedupe key for this envelope (harmless on
   * its own) but could also propagate out of the Bolt listener with nothing
   * in this class catching it, depending on how forgiving the caller is. A
   * slow #isKnownSession is not specially bounded here: this call is simply
   * awaited normally, so the only cost is this one envelope taking longer
   * to resolve, never a wedge in #recentEvents or in any other envelope's
   * own independent handling.
   */
  async #isChannelEntryAllowed(event: SlackRawEvent, channel: string, ts: string, eventType: string): Promise<boolean> {
    if (channel.startsWith('D')) return true

    const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : undefined
    const isThreadReply = threadTs !== undefined && threadTs !== ts
    if (!isThreadReply) return eventType === 'app_mention'
    if (this.#acceptThreadMentions && eventType === 'app_mention') return true

    try {
      return await this.#isKnownSession(composeThreadRef(channel, threadTs))
    } catch (error) {
      this.#log?.error(
        { err: error },
        'SlackAdapter: isKnownSession threw; refusing this thread reply (fail closed) rather than crashing the listener',
      )
      return false
    }
  }

  /**
   * True for the app's own messages and any bot message, per the explicit
   * requirement that Relay must never loop on itself in a real workspace.
   * `bot_id` is present on every message a bot (including this one) posts;
   * `subtype === 'bot_message'` covers the same case on older event shapes;
   * comparing `user` against the bot's own user id (learned once via
   * auth.test in `create`) catches it even on a shape that carries neither.
   *
   * `file_share` is deliberately not in IGNORED_MESSAGE_SUBTYPES (a real
   * person sharing a file is a genuine way to address Relay), which makes
   * its self-loop guard worth calling out explicitly: per @slack/types'
   * FileShareMessageEvent, the type @slack/bolt itself ships for this
   * subtype, a file_share event never carries `bot_id` at all, only a
   * required `user`. When Relay uploads its own file, Slack reports it the
   * same way it reports any other message this bot posted: `user` set to
   * the bot's own user id. So the `user === botUserId` check below, the
   * last line in this function, is what has to catch a self-authored
   * file_share; there is no `bot_id` for it to ever match on. See the
   * "ignores a bot-authored file_share" test in adapter.test.ts.
   */
  #shouldIgnore(event: SlackRawEvent): boolean {
    if (typeof event.bot_id === 'string' && event.bot_id.length > 0) return true
    if (event.subtype === 'bot_message') return true
    if (typeof event.subtype === 'string' && IGNORED_MESSAGE_SUBTYPES.has(event.subtype)) return true
    if (typeof event.user === 'string' && event.user === this.#botUserId) return true
    return false
  }

  /**
   * `channel` starting with 'D' is Slack's own encoding of a DM channel id;
   * that plus whether `thread_ts` names a different message than `ts`
   * itself is enough to place every inbound event into exactly one of the
   * three shapes FR-SL-2 names. A thread reply always resolves to
   * 'thread_reply' regardless of whether it happened in a DM or a channel:
   * the ref carries `thread` and `message` either way. A mention and a DM
   * are otherwise indistinguishable at the ChatEventKind level (both
   * 'message'); the channel id in ref.channel is what tells them apart.
   *
   * `message` is always set to this event's own `ts`, thread reply or not.
   * Per FR-SL-3 the reply thread IS the session, and a caller can only start
   * one from a ref that names the message it is replying to; dropping `ts`
   * on a fresh DM or mention (the old two-branch form) left a caller with
   * nothing to thread from, so the very first reply landed at the channel
   * root instead of opening a thread. `sessionRefFor` in contract.ts is the
   * one place that turns this ref into "where the reply goes."
   */
  async #buildChatEvent(event: SlackRawEvent, channel: string, ts: string): Promise<ChatEvent> {
    const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : undefined
    const isThreadReply = threadTs !== undefined && threadTs !== ts
    const kind: ChatEventKind = isThreadReply ? 'thread_reply' : 'message'
    const ref: ChatRef = isThreadReply && threadTs !== undefined ? { channel, thread: threadTs, message: ts } : { channel, message: ts }

    const userId = typeof event.user === 'string' ? event.user : undefined
    const principalId = userId ? await this.#resolvePrincipalId(userId) : null

    return {
      kind,
      adapter: this.name,
      workspaceId: this.#workspaceId,
      platformTeamId: this.#platformTeamId,
      principalId,
      ref,
      text: wrapUntrusted(typeof event.text === 'string' ? event.text : ''),
      files: buildChatFiles(event.files),
      raw: wrapUntrusted(event),
      receivedAt: new Date().toISOString(),
      mentionsBot: typeof event.text === 'string' && mentionsUser(event.text, this.#botUserId),
      platformEventId: `${channel}:${ts}`,
    }
  }

  async #deliver(handler: (event: ChatEvent) => Promise<void>, event: ChatEvent): Promise<void> {
    try {
      await handler(event)
    } catch (error) {
      this.#log?.error({ err: error }, 'SlackAdapter: inbound handler threw')
    }
  }

  /**
   * FR-ATT-5's "sessions" command: lists recent Claude Code sessions in the
   * thread the command arrived in, as a Block Kit message with one Attach
   * button per session. `channel`/`thread` are taken from chatEvent.ref,
   * per composeThreadRef's own convention (`ref.thread` for a reply,
   * `ref.message` for the message that starts a thread), and encoded into
   * each button's own value so #handleSessionAttachButton never has to
   * reconstruct them from a click envelope.
   *
   * A #listRecentSessions failure is reported into the thread rather than
   * only logged, matching #handleApprovalButton's own standard: the
   * operator asked for something and deserves to know it did not work,
   * not silence indistinguishable from Relay ignoring them.
   */
  async #handleSessionsCommand(chatEvent: ChatEvent): Promise<void> {
    const channel = chatEvent.ref.channel
    const thread = chatEvent.ref.thread ?? chatEvent.ref.message
    if (thread === undefined) {
      this.#log?.error('SlackAdapter: sessions command carried no message ref to thread from; ignoring')
      return
    }
    try {
      const sessions = await this.#listRecentSessions(MAX_LISTED_SESSIONS)
      const { text, blocks } = renderSessionList(sessions, channel, thread)
      await this.#apiClient.postMessage({ channel, thread, text, blocks })
    } catch (error) {
      this.#log?.error({ err: error }, 'SlackAdapter: listing sessions failed')
      const { text, blocks } = renderAttachFailure('could not list sessions right now')
      await this.#apiClient.postMessage({ channel, thread, text, blocks }).catch(() => {})
    }
  }

  /**
   * Handles one selection on the session picker.
   *
   * ONLY the session id travels in the payload. The thread comes from the
   * click envelope, and the working directory is re-derived from discovery
   * by that id, so a crafted payload can name neither an arbitrary thread
   * nor an arbitrary path. An undecodable value (a stale message from a
   * redeployed version, a forged payload) is ignored rather than trusted,
   * matching #handleApprovalButton's own decode failures staying silent,
   * since there is no legitimate click that produces one.
   *
   * FR-ATT-30's unmediated label is posted here, on success, the moment the
   * attachment actually takes effect: renderAttachConfirmation, not a bare
   * "done." A denied attach (`#attachThreadToSession` returning
   * `undefined`, whether because it is not wired or because the resolver
   * refused an unmapped principal) and a thrown error both report failure
   * back into the thread, the same standard #handleApprovalButton holds
   * itself to for anything past the point a channel/thread ref is known.
   */
  async #handleSessionAttachButton(envelope: SlackBlockActionEnvelope): Promise<void> {
    const action = envelope.actions[0]
    // A dropdown puts the payload in `selected_option.value`; a button puts
    // it in `value`. Both are read so the handler works whichever element
    // the list was rendered with, and an older message already in the
    // channel keeps working after the renderer changes.
    const rawValue = action?.selected_option?.value ?? action?.value
    if (!rawValue) {
      this.#log?.warn('SlackAdapter: session attach click carried no value; ignoring')
      return
    }
    const decoded = decodeSessionAttachValue(rawValue)
    if (!decoded) {
      this.#log?.error('SlackAdapter: session attach value was not a valid SessionAttachValue; ignoring')
      return
    }
    const { engineSessionId } = decoded

    // AP-2: a button's value is outside content. Slack guarantees it
    // delivered the payload, never that Relay authored it, so the only
    // fields trusted here are the ones Slack itself stamps on the click
    // envelope. Taking the channel and thread from the button's own value
    // would let a crafted payload bind ANY thread to a session, and an
    // attached session runs unmediated in the operator's own directory
    // with the operator's own permissions (§24), so that is the most
    // consequential binding in the product.
    const channel = envelope.channel?.id
    const thread = envelope.message?.ts
    if (!channel || !thread) {
      this.#log?.error('SlackAdapter: session attach click carried no channel or message ts; ignoring')
      return
    }

    try {
      // FR-CA-4: fail closed on an unmapped principal. Attaching is not a
      // read, it decides where an ungoverned engine runs, so an actor Relay
      // cannot name must never reach it.
      const principalId = await this.#resolvePrincipalId(envelope.user.id)
      if (principalId === null) {
        // Unmapped senders get no reply anywhere; the log names them for `relay principals add`.
        this.#log?.warn({ platformUserId: envelope.user.id }, 'SlackAdapter: ignored a session attach click from an unmapped principal')
        return
      }

      // The working directory is re-derived from discovery by session id
      // rather than taken from the payload, for the same reason as above:
      // it determines where a process executes. Re-deriving also handles
      // the ordinary case of a card that has sat in a thread for a week
      // whose session has since moved or been deleted, turning it into a
      // clean refusal instead of an attachment to a path that no longer
      // means what it meant when the button was drawn.
      const discovered = (await this.#listRecentSessions(MAX_LISTED_SESSIONS)).find(
        (session) => session.sessionId === engineSessionId,
      )
      if (!discovered) {
        const { text, blocks } = renderAttachFailure('that session no longer exists on this machine')
        await this.#apiClient.postMessage({ channel, thread, text, blocks })
        return
      }
      const engineCwd = discovered.cwd

      const threadRef = composeThreadRef(channel, thread)
      const result = await this.#attachThreadToSession({ threadRef, principalId, engineSessionId, engineCwd })
      if (!result) {
        const { text, blocks } = renderAttachFailure('attaching sessions is not available right now')
        await this.#apiClient.postMessage({ channel, thread, text, blocks })
        return
      }
      const { text, blocks } = renderAttachConfirmation(engineCwd)
      await this.#apiClient.postMessage({ channel, thread, text, blocks })
    } catch (error) {
      this.#log?.error({ err: error }, 'SlackAdapter: session attach handler threw')
      const { text, blocks } = renderAttachFailure('an unexpected error occurred')
      await this.#apiClient.postMessage({ channel, thread, text, blocks }).catch(() => {})
    }
  }

  /**
   * Handles one Block Kit button click on an approval card. `option` is
   * fixed per action id, decided by which of the four listeners start()
   * registered, never decoded from the payload itself, so a malformed or
   * spoofed action_id can never be routed to the wrong option.
   *
   * For 'approve' on an approval whose card declared requiresTypedConfirmation
   * (encoded into the button's own value by renderApprovalCard, so no
   * lookup is needed to know this client side), this opens the confirmation
   * modal instead of resolving directly, per FR-APR-5. For 'edit_and_approve'
   * this always opens the edit modal, since collecting free text needs a
   * modal regardless of tier. Every other case resolves immediately.
   *
   * `action()` acks the click BEFORE this method ever runs (see
   * createLiveSlackBoltApp's own `action` wiring and its doc comment: Bolt's
   * three second ack budget can be shorter than a database round trip), so
   * by the time any code here executes, Slack has already told the operator
   * their click was received. Fix round 1, finding 4: an unhandled failure
   * from this point on used to be caught and only logged, which is a
   * genuinely dangerous shape specifically for Approve/Deny, not a merely
   * unpolished one: the operator sees their click register, nothing is
   * recorded, and they have no way to tell "not resolved yet" apart from
   * "silently dropped." Decode-and-validate failures (a malformed or
   * missing payload) stay silent, because there is no channel/messageTs to
   * report into and no legitimate click produces them; everything past that
   * point, where a channel and message ref are known, reports failure back
   * into the thread via #reportResolutionFailure rather than only logging.
   */
  async #handleApprovalButton(envelope: SlackBlockActionEnvelope, option: ApprovalOption): Promise<void> {
    const action = envelope.actions[0]
    if (!action?.value) {
      this.#log?.warn({ option }, 'SlackAdapter: approval button click carried no value; ignoring')
      return
    }
    let decoded: { approvalId?: unknown; requiresTypedConfirmation?: unknown }
    try {
      decoded = JSON.parse(action.value) as { approvalId?: unknown; requiresTypedConfirmation?: unknown }
    } catch (error) {
      this.#log?.error({ err: error, option }, 'SlackAdapter: approval button value was not valid JSON; ignoring')
      return
    }
    if (typeof decoded.approvalId !== 'string') {
      this.#log?.error({ option }, 'SlackAdapter: approval button value carried no approvalId; ignoring')
      return
    }
    const channel = envelope.channel?.id
    const messageTs = envelope.message?.ts
    if (!channel || !messageTs) {
      this.#log?.error({ option }, 'SlackAdapter: approval button click carried no channel/message ref; ignoring')
      return
    }

    // From here on, channel and messageTs are known, so any failure is
    // reported back into the thread rather than only logged; see this
    // method's own doc comment.
    try {
      const needsModal =
        (option === 'approve' && decoded.requiresTypedConfirmation === true) || option === 'edit_and_approve'
      if (needsModal) {
        if (!this.capabilities.modals) {
          this.#log?.error(
            { option, approvalId: decoded.approvalId },
            'SlackAdapter: this action requires a modal but modals capability is false; refusing rather than ' +
              'bypassing the safeguard it exists to enforce',
          )
          await this.#reportResolutionFailure(channel, messageTs, option)
          return
        }
        if (!envelope.trigger_id) {
          this.#log?.error(
            { option },
            'SlackAdapter: approval button click carried no trigger_id, cannot open a modal; ignoring',
          )
          await this.#reportResolutionFailure(channel, messageTs, option)
          return
        }
        const meta: ModalMetadata = { approvalId: decoded.approvalId, channel, messageTs }
        const view = option === 'edit_and_approve' ? renderEditModal(meta) : renderConfirmationModal(meta)
        await this.#apiClient.openModal({ triggerId: envelope.trigger_id, view })
        return
      }

      await this.#resolveAndRenderCard({
        approvalId: decoded.approvalId,
        option,
        resolverPlatformUserId: envelope.user.id,
        channel,
        messageTs,
      })
    } catch (error) {
      this.#log?.error({ err: error, option }, 'SlackAdapter: approval button handler threw')
      await this.#reportResolutionFailure(channel, messageTs, option)
    }
  }

  /**
   * FR-APR-5's confirmation modal submission: validates the typed word
   * before resolving. A mismatch or a missing value keeps the modal open
   * with an inline error (Slack's `response_action: 'errors'`) rather than
   * silently closing on a wrong answer, per confirmationMismatchError's own
   * doc comment.
   *
   * Fix round 1, finding 4: this method must never resolve with `undefined`
   * ("accept, close the modal") for anything other than a genuine terminal
   * outcome (resolved, or a known non-resolving outcome that already has
   * its own visible handling). An unwired resolver or an unexpected
   * internal error used to fall through to a plain `undefined`, which
   * closes the modal exactly as if the decision had been recorded; both now
   * keep the modal open with a truthful "not recorded" error instead. This
   * is what actually closes the "unacked view() hangs" class of bug: this
   * method is the ONE thing createLiveSlackBoltApp's `view` wiring ever
   * awaits before it can call `ack()` at all, and it never throws (both
   * branches below return a value, they do not rethrow), so `ack()` is
   * always reached with a real response to give Slack, live wiring or not.
   */
  async #handleConfirmModalSubmission(envelope: SlackViewSubmissionEnvelope): Promise<SlackViewSubmissionResponse> {
    let meta: ModalMetadata
    try {
      meta = parseModalMetadata(envelope.view.private_metadata)
    } catch (error) {
      // No channel/messageTs to report into at all: a malformed
      // private_metadata means this is not a modal this adapter ever
      // opened, an adversarial or corrupted payload, not a legitimate
      // operator flow. Logging is the honest ceiling here.
      this.#log?.error({ err: error }, 'SlackAdapter: confirmation modal submission carried malformed private_metadata')
      return undefined
    }

    try {
      const typed = envelope.view.state.values[CONFIRM_MODAL_BLOCK_ID]?.[CONFIRM_MODAL_ACTION_ID]?.value ?? undefined

      const resolverPrincipalId = await this.#resolvePrincipalId(envelope.user.id)
      const result = await this.#resolveApprovalInteraction({
        approvalId: meta.approvalId,
        option: 'approve',
        resolverPlatformUserId: envelope.user.id,
        resolverPrincipalId,
        // Conditionally spread, not `typedConfirmation: typed`: same
        // exactOptionalPropertyTypes reasoning as createLiveSlackBoltApp's
        // `action` wiring above.
        ...(typed !== undefined ? { typedConfirmation: typed } : {}),
      })

      if (!result) {
        this.#log?.warn(
          { approvalId: meta.approvalId },
          'SlackAdapter: no approval resolver is wired; ignoring modal submission',
        )
        return { response_action: 'errors', errors: this.#internalErrorResponse(CONFIRM_MODAL_CALLBACK_ID) }
      }
      if (result.outcome === 'confirmation_required' || result.outcome === 'confirmation_mismatch') {
        return { response_action: 'errors', errors: confirmationMismatchError() }
      }
      if (result.outcome === 'resolved') {
        if (!result.approval) {
          this.#log?.error(
            { approvalId: meta.approvalId },
            'SlackAdapter: resolveApproval returned resolved with no approval row, which should be unreachable',
          )
          return { response_action: 'errors', errors: this.#internalErrorResponse(CONFIRM_MODAL_CALLBACK_ID) }
        }
        await this.#renderResolvedApprovalCard(result.approval, meta.channel, meta.messageTs, envelope.user.id)
        return undefined
      }
      if (result.outcome === 'invalid_input') {
        // Fix round 2: `invalid_input` names an edit-and-approve outcome,
        // and this modal only ever submits option 'approve' (see the
        // resolveApprovalInteraction call above); resolveApproval's own
        // edit_and_approve branch is the only place that outcome comes
        // from. Reaching it here should be unreachable, and treating it as
        // an ordinary generic outcome would have rendered the EDIT modal's
        // "could not validate this as JSON" wording for an operator who
        // typed a confirmation phrase, not JSON, which is exactly the
        // wrong-surface-wording bug this branch exists to rule out.
        this.#log?.error(
          { approvalId: meta.approvalId },
          'SlackAdapter: confirmation modal submission produced invalid_input, which should be unreachable for an approve-only resolution',
        )
        return { response_action: 'errors', errors: this.#internalErrorResponse(CONFIRM_MODAL_CALLBACK_ID) }
      }
      // Every remaining outcome (not_found, already_resolved, expired,
      // unauthorized) used to fall through to a bare log line, closing the
      // modal as if the decision had been recorded, per fix round 1.
      // GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS's narrower type (fix round
      // 2) is what actually enforces this branch excludes every
      // context-specific outcome first: indexing it with `result.outcome`
      // only compiles once TypeScript has narrowed that type down to
      // exactly these four, which the three branches above (and 'resolved'
      // further up) are what do that narrowing.
      this.#log?.info(
        { approvalId: meta.approvalId, outcome: result.outcome },
        'SlackAdapter: confirmation modal submission did not resolve',
      )
      return {
        response_action: 'errors',
        errors: { [CONFIRM_MODAL_BLOCK_ID]: GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS[result.outcome] },
      }
    } catch (error) {
      this.#log?.error({ err: error }, 'SlackAdapter: confirmation modal handler threw')
      return { response_action: 'errors', errors: this.#internalErrorResponse(CONFIRM_MODAL_CALLBACK_ID) }
    }
  }

  /**
   * FR-APR-2's edit-and-approve modal submission: collects the operator's
   * JSON-text replacement and resolves with it. `invalid_input` (the edited
   * value failed the capability's own schema, per
   * src/approvals/store.ts's resolveApproval) keeps the modal open with
   * editValidationError's inline message, the same non-closing shape
   * confirmationMismatchError already uses. See
   * #handleConfirmModalSubmission's own doc comment for why this method
   * also never resolves `undefined` on an unwired resolver or an internal
   * error.
   */
  async #handleEditModalSubmission(envelope: SlackViewSubmissionEnvelope): Promise<SlackViewSubmissionResponse> {
    let meta: ModalMetadata
    try {
      meta = parseModalMetadata(envelope.view.private_metadata)
    } catch (error) {
      this.#log?.error({ err: error }, 'SlackAdapter: edit modal submission carried malformed private_metadata')
      return undefined
    }

    try {
      const edited = envelope.view.state.values[EDIT_MODAL_BLOCK_ID]?.[EDIT_MODAL_ACTION_ID]?.value ?? ''

      const resolverPrincipalId = await this.#resolvePrincipalId(envelope.user.id)
      const result = await this.#resolveApprovalInteraction({
        approvalId: meta.approvalId,
        option: 'edit_and_approve',
        resolverPlatformUserId: envelope.user.id,
        resolverPrincipalId,
        editedArguments: edited,
      })

      if (!result) {
        this.#log?.warn(
          { approvalId: meta.approvalId },
          'SlackAdapter: no approval resolver is wired; ignoring modal submission',
        )
        return { response_action: 'errors', errors: this.#internalErrorResponse(EDIT_MODAL_CALLBACK_ID) }
      }
      if (result.outcome === 'invalid_input') {
        return { response_action: 'errors', errors: editValidationError() }
      }
      if (result.outcome === 'resolved') {
        if (!result.approval) {
          this.#log?.error(
            { approvalId: meta.approvalId },
            'SlackAdapter: resolveApproval returned resolved with no approval row, which should be unreachable',
          )
          return { response_action: 'errors', errors: this.#internalErrorResponse(EDIT_MODAL_CALLBACK_ID) }
        }
        await this.#renderResolvedApprovalCard(result.approval, meta.channel, meta.messageTs, envelope.user.id)
        return undefined
      }
      if (result.outcome === 'confirmation_required' || result.outcome === 'confirmation_mismatch') {
        // Fix round 2: the mirror image of #handleConfirmModalSubmission's
        // own invalid_input guard. resolveApproval only ever gates typed
        // confirmation for option 'approve' (see its own doc comment), and
        // this modal always submits 'edit_and_approve', so either
        // confirmation outcome here should be unreachable; treating it as
        // generic would have rendered neither the confirmation wording nor
        // anything about the edited JSON, just whichever text happened to
        // sit at that key, which is not an honest description of what the
        // operator just did.
        this.#log?.error(
          { approvalId: meta.approvalId, outcome: result.outcome },
          'SlackAdapter: edit modal submission produced a confirmation outcome, which should be unreachable for an edit-and-approve resolution',
        )
        return { response_action: 'errors', errors: this.#internalErrorResponse(EDIT_MODAL_CALLBACK_ID) }
      }
      // Same exhaustive, narrowed fallback as #handleConfirmModalSubmission's own; see its comment.
      this.#log?.info(
        { approvalId: meta.approvalId, outcome: result.outcome },
        'SlackAdapter: edit modal submission did not resolve',
      )
      return {
        response_action: 'errors',
        errors: { [EDIT_MODAL_BLOCK_ID]: GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS[result.outcome] },
      }
    } catch (error) {
      this.#log?.error({ err: error }, 'SlackAdapter: edit modal handler threw')
      return { response_action: 'errors', errors: this.#internalErrorResponse(EDIT_MODAL_CALLBACK_ID) }
    }
  }

  /**
   * The block id a modal's own inline error should attach to, keyed by
   * which modal's callback id is currently open: Slack's `response_action:
   * 'errors'` contract requires the key to name a real block in the
   * CURRENTLY OPEN view, so a generic "something went wrong" message still
   * has to be addressed to the right block or Slack rejects the ack itself.
   */
  #internalErrorResponse(callbackId: string): Record<string, string> {
    const blockId = callbackId === EDIT_MODAL_CALLBACK_ID ? EDIT_MODAL_BLOCK_ID : CONFIRM_MODAL_BLOCK_ID
    return { [blockId]: 'Something went wrong recording this decision. Your decision was not recorded; please try again.' }
  }

  /**
   * Posts a threaded reply stating that a button-click resolution did not
   * happen, per fix round 1: the ONE place #handleApprovalButton's own
   * failure paths (an unwired resolver, a modal that could not be opened,
   * an unexpected throw) reach, so a click that fails never looks
   * indistinguishable from one that quietly succeeded. Threaded off the
   * approval card's own message (`thread: messageTs`), not a bare channel
   * post, so it reads as attached to the card it is about, and best-effort:
   * a failure reporting the failure is logged, not thrown, since there is
   * no further fallback surface left to report THAT to.
   */
  async #reportResolutionFailure(channel: string, messageTs: string, option: ApprovalOption): Promise<void> {
    await this.#postThreadNotice(
      channel,
      messageTs,
      `Your "${option}" could not be recorded due to an internal error. ` +
        'The approval is still pending; please try again.',
    )
  }

  /**
   * Reports a known, non-'resolved' store outcome (not_found,
   * already_resolved, expired, or unauthorized; the confirmation/edit
   * outcomes have their own dedicated modal handling and never reach a
   * button-click caller of this method) back into the thread. Fix round 1:
   * these four used to produce only a log line, indistinguishable from the
   * operator's own eyes from a click that was still silently in flight.
   * expired and already_resolved in particular are easy to conflate ("you
   * were too late" vs. "someone else already answered"), which is exactly
   * why each gets its own wording from UNRESOLVED_OUTCOME_DESCRIPTIONS
   * rather than one generic "did not work" message.
   */
  async #reportOutcome(channel: string, messageTs: string, outcome: Exclude<ResolveOutcome, 'resolved'>): Promise<void> {
    await this.#postThreadNotice(channel, messageTs, UNRESOLVED_OUTCOME_DESCRIPTIONS[outcome])
  }

  /** Shared by #reportResolutionFailure and #reportOutcome: posts `text` threaded off the approval card's own message, best-effort (a failure here is logged, not thrown, since there is no further fallback surface left to report THAT to). */
  async #postThreadNotice(channel: string, messageTs: string, text: string): Promise<void> {
    try {
      await this.#callApi(() => this.#apiClient.postMessage({ channel, thread: messageTs, text }))
    } catch (error) {
      this.#log?.error({ err: error }, 'SlackAdapter: failed to post an approval status notice back to the thread')
    }
  }

  /**
   * The shared "resolve directly, then update the card" path for deny,
   * plain approve, and approve-all-session: none of these need a modal,
   * per #handleApprovalButton's own needsModal check. Throws are left to
   * propagate to #handleApprovalButton's own try/catch, which is what
   * reports failure back into the thread; an unwired resolver is not a
   * throw, so it is reported here directly instead, per fix round 1.
   */
  async #resolveAndRenderCard(params: {
    approvalId: string
    option: ApprovalOption
    resolverPlatformUserId: string
    channel: string
    messageTs: string
  }): Promise<void> {
    const resolverPrincipalId = await this.#resolvePrincipalId(params.resolverPlatformUserId)
    const result = await this.#resolveApprovalInteraction({
      approvalId: params.approvalId,
      option: params.option,
      resolverPlatformUserId: params.resolverPlatformUserId,
      resolverPrincipalId,
    })

    if (!result) {
      this.#log?.warn(
        { approvalId: params.approvalId },
        'SlackAdapter: no approval resolver is wired; ignoring interaction',
      )
      await this.#reportResolutionFailure(params.channel, params.messageTs, params.option)
      return
    }
    if (result.outcome === 'resolved') {
      if (!result.approval) {
        // Should be impossible: resolveApproval's own contract only omits
        // `approval` for 'not_found'. Reported the same way an internal
        // failure is, rather than silently doing nothing, if it ever
        // happens anyway.
        this.#log?.error(
          { approvalId: params.approvalId },
          'SlackAdapter: resolveApproval returned resolved with no approval row, which should be unreachable',
        )
        await this.#reportResolutionFailure(params.channel, params.messageTs, params.option)
        return
      }
      await this.#renderResolvedApprovalCard(result.approval, params.channel, params.messageTs, params.resolverPlatformUserId)
      return
    }
    if (result.outcome === 'invalid_input') {
      // Fix round 2: unreachable in practice. This path only ever resolves
      // 'deny', 'approve' (with the button's own value already having
      // established requiresTypedConfirmation is false), or
      // 'approve_all_session' (see #handleApprovalButton's needsModal
      // check, which sends 'edit_and_approve' to a modal unconditionally,
      // never here). resolveApproval only ever returns invalid_input for
      // option 'edit_and_approve'.
      this.#log?.error(
        { approvalId: params.approvalId },
        'SlackAdapter: button-click resolution produced invalid_input, which should be unreachable outside edit_and_approve',
      )
      await this.#reportResolutionFailure(params.channel, params.messageTs, params.option)
      return
    }
    if (result.outcome === 'confirmation_required' || result.outcome === 'confirmation_mismatch') {
      // Fix round 2, a deliberate decision, not a side effect: this path
      // is entered when the button's OWN encoded value said
      // requiresTypedConfirmation is false (see #handleApprovalButton's
      // needsModal check), so under normal operation resolveApproval
      // should never disagree, since that field is fixed at approval
      // creation and never changes afterward. It CAN still happen if a
      // caller renders a stale or mismatched card. Rather than silently
      // doing nothing on that mismatch (the pre-fix-round-1 behaviour this
      // whole class of finding is about), this posts the same wording the
      // confirmation modal itself would show. The text is accurate
      // regardless of which surface displays it ("type CONFIRM to
      // approve" is true whether read in a modal or a thread reply), so
      // this is not the wrong-surface-wording bug the invalid_input branch
      // above guards against; it is a legitimate fallback for a state that
      // should not arise, kept visible rather than silent. Tested
      // explicitly in test/chat/slack/adapter.test.ts.
      this.#log?.warn(
        { approvalId: params.approvalId, outcome: result.outcome },
        'SlackAdapter: button-click resolution required typed confirmation the button itself did not request; reporting rather than silently dropping',
      )
      await this.#reportOutcome(params.channel, params.messageTs, result.outcome)
      return
    }
    this.#log?.info(
      { approvalId: params.approvalId, outcome: result.outcome },
      'SlackAdapter: approval interaction did not resolve',
    )
    await this.#postThreadNotice(params.channel, params.messageTs, GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS[result.outcome])
  }

  /**
   * Replaces a resolved approval's card in place, per FR-SL-5: the card
   * must stop looking pending the moment it is acted on. Bypasses the
   * ChatAction contract (src/chat/contract.ts's 'edit' carries text only,
   * no blocks) and calls the Slack API client directly, since Block Kit
   * rendering is specific to this file's own approval handling, not
   * something the platform-neutral contract supports yet; see
   * SlackUpdateMessageArgs's own doc comment.
   */
  async #renderResolvedApprovalCard(
    approval: Approval,
    channel: string,
    messageTs: string,
    resolverPlatformUserId: string,
  ): Promise<void> {
    if (!approval.selectedOption) return
    const card = renderResolvedCard({
      approvalId: approval.id,
      capability: approval.capability,
      description: approval.description,
      target: approval.target,
      tier: approval.tier,
      escalationReason: approval.escalationReason,
      runId: approval.runId,
      sessionId: approval.sessionId,
      // The card only has the requester's Relay principal id available here,
      // not a nice display name: that lookup belongs to whoever posts the
      // ORIGINAL card (a later wiring task, per this file's own
      // resolveApprovalInteraction doc comment), which has the display name
      // to hand already. resolverDisplayName below is different: it comes
      // straight from this interaction's own Slack payload, so it can be a
      // real mention.
      requesterDisplayName: approval.requesterPrincipalId,
      requiresTypedConfirmation: approval.requiresTypedConfirmation,
      status: approval.status,
      selectedOption: approval.selectedOption,
      resolverDisplayName: `<@${resolverPlatformUserId}>`,
      resolvedAtIso: approval.resolvedAt ?? new Date().toISOString(),
      editedArguments: approval.editedArguments,
    })
    await this.#callApi(() =>
      this.#apiClient.updateMessage({ channel, ts: messageTs, text: card.text, blocks: card.blocks }),
    )
  }

  /**
   * Waits for the current #deliveryQueue to settle, up to `timeoutMs`.
   * Never rejects, and never keeps the event loop alive on its own: the
   * timer is cleared as soon as the queue settles, so a fast shutdown does
   * not sit waiting on a pending timer it no longer needs.
   */
  async #settleDeliveryQueue(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), timeoutMs)
    })
    try {
      const outcome = await Promise.race([
        this.#deliveryQueue.then(() => 'settled' as const),
        timedOut,
      ])
      if (outcome === 'timed-out') {
        this.#log?.warn(
          { timeoutMs },
          'SlackAdapter: inbound delivery queue did not settle within the bounded wait; stopping anyway',
        )
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
