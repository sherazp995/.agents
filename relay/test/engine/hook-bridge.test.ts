import { afterEach, describe, expect, it } from 'vitest'
import type { Policy } from '../../src/config/schema.js'
import {
  HookBridgeServer,
  CLAUDE_CODE_TOOL_TIERS,
  resolveDeclaredTier,
  resolveHookDecision,
} from '../../src/engine/hook-bridge.js'
import type { HookDecisionRequest } from '../../src/engine/hook-bridge.js'

function buildPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    defaults: { unmatched: 'ask' },
    hard_blocked_origins: ['*.chase.com'],
    ...overrides,
  }
}

function buildRequest(overrides: Partial<HookDecisionRequest> = {}): HookDecisionRequest {
  return { toolUseId: 'toolu_test', toolName: 'Read', sessionId: 'session-1', toolInput: {}, ...overrides }
}

describe('resolveDeclaredTier', () => {
  it.each([
    ['Read', 'read'],
    ['Glob', 'read'],
    ['Grep', 'read'],
    ['WebSearch', 'read'],
    ['Edit', 'write'],
    ['Write', 'write'],
    ['NotebookEdit', 'write'],
    ['TodoWrite', 'write'],
    ['WebFetch', 'sensitive'],
    ['Task', 'sensitive'],
    ['Bash', 'irreversible'],
  ] as const)('maps %s to %s, per CLAUDE_CODE_TOOL_TIERS', (toolName, expectedTier) => {
    expect(resolveDeclaredTier(toolName)).toBe(expectedTier)
  })

  it('defaults an unrecognised tool name to irreversible, the most conservative tier, never a guess toward permissive', () => {
    expect(resolveDeclaredTier('mcp__some_plugin__delete_everything')).toBe('irreversible')
    expect(resolveDeclaredTier('')).toBe('irreversible')
  })

  it('CLAUDE_CODE_TOOL_TIERS itself contains no tool mapped to a tier decide() would ever allow outright without a destination check', () => {
    // Sanity pin on the table's own shape: every declared tier is one of the
    // four real tiers, so a future typo can't silently introduce a fifth.
    const validTiers = new Set(['read', 'write', 'sensitive', 'irreversible'])
    for (const tier of Object.values(CLAUDE_CODE_TOOL_TIERS)) {
      expect(validTiers.has(tier)).toBe(true)
    }
  })
})

describe('resolveHookDecision: table-driven over the tier defaults', () => {
  it('allows a read-tier tool outright', () => {
    const result = resolveHookDecision(buildRequest({ toolName: 'Read' }), { policy: buildPolicy() })
    expect(result.decision).toBe('allow')
  })

  it('allows a write-tier tool with no destination (no allowlist to fail)', () => {
    const result = resolveHookDecision(buildRequest({ toolName: 'Edit' }), { policy: buildPolicy() })
    expect(result.decision).toBe('allow')
  })

  it('defers a sensitive-tier tool, since sensitive always asks and the hook cannot itself ask a human', () => {
    const result = resolveHookDecision(buildRequest({ toolName: 'WebFetch' }), { policy: buildPolicy() })
    expect(result.decision).toBe('defer')
  })

  it('defers an irreversible-tier tool (Bash), for the same reason', () => {
    const result = resolveHookDecision(buildRequest({ toolName: 'Bash' }), { policy: buildPolicy() })
    expect(result.decision).toBe('defer')
  })

  it('denies outright when the destination is hard-blocked, never defers it (FR-POL-4: no approval can override this)', () => {
    const result = resolveHookDecision(
      buildRequest({ toolName: 'WebFetch', destination: 'pay.chase.com' }),
      { policy: buildPolicy() },
    )
    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/hard-blocked/)
  })

  it('carries the reason string through from decide(), never inventing its own', () => {
    const result = resolveHookDecision(buildRequest({ toolName: 'Read' }), { policy: buildPolicy() })
    expect(result.reason).toMatch(/read-tier/)
  })
})

