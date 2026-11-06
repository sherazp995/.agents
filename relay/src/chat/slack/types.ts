/**
 * The Slack adapter's types: the two seams (SlackBoltApp inbound,
 * SlackApiClient outbound), the event, action and view envelopes their
 * listeners receive, and the SlackAdapter options and dependencies. See
 * adapter.ts's own header for how the seams keep the adapter testable.
 */
import type { SlackBlock } from '../../approvals/blockkit.js'
import type { ApprovalOption, ResolveApprovalResult } from '../../approvals/store.js'
import type { Logger } from '../../obs/logger.js'
import type { EngineSession } from '../../sessions/discovery.js'
import type { AdapterCapabilities } from '../contract.js'
import type { AttachThreadToSessionParams, AttachThreadToSessionResult } from './session-attach.js'
import type { ReminderChannels } from './reminder.js'

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
  /** The clicked message; `thread_ts` is set when it is a reply in a thread, as the session picker always is. */
  message?: { ts: string; thread_ts?: string }
  trigger_id?: string
}
export type SlackActionListener = (envelope: SlackBlockActionEnvelope) => Promise<void>

/**
 * A Block Kit modal submission (`view_submission`), per FR-APR-5's typed
 * confirmation and FR-APR-2's edit-and-approve. `state.values` is keyed by
 * block id then action id, matching how Slack itself shapes a submitted
 * view's collected input; src/approvals/blockkit.ts's exported block/action
 * id constants are what the adapter reads out of it.
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
  start(): Promise<unknown>
  stop(): Promise<void>
}

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
 * anything the adapter needs, since the modal's own eventual view_submission
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

/**
 * What a Block Kit approval interaction, decoded, hands to the injected
 * resolver: everything src/approvals/store.ts's resolveApproval needs
 * except `workspaceId` (this adapter always knows its own) and
 * `sessionGrantTtlMs`/`now` (the resolver's own concern, not the
 * interaction's). `resolverPrincipalId` is resolved the same way every
 * other inbound identity in the adapter is, through `resolvePrincipalId`,
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

/** A "direct [directory] [message]" message: `thread` is the message's own thread, where the session's replies go. */
export type DirectCommandRequest = {
  channelId: string
  userId: string
  text: string
  thread: string
  post: (text: string) => Promise<{ ts: string }>
}

export type SlackAdapterOptions = {
  log?: Logger
  /** Maps a Slack user id to a Relay principal id, per FR-CA-4. Defaults to always-null (unmapped, fail closed), because SlackAdapter itself has no database dependency; a caller that wants real mapping passes principals.ts's resolvePrincipal bound to its own pool and workspace. */
  resolvePrincipalId?: (platformUserId: string) => Promise<string | null>
  /** Whether a Slack user is an owner of this Relay (src/tenancy/access.ts), for the owner-only session tools: the "sessions" and "direct" messages and Attach. Defaults to always-false, fail closed like resolvePrincipalId. */
  isOwner?: (platformUserId: string) => Promise<boolean>
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
  /** Channels whose Slackbot reminders Relay takes, each with the owner it runs as (config `slack.reminders`, src/chat/slack/reminder.ts). None by default. */
  reminderChannels?: ReminderChannels
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
   * FR-ATT-30: handles a "direct" message, which puts its thread on a plain Claude Code
   * session instead of Relay's governed loop. Injected rather than
   * implemented here for the same reason listRecentSessions is: the adapter
   * carries messages, it does not decide what a session is.
   */
  onDirectCommand?: (request: DirectCommandRequest) => Promise<void>
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

export type SlackAdapterDeps = {
  boltApp: SlackBoltApp
  apiClient: SlackApiClient
  botUserId: string
  workspaceId: string
  platformTeamId: string
  capabilities: AdapterCapabilities
  resolvePrincipalId: (platformUserId: string) => Promise<string | null>
  isOwner: (platformUserId: string) => Promise<boolean>
  isKnownSession: (threadRef: string) => Promise<boolean>
  acceptThreadMentions: boolean
  reminderChannels: ReminderChannels
  resolveApprovalInteraction: (request: ApprovalInteractionRequest) => Promise<ResolveApprovalResult | undefined>
  listRecentSessions: (limit: number) => Promise<readonly EngineSession[]>
  onDirectCommand: (request: DirectCommandRequest) => Promise<void>
  attachThreadToSession: (params: AttachThreadToSessionParams) => Promise<AttachThreadToSessionResult | undefined>
  sleep: (ms: number) => Promise<void>
  maxRateLimitRetries: number
  log: Logger | undefined
}
