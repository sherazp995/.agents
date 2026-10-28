/**
 * Tests for src/policy/engine.ts: the pure mediate() and the async
 * mediateCapabilityCall() that wraps it with an injected approval seam.
 *
 * These tests exercise engine.ts DIRECTLY, which is legitimate here (unlike
 * a test that calls decide() directly and claims it proves AP-1): this file
 * proves engine.ts's own two structural guarantees in isolation (refuse
 * before decide, never invoke requestApproval on allow/deny), which are
 * this module's actual unit of behaviour. AP-1 itself, "the loop cannot
 * invoke a capability without going through this", is proved separately in
 * test/agent/loop.test.ts by driving runAgentLoop end to end and observing
 * the capability function itself, per the brief's explicit instruction.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Policy } from '../../src/config/schema.js'
import { CapabilityRegistry } from '../../src/capabilities/registry.js'
import type { CapabilityDefinition } from '../../src/capabilities/registry.js'
import { mediate, mediateCapabilityCall, normalizeDestination } from '../../src/policy/engine.js'
import type { ApprovalDecision, ApprovalRequest } from '../../src/policy/engine.js'

function buildPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    defaults: { unmatched: 'ask' },
    hard_blocked_origins: ['*.chase.com'],
    origins: { allow: ['*.mycompany.com', 'github.com'], deny: [] },
    ...overrides,
  }
}

function buildDefinition(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    name: 'test.capability',
    description: 'a capability for a test',
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    riskTier: 'read',
    idempotencyClass: 'safe',
    requiredRunnerFeatures: [],
    costHint: 'free',
    requiresMachineLock: false,
    run: async (input: unknown) => input,
    ...overrides,
  }
}

/** An isolated registry per test, per CapabilityRegistry's own doc comment, so nothing here touches the process-wide registry other test files share. */
function buildLookup(...definitions: CapabilityDefinition[]): (name: string) => CapabilityDefinition | undefined {
  const registry = new CapabilityRegistry()
  for (const definition of definitions) registry.register(definition)
  return (name: string) => registry.get(name)
}

describe('mediate: refuses a capability absent from the registry, before decide is ever consulted', () => {
  it('denies an unregistered capability', () => {
    const lookup = buildLookup()
    const result = mediate({ capability: 'ghost.capability', policy: buildPolicy() }, lookup)
    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/not registered/)
  })

  it('STRUCTURAL PROOF: decide is never reached for an unregistered capability, not merely coincidentally denied. A policy value that would throw the instant classify/decide touched it still produces a clean deny.', () => {
    const lookup = buildLookup()
    // If mediate() ever called classify()/decide() before checking the
    // registry, accessing `policy.hard_blocked_origins` (or anything else on
    // this object) would throw a TypeError, since `policy` is not an object
    // at all. A clean deny result, with no throw, is only possible if the
    // registry check ran and returned before either function was reached.
    const poisonedPolicy = null as unknown as Policy
    const result = mediate({ capability: 'ghost.capability', policy: poisonedPolicy }, lookup)
    expect(result.decision).toBe('deny')
  })
})

describe('mediate: registered capability, declared tier comes only from the registry', () => {
  it('allows a read-tier capability under a plain policy', () => {
    const lookup = buildLookup(buildDefinition({ name: 'echo', riskTier: 'read' }))
    const result = mediate({ capability: 'echo', policy: buildPolicy() }, lookup)
    expect(result.decision).toBe('allow')
  })

  it('the caller cannot claim a tier: MediateParams carries no declaredTier field a caller could set to bypass the registry', () => {
    const lookup = buildLookup(buildDefinition({ name: 'risky', riskTier: 'write' }))
    // A write-tier capability whose destination is not on the allowlist asks,
    // per decide()'s §10.1 default. If a caller could smuggle in
    // `declaredTier: 'read'` this would allow instead.
    const result = mediate(
      { capability: 'risky', policy: buildPolicy(), destination: 'unknown-vendor.example' },
      lookup,
    )
    expect(result.decision).toBe('ask')
  })

  it('denies when the capability is disabled by policy, regardless of its declared tier', () => {
    const lookup = buildLookup(buildDefinition({ name: 'echo', riskTier: 'read' }))
    const policy = buildPolicy({ capabilities: { echo: { global: 'disabled' } } })
    const result = mediate({ capability: 'echo', policy }, lookup)
    expect(result.decision).toBe('deny')
  })

  it('asks when the capability is approval-gated by policy, regardless of its declared tier', () => {
    const lookup = buildLookup(buildDefinition({ name: 'echo', riskTier: 'read' }))
    const policy = buildPolicy({ capabilities: { echo: { global: 'approval_gated' } } })
    const result = mediate({ capability: 'echo', policy }, lookup)
    expect(result.decision).toBe('ask')
    expect(result.tier).toBe('read')
  })

  it('escalates via a configured escalation rule before deciding, e.g. a large amount raises a read-tier call to sensitive', () => {
    const lookup = buildLookup(buildDefinition({ name: 'pay', riskTier: 'read' }))
    const policy = buildPolicy({
      escalation_rules: [{ when: { amount_gt: 50 }, then: 'sensitive' }],
    })
    const result = mediate({ capability: 'pay', policy, amountUsd: 100 }, lookup)
    expect(result.decision).toBe('ask')
    expect(result.tier).toBe('sensitive')
  })
})

