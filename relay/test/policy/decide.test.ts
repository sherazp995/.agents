import { describe, expect, it } from 'vitest'
import type { Policy } from '../../src/config/schema.js'
import { decide } from '../../src/policy/decide.js'
import type { Classification, DecisionContext } from '../../src/policy/schema.js'

function buildPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    defaults: { unmatched: 'ask' },
    hard_blocked_origins: ['*.chase.com', '*.coinbase.com'],
    origins: { allow: ['*.mycompany.com', 'github.com'], deny: ['*.ads.example'] },
    ...overrides,
  }
}

function buildClassification(overrides: Partial<Classification> = {}): Classification {
  return { tier: 'read', escalatedBy: [], ...overrides }
}

function buildContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return { policy: buildPolicy(), capability: 'test.capability', ...overrides }
}

describe('decide: table-driven §10.1 default handling per tier', () => {
  it('allows a read-tier action unconditionally', () => {
    const result = decide(buildClassification({ tier: 'read' }), buildContext({ destination: 'anything.example' }))
    expect(result.decision).toBe('allow')
  })

  it('allows a write-tier action whose destination is on the origin allowlist', () => {
    const result = decide(buildClassification({ tier: 'write' }), buildContext({ destination: 'github.com' }))
    expect(result.decision).toBe('allow')
  })

  it('allows a write-tier action with no destination at all (a local write, e.g. a scratch file)', () => {
    const result = decide(buildClassification({ tier: 'write' }), buildContext())
    expect(result.decision).toBe('allow')
  })

  it('asks for a write-tier action whose destination is not on the origin allowlist', () => {
    const result = decide(buildClassification({ tier: 'write' }), buildContext({ destination: 'unknown-vendor.example' }))
    expect(result.decision).toBe('ask')
  })

  it('always asks for a sensitive-tier action, regardless of destination', () => {
    const result = decide(buildClassification({ tier: 'sensitive' }), buildContext({ destination: 'github.com' }))
    expect(result.decision).toBe('ask')
  })

  it('always asks for an irreversible-tier action, regardless of destination', () => {
    const result = decide(buildClassification({ tier: 'irreversible' }), buildContext({ destination: 'github.com' }))
    expect(result.decision).toBe('ask')
  })
})

describe('decide: FR-POL-4: hard-blocked destinations, required proof: no policy setting or approval can turn it into allow', () => {
  it('denies a read-tier call to a hard-blocked destination, even though read is normally always allowed', () => {
    const result = decide(buildClassification({ tier: 'read' }), buildContext({ destination: 'pay.chase.com' }))
    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/hard-blocked/)
  })

  it('denies even when the same destination is also on the origin allowlist, since hard-block outranks every other setting', () => {
    const policy = buildPolicy({
      hard_blocked_origins: ['vault.example'],
      origins: { allow: ['vault.example'], deny: [] },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, destination: 'vault.example' }),
    )
    expect(result.decision).toBe('deny')
  })

  it('denies even when the capability is explicitly enabled at every FR-CAP-2 scope', () => {
    const policy = buildPolicy({
      capabilities: { 'test.capability': { global: 'enabled', principals: { alice: 'enabled' } } },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, destination: 'pay.chase.com', principalId: 'alice' }),
    )
    expect(result.decision).toBe('deny')
  })

  it('matches a bare hard-blocked domain against a subdomain via the wildcard pattern', () => {
    const result = decide(buildClassification({ tier: 'read' }), buildContext({ destination: 'login.pay.chase.com' }))
    expect(result.decision).toBe('deny')
  })
})

describe('decide: FR-POL-4: destination denylist (ordinary, policy-editable, distinct from hard-block)', () => {
  it('denies a destination on origins.deny', () => {
    const result = decide(buildClassification({ tier: 'read' }), buildContext({ destination: 'x.ads.example' }))
    expect(result.decision).toBe('deny')
    expect(result.reason).not.toMatch(/hard-blocked/)
  })
})

