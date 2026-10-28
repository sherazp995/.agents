import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  isLoopbackAddress,
  isPublicAddress,
  isValidHostname,
  OPENSSL_BINARY_PATH,
  parseAuthority,
  rememberBounded,
  resolvesToLoopbackOnly,
  startEgressProxy,
  type EgressProxy,
} from '../../src/autonomous/egress-proxy.js'

type Hit = { method: string; url: string }
type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string }

const openssl = (dir: string, ...args: string[]) => execFileSync(OPENSSL_BINARY_PATH, args, { cwd: dir, stdio: 'pipe' })

/** A test root, a 127.0.0.1 certificate it signs, and a self-signed one it does not. */
function upstreamCertificates(dir: string): { ca: string; key: string; cert: string; selfSignedKey: string; selfSignedCert: string } {
  writeFileSync(join(dir, 'ca.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=upstream test root\n[v3]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign\n')
  writeFileSync(join(dir, 'leaf.ext'), 'basicConstraints=CA:false\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n')
  writeFileSync(join(dir, 'self.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=self\n[v3]\nsubjectAltName=IP:127.0.0.1\n')
  openssl(dir, 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-out', 'ca.key')
  openssl(dir, 'req', '-x509', '-new', '-key', 'ca.key', '-days', '2', '-sha256', '-config', 'ca.cnf', '-out', 'ca.pem')
  openssl(dir, 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-out', 'leaf.key')
  openssl(dir, 'req', '-new', '-key', 'leaf.key', '-subj', '/CN=upstream', '-out', 'leaf.csr')
  openssl(dir, 'x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '1', '-days', '2', '-sha256', '-extfile', 'leaf.ext', '-out', 'leaf.pem')
  openssl(dir, 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-out', 'self.key')
  openssl(dir, 'req', '-x509', '-new', '-key', 'self.key', '-days', '2', '-sha256', '-config', 'self.cnf', '-out', 'self.pem')
  const read = (name: string) => readFileSync(join(dir, name), 'utf8')
  return { ca: read('ca.pem'), key: read('leaf.key'), cert: read('leaf.pem'), selfSignedKey: read('self.key'), selfSignedCert: read('self.pem') }
}

function recordingHandler(hits: Hit[]): http.RequestListener {
  return (req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '' })
    seenHosts.push(req.headers.host ?? '')
    req.resume()
    if (req.url === '/redirect') {
      res.writeHead(307, { location: `https://127.0.0.1:${remotePort()}/submit` })
      return res.end()
    }
    res.end(`ok ${req.method}`)
  }
}

async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function collect(req: http.ClientRequest, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Opens a CONNECT tunnel through the proxy; resolves with the tunnel socket and the proxy's status. */
function connectTunnel(proxy: EgressProxy, authority: string): Promise<{ status: number; socket: import('node:net').Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: authority })
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }))
    req.on('error', reject)
    req.end()
  })
}

/** A TLS session to a "remote" 127.0.0.1 port through the proxy, trusting only the task authority. */
async function tlsThroughProxy(proxy: EgressProxy, port: number): Promise<tls.TLSSocket> {
  const { status, socket } = await connectTunnel(proxy, `127.0.0.1:${port}`)
  expect(status).toBe(200)
  const secure = tls.connect({ socket, host: '127.0.0.1', ca: readFileSync(proxy.caCertPath), rejectUnauthorized: true })
  await new Promise<void>((resolve, reject) => {
    secure.once('secureConnect', resolve)
    secure.once('error', reject)
  })
  return secure
}

/** One HTTPS request to a "remote" 127.0.0.1 port through the proxy. */
async function httpsThroughProxy(proxy: EgressProxy, port: number, method: string, path: string, headers: http.OutgoingHttpHeaders = {}): Promise<Reply> {
  const secure = await tlsThroughProxy(proxy, port)
  const req = http.request({ createConnection: () => secure, host: '127.0.0.1', port, method, path, headers })
  return collect(req, method === 'POST' ? 'payload' : undefined)
}

/** Writes raw HTTP into a terminated tunnel and returns everything read until the proxy closes it. */
async function rawThroughProxy(proxy: EgressProxy, port: number, text: string): Promise<string> {
  const secure = await tlsThroughProxy(proxy, port)
  let replies = ''
  secure.setEncoding('utf8')
  secure.on('data', (chunk: string) => (replies += chunk))
  const ended = new Promise((resolve) => secure.on('end', resolve))
  secure.write(text)
  await ended
  return replies
}

