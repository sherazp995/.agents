import { describe, expect, it } from 'vitest'
import { unwrapForAudit, wrapUntrusted } from '../../src/agent/untrusted.js'
import type {
  AdapterCapabilities,
  ChatAction,
  ChatAdapter,
  ChatEvent,
  ChatRef,
} from '../../src/chat/contract.js'

/**
 * The shape a test double must implement to run through
 * runChatAdapterConformance. It is deliberately a superset of ChatAdapter:
 * ChatAdapter itself has no generic "inject an inbound event" member and no
 * way to observe a handler's failure, so the suite needs three affordances
 * beyond the production contract to exercise those properties at all.
 * `MockAdapter` (src/chat/mock.ts) is the reference implementation; a
 * future adapter's own test double (for example Slack wired to a stubbed
 * receiver) must implement the same three members to be conformance
 * tested, since they exist for testing only and are never part of what a
 * production ChatAdapter promises its real callers.
 *
 *   - `emit(event)` drives one inbound event through whatever handler
 *     `start` registered, the way a real platform event would arrive.
 *   - `handlerErrors` is how a handler's thrown error becomes observable
 *     rather than silently swallowed: every error the handler threw,
 *     recorded in delivery order, without interrupting delivery of later
 *     events.
 *   - `performed` records every ChatAction perform() has completed, in
 *     order. It is required unconditionally (MockAdapter always has it),
 *     but the conformance suite only reads it on the branch of the
 *     maxMessageBytes test where an adapter declares "split" instead of
 *     "reject".
 */
export type ConformanceAdapter = ChatAdapter & {
  emit(event: ChatEvent): Promise<void>
  readonly handlerErrors: readonly Error[]
  readonly performed: readonly ChatAction[]
}

/**
 * A Vitest `describe` block any ChatAdapter must pass. `factory` builds a
 * fresh adapter (and its teardown) for each test, so one test's state can
 * never leak into another's. The runtime guards inside (`assertEmits` and
 * friends) exist as a safety net for a factory that satisfies
 * ConformanceAdapter only through an unsafe cast; a factory typed
 * correctly against ConformanceAdapter never reaches them.
 */
