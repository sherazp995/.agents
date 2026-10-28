import { ErrorCode } from '@slack/web-api'
import { describe, expect, it } from 'vitest'
import { unwrapForAudit } from '../../../src/agent/untrusted.js'
import type { AdapterCapabilities, ChatAction, ChatActionResult, ChatEvent } from '../../../src/chat/contract.js'
import { IntakeFailedError, sessionRefFor } from '../../../src/chat/contract.js'
import { SlackAdapter, composeThreadRef } from '../../../src/chat/slack/adapter.js'
import type {
  ApprovalInteractionRequest,
  SlackAdapterCreateOptions,
  SlackApiClient,
  SlackAuthIdentity,
  SlackBlockActionEnvelope,
  SlackBoltApp,
  SlackCommandEnvelope,
  SlackCommandListener,
  SlackEventEnvelope,
  SlackEventListener,
  SlackActionListener,
  SlackOpenModalArgs,
  SlackAddReactionArgs,
  SlackPostMessageArgs,
  SlackUpdateMessageArgs,
  SlackUploadFileArgs,
  SlackViewListener,
  SlackViewSubmissionEnvelope,
  SlackViewSubmissionResponse,
} from '../../../src/chat/slack/adapter.js'
import { SecretNotFoundError } from '../../../src/secrets/provider.js'
import type { SecretProvider } from '../../../src/secrets/provider.js'
import type { ResolveApprovalResult } from '../../../src/approvals/store.js'
import {
  APPROVAL_ACTION_IDS,
  CONFIRMATION_TOKEN,
  CONFIRM_MODAL_ACTION_ID,
  CONFIRM_MODAL_BLOCK_ID,
  CONFIRM_MODAL_CALLBACK_ID,
  EDIT_MODAL_ACTION_ID,
  EDIT_MODAL_BLOCK_ID,
  EDIT_MODAL_CALLBACK_ID,
  parseModalMetadata,
  UNRESOLVED_OUTCOME_DESCRIPTIONS,
} from '../../../src/approvals/blockkit.js'
import { encodeSessionAttachValue, SESSION_ATTACH_ACTION_ID } from '../../../src/chat/slack/session-attach.js'
import type { AttachThreadToSessionParams, AttachThreadToSessionResult } from '../../../src/chat/slack/session-attach.js'
import type { EngineSession } from '../../../src/sessions/discovery.js'
import type { ConformanceAdapter } from '../conformance.js'
import { runChatAdapterConformance } from '../conformance.js'

const BOT_USER_ID = 'UBOTLIVE'
const WORKSPACE_ID = 'TRELAYWORKSPACE'

function fakeSecrets(values: Record<string, string>): SecretProvider {
  return {
    kind: 'env',
    async get(name: string) {
      const value = values[name]
      if (value === undefined) throw new SecretNotFoundError(name)
      return value
    },
    async has(name: string) {
      return values[name] !== undefined
    },
  }
}

function bothTokens(): Record<string, string> {
  return { 'relay-slack-bot-token': 'xoxb-fake-test-token', 'relay-slack-app-token': 'xapp-fake-test-token' }
}

/** An immediate, non-sleeping stand in for the real setTimeout based sleep, so a rate limit retry test never actually waits. */
async function instantSleep(): Promise<void> {}

/**
 * A fixed, syntactically valid workspace uuid used by every test in this
 * file that is not itself about workspace id mapping. None of those tests
 * inspect ChatEvent.workspaceId's value, so a constant is enough; the
 * mapping behaviour itself (resolveWorkspaceId called correctly, the
 * emitted workspaceId parsing as a uuid, the fail closed default) is proven
 * in the "SlackAdapter workspace id mapping" describe block below.
 */
const FAKE_WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111'

/**
 * Every test in this file that needs a working adapter (one that can
 * actually start and dispatch events) goes through this wrapper rather than
 * calling SlackAdapter.create directly, so that adding the mandatory
 * resolveWorkspaceId option (per PRE-3) did not require touching each call
 * site's own options object individually. The two "missing token" startup
 * tests below call SlackAdapter.create directly instead, since they are
 * about that method's own secret validation, not about a working adapter.
 */
function createTestAdapter(
  secrets: SecretProvider,
  options: SlackAdapterCreateOptions = {},
): ReturnType<typeof SlackAdapter.create> {
  return SlackAdapter.create(secrets, {
    resolveWorkspaceId: async () => FAKE_WORKSPACE_UUID,
    ...options,
  })
}

/**
 * Records every listener the adapter registers, keyed by event type, and
 * lets a test drive a raw envelope through them the way a real Socket Mode
 * connection would. `stopped` and `started` let the generic lifecycle
 * conformance tests observe start/stop actually reaching this stub.
 */
class StubBoltApp implements SlackBoltApp {
  readonly listenersByType = new Map<string, SlackEventListener[]>()
  /** Task 4 addition: one listener per fixed action id, matching how SlackAdapter.start() registers exactly one per APPROVAL_ACTION_IDS entry. */
  readonly listenersByActionId = new Map<string, SlackActionListener>()
  /** Task 4 addition: one listener per fixed modal callback id (confirm/edit). */
  readonly listenersByCallbackId = new Map<string, SlackViewListener>()
  started = false
  stopped = false

  event(eventType: string, listener: SlackEventListener): void {
    const list = this.listenersByType.get(eventType) ?? []
    list.push(listener)
    this.listenersByType.set(eventType, list)
  }

  action(actionId: string, listener: SlackActionListener): void {
    this.listenersByActionId.set(actionId, listener)
  }

  readonly commands = new Map<string, SlackCommandListener>()
  command(commandName: string, listener: SlackCommandListener): void {
    this.commands.set(commandName, listener)
  }
  /** Drives one registered slash command the way Slack itself would. */
  async dispatchCommand(commandName: string, envelope: SlackCommandEnvelope): Promise<void> {
    const listener = this.commands.get(commandName)
    if (!listener) throw new Error(`no listener registered for command ${commandName}`)
    await listener(envelope)
  }

  view(callbackId: string, listener: SlackViewListener): void {
    this.listenersByCallbackId.set(callbackId, listener)
  }

  async start(): Promise<unknown> {
    this.started = true
    return undefined
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  async dispatch(eventType: string, envelope: SlackEventEnvelope): Promise<void> {
    const list = this.listenersByType.get(eventType) ?? []
    for (const listener of list) {
      await listener(envelope)
    }
  }

  /** Drives a Block Kit button click through the listener SlackAdapter.start() registered for `actionId`, the way a real Socket Mode block_actions payload would. Throws if nothing registered that id, since a test driving a click SlackAdapter never subscribed to indicates a bug in the test, not a legitimate "no listener" case. */
  async dispatchAction(actionId: string, envelope: SlackBlockActionEnvelope): Promise<void> {
    const listener = this.listenersByActionId.get(actionId)
    if (!listener) throw new Error(`StubBoltApp: no action listener registered for "${actionId}"`)
    await listener(envelope)
  }

  /** Drives a modal view_submission through the listener registered for `callbackId`, returning whatever response_action (if any) the real handler produced, exactly like Bolt's own ack() would carry back to Slack. */
  async dispatchView(callbackId: string, envelope: SlackViewSubmissionEnvelope): Promise<SlackViewSubmissionResponse> {
    const listener = this.listenersByCallbackId.get(callbackId)
    if (!listener) throw new Error(`StubBoltApp: no view listener registered for "${callbackId}"`)
    return listener(envelope)
  }
}

/**
 * Records every outbound call and can be told to fail its next call with a
 * rate limited error shaped exactly like a real WebAPIRateLimitedError
 * (same `code`, same `retryAfter` in seconds), so #callApi's retry logic is
 * exercised without any real network or real waiting.
 */
class StubSlackApiClient implements SlackApiClient {
  readonly posted: SlackPostMessageArgs[] = []
  readonly updated: SlackUpdateMessageArgs[] = []
  readonly uploaded: SlackUploadFileArgs[] = []
  /** Task 4 addition: every openModal call, so a test can assert which view (confirmation vs edit) was opened and with which private_metadata. */
  readonly openedModals: SlackOpenModalArgs[] = []
  readonly reactions: SlackAddReactionArgs[] = []
  #seq = 0
  #pendingRateLimits: number[] = []

  constructor(
    private readonly identity: SlackAuthIdentity = { botUserId: BOT_USER_ID, platformTeamId: WORKSPACE_ID },
  ) {}

  /** The next `count` calls (across post/edit/upload) reject with a rate limited error carrying the given retryAfter (seconds), then calls succeed normally again. */
  failNextCallsWithRateLimit(count: number, retryAfterSeconds: number): void {
    this.#pendingRateLimits = Array.from({ length: count }, () => retryAfterSeconds)
  }

  async authTest(): Promise<SlackAuthIdentity> {
    return this.identity
  }

  async postMessage(args: SlackPostMessageArgs): Promise<{ ts: string }> {
    this.#maybeRateLimit()
    this.posted.push(args)
    this.#seq += 1
    return { ts: `${this.#seq}.000001` }
  }

  async updateMessage(args: SlackUpdateMessageArgs): Promise<{ ts: string }> {
    this.#maybeRateLimit()
    this.updated.push(args)
    return { ts: args.ts }
  }

  async uploadFile(args: SlackUploadFileArgs): Promise<void> {
    this.#maybeRateLimit()
    this.uploaded.push(args)
  }

  async openModal(args: SlackOpenModalArgs): Promise<void> {
    this.#maybeRateLimit()
    this.openedModals.push(args)
  }

  async addReaction(args: SlackAddReactionArgs): Promise<void> {
    this.#maybeRateLimit()
    this.reactions.push(args)
  }

  #maybeRateLimit(): void {
    const retryAfter = this.#pendingRateLimits.shift()
    if (retryAfter === undefined) return
    const error = new Error('rate limited') as Error & { code: string; retryAfter: number }
    error.code = ErrorCode.RateLimitedError
    error.retryAfter = retryAfter
    throw error
  }
}

/**
 * Wraps a real SlackAdapter (wired to stubs) so it satisfies
 * ConformanceAdapter, driving every `emit` through StubBoltApp exactly like
 * a real Socket Mode delivery would: SlackAdapter's own #handleRawEnvelope,
 * dedupe window, channel entry gate, and #buildChatEvent all run for real,
 * so a break in SlackAdapter's own delivery mechanics (ordering,
 * exactly-once via #deliveryQueue, where a handler error actually surfaces)
 * fails these conformance tests too. Calling the private handler directly,
 * the previous approach, could never catch that class of break, since it
 * never touched any of that machinery.
 *
 * SlackAdapter's real #buildChatEvent cannot reproduce an arbitrary
 * caller-supplied ChatEvent byte for byte: `adapter`, `workspaceId`, `raw`,
 * and `receivedAt` are always Slack's own identity and clock (this
 * instance's fixed name and workspace, the real raw envelope, the real
 * receipt time), never whatever the generic conformance fixture happens to
 * set (see `buildEvent` in test/chat/conformance.ts). `#pendingByTs`
 * bridges that gap: `emit` records which original ChatEvent a given
 * synthetic ts corresponds to, and once that ts round-trips back out
 * through the real pipeline, the ORIGINAL object is what reaches the
 * suite's own handler, so its assertions (built against the object it
 * itself constructed) still hold. The mechanics under test, whether the
 * pipeline delivers it at all, in what order, how many times, and whether
 * a handler error is isolated, are all exercised for real regardless: a
 * dropped, duplicated, or reordered delivery shows up exactly as a missing,
 * repeated, or out-of-order entry in `received`, correlation or not. Raw
 * field parsing itself (kind/ref/text mapping) is not this suite's concern;
 * this file's own dedicated tests below exercise that directly.
 */
class ConformanceSlackAdapter implements ConformanceAdapter {
  readonly name: string
  readonly capabilities: AdapterCapabilities
  readonly handlerErrors: Error[] = []
  readonly performed: ChatAction[] = []

  #inner: SlackAdapter
  #boltApp: StubBoltApp
  #seq = 0
  #pendingByTs = new Map<string, ChatEvent>()

