/**
 * Per-task browser egress proxy (plan step 8). The autonomous worker's
 * headless Playwright browser runs with `--proxy-server` pointed here, so the
 * loopback-only interaction rule is enforced at the network, whatever tab,
 * frame or redirect makes the request.
 *
 * Loopback hosts get every method: CONNECT is tunnelled unchanged and plain
 * HTTP is forwarded. Other hosts get body-less GET and HEAD only, with `Host`
 * forced to the checked target, and only at public addresses (private,
 * link-local, metadata and loopback ranges are refused at connect time). An
 * HTTPS CONNECT to one is terminated with a leaf certificate from a per-task
 * authority (the isolated browser profile runs with `--ignore-https-errors`),
 * every request on the tunnel is checked, and the proxy opens its own
 * verified TLS connection upstream. WebSocket upgrades to a non-loopback host
 * are refused. Redirects are passed back to the browser, whose follow-up
 * request is then checked on its own. Anything ambiguous is refused.
 *
 * Request bodies and headers are never logged; a log line carries the method,
 * host and reason only.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import dns from 'node:dns'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import net, { type Socket } from 'node:net'
import { join } from 'node:path'
import tls from 'node:tls'
import type { Logger } from 'pino'

export const OPENSSL_BINARY_PATH = '/usr/bin/openssl'
export const PROXY_CA_DIR_NAME = 'proxy-ca'
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000
export const MAX_CACHED_LEAVES = 256

const READ_METHODS = new Set(['GET', 'HEAD'])
// Hop-by-hop and proxy headers are never forwarded upstream; `host` is set by the proxy.
const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'upgrade', 'host'])
const DNS_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i
const BLOCKED_ADDRESS_CODE = 'EBLOCKEDADDRESS'

// Addresses a remote request may never reach.
const NON_PUBLIC_ADDRESSES = new net.BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, 'ipv6')
}
// Every IPv4-mapped IPv6 address is refused, which covers the mapped forms of
// the IPv4 ranges. Kept apart because BlockList matches IPv4 addresses
// against IPv6 rules through this mapping.
const IPV4_MAPPED = new net.BlockList()
IPV4_MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6')

export type IsLoopback = (host: string) => Promise<boolean>

export type EgressProxyOptions = {
  /** The task directory; the authority lives in `<taskDir>/proxy-ca/` until close. */
  taskDir: string
  /** Decides which hosts get every method. Defaults to `resolvesToLoopbackOnly`. */
  isLoopback?: IsLoopback
  /** Decides which resolved addresses a remote request may reach. Defaults to `isPublicAddress`. */
  isAllowedRemoteAddress?: (address: string) => boolean
  /** Replaces Node's bundled roots for upstream verification (tests). */
  upstreamCa?: string | Buffer
  /** Idle limit for upstream requests and tunnelled sockets. */
  idleTimeoutMs?: number
  log?: Logger
}

export type EgressProxy = {
  url: string
  port: number
  caCertPath: string
  close(): Promise<void>
}

type CertificateAuthority = { dir: string; certPath: string; keyPath: string; leafKeyPath: string }
type LeafContext = tls.SecureContext
type Target = { host: string; port: number }

const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, '').toLowerCase()

/** True for an address in 127.0.0.0/8 or ::1 (including the IPv4-mapped form). */
export function isLoopbackAddress(address: string): boolean {
  const bare = stripBrackets(address)
  const mapped = bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare
  if (net.isIPv4(mapped)) return mapped.split('.')[0] === '127'
  if (net.isIPv6(bare)) return bare === '::1' || bare === '0:0:0:0:0:0:0:1'
  return false
}

/** True for an IP address outside every private, link-local, metadata, loopback and special range. */
export function isPublicAddress(address: string): boolean {
  const bare = stripBrackets(address)
  if (net.isIPv4(bare)) return !NON_PUBLIC_ADDRESSES.check(bare, 'ipv4')
  if (net.isIPv6(bare)) return !NON_PUBLIC_ADDRESSES.check(bare, 'ipv6') && !IPV4_MAPPED.check(bare, 'ipv6')
  return false
}

/** A DNS name with labels of 1 to 63 letters, digits and inner hyphens, 253 characters at most. */
export function isValidHostname(host: string): boolean {
  return host.length <= 253 && host.split('.').every((label) => label.length <= 63 && DNS_LABEL_PATTERN.test(label))
}

/**
 * True when the host is a loopback literal, or a name whose every resolved
 * address is loopback. A name with any non-loopback address, or one that does
 * not resolve, is not loopback.
 */
