/**
 * Slack over Socket Mode. This is the one file in the milestone that talks
 * to Slack: everything else works against the platform neutral contract in
 * src/chat/contract.ts. Two seams keep it testable without a workspace:
 * `SlackBoltApp` stands in for a real `@slack/bolt` App (event ingestion),
 * and `SlackApiClient` stands in for a real `@slack/web-api` WebClient
 * (outbound calls). Production code builds both from real Slack packages in
 * createLiveSlackBoltApp and createLiveSlackApiClient (api-client.ts); test/chat/slack/
 * adapter.test.ts wires SlackAdapter to hand written stubs instead, so
 * runChatAdapterConformance proves the contract with no network at all.
 */
import { unwrapForAudit, wrapUntrusted } from '../../agent/untrusted.js'
import type { Untrusted } from '../../agent/untrusted.js'
import type { Logger } from '../../obs/logger.js'
import type { SecretProvider } from '../../secrets/provider.js'
import type {
  AdapterCapabilities,
  ChatAction,
  ChatActionResult,
  ChatAdapter,
  ChatEvent,
  ChatEventKind,
  ChatRef,
} from '../contract.js'
import { IntakeFailedError, isStopInstruction } from '../contract.js'
import { APPROVAL_ACTION_IDS, CONFIRM_MODAL_CALLBACK_ID, EDIT_MODAL_CALLBACK_ID } from '../../approvals/blockkit.js'
import type { SlackBlock } from '../../approvals/blockkit.js'
import { handleSessionAttachButton, handleSessionsCommand, SESSION_ATTACH_ACTION_ID } from './session-attach.js'
import type { SessionAttachContext } from './session-attach.js'
import { DIRECT_COMMAND_WORD } from '../../live/session-mode.js'
import {
  classifyTransportError,
  createLiveSlackApiClient,
  createLiveSlackBoltApp,
  isRateLimitedError,
  mentionsUser,
  readRequiredSecret,
} from './api-client.js'
import { handleApprovalButton, handleConfirmModalSubmission, handleEditModalSubmission } from './approval-interactions.js'
import type { ApprovalInteractionContext } from './approval-interactions.js'
import { buildChatFiles, composeThreadRef, IGNORED_MESSAGE_SUBTYPES, RecentEventWindow } from './events.js'
import type {
  DirectCommandRequest,
  SlackAdapterCreateOptions,
  SlackAdapterDeps,
  SlackApiClient,
  SlackBlockActionEnvelope,
  SlackBoltApp,
  SlackEventEnvelope,
  SlackEventListener,
  SlackRawEvent,
} from './types.js'
import { TEAM_PROPOSAL_ACTION_IDS, type TeamProposalDecision } from './team-proposal-card.js'

/** Slack's cumulative limit for markdown blocks in one message; a longer agent post goes out as plain text. */
export const MARKDOWN_BLOCK_MAX_CHARS = 12_000

/** The markdown block an agent's Markdown post or edit carries, with `text` as the fallback; none when plain or too long. */
function markdownBlocks(action: { text: string; markdown?: true }): { blocks?: SlackBlock[] } {
  return action.markdown === true && action.text.length <= MARKDOWN_BLOCK_MAX_CHARS ? { blocks: [{ type: 'markdown', text: action.text }] } : {}
}

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
export const SLACK_MAX_MESSAGE_BYTES = 40_000

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
/** A message's text without mentions of the bot, so "@Relay sessions" in a channel reads as "sessions", as it does in a DM. */
function withoutBotMention(text: Untrusted<string>, botUserId: string): string {
  return unwrapForAudit(text).split(`<@${botUserId}>`).join(' ').replace(new RegExp(`<@${botUserId}\\|[^>]*>`, 'g'), ' ').trim()
}

function isSessionsCommand(command: string): boolean {
  return command.toLowerCase() === SESSIONS_COMMAND_TEXT
}

/** For "direct [directory] [message]", what follows the word ('' for a bare "direct"); undefined for any other message. */
function directCommandArguments(command: string): string | undefined {
  const [first = '', ...rest] = command.split(/\s+/)
  if (first.toLowerCase() !== DIRECT_COMMAND_WORD) return undefined
  return rest.join(' ')
}
/**
 * Bounds how long stop() waits for already-queued inbound deliveries to
 * settle before stopping Bolt anyway. Matches SHUTDOWN_SETTLE_TIMEOUT_MS in
 * src/orchestrator.ts: by the time that caller reaches dispatcher.stop() it
 * has already spent its own bounded wait on the same in-flight work, so
 * this is a backstop for a direct SlackAdapter user, not the primary bound.
 */
