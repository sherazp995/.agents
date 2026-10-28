/**
 * Persists approvals and their audit trail against the `approvals`,
 * `approval_events`, and `session_approval_grants` tables
 * (0012_approvals.sql). This is the human in the loop: when policy says
 * `ask`, something (the future policy seam, per Task 3's interface, not
 * wired here) calls createApproval and waits; a human resolves it, in this
 * milestone via src/chat/slack/adapter.ts's Block Kit interaction handler,
 * which calls resolveApproval.
 *
 * FR-APR-3 is this module's central correctness property: a timed out
 * approval defaults to deny-and-pause, never proceed. resolveApproval
 * checks the deadline BEFORE authorization and BEFORE applying any option,
 * so a click that arrives after the deadline can never reach the branch
 * that approves anything, no matter which option it names. See
 * test/approvals/store.test.ts's self-attack test for the proof that
 * removing this check is what a passing test suite would look like if this
 * guarantee did not hold.
 */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { RiskTier } from '../capabilities/registry.js'
import { getCapability } from '../capabilities/registry.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { signApprovalReceipt } from './receipt.js'

export const APPROVAL_OPTIONS = ['approve', 'deny', 'approve_all_session', 'edit_and_approve'] as const
export type ApprovalOption = (typeof APPROVAL_OPTIONS)[number]

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'timed_out'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/**
 * FR-APR-5's "operator types a specified token": a fixed word, not a
 * per-approval secret. The friction FR-APR-5 asks for is a deliberate,
 * conscious act distinct from a single tap, not secrecy; nothing about
 * this value needs to be unguessable, so it is shared across every
 * approval that requires it, matching how a person, not a system, decides
 * whether to type it.
 */
export const CONFIRMATION_TOKEN = 'CONFIRM'

/**
 * `standard` is every governed approval. `plan` and `remote_write` belong to
 * autonomous tasks: approve or deny only, never a session grant or an edit,
 * because each one names one exact plan version or one exact operation.
 */
