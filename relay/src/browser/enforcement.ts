/**
 * FR-PRF-4: the seam every browser capability call passes through before it
 * is allowed to navigate.
 *
 * The requirement's own asymmetry is the whole point of this file. Tiers 2
 * and 3 are drivers Relay owns, so an off-allowlist navigation is PREVENTED
 * outright: it simply never happens. Tier 1 is the Claude-in-Chrome
 * extension, which owns navigation and honours its own permission model
 * (FR-BR-1), so Relay can only REFUSE TO ISSUE an off-allowlist navigation
 * at request time; whether the extension goes there anyway by some other
 * path is outside Relay's control and can only be discovered afterwards, by
 * `detectOriginIncident` below. "Enforcement is never described as absolute
 * where it is not" (FR-PRF-4), so `enforceNavigation`'s return type carries
 * a named `enforcement` field rather than collapsing both cases into a
 * boolean: a caller reading `outcome === 'refused'` still has to look at
 * `enforcement` to know whether the origin was actually kept out or merely
 * not invited to.
 *
 * The global hard-blocked list is checked first, unconditionally, mirroring
 * `src/policy/decide.ts`'s own ordering (FR-POL-4): no profile allowlist is
 * ever consulted for a hard-blocked destination, at any tier, so a profile
 * can never widen it.
 */

import { matchesAnyOrigin } from '../policy/origin-match.js'
import { profilePermitsOrigin } from '../profiles/resolve.js'
import type { BrowserTier, ProfileEntry } from '../profiles/schema.js'

/**
 * How a 'refused' verdict was enforced. `prevented` means the navigation
 * cannot happen at all, Relay is the driver. `refused_at_request` means
 * Relay declined to issue the instruction, nothing more: it is not a claim
 * that the destination is unreachable, only that Relay did not send anyone
 * there. Keeping these as two distinct string literals, rather than one
 * boolean, is what stops a caller from writing code that treats a tier 1
 * refusal as if it had prevented anything.
 */
export const ENFORCEMENT_MODES = ['prevented', 'refused_at_request'] as const
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number]

export type NavigationCheckParams = {
  /** The resolved profile, or `undefined` for a call with no bound profile. */
  readonly profile: ProfileEntry | undefined
  readonly tier: BrowserTier
  /** A bare hostname, already normalized by the caller (the mediation seam owns normalization, per `src/policy/engine.ts`'s own doc comment; this module does not parse URLs). */
  readonly destination: string
  /** FR-POL-4's hard-blocked list, supplied by the caller from `Policy.hard_blocked_origins` so this module does not have to import the whole policy engine to ask one question. */
  readonly hardBlockedOrigins: readonly string[]
}

export type NavigationDecision =
  | { readonly outcome: 'allowed' }
  /** FR-PRF-2: a call with no bound profile is refused, never defaulted. Kept as its own outcome rather than folded into `refused` below, because it is not a tier-dependent origin decision at all: there is no profile to check an origin against. */
  | { readonly outcome: 'no_profile'; readonly reason: string }
  | { readonly outcome: 'refused'; readonly enforcement: EnforcementMode; readonly reason: string }

/**
 * Whether a navigation to `destination` may be issued, and how firmly that
 * answer holds.
 *
 * Order of checks, and why it is fixed:
 *
 *   1. No profile: refused immediately, per FR-PRF-2. Nothing below this
 *      needs a profile, so nothing below it runs.
 *   2. The hard-blocked list, unconditionally, before the profile's own
 *      allowlist is even read. This is what makes "a profile can never
 *      widen it" true: the profile's `allowed_origins` is never consulted
 *      for a hard-blocked destination.
 *   3. The profile's own allow/deny, via `profilePermitsOrigin`, which
 *      already gives deny priority over allow within the profile.
 *
 * `enforcement` is derived from `tier` alone, in exactly one place: tiers 2
 * and 3 get `prevented`, tier 1 gets `refused_at_request`. That one branch
 * is the entire guard FR-PRF-4 asks for; the tests in
 * `test/browser/enforcement.test.ts` pin it down by asserting the mapping
 * directly, not just the outcome, so that swapping the branches fails a
 * test rather than silently shipping a tier 1 that claims prevention.
 */
export function enforceNavigation(params: NavigationCheckParams): NavigationDecision {
  const { profile, tier, destination, hardBlockedOrigins } = params
  const enforcement: EnforcementMode = tier === 1 ? 'refused_at_request' : 'prevented'

  if (profile === undefined) {
    return {
      outcome: 'no_profile',
      reason: 'no profile is bound to this call; a browser call with no resolved profile is refused, never defaulted (FR-PRF-2)',
    }
  }

  if (matchesAnyOrigin(destination, hardBlockedOrigins)) {
    return {
      outcome: 'refused',
      enforcement,
      reason: `${destination} is on the hard-blocked destination list; no profile allowlist can override this, at any tier (FR-POL-4)`,
    }
  }

  if (profilePermitsOrigin(profile, destination)) {
    return { outcome: 'allowed' }
  }

  return {
    outcome: 'refused',
    enforcement,
    reason: `${destination} is not permitted by profile "${profile.name}"'s origin allowlist`,
  }
}

/**
 * FR-PRF-4's other half: for tier 1, an origin actually reached outside the
 * allowlist is detected and reported as an incident, since Relay cannot have
 * prevented it. Tiers 2 and 3 never call this meaningfully because
 * `enforceNavigation` already prevented any such navigation from happening
 * in the first place; called with tier 2 or 3 anyway, it reports nothing,
 * since there is nothing for Relay to have failed to prevent.
 */
export type OriginIncident = {
  readonly reachedOrigin: string
  readonly profile: string
  /** Always 1: detection exists only where prevention was not possible. */
  readonly tier: 1
  readonly reason: string
}

export function detectOriginIncident(params: {
  readonly profile: ProfileEntry
  readonly tier: BrowserTier
  readonly reachedOrigin: string
  readonly hardBlockedOrigins: readonly string[]
}): OriginIncident | undefined {
  if (params.tier !== 1) return undefined

  if (matchesAnyOrigin(params.reachedOrigin, params.hardBlockedOrigins)) {
    return {
      reachedOrigin: params.reachedOrigin,
      profile: params.profile.name,
      tier: 1,
      reason: `tier 1 reached ${params.reachedOrigin}, which is on the hard-blocked destination list`,
    }
  }

  if (profilePermitsOrigin(params.profile, params.reachedOrigin)) return undefined

  return {
    reachedOrigin: params.reachedOrigin,
    profile: params.profile.name,
    tier: 1,
    reason: `tier 1 reached ${params.reachedOrigin}, outside profile "${params.profile.name}"'s origin allowlist`,
  }
}
