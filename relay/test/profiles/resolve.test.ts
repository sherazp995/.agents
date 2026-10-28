import { describe, expect, it } from 'vitest'

import { profileEntrySchema, profileRegistrySchema } from '../../src/profiles/schema.js'
import type { ProfileEntry, ProfileRegistry } from '../../src/profiles/schema.js'
import { profilePermitsOrigin, resolveProfile } from '../../src/profiles/resolve.js'

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

function buildRegistry(profiles: readonly Partial<ProfileEntry>[]): ProfileRegistry {
  return profileRegistrySchema.parse({ version: 1, profiles: profiles.map((p) => buildProfile(p)) })
}

describe('profile registry schema, FR-PRF-1', () => {
  it('rejects a profile with no allowed origins', () => {
    // The registry's own acceptance criterion. An empty allowlist reads
    // equally as "nothing permitted" and "not configured yet", and a
    // registry that cannot tell those apart will be asked to guess.
    expect(() => buildProfile({ allowed_origins: [] })).toThrow(/no allowed origins/i)
  })

  it('rejects a personal profile marked usable, per FR-PRF-5', () => {
    expect(() => buildProfile({ classification: 'personal', usable: true })).toThrow(/personal profile cannot be usable/i)
  })

  it('accepts a personal profile listed as explicitly excluded', () => {
    // Listing it is the point: naming it later then produces an explicit
    // refusal rather than a silent miss indistinguishable from a typo.
    expect(buildProfile({ classification: 'personal', usable: false }).usable).toBe(false)
  })

  it('refuses a tier 1 pin, since tier 1 detects rather than enforces', () => {
    // FR-PRF-4a: a pin is a promise that scoping is ENFORCED. Tier 1 cannot
    // make that promise, so the type refuses rather than accepting a pin
    // that would be quietly unhonoured.
    expect(() => buildProfile({ pinned_tier: 1 as unknown as 2 })).toThrow()
  })

  it('rejects duplicate profile names, which would make resolution order-dependent', () => {
    expect(() => buildRegistry([{ name: 'acme' }, { name: 'ACME' }])).toThrow(/duplicate profile name/i)
  })
})

describe('resolveProfile, FR-PRF-2 and FR-PRF-3', () => {
  it('resolves an explicitly named profile', () => {
    const registry = buildRegistry([{ name: 'acme' }, { name: 'other', allowed_origins: ['*.other.com'] }])

    const result = resolveProfile(registry, { explicitProfile: 'acme' })

    expect(result.outcome).toBe('resolved')
    expect(result.outcome === 'resolved' && result.by).toBe('explicit')
  })

  it('refuses rather than defaulting when nothing resolves, per FR-PRF-2', () => {
    const registry = buildRegistry([{ name: 'acme' }])

    // Deliberately with a single profile in the registry: "there is only
    // one, so use it" is the most tempting default and the most dangerous,
    // because it works right up until a second profile is added.
    const result = resolveProfile(registry, {})

    expect(result.outcome).toBe('unresolved')
  })

  it('asks rather than guessing when two profiles claim the same project', () => {
    const registry = buildRegistry([
      { name: 'acme-a', project: 'acme' },
      { name: 'acme-b', project: 'acme', allowed_origins: ['*.acme.net'] },
    ])

    const result = resolveProfile(registry, { project: 'acme' })

    expect(result.outcome).toBe('ambiguous')
    expect(result.outcome === 'ambiguous' && result.candidates).toHaveLength(2)
  })

  it('asks rather than guessing when two profiles allow the same origin', () => {
    const registry = buildRegistry([
      { name: 'acme-a' },
      { name: 'acme-b', allowed_origins: ['*.acme.com'] },
    ])

    // Overlapping allowlists are legitimate. The right answer to an overlap
    // is a question, never the first match.
    const result = resolveProfile(registry, { destination: 'app.acme.com' })

    expect(result.outcome).toBe('ambiguous')
  })

  it('does not fall through to a weaker rule to break a tie', () => {
    const registry = buildRegistry([
      { name: 'acme-a', project: 'acme' },
      { name: 'acme-b', project: 'acme', allowed_origins: ['*.acme.net'] },
    ])

    // The origin would resolve cleanly to acme-b, but the operator invoked
    // the project rule and it was ambiguous. Silently answering with a rule
    // they did not invoke is exactly the guess FR-PRF-3 forbids.
    const result = resolveProfile(registry, { project: 'acme', destination: 'app.acme.net' })

    expect(result.outcome).toBe('ambiguous')
  })

  it('names the real reason when an excluded personal profile is asked for by name', () => {
    const registry = buildRegistry([{ name: 'personal', classification: 'personal', usable: false }])

    const result = resolveProfile(registry, { explicitProfile: 'personal' })

    // Not "no such profile": that would send the operator hunting for a typo
    // that does not exist.
    expect(result.outcome).toBe('unresolved')
    expect(result.outcome === 'unresolved' && result.reason).toMatch(/excluded from agent use/i)
  })

  it('never resolves to a personal profile through any rule', () => {
    const registry = buildRegistry([{ name: 'personal', classification: 'personal', usable: false, project: 'acme' }])

    expect(resolveProfile(registry, { project: 'acme' }).outcome).toBe('unresolved')
    expect(resolveProfile(registry, { destination: 'app.acme.com' }).outcome).toBe('unresolved')
  })

  it('resolves through a channel binding when one is configured', () => {
    const registry = buildRegistry([{ name: 'acme' }])

    const result = resolveProfile(registry, { channelId: 'C1', channelBindings: { C1: 'acme' } })

    expect(result.outcome === 'resolved' && result.by).toBe('channel')
  })
})

describe('profilePermitsOrigin, FR-PRF-4', () => {
  it('permits an allowlisted origin', () => {
    expect(profilePermitsOrigin(buildProfile(), 'app.acme.com')).toBe(true)
  })

  it('refuses an origin outside the allowlist', () => {
    expect(profilePermitsOrigin(buildProfile(), 'evil.example.com')).toBe(false)
  })

  it('lets deny beat allow, so a broad pattern cannot undo a specific prohibition', () => {
    const profile = buildProfile({ allowed_origins: ['*.acme.com'], denied_origins: ['admin.acme.com'] })

    expect(profilePermitsOrigin(profile, 'app.acme.com')).toBe(true)
    expect(profilePermitsOrigin(profile, 'admin.acme.com')).toBe(false)
  })
})