  constructor(inner: SlackAdapter, boltApp: StubBoltApp) {
    this.#inner = inner
    this.#boltApp = boltApp
    this.name = inner.name
    this.capabilities = inner.capabilities
  }

  async start(handler: (event: ChatEvent) => Promise<void>): Promise<void> {
    const wrapped = async (deliveredEvent: ChatEvent): Promise<void> => {
      const ts = deliveredEvent.ref.message
      const original = ts !== undefined ? this.#pendingByTs.get(ts) : undefined
      try {
        await handler(original ?? deliveredEvent)
      } catch (error) {
        this.handlerErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    await this.#inner.start(wrapped)
  }

  async stop(): Promise<void> {
    await this.#inner.stop()
  }

  async perform(action: ChatAction): Promise<ChatActionResult> {
    const result = await this.#inner.perform(action)
    this.performed.push(action)
    return result
  }

  async emit(event: ChatEvent): Promise<void> {
    this.#seq += 1
    const ts = `${Date.now()}.${String(this.#seq).padStart(6, '0')}`
    this.#pendingByTs.set(ts, event)
    // Always dispatched as an app_mention, on a synthetic channel-agnostic
    // basis: this suite tests generic ChatAdapter behaviour, not the
    // channel entry policy (FR-SL-2), which test/chat/slack/adapter.test.ts's
    // own "channel entry policy" describe block below covers. app_mention
    // keeps every conformance fixture's channel accepted regardless of its
    // name.
    await this.#boltApp.dispatch('app_mention', {
      event: { type: 'app_mention', channel: event.ref.channel, user: 'UCONFORMANCE', text: unwrapForAudit(event.text), ts },
      body: {},
    })
  }
}

/**
 * fileUpload is deliberately false on this instance, purely so
 * runChatAdapterConformance's capability honesty test has a real gap to
 * exercise (see its unsupportedAction helper, which requires at least one
 * of editMessage/fileUpload to be false). This is a test-only override, not
 * what SlackAdapter declares by default: 'SlackAdapter declares Slack
 * capabilities honestly by default' below proves the real default is
 * fileUpload true, matching what SLACK_BOT_SCOPES's files:write scope
 * actually grants.
 */
async function buildConformanceAdapter(): Promise<{ adapter: ConformanceAdapter; cleanup: () => Promise<void> }> {
  const boltApp = new StubBoltApp()
  const inner = await createTestAdapter(fakeSecrets(bothTokens()), {
    boltApp,
    apiClient: new StubSlackApiClient(),
    sleep: instantSleep,
    capabilities: { fileUpload: false },
  })
  const adapter = new ConformanceSlackAdapter(inner, boltApp)
  return { adapter, cleanup: async () => adapter.stop() }
}

runChatAdapterConformance('SlackAdapter', buildConformanceAdapter)

describe('SlackAdapter capabilities', () => {
  it('declares Slack capabilities honestly by default: buttons, editMessage, fileUpload, modals, and threads all true, and the documented byte limit', async () => {
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp: new StubBoltApp(),
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    expect(adapter.capabilities).toEqual({
      buttons: true,
      editMessage: true,
      fileUpload: true,
      modals: true,
      threads: true,
      maxMessageBytes: 40_000,
    })
  })
})

describe('SlackAdapter startup', () => {
  it('a missing bot token produces a clear error naming relay-slack-bot-token', async () => {
    await expect(SlackAdapter.create(fakeSecrets({}))).rejects.toThrow(/relay-slack-bot-token/)
  })

  it('a missing app token produces a clear error naming relay-slack-app-token, and never echoes the bot token that was already read successfully', async () => {
    const secrets = fakeSecrets({ 'relay-slack-bot-token': 'xoxb-should-never-leak-anywhere' })
    await expect(SlackAdapter.create(secrets)).rejects.toThrow(/relay-slack-app-token/)

    try {
      await SlackAdapter.create(secrets)
      throw new Error('expected SlackAdapter.create to reject')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? (error.stack ?? '') : ''
      expect(message).not.toContain('xoxb-should-never-leak-anywhere')
      expect(stack).not.toContain('xoxb-should-never-leak-anywhere')
    }
  })
})

/**
 * PRE-3 (docs/decisions/open-questions.md): ChatEvent.workspaceId must carry
 * a Relay workspace uuid, never Slack's own team id, because workspaces.id
 * is a uuid column and any raw team id passed into resolvePrincipal or
 * Outbox.enqueue would fail with invalid uuid syntax. These tests are what
 * the Task 1 brief's self-attack targets: reverting the mapping (assigning
 * identity.platformTeamId straight to workspaceId again, the pre-fix shape)
 * must make "maps the resolved uuid onto workspaceId..." fail, since the raw
 * WORKSPACE_ID constant below is deliberately not uuid shaped and deliberately
 * distinct from RESOLVED_WORKSPACE_UUID.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RESOLVED_WORKSPACE_UUID = '22222222-2222-4222-8222-222222222222'

describe('SlackAdapter workspace id mapping (PRE-3)', () => {
  it('create() throws when no resolveWorkspaceId is provided, rather than falling back to the raw Slack team id', async () => {
    await expect(
      SlackAdapter.create(fakeSecrets(bothTokens()), {
        boltApp: new StubBoltApp(),
        apiClient: new StubSlackApiClient(),
        sleep: instantSleep,
      }),
    ).rejects.toThrow(/resolveWorkspaceId/)
  })

  it('maps the resolved uuid onto every emitted ChatEvent.workspaceId, keeping the raw Slack team id on platformTeamId, and never puts the raw team id where the uuid belongs', async () => {
    expect(WORKSPACE_ID).not.toMatch(UUID_PATTERN)

    const calls: Array<{ platform: string; platformTeamId: string }> = []
    const boltApp = new StubBoltApp()
    const adapter = await SlackAdapter.create(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
      resolveWorkspaceId: async (platform, platformTeamId) => {
        calls.push({ platform, platformTeamId })
        return RESOLVED_WORKSPACE_UUID
      },
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    await boltApp.dispatch('app_mention', {
      event: { type: 'app_mention', channel: 'C1', user: 'UAHUMAN', text: '<@UBOTLIVE> hi', ts: '2000.000001' },
      body: {},
    })

    expect(calls).toEqual([{ platform: 'slack', platformTeamId: WORKSPACE_ID }])
    expect(events).toHaveLength(1)
    expect(events[0]?.workspaceId).toBe(RESOLVED_WORKSPACE_UUID)
    expect(events[0]?.workspaceId).toMatch(UUID_PATTERN)
    expect(events[0]?.workspaceId).not.toBe(WORKSPACE_ID)
    expect(events[0]?.platformTeamId).toBe(WORKSPACE_ID)

    await adapter.stop()
  })

  it('resolves the workspace uuid once at construction, not once per dispatched event', async () => {
    let calls = 0
    const boltApp = new StubBoltApp()
    const adapter = await SlackAdapter.create(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
      resolveWorkspaceId: async () => {
        calls += 1
        return RESOLVED_WORKSPACE_UUID
      },
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    await boltApp.dispatch('app_mention', {
      event: { type: 'app_mention', channel: 'C1', user: 'UAHUMAN', text: '<@UBOTLIVE> one', ts: '2001.000001' },
      body: {},
    })
    await boltApp.dispatch('app_mention', {
      event: { type: 'app_mention', channel: 'C1', user: 'UAHUMAN', text: '<@UBOTLIVE> two', ts: '2001.000002' },
      body: {},
    })

    expect(calls).toBe(1)
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.workspaceId === RESOLVED_WORKSPACE_UUID)).toBe(true)

    await adapter.stop()
  })
})

describe('SlackAdapter inbound event mapping', () => {
  async function startWithBolt(): Promise<{
    boltApp: StubBoltApp
    events: ChatEvent[]
    stop: () => Promise<void>
  }> {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })
    return { boltApp, events, stop: () => adapter.stop() }
  }

  it('maps a channel mention to kind message with a plain channel ref', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('app_mention', {
        event: { type: 'app_mention', channel: 'C123CHANNEL', user: 'U1REAL', text: '<@UBOTLIVE> hello', ts: '100.000001' },
        body: { team_id: WORKSPACE_ID },
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'message',
        ref: { channel: 'C123CHANNEL', message: '100.000001' },
        adapter: 'slack',
      })
      expect(events[0]?.ref.thread).toBeUndefined()
    } finally {
      await stop()
    }
  })

  it("maps a DM to kind message with a channel ref that starts with 'D', carrying message equal to the incoming ts so a reply has something to thread from", async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: { type: 'message', channel: 'D999DM', user: 'U1REAL', text: 'hi there', ts: '200.000001' },
        body: { team_id: WORKSPACE_ID },
      })

      expect(events).toHaveLength(1)
      expect(events[0]?.kind).toBe('message')
      expect(events[0]?.ref.channel.startsWith('D')).toBe(true)
      expect(events[0]?.ref.message).toBe('200.000001')
      expect(events[0]?.ref.thread).toBeUndefined()
    } finally {
      await stop()
    }
  })

  it('maps a thread reply to kind thread_reply carrying both thread and message on the ref', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      // A DM, not a channel: the channel entry policy (see 'SlackAdapter
      // channel entry policy' below) ignores channel thread replies
      // outright until P0.3 adds session storage, but a DM is always
      // accepted, so this stays the right fixture to prove #buildChatEvent's
      // thread_reply mapping itself, independent of that policy.
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'D300DM',
          user: 'U1REAL',
          text: 'a reply',
          ts: '300.000002',
          thread_ts: '300.000001',
        },
        body: { team_id: WORKSPACE_ID },
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'thread_reply',
        ref: { channel: 'D300DM', thread: '300.000001', message: '300.000002' },
      })
    } finally {
      await stop()
    }
  })

  it('does not treat the thread parent message itself (thread_ts equal to ts) as a thread reply', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      // Dispatched as app_mention, not message: a channel root message
      // (which this is, thread_ts equal to ts is not a reply) only enters
      // through app_mention under the channel entry policy below. That
      // policy is a separate concern from what this test proves, the
      // thread_ts === ts classification boundary.
      await boltApp.dispatch('app_mention', {
        event: { type: 'app_mention', channel: 'C1', user: 'U1REAL', text: 'starts a thread', ts: '400.000001', thread_ts: '400.000001' },
        body: {},
      })

      expect(events).toHaveLength(1)
      expect(events[0]?.kind).toBe('message')
    } finally {
      await stop()
    }
  })
})

describe('SlackAdapter self-message filtering', () => {
  it('ignores an event carrying bot_id, so the adapter cannot loop on another bot', async () => {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    await boltApp.dispatch('message', {
      event: { type: 'message', channel: 'C1', bot_id: 'BOTHER', text: 'a bot said this', ts: '500.000001' },
      body: {},
    })

    expect(events).toHaveLength(0)
    await adapter.stop()
  })

  it("ignores an event whose user is the app's own bot user id, so the adapter cannot loop on itself", async () => {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient({ botUserId: BOT_USER_ID, platformTeamId: WORKSPACE_ID }),
      sleep: instantSleep,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    await boltApp.dispatch('message', {
      event: { type: 'message', channel: 'C1', user: BOT_USER_ID, text: 'relay talking to itself', ts: '600.000001' },
      body: {},
    })

    expect(events).toHaveLength(0)
    await adapter.stop()
  })

  // This used to assert an unmentioned C1 channel message from an ordinary
  // human WAS delivered, as proof that self-filtering was not simply
  // refusing everything. That pinned exactly the bug FR-SL-2 forbids: any
  // workspace conversation in a channel Relay sits in could trigger the
  // system. FR-SL-2 permits channel entry only through an @relay mention or
  // a reply inside an existing Relay thread; the interim rule enforced
  // until P0.3 adds session storage (see #isChannelEntryAllowed in
  // src/chat/slack/adapter.ts and the 'SlackAdapter channel entry policy'
  // describe block below) requires app_mention for a channel root message.
  // Proof that self-filtering itself is not "refusing everything" now lives
  // in the mention and DM cases in that describe block, which a real human
  // message must still reach.
  it('does not deliver an unmentioned ordinary channel message, even from a real human with no bot markers at all', async () => {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    await boltApp.dispatch('message', {
      event: { type: 'message', channel: 'C1', user: 'UAHUMAN', text: 'a real user message', ts: '700.000001' },
      body: {},
    })

    expect(events).toHaveLength(0)
    await adapter.stop()
  })

  it('delivers a mention only once even though it arrives through both app_mention and message subscriptions', async () => {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    const sameRawEvent = {
      type: 'app_mention',
      channel: 'C1',
      user: 'UAHUMAN',
      text: '<@UBOTLIVE> hi',
      ts: '800.000001',
    }
    await boltApp.dispatch('app_mention', { event: sameRawEvent, body: {} })
    await boltApp.dispatch('message', { event: sameRawEvent, body: {} })

    expect(events).toHaveLength(1)
    await adapter.stop()
  })

  // OQ-3 (docs/decisions/open-questions.md) is resolved: per Slack's
  // documented message_deleted shape, a housekeeping envelope's own top
  // level `ts` is the EVENT's own timestamp, not the ts of whatever message
  // it is reporting on. So a message_changed envelope's top level `ts` and
  // its nested `message.ts` are genuinely different values, never the same
  // value asserted twice the way an earlier version of this test assumed.
  it('does not let an ignored message_changed envelope claim the dedupe key at its own top level ts, so a later genuine message that happens to arrive at that same ts is still delivered', async () => {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    // The edit event's own ts (860.000099) is distinct from the original,
    // edited message's ts (860.000001) nested under `message`. If the
    // ignore check ran after the dedupe window had already been written,
    // this housekeeping envelope would burn the key at ITS OWN ts, and any
    // later message that happened to land on that exact ts would be
    // dropped forever with no trace.
    await boltApp.dispatch('message', {
      event: {
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        ts: '860.000099',
        message: { type: 'message', user: 'UAHUMAN', text: '<@UBOTLIVE> hi (edited)', ts: '860.000001' },
      },
      body: {},
    })

    // A later, unrelated genuine mention arrives at exactly the ts the
    // ignored edit envelope carried at its own top level.
    await boltApp.dispatch('app_mention', {
      event: { type: 'app_mention', channel: 'C1', user: 'UAHUMAN', text: '<@UBOTLIVE> hi', ts: '860.000099' },
      body: {},
    })

    expect(events).toHaveLength(1)
    expect(events[0] && unwrapForAudit(events[0].text)).toBe('<@UBOTLIVE> hi')
    await adapter.stop()
  })

  it('does not claim the dedupe key when principal resolution throws, so Slack retrying the same envelope is delivered once resolution succeeds', async () => {
    const boltApp = new StubBoltApp()
    let shouldThrow = true
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
      resolvePrincipalId: async () => {
        if (shouldThrow) throw new Error('principal lookup failed')
        return 'principal-1'
      },
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    const rawEvent = { type: 'app_mention', channel: 'C1', user: 'UAHUMAN', text: '<@UBOTLIVE> hi', ts: '950.000001' }

    await expect(boltApp.dispatch('app_mention', { event: rawEvent, body: {} })).rejects.toThrow(
      'principal lookup failed',
    )
    expect(events).toHaveLength(0)

    // Slack's own retry of the exact same envelope: nothing here changes the
    // (channel, ts). If the earlier throw had already claimed the dedupe
    // key, this would be silently swallowed as a duplicate and the message
    // would be lost for good.
    shouldThrow = false
    await boltApp.dispatch('app_mention', { event: rawEvent, body: {} })

    expect(events).toHaveLength(1)
    expect(events[0]?.principalId).toBe('principal-1')
    await adapter.stop()
  })
})

/**
 * FR-SL-2 says channel entry is only through an @relay mention or a reply
 * inside an existing Relay thread. P0.2 shipped without the thread reply
 * case, because recognising "an existing Relay thread" needed session
 * storage that did not exist yet; that storage exists now
 * (src/sessions/store.ts), so #isChannelEntryAllowed asks an injected
 * `isKnownSession` predicate rather than refusing every channel thread
 * reply outright. `isKnownSession` defaults to always false (PRE-4,
 * docs/decisions/open-questions.md), so with no predicate injected, a
 * channel thread reply is still ignored exactly as it was under P0.2: that
 * default is what most of these tests exercise, and it is deliberately
 * unchanged. The `isKnownSession` describe block below covers the injected
 * case, both accepted (a known thread) and still ignored (an unrelated
 * thread, the blocker P0.2's gate caught).
 */
