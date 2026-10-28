/**
 * AP-1 made real: the one place a capability name and its call facts become
 * a governance verdict. Nothing downstream of mediate()/mediateCapabilityCall()
 * ever sees a raw, unmediated capability call; src/agent/loop.ts's dispatch
 * path is the sole production caller, and it is structured so there is no
 * path from "the engine named a capability" to "the capability ran" that
 * skips this file.
 *
 * TWO LAYERS, matching classify.ts/decide.ts's own pure/impure split:
 *
 *   - mediate() is synchronous and total: normalize the destination, then
 *     registry lookup, then classify(), then decide(), then a defence-in-
 *     depth denylist re-check. No I/O, no waiting. It is also where
 *     FR-POL-3's other half lives (see the comment on the registry check
 *     below): decide() alone defaults an unmatched policy-file capability
 *     to enabled, which means it cannot fail closed on a capability that is
 *     not even REGISTERED, since it never sees the registry at all. That
 *     refusal has to happen here, structurally before decide() is ever
 *     called, not as an extra branch inside decide() (which is not this
 *     task's file to touch, and, per Task 2's review, was a deliberate
 *     scope line: decide() answers "is this call allowed by policy", not
 *     "does this capability exist").
 *   - mediateCapabilityCall() is async: it wraps mediate() and, only for an
 *     'ask' verdict, calls the injected requestApproval and awaits it. This
 *     is the actual suspension point: the returned promise does not settle
 *     until the approval resolves, however long that takes. requestApproval
 *     is Task 4's to implement in production (the approvals store and Slack
 *     interaction); every test in this file uses a controllable test double
 *     instead, per this task's own instruction not to build a second one.
 *
 * HOSTNAME NORMALIZATION, added after Task 2's review found a gap: this
 * file's own destination handling is the one place origin-match.ts's own
 * docstring names as the owner of hostname normalization ("extracting the
 * hostname... is the caller's job (the mediation seam, Task 3)"). See
 * normalizeDestination below for exactly what it does and why each step is
 * there; the short version is that a destination is normalized exactly
 * once, before it is classified, decided over, or checked against any
 * origin list, and the SAME normalized string is what appears in every
 * reason and every approval request, so classify(), decide(), this file's
 * own denylist re-check, and whatever a human eventually reads all agree.
 */

import { domainToASCII } from 'node:url'
import { getCapability } from '../capabilities/registry.js'
import type { CapabilityDefinition, RiskTier } from '../capabilities/registry.js'
import { classify } from './classify.js'
import { decide } from './decide.js'
import { matchesAnyOrigin } from './origin-match.js'
import type { Policy } from '../config/schema.js'
import type { ClassificationContext, Decision, DecisionContext, ProposedCall } from './schema.js'

// ---------------------------------------------------------------------------
// Hostname normalization.
// ---------------------------------------------------------------------------

/**
 * Canonicalizes a destination hostname into the one form classify(),
 * decide(), this file's own denylist re-check, and any resulting approval
 * request all agree on. origin-match.ts's own matcher already holds against
 * prefix, suffix, embedded-dot, and case attacks (it lowercases, and a
 * bare-domain pattern never matches a substring or a subdomain); what it
 * deliberately does NOT do is normalize its input at all, per its own
 * docstring naming this file as the owner of that. Steps, in order, and why
 * each one is here:
 *
 *   1. Trim surrounding whitespace: a destination carrying leading or
 *      trailing whitespace should never silently fail to match a pattern
 *      that would otherwise be exact.
 *   2. Strip a userinfo prefix ("user:pass@host" -> "host"), splitting on
 *      the LAST "@": a password component is free to contain "@" itself,
 *      and the actual host is always what follows the final one.
 *   3. Strip an explicit port ("host:443" -> "host"), splitting on the
 *      FIRST ":". Does not attempt to handle a bracketed IPv6 literal's own
 *      embedded colons ("[::1]:443"); every capability this milestone ships
 *      supplies a plain DNS hostname, never an IPv6 literal, so that shape
 *      is passed through as-is rather than mishandled by a parser this file
 *      does not need yet.
 *   4. Strip exactly one trailing DNS root dot ("chase.com." -> "chase.com"),
 *      the specific gap Task 2's review found: a trailing root dot is a
 *      syntactically valid hostname that resolves identically to the bare
 *      one and does not match a denylist pattern without this step, a known
 *      blocklist-evasion technique.
 *   5. Convert to the ASCII/punycode form via Node's own domainToASCII, so
 *      a genuine IDN hostname and a Unicode homoglyph lookalike domain both
 *      collapse to the one representation policy.yaml's own ASCII patterns
 *      can actually be compared against. This STRENGTHENS the existing
 *      lookalike-domain defense rather than weakening it: a Cyrillic "с"
 *      standing in for a Latin "c" converts to a punycode string that does
 *      NOT match the real domain's pattern, so it correctly fails to match
 *      rather than being silently treated as equivalent.
 *   6. Lowercase. domainToASCII already returns a lowercase string; this is
 *      kept as an explicit, final step rather than relying on that being
 *      permanent across Node versions.
 *
 * `domainToASCII` returns `''` for input it cannot parse as a domain at
 * all; that is treated as "normalization could not improve on the
 * pre-conversion value" and the un-converted (but still trimmed,
 * de-userinfo'd, de-ported, de-dotted) value is kept, rather than silently
 * collapsing an unparseable destination to an empty string, which would
 * make it match every wildcard pattern or none unpredictably.
 */
