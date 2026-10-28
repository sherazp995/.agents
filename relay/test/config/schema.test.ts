import { describe, expect, it } from 'vitest'
import { policySchema } from '../../src/config/schema.js'

/** The minimum a valid policy needs, per test/policy/classify.test.ts's own identical fixture. */
function basePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    defaults: { unmatched: 'ask' },
    hard_blocked_origins: ['*.chase.com'],
    ...overrides,
  }
}

describe('policySchema: approvals section (FR-APR-4, FR-APR-5)', () => {
  it('accepts a policy with no approvals section at all', () => {
    const result = policySchema.safeParse(basePolicy())
    expect(result.success).toBe(true)
    expect(result.success && result.data.approvals).toBeUndefined()
  })

  it('accepts a sparse approvals map naming only the tiers it configures', () => {
    const result = policySchema.safeParse(
      basePolicy({
        approvals: {
          irreversible: { required_roles: ['operator'], requires_typed_confirmation: true },
        },
      }),
    )
    expect(result.success).toBe(true)
    expect(result.success && result.data.approvals).toEqual({
      irreversible: { required_roles: ['operator'], requires_typed_confirmation: true },
    })
    // A tier this policy never mentions ('sensitive', here) is genuinely
    // absent from the parsed result, not defaulted to an empty entry:
    // "unconfigured" and "explicitly configured with no roles" must stay
    // distinguishable, since the schema refuses the second state outright
    // (see the next test) and a caller needs to be able to tell "nothing
    // was said about this tier" apart from a state that cannot exist.
    expect(result.success && result.data.approvals?.sensitive).toBeUndefined()
  })

  it('requires_typed_confirmation defaults to false when a tier configures only required_roles', () => {
    const result = policySchema.safeParse(basePolicy({ approvals: { write: { required_roles: ['operator'] } } }))
    expect(result.success).toBe(true)
    expect(result.success && result.data.approvals?.write).toEqual({
      required_roles: ['operator'],
      requires_typed_confirmation: false,
    })
  })

  it('refuses an empty required_roles list for a tier, rather than accepting the "anybody may approve" reading', () => {
    const result = policySchema.safeParse(basePolicy({ approvals: { irreversible: { required_roles: [] } } }))
    expect(result.success).toBe(false)
  })

  it('refuses a required_roles entry that is a blank or whitespace-only string', () => {
    const result = policySchema.safeParse(basePolicy({ approvals: { irreversible: { required_roles: ['   '] } } }))
    expect(result.success).toBe(false)
  })

  it('refuses a tier name outside RiskTier', () => {
    const result = policySchema.safeParse(
      basePolicy({ approvals: { not_a_real_tier: { required_roles: ['operator'] } } }),
    )
    expect(result.success).toBe(false)
  })

  it('refuses an unknown field inside a tier entry, per this schema\'s strict-everywhere convention', () => {
    const result = policySchema.safeParse(
      basePolicy({ approvals: { irreversible: { required_roles: ['operator'], unknown_field: true } } }),
    )
    expect(result.success).toBe(false)
  })

  it('accepts every tier configured at once, each independently, including differing typed-confirmation settings', () => {
    const result = policySchema.safeParse(
      basePolicy({
        approvals: {
          read: { required_roles: ['member'] },
          write: { required_roles: ['member', 'operator'] },
          sensitive: { required_roles: ['operator'] },
          irreversible: { required_roles: ['operator'], requires_typed_confirmation: true },
        },
      }),
    )
    expect(result.success).toBe(true)
    expect(result.success && result.data.approvals?.read?.requires_typed_confirmation).toBe(false)
    expect(result.success && result.data.approvals?.irreversible?.requires_typed_confirmation).toBe(true)
  })
})
