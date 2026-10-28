/**
 * FR-PRF-2 and FR-PRF-3: binding a browser call to exactly one profile, or
 * refusing.
 *
 * The whole value of this module is what it does when it is not sure. A
 * browser profile carries live logged-in sessions, so guessing wrong does not
 * produce a wrong answer, it produces a real action inside the wrong client's
 * account. So there are exactly three outcomes and no default:
 *
 *   - resolved: exactly one candidate.
 *   - ambiguous: more than one. Relay asks, with the candidates named.
 *   - unresolved: none. Relay asks.
 *
 * FR-PRF-2 states it directly: a call with no bound profile is refused, never
 * defaulted. There is deliberately no "first match wins" and no "if only one
 * profile exists, use it", because both are guesses that read as convenience
 * until the day a second profile is added.
 *
 * Pure, with no I/O: every fact a rule can test is supplied by the caller, so
 * the whole decision table is exhaustively testable.
 */

import { matchesAnyOrigin } from '../policy/origin-match.js'
import type { ProfileEntry, ProfileRegistry } from './schema.js'

export type ProfileResolutionRequest = {
  /** (a) An explicit profile named in the task or recipe. The strongest signal, because the operator said it. */
  readonly explicitProfile?: string
  /** (b) A project or client name mentioned in the task. */
  readonly project?: string
  /** (c) The origin the task wants to reach. */
  readonly destination?: string
  /** (d) The Slack channel the task came from, where a channel-to-profile mapping is configured. */
  readonly channelId?: string
  /** Channel to profile bindings, where the operator has configured any. */
  readonly channelBindings?: Readonly<Record<string, string>>
}

export type ProfileResolution =
  | { readonly outcome: 'resolved'; readonly profile: ProfileEntry; readonly by: 'explicit' | 'project' | 'origin' | 'channel' }
  | { readonly outcome: 'ambiguous'; readonly candidates: readonly ProfileEntry[]; readonly reason: string }
  | { readonly outcome: 'unresolved'; readonly reason: string }

/** Profiles eligible to be resolved at all. FR-PRF-5's exclusion is applied once, here, rather than at each rule. */
function usableProfiles(registry: ProfileRegistry): readonly ProfileEntry[] {
  return registry.profiles.filter((profile) => profile.usable && profile.classification !== 'personal')
}

/**
 * Resolves a profile, or refuses.
 *
 * The four rules are tried in FR-PRF-3's order, and the FIRST rule that
 * matches anything decides the outcome, including deciding that the outcome
 * is ambiguous. It does not fall through to a weaker rule to break a tie:
 * if the operator named a project and two profiles claim it, the answer is a
 * question, not a guess made by a rule they did not invoke.
 */
export function resolveProfile(registry: ProfileRegistry, request: ProfileResolutionRequest): ProfileResolution {
  const usable = usableProfiles(registry)

  // (a) An explicitly named profile. Checked against the FULL registry, not
  // just the usable ones, so naming an excluded personal profile is refused
  // with its real reason rather than reported as "no such profile", which
  // would send the operator hunting for a typo that is not there.
  if (request.explicitProfile !== undefined) {
    const named = request.explicitProfile.trim().toLowerCase()
    const match = registry.profiles.find((profile) => profile.name.toLowerCase() === named)
    if (!match) {
      return { outcome: 'unresolved', reason: `no profile named "${request.explicitProfile}" exists in the registry` }
    }
    if (!match.usable || match.classification === 'personal') {
      return {
        outcome: 'unresolved',
        reason: `profile "${match.name}" is excluded from agent use, per FR-PRF-5`,
      }
    }
    return { outcome: 'resolved', profile: match, by: 'explicit' }
  }

  // (b) A project or client named in the task.
  if (request.project !== undefined) {
    const wanted = request.project.trim().toLowerCase()
    const matches = usable.filter((profile) => profile.project?.toLowerCase() === wanted)
    if (matches.length === 1 && matches[0]) return { outcome: 'resolved', profile: matches[0], by: 'project' }
    if (matches.length > 1) {
      return {
        outcome: 'ambiguous',
        candidates: matches,
        reason: `${matches.length} profiles are bound to project "${request.project}"`,
      }
    }
  }

  // (c) The requested origin matching exactly one profile's allowlist.
  // "Exactly one" is the point: overlapping allowlists are legitimate, and
  // the right response to an overlap is to ask which one, not to take the
  // first.
  if (request.destination !== undefined) {
    const destination = request.destination
    const matches = usable.filter((profile) => matchesAnyOrigin(destination, profile.allowed_origins))
    if (matches.length === 1 && matches[0]) return { outcome: 'resolved', profile: matches[0], by: 'origin' }
    if (matches.length > 1) {
      return {
        outcome: 'ambiguous',
        candidates: matches,
        reason: `${matches.length} profiles allow the origin "${request.destination}"`,
      }
    }
  }

  // (d) A Slack channel bound to a profile, where that mapping exists.
  if (request.channelId !== undefined && request.channelBindings) {
    const boundName = request.channelBindings[request.channelId]
    if (boundName !== undefined) {
      const match = usable.find((profile) => profile.name.toLowerCase() === boundName.trim().toLowerCase())
      if (match) return { outcome: 'resolved', profile: match, by: 'channel' }
      return {
        outcome: 'unresolved',
        reason: `channel ${request.channelId} is bound to profile "${boundName}", which is not usable or does not exist`,
      }
    }
  }

  return {
    outcome: 'unresolved',
    reason:
      'no profile could be resolved from the task, the project, the destination, or the channel. ' +
      'Name one explicitly rather than letting Relay choose.',
  }
}

/**
 * FR-PRF-4: whether a profile permits reaching `destination`.
 *
 * Deny beats allow, unconditionally. A denied origin is a decision the
 * operator already made, and an allowlist entry that also matches is not new
 * information, so letting allow win would let a broad pattern silently undo
 * a specific prohibition.
 *
 * This answers only what the PROFILE permits. The global hard-blocked list
 * applies on top of every profile at every tier, and is enforced by the
 * policy engine rather than here, so that a profile cannot widen it.
 */
export function profilePermitsOrigin(profile: ProfileEntry, destination: string): boolean {
  if (matchesAnyOrigin(destination, profile.denied_origins)) return false
  return matchesAnyOrigin(destination, profile.allowed_origins)
}