export async function resolvesToLoopbackOnly(host: string): Promise<boolean> {
  const bare = stripBrackets(host)
  if (net.isIP(bare) !== 0) return isLoopbackAddress(bare)
  try {
    const addresses = await dns.promises.lookup(bare, { all: true, verbatim: true })
    return addresses.length > 0 && addresses.every((entry) => isLoopbackAddress(entry.address))
  } catch {
    return false
  }
}

/**
 * A socket `lookup` that resolves at connect time and fails unless every
 * address passes `allowed`. Loopback sockets use it so a name that rebinds
 * between the check and the connect cannot reach a remote host; remote
 * sockets use it so a public name cannot point at a private address.
 */
function lookupAllowing(allowed: (address: string) => boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      const first = addresses?.[0]
      if (error) return callback(error, '')
      if (first === undefined || !addresses.every((entry) => allowed(entry.address))) {
        return callback(Object.assign(new Error(`${hostname} resolves to a refused address`), { code: BLOCKED_ADDRESS_CODE }), '')
      }
      if (options.all === true) return callback(null, addresses)
      callback(null, first.address, first.family)
    })
  }
}

const loopbackOnlyLookup = lookupAllowing(isLoopbackAddress)

/** Adds or refreshes a cache entry, dropping the least recently used ones past `max`. */
export function rememberBounded<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
  cache.delete(key)
  cache.set(key, value)
  for (const oldest of cache.keys()) {
    if (cache.size <= max) break
    cache.delete(oldest)
  }
}

function runOpenssl(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(OPENSSL_BINARY_PATH, args as string[], (error, stdout, stderr) => {
      if (error) reject(new Error(`openssl ${args[0]} failed: ${String(stderr).trim() || error.message}`))
      else resolve(String(stdout))
    })
  })
}

async function generateKey(path: string): Promise<void> {
  await runOpenssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-out', path])
  await chmod(path, 0o600)
}

/** Creates the task authority and the one key every leaf certificate shares. */
async function createAuthority(taskDir: string): Promise<CertificateAuthority> {
  const dir = join(taskDir, PROXY_CA_DIR_NAME)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const ca: CertificateAuthority = {
    dir,
    certPath: join(dir, 'ca.pem'),
    keyPath: join(dir, 'ca.key'),
    leafKeyPath: join(dir, 'leaf.key'),
  }
  const configPath = join(dir, 'ca.cnf')
  await writeFile(
    configPath,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3_ca',
      'prompt = no',
      '[dn]',
      'CN = relay task egress proxy',
      '[v3_ca]',
      'basicConstraints = critical, CA:true, pathlen:0',
      'keyUsage = critical, keyCertSign, cRLSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
  )
  await generateKey(ca.keyPath)
  await runOpenssl(['req', '-x509', '-new', '-key', ca.keyPath, '-days', '30', '-sha256', '-config', configPath, '-out', ca.certPath])
  await generateKey(ca.leafKeyPath)
  return ca
}

/** Signs a leaf certificate for one host (a validated DNS name or IP literal). */
async function mintLeaf(ca: CertificateAuthority, host: string): Promise<string> {
  const ip = net.isIP(host) !== 0
  if (!ip && !isValidHostname(host)) throw new Error('host is not a valid DNS name')
  const id = randomBytes(8).toString('hex')
  const csrPath = join(ca.dir, `${id}.csr`)
  const extPath = join(ca.dir, `${id}.ext`)
  try {
    await writeFile(
      extPath,
      [
        'basicConstraints = critical, CA:false',
        'keyUsage = critical, digitalSignature, keyEncipherment',
        'extendedKeyUsage = serverAuth',
        `subjectAltName = ${ip ? 'IP' : 'DNS'}:${host}`,
        '',
      ].join('\n'),
    )
    await runOpenssl(['req', '-new', '-key', ca.leafKeyPath, '-subj', '/CN=relay egress leaf', '-out', csrPath])
    return await runOpenssl([
      'x509', '-req', '-in', csrPath, '-CA', ca.certPath, '-CAkey', ca.keyPath,
      '-set_serial', `0x${randomBytes(12).toString('hex')}`, '-days', '30', '-sha256', '-extfile', extPath,
    ])
  } finally {
    await rm(csrPath, { force: true })
    await rm(extPath, { force: true })
  }
}

/** Splits `host:port` (with `[v6]:port`); null when malformed. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority)
  if (match === null) return null
  const host = (match[1] ?? match[2] ?? '').toLowerCase()
  const port = Number(match[3])
  if (host === '' || port < 1 || port > 65535) return null
  if (match[1] !== undefined && net.isIPv6(host) === false) return null
  return { host, port }
}

/** The `Host` value for a checked target, with the port only when it is not the scheme's default. */
function hostHeader({ host, port }: Target, defaultPort: number): string {
  const name = net.isIPv6(host) ? `[${host}]` : host
  return port === defaultPort ? name : `${name}:${port}`
}