export function normalizeDestination(destination: string): string {
  let host = destination.trim()

  const atIndex = host.lastIndexOf('@')
  if (atIndex !== -1) host = host.slice(atIndex + 1)

  const colonIndex = host.indexOf(':')
  if (colonIndex !== -1) host = host.slice(0, colonIndex)

  host = host.replace(/\.$/, '')

  const ascii = domainToASCII(host)
  if (ascii.length > 0) host = ascii

  return host.toLowerCase()
}

// ---------------------------------------------------------------------------
// mediate(): synchronous, registry lookup + classify + decide.
// ---------------------------------------------------------------------------

/**
 * Everything mediate() needs beyond the capability's own registered
 * definition. Deliberately has NO `declaredTier` field: the declared tier
 * comes only from the registry lookup below, never from the caller, so a
 * caller cannot claim a capability is lower-risk than it is registered as
 * in order to skip governance. Every fact here mirrors ProposedCall's own
 * doc comment on why it excludes raw arguments: `amountUsd`, `destination`,
 * and friends are derived, non-secret facts a real caller (loop.ts) is
 * responsible for computing; this file does not derive them itself.
 * `destination`, when present, is normalized by mediate() itself; the
 * caller may pass any of the raw forms normalizeDestination's own doc
 * comment describes.
 */
export type MediateParams = {
  readonly capability: string
  readonly policy: Policy
  readonly principalId?: string
  readonly sessionId?: string
  readonly recipeId?: string
  readonly destination?: string
  readonly knownOrigins?: readonly string[]
  readonly amountUsd?: number
  readonly affectedCount?: number
  readonly recipientCount?: number
  readonly irreversible?: boolean
  readonly containsCredential?: boolean
}

export type MediationOutcome =
  | { readonly decision: Extract<Decision, 'allow'>; readonly reason: string; readonly tier: RiskTier }
  | { readonly decision: Extract<Decision, 'ask'>; readonly reason: string; readonly tier: RiskTier }
  /** `tier` is absent only for the registry-refusal case below: there is no declared tier to report when the capability was never registered at all. */
  | { readonly decision: Extract<Decision, 'deny'>; readonly reason: string; readonly tier?: RiskTier }

/** Looks up a capability definition. Defaults to the process-wide registry; every call site in this file's own tests injects an isolated CapabilityRegistry instead, per that class's own doc comment on why (shared global state would let one test's registration leak into another's). */
export type CapabilityLookup = (name: string) => CapabilityDefinition | undefined

