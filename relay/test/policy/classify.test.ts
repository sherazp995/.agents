import { describe, expect, it } from 'vitest'
import type { Policy } from '../../src/config/schema.js'
import { classify } from '../../src/policy/classify.js'
import type { ClassificationContext, ProposedCall } from '../../src/policy/schema.js'

/**
 * Mirrors the requirements doc's own §18.4 policy example verbatim
 * (amount_gt: 50, affected_count_gt: 10, origin_unknown + tier: write,
 * credential_in_args), plus recipient_count_gt and irreversible for
 * FR-POL-8's other two blast-radius dimensions, which the example doesn't
 * show but FR-POL-8's own requirement text names. version/defaults/
 * hard_blocked_origins are the minimum policySchema requires; they play no
 * part in classify itself.
 */
function buildPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    defaults: { unmatched: 'ask' },
    hard_blocked_origins: ['*.chase.com'],
    escalation_rules: [
      { when: { amount_gt: 50 }, then: 'irreversible' },
      { when: { affected_count_gt: 10 }, then: 'irreversible' },
      { when: { recipient_count_gt: 5 }, then: 'irreversible' },
      { when: { irreversible: true }, then: 'irreversible' },
      { when: { origin_unknown: true, tier: 'write' }, then: 'sensitive' },
      { when: { credential_in_args: true }, then: 'sensitive' },
    ],
    ...overrides,
  }
}

function buildCall(overrides: Partial<ProposedCall> = {}): ProposedCall {
  return { capability: 'test.capability', declaredTier: 'read', ...overrides }
}

function buildContext(overrides: Partial<ClassificationContext> = {}): ClassificationContext {
  return { policy: buildPolicy(), knownOrigins: [], ...overrides }
}

describe('classify: table-driven over every tier, with no escalation rule firing', () => {
  it.each([
    ['read', 'read'],
    ['write', 'write'],
    ['sensitive', 'sensitive'],
    ['irreversible', 'irreversible'],
  ] as const)('a %s-tier call with no escalating fact classifies as %s', (declaredTier, expectedTier) => {
    const result = classify(buildCall({ declaredTier }), buildContext())
    expect(result.tier).toBe(expectedTier)
    expect(result.escalatedBy).toEqual([])
  })
})

describe('classify: FR-POL-8 blast radius: monetary amount (boundary: one below, at, one above the amount_gt: 50 threshold)', () => {
  it('does not escalate one below the threshold (49.99)', () => {
    const result = classify(buildCall({ declaredTier: 'write', amountUsd: 49.99 }), buildContext())
    expect(result.tier).toBe('write')
  })

  it('does not escalate at exactly the threshold (50, strict greater-than)', () => {
    const result = classify(buildCall({ declaredTier: 'write', amountUsd: 50 }), buildContext())
    expect(result.tier).toBe('write')
  })

  it('escalates one above the threshold (50.01)', () => {
    const result = classify(buildCall({ declaredTier: 'write', amountUsd: 50.01 }), buildContext())
    expect(result.tier).toBe('irreversible')
    expect(result.escalatedBy).toHaveLength(1)
  })

  it('escalates well above the threshold ("delete these 400 files"-scale amount)', () => {
    const result = classify(buildCall({ declaredTier: 'write', amountUsd: 400 }), buildContext())
    expect(result.tier).toBe('irreversible')
  })

  it('does not escalate when no amount is present on the call at all', () => {
    const result = classify(buildCall({ declaredTier: 'write' }), buildContext())
    expect(result.tier).toBe('write')
  })
})

describe('classify: FR-POL-8 blast radius: affected item count (boundary: one below, at, one above the affected_count_gt: 10 threshold)', () => {
  it('does not escalate one below the threshold (9)', () => {
    const result = classify(buildCall({ declaredTier: 'write', affectedCount: 9 }), buildContext())
    expect(result.tier).toBe('write')
  })

  it('does not escalate at exactly the threshold (10)', () => {
    const result = classify(buildCall({ declaredTier: 'write', affectedCount: 10 }), buildContext())
    expect(result.tier).toBe('write')
  })

  it('escalates one above the threshold (11)', () => {
    const result = classify(buildCall({ declaredTier: 'write', affectedCount: 11 }), buildContext())
    expect(result.tier).toBe('irreversible')
  })

  it('escalates well above the threshold ("delete these 400 files" scenario)', () => {
    const result = classify(buildCall({ declaredTier: 'write', affectedCount: 400 }), buildContext())
    expect(result.tier).toBe('irreversible')
  })
})

describe('classify: FR-POL-8 blast radius: recipient breadth (boundary: one below, at, one above the recipient_count_gt: 5 threshold)', () => {
  it('does not escalate one below the threshold (4)', () => {
    const result = classify(buildCall({ declaredTier: 'write', recipientCount: 4 }), buildContext())
    expect(result.tier).toBe('write')
  })

  it('does not escalate at exactly the threshold (5)', () => {
    const result = classify(buildCall({ declaredTier: 'write', recipientCount: 5 }), buildContext())
    expect(result.tier).toBe('write')
  })

  it('escalates one above the threshold (6)', () => {
    const result = classify(buildCall({ declaredTier: 'write', recipientCount: 6 }), buildContext())
    expect(result.tier).toBe('irreversible')
  })

  it('escalates well above the threshold (a broadcast vs. a single recipient)', () => {
    const result = classify(buildCall({ declaredTier: 'write', recipientCount: 50 }), buildContext())
    expect(result.tier).toBe('irreversible')
  })
})