/** A request body would carry data off the machine, so a remote read must not have one. */
function hasBody(req: IncomingMessage): boolean {
  return req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? '0') !== 0
}

function forwardHeaders(headers: IncomingMessage['headers']): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name)) forwarded[name] = value
  }
  return forwarded
}

function refuse(res: ServerResponse, status: number, reason: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
  res.end(`relay egress proxy: ${reason}\n`)
}

function refuseSocket(socket: Socket | tls.TLSSocket, status: number, reason: string): void {
  const text = `relay egress proxy: ${reason}\n`
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\ncontent-type: text/plain; charset=utf-8\r\n` +
      `content-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`,
  )
}

function pipeResponse(upstream: http.ClientRequest, res: ServerResponse, onError: (error: NodeJS.ErrnoException) => void): void {
  upstream.on('response', (response) => {
    res.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers))
    response.pipe(res)
  })
  upstream.on('timeout', () => upstream.destroy(new Error('upstream idle timeout')))
  upstream.on('error', onError)
  res.on('close', () => upstream.destroy())
}

/** Starts the proxy on 127.0.0.1 with a fresh task authority. */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const isLoopback = options.isLoopback ?? resolvesToLoopbackOnly
  const isAllowedRemoteAddress = options.isAllowedRemoteAddress ?? isPublicAddress
  const remoteLookup = lookupAllowing(isAllowedRemoteAddress)
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const log = options.log
  const ca = await createAuthority(options.taskDir)
  const leaves = new Map<string, Promise<LeafContext>>()
  const sockets = new Set<Socket>()
  const tunnelTargets = new WeakMap<Socket, Target>()
  const upstreamAgent = new https.Agent({ keepAlive: true })
  let leafKey: Buffer | undefined

  const note = (method: string, host: string, reason: string): void => {
    log?.info({ method, host, reason }, 'egress proxy refused a request')
  }

  const leafContext = (host: string): Promise<LeafContext> => {
    let cached = leaves.get(host)
    if (cached === undefined) {
      cached = (async () => {
        leafKey ??= await readFile(ca.leafKeyPath)
        const cert = await mintLeaf(ca, host)
        return tls.createSecureContext({ key: leafKey, cert })
      })()
      cached.catch(() => leaves.delete(host))
    }
    rememberBounded(leaves, host, cached, MAX_CACHED_LEAVES)
    return cached
  }

  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  }

  const idle = (socket: Socket): void => {
    socket.setTimeout(idleTimeoutMs, () => socket.destroy())
  }

  /** Why a remote target is refused before any connection is opened, or null. */
  const remoteRefusal = (method: string, req: IncomingMessage, host: string): string | null => {
    if (!READ_METHODS.has(method)) return `${method} to a non-loopback host is not allowed`
    if (hasBody(req)) return `a ${method} with a body to a non-loopback host is not allowed`
    if (net.isIP(host) !== 0 && !isAllowedRemoteAddress(host)) return 'that address is not reachable through this proxy'
    return null
  }

  const upstreamFailed = (res: ServerResponse, method: string, host: string) => (error: NodeJS.ErrnoException) => {
    if (error.code === BLOCKED_ADDRESS_CODE) {
      note(method, host, 'resolves to a refused address')
      return refuse(res, 403, 'that address is not reachable through this proxy')
    }
    // An unverifiable upstream certificate fails here like any other connection error.
    note(method, host, 'upstream connection or verification failed')
    refuse(res, 502, 'upstream connection or certificate verification failed')
  }

  /**
   * Pipes a raw loopback tunnel both ways. Before the upstream connects a
   * failure is answered with a 502; after it, the tunnel is just closed, so
   * nothing is written into the tunnelled stream.
   */
  const tunnelLoopback = (socket: Socket, target: Target, onConnect: (upstream: Socket) => void): void => {
    const upstream = net.connect({ host: target.host, port: target.port, lookup: loopbackOnlyLookup })
    track(upstream)
    idle(upstream)
    idle(socket)
    let connected = false
    upstream.on('connect', () => {
      connected = true
      onConnect(upstream)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => (connected ? socket.destroy() : refuseSocket(socket, 502, 'upstream connection failed')))
    upstream.on('close', () => connected && socket.destroy())
    socket.on('close', () => upstream.destroy())
  }

  // Plain HTTP in absolute form: http://host:port/path.
  const handlePlainRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? ''
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      return refuse(res, 400, 'expected an absolute http:// URL')
    }
    if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') {
      return refuse(res, 400, 'expected an absolute http:// URL')
    }
    const target = { host: stripBrackets(url.hostname), port: url.port === '' ? 80 : Number(url.port) }
    const loopback = await isLoopback(target.host)
    const refusal = loopback ? null : remoteRefusal(method, req, target.host)
    if (refusal !== null) {
      note(method, target.host, refusal)
      req.resume()
      return refuse(res, 403, refusal)
    }
    const upstream = http.request({
      host: target.host,
      port: target.port,
      method,
      path: `${url.pathname}${url.search}`,
      headers: { ...forwardHeaders(req.headers), host: hostHeader(target, 80) },
      agent: false,
      timeout: idleTimeoutMs,
      lookup: loopback ? loopbackOnlyLookup : remoteLookup,
    })
    pipeResponse(upstream, res, upstreamFailed(res, method, target.host))
    if (loopback) req.pipe(upstream)
    else upstream.end()
  }

  // An Upgrade request in absolute form (a WebSocket over plain HTTP).
  const handlePlainUpgrade = async (req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
    track(socket)
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      return refuseSocket(socket, 400, 'expected an absolute http:// URL')
    }
    const host = stripBrackets(url.hostname)
    if (url.protocol !== 'http:' || !(await isLoopback(host))) {
      note(req.method ?? '', host, 'upgrade to a remote host')
      return refuseSocket(socket, 403, 'upgrades to a non-loopback host are not allowed')
    }
    tunnelLoopback(socket, { host, port: url.port === '' ? 80 : Number(url.port) }, (upstream) => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] ?? ''
        if (!['proxy-connection', 'proxy-authorization'].includes(name.toLowerCase())) lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ''}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      upstream.write(head)
    })
  }

  // One server reads the requests of every terminated TLS tunnel; each tunnel's target is keyed by its socket.
  const tunnelServer = http.createServer((req, res) => {
    const method = req.method ?? ''
    const target = tunnelTargets.get(req.socket)
    if (target === undefined) return refuse(res, 400, 'unknown tunnel')
    const path = req.url ?? ''
    if (!path.startsWith('/') || path.startsWith('//')) {
      note(method, target.host, 'not an origin-form path')
      req.resume()
      return refuse(res, 400, 'expected an origin-form path')
    }
    const refusal = remoteRefusal(method, req, target.host)
    if (refusal !== null) {
      note(method, target.host, refusal)
      req.resume()
      return refuse(res, 403, refusal)
    }
    const upstream = https.request({
      host: target.host,
      port: target.port,
      ...(net.isIP(target.host) === 0 ? { servername: target.host } : {}),
      method,
      path,
      headers: { ...forwardHeaders(req.headers), host: hostHeader(target, 443) },
      agent: upstreamAgent,
      timeout: idleTimeoutMs,
      lookup: remoteLookup,
      rejectUnauthorized: true,
      ...(options.upstreamCa === undefined ? {} : { ca: options.upstreamCa }),
    })
    pipeResponse(upstream, res, upstreamFailed(res, method, target.host))
    upstream.end()
  })
  tunnelServer.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    note(req.method ?? '', tunnelTargets.get(socket)?.host ?? '', 'upgrade to a remote host')
    refuseSocket(socket, 403, 'upgrades to a non-loopback host are not allowed')
  })
  tunnelServer.on('clientError', (_error, socket) => socket.destroy())

  const handleConnect = async (req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
    track(socket)
    const target = parseAuthority(req.url ?? '')
    if (target === null) return refuseSocket(socket, 400, 'expected CONNECT host:port')

    if (await isLoopback(target.host)) {
      tunnelLoopback(socket, target, (upstream) => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
      })
      return
    }

    let context: LeafContext
    try {
      context = await leafContext(target.host)
    } catch {
      note('CONNECT', target.host, 'no certificate for host')
      return refuseSocket(socket, 403, 'cannot terminate TLS for this host')
    }
    idle(socket)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) socket.unshift(head)
    // No ALPN, so the browser speaks HTTP/1.1 and every request is visible.
    const terminated = new tls.TLSSocket(socket, { isServer: true, secureContext: context })
    terminated.on('error', () => socket.destroy())
    tunnelTargets.set(terminated, target)
    tunnelServer.emit('connection', terminated)
  }

  const server = http.createServer((req, res) => {
    handlePlainRequest(req, res).catch(() => refuse(res, 502, 'proxy error'))
  })
  server.on('connection', track)
  server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    handleConnect(req, socket, head).catch(() => refuseSocket(socket, 502, 'proxy error'))
  })
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    handlePlainUpgrade(req, socket, head).catch(() => refuseSocket(socket, 502, 'proxy error'))
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (error) {
    await rm(ca.dir, { recursive: true, force: true })
    throw error
  }
  const port = (server.address() as net.AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    caCertPath: ca.certPath,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      })
      upstreamAgent.destroy()
      leaves.clear()
      await rm(ca.dir, { recursive: true, force: true })
    },
  }
}