export function runChatAdapterConformance(
  name: string,
  factory: () => Promise<{ adapter: ConformanceAdapter; cleanup: () => Promise<void> }>,
): void {
  describe(`ChatAdapter conformance: ${name}`, () => {
    it('starts then stops cleanly, and a second stop does not throw', async () => {
      const { adapter, cleanup } = await factory()
      try {
        await adapter.start(async () => {})
        await adapter.stop()
        await expect(adapter.stop()).resolves.toBeUndefined()
      } finally {
        await cleanup()
      }
    })

    it('actually stops delivering events after stop(), not merely no-ops', async () => {
      const { adapter, cleanup } = await factory()
      try {
        let calls = 0
        await adapter.start(async () => {
          calls += 1
        })
        await adapter.stop()

        try {
          await assertEmits(adapter).emit(buildEvent({ text: wrapUntrusted('after-stop') }))
        } catch {
          // Refusing to accept an event once stopped is an acceptable way
          // to guarantee the handler is not called; either outcome is
          // fine as long as the handler itself never runs.
        }

        expect(calls).toBe(0)
      } finally {
        await cleanup()
      }
    })

    it('delivers an inbound event to the handler exactly once', async () => {
      const { adapter, cleanup } = await factory()
      try {
        const received: ChatEvent[] = []
        await adapter.start(async (event) => {
          received.push(event)
        })

        const event = buildEvent()
        await assertEmits(adapter).emit(event)

        expect(received).toHaveLength(1)
        expect(received[0]).toEqual(event)
      } finally {
        await cleanup()
      }
    })

    it('does not die when the handler throws, and the failure is observable rather than swallowed', async () => {
      const { adapter, cleanup } = await factory()
      try {
        let calls = 0
        const delivered: string[] = []
        await adapter.start(async (event) => {
          calls += 1
          if (calls === 1) throw new Error('handler exploded on the first event')
          delivered.push(unwrapForAudit(event.text))
        })

        await assertEmits(adapter).emit(buildEvent({ text: wrapUntrusted('first') }))

        const errorsAfterFirst = assertHandlerErrors(adapter)
        expect(errorsAfterFirst).toHaveLength(1)
        expect(errorsAfterFirst[0]?.message).toMatch(/handler exploded/)

        // Recovery has to hold for more than the one event immediately
        // after the throw: emit three further, distinct events and
        // confirm every single one is actually delivered, not merely
        // that the adapter survived one and then quietly dropped the
        // rest.
        await assertEmits(adapter).emit(buildEvent({ text: wrapUntrusted('second') }))
        await assertEmits(adapter).emit(buildEvent({ text: wrapUntrusted('third') }))
        await assertEmits(adapter).emit(buildEvent({ text: wrapUntrusted('fourth') }))

        expect(calls).toBe(4)
        expect(delivered).toEqual(['second', 'third', 'fourth'])
      } finally {
        await cleanup()
      }
    })

    it('returns a post ref that a subsequent edit can use', async () => {
      const { adapter, cleanup } = await factory()
      try {
        await adapter.start(async () => {})

        const posted = await adapter.perform({
          kind: 'post',
          ref: { channel: 'C-post-edit' },
          text: 'v1',
        })
        expect(posted.ref.message).toBeDefined()
        const message = posted.ref.message
        if (!message) throw new Error('post did not return a message id to edit against')

        await expect(
          adapter.perform({
            kind: 'edit',
            ref: { channel: 'C-post-edit', message },
            text: 'v2',
          }),
        ).resolves.toBeDefined()
      } finally {
        await cleanup()
      }
    })

    it('mints a distinct message ref for each post, so an editor can tell them apart', async () => {
      const { adapter, cleanup } = await factory()
      try {
        await adapter.start(async () => {})

        const first = await adapter.perform({
          kind: 'post',
          ref: { channel: 'C-distinct' },
          text: 'first post',
        })
        const second = await adapter.perform({
          kind: 'post',
          ref: { channel: 'C-distinct' },
          text: 'second post',
        })

        expect(first.ref.message).toBeDefined()
        expect(second.ref.message).toBeDefined()
        // A constant, hardcoded message ref would make every edit target
        // the same message no matter which post it followed, which is
        // exactly the bug the Task 5 progress reporter cannot tolerate:
        // it owns and edits one specific message, not "whichever one
        // happened to be posted last, identified by a fixed string".
        expect(second.ref.message).not.toBe(first.ref.message)
      } finally {
        await cleanup()
      }
    })

    it("rejects an action its own capabilities say it cannot do, naming the capability", async () => {
      const { adapter, cleanup } = await factory()
      try {
        await adapter.start(async () => {})
        const ref: ChatRef = { channel: 'C-capability' }

        // Post first so the edit branch below can target a message this
        // adapter genuinely issued, leaving the declared capability as the
        // only possible reason for the refusal.
        const posted = await adapter.perform({ kind: 'post', ref, text: 'seed' })
        const issuedMessage = posted.ref.message
        if (issuedMessage === undefined) {
          // Throw rather than substitute a placeholder: a placeholder would
          // be an unissued id, quietly reintroducing the ambiguity this
          // seeding exists to remove.
          throw new Error(
            `${adapter.name} resolved a post without a message id on the returned ref, so the ` +
              'capability test cannot build an edit against a genuinely issued message.',
          )
        }

        const { action, capabilityName } = unsupportedAction(
          adapter.capabilities,
          ref,
          issuedMessage,
        )

        await expect(adapter.perform(action)).rejects.toThrow(new RegExp(capabilityName))
      } finally {
        await cleanup()
      }
    })

    it('respects maxMessageBytes without silently truncating', async () => {
      const { adapter, cleanup } = await factory()
      try {
        await adapter.start(async () => {})
        // Meaningfully over the limit, not just one byte over: a "split"
        // that merely trims a single byte off the end and calls the
        // (still oversized) remainder a chunk would otherwise happen to
        // produce a compliant-looking first chunk purely because
        // limit + 1 minus one byte equals the limit exactly.
        const oversizedText = 'x'.repeat(adapter.capabilities.maxMessageBytes * 2 + 37)
        const ref: ChatRef = { channel: 'C-oversized' }

        let rejection: unknown
        let resolved: boolean
        try {
          await adapter.perform({ kind: 'post', ref, text: oversizedText })
          resolved = true
        } catch (error) {
          rejection = error
          resolved = false
        }

        if (!resolved) {
          // Declares "reject": the error must clearly name the reason,
          // not fail obscurely.
          const message = rejection instanceof Error ? rejection.message : String(rejection)
          expect(message).toMatch(/maxMessageBytes|exceeds|too long|size/i)
          return
        }

        // Declares "split": prove the full text was preserved across
        // multiple sends rather than one truncated one, and that every
        // individual chunk actually fits the declared limit. A split
        // that still emits one oversized chunk plus a tiny remainder
        // defeats FR-RPT-10 exactly as badly as truncation does.
        const performed = assertPerformed(adapter)
        const postedChunks = performed
          .filter((performedAction): performedAction is Extract<ChatAction, { kind: 'post' }> =>
            performedAction.kind === 'post',
          )
          .map((performedAction) => performedAction.text)

        expect(
          postedChunks.length,
          'adapter resolved an oversized post without rejecting, but only recorded one ' +
            'post; that is silent truncation, not a split',
        ).toBeGreaterThan(1)
        expect(postedChunks.join('')).toBe(oversizedText)

        for (const chunk of postedChunks) {
          expect(
            Buffer.byteLength(chunk, 'utf8'),
            `a split chunk starting "${chunk.slice(0, 20)}" is itself still over ` +
              `maxMessageBytes (${adapter.capabilities.maxMessageBytes})`,
          ).toBeLessThanOrEqual(adapter.capabilities.maxMessageBytes)
        }
      } finally {
        await cleanup()
      }
    })

    it('delivers events in the order they were emitted', async () => {
      const { adapter, cleanup } = await factory()
      try {
        const received: string[] = []
        await adapter.start(async (event) => {
          // Deliberately uneven latency, weighted so a non-serializing
          // adapter would finish these out of order. A correct adapter
          // delivers strictly one at a time in arrival order regardless.
          const text = unwrapForAudit(event.text)
          const delay = text === 'one' ? 15 : text === 'two' ? 8 : 1
          await new Promise((resolve) => setTimeout(resolve, delay))
          received.push(text)
        })

        const emitter = assertEmits(adapter)
        await Promise.all([
          emitter.emit(buildEvent({ text: wrapUntrusted('one') })),
          emitter.emit(buildEvent({ text: wrapUntrusted('two') })),
          emitter.emit(buildEvent({ text: wrapUntrusted('three') })),
        ])

        expect(received).toEqual(['one', 'two', 'three'])
      } finally {
        await cleanup()
      }
    })
  })
}

function buildEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    kind: 'message',
    adapter: 'conformance',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    platformTeamId: 'T-CONFORMANCE',
    principalId: null,
    ref: { channel: 'C1' },
    text: wrapUntrusted('hello'),
    files: [],
    raw: wrapUntrusted({}),
    receivedAt: '2026-08-08T00:00:00.000Z',
    mentionsBot: false,
    platformEventId: 'C1:conformance',
    ...overrides,
  }
}

/**
 * Picks a ChatAction the adapter under test has declared it cannot perform,
 * from the two capabilities that map onto a real ChatAction kind.
 *
 * The `edit` branch takes a `message` the caller obtained from a real post
 * rather than a hardcoded literal. An adapter is entitled to reject an edit
 * whose ref it never issued (MockAdapter does exactly that), so a made-up
 * id would let this test pass for the wrong reason, or fail confusingly,
 * depending only on which of the two checks the adapter happens to run
 * first. Handing it a genuinely issued ref leaves the declared capability
 * as the single reason the action can be refused.
 */
function unsupportedAction(
  capabilities: AdapterCapabilities,
  ref: ChatRef,
  issuedMessage: string,
): { action: ChatAction; capabilityName: 'editMessage' | 'fileUpload' } {
  if (!capabilities.editMessage) {
    return {
      action: { kind: 'edit', ref: { channel: ref.channel, message: issuedMessage }, text: 'x' },
      capabilityName: 'editMessage',
    }
  }
  if (!capabilities.fileUpload) {
    return {
      action: { kind: 'upload', ref, filename: 'f.txt', bytes: new Uint8Array([1, 2, 3]) },
      capabilityName: 'fileUpload',
    }
  }
  throw new Error(
    'runChatAdapterConformance requires the adapter under test to declare editMessage or ' +
      'fileUpload as false, so capability honesty (rejecting an action the adapter says it ' +
      "cannot do) is provably exercised rather than skipped. Configure the factory's adapter " +
      'with at least one of those capabilities false.',
  )
}

// The three guards below are a defensive fallback only. ConformanceAdapter
// already requires emit, handlerErrors, and performed at compile time, so
// a factory typed correctly against it can never trip these; they exist
// purely in case a caller reaches this function through an unsafe cast.

function assertEmits(adapter: ConformanceAdapter): { emit(event: ChatEvent): Promise<void> } {
  if (typeof adapter.emit !== 'function') {
    throw new Error(
      `${adapter.name} does not implement emit(event): Promise<void>, which ` +
        'runChatAdapterConformance requires to drive inbound events into any adapter under test.',
    )
  }
  return adapter
}

function assertHandlerErrors(adapter: ConformanceAdapter): readonly Error[] {
  if (!Array.isArray(adapter.handlerErrors)) {
    throw new Error(
      `${adapter.name} does not expose handlerErrors: readonly Error[], which ` +
        'runChatAdapterConformance requires so a handler failure is observable rather than ' +
        'silently swallowed.',
    )
  }
  return adapter.handlerErrors
}

function assertPerformed(adapter: ConformanceAdapter): readonly ChatAction[] {
  if (!Array.isArray(adapter.performed)) {
    throw new Error(
      `${adapter.name} does not expose performed: readonly ChatAction[], which ` +
        'runChatAdapterConformance requires to verify a "split" oversized post preserved the ' +
        'full text instead of truncating it.',
    )
  }
  return adapter.performed
}