describe('SlackAdapter channel entry policy (FR-SL-2)', () => {
  async function startWithBolt(options: SlackAdapterCreateOptions = {}): Promise<{
    boltApp: StubBoltApp
    events: ChatEvent[]
    stop: () => Promise<void>
  }> {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
      ...options,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })
    return { boltApp, events, stop: () => adapter.stop() }
  }

  it('accepts a channel root message that arrives as an app_mention', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('app_mention', {
        event: { type: 'app_mention', channel: 'CENTRY1', user: 'UAHUMAN', text: '<@UBOTLIVE> do the thing', ts: '1000.000001' },
        body: {},
      })

      expect(events).toHaveLength(1)
    } finally {
      await stop()
    }
  })

  it('accepts a DM whether or not it mentions the bot', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: { type: 'message', channel: 'DENTRY1', user: 'UAHUMAN', text: 'no mention needed here', ts: '1001.000001' },
        body: {},
      })

      expect(events).toHaveLength(1)
    } finally {
      await stop()
    }
  })

  it('ignores a channel root message that arrives on the plain message subscription rather than app_mention', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: { type: 'message', channel: 'CENTRY2', user: 'UAHUMAN', text: 'unrelated office chat', ts: '1002.000001' },
        body: {},
      })

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  it('ignores a channel thread reply entirely when no isKnownSession predicate is injected, even one that mentions the bot: this is case 5, the exact P0.2 default behaviour', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CENTRY3',
          user: 'UAHUMAN',
          text: '<@UBOTLIVE> a reply inside some thread',
          ts: '1003.000002',
          thread_ts: '1003.000001',
        },
        body: {},
      })

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  it('ignores a channel thread reply even on the app_mention subscription: a mention alone does not carve out an exception for a thread reply', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('app_mention', {
        event: {
          type: 'app_mention',
          channel: 'CENTRY4',
          user: 'UAHUMAN',
          text: '<@UBOTLIVE> a reply inside some thread',
          ts: '1004.000002',
          thread_ts: '1004.000001',
        },
        body: {},
      })

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  it('never calls isKnownSession for a DM or a channel root mention: both are already decided without a database round trip', async () => {
    const calls: string[] = []
    const isKnownSession = async (threadRef: string): Promise<boolean> => {
      calls.push(threadRef)
      return false
    }
    const { boltApp, events, stop } = await startWithBolt({ isKnownSession })
    try {
      await boltApp.dispatch('app_mention', {
        event: { type: 'app_mention', channel: 'CENTRY5', user: 'UAHUMAN', text: '<@UBOTLIVE> hi', ts: '1005.000001' },
        body: {},
      })
      await boltApp.dispatch('message', {
        event: { type: 'message', channel: 'DENTRY5', user: 'UAHUMAN', text: 'a dm', ts: '1006.000001' },
        body: {},
      })

      expect(events).toHaveLength(2)
      expect(calls).toEqual([])
    } finally {
      await stop()
    }
  })
})

/**
 * PRE-4: the third entry point FR-SL-2 permits, a reply inside an existing
 * Relay thread, restored now that session storage exists to answer "is this
 * thread genuinely Relay's". These are the two cases that matter most: a
 * known thread is accepted (case 3), and an unrelated thread is still
 * ignored (case 4, the blocker P0.2's gate caught). A predicate that
 * answered true unconditionally would pass case 3 but must fail case 4;
 * that self-attack is run explicitly below.
 */
describe('SlackAdapter mention fields and thread mentions (autonomous intake)', () => {
  async function startWithBolt(options: SlackAdapterCreateOptions = {}): Promise<{
    boltApp: StubBoltApp
    events: ChatEvent[]
    stop: () => Promise<void>
  }> {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
      ...options,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })
    return { boltApp, events, stop: () => adapter.stop() }
  }

  const mentionText = `<@${BOT_USER_ID}> review this`

  for (const order of [['app_mention', 'message'], ['message', 'app_mention']] as const) {
    it(`yields one event with mentionsBot and one platformEventId when the ${order[0]} envelope arrives first`, async () => {
      const { boltApp, events, stop } = await startWithBolt()
      try {
        for (const type of order) {
          await boltApp.dispatch(type, {
            event: { type, channel: 'DMENTION', user: 'UAHUMAN', text: mentionText, ts: '1500.000001' },
            body: {},
          })
        }

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ mentionsBot: true, platformEventId: 'DMENTION:1500.000001' })
      } finally {
        await stop()
      }
    })
  }

  it('sets mentionsBot for the labelled mention form', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: { type: 'message', channel: 'DLABEL', user: 'UAHUMAN', text: `<@${BOT_USER_ID}|relay> hi`, ts: '1504.000001' },
        body: {},
      })

      expect(events[0]?.mentionsBot).toBe(true)
    } finally {
      await stop()
    }
  })

  it('sets mentionsBot false when the text carries no mention of the bot', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: { type: 'message', channel: 'DPLAIN', user: 'UAHUMAN', text: 'hello <@USOMEONE>', ts: '1501.000001' },
        body: {},
      })

      expect(events[0]?.mentionsBot).toBe(false)
    } finally {
      await stop()
    }
  })

  const threadEnvelope = (type: 'app_mention' | 'message', ts: string) => ({
    event: { type, channel: 'CTHREAD', user: 'UAHUMAN', text: mentionText, ts, thread_ts: '1502.000001' },
    body: {},
  })

  it('with acceptThreadMentions on, delivers an app_mention reply in an unknown thread and still drops a plain reply there', async () => {
    const { boltApp, events, stop } = await startWithBolt({ acceptThreadMentions: true })
    try {
      await boltApp.dispatch('app_mention', threadEnvelope('app_mention', '1502.000002'))
      await boltApp.dispatch('message', {
        event: { type: 'message', channel: 'CTHREAD', user: 'UAHUMAN', text: 'no mention', ts: '1502.000003', thread_ts: '1502.000001' },
        body: {},
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'thread_reply', mentionsBot: true, platformEventId: 'CTHREAD:1502.000002' })
    } finally {
      await stop()
    }
  })

  it('with acceptThreadMentions off, drops both the app_mention reply and the plain reply in an unknown thread, as before', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('app_mention', threadEnvelope('app_mention', '1503.000002'))
      await boltApp.dispatch('message', threadEnvelope('message', '1503.000003'))

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })
})

