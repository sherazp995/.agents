/**
 * FR-POL-1 / FR-POL-8: classifies a proposed call into a risk tier, taking
 * the capability's declared tier and raising it wherever a configured
 * escalation rule matches. Pure: no I/O, no clock, no database. Every fact
 * an escalation rule can test (destination history, blast-radius counts,
 * whether a credential is present) is supplied by the caller through `call`
 * and `context`, per §18.3's `PolicyEngine.classify(call, context)`.
 */

import type { EscalationCondition, EscalationRule } from '../config/schema.js'
import { RISK_TIERS } from '../capabilities/registry.js'
import type { RiskTier } from '../capabilities/registry.js'
import { matchesAnyOrigin } from './origin-match.js'
import type { Classification, ClassificationContext, ProposedCall } from './schema.js'

function tierRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier)
}

/** The higher-ranked of two tiers. Escalation only ever raises a tier, never lowers it, per FR-POL-8. */
function higherTier(a: RiskTier, b: RiskTier): RiskTier {
  return tierRank(b) > tierRank(a) ? b : a
}

/**
 * Whether `call` is a first contact with its own destination, i.e. absent
 * from `knownOrigins`. A call with no destination at all is never "unknown"
 * (there is no origin to have first-contacted), so a local capability like
 * `shell.exec` never matches `origin_unknown`.
 */
function isUnknownOrigin(call: ProposedCall, context: ClassificationContext): boolean {
  if (call.destination === undefined) return false
  return !context.knownOrigins.includes(call.destination)
}

/** Whether `call`'s destination fails to match any pattern in the policy's `origins.allow` list. A call with no destination is never "not allowlisted", for the same reason it is never "unknown". */
function isNotAllowlisted(call: ProposedCall, context: ClassificationContext): boolean {
  if (call.destination === undefined) return false
  const allowlist = context.policy.origins?.allow ?? []
  return !matchesAnyOrigin(call.destination, allowlist)
}

/**
 * Whether every field present in `when` matches `call`/`context`. Fields
 * combine with AND semantics; a field absent from `when` imposes no
 * constraint. `when.tier`, when present, always compares against `call`'s
 * OWN declared tier, never a tier already raised by an earlier rule in the
 * same policy, so which rules match never depends on rule order (see the
 * "order-independent" test in classify.test.ts).
 */
function conditionMatches(when: EscalationCondition, call: ProposedCall, context: ClassificationContext): boolean {
  if (when.tier !== undefined && when.tier !== call.declaredTier) return false
  if (when.amount_gt !== undefined && !(call.amountUsd !== undefined && call.amountUsd > when.amount_gt)) return false
  if (
    when.affected_count_gt !== undefined &&
    !(call.affectedCount !== undefined && call.affectedCount > when.affected_count_gt)
  ) {
    return false
  }
  if (
    when.recipient_count_gt !== undefined &&
    !(call.recipientCount !== undefined && call.recipientCount > when.recipient_count_gt)
  ) {
    return false
  }
  if (when.irreversible !== undefined && (call.irreversible ?? false) !== when.irreversible) return false
  if (when.credential_in_args !== undefined && (call.containsCredential ?? false) !== when.credential_in_args) {
    return false
  }
  if (when.origin_unknown !== undefined && isUnknownOrigin(call, context) !== when.origin_unknown) return false
  if (when.origin_not_allowlisted !== undefined && isNotAllowlisted(call, context) !== when.origin_not_allowlisted) {
    return false
  }
  return true
}

/**
 * A human-readable description of what made a rule fire, built only from
 * the rule's own policy-authored condition (thresholds, flags) and its
 * target tier, never from any of `call`'s field values. This is what keeps
 * `Classification.escalatedBy` safe to surface to a human under FR-SEC-1: a
 * threshold number an operator wrote into policy.yaml is not secret, but
 * the call's own arguments might be, so they never appear here.
 */
function describeRule(rule: EscalationRule): string {
  const { when, then } = rule
  const parts: string[] = []
  if (when.tier !== undefined) parts.push(`declared tier is ${when.tier}`)
  if (when.origin_unknown !== undefined) {
    parts.push(when.origin_unknown ? 'first contact with this destination' : 'destination contacted before')
  }
  if (when.origin_not_allowlisted !== undefined) {
    parts.push(when.origin_not_allowlisted ? 'destination is not on the origin allowlist' : 'destination is on the origin allowlist')
  }
  if (when.amount_gt !== undefined) parts.push(`amount exceeds ${when.amount_gt}`)
  if (when.affected_count_gt !== undefined) parts.push(`affected item count exceeds ${when.affected_count_gt}`)
  if (when.recipient_count_gt !== undefined) parts.push(`recipient count exceeds ${when.recipient_count_gt}`)
  if (when.irreversible !== undefined) parts.push(when.irreversible ? 'action is irreversible' : 'action is reversible')
  if (when.credential_in_args !== undefined) {
    parts.push(when.credential_in_args ? 'arguments contain a credential' : 'arguments contain no credential')
  }
  return `escalated to ${then} (${parts.join(', ')})`
}

export function classify(call: ProposedCall, context: ClassificationContext): Classification {
  let tier = call.declaredTier
  const escalatedBy: string[] = []
  for (const rule of context.policy.escalation_rules ?? []) {
    if (!conditionMatches(rule.when, call, context)) continue
    if (tierRank(rule.then) > tierRank(tier)) escalatedBy.push(describeRule(rule))
    tier = higherTier(tier, rule.then)
  }
  return { tier, escalatedBy }
}