export function mediate(params: MediateParams, lookup: CapabilityLookup = getCapability): MediationOutcome {
  const definition = lookup(params.capability)
  // FR-POL-3's other half, per this file's header comment: refused here,
  // structurally before classify()/decide() are ever called, so neither
  // function's own defaulting behaviour (decide()'s "absent from
  // policy.capabilities means enabled") can ever apply to a capability that
  // was never registered in the first place.
  if (!definition) {
    return {
      decision: 'deny',
      reason:
        `capability "${params.capability}" is not registered in Relay's capability registry; ` +
        'an unregistered capability is refused before policy is even consulted (FR-POL-3)',
    }
  }

  // Normalized exactly once, here, before it reaches classify(), decide(),
  // or the defence-in-depth re-check below: every one of them, and any
  // resulting approval request, sees and reports this same string.
  const destination = params.destination !== undefined ? normalizeDestination(params.destination) : undefined

  const call: ProposedCall = {
    capability: params.capability,
    declaredTier: definition.riskTier,
    ...(destination !== undefined ? { destination } : {}),
    ...(params.amountUsd !== undefined ? { amountUsd: params.amountUsd } : {}),
    ...(params.affectedCount !== undefined ? { affectedCount: params.affectedCount } : {}),
    ...(params.recipientCount !== undefined ? { recipientCount: params.recipientCount } : {}),
    ...(params.irreversible !== undefined ? { irreversible: params.irreversible } : {}),
    ...(params.containsCredential !== undefined ? { containsCredential: params.containsCredential } : {}),
  }
  const classificationContext: ClassificationContext = {
    policy: params.policy,
    knownOrigins: params.knownOrigins ?? [],
  }
  const classification = classify(call, classificationContext)

  const decisionContext: DecisionContext = {
    policy: params.policy,
    capability: params.capability,
    ...(destination !== undefined ? { destination } : {}),
    ...(params.principalId !== undefined ? { principalId: params.principalId } : {}),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    ...(params.recipeId !== undefined ? { recipeId: params.recipeId } : {}),
  }
  const { decision, reason } = decide(classification, decisionContext)

  // DEFENCE IN DEPTH, per Task 2's review: decide() itself now checks both
  // destination lists ahead of FR-CAP-2's capability state (fix round 1,
  // I-1, after review found an approval_gated capability could turn a
  // denylisted destination's proper `deny` into an `ask`, letting a single
  // human approval reopen a question policy had already settled). This
  // seam is the LAST LINE before a human is even asked, let alone before a
  // capability runs, so it re-checks independently rather than trusting a
  // single implementation to never regress: an `ask` verdict for a
  // destination on either list is overridden to `deny` here, structurally,
  // regardless of what decide() itself computed. mediateCapabilityCall's
  // 'ask' branch (the one that actually calls requestApproval) is
  // therefore unreachable for a denylisted destination no matter how
  // decide() is implemented.
  if (
    decision === 'ask' &&
    destination !== undefined &&
    (matchesAnyOrigin(destination, params.policy.hard_blocked_origins) ||
      matchesAnyOrigin(destination, params.policy.origins?.deny ?? []))
  ) {
    return {
      decision: 'deny',
      reason: `${destination} is on a denylist; policy computed ask, but a denylisted destination is never eligible for approval (defence in depth)`,
      tier: classification.tier,
    }
  }

  return { decision, reason, tier: classification.tier } as MediationOutcome
}

// ---------------------------------------------------------------------------
// mediateCapabilityCall(): async, adds the approval seam for 'ask'.
// ---------------------------------------------------------------------------

/**
 * What a human (or a future automated policy, e.g. a standing grant) needs
 * to resolve an 'ask' verdict, per FR-APR-1's own field list ("capability,
 * human-readable description, exact target, tier, the escalation reason,
 * the run and session identity, and the requester"). `reason` comes from
 * decide(), which per its own and classify.ts's doc comments never quotes a
 * call argument value, only policy-authored condition text and a tier, so
 * this can never carry a credential either, per FR-SEC-1.
 */
export type ApprovalRequest = {
  readonly runId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly principalId: string
  readonly capability: string
  readonly tier: RiskTier
  readonly reason: string
  /** FR-APR-1: a human-readable description of what this specific call is about to do. See MediateCapabilityCallParams.description's own doc comment for how this is derived. */
  readonly description: string
  /** FR-APR-1: the exact target of this call, normalized the same way `destination` is. See MediateCapabilityCallParams.target's own doc comment for how this is derived. */
  readonly target: string
  /** The normalized hostname, when this call has one. Distinct from `target`: a capability with no external destination still has a target (itself), but no `destination`. */
  readonly destination?: string
}

/**
 * What resolving an approval produces. `approved` optionally carries a
 * replacement `input`, for FR-APR-1's "edit and approve" option: present
 * means the call proceeds with THIS input instead of the one originally
 * proposed; absent means proceed unchanged. Task 4's richer Slack UX
 * (approve-all-of-this-type-for-a-session) is built on top of this, not
 * inside it: "approve-all" still resolves THIS promise with
 * `{ outcome: 'approved' }` and separately records a standing grant future
 * `decide()` calls can read from policy.
 */