export const APPROVAL_KINDS = ['standard', 'plan', 'remote_write'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

const SINGLE_DECISION_OPTIONS: readonly ApprovalOption[] = ['approve', 'deny']

/** FR-SES-3's default TTL for an "approve all of this type for this session" grant. */
export const DEFAULT_SESSION_GRANT_TTL_MS = 60 * 60 * 1000

export type Approval = {
  id: string
  workspaceId: string
  runId: string
  sessionId: string
  requesterPrincipalId: string
  capability: string
  description: string
  target: string
  tier: RiskTier
  escalationReason: string
  /** FR-APR-4: which roles may resolve this approval. Supplied by the caller at creation time; see this module's header comment on why the tier-to-role mapping is not derived in here. */
  requiredRoles: readonly string[]
  requiresTypedConfirmation: boolean
  status: ApprovalStatus
  selectedOption: ApprovalOption | null
  resolvedByPrincipalId: string | null
  resolvedAt: string | null
  /**
   * FR-APR-2's "edit and approve," per fix round 1: the operator's edited
   * input, already validated against this approval's own capability's
   * `inputSchema` (src/capabilities/registry.ts) by the time this is ever
   * non-null. Never a raw, unvalidated string, and never a silent fallback
   * to the original arguments: resolveApproval refuses the resolution
   * outright (outcome `invalid_input`) rather than storing or returning
   * anything when validation fails. `unknown`, not a specific shape,
   * because different capabilities declare different schemas.
   */
  editedArguments: unknown | null
  timeoutAt: string
  createdAt: string
  updatedAt: string
  kind: ApprovalKind
  /** When set, replaces the role check: only these principals, or an operator, may resolve. */
  allowedPrincipalIds: readonly string[] | null
  /** The autonomous operation a `remote_write` approval names. */
  operationId: string | null
  /** HMAC over the decision, written by resolveApproval when given a key (src/approvals/receipt.ts). */
  receipt: string | null
}

export type CreateApprovalParams = {
  workspaceId: string
  runId: string
  sessionId: string
  requesterPrincipalId: string
  capability: string
  description: string
  target: string
  tier: RiskTier
  escalationReason: string
  requiredRoles: readonly string[]
  requiresTypedConfirmation?: boolean
  timeoutMs: number
  now?: Date
  kind?: ApprovalKind
  allowedPrincipalIds?: readonly string[]
  operationId?: string
}

/**
 * Every outcome resolveApproval can settle on. Only `resolved` changes the
 * approval's terminal state to `approved`/`denied`; every other outcome
 * either leaves a pending approval exactly as it was (`unauthorized`,
 * `confirmation_required`, `confirmation_mismatch`), reports a state that
 * was already terminal (`already_resolved`, `expired`), or reports that no
 * such approval exists at all (`not_found`).
 */
export const RESOLVE_OUTCOMES = [
  'resolved',
  'not_found',
  'already_resolved',
  'expired',
  'unauthorized',
  'confirmation_required',
  'confirmation_mismatch',
  'invalid_input',
  'option_not_allowed',
] as const
export type ResolveOutcome = (typeof RESOLVE_OUTCOMES)[number]

export type ResolveApprovalParams = {
  workspaceId: string
  approvalId: string
  option: ApprovalOption
  /**
   * `null` when the resolving Slack user has no mapped Relay principal at
   * all (src/tenancy/principals.ts's resolvePrincipal contract), per fix
   * round 1: an earlier version required a non-null string here, which
   * forced a caller to invent a sentinel id for an unmapped user, and that
   * sentinel then violated approval_events' own foreign key the moment it
   * tried to audit the rejection. `null` is the honest signal instead;
   * resolveApproval below never needs a real principal row to know a null
   * resolver cannot be authorized.
   */
  resolverPrincipalId: string | null
  /** Required, and checked, only when the approval's requiresTypedConfirmation is true and option is 'approve'. */
  typedConfirmation?: string
  /**
   * Raw JSON text collected from the operator for option 'edit_and_approve'
   * (a Slack modal's plain_text_input has no structured type of its own).
   * Parsed and validated against this approval's capability's own
   * `inputSchema` before it is ever stored or returned; malformed JSON or a
   * value that fails validation resolves to outcome `invalid_input` rather
   * than silently falling back to the original arguments, per fix round 1.
   */
  editedArguments?: string
  sessionGrantTtlMs?: number
  now?: Date
  /** The daemon's receipt key. When given, a resolved approval stores a receipt over its decision. */
  receiptKey?: Uint8Array
}

export type ResolveApprovalResult = {
  outcome: ResolveOutcome
  /** Null only for 'not_found'; every other outcome carries the approval row as it stood after this call, whether or not this call changed it. */
  approval: Approval | null
}

export type ApprovalEventAction = 'created' | 'resolve_attempt' | 'expired'

export type ApprovalEvent = {
  id: string
  workspaceId: string
  approvalId: string
  actorPrincipalId: string | null
  action: ApprovalEventAction
  option: ApprovalOption | null
  outcome: string
  occurredAt: string
}

export type SessionApprovalGrant = {
  id: string
  workspaceId: string
  sessionId: string
  capability: string
  sourceApprovalId: string
  grantedByPrincipalId: string
  grantedAt: string
  expiresAt: string
}

type ApprovalRow = {
  id: string
  workspace_id: string
  run_id: string
  session_id: string
  requester_principal_id: string
  capability: string
  description: string
  target: string
  tier: RiskTier
  escalation_reason: string
  required_roles: string[]
  requires_typed_confirmation: boolean
  status: ApprovalStatus
  selected_option: ApprovalOption | null
  resolved_by_principal_id: string | null
  resolved_at: Date | null
  // jsonb, not text: pg already parses this into a real JS value on read,
  // no JSON.parse needed here. See Approval.editedArguments's own comment.
  edited_arguments: unknown | null
  timeout_at: Date
  created_at: Date
  updated_at: Date
  kind: ApprovalKind
  allowed_principal_ids: string[] | null
  operation_id: string | null
  receipt: string | null
}

type ApprovalEventRow = {
  id: string
  workspace_id: string
  approval_id: string
  actor_principal_id: string | null
  action: ApprovalEventAction
  option: ApprovalOption | null
  outcome: string
  occurred_at: Date
}

type SessionApprovalGrantRow = {
  id: string
  workspace_id: string
  session_id: string
  capability: string
  source_approval_id: string
  granted_by_principal_id: string
  granted_at: Date
  expires_at: Date
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    sessionId: row.session_id,
    requesterPrincipalId: row.requester_principal_id,
    capability: row.capability,
    description: row.description,
    target: row.target,
    tier: row.tier,
    escalationReason: row.escalation_reason,
    requiredRoles: row.required_roles,
    requiresTypedConfirmation: row.requires_typed_confirmation,
    status: row.status,
    selectedOption: row.selected_option,
    resolvedByPrincipalId: row.resolved_by_principal_id,
    resolvedAt: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    editedArguments: row.edited_arguments,
    timeoutAt: row.timeout_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    kind: row.kind,
    allowedPrincipalIds: row.allowed_principal_ids,
    operationId: row.operation_id,
    receipt: row.receipt,
  }
}

