/**
 * FR-POL-3 / FR-POL-4 / FR-CAP-2: maps a classification to allow, deny, or
 * ask, with a user-visible reason. Pure, per §18.3's
 * `PolicyEngine.decide(classification, context)`.
 *
 * Check order matters and is fixed, not data-driven. Both destination lists
 * (hard-blocked AND the ordinary denylist) run before FR-CAP-2's capability
 * state, and neither can be short-circuited by it. FR-POL-4 says this in so
 * many words for the hard-blocked list ("cannot be overridden at runtime");
 * the ordinary denylist gets the same placement for the same reason, even
 * though its own entries remain editable in the policy file: a denylist
 * entry is a decision the operator already made, and `approval_gated`
 * asking a human anyway would let a single approval reopen a question the
 * policy already settled. Fix round 1 (I-1) moved the denylist check ahead
 * of capability-state resolution after review found the previous order let
 * `approval_gated` return `ask` for a denylisted destination, in effect
 * routing a denylisted call through a human instead of refusing it.
 */

import type { CapabilityState } from '../config/schema.js'
import { matchesAnyOrigin } from './origin-match.js'
import type { Classification, DecisionContext, Policy, PolicyDecision } from './schema.js'

/**
 * Every FR-CAP-2 scope state applicable to this call, most specific first
 * (recipe > session > principal > global). A scope is applicable only when
 * both the context carries that id AND the policy has an entry for it;
 * global is applicable whenever it is set at all. Order here is precedence
 * order, not evaluation order for a short-circuit: `resolveCapabilityState`
 * below scans the whole list for `disabled` before it ever uses this
 * ordering to break a tie.
 */
function applicableStatesByPrecedence(
  context: DecisionContext,
  overrides: NonNullable<Policy['capabilities']>[string],
): CapabilityState[] {
  const states: CapabilityState[] = []
  const recipeState = context.recipeId !== undefined ? overrides.recipes?.[context.recipeId] : undefined
  if (recipeState !== undefined) states.push(recipeState)
  const sessionState = context.sessionId !== undefined ? overrides.sessions?.[context.sessionId] : undefined
  if (sessionState !== undefined) states.push(sessionState)
  const principalState = context.principalId !== undefined ? overrides.principals?.[context.principalId] : undefined
  if (principalState !== undefined) states.push(principalState)
  if (overrides.global !== undefined) states.push(overrides.global)
  return states
}

/**
 * Resolves the effective FR-CAP-2 state for `context.capability`.
 * Fail-safe, two-phase resolution rather than a single precedence chain
 * (fix round 3, I-4, after review found a plain chain let a narrower
 * `enabled` override a broader `disabled`, e.g. a specific recipe marked
 * enabled overriding a specific principal's own `disabled`):
 *
 * 1. Collect every applicable scope's state (see
 *    `applicableStatesByPrecedence` above).
 * 2. If ANY applicable scope says `disabled`, the answer is `disabled`,
 *    full stop, regardless of how specific the scope that said it was.
 *    This mirrors FR-POL-4's own principle for the hard-block and denylist
 *    checks in `decide` itself: a restriction, once set, is not something a
 *    more specific scope gets to reopen.
 * 3. Otherwise, only `enabled` and `approval_gated` remain possible among
 *    the applicable scopes, and specificity decides between them: the
 *    first entry in `applicableStatesByPrecedence`'s result, since it is
 *    already ordered recipe > session > principal > global.
 * 4. No applicable scope at all -> `enabled` (the FR-CAP-2 default;
 *    policy.yaml is not expected to enumerate every registered capability).
 */
function resolveCapabilityState(context: DecisionContext): CapabilityState {
  const overrides = context.policy.capabilities?.[context.capability]
  if (overrides === undefined) return 'enabled'

  const applicable = applicableStatesByPrecedence(context, overrides)
  if (applicable.length === 0) return 'enabled'
  if (applicable.includes('disabled')) return 'disabled'
  return applicable[0] ?? 'enabled'
}

export function decide(classification: Classification, context: DecisionContext): PolicyDecision {
  const { policy, destination, capability } = context

  // FR-POL-4: checked first and unconditionally. No branch below this one
  // can produce anything but this same deny for a hard-blocked destination.
  if (destination !== undefined && matchesAnyOrigin(destination, policy.hard_blocked_origins)) {
    return {
      decision: 'deny',
      reason: `${destination} is on the hard-blocked destination list; no approval can override this (FR-POL-4)`,
    }
  }

  // Ordinary destination denylist: policy-editable at runtime, unlike the
  // hard-blocked list above, but still checked before FR-CAP-2 capability
  // state, so an approval_gated capability can never turn a denylisted
  // destination into an `ask` (I-1).
  if (destination !== undefined && matchesAnyOrigin(destination, policy.origins?.deny ?? [])) {
    return { decision: 'deny', reason: `${destination} is on the destination denylist` }
  }

  // FR-CAP-2.
  const capabilityState = resolveCapabilityState(context)
  if (capabilityState === 'disabled') {
    return { decision: 'deny', reason: `capability "${capability}" is disabled by policy` }
  }
  if (capabilityState === 'approval_gated') {
    return { decision: 'ask', reason: `capability "${capability}" is approval-gated by policy` }
  }

  // §10.1's default handling per tier.
  switch (classification.tier) {
    case 'read':
      return { decision: 'allow', reason: 'read-tier action: no observable external change (§10.1)' }

    case 'write': {
      const allowlist = policy.origins?.allow ?? []
      if (destination === undefined) {
        return { decision: 'allow', reason: 'write-tier action with no external destination (§10.1)' }
      }
      if (matchesAnyOrigin(destination, allowlist)) {
        return { decision: 'allow', reason: `${destination} is on the origin allowlist for a write-tier action (§10.1)` }
      }
      return { decision: 'ask', reason: `${destination} is not on the origin allowlist for a write-tier action (§10.1)` }
    }

    case 'sensitive':
      return { decision: 'ask', reason: 'sensitive-tier action always requires approval (§10.1)' }

    case 'irreversible':
      return { decision: 'ask', reason: 'irreversible-tier action always requires approval (§10.1)' }

    default:
      // FR-POL-3: anything this function does not recognise defaults to
      // ask, never allow. Not reachable through a real classify() result
      // today (every RiskTier is handled above); this is the same defensive
      // floor Task 1 built for an out-of-enum riskTier, kept here in case a
      // future tier is added to RISK_TIERS without this switch being
      // updated to match.
      return { decision: 'ask', reason: 'unrecognised risk tier, defaulting to ask (FR-POL-3)' }
  }
}
