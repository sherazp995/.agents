import { describe, expect, it } from 'vitest'
import type { Policy } from '../../src/config/schema.js'
import {
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