function toApprovalEvent(row: ApprovalEventRow): ApprovalEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    approvalId: row.approval_id,
    actorPrincipalId: row.actor_principal_id,
    action: row.action,
    option: row.option,
    outcome: row.outcome,
    occurredAt: row.occurred_at.toISOString(),
  }
}

function toSessionApprovalGrant(row: SessionApprovalGrantRow): SessionApprovalGrant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    capability: row.capability,
    sourceApprovalId: row.source_approval_id,
    grantedByPrincipalId: row.granted_by_principal_id,
    grantedAt: row.granted_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }
}

/** Checks out a client for the duration of `fn`, always releasing it, matching src/runs/store.ts's identical helper. */
async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

/**
 * Records one audit row. Called from inside the same transaction as the
 * write it documents (creation, a resolve attempt of any outcome, or a
 * system-driven expiry), so a crash between the two is impossible: either
 * both commit or neither does. `actorPrincipalId` is null only for a
 * system-driven expiry (see expireApproval), never for a human's attempt,
 * authorized or not.
 */
async function recordEvent(
  client: PoolClient,
  params: {
    workspaceId: string
    approvalId: string
    actorPrincipalId: string | null
    action: ApprovalEventAction
    option: ApprovalOption | null
    outcome: string
  },
): Promise<void> {
  await client.query(
    `INSERT INTO approval_events (workspace_id, approval_id, actor_principal_id, action, option, outcome)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [params.workspaceId, params.approvalId, params.actorPrincipalId, params.action, params.option, params.outcome],
  )
}

/**
 * Serialises `value` to a JSON string and runs it through `scrubSecrets`
 * before it is ever written to a `jsonb` column, mirroring
 * src/runs/store.ts's identical `serializeAndScrub` for `steps.input` and
 * `steps.output`. Returns `null`, not the string `"null"`, for a value
 * `JSON.stringify` cannot represent, so a caller can pass the result
 * straight to a `jsonb` column parameter without a second null check.
 */
function serializeAndScrub(value: unknown): string | null {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return null
  return scrubSecrets(serialized)
}

/**
 * Validates an edit-and-approve submission's raw text against
 * `capabilityName`'s own registered `inputSchema`
 * (src/capabilities/registry.ts), per fix round 1: FR-APR-2's edited
 * arguments must be proven to satisfy the capability's own schema before
 * they can ever be substituted for the original call, never merely
 * accepted as free text. Three distinct ways to fail, all collapsed into
 * the same `{ ok: false }`, since resolveApproval's own `invalid_input`
 * outcome does not distinguish which one occurred (see the module's
 * header comment on why: an operator debugging a rejected edit can already
 * see their own input again from the modal, which is diagnosis enough
 * without leaking a raw zod issue list into the audit trail):
 *
 *   - the approval's own `capability` is not a name any registered
 *     capability holds (a configuration gap, not something the operator's
 *     input can fix);
 *   - `rawInput` is not valid JSON at all (a Slack `plain_text_input` has
 *     no structural type of its own, so this is a normal, expected shape
 *     of operator mistake, not a bug);
 *   - `rawInput` parses but does not satisfy the capability's own zod
 *     `inputSchema`.
 */
function validateEditedInput(
  capabilityName: string,
  rawInput: string | undefined,
): { ok: true; value: unknown } | { ok: false } {
  const capability = getCapability(capabilityName)
  if (!capability) return { ok: false }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawInput ?? '')
  } catch {
    return { ok: false }
  }

  const validation = capability.inputSchema.safeParse(parsed)
  if (!validation.success) return { ok: false }
  return { ok: true, value: validation.data }
}

/**
 * Creates a pending approval, per FR-APR-1's exact field list. `description`,
 * `target`, and `escalationReason` are run through scrubSecrets before ever
 * reaching a column, per FR-SEC-1: the approval card renders `target`
 * verbatim (src/approvals/blockkit.ts), which is exactly where a credential
 * quoted into a call's arguments would otherwise leak to a chat surface.
 * This mirrors src/runs/store.ts's identical treatment of `steps.input`.
 *
 * The id is generated here, in application code, rather than left to the
 * column's own DEFAULT gen_random_uuid(): CONFIRMATION_TOKEN is a fixed
 * shared word, not derived from the id, so nothing about creation actually
 * needs the id before the INSERT the way, for example, OutboundDispatcher's
 * dispatch id does; it is generated up front purely so this function and its
 * audit event agree on one id without a second round trip.
 */
export async function createApproval(pool: Pool, params: CreateApprovalParams): Promise<Approval> {
  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN')
      const approval = await createApprovalInTransaction(client, params)
      await client.query('COMMIT')
      return approval
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        // The connection may already be broken; discard the secondary error
        // so the caller sees the original failure, matching the pattern
        // src/runs/store.ts already uses.
      })
      throw error
    }
  })
}

/**
 * createApproval's body on a caller's open transaction, so an approval and
 * whatever announces it (an outbox row with its card) commit together.
 */
export async function createApprovalInTransaction(client: PoolClient, params: CreateApprovalParams): Promise<Approval> {
  // Fix round 1: fails loudly and immediately, before any I/O, rather than
  // letting an empty array reach 0012_approvals.sql's CHECK constraint and
  // surface as an opaque Postgres constraint-violation error. `RiskTier`
  // and `ApprovalOption` are narrow enough that TypeScript itself rules out
  // an invalid value; `requiredRoles: string[]` has no equivalent
  // compile-time floor against emptiness, so this is the one field in
  // CreateApprovalParams that earns a real runtime guard.
  if (params.requiredRoles.length === 0) {
    throw new Error(
      'createApproval: requiredRoles must name at least one role. An empty list is ambiguous between ' +
        '"nobody can resolve this" and "anybody can," per FR-APR-4, and 0012_approvals.sql refuses to store one.',
    )
  }

  const id = randomUUID()
  const now = params.now ?? new Date()
  const timeoutAt = new Date(now.getTime() + params.timeoutMs)

  const { rows } = await client.query<ApprovalRow>(
    `INSERT INTO approvals (
       id, workspace_id, run_id, session_id, requester_principal_id, capability,
       description, target, tier, escalation_reason, required_roles,
       requires_typed_confirmation, timeout_at, kind, allowed_principal_ids, operation_id
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      id,
      params.workspaceId,
      params.runId,
      params.sessionId,
      params.requesterPrincipalId,
      params.capability,
      scrubSecrets(params.description),
      scrubSecrets(params.target),
      params.tier,
      scrubSecrets(params.escalationReason),
      params.requiredRoles,
      params.requiresTypedConfirmation ?? false,
      timeoutAt,
      params.kind ?? 'standard',
      params.allowedPrincipalIds ?? null,
      params.operationId ?? null,
    ],
  )
  const row = rows[0]
  if (!row) throw new Error('createApproval: INSERT ... RETURNING * returned no row')
  await recordEvent(client, {
    workspaceId: row.workspace_id,
    approvalId: row.id,
    actorPrincipalId: params.requesterPrincipalId,
    action: 'created',
    option: null,
    outcome: 'pending',
  })
  return toApproval(row)
}

