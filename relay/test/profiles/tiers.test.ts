import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { profileEntrySchema } from '../../src/profiles/schema.js'
import type { ProfileEntry } from '../../src/profiles/schema.js'
import { isDefaultChromeUserDataDir, reportTierAvailability, validatePin } from '../../src/profiles/tiers.js'

const HOME = '/Users/op'
const DEFAULT_DIR = join(HOME, 'Library', 'Application Support', 'Google', 'Chrome')

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

describe('isDefaultChromeUserDataDir, FR-PRF-6a', () => {
  it('recognises Chrome own default directory', () => {
    expect(isDefaultChromeUserDataDir(DEFAULT_DIR, HOME)).toBe(true)
  })

  it('recognises it through a trailing slash and a redundant segment', () => {
    // A near miss here does not fail safe: it would report the operator's
    // everyday browser as automatable, which is the exact false positive
    // this module exists to prevent.
    expect(isDefaultChromeUserDataDir(`${DEFAULT_DIR}/`, HOME)).toBe(true)
    expect(isDefaultChromeUserDataDir(join(DEFAULT_DIR, 'Profile 1', '..'), HOME)).toBe(true)
  })

  it('does not mistake a dedicated automation directory for the default', () => {
    expect(isDefaultChromeUserDataDir('/Users/op/chrome-relay', HOME)).toBe(false)
  })

  it('only treats the running platform own paths as default', () => {
    // Checking every platform's paths at once would tell a Linux operator
    // who genuinely put an automation directory at the macOS-shaped path,
    // which is an ordinary directory there, that tier 2 is unavailable when
    // it is. The error would be in the conservative direction, but it is
    // still a wrong answer given confidently, which is what this module
    // exists to replace.
    expect(isDefaultChromeUserDataDir(DEFAULT_DIR, HOME, 'darwin')).toBe(true)
    expect(isDefaultChromeUserDataDir(DEFAULT_DIR, HOME, 'linux')).toBe(false)
    expect(isDefaultChromeUserDataDir(join(HOME, '.config', 'google-chrome'), HOME, 'linux')).toBe(true)
    expect(isDefaultChromeUserDataDir(join(HOME, '.config', 'google-chrome'), HOME, 'darwin')).toBe(false)
  })
})

describe('reportTierAvailability, FR-PRF-6a', () => {
  it('refuses tier 2 for a profile pointing at the everyday Chrome directory', () => {
    const report = reportTierAvailability(buildProfile({ user_data_dir: DEFAULT_DIR }), HOME)
    const tier2 = report.tiers.find((entry) => entry.tier === 2)

    // Not "unreliable with", cannot: Chrome 136 and later ignore
    // remote-debugging switches for the default user-data directory.
    expect(tier2?.available).toBe(false)
    expect(tier2?.reason).toMatch(/default user-data directory/i)
  })

  it('offers tier 2 for a dedicated automation directory', () => {
    const tier2 = reportTierAvailability(buildProfile(), HOME).tiers.find((entry) => entry.tier === 2)

    expect(tier2?.available).toBe(true)
    expect(tier2?.reason).toMatch(/ENFORCED/)
  })

  it('offers tier 1 only where the extension is declared', () => {
    expect(reportTierAvailability(buildProfile({ extension: true }), HOME).tiers[0]?.available).toBe(true)
    expect(reportTierAvailability(buildProfile({ extension: false }), HOME).tiers[0]?.available).toBe(false)
  })

  it('states plainly that tier 1 detects rather than prevents', () => {
    const tier1 = reportTierAvailability(buildProfile({ extension: true }), HOME).tiers[0]

    // FR-PRF-4: enforcement is never described as absolute where it is not.
    // Asserted by meaning rather than by banning the word "prevented", which
    // the honest sentence legitimately contains as "not prevented".
    expect(tier1?.reason).toMatch(/DETECTED/)
    expect(tier1?.reason).toMatch(/not prevented/i)
    expect(tier1?.reason).not.toMatch(/ENFORCED/)
  })

  it('does not count tier 1 toward pinnability, even when available', () => {
    // A pin promises ENFORCEMENT. Tier 1 can only detect, so counting it
    // would make a pin honourable on paper and hollow in practice.
    const report = reportTierAvailability(
      buildProfile({ extension: true, user_data_dir: DEFAULT_DIR }),
      HOME,
    )

    expect(report.tiers[0]?.available).toBe(true)
    expect(report.tiers.find((entry) => entry.tier === 2)?.available).toBe(false)
    // Tier 3 is always available, so this stays pinnable via tier 3 alone.
    expect(report.canPin).toBe(true)
  })
})

describe('validatePin, FR-PRF-4a', () => {
  it('accepts a pin the profile can honour', () => {
    expect(validatePin(buildProfile({ pinned_tier: 2 }), HOME).ok).toBe(true)
  })

  it('refuses a tier 2 pin on an everyday profile, naming the reason', () => {
    // Setup never accepts a pin it cannot honour. Accepting it would leave
    // the operator believing origin scoping is enforced for a client
    // profile when it is only detected.
    const result = validatePin(buildProfile({ pinned_tier: 2, user_data_dir: DEFAULT_DIR }), HOME)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/not available/i)
    expect(result.ok === false && result.reason).toMatch(/default user-data directory/i)
  })

  it('accepts a tier 3 pin even on an everyday profile, since Relay owns that browser', () => {
    expect(validatePin(buildProfile({ pinned_tier: 3, user_data_dir: DEFAULT_DIR }), HOME).ok).toBe(true)
  })

  it('accepts a profile with no pin at all', () => {
    expect(validatePin(buildProfile(), HOME).ok).toBe(true)
  })
})