describe('classify: FR-POL-8 blast radius: reversibility', () => {
  it('escalates a call the caller marked irreversible', () => {
    const result = classify(buildCall({ declaredTier: 'write', irreversible: true }), buildContext())
    expect(result.tier).toBe('irreversible')
  })

  it('does not escalate a call explicitly marked reversible', () => {
    const result = classify(buildCall({ declaredTier: 'write', irreversible: false }), buildContext())
    expect(result.tier).toBe('write')
  })
})

describe('classify: FR-POL-1: credential in arguments', () => {
  it('escalates when the caller reports a credential in the arguments', () => {
    const result = classify(buildCall({ declaredTier: 'write', containsCredential: true }), buildContext())
    expect(result.tier).toBe('sensitive')
  })

  it('does not escalate when the caller reports no credential present', () => {
    const result = classify(buildCall({ declaredTier: 'write', containsCredential: false }), buildContext())
    expect(result.tier).toBe('write')
  })
})

describe('classify: FR-POL-1: first time on this origin, required proof: a write on an unknown origin escalates to sensitive', () => {
  it('escalates a write-tier call to an origin never contacted before', () => {
    const result = classify(
      buildCall({ declaredTier: 'write', destination: 'new-vendor.example' }),
      buildContext({ knownOrigins: ['github.com'] }),
    )
    expect(result.tier).toBe('sensitive')
    expect(result.escalatedBy).toHaveLength(1)
  })

  it('does not escalate a write-tier call to an origin already in knownOrigins', () => {
    const result = classify(
      buildCall({ declaredTier: 'write', destination: 'github.com' }),
      buildContext({ knownOrigins: ['github.com'] }),
    )
    expect(result.tier).toBe('write')
  })

  it('does not fire the origin_unknown rule for a read-tier call, since the fixture rule is tier-scoped to write', () => {
    const result = classify(
      buildCall({ declaredTier: 'read', destination: 'new-vendor.example' }),
      buildContext({ knownOrigins: [] }),
    )
    expect(result.tier).toBe('read')
  })

  it('treats a call with no destination as never unknown, since there is no origin to have first-contacted', () => {
    const result = classify(buildCall({ declaredTier: 'write' }), buildContext({ knownOrigins: [] }))
    expect(result.tier).toBe('write')
  })
})

describe('classify: multiple rules and monotonic escalation', () => {
  it('takes the highest tier across every matching rule, not just the first or last', () => {
    const result = classify(
      buildCall({ declaredTier: 'write', amountUsd: 100, containsCredential: true }),
      buildContext(),
    )
    // amount_gt fires -> irreversible; credential_in_args fires -> sensitive.
    // irreversible outranks sensitive, so the call ends at irreversible
    // regardless of which rule is listed first in the policy.
    expect(result.tier).toBe('irreversible')
    expect(result.escalatedBy.length).toBeGreaterThanOrEqual(1)
  })

  it('is order-independent: reversing the escalation_rules array yields the same final tier', () => {
    const policy = buildPolicy()
    const reversed = { ...policy, escalation_rules: [...(policy.escalation_rules ?? [])].reverse() }
    const call = buildCall({ declaredTier: 'write', amountUsd: 100, containsCredential: true })
    const forward = classify(call, buildContext({ policy }))
    const backward = classify(call, buildContext({ policy: reversed }))
    expect(forward.tier).toBe(backward.tier)
  })

  it('never lowers a tier: an irreversible-declared capability stays irreversible even with no escalating facts', () => {
    const result = classify(buildCall({ declaredTier: 'irreversible' }), buildContext())
    expect(result.tier).toBe('irreversible')
  })

  it('does nothing when escalation_rules is absent from the policy entirely', () => {
    const policy = buildPolicy()
    const { escalation_rules: _unused, ...withoutRules } = policy
    const result = classify(
      buildCall({ declaredTier: 'write', amountUsd: 10_000 }),
      buildContext({ policy: withoutRules as Policy }),
    )
    expect(result.tier).toBe('write')
  })
})

describe('classify: SELF-ATTACK: unmatched default must be ask at the decide layer, not silently allow here', () => {
  it('classify itself never produces anything outside RISK_TIERS; an out-of-range declared tier is rejected at the policy/registry boundary, not smoothed over here', () => {
    // classify has no "unmatched" branch of its own: every call carries a
    // declaredTier from the registry, which is always one of the four real
    // tiers (enforced by CapabilityDefinitionSchema in Task 1). The
    // "unmatched -> ask, never allow" guard genuinely lives in decide, not
    // classify; see test/policy/decide.test.ts's own SELF-ATTACK section.
    const result = classify(buildCall({ declaredTier: 'read' }), buildContext())
    expect(['read', 'write', 'sensitive', 'irreversible']).toContain(result.tier)
  })
})