const statuses = (replies: string) => [...replies.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((match) => match[1])

function plainThroughProxy(proxy: EgressProxy, url: string, method: string, headers: http.OutgoingHttpHeaders = {}, body?: string): Promise<Reply> {
  const req = http.request({ host: '127.0.0.1', port: proxy.port, method, path: url, headers: { host: new URL(url).host, ...headers } })
  return collect(req, body ?? (method === 'POST' ? 'payload' : undefined))
}

let remote: https.Server
let untrusted: https.Server
let loopback: http.Server
let remotePortNumber = 0
let untrustedPort = 0
let loopbackPort = 0
let upstreamCa = ''
const remoteHits: Hit[] = []
const loopbackHits: Hit[] = []
const seenHosts: string[] = []
const remotePort = () => remotePortNumber

// 127.0.0.1 counts as remote; only the name `localhost` is loopback.
const onlyLocalhost = async (host: string) => host === 'localhost'

beforeAll(async () => {
  const certs = upstreamCertificates(mkdtempSync(join(tmpdir(), 'relay-proxy-upstream-')))
  upstreamCa = certs.ca
  remote = https.createServer({ key: certs.key, cert: certs.cert }, recordingHandler(remoteHits))
  remote.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n'))
  untrusted = https.createServer({ key: certs.selfSignedKey, cert: certs.selfSignedCert }, recordingHandler(remoteHits))
  loopback = http.createServer(recordingHandler(loopbackHits))
  remotePortNumber = await listen(remote)
  untrustedPort = await listen(untrusted)
  loopbackPort = await listen(loopback)
})

afterAll(async () => {
  for (const server of [remote, untrusted, loopback]) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

describe('startEgressProxy', () => {
  let proxy: EgressProxy
  let taskDir: string

  beforeAll(async () => {
    taskDir = mkdtempSync(join(tmpdir(), 'relay-proxy-task-'))
    // Every address is allowed here so 127.0.0.1 can stand in for a public host.
    proxy = await startEgressProxy({ taskDir, isLoopback: onlyLocalhost, isAllowedRemoteAddress: () => true, upstreamCa })
  })

  afterAll(async () => {
    await proxy.close()
  })

  afterEach(() => {
    remoteHits.length = 0
    loopbackHits.length = 0
    seenHosts.length = 0
  })

  it('binds 127.0.0.1 and keeps the task authority keys private', () => {
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`)
    expect(statSync(join(taskDir, 'proxy-ca', 'ca.key')).mode & 0o777).toBe(0o600)
    expect(statSync(join(taskDir, 'proxy-ca', 'leaf.key')).mode & 0o777).toBe(0o600)
  })

  it('passes an HTTPS GET to a remote host and refuses an HTTPS POST before it leaves', async () => {
    const get = await httpsThroughProxy(proxy, remotePort(), 'GET', '/page')
    const post = await httpsThroughProxy(proxy, remotePort(), 'POST', '/submit')

    expect(get).toMatchObject({ status: 200, body: 'ok GET' })
    expect(post.status).toBe(403)
    expect(post.body).toContain('POST to a non-loopback host is not allowed')
    expect(remoteHits).toEqual([{ method: 'GET', url: '/page' }])
  })

  it('checks every request on a kept-alive tunnel', async () => {
    const replies = await rawThroughProxy(proxy, remotePort(), 'GET /one HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\nPUT /two HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 1\r\n\r\nx')

    expect(statuses(replies)).toEqual(['200', '403'])
    expect(remoteHits).toEqual([{ method: 'GET', url: '/one' }])
  })

  it('sends the checked target as Host, never the client value', async () => {
    await httpsThroughProxy(proxy, remotePort(), 'GET', '/page', { host: 'evil.example' })
    await plainThroughProxy(proxy, `http://127.0.0.1:${loopbackPort}/page`, 'GET', { host: 'evil.example' })

    expect(seenHosts).toEqual([`127.0.0.1:${remotePort()}`, `127.0.0.1:${loopbackPort}`])
  })

  it('refuses a tunnelled request whose target is not an origin-form path', async () => {
    const protocolRelative = await rawThroughProxy(proxy, remotePort(), 'GET //evil.example/x HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n')
    const absolute = await rawThroughProxy(proxy, remotePort(), 'GET http://evil.example/x HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n')

    expect([statuses(protocolRelative), statuses(absolute)]).toEqual([['400'], ['400']])
    expect(remoteHits).toEqual([])
  })

  it('refuses a remote GET that carries a body, tunnelled or plain', async () => {
    const sized = await rawThroughProxy(proxy, remotePort(), 'GET /x HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 3\r\n\r\nabc')
    const chunked = await rawThroughProxy(proxy, remotePort(), 'GET /x HTTP/1.1\r\nhost: 127.0.0.1\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n')
    const plain = await plainThroughProxy(proxy, `http://127.0.0.1:${loopbackPort}/x`, 'GET', { 'content-length': 6 }, 'secret')

    expect([statuses(sized), statuses(chunked), plain.status]).toEqual([['403'], ['403'], 403])
    expect([...remoteHits, ...loopbackHits]).toEqual([])
  })

  it('refuses a host name that is not a valid DNS name before terminating TLS', async () => {
    const { status } = await connectTunnel(proxy, `${'a'.repeat(64)}.example:443`)

    expect(status).toBe(403)
  })

  it('closes a loopback tunnel without writing into it when the upstream fails after connecting', async () => {
    const resetting = net.createServer((socket) => socket.once('data', () => socket.resetAndDestroy()))
    const port = await listen(resetting as unknown as http.Server)
    const { socket } = await connectTunnel(proxy, `localhost:${port}`)
    let received = ''
    socket.on('data', (chunk: Buffer) => (received += chunk.toString()))
    const closed = new Promise((resolve) => socket.on('close', resolve))
    socket.write('hello')
    await closed
    resetting.close()

    expect(received).toBe('')
  })

  it('refuses a WebSocket upgrade to a remote host', async () => {
    const reply = await httpsThroughProxy(proxy, remotePort(), 'GET', '/socket', { connection: 'Upgrade', upgrade: 'websocket' })

    expect(reply.status).toBe(403)
    expect(reply.body).toContain('upgrades to a non-loopback host are not allowed')
  })

  it('refuses a plain HTTP POST to a remote host and passes a GET', async () => {
    const post = await plainThroughProxy(proxy, `http://127.0.0.1:${loopbackPort}/form`, 'POST')
    const get = await plainThroughProxy(proxy, `http://127.0.0.1:${loopbackPort}/page`, 'GET')

    expect([post.status, get.status]).toEqual([403, 200])
    expect(loopbackHits).toEqual([{ method: 'GET', url: '/page' }])
  })

  it('passes GET and POST to a loopback host, plain and tunnelled', async () => {
    const get = await plainThroughProxy(proxy, `http://localhost:${loopbackPort}/page`, 'GET')
    const post = await plainThroughProxy(proxy, `http://localhost:${loopbackPort}/form`, 'POST')
    const { status, socket } = await connectTunnel(proxy, `localhost:${loopbackPort}`)
    const tunnelled = await collect(http.request({ createConnection: () => socket, host: 'localhost', port: loopbackPort, method: 'POST', path: '/tunnel' }), 'x')

    expect([get.status, post.status, status, tunnelled.status]).toEqual([200, 200, 200, 200])
    expect(loopbackHits).toEqual([
      { method: 'GET', url: '/page' },
      { method: 'POST', url: '/form' },
      { method: 'POST', url: '/tunnel' },
    ])
  })

  it('fails an upstream whose certificate the trusted roots did not sign', async () => {
    const reply = await httpsThroughProxy(proxy, untrustedPort, 'GET', '/page')

    expect(reply.status).toBe(502)
    expect(remoteHits).toEqual([])
  })

  it('passes a loopback redirect back, and refuses the follow-up POST to the remote host', async () => {
    const redirect = await plainThroughProxy(proxy, `http://localhost:${loopbackPort}/redirect`, 'POST')
    const location = new URL(redirect.headers.location ?? '')
    const followed = await httpsThroughProxy(proxy, Number(location.port), 'POST', location.pathname)

    expect(redirect.status).toBe(307)
    expect(followed.status).toBe(403)
    expect(remoteHits).toEqual([])
  })
})

describe('startEgressProxy default remote address policy', () => {
  it('refuses loopback and private addresses reached as a remote host, literal or resolved', async () => {
    const proxy = await startEgressProxy({ taskDir: mkdtempSync(join(tmpdir(), 'relay-proxy-task-')), isLoopback: onlyLocalhost, upstreamCa })
    const neverLoopback = await startEgressProxy({ taskDir: mkdtempSync(join(tmpdir(), 'relay-proxy-task-')), isLoopback: async () => false })
    try {
      const tunnelled = await httpsThroughProxy(proxy, remotePort(), 'GET', '/page')
      const plain = await plainThroughProxy(proxy, `http://127.0.0.1:${loopbackPort}/page`, 'GET')
      const resolved = await plainThroughProxy(neverLoopback, `http://localhost:${loopbackPort}/page`, 'GET')

      expect([tunnelled.status, plain.status, resolved.status]).toEqual([403, 403, 403])
      expect([...remoteHits, ...loopbackHits]).toEqual([])
    } finally {
      await proxy.close()
      await neverLoopback.close()
    }
  })
})

describe('startEgressProxy idle timeout', () => {
  it('closes a tunnel that stays idle past the limit', async () => {
    const silent = net.createServer(() => undefined)
    const port = await listen(silent as unknown as http.Server)
    const proxy = await startEgressProxy({ taskDir: mkdtempSync(join(tmpdir(), 'relay-proxy-task-')), isLoopback: onlyLocalhost, idleTimeoutMs: 100 })
    try {
      const { socket } = await connectTunnel(proxy, `localhost:${port}`)
      await new Promise((resolve) => socket.on('close', resolve))
    } finally {
      await proxy.close()
      silent.close()
    }
  })
})

describe('startEgressProxy close', () => {
  it('removes the task authority directory', async () => {
    const taskDir = mkdtempSync(join(tmpdir(), 'relay-proxy-task-'))
    const proxy = await startEgressProxy({ taskDir })
    expect(existsSync(proxy.caCertPath)).toBe(true)

    await proxy.close()

    expect(existsSync(join(taskDir, 'proxy-ca'))).toBe(false)
  })
})

describe('loopback classification', () => {
  it('accepts loopback literals and names that resolve only to loopback', async () => {
    expect(['127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1'].map(isLoopbackAddress)).toEqual([true, true, true, true, true])
    expect(['10.0.0.1', '128.0.0.1', '::2', 'example.com'].map(isLoopbackAddress)).toEqual([false, false, false, false])
    expect(await resolvesToLoopbackOnly('localhost')).toBe(true)
    expect(await resolvesToLoopbackOnly('93.184.216.34')).toBe(false)
    expect(await resolvesToLoopbackOnly('name.invalid')).toBe(false)
  })

  it('treats only public addresses as reachable remote addresses', () => {
    const refused = ['10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '127.0.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe']
    expect(refused.filter(isPublicAddress)).toEqual([])
    expect(['93.184.216.34', '172.32.0.1', '2606:4700::1111'].map(isPublicAddress)).toEqual([true, true, true])
  })

  it('validates DNS label and name lengths', () => {
    expect([`${'a'.repeat(63)}.com`, 'a-b.example'].map(isValidHostname)).toEqual([true, true])
    expect([`${'a'.repeat(64)}.com`, `${'a.'.repeat(127)}com`, '-a.com', 'a..com', 'a_b.com'].map(isValidHostname)).toEqual([false, false, false, false, false])
  })

  it('keeps the bounded cache to its most recently used entries', () => {
    const cache = new Map<string, number>()
    for (const key of ['a', 'b', 'c']) rememberBounded(cache, key, 1, 2)
    rememberBounded(cache, 'b', 2, 2)
    rememberBounded(cache, 'd', 3, 2)

    expect([...cache.keys()]).toEqual(['b', 'd'])
  })

  it('parses CONNECT authorities and rejects malformed ones', () => {
    expect(parseAuthority('example.com:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseAuthority('[::1]:8080')).toEqual({ host: '::1', port: 8080 })
    expect(['example.com', 'a:b:443', 'host:0', 'host:99999', '[nope]:1'].map(parseAuthority)).toEqual([null, null, null, null, null])
  })
})
