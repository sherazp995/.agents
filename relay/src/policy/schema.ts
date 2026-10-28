/**
 * The pure types `classify` and `decide` operate over, per the interface
 * table in docs/specs/2026-08-08-relay-requirements.md §18.3:
 * `PolicyEngine.classify(call, context)` and
 * `PolicyEngine.decide(classification, context)`.
 *
 * This file deliberately does NOT define a second policy-file zod schema.
 * The declarative policy format (origins, escalation_rules, capabilities)
 * lives in `src/config/schema.ts`'s `policySchema`, extended there rather
 * than duplicated here, because P0.1 already owns config validation and a
 * second, parallel policy schema is exactly the drift FR-POL-2's "single
 * validated source of truth" exists to prevent. This file only re-exports
 * `Policy` for convenience and adds the request/response shapes the pure
 * functions need, which are not part of the on-disk policy format at all.
 */

import type { Policy } from '../config/schema.js'
import type { RiskTier } from '../capabilities/registry.js'

export type { Policy } from '../config/schema.js'

export const DECISIONS = ['allow', 'deny', 'ask'] as const
export type Decision = (typeof DECISIONS)[number]

/**
 * A proposed capability call, reduced to the facts `classify` needs to
 * apply FR-POL-1 and FR-POL-8's escalation rules. Deliberately excludes the
 * call's raw arguments: `classify` only ever sees derived, non-secret
 * facts, a boolean, a count, a currency amount, never an argument value
 * itself, so there is no field here a credential could ever be quoted
 * through into a reason string, per FR-SEC-1. Deriving these facts from the
 * real arguments (extracting a hostname, scanning for a credential pattern
 * with `src/secrets/scrubber.ts`, counting affected items) is the caller's
 * job; today that is Task 3, the mediation seam.
 */
export interface ProposedCall {
  /** The capability's registered name, e.g. "shell.exec". */
  readonly capability: string
  /** The capability's own declared risk tier, from the registry (FR-CAP-1). classify only ever escalates above this; it never lowers it. */
  readonly declaredTier: RiskTier
  /** A bare hostname, e.g. "chase.com", not a full URL. Absent for a capability with no external destination (a local shell command, a filesystem write). */
  readonly destination?: string
  readonly amountUsd?: number
  readonly affectedCount?: number
  /** Distinct recipient count, for FR-POL-8's "recipient breadth" (a message to one address vs. a broadcast to a mailing list). */
  readonly recipientCount?: number
  /** Whether this specific call's effect cannot be undone, for FR-POL-8's "reversibility". Distinct from the capability's registered `idempotencyClass`: that describes whether repeating the SAME call is safe, this describes whether THIS call's effect can be undone by a human. */
  readonly irreversible?: boolean
  /** Whether the caller detected a credential in the call's arguments, per FR-POL-1. A boolean, never the credential itself. */
  readonly containsCredential?: boolean
}

/** Everything `classify` needs beyond the call itself. Supplied by the caller so `classify` stays pure: it never reads a database or a clock. */
export interface ClassificationContext {
  readonly policy: Policy
  /** Destinations this principal/session has successfully contacted before now, for FR-POL-1's "first time on this origin". Caller-supplied history, not looked up internally. */
  readonly knownOrigins: readonly string[]
}

export interface Classification {
  readonly tier: RiskTier
  /** Human-readable descriptions of the policy rules that raised the tier above `call.declaredTier`, in the order they fired. Built only from policy-authored condition text (thresholds, flags), never from the call's own field values, so this can never carry a credential either. Empty when no rule escalated the call. */
  readonly escalatedBy: readonly string[]
}

/** Everything `decide` needs beyond the classification. */
export interface DecisionContext {
  readonly policy: Policy
  readonly capability: string
  readonly destination?: string
  readonly principalId?: string
  readonly sessionId?: string
  readonly recipeId?: string
}

export interface PolicyDecision {
  readonly decision: Decision
  /** User-visible, per FR-POL-3. Never quotes a call argument value; see ProposedCall's own doc comment. */
  readonly reason: string
}
