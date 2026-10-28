/**
 * FR-PRF-6a: `relay doctor` reports which browser tiers are truly available
 * per profile, so an operator learns the truth about their machine from one
 * command rather than discovering at task time that a tier they were
 * relying on was never available.
 *
 * This check is a thin reporting layer over src/profiles/tiers.ts, which
 * already does the actual detection (reportTierAvailability) and the
 * pin-honourability judgement (validatePin). Nothing here re-derives that
 * logic; the job here is only to load the registry and render its findings
 * truthfully.
 *
 * Three things this check must never get wrong, because each one is a way
 * an operator ends up trusting something that is not true:
 *
 *   - No profiles.yaml at all is NOT a failure. It means browser profiles
 *     are simply not configured yet, and every browser call is refused with
 *     a clear reason (FR-PRF-2), which is a safe resting state.
 *   - A pin that cannot be honoured is a FAILURE, not a warning (FR-PRF-4a).
 *     Reporting it as anything softer would tell an operator that origin
 *     scoping is enforced for a client profile when it is only detected.
 *   - A `personal` profile is reported as excluded from agent use (FR-PRF-5),
 *     not as a set of tier availabilities, since it can never be bound to a
 *     task regardless of what tiers its browser could technically support.
 */

import { homedir } from 'node:os'
import { defaultConfigPath, defaultPolicyPath, defaultProfilesPath } from '../../config/paths.js'

import { loadProfileRegistryIfPresent } from '../../config/load.js'
import type { ProfileEntry } from '../../profiles/schema.js'
import { reportTierAvailability, validatePin } from '../../profiles/tiers.js'
import type { CheckResult } from '../checks.js'
import { registerCheck } from '../registry.js'
import type { Check } from '../registry.js'

/**
 * Matches the CLI's own defaults for config and policy ('config/relay.config.yaml',
 * 'config/policy.yaml') and config/profiles.example.yaml's own instruction to
 * copy itself to this path. There is no config field carrying this path,
 * because profiles.yaml is deliberately allowed to be entirely absent
 * (FR-PRF-1's registry is optional infrastructure, not required config).
 */
const DEFAULT_PROFILES_PATH = defaultProfilesPath()

const NOT_CONFIGURED_DETAIL =
  'no profiles configured. Every browser call is refused with a clear reason (FR-PRF-2), which is a safe state, ' +
  'not a broken one.'

const PIN_FAILURE_REMEDIATION =
  'A pinned profile cannot be honoured with its current tiers. Point it at a dedicated automation user_data_dir ' +
  'so tier 2 becomes available, pin it to tier 3 instead, or remove the pin, per FR-PRF-4a.'

/**
 * Removes every occurrence of the operator's home directory from a piece of
 * text before it can reach a CheckResult (FR-SEC-1). A profile's
 * user_data_dir is a filesystem path, and on every platform Relay runs on
 * that path starts with the operator's home directory, which on macOS is
 * /Users/<name>/... . reportTierAvailability's own tier 2 reason embeds
 * user_data_dir verbatim so the operator can see exactly which directory it
 * is talking about, which is correct for a report meant to be acted on, but
 * relay doctor output is exactly what an operator pastes into an issue or a
 * chat, so the account-identifying prefix is stripped here before that can
 * happen. The replacement is a bare tilde, the shell's own shorthand for
 * home, so the rest of the path stays readable and the operator can still
 * tell which profile a reason is about.
 */
function redactHome(text: string, home: string): string {
  if (home.length === 0) return text
  return text.split(home).join('~')
}

/**
 * One profile's line in the report. A personal profile is reported as
 * excluded and nothing else, per FR-PRF-5: its tier availabilities are
 * irrelevant, since Relay refuses to bind a task to it regardless of what
 * its browser could technically support.
 */
function formatProfile(profile: ProfileEntry, home: string): string {
  if (profile.classification === 'personal') {
    return `profile "${profile.name}" (personal): excluded from agent use, per FR-PRF-5`
  }

  const report = reportTierAvailability(profile, home)
  const tierLines = report.tiers
    .map((entry) => `tier ${entry.tier} ${entry.available ? 'available' : 'unavailable'} (${entry.reason})`)
    .join('; ')

  const pin = profile.pinned_tier === undefined ? undefined : validatePin(profile, home)
  const pinLine =
    pin === undefined ? '' : pin.ok ? ` Pinned to tier ${profile.pinned_tier}, honoured.` : ` PIN FAILURE: ${pin.reason}`

  return `profile "${profile.name}" (${profile.classification}): ${tierLines}.${pinLine}`
}

/**
 * `home` is a parameter, not a call to homedir() inside the function, for
 * the same reason src/profiles/tiers.ts takes it as a parameter throughout:
 * a test needs to construct a profile pointing at "Chrome's own default
 * directory" without depending on, or mutating, the real machine's actual
 * home directory.
 */
export function checkProfiles(profilesPath: string = DEFAULT_PROFILES_PATH, home: string = homedir()): Check {
  return {
    name: 'profiles',
    async run(): Promise<CheckResult> {
      const registry = loadProfileRegistryIfPresent(profilesPath)

      if (registry.profiles.length === 0) {
        return { name: 'profiles', status: 'ok', detail: NOT_CONFIGURED_DETAIL }
      }

      const detail = redactHome(
        registry.profiles.map((profile) => formatProfile(profile, home)).join('\n'),
        home,
      )

      // FR-PRF-4a: "setup never accepts a pin it cannot honour." A pin that
      // slipped past configuration time regardless, for instance because the
      // operator's machine changed after the registry was written, is a
      // failure here, not a degradation: an operator who believes origin
      // scoping is enforced for a client profile when it is only detected
      // has been actively misled, and "degraded" reads as optional to fix.
      const unhonourablePin = registry.profiles.some((profile) => !(validatePin(profile, home).ok))
      if (unhonourablePin) {
        return { name: 'profiles', status: 'failed', detail, remediation: PIN_FAILURE_REMEDIATION }
      }

      return { name: 'profiles', status: 'ok', detail }
    },
  }
}

registerCheck(checkProfiles())