/** Scoped by workspace, per AP-8: a caller in workspace A can never read an approval that belongs to workspace B, even by guessing its id. Returns null rather than throwing for "not found," matching src/sessions/store.ts's findActiveSession. */
export async function getApproval(pool: Pool, workspaceId: string, approvalId: string): Promise<Approval | null> {
  const { rows } = await pool.query<ApprovalRow>(
    'SELECT * FROM approvals WHERE id = $1 AND workspace_id = $2',
    [approvalId, workspaceId],
  )
  const row = rows[0]
  return row ? toApproval(row) : null
}

/** Every audit event for `approvalId`, oldest first, per FR-APR-2's "audited with actor, timestamp, and chosen option." */
export async function listApprovalEvents(pool: Pool, workspaceId: string, approvalId: string): Promise<ApprovalEvent[]> {
  const { rows } = await pool.query<ApprovalEventRow>(
    'SELECT * FROM approval_events WHERE workspace_id = $1 AND approval_id = $2 ORDER BY occurred_at, id',
    [workspaceId, approvalId],
  )
  return rows.map(toApprovalEvent)
}

/**
 * Whether `roles` intersects `requiredRoles`, fail-closed on an empty
 * `requiredRoles`. Fix round 1: `requiredRoles.some(...)` over an empty
 * array is `false` on its own, with no special case needed, and that is
 * the direction this function commits to explicitly rather than by
 * accident, matching 0012_approvals.sql's CHECK constraint that
 * `required_roles` can never actually be empty in a stored row. If that
 * constraint were ever relaxed, "nobody can resolve this" is the safer
 * failure mode than "anybody can," so this function does not special-case
 * the empty array back toward "no restriction" the way an earlier version
 * did.
 */
