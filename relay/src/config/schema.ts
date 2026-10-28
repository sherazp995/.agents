import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { RISK_TIERS } from '../capabilities/registry.js'

/**
 * Accepts only a URL whose scheme is one of the given values. Rejects an
 * otherwise well-formed URL (an HTTPS one, for instance) that points at the
 * wrong kind of service, since `z.string().url()` alone accepts any scheme.
 */
function urlWithScheme(schemes: string[]): z.ZodEffects<z.ZodString, string, string> {
  const expected = new Set(schemes)
  return z.string().url().refine(
    (value) => {
      try {
        return expected.has(new URL(value).protocol)
      } catch {
        return false
      }
    },
    { message: `must be a URL with scheme ${schemes.join(' or ')}` },
  )
}

/** A non-empty, trimmed origin pattern: a bare domain ("chase.com") or a wildcard subdomain pattern ("*.chase.com"), per the requirements' §18.4 policy example. Shared by every origin list in the policy (hard-blocked, allow, deny) so all four accept and reject the same shapes. */
const originPattern = z.string().trim().min(1)

/**
 * FR-POL-1 and FR-POL-8's escalation conditions. Every field is optional and
 * a rule's fields combine with AND semantics (see src/policy/classify.ts);
 * `.refine` below rejects an empty `when` clause, since a rule that matches
 * unconditionally would silently escalate every single call, which is never
 * what a policy author means to write.
 *
 * `_gt` fields are strict greater-than, matching the "above threshold"
 * wording in FR-POL-1 and FR-POL-8: a call exactly at the threshold does not
 * escalate. `origin_unknown` (first contact with this origin) and
 * `origin_not_allowlisted` (origin is not on the configured allowlist) are
 * FR-POL-1's two separate destination triggers; they can differ, since an
 * origin can be on the allowlist yet never contacted before, or contacted
 * before yet never added to the allowlist.
 */
const escalationConditionSchema = z
  .object({
    // Restricts the rule to calls whose capability-declared tier is exactly
    // this, matching the requirements' own example (`{ origin_unknown:
    // true, tier: write }`). Always compared against the call's declared
    // tier, never a tier already escalated by an earlier rule in this same
    // list, so rule order never changes which rules match.
    tier: z.enum(RISK_TIERS).optional(),
    origin_unknown: z.boolean().optional(),
    origin_not_allowlisted: z.boolean().optional(),
    amount_gt: z.number().nonnegative().optional(),
    affected_count_gt: z.number().int().nonnegative().optional(),
    recipient_count_gt: z.number().int().nonnegative().optional(),
    irreversible: z.boolean().optional(),
    credential_in_args: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'escalation rule condition must specify at least one field',
  })

/** One escalation rule, per the requirements' §18.4 policy example (`when: {...} then: <tier>`). `then` only ever raises the tier; src/policy/classify.ts takes the maximum of the declared tier and every matching rule's `then`, so a rule can never lower a tier below what the capability itself declared. */
const escalationRuleSchema = z
  .object({
    when: escalationConditionSchema,
    then: z.enum(RISK_TIERS),
  })
  .strict()

/** FR-CAP-2's three states: enabled (default), disabled (capability refused outright), or approval_gated (always asks, regardless of tier). */
const capabilityStateSchema = z.enum(['enabled', 'disabled', 'approval_gated'])

/**
 * FR-CAP-2: a capability can be enabled, disabled, or approval-gated
 * globally, per principal, per session, and per recipe. `principals`,
 * `sessions`, and `recipes` are keyed by the relevant identifier (principal
 * id, session id, recipe name); src/policy/decide.ts resolves the effective
 * state with recipe > session > principal > global precedence, falling back
 * to `enabled` when a capability has no entry at all, since policy.yaml is
 * not expected to enumerate every registered capability.
 */
const capabilityScopeOverridesSchema = z
  .object({
    global: capabilityStateSchema.optional(),
    principals: z.record(z.string(), capabilityStateSchema).optional(),
    sessions: z.record(z.string(), capabilityStateSchema).optional(),
    recipes: z.record(z.string(), capabilityStateSchema).optional(),
  })
  .strict()

