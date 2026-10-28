import { describe, expect, it } from 'vitest'

import { loadProfileRegistry } from '../../src/config/load.js'
import { reportTierAvailability, validatePin } from '../../src/profiles/tiers.js'

/**
 * The shipped example is the first thing an operator copies, so a mistake in
 * it is a mistake every installation starts from. It is checked here as real
 * input rather than treated as documentation.
 */
describe('config/profiles.example.yaml', () => {
  const registry = loadProfileRegistry('config/profiles.example.yaml')

  it('validates against the real schema', () => {
    expect(registry.profiles.map((profile) => profile.name)).toEqual(['acme', 'work', 'personal'])
  })

  it('ships no pin it cannot honour', () => {
    // FR-PRF-4a. An example that pinned a profile whose tier is unavailable
    // would teach the operator to write exactly the configuration setup is
    // supposed to refuse.
    for (const profile of registry.profiles) {
      expect(validatePin(profile, '/Users/you').ok, `pin for ${profile.name}`).toBe(true)
    }
  })

  it('demonstrates the Chrome default-directory constraint rather than hiding it', () => {
    // The `work` profile deliberately points at Chrome's own default
    // directory, so an operator copying this file sees a REAL example of a
    // profile where tier 2 is unavailable, and `relay doctor` explains why.
    // An example where everything is available would leave FR-PRF-6a's
    // constraint to be discovered at task time.
    const work = registry.profiles.find((profile) => profile.name === 'work')
    expect(work).toBeDefined()
    const tier2 = reportTierAvailability(work!, '/Users/you').tiers.find((entry) => entry.tier === 2)
    expect(tier2?.available).toBe(false)
    expect(tier2?.reason).toMatch(/default user-data directory/i)
  })

  it('lists the personal profile as excluded, per FR-PRF-5', () => {
    const personal = registry.profiles.find((profile) => profile.name === 'personal')

    expect(personal?.usable).toBe(false)
  })
})
