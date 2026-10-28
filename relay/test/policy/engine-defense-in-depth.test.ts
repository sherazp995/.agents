/**
 * A separate file, not a describe block inside engine.test.ts, because
 * `vi.mock` is hoisted and applies to every test in whatever file it is
 * declared in: this file's SOLE purpose is exercising src/policy/engine.ts's
 * mediate() with src/policy/decide.ts replaced by a version that reproduces
 * the exact bug Task 2's review found and fixed once already (an
 * `approval_gated` capability returning `ask` for a destination that is
 * ALSO on the denylist, letting a human approval reopen a question policy
 * had already settled). decide() itself no longer has this bug; this proves
 * mediate()'s own INDEPENDENT re-check catches it anyway, so a future
 * regression in decide() (a second time) does not automatically become a
 * live path to an approval prompt for a denylisted destination. Per the
 * team's own framing: "defence in depth at a boundary that has already
 * failed once is worth the extra test."
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Policy } from '../../src/config/schema.js'
import { CapabilityRegistry } from '../../src/capabilities/registry.js'
import type { CapabilityDefinition } from '../../src/capabilities/registry.js'

vi.mock('../../src/policy/decide.js', () => ({
  // Reproduces the exact pre-fix-round-1 bug: 'ask' for ANY approval_gated
  // capability, never checking the destination lists at all.
  decide: () => ({ decision: 'ask', reason: 'mocked: pretend decide() forgot to check the denylist' }),
}))

// Imported AFTER the mock is declared (vi.mock is hoisted above imports by
// vitest itself, so this ordering in the source is only for readability).
const { mediate } = await import('../../src/policy/engine.js')

function buildPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    defaults: { unmatched: 'ask' },
    hard_blocked_origins: ['*.never-matched.invalid'],
    origins: { allow: [], deny: ['chase.com'] },
    capabilities: { 'os.click': { global: 'approval_gated' } },
    ...overrides,
  }
}

function buildDefinition(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    name: 'os.click',
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

function buildLookup(...definitions: CapabilityDefinition[]): (name: string) => CapabilityDefinition | undefined {
  const registry = new CapabilityRegistry()
  for (const definition of definitions) registry.register(definition)
  return (name: string) => registry.get(name)
}

describe('mediate: defence in depth against a decide() that (per this file\'s mock) forgot to check the denylist', () => {
  it('overrides an ask verdict to deny when the destination is on the denylist, regardless of what decide() itself returned', () => {
    const lookup = buildLookup(buildDefinition())
    const policy = buildPolicy()
    const result = mediate({ capability: 'os.click', policy, destination: 'chase.com' }, lookup)

    // The mocked decide() said 'ask'; mediate() must not trust it here.
    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/denylist/)
    expect(result.reason).not.toMatch(/mocked: pretend/)
  })

  it('still asks (trusting the mocked decide()) when the destination is NOT on any denylist, proving this is a targeted override, not a blanket refusal of every ask', () => {
    const lookup = buildLookup(buildDefinition())
    const policy = buildPolicy()
    const result = mediate({ capability: 'os.click', policy, destination: 'not-on-any-list.example' }, lookup)

    expect(result.decision).toBe('ask')
  })
})
