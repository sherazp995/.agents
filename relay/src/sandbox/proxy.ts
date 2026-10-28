/**
 * FR-SH-6's enforcing egress proxy.
 *
 * WHY THIS EXISTS AT ALL, in the requirement's own words: "Host-based egress
 * filtering is not achievable with `sandbox-exec` alone, which filters only
 * coarsely, so the sandbox denies direct outbound networking entirely and
 * forces all traffic through a local Relay proxy that enforces the
 * destination list, terminates connections to undeclared hosts, and logs
 * every attempt."
 *
 * The two halves are load-bearing together and neither is sufficient alone:
 *
 *   - The SANDBOX makes this proxy unbypassable. Without the kernel denying
 *     direct sockets, a run could simply not use the proxy, and an allowlist
 *     it can opt out of enforces nothing.
 *   - The PROXY makes the sandbox's coarse network denial useful. Without
 *     it, confinement would mean a coding run had no network at all, which
 *     no real run survives.
 *
 * NO TLS INTERCEPTION, deliberately. HTTPS goes through `CONNECT
 * host:port`, and that request line carries the hostname in the clear
 * before any tunnel exists, which is the only thing enforcement needs.
 * Terminating TLS here would mean minting certificates, holding a private
 * key, and putting Relay in a position to read every byte of the
 * operator's traffic, all to learn something the CONNECT line already
 * says. The cost of not intercepting is that once a tunnel to an ALLOWED
 * host is open, its contents are not inspected, which is the correct
 * trade: the destination list is what was approved.
 *
 * EVERY ATTEMPT IS LOGGED, allowed or refused. A refusal nobody can see is
 * indistinguishable from a network that happened to be down, and FR-SH-6
 * requires the denial to appear in the run record.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'

import { matchesAnyOrigin } from '../policy/origin-match.js'

export type EgressAttempt = {
  readonly host: string
  readonly port: number
  /** `connect` for a CONNECT tunnel (HTTPS), `request` for plain HTTP. */
  readonly method: 'connect' | 'request'
  readonly allowed: boolean
  /** Present when refused, so a run record can say why rather than "failed". */
  readonly reason?: string
}

export type EgressProxyOptions = {
  /** The destination list this proxy enforces. Wildcards use the same syntax as every other origin list in Relay. */
  readonly allowedHosts: readonly string[]
  /** Called for every attempt, allowed or not. */
  readonly onAttempt?: (attempt: EgressAttempt) => void
  /** Bind port. 0 asks the OS for a free one, which is the normal case. */
  readonly port?: number
}

export type EgressProxy = {
  readonly port: number
  /** Every attempt seen, in order. The run record's source for FR-SH-6's "logs every attempt". */
  readonly attempts: readonly EgressAttempt[]
  close(): Promise<void>
}

/**
 * Parses `host:port` from a CONNECT request target.
 *
 * A bare IPv6 literal contains colons of its own, so splitting on the last
 * colon rather than the first is what keeps `[::1]:443` from parsing as host
 * `[` and a nonsense port.
 */
export function parseConnectTarget(target: string): { host: string; port: number } | undefined {
  const separator = target.lastIndexOf(':')
  if (separator <= 0) return undefined
  const host = target.slice(0, separator).replace(/^\[|\]$/g, '')
  const port = Number.parseInt(target.slice(separator + 1), 10)
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host, port }
}

/**
 * A header value safe to write into a re-emitted request line.
 *
 * The proxy rebuilds the request rather than forwarding the parsed object,
 * so any CR or LF surviving in a value would end the header and let the rest
 * be read as a NEW request: classic request splitting, with the confined run
 * on the writing end. Node rejects most of these at parse time, but this
 * proxy must not depend on the parser upstream of it staying strict.
 *
 * A value carrying CR or LF is DROPPED rather than stripped. Silently
 * altering a header produces a request the caller did not write and cannot
 * debug; omitting it fails visibly.
 */
export function headerValue(value: string | readonly string[] | undefined): string {
  if (value === undefined) return ''
  const joined = Array.isArray(value) ? value.join(', ') : String(value)
  return /[\r\n]/.test(joined) ? '' : joined
}

/** The hostname a plain-HTTP proxy request is for. Absolute-form URL first, since that is what a proxy is sent; Host header as the fallback. */
export function parseRequestTarget(request: IncomingMessage): { host: string; port: number } | undefined {
  const url = request.url ?? ''
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url)
      return { host: parsed.hostname, port: parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number.parseInt(parsed.port, 10) }
    } catch {
      return undefined
    }
  }
  const header = request.headers.host
  if (header === undefined) return undefined
  const parsed = parseConnectTarget(header.includes(':') ? header : `${header}:80`)
  return parsed
}

