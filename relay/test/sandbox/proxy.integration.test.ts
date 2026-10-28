import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runSandboxed, sandboxAvailability } from '../../src/sandbox/exec.js'
import { headerValue, parseConnectTarget, startEgressProxy } from '../../src/sandbox/proxy.js'
import type { EgressProxy } from '../../src/sandbox/proxy.js'

/**
 * FR-SH-6's acceptance criterion has three parts, and this proves all three
 * together because each is worthless alone:
 *
 *   1. traffic to a DECLARED host reaches it through the proxy
 *   2. traffic to an UNDECLARED host is terminated by the proxy
 *   3. a direct socket that tries to go around the proxy fails at the
 *      KERNEL, which is what makes 2 unbypassable rather than advisory
 *
 * Everything runs on loopback: the "internet" here is a local server. A test
 * that reached a real host would depend on the network, on that host staying
 * up, and would send traffic to a destination the egress inventory has no
 * reason to declare.
 */

const available = sandboxAvailability().available
const describeIfSandboxed = available ? describe : describe.skip

let destination: Server
let destinationPort: number
let proxy: EgressProxy

beforeAll(async () => {
  destination = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('reached-the-declared-host')
  })
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', () => resolve()))
  destinationPort = (destination.address() as AddressInfo).port

  // 127.0.0.1 is declared; nothing else is.
  proxy = await startEgressProxy({ allowedHosts: ['127.0.0.1'] })
})

afterAll(async () => {
  await proxy.close()
  await new Promise<void>((resolve) => {
    destination.closeAllConnections()
    destination.close(() => resolve())
  })
})

/** Speaks the proxy protocol directly, since a normal HTTP client cannot express "ask this proxy for that host". */
function rawProxyRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(request))
    let reply = ''
    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve(reply)
    })
    socket.on('data', (chunk: Buffer) => {
      reply += chunk.toString()
    })
    socket.on('close', () => resolve(reply))
    socket.on('error', reject)
  })
}

describe('parseConnectTarget', () => {
  it('splits on the LAST colon, so an IPv6 literal does not parse as nonsense', () => {
    expect(parseConnectTarget('example.com:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseConnectTarget('[::1]:443')).toEqual({ host: '::1', port: 443 })
  })

  it('rejects a target with no usable port rather than guessing one', () => {
    expect(parseConnectTarget('example.com')).toBeUndefined()
    expect(parseConnectTarget('example.com:0')).toBeUndefined()
    expect(parseConnectTarget(':443')).toBeUndefined()
  })
})

describe('a header value cannot split the re-emitted request', () => {
  it('DROPS a value carrying CR or LF rather than writing it into the request line', () => {
    // The proxy rebuilds the request rather than forwarding a parsed object,
    // so a surviving CRLF would end the headers and let the rest be read as
    // a NEW request, with the confined run on the writing end.
    expect(headerValue('evil\r\nX-Injected: 1')).toBe('')
    expect(headerValue('evil\nX-Injected: 1')).toBe('')
  })

  it('passes an ordinary value through, and joins a repeated header', () => {
    expect(headerValue('application/json')).toBe('application/json')
    expect(headerValue(['a', 'b'])).toBe('a, b')
    expect(headerValue(undefined)).toBe('')
  })
})

describe('the proxy enforces the destination list', () => {
  it('refuses an undeclared host and says so, rather than timing out', async () => {
    // Sent as a raw absolute-form request, which is what a proxy actually
    // receives. Node's own fetch ignores a supplied `host` header, so it
    // cannot express "ask this proxy for that host" at all.
    const reply = await rawProxyRequest(proxy.port, 'GET http://not-declared.example/ HTTP/1.1\r\nHost: not-declared.example\r\n\r\n')

    expect(reply).toContain('403')
    const refusal = proxy.attempts.find((attempt) => attempt.host === 'not-declared.example')
    expect(refusal?.allowed).toBe(false)
    expect(refusal?.reason).toContain("not in this run's declared destination list")
  })

  it('refuses an undeclared host on CONNECT, before any tunnel exists', async () => {
    // The enforcement point for HTTPS. The hostname is in the CONNECT line
    // in the clear, so no TLS interception is needed to enforce here.
    const reply = await rawProxyRequest(proxy.port, 'CONNECT secret.example:443 HTTP/1.1\r\nHost: secret.example:443\r\n\r\n')

    expect(reply).toContain('403')
    expect(proxy.attempts.some((attempt) => attempt.host === 'secret.example' && attempt.method === 'connect' && !attempt.allowed)).toBe(true)
  })

  it('logs every attempt, allowed or refused, since a silent denial reads as a broken network', () => {
    expect(proxy.attempts.length).toBeGreaterThan(0)
    expect(proxy.attempts.every((attempt) => typeof attempt.host === 'string')).toBe(true)
  })
})

describeIfSandboxed('the sandbox and the proxy together, which is the whole FR-SH-6 claim', () => {
  it('reaches a DECLARED host through the proxy', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-proxy-ok-'))
    try {
      const result = await runSandboxed({
        spec: { worktree, proxyPort: proxy.port },
        command: '/bin/sh',
        args: [
          '-c',
          `/usr/bin/curl -s -m 10 --proxy http://127.0.0.1:${proxy.port} http://127.0.0.1:${destinationPort}/ ; echo; echo DONE`,
        ],
        timeoutMs: 25_000,
      })

      expect(result.outcome).toBe('ran')
      if (result.outcome !== 'ran') return
      expect(result.stdout).toContain('DONE')
      expect(result.stdout).toContain('reached-the-declared-host')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 35_000)

  it('CANNOT reach the destination directly, bypassing the proxy', async () => {
    // This is the property that makes the destination list mean anything.
    // The destination server is alive and on loopback; only the kernel is
    // stopping this.
    const worktree = mkdtempSync(join(tmpdir(), 'relay-proxy-bypass-'))
    try {
      const result = await runSandboxed({
        spec: { worktree, proxyPort: proxy.port },
        command: '/bin/sh',
        args: ['-c', `/usr/bin/curl -s -m 5 http://127.0.0.1:${destinationPort}/ ; echo; echo DONE`],
        timeoutMs: 25_000,
      })

      expect(result.outcome).toBe('ran')
      if (result.outcome !== 'ran') return
      expect(result.stdout).toContain('DONE')
      expect(result.stdout).not.toContain('reached-the-declared-host')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 35_000)

  it('is refused by the PROXY when it asks for an undeclared host through it', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-proxy-denied-'))
    try {
      const result = await runSandboxed({
        spec: { worktree, proxyPort: proxy.port },
        command: '/bin/sh',
        args: [
          '-c',
          `/usr/bin/curl -s -m 10 --proxy http://127.0.0.1:${proxy.port} http://undeclared.example/ ; echo; echo DONE`,
        ],
        timeoutMs: 25_000,
      })

      expect(result.outcome).toBe('ran')
      if (result.outcome !== 'ran') return
      expect(result.stdout).toContain('DONE')
      expect(proxy.attempts.some((attempt) => attempt.host === 'undeclared.example' && !attempt.allowed)).toBe(true)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 35_000)
})