describe('mediateCapabilityCall: the async seam, including the injected approval dependency', () => {
  function buildApprovalRequestCapture(): {
    requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>
    calls: ApprovalRequest[]
    resolveWith(decision: ApprovalDecision): void
  } {
    const calls: ApprovalRequest[] = []
    let resolve: ((decision: ApprovalDecision) => void) | undefined
    const requestApproval = vi.fn((request: ApprovalRequest) => {
      calls.push(request)
      return new Promise<ApprovalDecision>((res) => {
        resolve = res
      })
    })
    return {
      requestApproval,
      calls,
      resolveWith(decision: ApprovalDecision) {
        if (!resolve) throw new Error('requestApproval was never called; nothing to resolve')
        resolve(decision)
      },
    }
  }

  it('an allow decision never calls requestApproval', async () => {
    const lookup = buildLookup(buildDefinition({ name: 'echo', riskTier: 'read' }))
    const { requestApproval } = buildApprovalRequestCapture()
    const verdict = await mediateCapabilityCall(
      {
        capability: 'echo',
        policy: buildPolicy(),
        runId: 'run-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        principalId: 'alice',
        requestApproval,
      },
      lookup,
    )
    expect(verdict.outcome).toBe('proceed')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('a deny decision (including the registry refusal) never calls requestApproval', async () => {
    const lookup = buildLookup()
    const { requestApproval } = buildApprovalRequestCapture()
    const verdict = await mediateCapabilityCall(
      {
        capability: 'ghost',
        policy: buildPolicy(),
        runId: 'run-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        principalId: 'alice',
        requestApproval,
      },
      lookup,
    )
    expect(verdict.outcome).toBe('refuse')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('an ask decision calls requestApproval with the capability, tier, and reason, and proceeds once approved', async () => {
    const lookup = buildLookup(buildDefinition({ name: 'os.click', riskTier: 'read' }))
    const policy = buildPolicy({ capabilities: { 'os.click': { global: 'approval_gated' } } })
    const capture = buildApprovalRequestCapture()

    const pending = mediateCapabilityCall(
      {
        capability: 'os.click',
        policy,
        runId: 'run-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        principalId: 'alice',
        requestApproval: capture.requestApproval,
      },
      lookup,
    )

    // The promise must not settle before the approval resolves: this is the
    // "suspends rather than proceeds or fails" proof at the engine level.
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]).toMatchObject({ capability: 'os.click', runId: 'run-1', workspaceId: 'ws-1', sessionId: 'sess-1', principalId: 'alice' })
    expect(capture.calls[0]?.reason).toMatch(/approval-gated/)

    capture.resolveWith({ outcome: 'approved' })
    const verdict = await pending
    expect(verdict.outcome).toBe('proceed')
  })

  it('an ask decision that resolves denied refuses, with the approval\'s own reason', async () => {
    const lookup = buildLookup(buildDefinition({ name: 'os.click', riskTier: 'read' }))
    const policy = buildPolicy({ capabilities: { 'os.click': { global: 'approval_gated' } } })
    const capture = buildApprovalRequestCapture()

    const pending = mediateCapabilityCall(
      {
        capability: 'os.click',
        policy,
        runId: 'run-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        principalId: 'alice',
        requestApproval: capture.requestApproval,
      },
      lookup,
    )
    capture.resolveWith({ outcome: 'denied', reason: 'the operator said no' })
    const verdict = await pending
    expect(verdict.outcome).toBe('refuse')
    expect(verdict.reason).toMatch(/the operator said no/)
  })
})

describe('normalizeDestination: hostname canonicalization, per Task 2\'s review', () => {
  it('strips a trailing DNS root dot', () => {
    expect(normalizeDestination('chase.com.')).toBe('chase.com')
  })

  it('lowercases', () => {
    expect(normalizeDestination('Chase.COM')).toBe('chase.com')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeDestination('  chase.com  ')).toBe('chase.com')
  })

  it('strips a userinfo prefix, splitting on the LAST @', () => {
    expect(normalizeDestination('user:p@ss@chase.com')).toBe('chase.com')
  })

  it('strips an explicit port', () => {
    expect(normalizeDestination('chase.com:8443')).toBe('chase.com')
  })

  it('converts an IDN hostname to its punycode form', () => {
    expect(normalizeDestination('münchen.de')).toBe('xn--mnchen-3ya.de')
  })

  it('leaves an already-canonical hostname unchanged', () => {
    expect(normalizeDestination('chase.com')).toBe('chase.com')
  })

  it('combines every form at once', () => {
    expect(normalizeDestination('  User@Chase.COM.:443')).toBe('chase.com')
  })
})

describe('mediate: hostname normalization applied before classification and policy consultation (attack, not formatting)', () => {
  it('denies a call to "chase.com." when "chase.com" is on the denylist: the trailing-dot evasion Task 2\'s review named', () => {
    const lookup = buildLookup(buildDefinition({ name: 'read.thing', riskTier: 'read' }))
    const policy = buildPolicy({ origins: { allow: [], deny: ['chase.com'] } })
    const result = mediate({ capability: 'read.thing', policy, destination: 'chase.com.' }, lookup)
    expect(result.decision).toBe('deny')
    // The reason names the NORMALIZED form, not the raw one with its
    // trailing dot: classify, decide, and a human reading the reason all
    // see the one canonical string.
    expect(result.reason).toContain('chase.com')
    expect(result.reason).not.toContain('chase.com.')
  })

  it('denies a call to an uppercase, whitespace-padded, ported form of a denylisted destination', () => {
    const lookup = buildLookup(buildDefinition({ name: 'read.thing', riskTier: 'read' }))
    const policy = buildPolicy({ origins: { allow: [], deny: ['chase.com'] } })
    const result = mediate({ capability: 'read.thing', policy, destination: '  Chase.COM:443  ' }, lookup)
    expect(result.decision).toBe('deny')
  })
})

describe('mediateCapabilityCall: description and target on the approval request, per FR-APR-1', () => {
  // requestApproval is called SYNCHRONOUSLY within mediateCapabilityCall's
  // own synchronous prefix (mediate() itself has no await, and neither does
  // building the ApprovalRequest), so `calls` is already populated the
  // instant mediateCapabilityCall(...) returns its pending promise, before
  // any `await` in this test. Matches the existing "ask decision calls
  // requestApproval..." test above.
  function buildCapture(): { requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>; calls: ApprovalRequest[] } {
    const calls: ApprovalRequest[] = []
    const requestApproval = (request: ApprovalRequest): Promise<ApprovalDecision> => {
      calls.push(request)
      return Promise.resolve({ outcome: 'approved' })
    }
    return { requestApproval, calls }
  }

  it('defaults description to the capability\'s own registered description, and target to the destination', async () => {
    const lookup = buildLookup(
      buildDefinition({ name: 'os.click', riskTier: 'read', description: 'clicks a point on the operator\'s screen' }),
    )
    // A destination NOT on buildPolicy()'s own default hard-blocked list
    // (`*.chase.com`, which also matches the bare `chase.com`): this test
    // is about the ask path specifically, and a hard-blocked destination
    // would deny before ever reaching approval_gated.
    const policy = buildPolicy({ capabilities: { 'os.click': { global: 'approval_gated' } } })
    const capture = buildCapture()

    const pending = mediateCapabilityCall(
      {
        capability: 'os.click',
        policy,
        runId: 'run-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        principalId: 'alice',
        destination: 'example.com',
        requestApproval: capture.requestApproval,
      },
      lookup,
    )

    expect(capture.calls[0]?.description).toBe('clicks a point on the operator\'s screen')
    expect(capture.calls[0]?.target).toBe('example.com')
    expect(capture.calls[0]?.destination).toBe('example.com')
    await pending
  })

  it('defaults target to the capability name when there is no destination at all', async () => {
    const lookup = buildLookup(buildDefinition({ name: 'os.click', riskTier: 'read' }))
    const policy = buildPolicy({ capabilities: { 'os.click': { global: 'approval_gated' } } })
    const capture = buildCapture()

    const pending = mediateCapabilityCall(
      {
        capability: 'os.click',
        policy,
        runId: 'run-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        principalId: 'alice',
        requestApproval: capture.requestApproval,
      },
      lookup,
    )

    expect(capture.calls[0]?.target).toBe('os.click')
    expect(capture.calls[0]?.destination).toBeUndefined()
    await pending
  })

  it('a caller-supplied description and target override the defaults', async () => {
    const lookup = buildLookup(buildDefinition({ name: 'os.click', riskTier: 'read', description: 'generic capability description' }))
    const policy = buildPolicy({ capabilities: { 'os.click': { global: 'approval_gated' } } })
    const capture = buildCapture()

    const pending = mediateCapabilityCall(
      {
        capability: 'os.click',
        policy,
        runId: 'run-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
        principalId: 'alice',
        description: 'wire $500 to acme-corp',
        target: 'acme-corp account #4471',
        requestApproval: capture.requestApproval,
      },
      lookup,
    )

    expect(capture.calls[0]?.description).toBe('wire $500 to acme-corp')
    expect(capture.calls[0]?.target).toBe('acme-corp account #4471')
    await pending
  })
})

describe('mediateCapabilityCall: edit-and-approve carries the replacement input through, per FR-APR-1', () => {
  // The distinction that matters throughout this block: "the operator
  // supplied no edit" (the `input` key absent from the ApprovalDecision
  // entirely) versus "the operator supplied an edit whose value happens to
  // be falsy" (`input` present, value null/0/''/false). `'input' in
  // verdict` is what tells these apart; `verdict.input ?? candidate.input`
  // would not, and would silently convert a null edit into the original.
  async function runMediateWithApproval(
    approval: ApprovalDecision,
  ): Promise<ReturnType<typeof mediateCapabilityCall> extends Promise<infer T> ? T : never> {
    const lookup = buildLookup(buildDefinition({ name: 'os.click', riskTier: 'read' }))
    const policy = buildPolicy({ capabilities: { 'os.click': { global: 'approval_gated' } } })
    const requestApproval = async (): Promise<ApprovalDecision> => approval
    return mediateCapabilityCall(
      { capability: 'os.click', policy, runId: 'r', workspaceId: 'w', sessionId: 's', principalId: 'p', requestApproval },
      lookup,
    )
  }

  it('no edit: the verdict carries no `input` key at all, distinct from carrying one whose value is undefined', async () => {
    const verdict = await runMediateWithApproval({ outcome: 'approved' })
    expect(verdict.outcome).toBe('proceed')
    // The KEY, not the value: a verdict that spread `{ input: undefined }`
    // would also fail `.input !== undefined` checks downstream in the same
    // way, but `'input' in verdict` is what actually proves no key exists.
    expect('input' in verdict).toBe(false)
  })

  it('an edit to null: the verdict carries `input: null`, not the original', async () => {
    const verdict = await runMediateWithApproval({ outcome: 'approved', input: null })
    expect(verdict.outcome).toBe('proceed')
    expect('input' in verdict).toBe(true)
    expect((verdict as { input?: unknown }).input).toBeNull()
  })

  it('an edit to a non-null falsy value (0): the verdict carries 0, not the original', async () => {
    const verdict = await runMediateWithApproval({ outcome: 'approved', input: 0 })
    expect('input' in verdict).toBe(true)
    expect((verdict as { input?: unknown }).input).toBe(0)
  })

  it('an edit to a non-null falsy value (empty string): the verdict carries \'\', not the original', async () => {
    const verdict = await runMediateWithApproval({ outcome: 'approved', input: '' })
    expect('input' in verdict).toBe(true)
    expect((verdict as { input?: unknown }).input).toBe('')
  })

  it('an edit to a non-null falsy value (false): the verdict carries false, not the original', async () => {
    const verdict = await runMediateWithApproval({ outcome: 'approved', input: false })
    expect('input' in verdict).toBe(true)
    expect((verdict as { input?: unknown }).input).toBe(false)
  })

  it('an edit to a truthy object: the verdict carries it, per the original coverage', async () => {
    const verdict = await runMediateWithApproval({ outcome: 'approved', input: { edited: true } })
    expect('input' in verdict).toBe(true)
    expect((verdict as { input?: unknown }).input).toEqual({ edited: true })
  })
})
