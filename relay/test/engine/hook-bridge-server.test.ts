import { afterEach, describe, expect, it } from 'vitest'
import type { Policy } from '../../src/config/schema.js'
import { HookBridgeServer } from '../../src/engine/hook-bridge.js'
import type { HookDecisionRequest } from '../../src/engine/hook-bridge.js'
import { MCP_CALL_PATH, MCP_RESULT_PATH } from '../../src/autonomous/mcp-protocol.js'

function buildPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    defaults: { unmatched: 'ask' },
    hard_blocked_origins: ['*.chase.com'],
    ...overrides,
  }
}

function buildRequest(overrides: Partial<HookDecisionRequest> = {}): HookDecisionRequest {
  return { toolUseId: 'toolu_test', toolName: 'Read', sessionId: 'session-1', ...overrides }
}

let activeServer: HookBridgeServer | undefined

async function startServer(policy: Policy = buildPolicy()): Promise<HookBridgeServer> {
  const server = new HookBridgeServer({ policy })
  await server.start()
  activeServer = server
  return server
}

afterEach(async () => {
  if (activeServer !== undefined) {
    await activeServer.stop()
    activeServer = undefined
  }
})

async function post(server: HookBridgeServer, body: unknown, token: string = server.token): Promise<{ status: number; body: unknown }> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

describe('HookBridgeServer: real requests against a real bound port', () => {
  it('binds to a real loopback port and answers a well-formed request with a real decision', async () => {
    const server = await startServer()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pre-tool-use$/)
    const { status, body } = await post(server, buildRequest({ toolName: 'Read' }))
    expect(status).toBe(200)
    expect(body).toMatchObject({ decision: 'allow' })
  })

  it('defers a tool that would need a human, over the real HTTP round trip', async () => {
    const server = await startServer()
    const { body } = await post(server, buildRequest({ toolName: 'Bash' }))
    expect(body).toMatchObject({ decision: 'defer' })
  })

  it('generates a fresh, high-entropy token per instance rather than a fixed or predictable one', async () => {
    const serverA = await startServer()
    const bServer = new HookBridgeServer({ policy: buildPolicy() })
    await bServer.start()
    try {
      expect(serverA.token).not.toBe(bServer.token)
      expect(serverA.token).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await bServer.stop()
    }
  })

  it('url getter throws before start() resolves, rather than returning a meaningless default', () => {
    const server = new HookBridgeServer({ policy: buildPolicy() })
    expect(() => server.url).toThrow()
  })
})

describe('HookBridgeServer: SELF-ATTACK: authentication must be real, required proof', () => {
  it('rejects a request with no Authorization header at all', async () => {
    const server = await startServer()
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildRequest()),
    })
    expect(response.status).toBe(401)
    const body = (await response.json()) as { decision: string }
    expect(body.decision).toBe('deny')
  })

  it('rejects a request bearing the wrong token', async () => {
    const server = await startServer()
    const { status, body } = await post(server, buildRequest(), 'not-the-real-token')
    expect(status).toBe(401)
    expect(body).toMatchObject({ decision: 'deny' })
  })

  it('rejects a token that is a truncated PREFIX of the real one (would defeat a naive startsWith check)', async () => {
    const server = await startServer()
    const { status } = await post(server, buildRequest(), server.token.slice(0, 8))
    expect(status).toBe(401)
  })

  it('accepts the real token', async () => {
    const server = await startServer()
    const { status } = await post(server, buildRequest())
    expect(status).toBe(200)
  })
})

describe('HookBridgeServer: malformed input over the wire, must deny, never 200-allow', () => {
  it('denies a malformed JSON body', async () => {
    const server = await startServer()
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: '{not valid json',
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { decision: string }
    expect(body.decision).toBe('deny')
  })

  it('denies a well-formed JSON body missing required fields', async () => {
    const server = await startServer()
    const { status, body } = await post(server, { toolName: 'Read' })
    expect(status).toBe(200) // the request reached resolveHookDecision, which itself denies cleanly
    expect(body).toMatchObject({ decision: 'deny' })
  })

  it('a GET request is refused rather than silently answered', async () => {
    const server = await startServer()
    const response = await fetch(server.url, { method: 'GET' })
    expect(response.status).toBe(404)
  })
})

describe('HookBridgeServer: SELF-ATTACK: the auth guard must be provably real', () => {
  it('proves the wrong-token rejection is not a fluke: ten distinct wrong tokens are all rejected', async () => {
    const server = await startServer()
    for (let i = 0; i < 10; i += 1) {
      const { status } = await post(server, buildRequest(), `wrong-token-${i}`)
      expect(status).toBe(401)
    }
  })
})