export type ApprovalDecision =
  | { readonly outcome: 'approved'; readonly input?: unknown }
  | { readonly outcome: 'denied'; readonly reason: string }

/**
 * The seam's one injected dependency, per this task's brief: narrow enough
 * that Task 4 (the approvals store and its Slack interaction) can implement
 * it without this file knowing anything about Slack, Postgres, or how long
 * a real approval takes to resolve.
 */
export type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalDecision>

export type MediateCapabilityCallParams = {
  readonly capability: string
  readonly policy: Policy
  readonly runId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly principalId: string
  readonly recipeId?: string
  readonly destination?: string
  /**
   * FR-APR-1: a human-readable description of this specific call, for the
   * approval card. Defaults to the capability's own registered
   * `description` (a description of the CAPABILITY in general) when the
   * caller supplies nothing more specific: no capability this milestone
   * ships can derive a genuinely per-call description on its own (echo's
   * `input` is opaque, unstructured `unknown`), so this default is
   * honestly generic, not a per-call summary, until a capability that can
   * do better exists. Say so plainly wherever this default is actually
   * used; do not let it read as a real per-call description.
   */
  readonly description?: string
  /** FR-APR-1: the exact target of this call, for the approval card. Defaults to the normalized `destination` when present, else the capability's own name (a local, non-networked capability's "target" is itself). */
  readonly target?: string
  readonly knownOrigins?: readonly string[]
  readonly amountUsd?: number
  readonly affectedCount?: number
  readonly recipientCount?: number
  readonly irreversible?: boolean
  readonly containsCredential?: boolean
  readonly requestApproval: RequestApproval
}

/**
 * The final, actionable verdict src/agent/loop.ts's dispatch path acts on:
 * either the call proceeds (allowed outright, or asked and then approved,
 * optionally with a replacement `input` per FR-APR-1's edit-and-approve),
 * or it is refused (denied outright, the registry refusal, or asked and
 * then denied) with a reason to record. Collapsing all three decision kinds
 * into two outcomes here, rather than leaking 'allow'/'deny'/'ask' up to
 * the loop, is deliberate: by the time this function resolves, 'ask' has
 * already been resolved one way or the other, so a caller acting on this
 * result never needs a third branch for "still waiting", only "did it end
 * up proceeding".
 */
export type MediationVerdict =
  | { readonly outcome: 'proceed'; readonly tier: RiskTier; readonly reason: string; readonly input?: unknown }
  | { readonly outcome: 'refuse'; readonly reason: string; readonly tier?: RiskTier }

export async function mediateCapabilityCall(
  params: MediateCapabilityCallParams,
  lookup: CapabilityLookup = getCapability,
): Promise<MediationVerdict> {
  const outcome = mediate(params, lookup)

  if (outcome.decision === 'allow') {
    return { outcome: 'proceed', tier: outcome.tier, reason: outcome.reason }
  }
  if (outcome.decision === 'deny') {
    return { outcome: 'refuse', reason: outcome.reason, ...(outcome.tier !== undefined ? { tier: outcome.tier } : {}) }
  }

  // 'ask': the actual suspension point. This await does not resolve until
  // requestApproval's own promise does, which is what makes "suspends the
  // run pending an approval rather than proceeding or failing" true: there
  // is no code path here that times out into an allow or a deny on its own,
  // only whatever requestApproval itself eventually resolves with. By this
  // point mediate()'s own defence-in-depth check has already ruled out a
  // denylisted destination ever reaching here as an 'ask'.
  const definition = lookup(params.capability)
  const destination = params.destination !== undefined ? normalizeDestination(params.destination) : undefined
  const request: ApprovalRequest = {
    runId: params.runId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    principalId: params.principalId,
    capability: params.capability,
    tier: outcome.tier,
    reason: outcome.reason,
    description: params.description ?? definition?.description ?? `invoke capability "${params.capability}"`,
    target: params.target ?? destination ?? params.capability,
    ...(destination !== undefined ? { destination } : {}),
  }
  const approval = await params.requestApproval(request)
  if (approval.outcome === 'approved') {
    return {
      outcome: 'proceed',
      tier: outcome.tier,
      reason: `approved: ${outcome.reason}`,
      ...(approval.input !== undefined ? { input: approval.input } : {}),
    }
  }
  return { outcome: 'refuse', reason: approval.reason, tier: outcome.tier }
}