describe('SlackAdapter intake failure (autonomous router)', () => {
  async function startWith(handler: (event: ChatEvent) => Promise<void>, options: SlackAdapterCreateOptions = {}) {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), { boltApp, apiClient, sleep: instantSleep, ...options })
    await adapter.start(handler)
    return { boltApp, apiClient, stop: () => adapter.stop() }
  }
  const mention = (ts: string, channel = 'DINTAKE') => ({
    event: { type: 'app_mention', channel, user: 'UAHUMAN', text: `<@${BOT_USER_ID}> fix it`, ts },
    body: {},
  })

  it('posts the could-not-start reply, releases the key, and processes a later delivery of the same mention', async () => {
    let failures = 1
    const delivered: string[] = []
    const { boltApp, apiClient, stop } = await startWith(async (event) => {
      if (failures-- > 0) throw new IntakeFailedError('intake failed')
      delivered.push(event.platformEventId)
    })
    try {
      await boltApp.dispatch('app_mention', mention('1600.000001'))
      expect(apiClient.posted).toEqual([expect.objectContaining({ channel: 'DINTAKE', thread: '1600.000001', text: 'I could not start this task, mention me again.' })])

      await boltApp.dispatch('app_mention', mention('1600.000001'))
      expect(delivered).toEqual(['DINTAKE:1600.000001'])
    } finally {
      await stop()
    }
  })

  it('keeps the key claimed and posts nothing for any other handler error, and later events still arrive', async () => {
    const delivered: string[] = []
    const { boltApp, apiClient, stop } = await startWith(async (event) => {
      if (event.platformEventId === 'DINTAKE:1601.000001') throw new Error('boom')
      delivered.push(event.platformEventId)
    })
    try {
      await boltApp.dispatch('app_mention', mention('1601.000001'))
      await boltApp.dispatch('app_mention', mention('1601.000001'))
      await boltApp.dispatch('app_mention', mention('1602.000001', 'DOTHER'))

      expect(apiClient.posted).toEqual([])
      expect(delivered).toEqual(['DOTHER:1602.000001'])
    } finally {
      await stop()
    }
  })

  it('runs one intake for two envelopes of the same message whose principal lookups finish together', async () => {
    let release: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const delivered: string[] = []
    const { boltApp, stop } = await startWith(
      async (event) => {
        delivered.push(event.platformEventId)
      },
      {
        resolvePrincipalId: async () => {
          await barrier
          return 'principal-1'
        },
      },
    )
    try {
      const first = boltApp.dispatch('app_mention', mention('1603.000001'))
      const second = boltApp.dispatch('message', { event: { ...mention('1603.000001').event, type: 'message' }, body: {} })
      release()
      await Promise.all([first, second])

      expect(delivered).toEqual(['DINTAKE:1603.000001'])
    } finally {
      await stop()
    }
  })
})

describe('SlackAdapter channel thread reply entry via isKnownSession (PRE-4)', () => {
  async function startWithBolt(isKnownSession: (threadRef: string) => Promise<boolean>): Promise<{
    boltApp: StubBoltApp
    events: ChatEvent[]
    stop: () => Promise<void>
  }> {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
      isKnownSession,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })
    return { boltApp, events, stop: () => adapter.stop() }
  }

  it('accepts a channel thread reply when isKnownSession says the thread IS a known session, mapping to thread_reply with both thread and message on the ref', async () => {
    const { boltApp, events, stop } = await startWithBolt(async () => true)
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CKNOWN1',
          user: 'UAHUMAN',
          text: 'continuing the thread',
          ts: '1100.000002',
          thread_ts: '1100.000001',
        },
        body: {},
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'thread_reply',
        ref: { channel: 'CKNOWN1', thread: '1100.000001', message: '1100.000002' },
      })
    } finally {
      await stop()
    }
  })

  // The blocker case. A predicate that mistakenly says true for everything
  // would pass every other test in this file; only this one, an UNRELATED
  // thread with the predicate correctly returning false, catches that. See
  // the self-attack in the report: forcing isKnownSession to return true
  // unconditionally makes exactly this test fail.
  it('ignores a channel thread reply in an unrelated thread when isKnownSession says false: the blocker case', async () => {
    const seen: string[] = []
    const { boltApp, events, stop } = await startWithBolt(async (threadRef) => {
      seen.push(threadRef)
      return false
    })
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CUNRELATED1',
          user: 'UAHUMAN',
          text: 'ordinary office chat inside some other thread',
          ts: '1101.000002',
          thread_ts: '1101.000001',
        },
        body: {},
      })

      expect(events).toHaveLength(0)
      expect(seen).toEqual([composeThreadRef('CUNRELATED1', '1101.000001')])
    } finally {
      await stop()
    }
  })

  it('calls isKnownSession with the threadRef composed from the reply\'s own channel and thread_ts', async () => {
    const seen: string[] = []
    const { boltApp, stop } = await startWithBolt(async (threadRef) => {
      seen.push(threadRef)
      return false
    })
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CARGS1',
          user: 'UAHUMAN',
          text: 'a reply',
          ts: '1102.000002',
          thread_ts: '1102.000001',
        },
        body: {},
      })

      expect(seen).toEqual(['CARGS1:1102.000001'])
    } finally {
      await stop()
    }
  })
})

/**
 * Task 3's reviewer proved this property by hand and asked for a committed
 * test: Task 8 replaces the fixed-boolean predicate every test above uses
 * with a real database query on the inbound path
 * (src/orchestrator.ts's isKnownSessionQuery), so a thrown error and a slow
 * answer both become real, reachable outcomes for the first time, not just
 * a theoretical concern. Neither may lose the event, kill the adapter, or
 * wedge the dedupe state (#recentEvents).
 */
describe('SlackAdapter isKnownSession failure modes (Task 8)', () => {
  async function startWithBolt(isKnownSession: (threadRef: string) => Promise<boolean>): Promise<{
    boltApp: StubBoltApp
    events: ChatEvent[]
    stop: () => Promise<void>
  }> {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
      isKnownSession,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })
    return { boltApp, events, stop: () => adapter.stop() }
  }

  it('a throwing isKnownSession does not lose the event, kill the adapter, or wedge the dedupe state: the thread reply is refused (fail closed) and a later, unrelated event still delivers normally', async () => {
    const { boltApp, events, stop } = await startWithBolt(async () => {
      throw new Error('simulated database failure')
    })
    try {
      // The throwing call itself must not escape as an uncaught rejection:
      // #isChannelEntryAllowed catches it, so this await resolves cleanly.
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CTHROWS1',
          user: 'UAHUMAN',
          text: 'a reply while the predicate is broken',
          ts: '1300.000002',
          thread_ts: '1300.000001',
        },
        body: {},
      })
      // Fail closed: refused, exactly like isKnownSession answering false.
      expect(events).toHaveLength(0)

      // The adapter is still alive and correct for a completely unrelated
      // event afterward: neither the dedupe window nor anything else was
      // left in a broken state by the throw.
      await boltApp.dispatch('app_mention', {
        event: { type: 'app_mention', channel: 'CTHROWS2', user: 'UAHUMAN', text: '<@UBOTLIVE> hi', ts: '1301.000001' },
        body: {},
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.ref).toMatchObject({ channel: 'CTHROWS2' })

      // The dedupe window was not wedged by the throwing envelope either: a
      // genuine SECOND delivery of that exact throwing envelope (Slack's own
      // retry-on-no-ack behaviour) is attempted again, not silently dropped
      // as though it had already been claimed.
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CTHROWS1',
          user: 'UAHUMAN',
          text: 'a reply while the predicate is broken',
          ts: '1300.000002',
          thread_ts: '1300.000001',
        },
        body: {},
      })
      expect(events).toHaveLength(1) // still refused (fail closed), not lost track of entirely
    } finally {
      await stop()
    }
  })

  it('a slow isKnownSession does not lose the event or block an unrelated event dispatched while it is still pending, and eventually resolves correctly', async () => {
    let releaseSlowCall: (() => void) | undefined

    const isKnownSession = (threadRef: string): Promise<boolean> => {
      if (threadRef !== composeThreadRef('CSLOW1', '1400.000001')) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        releaseSlowCall = () => resolve(true)
      })
    }

    const { boltApp, events, stop } = await startWithBolt(isKnownSession)
    try {
      const slowDispatch = boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CSLOW1',
          user: 'UAHUMAN',
          text: 'a reply while the predicate is still thinking',
          ts: '1400.000002',
          thread_ts: '1400.000001',
        },
        body: {},
      })

      // An unrelated event, dispatched while the slow call above is still
      // pending, is not blocked by it: this adapter has no global lock
      // around #isChannelEntryAllowed, only the one envelope waiting on its
      // own predicate call is affected.
      await boltApp.dispatch('app_mention', {
        event: { type: 'app_mention', channel: 'CSLOW2', user: 'UAHUMAN', text: '<@UBOTLIVE> hi', ts: '1401.000001' },
        body: {},
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.ref).toMatchObject({ channel: 'CSLOW2' })

      // Now let the slow call resolve, and confirm the original thread
      // reply was not lost: it is delivered once the predicate finally
      // answers.
      releaseSlowCall?.()
      await slowDispatch
      expect(events).toHaveLength(2)
      expect(events[1]?.kind).toBe('thread_reply')
      expect(events[1]?.ref).toMatchObject({ channel: 'CSLOW1', thread: '1400.000001', message: '1400.000002' })
    } finally {
      await stop()
    }
  })
})

/**
 * The silent failure mode named in the task brief: if the threadRef the
 * adapter composes for a thread reply did not equal the threadRef an
 * orchestrator composes for that thread's own root message, isKnownSession
 * would never match a genuinely known thread, and every reply would be
 * ignored forever with no error anywhere, indistinguishable from Relay
 * simply not responding. A test that calls composeThreadRef twice with the
 * same pre-matched arguments would only prove the function is
 * deterministic, not that both call sites feed it the right ts, so this
 * drives both sides through the real code paths instead: the root message
 * through the adapter's own delivery, then through contract.ts's
 * sessionRefFor (what Task 8's orchestrator uses to name a session's
 * thread), and the reply through the adapter's real
 * #isChannelEntryAllowed, captured via the isKnownSession spy.
 */
describe('SlackAdapter composeThreadRef round trip (PRE-4)', () => {
  it("composes the same threadRef for a thread reply as an orchestrator would compose for that thread's root message via sessionRefFor", async () => {
    const seenThreadRefs: string[] = []
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
      isKnownSession: async (threadRef) => {
        seenThreadRefs.push(threadRef)
        return false
      },
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })

    // The root message that starts the thread: a channel mention, accepted
    // via app_mention under the existing entry rule.
    await boltApp.dispatch('app_mention', {
      event: { type: 'app_mention', channel: 'CROUNDTRIP1', user: 'UAHUMAN', text: '<@UBOTLIVE> start', ts: '1200.000001' },
      body: {},
    })
    expect(events).toHaveLength(1)
    const rootEvent = events[0]
    if (!rootEvent) throw new Error('root message was not delivered')

    // What Task 8's orchestrator composes when it creates the session off
    // this root message: sessionRefFor names the thread a reply threads
    // against, and composeThreadRef turns that into the store's opaque key.
    const rootSessionRef = sessionRefFor(rootEvent)
    const rootThread = rootSessionRef.thread
    if (rootThread === undefined) throw new Error('sessionRefFor did not return a thread to compose against')
    const threadRefFromRoot = composeThreadRef(rootSessionRef.channel, rootThread)

    // A reply landing in that same thread: thread_ts set to the root
    // message's own ts, exactly what Slack itself sets it to.
    await boltApp.dispatch('message', {
      event: {
        type: 'message',
        channel: 'CROUNDTRIP1',
        user: 'UAHUMAN',
        text: 'a reply',
        ts: '1200.000002',
        thread_ts: '1200.000001',
      },
      body: {},
    })

    expect(seenThreadRefs).toEqual([threadRefFromRoot])
    await adapter.stop()
  })
})