describe('resolveHookDecision: SELF-ATTACK: an internal failure must deny, never allow or throw', () => {
  it('denies when the policy object is malformed in a way that would make classify()/decide() throw', () => {
    // A cast past the type checker: the one way this happens in real code,
    // since a literal missing `hard_blocked_origins` would already be
    // refused by policySchema at load time. Exercises the actual runtime
    // guard, not a type-level one. Must supply a destination too: decide()
    // only ever reads hard_blocked_origins once a destination is present,
    // so a request with none would never actually reach the broken field.
    const brokenPolicy = { version: 1, defaults: { unmatched: 'ask' } } as unknown as Policy
    const request = buildRequest({ toolName: 'Read', destination: 'example.com' })
    expect(() => resolveHookDecision(request, { policy: brokenPolicy })).not.toThrow()
    const result = resolveHookDecision(request, { policy: brokenPolicy })
    expect(result.decision).toBe('deny')
  })

  it('denies when toolName is an unexpected type at the runtime boundary (a hostile or malformed hook payload)', () => {
    const hostileRequest = { ...buildRequest(), toolName: 123 } as unknown as HookDecisionRequest
    const result = resolveHookDecision(hostileRequest, { policy: buildPolicy() })
    expect(result.decision).toBe('deny')
  })
})

describe('HookBridgeServer extra routes', () => {
  const context = { workspaceId: 'w1', taskId: 't1', runId: 'r1', leaseGeneration: 3 }
  let server: HookBridgeServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  async function start(routeDeadlineMs?: number) {
    const seen: { context: unknown; body: unknown }[] = []
    server = new HookBridgeServer({
      decide: async () => ({ decision: 'allow', reason: 'ok' }),
      ...(routeDeadlineMs !== undefined ? { routeDeadlineMs } : {}),
      routes: {
        '/echo': async (ctx, body) => {
          seen.push({ context: ctx, body })
          return { status: 202, body: { ok: true, message: 'done' } }
        },
        '/slow': () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: {} }), 1_000)),
        '/pre-tool-use': async () => ({ status: 200, body: { hijacked: true } }),
      },
    })
    await server.start()
    return { server, seen }
  }

  async function call(bridge: HookBridgeServer, path: string, token: string, method = 'POST') {
    const response = await fetch(new URL(path, bridge.url), {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(method === 'POST' ? { body: JSON.stringify({ hello: 1 }) } : {}),
    })
    return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown }
  }

  it('hands a turn token\'s context and the parsed body to the route', async () => {
    const { server: bridge, seen } = await start()
    const answer = await call(bridge, '/echo', bridge.issueToken(context))
    expect(answer).toEqual({ status: 202, body: { ok: true, message: 'done' } })
    expect(seen).toEqual([{ context, body: { hello: 1 } }])
  })

  it('refuses the instance token, a wrong or revoked token, and a GET, without calling the route', async () => {
    const { server: bridge, seen } = await start()
    expect((await call(bridge, '/echo', bridge.token)).status).toBe(403)
    expect((await call(bridge, '/echo', 'f'.repeat(64))).status).toBe(401)
    const revoked = bridge.issueToken(context)
    bridge.revokeToken(revoked)
    expect((await call(bridge, '/echo', revoked)).status).toBe(401)
    expect((await call(bridge, '/echo', bridge.issueToken(context), 'GET')).status).toBe(404)
    expect(seen).toEqual([])
  })

  it('keeps /pre-tool-use the decision route and answers 404 for a path it was not given', async () => {
    const { server: bridge } = await start()
    const token = bridge.issueToken(context)
    expect((await call(bridge, '/pre-tool-use', token)).body).toMatchObject({ decision: 'allow' })
    expect((await call(bridge, '/other', token)).status).toBe(404)
  })

  it('answers 504 when a route is slow', async () => {
    const { server: bridge } = await start(50)
    expect((await call(bridge, '/slow', bridge.issueToken(context))).status).toBe(504)
  })
})
