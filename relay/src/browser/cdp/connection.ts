/**
 * The Chrome DevTools Protocol transport: one WebSocket, many in-flight
 * commands, many event subscribers. Everything tier 2 does eventually
 * becomes a `send()` on this object.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY. Playwright and puppeteer both
 * bring a bundled browser download and a large dependency surface, and
 * neither can attach to the profile shapes FR-PRF-6a describes any better
 * than CDP can, because the constraint is Chrome's, not the library's.
 * Node 22 ships a global `WebSocket`, so the whole transport is one file
 * with no new dependency, and no new destination in the egress inventory
 * beyond loopback (see src/data/egress.ts's LOCAL_ONLY_FETCH_HOSTS).
 *
 * THE FAILURE THIS FILE IS BUILT AROUND: a hung command. A CDP command
 * that is never answered, because the page navigated away, because the
 * target detached, or because Chrome died, must never leave a caller
 * awaiting a promise that can no longer settle. "Silence is the worst
 * failure." So every pending command has exactly two ways out beyond a
 * normal reply, and both are unconditional:
 *
 *   1. A per-command timeout, so an answer that never comes becomes a
 *      stated error rather than a wedged run.
 *   2. Socket closure, which rejects every command still in flight with
 *      the reason the socket gave, rather than leaving them to time out
 *      one by one long after the connection is known to be gone.
 *
 * SESSIONS. A CDP connection to the browser endpoint reaches the browser
 * itself; reaching a page means attaching to its target and passing that
 * target's `sessionId` on every subsequent command. This class treats
 * `sessionId` as an opaque routing field: it stamps it onto outgoing
 * commands, and it reports the `sessionId` an incoming event arrived on,
 * but it owns no notion of what a session IS. `src/browser/cdp/session.ts`
 * owns that.
 */

/**
 * The narrow surface this module needs from a WebSocket, as four callback
 * registrations rather than a `WebSocket` instance.
 *
 * The seam exists so the whole protocol layer, request correlation, error
 * mapping, timeout behaviour, close behaviour, is testable by driving a
 * hand-written socket directly, with no Chrome, no network, and no real
 * timers. The integration tests in test/browser/cdp/ drive the real
 * default implementation against a real Chrome; the unit tests drive this
 * seam. Both matter: the seam alone would prove only that this file agrees
 * with itself.
 */
export type CdpSocket = {
  send(data: string): void
  onMessage(listener: (data: string) => void): void
  /** Fires exactly once, when the socket is closed for any reason, including a close this process initiated. */
  onClose(listener: (reason: string) => void): void
  close(): void
}

export type OpenCdpSocketFn = (url: string) => Promise<CdpSocket>

/** How long a single command waits for its reply before it is abandoned with a stated reason. Chosen, not measured: generous enough for a slow page load triggered by `Page.navigate`, short enough that a wedged run reports rather than hangs. Every caller can override it per command. */
export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 30_000

/** How long `defaultOpenCdpSocket` waits for the WebSocket handshake itself. Separate from the command timeout because it fails for entirely different reasons: nothing is listening, or the endpoint rejected the upgrade. */
export const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 10_000

/**
 * An error the DevTools endpoint itself returned, as distinct from a
 * transport failure. Carries CDP's own numeric code and message, because
 * the difference between "no node found for the given selector" (a normal,
 * expected answer this driver acts on) and "Target closed" (the session is
 * gone) is exactly what a caller needs in order to decide whether to
 * escalate.
 */
export class CdpProtocolError extends Error {
  readonly code: number
  readonly method: string
  readonly data: string | undefined

  constructor(params: { method: string; code: number; message: string; data?: string }) {
    super(`CDP ${params.method} failed: ${params.message}${params.data !== undefined ? ` (${params.data})` : ''}`)
    this.name = 'CdpProtocolError'
    this.code = params.code
    this.method = params.method
    this.data = params.data
  }
}

/** A command that could not be answered at all: the socket closed, or the reply never came. Distinct from CdpProtocolError, which is Chrome answering "no". */
export class CdpTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpTransportError'
  }
}

export type CdpEventListener = (params: Record<string, unknown>, sessionId: string | undefined) => void