describe('SlackAdapter message subtype filtering', () => {
  async function startWithBolt(): Promise<{
    boltApp: StubBoltApp
    events: ChatEvent[]
    stop: () => Promise<void>
  }> {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })
    return { boltApp, events, stop: () => adapter.stop() }
  }

  it('ignores a message_changed envelope, whose author lives nested under event.message with no top level user or bot_id, which is exactly what the self-message filter cannot match on', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C1',
          ts: '900.000002',
          message: {
            type: 'message',
            user: BOT_USER_ID,
            text: 'Relay smoke test: step 2 of 3, still working...',
            ts: '900.000001',
          },
        },
        body: {},
      })

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  it('ignores a message_deleted envelope, which carries no top level user either', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          subtype: 'message_deleted',
          channel: 'C1',
          ts: '901.000002',
          deleted_ts: '901.000001',
        },
        body: {},
      })

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  it('ignores channel_join housekeeping, a real subtype in IGNORED_MESSAGE_SUBTYPES', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          subtype: 'channel_join',
          channel: 'C1',
          user: 'UAHUMAN',
          text: '<@UAHUMAN> has joined the channel',
          ts: '902.000001',
        },
        body: {},
      })

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  it('ignores channel_topic housekeeping, another real subtype in IGNORED_MESSAGE_SUBTYPES', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          subtype: 'channel_topic',
          channel: 'C1',
          user: 'UAHUMAN',
          text: 'set the channel topic',
          ts: '903.000001',
        },
        body: {},
      })

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  it('still dispatches a thread_broadcast, a real person replying in thread and also sending to channel', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      // A DM, not a channel: thread_ts differs from ts here, which the
      // channel entry policy below now ignores outright for a channel.
      // This test's own point, that thread_broadcast is not itself in
      // IGNORED_MESSAGE_SUBTYPES, does not depend on being in a channel.
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          subtype: 'thread_broadcast',
          channel: 'D904DM',
          user: 'UAHUMAN',
          text: 'also sending this to the channel',
          ts: '904.000002',
          thread_ts: '904.000001',
        },
        body: {},
      })

      expect(events).toHaveLength(1)
      expect(events[0] && unwrapForAudit(events[0].text)).toBe('also sending this to the channel')
    } finally {
      await stop()
    }
  })

  it('still dispatches a real user\'s file_share, proving the bot-authored guard is not blocking everyone', async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      // A DM, not a channel: this test's point is the self-loop guard (see
      // the bot-authored case below), not the channel entry policy, which
      // has its own dedicated describe block.
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'D905DM',
          user: 'UAHUMAN',
          text: 'here is a file',
          ts: '905.000001',
          files: [{ id: 'F1', name: 'a.txt', mimetype: 'text/plain', size: 10, url_private: 'https://example/a.txt' }],
        },
        body: {},
      })

      expect(events).toHaveLength(1)
      expect(events[0]?.files).toHaveLength(1)
    } finally {
      await stop()
    }
  })

  // Per @slack/types' FileShareMessageEvent (the type @slack/bolt ships for
  // this exact subtype), a file_share event never carries `bot_id` at all,
  // only a required `user`. So when Relay uploads its own file, Slack
  // reports it exactly like any other message this bot posted: `user` set
  // to the bot's own user id, no `bot_id` anywhere on the envelope. That
  // means the existing `user === botUserId` check in #shouldIgnore, the
  // same one that guards every other self-authored message, already covers
  // file_share too; nothing file_share specific needed adding. This test is
  // what proves that guard actually reaches this subtype rather than being
  // trusted on the strength of a type definition alone.
  it("ignores a bot-authored file_share: Slack sets user to the bot's own id and carries no bot_id at all on this subtype, so the ordinary self-message guard is what has to catch it", async () => {
    const { boltApp, events, stop } = await startWithBolt()
    try {
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'D906DM',
          user: BOT_USER_ID,
          text: 'Relay uploaded this itself',
          ts: '906.000001',
          files: [{ id: 'F2', name: 'b.txt', mimetype: 'text/plain', size: 5, url_private: 'https://example/b.txt' }],
        },
        body: {},
      })

      expect(events).toHaveLength(0)
    } finally {
      await stop()
    }
  })
})

describe('SlackAdapter perform', () => {
  it("post returns Slack's ts as ref.message, which a subsequent edit uses", async () => {
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp: new StubBoltApp(),
      apiClient,
      sleep: instantSleep,
    })
    await adapter.start(async () => {})

    const posted = await adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'hello' })
    expect(posted.ref.message).toBe('1.000001')
    const message = posted.ref.message
    if (!message) throw new Error('post did not return a message id to edit against')

    await adapter.perform({ kind: 'edit', ref: { channel: 'C1', message }, text: 'edited' })
    expect(apiClient.updated).toEqual([{ channel: 'C1', ts: '1.000001', text: 'edited' }])
  })

  it('post_approval_card posts its text with its blocks', async () => {
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp: new StubBoltApp(),
      apiClient,
      sleep: instantSleep,
    })
    await adapter.start(async () => {})
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'card' } }]

    const result = await adapter.perform({ kind: 'post_approval_card', ref: { channel: 'C1', thread: '5.1' }, text: 'Approval needed', blocks })

    expect(apiClient.posted).toEqual([{ channel: 'C1', thread: '5.1', text: 'Approval needed', blocks }])
    expect(result.ref).toEqual({ channel: 'C1', thread: '5.1', message: '1.000001' })
  })

  it('react calls reactions.add with the message ts and the emoji name', async () => {
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp: new StubBoltApp(),
      apiClient,
      sleep: instantSleep,
    })
    await adapter.start(async () => {})

    const result = await adapter.perform({ kind: 'react', ref: { channel: 'C1', message: '9.000001' }, name: 'eyes' })

    expect(apiClient.reactions).toEqual([{ channel: 'C1', ts: '9.000001', name: 'eyes' }])
    expect(result.ref).toEqual({ channel: 'C1', message: '9.000001' })
  })

  it('rejects a post whose text exceeds maxMessageBytes, naming the reason', async () => {
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp: new StubBoltApp(),
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    await adapter.start(async () => {})

    await expect(
      adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'x'.repeat(40_001) }),
    ).rejects.toThrow(/maxMessageBytes|exceeds/)
  })

  it('retries once on a rate limited response and succeeds, waiting the amount Slack asked for', async () => {
    const apiClient = new StubSlackApiClient()
    apiClient.failNextCallsWithRateLimit(1, 2)
    const waits: number[] = []
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp: new StubBoltApp(),
      apiClient,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    await adapter.start(async () => {})

    const result = await adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'hi' })

    expect(waits).toEqual([2000])
    expect(apiClient.posted).toHaveLength(1)
    expect(result.ref.message).toBeDefined()
  })

  it('gives up after maxRateLimitRetries and rethrows the rate limited error rather than hanging or silently dropping the action', async () => {
    const apiClient = new StubSlackApiClient()
    apiClient.failNextCallsWithRateLimit(10, 1)
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp: new StubBoltApp(),
      apiClient,
      sleep: instantSleep,
      maxRateLimitRetries: 2,
    })
    await adapter.start(async () => {})

    await expect(adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'hi' })).rejects.toThrow(
      /rate limited/,
    )
    expect(apiClient.posted).toHaveLength(0)
  })
})

/** Chains a fixed number of microtask ticks, enough for #handleRawEnvelope's own await chain (channel entry check, principal resolution, dispatch()'s synchronous #deliveryQueue assignment) to run to completion even when the handler at the end of that chain never itself resolves. Real timers are untouched; this only drains microtasks, never a macrotask queue, so it needs no fake timer setup. */
async function flushMicrotasks(times = 50): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}

/**
 * These two fixes were made during the P0.3 gate fix wave and then never
 * committed: five subsequent commits landed without them, and the gate
 * verdict was recorded PASS over code that had neither. Both are correct;
 * neither had a test, which is what let them go missing undetected for five
 * commits. This describes the bounded shutdown half (was gate finding
 * Medium 1); the Stop dedupe ordering half follows in the next describe
 * block below.
 */
describe('SlackAdapter stop() bounded shutdown (orphaned gate fix, Medium 1)', () => {
  it('a handler that never resolves does not wedge stop(): it still returns, within the bounded wait, and never throws', async () => {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    // A handler that never settles, standing in for a wedged engine
    // subprocess or a database call stuck past every timeout of its own.
    await adapter.start(() => new Promise<void>(() => {}))

    // Fire-and-forget: this outer dispatch promise can never resolve either,
    // since it awaits the very handler invocation above. Flushing
    // microtasks below is what proves the delivery reached #deliveryQueue
    // without needing to await this promise to completion.
    void boltApp.dispatch('app_mention', {
      event: { type: 'app_mention', channel: 'CHANG1', user: 'UAHUMAN', text: '<@UBOTLIVE> hang forever', ts: '2200.000001' },
      body: {},
    })
    await flushMicrotasks()

    const startedAt = Date.now()
    await expect(adapter.stop()).resolves.toBeUndefined()
    const elapsedMs = Date.now() - startedAt

    // Bounded near the adapter's own settle timeout (STOP_DELIVERY_SETTLE_TIMEOUT_MS,
    // 15 seconds, not exported), never "forever": the old, orphaned
    // unbounded `await this.#deliveryQueue` would have hung this await past
    // Vitest's own test timeout instead of returning at all. The lower
    // bound proves stop() genuinely waited out the settle window rather
    // than returning immediately and abandoning the hung handler unbounded
    // in the background; the upper bound proves it did not wait
    // meaningfully longer than that window either.
    expect(elapsedMs).toBeGreaterThanOrEqual(14_000)
    expect(elapsedMs).toBeLessThan(20_000)
    expect(boltApp.stopped).toBe(true)
  }, 25_000)

  it('still awaits genuine in-flight delivery that settles well within the bound, rather than abandoning it: the whole point of awaiting in the first place', async () => {
    const order: string[] = []
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    await adapter.start(async () => {
      order.push('handler-start')
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
      order.push('handler-resolved')
    })

    const dispatched = boltApp.dispatch('app_mention', {
      event: { type: 'app_mention', channel: 'CINFLIGHT1', user: 'UAHUMAN', text: '<@UBOTLIVE> in flight', ts: '2201.000001' },
      body: {},
    })
    // Give the handler a moment to genuinely be in flight before stop()
    // races it, rather than calling stop() before delivery even starts.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const stopStartedAt = Date.now()
    await adapter.stop()
    const stopElapsedMs = Date.now() - stopStartedAt
    order.push('stop-returned')

    // The handler's own 200ms delay resolved BEFORE stop() returned, not
    // merely before this assertion runs: an abandon-on-shutdown regression
    // (stop() returning immediately without waiting) would still let the
    // background handler resolve eventually, so ordering, not just "did it
    // resolve", is what proves stop() actually waited.
    expect(order).toEqual(['handler-start', 'handler-resolved', 'stop-returned'])
    // Settled genuinely, via the real delivery completing, nowhere near the
    // 15 second bound that only the previous (hung handler) test exercises.
    expect(stopElapsedMs).toBeGreaterThanOrEqual(100)
    expect(stopElapsedMs).toBeLessThan(5_000)
    expect(boltApp.stopped).toBe(true)

    await dispatched
  })
})

/**
 * The Stop dedupe ordering half of the same orphaned pair. This one is a
 * GT-14 failure: HEAD claimed the dedupe key at #recentEvents.add(dedupeKey)
 * BEFORE reading `this.#handler`, so a Stop arriving when no handler is
 * registered burned its dedupe key on a Stop that was never delivered, and
 * Slack's automatic retry of that identical envelope was then silently
 * dropped as a duplicate: the Stop lost for good, in the exact code path
 * the fix wave existed to create. The working tree fix reorders this: the
 * key is claimed only once a handler actually exists to receive the event.
 *
 * "No handler registered" is reached here through the same window the
 * adapter's own #handleRawEnvelope comment names: after stop() has cleared
 * #handler. Restarting the same adapter afterward, to prove the retry is
 * genuinely delivered once a handler exists again, re-registers a second
 * pair of listeners on StubBoltApp (start() does not know it is being
 * called a second time on an already-stopped instance). That duplication is
 * harmless to what this test proves: both listeners read the SAME
 * #recentEvents/#handler instance fields at call time, so the dedupe check
 * itself, the exact mechanism under test, is what keeps the retry a single
 * delivery rather than two.
 */