/**
 * FR-APR-4's tier-to-role mapping and FR-APR-5's typed-confirmation gate,
 * decided here in policy.yaml, the operator's one place for governance
 * decisions, rather than hard-coded in src/approvals/store.ts. That store
 * deliberately takes `requiredRoles` and `requiresTypedConfirmation` as
 * caller-supplied fields per approval precisely so this section can be the
 * caller (once a later task wires the two together; this schema does not
 * do that wiring itself).
 */
const approvalTierPolicySchema = z
  .object({
    // Non-empty for the same reason 0014_approvals_fix_round_1.sql's CHECK
    // constraint on approvals.required_roles exists: an empty array is
    // ambiguous between "nobody can resolve this" (a silent deadlock into
    // FR-APR-3's deny-and-pause timeout) and "anybody can" (FR-APR-4's gate
    // silently absent), and src/approvals/store.ts's hasRequiredRole and
    // createApproval both already resolve that ambiguity toward "nobody,"
    // fail-closed. A policy author who wants "no one may approve this tier"
    // expresses it by omitting the tier from approvalPolicySchema below
    // entirely, not by writing an empty list here.
    required_roles: z.array(z.string().trim().min(1)).min(1),
    // FR-APR-5: whether resolving 'approve' at this tier requires typing
    // the fixed confirmation word rather than a single click. Configurable
    // per tier, not hard-coded to 'irreversible': that is the natural
    // default an operator would choose, not a rule this schema enforces.
    // Defaults to false, so a tier that only configures required_roles
    // does not silently gain typed confirmation as a side effect. Cast for
    // the same reason `logging.level` and `secrets.provider` already are
    // above: `loadValidated<T>` (src/config/load.ts) needs `z.ZodType<T>`,
    // whose single-type-parameter form treats a schema's input and output
    // as one type, and a `.default()` field otherwise leaves the input
    // side optional while the parsed output is required.
    requires_typed_confirmation: z.boolean().default(false),
  })
  .strict() as z.ZodType<{ required_roles: string[]; requires_typed_confirmation: boolean }>

/**
 * Keyed by risk tier via `z.record`, not a fixed four-key object, so this
 * can never drift out of sync with RISK_TIERS if that enum ever changes.
 * Deliberately SPARSE: every tier is optional, and a tier this policy
 * never mentions has NO configured approvers, which must mean nobody may
 * resolve an approval at that tier, per FR-POL-3's ask-never-allow default
 * applied one level down to FR-APR-4. This is the exact same failure mode
 * `approvalTierPolicySchema`'s non-empty `required_roles` already guards
 * against, and it resolves the same way: whatever reads this map (a later
 * wiring task, not this schema or src/approvals/store.ts) must treat a
 * missing tier exactly like an empty required_roles list, which
 * createApproval already refuses outright and hasRequiredRole already
 * treats as satisfiable by nobody. A `read` tier action never actually
 * reaches an approval at all (src/policy/decide.ts's own switch always
 * allows it), so omitting `read` here is the ordinary case, not an
 * oversight to flag.
 */
const approvalPolicySchema = z.record(z.enum(RISK_TIERS), approvalTierPolicySchema)

/**
 * Policy shape. Two rules are enforced here rather than at call sites,
 * because a permissive policy that merely fails later is the exact failure
 * mode FR-POL-2 forbids. `.strict()` at every level rejects an unknown field
 * by name instead of silently discarding it, so a misspelled safety setting
 * fails loudly rather than looking valid while being ignored.
 */
function hasPassword(value: string): boolean {
  try {
    const url = new URL(value)
    return url.password !== '' || (url.searchParams.get('password') ?? '') !== ''
  } catch {
    return false
  }
}