describe('HookBridgeServer: injected decide and per-invocation tokens', () => {
  const context = { workspaceId: 'w1', taskId: 't1', invocationId: 'i1', leaseGeneration: 3 }

  async function startWith(options: ConstructorParameters<typeof HookBridgeServer>[0]): Promise<HookBridgeServer> {
    const server = new HookBridgeServer(options)
    await server.start()
    activeServer = server
    return server
  }

  it('passes the issued token’s context to decide, and none for the instance token', async () => {
    const seen: unknown[] = []
    const server = await startWith({
      decide: async (_request, ctx) => {
        seen.push(ctx)
        return { decision: 'allow', reason: 'ok' }
      },
    })
    const token = server.issueToken(context)
    expect((await post(server, buildRequest(), token)).body).toMatchObject({ decision: 'allow' })
    await post(server, buildRequest())
    expect(seen).toEqual([context, undefined])
  })

  it('refuses a revoked token', async () => {
    const server = await startWith({ decide: async () => ({ decision: 'allow', reason: 'ok' }) })
    const token = server.issueToken(context)
    server.revokeToken(token)
    expect((await post(server, buildRequest(), token)).status).toBe(401)
  })

  it('denies when decide throws (a database failure)', async () => {
    const server = await startWith({
      decide: async () => {
        throw new Error('connection terminated')
      },
    })
    expect((await post(server, buildRequest())).body).toMatchObject({ decision: 'deny' })
  })

  it('denies by deadline when decide is slow', async () => {
    const server = await startWith({
      deadlineMs: 50,
      decide: () => new Promise((resolve) => setTimeout(() => resolve({ decision: 'allow', reason: 'too late' }), 1_000)),
    })
    const started = Date.now()
    expect((await post(server, buildRequest())).body).toMatchObject({ decision: 'deny', reason: expect.stringContaining('deadline') })
    expect(Date.now() - started).toBeLessThan(900)
  })

  it('denies a decision value it does not know', async () => {
    const server = await startWith({ decide: async () => ({ decision: 'maybe', reason: '' }) as never })
    expect((await post(server, buildRequest())).body).toMatchObject({ decision: 'deny' })
  })

  it('requires a policy or a decide function', () => {
    expect(() => new HookBridgeServer({})).toThrow()
  })

  it('answers 404 for an unknown path', async () => {
    const server = await startServer()
    const response = await fetch(new URL('/elsewhere', server.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}` },
      body: '{}',
    })
    expect(response.status).toBe(404)
  })
})

describe('HookBridgeServer: MCP endpoints', () => {
  const context = { workspaceId: 'w1', taskId: 't1', invocationId: 'i1', leaseGeneration: 3 }
  const call = { server: 'github', tool: 'create_comment', args: { body: 'hi' } }

  async function postTo(server: HookBridgeServer, path: string, body: unknown, token: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(new URL(path, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  it('answers a call with the injected decision and the token’s context', async () => {
    const seen: unknown[] = []
    const server = new HookBridgeServer({
      policy: buildPolicy(),
      decideMcpCall: async (request, ctx) => {
        seen.push([request, ctx])
        return { decision: 'pending', operationId: 'op-1', message: 'waiting' }
      },
    })
    await server.start()
    activeServer = server
    const token = server.issueToken(context)
    expect((await postTo(server, MCP_CALL_PATH, call, token)).body).toEqual({ decision: 'pending', operationId: 'op-1', message: 'waiting' })
    expect(seen).toEqual([[call, context]])
  })

  it('denies when the injected function throws, is slow, is absent, or the call is malformed', async () => {
    const throwing = new HookBridgeServer({
      policy: buildPolicy(),
      decideMcpCall: async () => {
        throw new Error('db down')
      },
    })
    const slow = new HookBridgeServer({
      policy: buildPolicy(),
      deadlineMs: 50,
      decideMcpCall: () => new Promise((resolve) => setTimeout(() => resolve({ decision: 'allow' }), 1_000)),
    })
    const absent = new HookBridgeServer({ policy: buildPolicy() })
    try {
      for (const server of [throwing, slow, absent]) {
        await server.start()
        expect((await postTo(server, MCP_CALL_PATH, call, server.token)).body).toMatchObject({ decision: 'deny' })
      }
      expect((await postTo(throwing, MCP_CALL_PATH, { server: 'x' }, throwing.token)).body).toMatchObject({ decision: 'deny' })
      expect((await postTo(throwing, MCP_CALL_PATH, call, 'wrong')).status).toBe(401)
    } finally {
      await Promise.all([throwing.stop(), slow.stop(), absent.stop()])
    }
  })

  it('records a result, and fails closed when recording throws or is absent', async () => {
    const recorded: unknown[] = []
    const server = new HookBridgeServer({
      policy: buildPolicy(),
      recordMcpResult: async (result, ctx) => {
        recorded.push([result, ctx])
      },
    })
    const failing = new HookBridgeServer({
      policy: buildPolicy(),
      recordMcpResult: async () => {
        throw new Error('db down')
      },
    })
    const absent = new HookBridgeServer({ policy: buildPolicy() })
    const result = { operationId: 'op-1', ok: true, result: { content: [] } }
    try {
      for (const each of [server, failing, absent]) await each.start()
      const token = server.issueToken(context)
      expect(await postTo(server, MCP_RESULT_PATH, result, token)).toEqual({ status: 200, body: { ok: true } })
      expect(recorded).toEqual([[result, context]])
      expect((await postTo(failing, MCP_RESULT_PATH, result, failing.token)).status).toBe(500)
      expect((await postTo(absent, MCP_RESULT_PATH, result, absent.token)).status).toBe(404)
      expect((await postTo(server, MCP_RESULT_PATH, { operationId: 'op-1' }, token)).status).toBe(400)
    } finally {
      await Promise.all([server.stop(), failing.stop(), absent.stop()])
    }
  })
})

describe('HookBridgeServer: lens regressions', () => {
  const call = { server: 'github', tool: 'create_comment', args: { body: 'hi' } }

  async function started(options: ConstructorParameters<typeof HookBridgeServer>[0]): Promise<HookBridgeServer> {
    const server = new HookBridgeServer(options)
    await server.start()
    activeServer = server
    return server
  }

  async function mcpCall(server: HookBridgeServer): Promise<unknown> {
    const response = await fetch(new URL(MCP_CALL_PATH, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify(call),
    })
    return response.json()
  }

  it('denies an MCP decision that is not a valid McpCallDecision', async () => {
    for (const bad of [
      { decision: 'maybe' },
      { decision: 'execute', args: {} },
      { decision: 'execute', operationId: 'op', args: 'not an object' },
      { decision: 'pending', operationId: 'op' },
      { decision: 'allow', extra: true },
    ]) {
      const server = await started({ policy: buildPolicy(), decideMcpCall: async () => bad as never })
      expect(await mcpCall(server), JSON.stringify(bad)).toMatchObject({ decision: 'deny' })
      await server.stop()
      activeServer = undefined
    }
    const ok = await started({ policy: buildPolicy(), decideMcpCall: async () => ({ decision: 'execute', operationId: 'op', args: { a: 1 } }) })
    expect(await mcpCall(ok)).toEqual({ decision: 'execute', operationId: 'op', args: { a: 1 } })
  })

  it('aborts the signal it gave decideMcpCall when the deadline answers', async () => {
    let signal: AbortSignal | undefined
    const server = await started({
      policy: buildPolicy(),
      deadlineMs: 50,
      decideMcpCall: (_call, _context, given) => {
        signal = given
        return new Promise((resolve) => setTimeout(() => resolve({ decision: 'allow' }), 300))
      },
    })
    expect(await mcpCall(server)).toMatchObject({ decision: 'deny' })
    expect(signal?.aborted).toBe(true)
  })

  it('answers 500 and logs when the answer cannot be serialized', async () => {
    const errors: unknown[] = []
    const circular: Record<string, unknown> = { decision: 'allow', reason: 'ok' }
    circular.self = circular
    const server = await started({
      decide: async () => circular as never,
      logger: { error: (...args: unknown[]) => errors.push(args) } as never,
    })
    const { status, body } = await post(server, buildRequest())
    expect(status).toBe(500)
    expect(body).toMatchObject({ decision: 'deny' })
    expect(errors).toHaveLength(1)
  })

  it('refuses an oversized body with 413 and closes the connection', async () => {
    const server = await startServer()
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: 'x'.repeat(5 * 1024 * 1024),
    }).catch((error: unknown) => error)
    // The server may close before the client finishes sending; either way nothing past the limit is read.
    if (response instanceof Response) {
      expect(response.status).toBe(413)
      expect(response.headers.get('connection')).toBe('close')
    } else {
      expect(response).toBeInstanceOf(Error)
    }
  })
})