export function hasRequiredRole(roles: readonly string[], requiredRoles: readonly string[]): boolean {
  return requiredRoles.some((role) => roles.includes(role))
}

/** An approval naming its allowed principals replaces the role check with "in the list, or an operator"; otherwise the role check applies. */
function isAuthorizedResolver(current: ApprovalRow, resolverPrincipalId: string | null, resolverRoles: readonly string[]): boolean {
  if (current.allowed_principal_ids === null) return hasRequiredRole(resolverRoles, current.required_roles)
  if (resolverPrincipalId === null) return false
  return current.allowed_principal_ids.includes(resolverPrincipalId) || resolverRoles.includes('operator')
}

/** The digest a receipt binds to: the operation's payload digest, or empty for an approval with no operation. */
export async function operationDigest(client: Pool | PoolClient, operationId: string | null): Promise<string> {
  if (operationId === null) return ''
  const { rows } = await client.query<{ payload_digest: string }>(
    'SELECT payload_digest FROM autonomous_operations WHERE id = $1',
    [operationId],
  )
  const digest = rows[0]?.payload_digest
  // Never sign or verify over an empty digest for an operation that should exist.
  if (digest === undefined) throw new Error(`approval names operation ${operationId}, which does not exist`)
  return digest
}

/**
 * Resolves an approval inside one transaction, row-locked with `SELECT ...
 * FOR UPDATE` before anything is read or decided, matching
 * src/runs/store.ts's applyRunTransition: two callers racing to resolve
 * the SAME approval must not both see it as pending, so the second one to
 * acquire the lock always observes the first one's already-committed write
 * and returns 'already_resolved' rather than double-applying an option.
 * Proven directly in test/approvals/store.test.ts's concurrency tests, both
 * for two callers racing the same approval and for three callers each
 * resolving their own independent approval concurrently.
 *
 * Check order, and why it is fixed rather than data-driven: not-found, then
 * already-terminal, then the FR-APR-3 deadline, then FR-APR-4 authorization,
 * then FR-APR-5 typed confirmation, then the option itself is applied. The
 * deadline check runs strictly before authorization and before the typed
 * confirmation check, and neither of those can ever run for an approval this
 * call is about to mark timed out: an authorized, correctly-confirmed
 * resolution that arrives one millisecond past the deadline still returns
 * 'expired', never 'resolved'. That ordering is what makes FR-APR-3's
 * deny-and-pause default structurally true rather than merely tested; see
 * this module's header comment and the self-attack test that inverts this
 * order to prove it is load-bearing.
 */
