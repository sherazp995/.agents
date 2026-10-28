import type {
  AdapterCapabilities,
  ChatAction,
  ChatActionResult,
  ChatAdapter,
  ChatEvent,
} from './contract.js'

type Handler = (event: ChatEvent) => Promise<void>

/**
 * The capability set MockAdapter declares when a test does not supply its
 * own. `fileUpload` is deliberately the one flag set to false, distinct
 * from every other flag, so the conformance suite always has a real
 * ChatAction kind (`upload`) it can perform against a capability the
 * adapter under test has openly declared it cannot do. See
 * test/chat/conformance.ts's capability honesty assertion.
 */
export const DEFAULT_MOCK_CAPABILITIES: AdapterCapabilities = {
  buttons: true,
  editMessage: true,
  fileUpload: false,
  modals: true,
  threads: true,
  maxMessageBytes: 4000,
}

/**
 * An in-memory ChatAdapter for tests. It implements ChatAdapter exactly,
 * plus three affordances the conformance suite and individual tests rely
 * on: `emit` drives one inbound event through whatever handler `start`
 * registered, `performed` and `failNextPerform` make outbound `perform`
 * calls observable and controllable, and `handlerErrors` is the minimal,
 * additional convention this task introduces so that a handler's failure
 * is observable rather than silently swallowed (the contract in
 * src/chat/contract.ts does not specify a mechanism for this; see the
 * task report for the reasoning). Any adapter run through
 * runChatAdapterConformance must expose `emit` and `handlerErrors` the
 * same way (see the exported `ConformanceAdapter` type in
 * test/chat/conformance.ts); the ones that want the "split, not reject"
 * branch of the maxMessageBytes assertion must also expose `performed`.
 *
 * Every `post` and `upload` mints a message id that has never been issued
 * before, and `edit` rejects a ref whose message id this adapter never
 * issued, rather than echoing it back as if it identified something real.
 * The Task 5 progress reporter depends on a post's ref genuinely
 * identifying the one message it owns, so a mock that rubber-stamped any
 * ref would hide that class of bug instead of catching it.
 */
export class MockAdapter implements ChatAdapter {
  readonly name = 'mock'
  readonly capabilities: AdapterCapabilities
  readonly performed: ChatAction[] = []
  readonly handlerErrors: Error[] = []

  #handler: Handler | undefined
  #started = false
  #nextPerformFailure: Error | undefined
  #messageSeq = 0
  /** Every message id `perform` has ever minted, so `edit` can refuse a ref that never came from this adapter instead of rubber-stamping it. */
  #issuedMessages = new Set<string>()
  /**
   * Serializes handler dispatch so concurrent `emit` calls still invoke the
   * handler one at a time, in the order `emit` was called, the way a
   * single inbound connection (a websocket, a webhook queue) would in a
   * real adapter. Without this, two emits racing against a slow first
   * handler call could complete out of order.
   */
  #queue: Promise<void> = Promise.resolve()

  constructor(capabilities: AdapterCapabilities = DEFAULT_MOCK_CAPABILITIES) {
    this.capabilities = capabilities
  }

  async start(handler: Handler): Promise<void> {
    this.#handler = handler
    this.#started = true
  }

  async stop(): Promise<void> {
    // Idempotent: a second stop, or a stop before start, is a clean no-op
    // rather than a throw, which is what any real shutdown race must
    // tolerate too.
    this.#started = false
  }

  /**
   * Drives one inbound event through the registered handler, the way a
   * real platform event would arrive. Always resolves, whether or not the
   * handler throws: a handler failure is the caller's bug, not a reason
   * for the adapter's own event loop to die, so it is caught here and
   * recorded on `handlerErrors` in order rather than rejecting this
   * promise or propagating out of the queue.
   */
  async emit(event: ChatEvent): Promise<void> {
    if (!this.#started || !this.#handler) {
      throw new Error('MockAdapter.emit called before start(); no handler is registered')
    }
    const handler = this.#handler
    const next = this.#queue.then(() => this.#deliver(handler, event))
    this.#queue = next
    return next
  }

  async #deliver(handler: Handler, event: ChatEvent): Promise<void> {
    try {
      await handler(event)
    } catch (error) {
      this.handlerErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** The next perform call rejects with this error instead of performing. Only the next call; later calls behave normally again. */
  failNextPerform(error: Error): void {
    this.#nextPerformFailure = error
  }

  async perform(action: ChatAction): Promise<ChatActionResult> {
    if (this.#nextPerformFailure) {
      const error = this.#nextPerformFailure
      this.#nextPerformFailure = undefined
      throw error
    }

    this.#assertCapability(action)

    if (action.kind === 'edit' && !this.#issuedMessages.has(action.ref.message)) {
      throw new Error(
        `MockAdapter cannot edit message "${action.ref.message}": no post or upload on this ` +
          'adapter ever issued that message id',
      )
    }

    if (action.kind === 'post' || action.kind === 'edit' || action.kind === 'post_approval_card') {
      const bytes = Buffer.byteLength(action.text, 'utf8')
      if (bytes > this.capabilities.maxMessageBytes) {
        throw new Error(
          `text is ${bytes} bytes, which exceeds this adapter's maxMessageBytes of ` +
            `${this.capabilities.maxMessageBytes}; MockAdapter rejects rather than truncates`,
        )
      }
    }

    this.performed.push(action)

    if (action.kind === 'edit' || action.kind === 'setStatus' || action.kind === 'react') {
      return { ref: action.ref }
    }

    // Every minted message id is distinct, never reused, so a caller
    // holding two different post results can always tell them apart and
    // so edit's issued-message check above means something.
    this.#messageSeq += 1
    const message = `mock-msg-${this.#messageSeq}`
    this.#issuedMessages.add(message)
    return { ref: { ...action.ref, message } }
  }

  #assertCapability(action: ChatAction): void {
    if (action.kind === 'edit' && !this.capabilities.editMessage) {
      throw new Error("MockAdapter cannot perform 'edit': capability editMessage is false")
    }
    if (action.kind === 'upload' && !this.capabilities.fileUpload) {
      throw new Error("MockAdapter cannot perform 'upload': capability fileUpload is false")
    }
  }
}