export const policySchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        // FR-POL-3: anything unmatched is asked, never allowed.
        unmatched: z.literal('ask'),
      })
      .strict(),
    // FR-SET-7: setup cannot complete with an empty hard-blocked list. Each
    // entry is trimmed before the length check, so a whitespace-only entry
    // such as "   " is rejected rather than counted as a real origin.
    hard_blocked_origins: z.array(originPattern).min(1),
    /**
     * FR-POL-7's spend caps, in dollars. Optional as a whole: a policy file
     * with no `budget` section means no metering, matching how every
     * milestone before this one behaved. Present means all three scopes are
     * enforced, since a partially configured budget invites the reading
     * that an unset scope is unlimited, which is the wrong default for a
     * governance control.
     */
    budget: z
      .object({
        run_cap_usd: z.number().positive(),
        session_cap_usd: z.number().positive(),
        principal_day_cap_usd: z.number().positive(),
      })
      .strict()
      .optional(),
    // FR-POL-4's separate, runtime-overridable destination controls: an
    // allowlist and a denylist, distinct from hard_blocked_origins above,
    // which no config short of an edit-plus-restart can change. Both
    // optional: a fresh policy need not declare either.
    origins: z
      .object({
        allow: z.array(originPattern),
        deny: z.array(originPattern),
      })
      .strict()
      .optional(),
    // FR-POL-1 / FR-POL-8: declarative escalation rules. Optional; a policy
    // with none simply never escalates a call above its capability-declared
    // tier through this mechanism (src/policy/decide.ts's own tier-default
    // handling, e.g. asking for a write outside the allowlist, still
    // applies regardless of whether any rule here is configured).
    // FR-SH-2's path scoping. Absent means the built-in default only, which
    // is a workspace directory inside the Relay home. Deliberately NOT a way
    // to express "everywhere": each root is a directory named on purpose,
    // and the acceptance criterion the whole capability is built around is
    // that reading ~/.ssh/id_rsa is refused by default.
    filesystem: z
      .object({
        roots: z.array(z.string().trim().min(1)),
      })
      .strict()
      .optional(),
    escalation_rules: z.array(escalationRuleSchema).optional(),
    // FR-CAP-2: per-capability enable/disable/approval-gate overrides,
    // keyed by capability name. Optional and sparse: a capability absent
    // from this map is enabled by default.
    capabilities: z.record(z.string(), capabilityScopeOverridesSchema).optional(),
    // FR-APR-4 / FR-APR-5: which roles may resolve an approval at each
    // tier, and which tiers require typed confirmation. Optional at the
    // top level too: a policy that configures no approvals section at all
    // means every tier is unconfigured, which per approvalPolicySchema's
    // own comment means no principal may resolve an approval at any tier,
    // the same fail-closed default as an entirely missing tier entry.
    approvals: approvalPolicySchema.optional(),
    // Autonomous tasks: what a worker may do remotely without a per-operation
    // approval. MCP tools listed here are forwarded by the gateway; servers in
    // proxy_enforced_mcp_servers are forwarded because the egress proxy only
    // lets them read remote hosts; every other MCP call becomes an operation
    // the requester approves. allowed_api_paths limits `api_write` requests.
    remote_writes: z
      .object({
        read_only_mcp_tools: z.array(z.string().trim().min(1)).default([]),
        proxy_enforced_mcp_servers: z.array(z.string().trim().min(1)).default([]),
        allowed_api_paths: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .optional(),
  })
  .strict()

export type Policy = z.infer<typeof policySchema>
export type EscalationRule = z.infer<typeof escalationRuleSchema>
export type EscalationCondition = z.infer<typeof escalationConditionSchema>
export type CapabilityState = z.infer<typeof capabilityStateSchema>
export type CapabilityScopeOverrides = z.infer<typeof capabilityScopeOverridesSchema>
export type ApprovalTierPolicy = z.infer<typeof approvalTierPolicySchema>
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>