describe('decide: FR-CAP-2: capability enable/disable/approval-gate at all four scopes', () => {
  it('denies when the capability is disabled globally, per the FR-CAP-2 acceptance example (shell.exec)', () => {
    const policy = buildPolicy({ capabilities: { 'shell.exec': { global: 'disabled' } } })
    const result = decide(
      buildClassification({ tier: 'irreversible' }),
      buildContext({ policy, capability: 'shell.exec' }),
    )
    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/disabled/)
  })

  it('allows when the capability has no entry in policy.capabilities at all (default enabled)', () => {
    const result = decide(buildClassification({ tier: 'read' }), buildContext({ capability: 'never.mentioned' }))
    expect(result.decision).toBe('allow')
  })

  it('asks when the capability is approval-gated globally, even at read tier', () => {
    const policy = buildPolicy({ capabilities: { 'os.click': { global: 'approval_gated' } } })
    const result = decide(buildClassification({ tier: 'read' }), buildContext({ policy, capability: 'os.click' }))
    expect(result.decision).toBe('ask')
  })

  // The three tests below prove specificity ordering (recipe > session >
  // principal > global) using only enabled/approval_gated pairs, never
  // disabled. Fix round 3 (I-4) made 'disabled' fail-safe absolute (see the
  // conflict block further down): once any applicable scope says
  // 'disabled', no ordering runs at all, so a disabled/enabled pair no
  // longer demonstrates specificity, only the fail-safe floor. These were
  // rewritten from a prior version that used global: 'disabled' + a more
  // specific 'enabled' and asserted 'allow'; that assertion is exactly what
  // I-4 correctly makes false now.
  it('resolves per-principal over global for the enabled/approval_gated tie-break: global approval-gated, this principal enabled', () => {
    const policy = buildPolicy({
      capabilities: { 'shell.exec': { global: 'approval_gated', principals: { alice: 'enabled' } } },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, capability: 'shell.exec', principalId: 'alice' }),
    )
    expect(result.decision).toBe('allow')
  })

  it('resolves per-session over per-principal for the enabled/approval_gated tie-break', () => {
    const policy = buildPolicy({
      capabilities: {
        'shell.exec': { principals: { alice: 'approval_gated' }, sessions: { 's-1': 'enabled' } },
      },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, capability: 'shell.exec', principalId: 'alice', sessionId: 's-1' }),
    )
    expect(result.decision).toBe('allow')
  })

  it('resolves per-recipe over everything else for the enabled/approval_gated tie-break', () => {
    const policy = buildPolicy({
      capabilities: {
        'shell.exec': {
          global: 'approval_gated',
          principals: { alice: 'approval_gated' },
          sessions: { 's-1': 'approval_gated' },
          recipes: { 'nightly-cleanup': 'enabled' },
        },
      },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({
        policy,
        capability: 'shell.exec',
        principalId: 'alice',
        sessionId: 's-1',
        recipeId: 'nightly-cleanup',
      }),
    )
    expect(result.decision).toBe('allow')
  })

  it('falls back to global when the more specific scope has no entry for this id', () => {
    const policy = buildPolicy({ capabilities: { 'shell.exec': { global: 'disabled' } } })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, capability: 'shell.exec', principalId: 'someone-not-listed' }),
    )
    expect(result.decision).toBe('deny')
  })
})

describe('decide: I-4 fix round 3: disabled is fail-safe absolute, so no more-specific scope can ever override it with enabled', () => {
  it('required minimum: denies when the principal is disabled but the recipe is enabled', () => {
    const policy = buildPolicy({
      capabilities: { 'shell.exec': { principals: { alice: 'disabled' }, recipes: { 'nightly-cleanup': 'enabled' } } },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, capability: 'shell.exec', principalId: 'alice', recipeId: 'nightly-cleanup' }),
    )
    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/disabled/)
  })

  it('adjacent pair, recipe/session: denies when the session is disabled but the recipe is enabled', () => {
    const policy = buildPolicy({
      capabilities: { 'shell.exec': { sessions: { 's-1': 'disabled' }, recipes: { 'nightly-cleanup': 'enabled' } } },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, capability: 'shell.exec', sessionId: 's-1', recipeId: 'nightly-cleanup' }),
    )
    expect(result.decision).toBe('deny')
  })

  it('adjacent pair, session/principal: denies when the principal is disabled but the session is enabled', () => {
    const policy = buildPolicy({
      capabilities: { 'shell.exec': { principals: { alice: 'disabled' }, sessions: { 's-1': 'enabled' } } },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, capability: 'shell.exec', principalId: 'alice', sessionId: 's-1' }),
    )
    expect(result.decision).toBe('deny')
  })

  it('adjacent pair, principal/global: denies when global is disabled but the principal is enabled (the exact case the prior, wrong version of this suite asserted should allow)', () => {
    const policy = buildPolicy({
      capabilities: { 'shell.exec': { global: 'disabled', principals: { alice: 'enabled' } } },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({ policy, capability: 'shell.exec', principalId: 'alice' }),
    )
    expect(result.decision).toBe('deny')
  })
})

describe('decide: I-1 fix round 1: the denylist is checked ahead of any capability state', () => {
  // Collapsed from four tests (I-3, fix round 2): the prior version had one
  // test per FR-CAP-2 scope, labelled global/principal/session/recipe, but
  // decide() returns from the denylist check before resolveCapabilityState
  // is ever called, so none of them exercised scope resolution at all; a
  // stub resolveCapabilityState that always returns 'enabled', ignoring
  // every scope, still passed all four. This single test states the one
  // property they actually establish: capability state, at any scope, is
  // never consulted once the destination is denylisted. Setting
  // 'approval_gated' at all four scopes at once, plus context ids for all
  // four, makes that true regardless of which scope FR-CAP-2 precedence
  // would otherwise have picked.
  it('denies a denylisted destination even when the capability is approval-gated at every FR-CAP-2 scope', () => {
    const policy = buildPolicy({
      capabilities: {
        'shell.exec': {
          global: 'approval_gated',
          principals: { alice: 'approval_gated' },
          sessions: { 's-1': 'approval_gated' },
          recipes: { 'nightly-cleanup': 'approval_gated' },
        },
      },
    })
    const result = decide(
      buildClassification({ tier: 'read' }),
      buildContext({
        policy,
        capability: 'shell.exec',
        destination: 'x.ads.example',
        principalId: 'alice',
        sessionId: 's-1',
        recipeId: 'nightly-cleanup',
      }),
    )
    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/denylist/)
  })
})

describe('decide: FR-POL-3: unmatched defaults to ask, never allow, required proof', () => {
  it('SELF-ATTACK-target: a tier value outside the four known risk tiers falls back to ask, never allow', () => {
    // A classification carrying a tier no RiskTier branch recognises. This
    // can only happen if a future tier is added to RISK_TIERS without
    // updating decide, or via a cast that defeats the type system, exactly
    // like Task 1's own missing-field self-attack; it is not reachable
    // through normal typed use of classify today.
    const bogus = { tier: 'catastrophic', escalatedBy: [] } as unknown as Classification
    const result = decide(bogus, buildContext())
    expect(result.decision).toBe('ask')
  })
})