const STOP_DELIVERY_SETTLE_TIMEOUT_MS = 15_000

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
  readonly #onDirectCommand: (request: DirectCommandRequest) => Promise<void>
  readonly #sleep: (ms: number) => Promise<void>
  readonly #maxRateLimitRetries: number
  readonly #log: Logger | undefined
  readonly #recentEvents = new RecentEventWindow(DEDUPE_WINDOW_SIZE)
  readonly #approvalContext: ApprovalInteractionContext
  readonly #sessionAttachContext: SessionAttachContext

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
    this.#onDirectCommand = deps.onDirectCommand
    this.#sleep = deps.sleep
    this.#maxRateLimitRetries = deps.maxRateLimitRetries
    this.#log = deps.log
    this.#approvalContext = {
      apiClient: deps.apiClient,
      capabilities: deps.capabilities,
      callApi: <T>(call: () => Promise<T>) => this.#callApi(call),
      resolvePrincipalId: deps.resolvePrincipalId,
      resolveApprovalInteraction: deps.resolveApprovalInteraction,
      log: deps.log,
    }
    this.#sessionAttachContext = {
      apiClient: deps.apiClient,
      resolvePrincipalId: deps.resolvePrincipalId,
      isOwner: deps.isOwner,
      listRecentSessions: deps.listRecentSessions,
      attachThreadToSession: deps.attachThreadToSession,
      log: deps.log,
    }
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
      isOwner: options.isOwner ?? (async () => false),
      isKnownSession: options.isKnownSession ?? (async () => false),
      acceptThreadMentions: options.acceptThreadMentions ?? false,
      resolveApprovalInteraction: options.resolveApprovalInteraction ?? (async () => undefined),
      listRecentSessions: options.listRecentSessions ?? (async () => []),
      // Refuses rather than silently doing nothing when no handler is
      // wired: a command that is accepted and then ignored is the worst of both.
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
      await handleApprovalButton(this.#approvalContext, envelope, 'approve')
    })
    this.#boltApp.action(APPROVAL_ACTION_IDS.deny, async (envelope) => {
      await handleApprovalButton(this.#approvalContext, envelope, 'deny')
    })
    this.#boltApp.action(APPROVAL_ACTION_IDS.approveAllSession, async (envelope) => {
      await handleApprovalButton(this.#approvalContext, envelope, 'approve_all_session')
    })
    this.#boltApp.action(APPROVAL_ACTION_IDS.editAndApprove, async (envelope) => {
      await handleApprovalButton(this.#approvalContext, envelope, 'edit_and_approve')
    })
    this.#boltApp.view(CONFIRM_MODAL_CALLBACK_ID, (envelope) => handleConfirmModalSubmission(this.#approvalContext, envelope))
    this.#boltApp.view(EDIT_MODAL_CALLBACK_ID, (envelope) => handleEditModalSubmission(this.#approvalContext, envelope))

    // FR-ATT-5's session picker button, one fixed action id shared by every
    // row (which session was picked travels in that row's own button
    // value, per SESSION_ATTACH_ACTION_ID's own doc comment), same
    // deliberate bypass of #deliveryQueue/#dispatch as the approval
    // buttons above, for the same reason.
    this.#boltApp.action(SESSION_ATTACH_ACTION_ID, async (envelope) => {
      await handleSessionAttachButton(this.#sessionAttachContext, envelope)
    })

    await this.#boltApp.start()
    this.#started = true
  }

  /** The team proposal card's Approve and Reject (src/chat/slack/team-proposal-card.ts); the handler catches its own errors. */
  onTeamProposalClick(handler: (envelope: SlackBlockActionEnvelope, decision: TeamProposalDecision) => Promise<unknown>): void {
    for (const decision of ['approve', 'reject'] as const) this.#boltApp.action(TEAM_PROPOSAL_ACTION_IDS[decision], async (envelope) => void (await handler(envelope, decision)))
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
          ...(action.kind === 'post' ? markdownBlocks(action) : {}),
        }),
      )
      const ref: ChatRef = { channel: result.channel ?? action.ref.channel, message: result.ts }
      if (action.ref.thread !== undefined) ref.thread = action.ref.thread
      return { ref }
    }

    if (action.kind === 'edit') {
      await this.#callApi(() =>
        this.#apiClient.updateMessage({ channel: action.ref.channel, ts: action.ref.message, text: action.text, ...markdownBlocks(action) }),
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
    const command = withoutBotMention(chatEvent.text, this.#botUserId)
    if (isSessionsCommand(command)) {
      this.#recentEvents.add(dedupeKey)
      await handleSessionsCommand(this.#sessionAttachContext, chatEvent, typeof event.user === 'string' ? event.user : undefined)
      return
    }

    // FR-ATT-30's "direct", only on a message that starts a thread: inside
    // an existing thread the same words are part of that thread's task.
    const directArguments = chatEvent.kind === 'message' ? directCommandArguments(command) : undefined
    if (directArguments !== undefined) {
      this.#recentEvents.add(dedupeKey)
      if (typeof event.user !== 'string') return
      await this.#handleDirectCommand(chatEvent.ref.channel, ts, event.user, directArguments)
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

  /** Starts a direct session in the thread of the message that asked for it; the owner check is the handler's. */
  async #handleDirectCommand(channel: string, thread: string, userId: string, text: string): Promise<void> {
    const post = (message: string) => this.#apiClient.postMessage({ channel, thread, text: message })
    try {
      await this.#onDirectCommand({ channelId: channel, userId, text, thread, post })
    } catch (error) {
      this.#log?.error({ err: error }, 'SlackAdapter: direct failed')
      await post('Could not start a direct session. Check `relay doctor`.').catch(() => {})
    }
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
