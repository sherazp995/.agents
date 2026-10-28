import { describe, expect, it } from 'vitest'

import { detectOriginIncident, enforceNavigation } from '../../src/browser/enforcement.js'
import { profileEntrySchema } from '../../src/profiles/schema.js'
import type { ProfileEntry } from '../../src/profiles/schema.js'

function buildProfile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return profileEntrySchema.parse({
    name: 'acme',
    description: 'Acme client work',
    user_data_dir: '/Users/op/chrome-relay',
    profile_directory: 'Profile 1',
    classification: 'client',
    allowed_origins: ['*.acme.com'],
    ...overrides,
  })
}

const HARD_BLOCKED = ['*.evil.example']

describe('enforceNavigation, FR-PRF-4', () => {
  it('refuses a call with no resolved profile, per FR-PRF-2', () => {
    const decision = enforceNavigation({
      profile: undefined,
      tier: 2,
      destination: 'app.acme.com',
      hardBlockedOrigins: HARD_BLOCKED,
    })

    expect(decision.outcome).toBe('no_profile')
  })

  describe('tiers 2 and 3: off-allowlist navigation is PREVENTED outright', () => {
    it.each([2, 3] as const)('tier %i prevents an off-allowlist navigation', (tier) => {
      const decision = enforceNavigation({
        profile: buildProfile(),
        tier,
        destination: 'not-acme.example',
        hardBlockedOrigins: HARD_BLOCKED,
      })

      expect(decision.outcome).toBe('refused')
      expect(decision.outcome === 'refused' && decision.enforcement).toBe('prevented')
    })

    it.each([2, 3] as const)('tier %i allows an on-allowlist navigation', (tier) => {
      const decision = enforceNavigation({
        profile: buildProfile(),
        tier,
        destination: 'app.acme.com',
        hardBlockedOrigins: HARD_BLOCKED,
      })

      expect(decision.outcome).toBe('allowed')
    })
  })

  describe('tier 1: the extension owns navigation, so Relay only refuses to issue', () => {
    it('refuses to issue an off-allowlist navigation, but only at request time, never claiming prevention', () => {
      const decision = enforceNavigation({
        profile: buildProfile(),
        tier: 1,
        destination: 'not-acme.example',
        hardBlockedOrigins: HARD_BLOCKED,
      })

      expect(decision.outcome).toBe('refused')
      // The load-bearing assertion: tier 1 must report refused_at_request,
      // never prevented, per FR-PRF-4's "enforcement is never described as
      // absolute where it is not". This is the exact line the self-attack
      // (below) flips to confirm the guard actually catches the mistake.
      expect(decision.outcome === 'refused' && decision.enforcement).toBe('refused_at_request')
      expect(decision.outcome === 'refused' && decision.enforcement).not.toBe('prevented')
    })

    it('allows an on-allowlist navigation', () => {
      const decision = enforceNavigation({
        profile: buildProfile(),
        tier: 1,
        destination: 'app.acme.com',
        hardBlockedOrigins: HARD_BLOCKED,
      })

      expect(decision.outcome).toBe('allowed')
    })
  })

  it('refuses a hard-blocked origin at every tier, even where a profile allowlist would permit it', () => {
    const profile = buildProfile({ allowed_origins: ['*.evil.example'] })

    for (const tier of [1, 2, 3] as const) {
      const decision = enforceNavigation({
        profile,
        tier,
        destination: 'sub.evil.example',
        hardBlockedOrigins: HARD_BLOCKED,
      })

      expect(decision.outcome).toBe('refused')
      expect(decision.outcome === 'refused' && decision.reason).toMatch(/hard-blocked/i)
    }
  })

  it('lets deny beat allow within a profile', () => {
    // A destination matching both the allowlist and the denylist: the
    // denylist entry is a decision the operator already made, so it wins,
    // per profilePermitsOrigin's own contract (src/profiles/resolve.ts).
    const profile = buildProfile({ allowed_origins: ['*.acme.com'], denied_origins: ['payroll.acme.com'] })

    const decision = enforceNavigation({
      profile,
      tier: 2,
      destination: 'payroll.acme.com',
      hardBlockedOrigins: HARD_BLOCKED,
    })

    expect(decision.outcome).toBe('refused')
  })

  it('never mistakes a subdomain match for the wrong profile\'s allowlist', () => {
    const profile = buildProfile({ allowed_origins: ['*.acme.com'] })

    const decision = enforceNavigation({
      profile,
      tier: 3,
      destination: 'app.acme.com.evil.example',
      hardBlockedOrigins: HARD_BLOCKED,
    })

    expect(decision.outcome).toBe('refused')
  })
})

describe('detectOriginIncident, FR-PRF-4 tier 1 detection', () => {
  it('reports an incident when tier 1 reached an origin outside the allowlist', () => {
    const incident = detectOriginIncident({
      profile: buildProfile(),
      tier: 1,
      reachedOrigin: 'not-acme.example',
      hardBlockedOrigins: HARD_BLOCKED,
    })

    expect(incident).toBeDefined()
    expect(incident?.tier).toBe(1)
    expect(incident?.reachedOrigin).toBe('not-acme.example')
  })

  it('reports an incident when tier 1 reached a hard-blocked origin', () => {
    const incident = detectOriginIncident({
      profile: buildProfile(),
      tier: 1,
      reachedOrigin: 'sub.evil.example',
      hardBlockedOrigins: HARD_BLOCKED,
    })

    expect(incident).toBeDefined()
    expect(incident?.reason).toMatch(/hard-blocked/i)
  })

  it('reports nothing when tier 1 stayed on an allowed origin', () => {
    const incident = detectOriginIncident({
      profile: buildProfile(),
      tier: 1,
      reachedOrigin: 'app.acme.com',
      hardBlockedOrigins: HARD_BLOCKED,
    })

    expect(incident).toBeUndefined()
  })

  it('reports nothing for tiers 2 and 3, since prevention already ruled this out', () => {
    for (const tier of [2, 3] as const) {
      const incident = detectOriginIncident({
        profile: buildProfile(),
        tier,
        reachedOrigin: 'not-acme.example',
        hardBlockedOrigins: HARD_BLOCKED,
      })

      expect(incident).toBeUndefined()
    }
  })
})