/**
 * Starts the proxy on loopback.
 *
 * Bound to 127.0.0.1 rather than every interface, because a proxy that
 * enforces one run's destination list should not be reachable from the
 * network by anything else on it.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const attempts: EgressAttempt[] = []
  const sockets = new Set<Socket>()

  const record = (attempt: EgressAttempt): void => {
    attempts.push(attempt)
    options.onAttempt?.(attempt)
  }

  const isAllowed = (host: string): boolean => matchesAnyOrigin(host, options.allowedHosts)

  const refusalReason = (host: string): string =>
    `${host} is not in this run's declared destination list, so the connection was terminated by Relay's egress ` +
    `proxy (FR-SH-6). Declared: ${options.allowedHosts.length === 0 ? '(nothing)' : options.allowedHosts.join(', ')}.`

  const server: Server = createServer()

  // A listener error must not be an unhandled 'error' event either. The
  // proxy runs inside the daemon, so its failures belong to the run that
  // started it, never to the process.
  server.on('clientError', (_error, socket) => socket.destroy())

  // Plain HTTP through the proxy. Rarer than CONNECT in practice, but a
  // package manager or a curl to an http:// URL still arrives here, and
  // leaving it unhandled would be an unenforced hole rather than an
  // unsupported one.
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    // Same reason as the CONNECT path below: an unhandled socket error here
    // is a process-level crash, not a failed request.
    request.on('error', () => response.destroy())
    response.on('error', () => response.destroy())

    const target = parseRequestTarget(request)
    if (target === undefined) {
      record({ host: '(unparseable)', port: 0, method: 'request', allowed: false, reason: 'the request named no host this proxy could parse' })
      response.writeHead(400)
      response.end('Relay egress proxy: could not determine the destination host.\n')
      return
    }
    if (!isAllowed(target.host)) {
      const reason = refusalReason(target.host)
      record({ ...target, method: 'request', allowed: false, reason })
      // Connection: close, so a refusal ends the connection rather than
      // leaving it keep-alive. A client waiting on a socket that stays open
      // experiences a refusal as a hang, which is the failure shape this
      // whole design is trying to avoid.
      response.writeHead(403, { connection: 'close' })
      response.end(`Relay egress proxy: ${reason}\n`)
      return
    }

    record({ ...target, method: 'request', allowed: true })

    // The client socket is captured BEFORE the upstream connection opens.
    // Reading `response.socket` inside the callback and falling back to
    // `upstream` piped the upstream into ITSELF when the client had already
    // gone away, which is an endless loop rather than a closed connection.
    const clientSocket = response.socket
    if (clientSocket === null) {
      response.end()
      return
    }

    const upstream = connect(target.port, target.host, () => {
      // Re-emitted rather than piped from a parsed object, so nothing this
      // proxy does can alter the request it forwards.
      const path = (request.url ?? '/').replace(/^https?:\/\/[^/]+/, '') || '/'
      const headers = Object.entries(request.headers)
        .filter(([name]) => name.toLowerCase() !== 'proxy-connection')
        .map(([name, value]) => `${name}: ${headerValue(value)}`)
        .filter((line) => line !== '')
        .join('\r\n')
      upstream.write(`${request.method ?? 'GET'} ${path} HTTP/1.1\r\n${headers}\r\n\r\n`)
      request.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
  })

  // CONNECT, which is how every HTTPS request arrives. The hostname is in
  // the request line, so it is checked BEFORE any tunnel exists: a refused
  // host never gets a socket to the outside at all.
  server.on('connect', (request: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    // Attached BEFORE anything can fail. A client that hangs up on a refusal
    // raises ECONNRESET on this socket, and with no listener Node turns that
    // into an unhandled 'error' event that takes down the whole process.
    // Found by pointing a real CLI at this proxy: the refusal worked and the
    // daemon died. A proxy any client can crash by disconnecting is a denial
    // of service on everything else Relay is doing.
    clientSocket.on('error', () => clientSocket.destroy())

    const target = parseConnectTarget(request.url ?? '')
    if (target === undefined) {
      record({ host: '(unparseable)', port: 0, method: 'connect', allowed: false, reason: 'the CONNECT target could not be parsed' })
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (!isAllowed(target.host)) {
      const reason = refusalReason(target.host)
      record({ ...target, method: 'connect', allowed: false, reason })
      // Terminated, per FR-SH-6, with a status the client reports as a
      // refusal rather than a timeout, so the run's own error says what
      // happened.
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${reason}\n`)
      return
    }

    record({ ...target, method: 'connect', allowed: true })
    const upstream = connect(target.port, target.host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    sockets.add(upstream)
    sockets.add(clientSocket)
    upstream.on('close', () => sockets.delete(upstream))
    clientSocket.on('close', () => sockets.delete(clientSocket))
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    get attempts() {
      return attempts
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