export const relayConfigSchema = z
  .object({
    model_provider: z
      .object({
        name: z.enum(['anthropic']),
        // FR-DATA-6: retention must be asserted, not assumed.
        zero_data_retention: z.literal(true),
      })
      .strict(),
    database: z
      .object({
        url: urlWithScheme(['postgres:', 'postgresql:', 'keystore:']),
        // Operator CLI commands (principals, kill, live, doctor) connect with
        // this instead of reading database.url's keystore item, which only the
        // daemon's helper may read. For a server that does not ask local
        // connections for a password; holding one here is refused.
        operator_url: urlWithScheme(['postgres:', 'postgresql:'])
          .refine((value) => !hasPassword(value), { message: 'operator_url must not hold a password; leave it unset where the server needs one' })
          .optional(),
      })
      .strict(),
    redis: z.object({ url: urlWithScheme(['redis:', 'rediss:']) }).strict(),
    logging: z
      .object({
        level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
        // FR-OBS-1: wires the daemon to the rotation module src/obs/rotation.ts
        // already implements. Optional as a whole, so an operator who wants
        // today's stdout logging keeps it by leaving this unset entirely;
        // absent means exactly today's behaviour, not a degraded version of
        // file logging.
        file: z.string().trim().min(1).optional(),
        // Both already default inside src/obs/rotation.ts (20 MiB / 5 files)
        // when omitted, so they stay optional here too rather than this
        // schema duplicating defaults that module already owns.
        max_size_bytes: z.number().int().positive().optional(),
        max_files: z.number().int().positive().optional(),
      })
      .strict(),
    // FR-SEC-2: which secret source to broker Slack tokens through. Only the
    // provider name lives here; no secret value is ever a config field.
    // Both accepted values are OS KEYSTORES: 'keychain' on macOS,
    // 'libsecret' (the freedesktop Secret Service, via secret-tool) on
    // Linux. FR-SLA-6 requires Slack tokens live in a keystore and never in
    // an environment dump, so an environment-sourced provider must never be
    // reachable through runtime configuration. Adding Linux support by
    // allowing 'env' here would have traded that security property for a
    // platform; adding a second keystore keeps the property and adds the
    // platform. EnvSecretProvider still
    // exists (src/secrets/env.ts) for tests to construct directly or for a
    // caller to inject explicitly; it is just no longer something a config
    // file can ask for. Cast for the same reason as `logging` above:
    // `loadValidated<T>` needs `z.ZodType<T>`, whose single-type-parameter
    // form treats this field's input and output as the same type, and a
    // `.default()` field otherwise leaves the input side optional while the
    // parsed output is required.
    // Autonomous tasks (src/autonomous): a mention starts a task relay works
    // through by itself after plan approval. Off unless enabled, and refused
    // at startup without a policy `budget` section (assertAutonomousBudget).
    autonomous: z
      .object({
        enabled: z.boolean(),
        // Reserved per worker or QA invocation before it starts; also the
        // charge when an invocation's real usage is unknown.
        per_turn_fallback_usd: z.number().positive(),
        // Codex reports tokens, not dollars; cost is estimated at this rate.
        codex_usd_per_mtok: z.number().positive(),
        // Fixed charge for general-review's nested Codex lens in review and
        // visual QA invocations, whose real usage relay cannot see (user decision 11).
        review_codex_allowance_usd: z.number().nonnegative(),
        // launchd has no shell aliases or PATH, so the CLIs are named here.
        claude_bin: z.string().trim().min(1).default(join(homedir(), '.local/bin/claude')),
        codex_bin: z.string().trim().min(1).default('/opt/homebrew/bin/codex'),
        turn_wall_clock_ms: z.number().int().positive().default(60 * 60 * 1000),
        approval_timeout_ms: z.number().int().positive().default(24 * 60 * 60 * 1000),
      })
      .strict()
      .optional(),
    secrets: z
      .object({ provider: z.enum(['keychain', 'libsecret']).default('keychain') })
      .strict() as z.ZodType<{
      provider: 'keychain' | 'libsecret'
    }>,
  })
  .strict()

export type RelayConfig = z.infer<typeof relayConfigSchema>
