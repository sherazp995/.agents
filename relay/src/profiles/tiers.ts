/**
 * FR-PRF-6a: establishing which browser tiers are actually available for a
 * profile, rather than assuming a ladder that silently has a rung missing.
 *
 * The constraint this exists for, quoted from the requirement because it
 * shapes the whole profile design: Chrome 136 and later ignore
 * remote-debugging switches for the DEFAULT user-data directory, automating
 * a default profile is unsupported by Playwright, and a user-data directory
 * permits only one running browser instance.
 *
 * The consequence is blunt and worth stating plainly: **tier 2 cannot attach
 * to the browser the operator uses day to day.** Not "is unreliable with",
 * cannot. So a setup flow that offers tier 2 for the operator's everyday
 * profile is offering something that will never work, and FR-PRF-4a's tier
 * pinning must refuse a pin it cannot honour rather than accept it and fail
 * later, at which point the operator believes scoping is enforced when it is
 * only detected.
 *
 * Detection is deliberately conservative. Where availability cannot be
 * established, the answer is unavailable, because the cost of wrongly
 * reporting a tier as available is an operator who believes origin scoping
 * is enforced for a client profile when it is not.
 */

import { homedir } from 'node:os'
import { join, normalize, resolve as resolvePath } from 'node:path'

import type { BrowserTier, ProfileEntry } from './schema.js'

export type TierAvailability = {
  readonly tier: BrowserTier
  readonly available: boolean
  /** Why, in words an operator can act on. Present whether available or not, since "why is this on" matters as much as "why is this off". */
  readonly reason: string
}

export type ProfileTierReport = {
  readonly profile: string
  readonly tiers: readonly TierAvailability[]
  /** True when at least one tier ENFORCES origin scoping rather than merely detecting it, which is what FR-PRF-4a's pin requires. */
  readonly canPin: boolean
}

/**
 * Chrome's own default user-data directories, per platform. A profile
 * pointing at one of these is the operator's everyday browser, which is
 * exactly the case Chrome 136 refuses to expose for automation.
 */
export function defaultChromeUserDataDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  // Platform-scoped rather than every platform's paths at once. Returning
  // all of them means a Linux operator who genuinely puts an automation
  // directory at ~/Library/Application Support/Google/Chrome, which is an
  // ordinary directory there, is told tier 2 is unavailable when it is.
  //
  // That error is in the conservative direction, so it costs a capability
  // rather than creating an exposure, but it is still a wrong answer given
  // confidently, and the whole point of this module is to replace a guess
  // with a fact.
  if (platform === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      join(home, 'Library', 'Application Support', 'Chromium'),
    ]
  }
  if (platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
      join(home, 'AppData', 'Local', 'Chromium', 'User Data'),
    ]
  }
  return [join(home, '.config', 'google-chrome'), join(home, '.config', 'chromium')]
}

/**
 * Whether `userDataDir` is one of Chrome's own defaults.
 *
 * Compared after normalising and resolving, so that a path written with a
 * trailing slash, a redundant segment, or a relative prefix is still
 * recognised. A near-miss here does not fail safe: it would report the
 * operator's everyday profile as automatable, which is the exact false
 * positive this module exists to prevent.
 */
export function isDefaultChromeUserDataDir(
  userDataDir: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const target = normalize(resolvePath(userDataDir))
  return defaultChromeUserDataDirs(home, platform).some((candidate) => normalize(resolvePath(candidate)) === target)
}

/**
 * The tier availability report for one profile.
 *
 * Tier 1, the Claude-in-Chrome extension, is available where the profile
 * declares the extension. It DETECTS origin violations rather than
 * preventing them, per FR-PRF-4, because the extension owns navigation.
 *
 * Tier 2, a Relay-driven browser over CDP, is available only for a
 * dedicated automation profile, for the reason above. It ENFORCES.
 *
 * Tier 3 is a fully Relay-owned browser with its own user-data directory,
 * always available because Relay creates it, and it ENFORCES. It is the
 * fallback that makes a pin honourable for a client profile whose everyday
 * browser cannot be driven, though it starts logged out.
 */
export function reportTierAvailability(
  profile: ProfileEntry,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): ProfileTierReport {
  const usesDefaultDir = isDefaultChromeUserDataDir(profile.user_data_dir, home, platform)

  const tiers: TierAvailability[] = [
    profile.extension
      ? {
          tier: 1,
          available: true,
          reason:
            'the profile declares the Claude-in-Chrome extension. Origin scoping is DETECTED and reported here, ' +
            'not prevented, because the extension owns navigation (FR-PRF-4). Declared availability is a ' +
            'CANDIDATE only: FR-PRF-6 requires tier 1 to discover the live browser connections and positively ' +
            'identify the one belonging to this profile before acting, and to skip tier 1 rather than act in an ' +
            'unverified browser. That verification happens at attach time, not here.',
        }
      : {
          tier: 1,
          available: false,
          reason: 'the profile does not declare the Claude-in-Chrome extension',
        },
    usesDefaultDir
      ? {
          tier: 2,
          available: false,
          reason:
            `"${profile.user_data_dir}" is Chrome's own default user-data directory. Chrome 136 and later ignore ` +
            'remote-debugging switches for it, so tier 2 cannot attach to the browser you use day to day. ' +
            'Point this profile at a dedicated automation user-data directory to make tier 2 available.',
        }
      : {
          tier: 2,
          available: true,
          reason:
            'a dedicated user-data directory, so Relay can drive it over CDP and origin scoping is ENFORCED. ' +
            'Only one browser instance may use this directory at a time.',
        },
    {
      tier: 3,
      available: true,
      reason:
        'a fully Relay-owned browser with its own user-data directory. Always available because Relay creates it, ' +
        'and origin scoping is ENFORCED. It starts logged out, so a task needing an existing session cannot use it.',
    },
  ]

  return {
    profile: profile.name,
    tiers,
    // A pin promises enforcement, so only enforcing tiers count toward it.
    // Tier 1 is excluded deliberately even when available.
    canPin: tiers.some((entry) => entry.available && entry.tier !== 1),
  }
}

/**
 * FR-PRF-4a: whether a profile's declared pin can actually be honoured.
 *
 * Called at configuration time so a pin that cannot be honoured is refused
 * with its reason, rather than accepted and discovered later, when the
 * operator already believes scoping is enforced for a client profile.
 */
export function validatePin(
  profile: ProfileEntry,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): { ok: true } | { ok: false; reason: string } {
  if (profile.pinned_tier === undefined) return { ok: true }

  const report = reportTierAvailability(profile, home, platform)
  const pinned = report.tiers.find((entry) => entry.tier === profile.pinned_tier)
  if (pinned?.available === true) return { ok: true }

  return {
    ok: false,
    reason:
      `profile "${profile.name}" is pinned to tier ${profile.pinned_tier}, which is not available: ` +
      `${pinned?.reason ?? 'unknown tier'}. Setup never accepts a pin it cannot honour (FR-PRF-4a).`,
  }
}