type PendingCommand = {
  readonly method: string
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export type CdpConnectionOptions = {
  readonly commandTimeoutMs?: number
  /** Test seam only; production always uses the real timer. Mirrors src/browser/launch.ts's own `sleep` seam. */
  readonly setTimeoutFn?: typeof setTimeout
  readonly clearTimeoutFn?: typeof clearTimeout
}

/**
 * One CDP connection. Not exported as a constructor a caller reaches for
 * directly in production: `connectToCdp` below opens the socket first, so
 * a connection object never exists in a not-yet-connected state a caller
 * could accidentally send on.
 */
export class CdpConnection {
  private readonly socket: CdpSocket
  private readonly commandTimeoutMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly pending = new Map<number, PendingCommand>()
  private readonly listeners = new Map<string, Set<CdpEventListener>>()
  private nextId = 1
  private closedReason: string | undefined

  constructor(socket: CdpSocket, options: CdpConnectionOptions = {}) {
    this.socket = socket
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout

    socket.onMessage((data) => {
      this.handleMessage(data)
    })
    socket.onClose((reason) => {
      this.handleClose(reason)
    })
  }

  /** Whether this connection has been closed, by `close()` or by the socket going away underneath it. A closed connection never reopens; a caller that needs another one opens another one. */
  get closed(): boolean {
    return this.closedReason !== undefined
  }

  /**
   * Sends one command and resolves with its `result` object.
   *
   * Rejects, never hangs: with `CdpProtocolError` where Chrome answered
   * with an error, with `CdpTransportError` where the reply never came or
   * the socket closed first. A command sent on an already-closed
   * connection rejects immediately rather than being queued for a socket
   * that will never carry it.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    if (this.closedReason !== undefined) {
      return Promise.reject(
        new CdpTransportError(`cannot send ${method}: the CDP connection is closed (${this.closedReason})`),
      )
    }

    const id = this.nextId++
    const effectiveTimeout = timeoutMs ?? this.commandTimeoutMs

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        // Dropped from `pending` before rejecting, so a late reply that
        // arrives after the timeout is discarded rather than resolving a
        // promise this caller has already given up on.
        this.pending.delete(id)
        reject(new CdpTransportError(`CDP ${method} did not answer within ${effectiveTimeout}ms`))
      }, effectiveTimeout)

      this.pending.set(id, { method, resolve, reject, timer })

      const message: Record<string, unknown> = { id, method, params }
      if (sessionId !== undefined) message['sessionId'] = sessionId

      try {
        this.socket.send(JSON.stringify(message))
      } catch (error) {
        this.pending.delete(id)
        this.clearTimeoutFn(timer)
        reject(new CdpTransportError(`CDP ${method} could not be written to the socket: ${errorMessage(error)}`))
      }
    })
  }

  /**
   * Subscribes to one CDP event by method name, returning the unsubscribe
   * function. Every subscriber for a method is called with the event's own
   * params and the session it arrived on; a subscriber that throws does not
   * stop the others, since one broken listener must not silently deprive
   * the rest of an event they were relying on.
   */
  on(method: string, listener: CdpEventListener): () => void {
    let set = this.listeners.get(method)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(method)
    }
  }

  /**
   * Closes the socket and fails every command still in flight.
   *
   * Idempotent: closing an already-closed connection is a no-op, not an
   * error, because the ordinary shutdown path (a driver closing its
   * connection after Chrome has already exited) reaches it both ways.
   */
  close(reason = 'closed by Relay'): void {
    if (this.closedReason !== undefined) return
    // Marked closed BEFORE closing the socket: the socket's own close
    // callback re-enters handleClose, and doing it in this order means the
    // pending commands are rejected exactly once, with this reason.
    this.handleClose(reason)
    try {
      this.socket.close()
    } catch {
      // A socket that throws on close is already gone; the pending
      // commands have been rejected, which is the part that matters.
    }
  }

  private handleClose(reason: string): void {
    if (this.closedReason !== undefined) return
    this.closedReason = reason
    const inFlight = [...this.pending.values()]
    this.pending.clear()
    for (const command of inFlight) {
      this.clearTimeoutFn(command.timer)
      command.reject(
        new CdpTransportError(`CDP ${command.method} was in flight when the connection closed: ${reason}`),
      )
    }
    this.listeners.clear()
  }

  private handleMessage(data: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      // An unparseable frame is not something this layer can act on, and
      // throwing here would cross into the socket's own callback. Dropped
      // deliberately: a command awaiting a reply still has its timeout.
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const message = parsed as Record<string, unknown>

    const id = message['id']
    if (typeof id === 'number') {
      this.settle(id, message)
      return
    }

    const method = message['method']
    if (typeof method !== 'string') return
    const params = isRecord(message['params']) ? message['params'] : {}
    const sessionId = typeof message['sessionId'] === 'string' ? message['sessionId'] : undefined
    // Iterated over a copy: a listener that unsubscribes itself while
    // being called would otherwise mutate the set mid-iteration.
    for (const listener of [...(this.listeners.get(method) ?? [])]) {
      try {
        listener(params, sessionId)
      } catch {
        // See `on`'s doc comment: one listener's failure must not deprive
        // the others of the event.
      }
    }
  }

  private settle(id: number, message: Record<string, unknown>): void {
    const command = this.pending.get(id)
    // An id with no pending command is a reply to something already timed
    // out or already rejected by a close. Dropping it is correct: the
    // caller has moved on.
    if (command === undefined) return
    this.pending.delete(id)
    this.clearTimeoutFn(command.timer)

    const error = message['error']
    if (isRecord(error)) {
      const code = typeof error['code'] === 'number' ? error['code'] : -1
      const text = typeof error['message'] === 'string' ? error['message'] : 'unknown protocol error'
      const data = typeof error['data'] === 'string' ? error['data'] : undefined
      command.reject(
        new CdpProtocolError({
          method: command.method,
          code,
          message: text,
          ...(data !== undefined ? { data } : {}),
        }),
      )
      return
    }

    command.resolve(isRecord(message['result']) ? message['result'] : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The production socket, over Node 22's own global `WebSocket`. No `ws`
 * dependency: the global has been unflagged since Node 22, which this
 * package's `engines` field already requires.
 *
 * Rejects rather than resolving a half-open socket if the handshake does
 * not complete within `connectTimeoutMs`: a caller awaiting a connection
 * that never opened is the same wedge this whole file exists to prevent,
 * one layer down.
 */
export function defaultOpenCdpSocket(connectTimeoutMs = DEFAULT_CDP_CONNECT_TIMEOUT_MS): OpenCdpSocketFn {
  return (url: string) =>
    new Promise<CdpSocket>((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (error) {
        reject(new CdpTransportError(`could not open a CDP socket to ${url}: ${errorMessage(error)}`))
        return
      }

      const messageListeners: Array<(data: string) => void> = []
      const closeListeners: Array<(reason: string) => void> = []
      let settled = false
      let closeDelivered = false

      const deliverClose = (reason: string): void => {
        if (closeDelivered) return
        closeDelivered = true
        for (const listener of closeListeners) listener(reason)
      }

      const connectTimer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          ws.close()
        } catch {
          // Already unusable; the rejection below is the outcome that matters.
        }
        reject(new CdpTransportError(`CDP socket to ${url} did not open within ${connectTimeoutMs}ms`))
      }, connectTimeoutMs)

      // Registered before the open handler resolves, so no frame delivered
      // between the handshake completing and the caller attaching its own
      // listener is lost.
      ws.addEventListener('message', (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data)
        for (const listener of messageListeners) listener(data)
      })
      // Typed structurally rather than as `CloseEvent`: this package's
      // lib is ES2023 with no DOM, and @types/node declares MessageEvent
      // but not CloseEvent. The two fields used are the two the WHATWG
      // interface guarantees.
      ws.addEventListener('close', (event: { readonly code: number; readonly reason: string }) => {
        clearTimeout(connectTimer)
        const reason = `websocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`
        if (!settled) {
          settled = true
          reject(new CdpTransportError(`CDP socket to ${url} closed before it opened: ${reason}`))
          return
        }
        deliverClose(reason)
      })
      ws.addEventListener('error', () => {
        // The WebSocket error event carries no useful detail by design (it
        // is deliberately opaque to avoid leaking cross-origin
        // information), so the message says what is actually known. A
        // 'close' event always follows, which is what delivers the close
        // to subscribers; this handler exists so a pre-open failure
        // rejects promptly rather than waiting out the connect timeout.
        clearTimeout(connectTimer)
        if (settled) return
        settled = true
        reject(new CdpTransportError(`CDP socket to ${url} failed to connect`))
      })
      ws.addEventListener('open', () => {
        clearTimeout(connectTimer)
        if (settled) return
        settled = true
        resolve({
          send: (data) => {
            ws.send(data)
          },
          onMessage: (listener) => {
            messageListeners.push(listener)
          },
          onClose: (listener) => {
            closeListeners.push(listener)
          },
          close: () => {
            ws.close()
          },
        })
      })
    })
}

/** Opens a socket to `webSocketDebuggerUrl` and wraps it in a `CdpConnection`. The one production entry point into this file. */
export async function connectToCdp(
  webSocketDebuggerUrl: string,
  options: CdpConnectionOptions & { readonly openSocket?: OpenCdpSocketFn; readonly connectTimeoutMs?: number } = {},
): Promise<CdpConnection> {
  const openSocket = options.openSocket ?? defaultOpenCdpSocket(options.connectTimeoutMs ?? DEFAULT_CDP_CONNECT_TIMEOUT_MS)
  const socket = await openSocket(webSocketDebuggerUrl)
  return new CdpConnection(socket, options)
}