export async function resolveApproval(pool: Pool, params: ResolveApprovalParams): Promise<ResolveApprovalResult> {
  const now = params.now ?? new Date()

  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN')

      const { rows } = await client.query<ApprovalRow>(
        'SELECT * FROM approvals WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
        [params.approvalId, params.workspaceId],
      )
      const current = rows[0]
      if (!current) {
        await client.query('COMMIT')
        return { outcome: 'not_found' as const, approval: null }
      }

      // Looked up once, fresh, inside the same locked transaction, rather
      // than trusted from a caller-supplied claim, so a role granted or
      // revoked between request and click is always read as of the moment
      // of resolution. `params.resolverPrincipalId` can be null (an
      // unmapped Slack user, per ResolveApprovalParams's own doc comment);
      // the query below simply matches no row in that case, same as any
      // other id that does not exist, so no special case is needed.
      //
      // `actorId` is fix round 1's fix for a real bug: recordEvent's
      // `actor_principal_id` foreign-keys to `principals`, so writing
      // `params.resolverPrincipalId` UNCONDITIONALLY into every audit event
      // meant an unmapped or fabricated resolver id made the AUDIT WRITE
      // ITSELF fail with a foreign key violation, on the very call meant to
      // record that the attempt was rejected. `actorId` is null whenever no
      // real principal row was found, so every recordEvent call below stays
      // truthful (never claims to attribute an action to a principal that
      // does not exist) and never trips that constraint.
      const { rows: principalRows } = await client.query<{ roles: string[] }>(
        'SELECT roles FROM principals WHERE id = $1 AND workspace_id = $2',
        [params.resolverPrincipalId, params.workspaceId],
      )
      const principalExists = principalRows.length > 0
      const resolverRoles = principalRows[0]?.roles ?? []
      const actorId = principalExists ? params.resolverPrincipalId : null

      if (current.status !== 'pending') {
        await recordEvent(client, {
          workspaceId: current.workspace_id,
          approvalId: current.id,
          actorPrincipalId: actorId,
          action: 'resolve_attempt',
          option: params.option,
          outcome: 'already_resolved',
        })
        await client.query('COMMIT')
        return { outcome: 'already_resolved' as const, approval: toApproval(current) }
      }

      // FR-APR-3: checked before authorization and before typed
      // confirmation, and before any option is applied. A resolution that
      // is both authorized AND correctly confirmed still cannot proceed
      // once this fires; see this function's own doc comment.
      if (now.getTime() >= current.timeout_at.getTime()) {
        const expired = await applyExpiry(client, current)
        await recordEvent(client, {
          workspaceId: current.workspace_id,
          approvalId: current.id,
          actorPrincipalId: actorId,
          action: 'resolve_attempt',
          option: params.option,
          outcome: 'expired',
        })
        await client.query('COMMIT')
        return { outcome: 'expired' as const, approval: toApproval(expired) }
      }

      // FR-APR-4: only a principal holding one of this approval's
      // requiredRoles may resolve it. Fail-closed on both sides: an unknown
      // resolver (principalExists false, resolverRoles []) and a known
      // resolver missing the role both fall through hasRequiredRole to
      // false, per that function's own doc comment.
      if (!isAuthorizedResolver(current, actorId, resolverRoles)) {
        await recordEvent(client, {
          workspaceId: current.workspace_id,
          approvalId: current.id,
          actorPrincipalId: actorId,
          action: 'resolve_attempt',
          option: params.option,
          outcome: 'unauthorized',
        })
        await client.query('COMMIT')
        return { outcome: 'unauthorized' as const, approval: toApproval(current) }
      }

      // hasRequiredRole only returns true when resolverRoles is non-empty,
      // and resolverRoles is only ever non-empty when principalExists is
      // true (see the lookup above), so actorId cannot be null here.
      // Asserted, not merely assumed, so a future change to that invariant
      // fails loudly right here instead of writing a null
      // granted_by_principal_id into session_approval_grants below, a NOT
      // NULL column with no room for "unknown."
      if (actorId === null) {
        throw new Error(
          'resolveApproval: reached the authorized branch with no resolver principal id, which should be unreachable',
        )
      }

      // FR-APR-5: gates only the 'approve' option, per this module's header
      // comment: 'edit_and_approve' already requires typing a real value,
      // and 'deny'/'approve_all_session' are not the highest-severity path
      // this requirement exists for.
      if (current.kind !== 'standard' && !SINGLE_DECISION_OPTIONS.includes(params.option)) {
        await recordEvent(client, {
          workspaceId: current.workspace_id,
          approvalId: current.id,
          actorPrincipalId: actorId,
          action: 'resolve_attempt',
          option: params.option,
          outcome: 'option_not_allowed',
        })
        await client.query('COMMIT')
        return { outcome: 'option_not_allowed' as const, approval: toApproval(current) }
      }

      if (current.requires_typed_confirmation && params.option === 'approve') {
        if (params.typedConfirmation === undefined) {
          await recordEvent(client, {
            workspaceId: current.workspace_id,
            approvalId: current.id,
            actorPrincipalId: actorId,
            action: 'resolve_attempt',
            option: params.option,
            outcome: 'confirmation_required',
          })
          await client.query('COMMIT')
          return { outcome: 'confirmation_required' as const, approval: toApproval(current) }
        }
        if (params.typedConfirmation !== CONFIRMATION_TOKEN) {
          await recordEvent(client, {
            workspaceId: current.workspace_id,
            approvalId: current.id,
            actorPrincipalId: actorId,
            action: 'resolve_attempt',
            option: params.option,
            outcome: 'confirmation_mismatch',
          })
          await client.query('COMMIT')
          return { outcome: 'confirmation_mismatch' as const, approval: toApproval(current) }
        }
      }

      // FR-APR-2 fix round 1: edit-and-approve's edited input is validated
      // against the CAPABILITY's own inputSchema, not merely accepted as
      // text, and a value that fails validation refuses the resolution
      // outright rather than silently substituting the original arguments.
      // An operator whose edit is rejected sees `invalid_input`, not a
      // false "approved," and the run never executes an action nobody
      // actually validated.
      let validatedEditedInput: unknown = null
      if (params.option === 'edit_and_approve') {
        const validation = validateEditedInput(current.capability, params.editedArguments)
        if (!validation.ok) {
          await recordEvent(client, {
            workspaceId: current.workspace_id,
            approvalId: current.id,
            actorPrincipalId: actorId,
            action: 'resolve_attempt',
            option: params.option,
            outcome: 'invalid_input',
          })
          await client.query('COMMIT')
          return { outcome: 'invalid_input' as const, approval: toApproval(current) }
        }
        validatedEditedInput = validation.value
      }

      const status: ApprovalStatus = params.option === 'deny' ? 'denied' : 'approved'
      // Scrubbed at the persistence boundary, matching src/runs/store.ts's
      // identical treatment of steps.input/output (serializeAndScrub), per
      // FR-SEC-1: this is a defence-in-depth backstop against a credential
      // typed directly into the Slack modal, not the primary mechanism.
      // AP-6 already requires secrets to be brokered rather than passed as
      // raw call arguments, so a validated, correctly-shaped edited input
      // should never legitimately contain one; when it does not, scrubbing
      // is a no-op and this value is exactly what was validated above.
      const editedArgumentsColumn =
        params.option === 'edit_and_approve' ? serializeAndScrub(validatedEditedInput) : null

      const { rows: updatedRows } = await client.query<ApprovalRow>(
        `UPDATE approvals
         SET status = $2, selected_option = $3, resolved_by_principal_id = $4,
             resolved_at = $5, edited_arguments = $6, updated_at = $5
         WHERE id = $1
         RETURNING *`,
        [current.id, status, params.option, actorId, now, editedArgumentsColumn],
      )
      let updated = updatedRows[0]
      if (!updated) throw new Error('resolveApproval: UPDATE ... RETURNING * returned no row')

      if (current.operation_id !== null && status === 'approved') {
        await client.query(
          `UPDATE autonomous_operations SET state = 'approved' WHERE id = $1 AND state = 'requested'`,
          [current.operation_id],
        )
      }

      if (params.receiptKey !== undefined) {
        const receipt = signApprovalReceipt(params.receiptKey, {
          approvalId: updated.id,
          kind: updated.kind,
          target: updated.target,
          operationDigest: await operationDigest(client, updated.operation_id),
          option: params.option,
          status,
          resolverPrincipalId: actorId,
          resolvedAt: now.toISOString(),
        })
        const { rows: signed } = await client.query<ApprovalRow>(
          'UPDATE approvals SET receipt = $2 WHERE id = $1 RETURNING *',
          [updated.id, receipt],
        )
        const signedRow = signed[0]
        if (!signedRow) throw new Error('resolveApproval: receipt UPDATE ... RETURNING * returned no row')
        updated = signedRow
      }

      if (params.option === 'approve_all_session') {
        const ttlMs = params.sessionGrantTtlMs ?? DEFAULT_SESSION_GRANT_TTL_MS
        const expiresAt = new Date(now.getTime() + ttlMs)
        await client.query(
          `INSERT INTO session_approval_grants
             (workspace_id, session_id, capability, source_approval_id, granted_by_principal_id, granted_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [current.workspace_id, current.session_id, current.capability, current.id, actorId, now, expiresAt],
        )
      }

      await recordEvent(client, {
        workspaceId: current.workspace_id,
        approvalId: current.id,
        actorPrincipalId: actorId,
        action: 'resolve_attempt',
        option: params.option,
        outcome: 'resolved',
      })
      await client.query('COMMIT')
      return { outcome: 'resolved' as const, approval: toApproval(updated) }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        // See createApproval's identical guard above.
      })
      throw error
    }
  })
}

/** Shared by resolveApproval's inline deadline check and expireApproval's standalone sweep: flips a pending row to timed_out and returns the updated row. Caller is responsible for its own transaction and for recording the audit event, since the two call sites want different actors on that event. */
async function applyExpiry(client: PoolClient, current: ApprovalRow): Promise<ApprovalRow> {
  const { rows } = await client.query<ApprovalRow>(
    `UPDATE approvals SET status = 'timed_out', updated_at = now() WHERE id = $1 RETURNING *`,
    [current.id],
  )
  const row = rows[0]
  if (!row) throw new Error('applyExpiry: UPDATE ... RETURNING * returned no row')
  return row
}

/**
 * Standalone FR-APR-3 sweep for a single approval: a scheduler (not wired
 * in this milestone; see this module's header comment) calls this on a
 * pending approval whose deadline has passed, with no human resolver
 * involved, so the audit event's actor is null rather than attributing a
 * system action to a principal. A no-op, returning the approval unchanged,
 * for anything that is not currently pending or not yet overdue: safe to
 * call speculatively without checking state first.
 */
export async function expireApproval(pool: Pool, workspaceId: string, approvalId: string, now?: Date): Promise<Approval | null> {
  const at = now ?? new Date()
  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<ApprovalRow>(
        'SELECT * FROM approvals WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
        [approvalId, workspaceId],
      )
      const current = rows[0]
      if (!current || current.status !== 'pending' || at.getTime() < current.timeout_at.getTime()) {
        await client.query('COMMIT')
        return current ? toApproval(current) : null
      }
      const expired = await applyExpiry(client, current)
      await recordEvent(client, {
        workspaceId: current.workspace_id,
        approvalId: current.id,
        actorPrincipalId: null,
        action: 'expired',
        option: null,
        outcome: 'timed_out',
      })
      await client.query('COMMIT')
      return toApproval(expired)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        // See createApproval's identical guard above.
      })
      throw error
    }
  })
}

/**
 * Every pending approval in `workspaceId` whose deadline has already
 * passed, oldest first. A scheduler's batch counterpart to expireApproval;
 * not called from anywhere in this milestone, per this module's header
 * comment.
 */
export async function listOverdueApprovals(pool: Pool, workspaceId: string, now?: Date): Promise<Approval[]> {
  const at = now ?? new Date()
  const { rows } = await pool.query<ApprovalRow>(
    `SELECT * FROM approvals WHERE workspace_id = $1 AND status = 'pending' AND timeout_at <= $2 ORDER BY timeout_at`,
    [workspaceId, at],
  )
  return rows.map(toApproval)
}

/**
 * Whether `sessionId` currently holds a live "approve all of this type for
 * this session" grant for `capability`, per FR-SES-3's TTL-scoped
 * escalation. Read-only; nothing in this milestone calls this from a real
 * policy decision path, per this module's header comment on Task 3's
 * interface being wired later.
 */
export async function findActiveSessionGrant(
  pool: Pool,
  workspaceId: string,
  sessionId: string,
  capability: string,
  now?: Date,
): Promise<SessionApprovalGrant | null> {
  const at = now ?? new Date()
  const { rows } = await pool.query<SessionApprovalGrantRow>(
    `SELECT * FROM session_approval_grants
     WHERE workspace_id = $1 AND session_id = $2 AND capability = $3 AND expires_at > $4
     ORDER BY granted_at DESC
     LIMIT 1`,
    [workspaceId, sessionId, capability, at],
  )
  const row = rows[0]
  return row ? toSessionApprovalGrant(row) : null
}