describe('SlackAdapter Stop dedupe ordering (orphaned gate fix, GT-14)', () => {
  it('a Stop arriving with no handler registered does not claim the dedupe key, so Slack redelivering the identical envelope is delivered once a handler exists', async () => {
    const boltApp = new StubBoltApp()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient: new StubSlackApiClient(),
      sleep: instantSleep,
    })
    const events: ChatEvent[] = []
    await adapter.start(async (event) => {
      events.push(event)
    })
    // Clears #handler (and #dispatch), but this stub's registered listeners
    // are not torn down by stop(), mirroring the real race the adapter's
    // own comment names: an envelope reaching a still-registered listener
    // after stop() has already cleared the handler it would deliver to.
    await adapter.stop()

    const stopEnvelope = { type: 'message', channel: 'D1STOP', user: 'UAHUMAN', text: 'stop', ts: '2300.000001' }

    // The Stop arrives while no handler is registered. If the old, orphaned
    // ordering were still in place (claim the key, THEN check the handler),
    // this alone would burn the dedupe key on a Stop that was never
    // delivered.
    await boltApp.dispatch('message', { event: stopEnvelope, body: {} })
    expect(events).toHaveLength(0)

    // A handler exists again. Slack's own retry-on-no-ack behaviour redelivers
    // the IDENTICAL envelope, same channel, same ts, nothing about it changed.
    await adapter.start(async (event) => {
      events.push(event)
    })
    await boltApp.dispatch('message', { event: stopEnvelope, body: {} })

    // Delivered exactly once: the dedupe key was never claimed by the first,
    // handler-less attempt, so this retry is treated as a fresh envelope and
    // genuinely reaches the handler, not silently dropped as a duplicate of
    // an event that in truth was never delivered.
    expect(events).toHaveLength(1)
    expect(events[0] && unwrapForAudit(events[0].text)).toBe('stop')
    await adapter.stop()
  })
})

/**
 * Task 4 (P0.4): Block Kit approval interactions. Every test here drives the
 * REAL listeners SlackAdapter.start() registers (via StubBoltApp's
 * dispatchAction/dispatchView, the same "real handler, stub transport"
 * shape the rest of this file already uses for app_mention/message), with a
 * fake resolveApprovalInteraction standing in for src/approvals/store.ts's
 * resolveApproval. The DB-backed proof that a real Slack payload reaches a
 * real Postgres row is test/chat/slack/adapter-approvals.test.ts, not here;
 * these tests instead pin the adapter's own decoding, modal-opening, and
 * card-update wiring in isolation from Postgres, the way every other test
 * in this file pins SlackAdapter behaviour against stubs.
 */
describe('SlackAdapter approval interactions', () => {
  function approvalButtonEnvelope(
    actionId: string,
    value: Record<string, unknown>,
    overrides: Partial<SlackBlockActionEnvelope> = {},
  ): SlackBlockActionEnvelope {
    return {
      actions: [{ action_id: actionId, type: 'button', value: JSON.stringify(value) }],
      user: { id: 'UAPPROVER' },
      channel: { id: 'C1' },
      message: { ts: '1700000000.000100' },
      trigger_id: 'trigger_123',
      ...overrides,
    }
  }

  /** Records every request the fake resolver observed, and returns whatever canned result it was configured with. */
  function fakeResolver(
    result: ResolveApprovalResult | undefined,
  ): { fn: (request: ApprovalInteractionRequest) => Promise<ResolveApprovalResult | undefined>; calls: ApprovalInteractionRequest[] } {
    const calls: ApprovalInteractionRequest[] = []
    return {
      calls,
      fn: async (request) => {
        calls.push(request)
        return result
      },
    }
  }

  /** A resolver that always rejects, standing in for a real database call failing mid-flight; fix round 1's operator-visible-failure tests drive their approval interactions through this. */
  function throwingResolver(): (request: ApprovalInteractionRequest) => Promise<ResolveApprovalResult | undefined> {
    return async () => {
      throw new Error('simulated internal failure')
    }
  }

  function resolvedApproval(overrides: Partial<ResolveApprovalResult['approval']> = {}): NonNullable<ResolveApprovalResult['approval']> {
    return {
      id: 'apr_1',
      workspaceId: 'ws_1',
      runId: 'run_1',
      sessionId: 'sess_1',
      requesterPrincipalId: 'prn_requester',
      capability: 'shell.exec',
      description: 'Delete old exports',
      target: 'rm -rf ~/Downloads/old-exports',
      tier: 'irreversible',
      escalationReason: 'irreversible-tier action always requires approval',
      requiredRoles: ['operator'],
      requiresTypedConfirmation: false,
      status: 'approved',
      selectedOption: 'approve',
      resolvedByPrincipalId: 'prn_approver',
      resolvedAt: '2026-08-10T12:00:00.000Z',
      editedArguments: null,
      timeoutAt: '2026-08-10T12:30:00.000Z',
      createdAt: '2026-08-10T11:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
      kind: 'standard',
      allowedPrincipalIds: null,
      operationId: null,
      receipt: null,
      ...overrides,
    }
  }

  it('Approve (no typed confirmation) resolves through the real listener and updates the card in place', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const resolver = fakeResolver({ outcome: 'resolved', approval: resolvedApproval() })
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolvePrincipalId: async () => 'prn_approver',
      resolveApprovalInteraction: resolver.fn,
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(
      APPROVAL_ACTION_IDS.approve,
      approvalButtonEnvelope(APPROVAL_ACTION_IDS.approve, { approvalId: 'apr_1', requiresTypedConfirmation: false }),
    )

    expect(resolver.calls).toEqual([
      { approvalId: 'apr_1', option: 'approve', resolverPlatformUserId: 'UAPPROVER', resolverPrincipalId: 'prn_approver' },
    ])
    expect(apiClient.updated).toHaveLength(1)
    expect(apiClient.updated[0]).toMatchObject({ channel: 'C1', ts: '1700000000.000100' })
    expect(apiClient.updated[0]?.text).toContain('Approved')
    expect(apiClient.openedModals).toHaveLength(0)
    await adapter.stop()
  })

  it('Deny resolves through the real listener and updates the card', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const resolver = fakeResolver({
      outcome: 'resolved',
      approval: resolvedApproval({ status: 'denied', selectedOption: 'deny' }),
    })
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolveApprovalInteraction: resolver.fn,
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(APPROVAL_ACTION_IDS.deny, approvalButtonEnvelope(APPROVAL_ACTION_IDS.deny, { approvalId: 'apr_1' }))

    expect(resolver.calls[0]).toMatchObject({ approvalId: 'apr_1', option: 'deny' })
    expect(apiClient.updated[0]?.text).toContain('Denied')
    await adapter.stop()
  })

  it('Approve all of this type for this session resolves directly, no modal', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const resolver = fakeResolver({
      outcome: 'resolved',
      approval: resolvedApproval({ selectedOption: 'approve_all_session' }),
    })
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolveApprovalInteraction: resolver.fn,
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(
      APPROVAL_ACTION_IDS.approveAllSession,
      approvalButtonEnvelope(APPROVAL_ACTION_IDS.approveAllSession, { approvalId: 'apr_1' }),
    )

    expect(resolver.calls[0]).toMatchObject({ approvalId: 'apr_1', option: 'approve_all_session' })
    expect(apiClient.openedModals).toHaveLength(0)
    expect(apiClient.updated).toHaveLength(1)
    await adapter.stop()
  })

  it('a non-resolved outcome (e.g. unauthorized) leaves the card untouched', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const resolver = fakeResolver({ outcome: 'unauthorized', approval: { ...resolvedApproval(), status: 'pending', selectedOption: null } })
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolveApprovalInteraction: resolver.fn,
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(
      APPROVAL_ACTION_IDS.approve,
      approvalButtonEnvelope(APPROVAL_ACTION_IDS.approve, { approvalId: 'apr_1', requiresTypedConfirmation: false }),
    )

    expect(apiClient.updated).toHaveLength(0)
    await adapter.stop()
  })

  it('when no resolver is wired (the default), the interaction is received and ignored, never crashes, never fakes a resolution', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), { boltApp, apiClient, sleep: instantSleep })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(
      APPROVAL_ACTION_IDS.deny,
      approvalButtonEnvelope(APPROVAL_ACTION_IDS.deny, { approvalId: 'apr_1' }),
    )

    expect(apiClient.updated).toHaveLength(0)
    await adapter.stop()
  })

  describe('FR-APR-5: typed confirmation opens a modal instead of resolving on click', () => {
    it('Approve on a card whose value declares requiresTypedConfirmation opens the confirmation modal and does not resolve yet', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'resolved', approval: resolvedApproval() })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.approve,
        approvalButtonEnvelope(APPROVAL_ACTION_IDS.approve, { approvalId: 'apr_1', requiresTypedConfirmation: true }),
      )

      expect(resolver.calls).toHaveLength(0)
      expect(apiClient.updated).toHaveLength(0)
      expect(apiClient.openedModals).toHaveLength(1)
      expect(apiClient.openedModals[0]?.triggerId).toBe('trigger_123')
      expect(apiClient.openedModals[0]?.view.callback_id).toBe(CONFIRM_MODAL_CALLBACK_ID)
      expect(parseModalMetadata(apiClient.openedModals[0]?.view.private_metadata as string)).toEqual({
        approvalId: 'apr_1',
        channel: 'C1',
        messageTs: '1700000000.000100',
      })
      await adapter.stop()
    })

    it('submitting the confirmation modal with a wrong token keeps it open with an inline error and does not resolve', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'confirmation_mismatch', approval: { ...resolvedApproval(), status: 'pending', selectedOption: null } })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(CONFIRM_MODAL_CALLBACK_ID, {
        view: {
          callback_id: CONFIRM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [CONFIRM_MODAL_BLOCK_ID]: { [CONFIRM_MODAL_ACTION_ID]: { value: 'nope' } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response).toEqual({ response_action: 'errors', errors: expect.objectContaining({ [CONFIRM_MODAL_BLOCK_ID]: expect.any(String) }) })
      expect(resolver.calls[0]).toMatchObject({ approvalId: 'apr_1', option: 'approve', typedConfirmation: 'nope' })
      expect(apiClient.updated).toHaveLength(0)
      await adapter.stop()
    })

    it('submitting the confirmation modal with the correct token resolves and updates the card', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'resolved', approval: resolvedApproval({ requiresTypedConfirmation: true }) })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(CONFIRM_MODAL_CALLBACK_ID, {
        view: {
          callback_id: CONFIRM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [CONFIRM_MODAL_BLOCK_ID]: { [CONFIRM_MODAL_ACTION_ID]: { value: CONFIRMATION_TOKEN } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response).toBeUndefined()
      expect(resolver.calls[0]).toMatchObject({ approvalId: 'apr_1', option: 'approve', typedConfirmation: CONFIRMATION_TOKEN })
      expect(apiClient.updated).toHaveLength(1)
      await adapter.stop()
    })
  })

  describe('FR-APR-2: edit and approve opens a modal to collect free text', () => {
    it('Edit and approve opens the edit modal', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'resolved', approval: resolvedApproval() })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.editAndApprove,
        approvalButtonEnvelope(APPROVAL_ACTION_IDS.editAndApprove, { approvalId: 'apr_1' }),
      )

      expect(resolver.calls).toHaveLength(0)
      expect(apiClient.openedModals[0]?.view.callback_id).toBe(EDIT_MODAL_CALLBACK_ID)
      await adapter.stop()
    })

    it('submitting the edit modal resolves with option edit_and_approve and the typed text', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({
        outcome: 'resolved',
        approval: resolvedApproval({ selectedOption: 'edit_and_approve', editedArguments: 'revised target' }),
      })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(EDIT_MODAL_CALLBACK_ID, {
        view: {
          callback_id: EDIT_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [EDIT_MODAL_BLOCK_ID]: { [EDIT_MODAL_ACTION_ID]: { value: 'revised target' } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response).toBeUndefined()
      expect(resolver.calls[0]).toMatchObject({ approvalId: 'apr_1', option: 'edit_and_approve', editedArguments: 'revised target' })
      expect(JSON.stringify(apiClient.updated[0]?.blocks)).toContain('revised target')
      await adapter.stop()
    })

    it('an edit whose value fails capability-schema validation keeps the modal open with an inline error, per outcome invalid_input', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({
        outcome: 'invalid_input',
        approval: { ...resolvedApproval(), status: 'pending', selectedOption: null },
      })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(EDIT_MODAL_CALLBACK_ID, {
        view: {
          callback_id: EDIT_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [EDIT_MODAL_BLOCK_ID]: { [EDIT_MODAL_ACTION_ID]: { value: 'not json' } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response?.response_action).toBe('errors')
      expect(apiClient.updated).toHaveLength(0)
      await adapter.stop()
    })
  })

  /**
   * Fix round 1, finding 4: an internal failure while resolving an
   * approval (the injected resolver throwing, standing in for a real
   * database call failing mid-flight) must never be indistinguishable from
   * a click that quietly succeeded. Every test here drives the REAL
   * listener with a resolver built to throw, and asserts what the operator
   * ends up seeing (a posted message, or an inline modal error that keeps
   * the modal open), not merely that something was logged.
   */
  describe('fix round 1: operator-visible failure reporting on an internal error', () => {
    it('a button click whose resolver throws posts a "not recorded" reply to the thread and leaves the card untouched', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: throwingResolver(),
      })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.deny,
        approvalButtonEnvelope(APPROVAL_ACTION_IDS.deny, { approvalId: 'apr_1' }),
      )

      // The card itself must never look resolved: no card update at all.
      expect(apiClient.updated).toHaveLength(0)
      // But the operator is told, explicitly, that their click did not work.
      expect(apiClient.posted).toHaveLength(1)
      expect(apiClient.posted[0]?.channel).toBe('C1')
      expect(apiClient.posted[0]?.thread).toBe('1700000000.000100')
      expect(apiClient.posted[0]?.text).toMatch(/not.*record|could not/i)
      await adapter.stop()
    })

    it('an unwired resolver (no callback configured) also reports failure, not silent inaction', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      // No resolveApprovalInteraction supplied: the default "unwired" seam.
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), { boltApp, apiClient, sleep: instantSleep })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.approve,
        approvalButtonEnvelope(APPROVAL_ACTION_IDS.approve, { approvalId: 'apr_1', requiresTypedConfirmation: false }),
      )

      expect(apiClient.updated).toHaveLength(0)
      expect(apiClient.posted).toHaveLength(1)
      await adapter.stop()
    })

    it('a confirmation modal submission whose resolver throws keeps the modal open with an inline error, never silently closes as if recorded', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: throwingResolver(),
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(CONFIRM_MODAL_CALLBACK_ID, {
        view: {
          callback_id: CONFIRM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [CONFIRM_MODAL_BLOCK_ID]: { [CONFIRM_MODAL_ACTION_ID]: { value: CONFIRMATION_TOKEN } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      // The response the real Bolt wiring would `ack()` with: 'errors' keeps
      // the modal open, `undefined` would close it as if it succeeded.
      expect(response?.response_action).toBe('errors')
      expect(apiClient.updated).toHaveLength(0)
      await adapter.stop()
    })

    it('an edit modal submission whose resolver throws keeps the modal open with an inline error', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: throwingResolver(),
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(EDIT_MODAL_CALLBACK_ID, {
        view: {
          callback_id: EDIT_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [EDIT_MODAL_BLOCK_ID]: { [EDIT_MODAL_ACTION_ID]: { value: '{"command":"x"}' } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response?.response_action).toBe('errors')
      expect(apiClient.updated).toHaveLength(0)
      await adapter.stop()
    })

  })

  /**
   * Fix round 2: every outcome resolveApproval can return, not only the
   * three that already had bespoke handling (resolved, confirmation
   * required/mismatch, invalid_input), must reach the operator, per the
   * team lead's finding that a rejected edit closing the modal with no
   * error is indistinguishable, to the operator, from it having worked.
   * `not_found`, `already_resolved`, `expired`, and `unauthorized` used to
   * fall through to a bare log line; each now has its own worded message,
   * exhaustively (UNRESOLVED_OUTCOME_DESCRIPTIONS's own type requires an
   * entry for every one), and each test asserts what the operator actually
   * sees, not merely that something was logged.
   */
  describe('fix round 2: every non-resolved outcome is reported to the operator, not only the ones with bespoke handling', () => {
    const buttonPathOutcomes = ['not_found', 'already_resolved', 'expired', 'unauthorized'] as const

    it.each(buttonPathOutcomes)('a button click resolving to outcome %s posts that outcome\'s own message to the thread', async (outcome) => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome, approval: null })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.deny,
        approvalButtonEnvelope(APPROVAL_ACTION_IDS.deny, { approvalId: 'apr_1' }),
      )

      expect(apiClient.updated).toHaveLength(0)
      expect(apiClient.posted).toHaveLength(1)
      expect(apiClient.posted[0]?.text).toBe(UNRESOLVED_OUTCOME_DESCRIPTIONS[outcome])
      await adapter.stop()
    })

    it('a confirmation modal submission resolving to already_resolved keeps the modal open with that outcome\'s own message', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'already_resolved', approval: null })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(CONFIRM_MODAL_CALLBACK_ID, {
        view: {
          callback_id: CONFIRM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [CONFIRM_MODAL_BLOCK_ID]: { [CONFIRM_MODAL_ACTION_ID]: { value: CONFIRMATION_TOKEN } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response).toEqual({
        response_action: 'errors',
        errors: { [CONFIRM_MODAL_BLOCK_ID]: UNRESOLVED_OUTCOME_DESCRIPTIONS.already_resolved },
      })
      expect(apiClient.updated).toHaveLength(0)
      await adapter.stop()
    })

    it('an edit modal submission resolving to expired keeps the modal open with that outcome\'s own message', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'expired', approval: null })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(EDIT_MODAL_CALLBACK_ID, {
        view: {
          callback_id: EDIT_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [EDIT_MODAL_BLOCK_ID]: { [EDIT_MODAL_ACTION_ID]: { value: '{"command":"x"}' } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response).toEqual({
        response_action: 'errors',
        errors: { [EDIT_MODAL_BLOCK_ID]: UNRESOLVED_OUTCOME_DESCRIPTIONS.expired },
      })
      expect(apiClient.updated).toHaveLength(0)
      await adapter.stop()
    })
  })

  /**
   * Fix round 2 addendum, per the team lead's finding: a single shared
   * outcome-description map, indexed generically at each surface's final
   * fallback, let one surface render another surface's wording for an
   * outcome it could never legitimately produce (a confirmation modal
   * showing edit-modal text for `invalid_input`, or vice versa), invisible
   * to the type checker because the narrowed outcome type at a generic
   * fallback was still a superset of what that surface could actually
   * return. Each handler now explicitly excludes the outcomes that do not
   * belong to it before reaching a fallback typed against
   * GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS's narrower four-key set, which
   * TypeScript itself refuses to index with anything outside that set.
   * These tests drive the real listeners with a resolver return value that
   * should be unreachable in that context and assert the CORRECT,
   * surface-appropriate response, not merely that something rendered.
   */
  describe('fix round 2 addendum: outcome wording matches the surface that produced it', () => {
    it('a confirmation modal that somehow receives invalid_input reports an internal error, never the edit modal\'s JSON wording', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'invalid_input', approval: null })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(CONFIRM_MODAL_CALLBACK_ID, {
        view: {
          callback_id: CONFIRM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [CONFIRM_MODAL_BLOCK_ID]: { [CONFIRM_MODAL_ACTION_ID]: { value: CONFIRMATION_TOKEN } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response?.response_action).toBe('errors')
      const message = response && 'errors' in response ? response.errors[CONFIRM_MODAL_BLOCK_ID] : undefined
      expect(message).not.toContain('JSON')
      expect(apiClient.updated).toHaveLength(0)
      await adapter.stop()
    })

    it('an edit modal that somehow receives confirmation_mismatch reports an internal error, never the confirmation wording', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'confirmation_mismatch', approval: null })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      const response = await boltApp.dispatchView(EDIT_MODAL_CALLBACK_ID, {
        view: {
          callback_id: EDIT_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: 'apr_1', channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [EDIT_MODAL_BLOCK_ID]: { [EDIT_MODAL_ACTION_ID]: { value: '{"command":"x"}' } } } },
        },
        user: { id: 'UAPPROVER' },
      })

      expect(response?.response_action).toBe('errors')
      const message = response && 'errors' in response ? response.errors[EDIT_MODAL_BLOCK_ID] : undefined
      expect(message).not.toContain(CONFIRMATION_TOKEN)
      expect(apiClient.updated).toHaveLength(0)
      await adapter.stop()
    })

    it('a button click that receives invalid_input (should be unreachable outside edit_and_approve) reports a generic internal-error message, not the edit modal\'s JSON wording', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'invalid_input', approval: null })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.deny,
        approvalButtonEnvelope(APPROVAL_ACTION_IDS.deny, { approvalId: 'apr_1' }),
      )

      expect(apiClient.updated).toHaveLength(0)
      expect(apiClient.posted).toHaveLength(1)
      expect(apiClient.posted[0]?.text).not.toContain('JSON')
      await adapter.stop()
    })

    /**
     * The deliberate decision, not a side effect: a button click can reach
     * confirmation_required/confirmation_mismatch only if the button's own
     * encoded value disagreed with the approval's actual
     * requires_typed_confirmation (a stale or mismatched card, since that
     * field never changes after creation). Rather than silently dropping
     * this mismatch, it is reported to the thread with the same wording
     * the confirmation modal itself would show, which is accurate
     * regardless of surface.
     */
    it('a button click that receives confirmation_required (a stale-card mismatch) posts the confirmation wording to the thread, not silence', async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const resolver = fakeResolver({ outcome: 'confirmation_required', approval: null })
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolveApprovalInteraction: resolver.fn,
      })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.approve,
        approvalButtonEnvelope(APPROVAL_ACTION_IDS.approve, { approvalId: 'apr_1', requiresTypedConfirmation: false }),
      )

      expect(apiClient.updated).toHaveLength(0)
      expect(apiClient.posted).toHaveLength(1)
      expect(apiClient.posted[0]?.text).toBe(UNRESOLVED_OUTCOME_DESCRIPTIONS.confirmation_required)
      await adapter.stop()
    })
  })
})

/**
 * FR-ATT-5: the "sessions" command and the session-attach button. Every
 * test here drives the REAL listeners SlackAdapter.start() registers, the
 * same "real handler, stub transport" shape test/chat/slack/adapter.test.ts
 * already uses for approvals: boltApp.dispatch('message', ...) for the
 * command, boltApp.dispatchAction(SESSION_ATTACH_ACTION_ID, ...) for the
 * button. A test that called #handleSessionsCommand or
 * #handleSessionAttachButton directly would prove nothing about whether a
 * real Slack message or button click can reach them at all, the exact gap
 * that let P0.3 ship a Stop nothing could trigger from Slack. The
 * DB-backed proof that a real attach reaches a real Postgres row is
 * test/chat/slack/adapter-sessions.test.ts, not here; these tests instead
 * pin the adapter's own command detection, rendering, decoding, and
 * failure-reporting wiring against stubs.
 */
describe('SlackAdapter session attach (FR-ATT-5)', () => {
  function sessionsCommandEnvelope(overrides: Partial<{ channel: string; ts: string; threadTs: string }> = {}) {
    return {
      event: {
        type: 'message',
        channel: overrides.channel ?? 'D1SESS',
        user: 'UOPERATOR',
        text: 'sessions',
        ts: overrides.ts ?? '3000.000001',
        ...(overrides.threadTs !== undefined ? { thread_ts: overrides.threadTs } : {}),
      },
      body: {},
    }
  }

  function sessionAttachButtonEnvelope(
    value: Record<string, unknown>,
    overrides: Partial<SlackBlockActionEnvelope> = {},
  ): SlackBlockActionEnvelope {
    return {
      actions: [{ action_id: SESSION_ATTACH_ACTION_ID, type: 'button', value: JSON.stringify(value) }],
      user: { id: 'UOPERATOR' },
      channel: { id: 'D1SESS' },
      message: { ts: '3000.000005' },
      ...overrides,
    }
  }

  /**
   * What PRODUCTION now sends: a `static_select`, whose payload arrives in
   * `selected_option.value` rather than in `value`.
   *
   * Every attach test dispatched a `button` with a top-level `value`, so
   * after the picker became a dropdown the whole suite exercised only the
   * legacy fallback branch and the live path had no coverage at all.
   */
  function sessionAttachSelectEnvelope(
    value: Record<string, unknown>,
    overrides: Partial<SlackBlockActionEnvelope> = {},
  ): SlackBlockActionEnvelope {
    return {
      actions: [
        {
          action_id: SESSION_ATTACH_ACTION_ID,
          type: 'static_select',
          selected_option: { value: JSON.stringify(value) },
        },
      ],
      user: { id: 'UOPERATOR' },
      channel: { id: 'D1SESS' },
      message: { ts: '3000.000005' },
      ...overrides,
    }
  }

  function buildSession(overrides: Partial<EngineSession> = {}): EngineSession {
    return {
      sessionId: 'sess-1',
      cwd: '/Users/operator/project-a',
      lastModifiedAt: new Date(),
      sizeBytes: 100,
      ...overrides,
    }
  }

  /** Records every call, so a test can assert both what was passed and how many times, mirroring fakeResolver's own shape in the approvals describe block above. */
  function fakeAttach(
    result: AttachThreadToSessionResult | undefined,
  ): {
    fn: (params: AttachThreadToSessionParams) => Promise<AttachThreadToSessionResult | undefined>
    calls: AttachThreadToSessionParams[]
  } {
    const calls: AttachThreadToSessionParams[] = []
    return {
      calls,
      fn: async (params) => {
        calls.push(params)
        return result
      },
    }
  }

  it('the "sessions" command, dispatched through the real listener, posts the rendered list into the same thread', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      listRecentSessions: async (limit) => {
        expect(limit).toBeGreaterThan(0)
        return [buildSession({ cwd: '/Users/operator/project-a' })]
      },
    })
    await adapter.start(async () => {
      throw new Error('the sessions command must never reach the orchestrator handler')
    })

    await boltApp.dispatch('message', sessionsCommandEnvelope())

    expect(apiClient.posted).toHaveLength(1)
    expect(apiClient.posted[0]?.channel).toBe('D1SESS')
    expect(apiClient.posted[0]?.thread).toBe('3000.000001')
    expect(JSON.stringify(apiClient.posted[0]?.blocks)).toContain('/Users/operator/project-a')
    await adapter.stop()
  })

  it('is case-insensitive and trims surrounding whitespace, matching isStopInstruction\'s own matching style', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      listRecentSessions: async () => [buildSession()],
    })
    await adapter.start(async () => {})

    await boltApp.dispatch('message', {
      event: { type: 'message', channel: 'D1SESS', user: 'UOPERATOR', text: '  Sessions  ', ts: '3001.000001' },
      body: {},
    })

    expect(apiClient.posted).toHaveLength(1)
    await adapter.stop()
  })

  it('an ordinary message (not the exact command) is not treated as the sessions command', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const events: ChatEvent[] = []
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      listRecentSessions: async () => [buildSession()],
    })
    await adapter.start(async (event) => {
      events.push(event)
    })

    await boltApp.dispatch('message', {
      event: { type: 'message', channel: 'D1SESS', user: 'UOPERATOR', text: 'show me the sessions please', ts: '3002.000001' },
      body: {},
    })

    expect(apiClient.posted).toHaveLength(0)
    expect(events).toHaveLength(1)
    await adapter.stop()
  })

  it('reports an honest "no sessions found" when listRecentSessions is left unwired (the default)', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), { boltApp, apiClient, sleep: instantSleep })
    await adapter.start(async () => {})

    await boltApp.dispatch('message', sessionsCommandEnvelope())

    expect(apiClient.posted).toHaveLength(1)
    expect(apiClient.posted[0]?.text).toMatch(/no.*sessions/i)
    await adapter.stop()
  })

  it('a listRecentSessions failure is reported into the thread, not only logged', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      listRecentSessions: async () => {
        throw new Error('simulated discovery failure')
      },
    })
    await adapter.start(async () => {})

    await boltApp.dispatch('message', sessionsCommandEnvelope())

    expect(apiClient.posted).toHaveLength(1)
    expect(apiClient.posted[0]?.text).toMatch(/could not list sessions/i)
    await adapter.stop()
  })

  it('/sessions, dispatched as a real slash command, posts the picker at top level', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      listRecentSessions: async () => [buildSession()],
    })
    await adapter.start(async () => {})

    await boltApp.dispatchCommand('/sessions', {
      channel_id: 'D1SESS',
      user_id: 'UOPERATOR',
      text: '',
    })

    expect(apiClient.posted).toHaveLength(1)
    // Top level, with no thread: a slash command has no thread of its own,
    // and the card's own ts becomes the root the Attach click then reads
    // off its envelope.
    expect(apiClient.posted[0]?.channel).toBe('D1SESS')
    expect(apiClient.posted[0]?.thread).toBeUndefined()
    expect(JSON.stringify(apiClient.posted[0]?.blocks ?? [])).toContain('/Users/operator/project-a')
    await adapter.stop()
  })

  it('clicking Attach, dispatched through the real listener, calls attachThreadToSession with the decoded session and the resolved principal', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const attach = fakeAttach({ relaySessionId: 'relay-sess-1' })
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolvePrincipalId: async (platformUserId) => (platformUserId === 'UOPERATOR' ? 'prn_operator' : null),
      listRecentSessions: async () => [buildSession({ sessionId: 'claude-sess-1' })],
      attachThreadToSession: attach.fn,
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(
      SESSION_ATTACH_ACTION_ID,
      sessionAttachButtonEnvelope({
        engineSessionId: 'claude-sess-1',
        engineCwd: '/Users/operator/project-a',
        channel: 'D1SESS',
        thread: '3000.000001',
      }),
    )

    expect(attach.calls).toEqual([
      {
        threadRef: composeThreadRef('D1SESS', '3000.000005'),
        principalId: 'prn_operator',
        engineSessionId: 'claude-sess-1',
        engineCwd: '/Users/operator/project-a',
      },
    ])
    await adapter.stop()
  })

  it('attaches from a DROPDOWN selection, which is what production sends', async () => {
    // The picker became a static_select, and a select delivers its payload
    // in `selected_option.value`, not in `value`. Every test here dispatched
    // a button, so the whole suite exercised the legacy fallback and the
    // live path had no coverage at all.
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const attach = fakeAttach({ relaySessionId: 'relay-sess-2' })
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolvePrincipalId: async (platformUserId) => (platformUserId === 'UOPERATOR' ? 'prn_operator' : null),
      listRecentSessions: async () => [buildSession({ sessionId: 'claude-sess-1' })],
      attachThreadToSession: attach.fn,
    })
    await adapter.start(async () => {})

    // Only the session id, which is all the option value carries now.
    await boltApp.dispatchAction(
      SESSION_ATTACH_ACTION_ID,
      sessionAttachSelectEnvelope({ engineSessionId: 'claude-sess-1' }),
    )

    expect(attach.calls).toEqual([
      {
        threadRef: composeThreadRef('D1SESS', '3000.000005'),
        principalId: 'prn_operator',
        engineSessionId: 'claude-sess-1',
        // Re-derived from discovery by id, never taken from the payload.
        engineCwd: '/Users/operator/project-a',
      },
    ])
    await adapter.stop()
  })

  it(
    'clicking Attach posts the FR-ATT-30 unmediated-session confirmation into the thread, and it names the folder, ' +
      'required proof the label is visible at the moment of attachment',
    async () => {
      const boltApp = new StubBoltApp()
      const apiClient = new StubSlackApiClient()
      const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
        boltApp,
        apiClient,
        sleep: instantSleep,
        resolvePrincipalId: async () => 'prn_operator',
        listRecentSessions: async () => [buildSession({ sessionId: 'claude-sess-1' })],
        attachThreadToSession: fakeAttach({ relaySessionId: 'relay-sess-1' }).fn,
      })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(
        SESSION_ATTACH_ACTION_ID,
        sessionAttachButtonEnvelope({
          engineSessionId: 'claude-sess-1',
          engineCwd: '/Users/operator/project-a',
          channel: 'D1SESS',
          thread: '3000.000001',
        }),
      )

      expect(apiClient.posted).toHaveLength(1)
      const posted = apiClient.posted[0]
      expect(posted?.channel).toBe('D1SESS')
      expect(posted?.thread).toBe('3000.000005')
      const rendered = (posted?.text ?? '') + JSON.stringify(posted?.blocks ?? [])
      expect(rendered).toMatch(/unmediated/i)
      expect(rendered).toContain('/Users/operator/project-a')
      await adapter.stop()
    },
  )

  it('SELF-ATTACK required proof: an unmapped Slack user (no resolvePrincipalId mapping) is passed through as null, never a guessed identity', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const attach = fakeAttach({ relaySessionId: 'relay-sess-1' })
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      // No resolvePrincipalId override: defaults to always-null, per
      // SlackAdapterOptions' own documented default.
      listRecentSessions: async () => [buildSession({ sessionId: 'claude-sess-1' })],
      attachThreadToSession: attach.fn,
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(
      SESSION_ATTACH_ACTION_ID,
      sessionAttachButtonEnvelope({
        engineSessionId: 'claude-sess-1',
        engineCwd: '/Users/operator/project-a',
        channel: 'D1SESS',
        thread: '3000.000001',
      }),
    )

    // FR-CA-4, tightened: an unmapped actor is now REFUSED rather than
    // passed through as a null principal. Attaching is not a read. It
    // decides which folder an unmediated engine runs in, holding the
    // operator's own permissions (section 24), so an actor Relay cannot
    // name must never reach it. Passing null through would have recorded
    // an attachment nobody is accountable for.
    expect(attach.calls).toEqual([])
    // Unmapped senders get no reply anywhere; only the log names them.
    expect(apiClient.posted).toEqual([])
    await adapter.stop()
  })

  it('reports failure into the thread when attachThreadToSession is left unwired (the default)', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolvePrincipalId: async () => 'prn_operator',
      listRecentSessions: async () => [buildSession({ sessionId: 'claude-sess-1' })],
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(
      SESSION_ATTACH_ACTION_ID,
      sessionAttachButtonEnvelope({
        engineSessionId: 'claude-sess-1',
        engineCwd: '/Users/operator/project-a',
        channel: 'D1SESS',
        thread: '3000.000001',
      }),
    )

    expect(apiClient.posted).toHaveLength(1)
    expect(apiClient.posted[0]?.text).toMatch(/not available/i)
    await adapter.stop()
  })

  it('reports failure into the thread when attachThreadToSession throws', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolvePrincipalId: async () => 'prn_operator',
      listRecentSessions: async () => [buildSession({ sessionId: 'claude-sess-1' })],
      attachThreadToSession: async () => {
        throw new Error('simulated internal failure')
      },
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(
      SESSION_ATTACH_ACTION_ID,
      sessionAttachButtonEnvelope({
        engineSessionId: 'claude-sess-1',
        engineCwd: '/Users/operator/project-a',
        channel: 'D1SESS',
        thread: '3000.000001',
      }),
    )

    expect(apiClient.posted).toHaveLength(1)
    expect(apiClient.posted[0]?.text).toMatch(/unexpected error/i)
    await adapter.stop()
  })

  it('SELF-ATTACK required proof: a malformed button value is ignored rather than acted on', async () => {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient()
    const attach = fakeAttach({ relaySessionId: 'relay-sess-1' })
    const adapter = await createTestAdapter(fakeSecrets(bothTokens()), {
      boltApp,
      apiClient,
      sleep: instantSleep,
      resolvePrincipalId: async () => 'prn_operator',
      listRecentSessions: async () => [buildSession({ sessionId: 'claude-sess-1' })],
      attachThreadToSession: attach.fn,
    })
    await adapter.start(async () => {})

    await boltApp.dispatchAction(SESSION_ATTACH_ACTION_ID, {
      actions: [{ action_id: SESSION_ATTACH_ACTION_ID, type: 'button', value: '{not valid json' }],
      user: { id: 'UOPERATOR' },
      channel: { id: 'D1SESS' },
      message: { ts: '3000.000005' },
    })

    expect(attach.calls).toHaveLength(0)
    expect(apiClient.posted).toHaveLength(0)
    await adapter.stop()
  })
})

