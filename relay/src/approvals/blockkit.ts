/**
 * Renders approval requests, their resolved state, modal prompts, and
 * paused-run summaries as Slack Block Kit JSON, per FR-APR-1, FR-APR-2,
 * FR-APR-5, and FR-APR-10. Pure: no Slack SDK, no I/O, nothing here talks
 * to a network; src/chat/slack/adapter.ts is what actually sends what these
 * functions return.
 *
 * Every string field a caller supplies (description, target, escalation
 * reason, edited arguments, a paused-run summary's free text) is run
 * through scrubSecrets before it reaches a returned block, per FR-SEC-1:
 * this is exactly the surface the Task 4 brief named as where a credential
 * quoted into a call's target leaks to a chat surface, and
 * src/secrets/scrubber.ts is the one process-wide scrubber this project
 * already has, registered at SecretProvider.get, not a second redactor
 * built here.
 */

import { scrubSecrets } from '../secrets/scrubber.js'
import type { ApprovalKind, ApprovalOption, ApprovalStatus, ResolveOutcome } from './store.js'
import { CONFIRMATION_TOKEN } from './store.js'

// Re-exported for convenience: every caller that renders a modal or a card
// mentioning the confirmation word reaches for this module first, since
// it owns the rendering; re-exporting avoids a second import line back to
// src/approvals/store.ts just for this one constant.
export { CONFIRMATION_TOKEN }

/**
 * A Block Kit block, or a modal view, loosely typed as plain JSON. Matches
 * how src/chat/slack/adapter.ts already treats every other Slack payload
 * (SlackRawEvent, SlackEventEnvelope) rather than depending on @slack/types
 * for a shape this module only ever builds, never parses.
 */
export type SlackBlock = Record<string, unknown>
export type SlackModalView = Record<string, unknown>

export type RenderedCard = { text: string; blocks: SlackBlock[] }

/**
 * Fixed action ids for the four FR-APR-2 buttons. Static, not per-approval:
 * the approval id travels in each button's `value` instead (standard Block
 * Kit practice), so the Slack adapter registers exactly four `app.action`
 * listeners once at startup rather than one per approval ever rendered.
 */
export const APPROVAL_ACTION_IDS = {
  approve: 'approval_approve',
  deny: 'approval_deny',
  approveAllSession: 'approval_approve_all_session',
  editAndApprove: 'approval_edit_and_approve',
} as const

export const CONFIRM_MODAL_CALLBACK_ID = 'approval_confirm_modal'
export const EDIT_MODAL_CALLBACK_ID = 'approval_edit_modal'
export const CONFIRM_MODAL_BLOCK_ID = 'approval_confirm_block'
export const CONFIRM_MODAL_ACTION_ID = 'approval_confirm_input'
export const EDIT_MODAL_BLOCK_ID = 'approval_edit_block'
export const EDIT_MODAL_ACTION_ID = 'approval_edit_input'

export const RESUME_RUN_ACTION_ID = 'resume_run'

/** Slack rejects a section whose text is over 3000 characters. */
const SECTION_TEXT_LIMIT = 3000

function mrkdwnSection(text: string): SlackBlock {
  const fitted = text.length > SECTION_TEXT_LIMIT ? `${text.slice(0, SECTION_TEXT_LIMIT - 20)}\n…(truncated)` : text
  return { type: 'section', text: { type: 'mrkdwn', text: fitted } }
}

/** Worker-written text shown on a card: scrubbed, and with backticks neutralised so it cannot close a code span the card opened. */
function untrustedMrkdwn(text: string): string {
  return scrubSecrets(text).replaceAll('`', "'")
}

function codeBlock(text: string): string {
  return `\`\`\`${untrustedMrkdwn(text)}\`\`\``
}

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

export type ApprovalCardFields = {
  approvalId: string
  capability: string
  description: string
  target: string
  tier: string
  escalationReason: string
  runId: string
  sessionId: string
  requesterDisplayName: string
  requiresTypedConfirmation: boolean
  /** FR-APR-1's "a screenshot or content preview where meaningful." Omitted when there is nothing to show. */
  screenshotUrl?: string
  /** Defaults to `standard`. `plan` and `remote_write` cards offer approve and deny only. */
  kind?: ApprovalKind
  /** For a `plan` card: the stored plan version the buttons approve. */
  plan?: { summary: string; scope: string; acceptanceCriteria: readonly string[]; testCommand: string | null }
  /** For a `remote_write` card: the exact operation, from its operation row. */
  operation?: { kind: string; text: string }
}

/**
 * Renders a pending approval card, per FR-APR-1's exact field list
 * (capability, human-readable description, exact target, tier, escalation
 * reason, run and session identity, requester) and FR-APR-2's four options.
 * The Approve button's `value` carries `requiresTypedConfirmation` alongside
 * the approval id so the adapter can decide, client side, whether to open
 * the confirmation modal (FR-APR-5) or resolve directly, without a second
 * round trip to look the approval up first.
 */
export function renderApprovalCard(fields: ApprovalCardFields): RenderedCard {
  const description = scrubSecrets(fields.description)
  const target = scrubSecrets(fields.target)
  const escalationReason = scrubSecrets(fields.escalationReason)

  const text = `Approval needed: ${description} (${fields.capability}, ${tierLabel(fields.tier)} tier)`

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Approval needed', emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Capability:*\n${fields.capability}` },
        { type: 'mrkdwn', text: `*Risk tier:*\n${tierLabel(fields.tier)}` },
        { type: 'mrkdwn', text: `*Requested by:*\n${fields.requesterDisplayName}` },
        { type: 'mrkdwn', text: `*Why it needs approval:*\n${escalationReason}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*What it will do:*\n${description}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Exact target:*\n\`${target}\`` } },
  ]

  if (fields.screenshotUrl) {
    blocks.push({ type: 'image', image_url: fields.screenshotUrl, alt_text: 'preview' })
  }

  const kind = fields.kind ?? 'standard'
  // A plan or remote-write card must show what the buttons approve; never render one blind.
  if (kind === 'plan' && !fields.plan) throw new Error('renderApprovalCard: a plan card needs its plan')
  if (kind === 'remote_write' && !fields.operation) throw new Error('renderApprovalCard: a remote-write card needs its operation')

  if (fields.plan) {
    const criteria = fields.plan.acceptanceCriteria.map((line) => `• ${untrustedMrkdwn(line)}`).join('\n') || '(none)'
    blocks.push(
      mrkdwnSection(`*Plan:*\n${untrustedMrkdwn(fields.plan.summary)}`),
      mrkdwnSection(`*Scope:*\n${untrustedMrkdwn(fields.plan.scope)}`),
      mrkdwnSection(`*Acceptance criteria:*\n${criteria}`),
    )
    if (fields.plan.testCommand !== null) {
      blocks.push(mrkdwnSection(`*Test command:*\n${codeBlock(fields.plan.testCommand)}`))
    }
  }

  if (fields.operation) {
    blocks.push(mrkdwnSection(`*Operation (${untrustedMrkdwn(fields.operation.kind)}):*\n${codeBlock(fields.operation.text)}`))
  }

  if (fields.requiresTypedConfirmation) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `This is the highest severity tier. Approving will ask you to type *${CONFIRMATION_TOKEN}* to confirm, per FR-APR-5.`,
        },
      ],
    })
  }

  blocks.push({
    type: 'actions',
    block_id: `approval_actions_${fields.approvalId}`,
    elements: [
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: 'Approve', emoji: true },
        action_id: APPROVAL_ACTION_IDS.approve,
        value: JSON.stringify({
          approvalId: fields.approvalId,
          requiresTypedConfirmation: fields.requiresTypedConfirmation,
        }),
      },
      {
        type: 'button',
        style: 'danger',
        text: { type: 'plain_text', text: 'Deny', emoji: true },
        action_id: APPROVAL_ACTION_IDS.deny,
        value: JSON.stringify({ approvalId: fields.approvalId }),
      },
      ...((fields.kind ?? 'standard') === 'standard'
        ? [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve all of this type for this session', emoji: true },
              action_id: APPROVAL_ACTION_IDS.approveAllSession,
              value: JSON.stringify({ approvalId: fields.approvalId }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Edit and approve', emoji: true },
              action_id: APPROVAL_ACTION_IDS.editAndApprove,
              value: JSON.stringify({ approvalId: fields.approvalId }),
            },
          ]
        : []),
    ],
  })

  if (kind !== 'standard' && fields.requiresTypedConfirmation) {
    throw new Error('renderApprovalCard: plan and remote-write approvals do not use typed confirmation')
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Run \`${fields.runId}\` · Session \`${fields.sessionId}\`` }],
  })

  return { text, blocks }
}

export type ResolvedCardFields = ApprovalCardFields & {
  status: ApprovalStatus
  selectedOption: ApprovalOption
  resolverDisplayName: string
  resolvedAtIso: string
  /** The already-validated, structured value src/approvals/store.ts's resolveApproval stored, per fix round 1; never raw operator text. `unknown`, matching Approval.editedArguments's own type, since different capabilities validate to different shapes. */
  editedArguments?: unknown
}

const OPTION_VERBS: Record<ApprovalOption, string> = {
  approve: 'Approved',
  deny: 'Denied',
  approve_all_session: 'Approved (all of this type for this session)',
  edit_and_approve: 'Approved with edits',
}

/**
 * Renders the resolved state of a card that was previously posted by
 * renderApprovalCard, per FR-SL-5's "each button resolves the pending
 * approval," so the card in the thread stops looking like it is still
 * waiting the moment someone acts on it. Carries no action buttons: a
 * resolved approval cannot be resolved again (src/approvals/store.ts's
 * resolveApproval refuses a second resolution outright), so offering
 * buttons that would only ever produce 'already_resolved' would be
 * misleading.
 */
export function renderResolvedCard(fields: ResolvedCardFields): RenderedCard {
  const description = scrubSecrets(fields.description)
  const target = scrubSecrets(fields.target)
  const verb = OPTION_VERBS[fields.selectedOption]

  const text = `${verb} by ${fields.resolverDisplayName}: ${description} (${fields.capability})`

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: verb, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*What it does:*\n${description}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Exact target:*\n\`${target}\`` } },
  ]

  if (fields.selectedOption === 'edit_and_approve' && fields.editedArguments !== undefined && fields.editedArguments !== null) {
    // Already validated, structured data by the time it reaches here (see
    // this field's own doc comment), so it is re-serialised for display,
    // not echoed as text: scrubSecrets still runs over that serialised
    // form, the same defence-in-depth backstop src/approvals/store.ts
    // itself already applies before persisting it.
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Edited arguments:*\n\`${scrubSecrets(JSON.stringify(fields.editedArguments))}\`` },
    })
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `${verb} by ${fields.resolverDisplayName} at ${fields.resolvedAtIso}` },
      { type: 'mrkdwn', text: `Run \`${fields.runId}\` · Session \`${fields.sessionId}\`` },
    ],
  })

  return { text, blocks }
}

export type ModalMetadata = { approvalId: string; channel: string; messageTs: string }

/** Parses the JSON private_metadata every modal below carries, so the adapter's view_submission handler has one place to decode it. Throws on malformed metadata rather than returning a partial object: a modal this store did not render should never be silently half-trusted. */
export function parseModalMetadata(raw: string): ModalMetadata {
  const parsed = JSON.parse(raw) as Partial<ModalMetadata>
  if (
    typeof parsed.approvalId !== 'string' ||
    typeof parsed.channel !== 'string' ||
    typeof parsed.messageTs !== 'string'
  ) {
    throw new Error(`parseModalMetadata: malformed private_metadata: ${raw}`)
  }
  return { approvalId: parsed.approvalId, channel: parsed.channel, messageTs: parsed.messageTs }
}

/**
 * FR-APR-5's typed-confirmation modal, opened when the Approve button is
 * clicked on an approval whose requiresTypedConfirmation is true. Submitting
 * without the input reaching CONFIRMATION_TOKEN is rejected by the adapter
 * with confirmationMismatchError below, which keeps the modal open rather
 * than silently closing on a wrong answer.
 */
export function renderConfirmationModal(meta: ModalMetadata): SlackModalView {
  return {
    type: 'modal',
    callback_id: CONFIRM_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Confirm approval' },
    submit: { type: 'plain_text', text: 'Approve' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `This is the highest severity tier. Type *${CONFIRMATION_TOKEN}* to approve.` },
      },
      {
        type: 'input',
        block_id: CONFIRM_MODAL_BLOCK_ID,
        label: { type: 'plain_text', text: 'Type to confirm' },
        element: { type: 'plain_text_input', action_id: CONFIRM_MODAL_ACTION_ID },
      },
    ],
  }
}

/**
 * The exact wording for a missing or mismatched typed-confirmation
 * submission, and the source of truth `confirmationMismatchError` and
 * `UNRESOLVED_OUTCOME_DESCRIPTIONS` both read from directly, per fix round
 * 2: an earlier version derived the description map's entry by CALLING
 * `confirmationMismatchError()` and indexing its returned object with `as
 * string`, which would have silently produced `undefined` (masked by the
 * cast) if that function's own block id key ever changed independently of
 * this one. A shared constant removes the indirection instead of asserting
 * past it.
 */
const CONFIRMATION_REQUIRED_MESSAGE = `Type ${CONFIRMATION_TOKEN} to confirm.`
const CONFIRMATION_MISMATCH_MESSAGE = `Does not match. Type ${CONFIRMATION_TOKEN} exactly to approve.`

/** The view_submission error payload for a wrong or missing confirmation token: keeps the modal open with an inline error, per Slack's own `response_action: 'errors'` contract, rather than closing on a failed attempt. */
export function confirmationMismatchError(): Record<string, string> {
  return { [CONFIRM_MODAL_BLOCK_ID]: CONFIRMATION_MISMATCH_MESSAGE }
}

/**
 * FR-APR-2's "edit and approve" modal: a free-text field, optionally
 * pre-filled with the approval's current target. The field collects JSON
 * text, per fix round 1: src/approvals/store.ts's resolveApproval parses
 * and validates this text against the capability's own inputSchema before
 * it can ever be substituted for the original call, and a Slack
 * `plain_text_input` has no structured type of its own to collect it as,
 * so JSON text is the closest this modal can get to a real argument value.
 * `currentTarget` is scrubbed before it is echoed back into the pre-filled
 * input, same as every other rendered field in this module.
 *
 * `currentTarget` is optional because the adapter that opens this modal
 * (src/chat/slack/adapter.ts) does so straight from a button click, with
 * only the approval id in hand, not the approval's own row; fetching the
 * current target first would need a second injected lookup this task does
 * not add, per its "do not wire the two together" scoping. Without it, the
 * field opens empty with a placeholder rather than silently rendering
 * "Current target: undefined".
 */
export function renderEditModal(meta: ModalMetadata, currentTarget?: string): SlackModalView {
  const target = currentTarget !== undefined ? scrubSecrets(currentTarget) : undefined
  const blocks: SlackBlock[] = []
  if (target !== undefined) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Current target:\n\`${target}\`` } })
  }
  blocks.push({
    type: 'input',
    block_id: EDIT_MODAL_BLOCK_ID,
    label: { type: 'plain_text', text: 'Revised arguments (JSON)' },
    element: {
      type: 'plain_text_input',
      action_id: EDIT_MODAL_ACTION_ID,
      multiline: true,
      ...(target !== undefined
        ? { initial_value: target }
        : { placeholder: { type: 'plain_text', text: 'e.g. {"command": "rm -rf only-2024-exports"}' } }),
    },
  })
  return {
    type: 'modal',
    callback_id: EDIT_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Edit and approve' },
    submit: { type: 'plain_text', text: 'Approve with edits' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  }
}

/** Same reasoning as CONFIRMATION_REQUIRED_MESSAGE/CONFIRMATION_MISMATCH_MESSAGE above: the one place this exact wording is written, read directly by both editValidationError and UNRESOLVED_OUTCOME_DESCRIPTIONS. */
const EDIT_VALIDATION_MESSAGE =
  'Could not validate this as JSON matching the capability\'s expected arguments. Check the JSON and try again.'

/**
 * The view_submission error payload for an edited value that failed
 * src/approvals/store.ts's capability-schema validation (outcome
 * `invalid_input`), per fix round 1: keeps the modal open with an inline
 * error, the same `response_action: 'errors'` contract
 * confirmationMismatchError already uses, rather than closing on a
 * rejected edit and leaving the operator uncertain whether it was applied.
 */
export function editValidationError(): Record<string, string> {
  return { [EDIT_MODAL_BLOCK_ID]: EDIT_VALIDATION_MESSAGE }
}

/**
 * Fix round 2: the four outcomes that mean the exact same thing regardless
 * of which surface (a button click, the confirmation modal, or the edit
 * modal) produced them. `not_found`, `already_resolved`, `expired`, and
 * `unauthorized` never reference "your typed confirmation" or "your edited
 * JSON," so their wording is safe to reuse verbatim across every context.
 *
 * The other three non-`resolved` outcomes (`confirmation_required`,
 * `confirmation_mismatch`, `invalid_input`) are deliberately NOT here:
 * each names something specific to one surface (typing a confirmation
 * word, or editing JSON), and fix round 2's own finding is exactly that a
 * single shared map covering all seven let one surface's fallback render
 * another surface's wording for an outcome it could never legitimately
 * produce, invisibly to the type checker, since the narrowed outcome type
 * at a generic fallback was still a superset of what that surface could
 * actually return. Typing every context's own final fallback against this
 * narrower, four-key map instead means TypeScript itself rejects the call
 * unless every context-specific outcome has already been excluded by an
 * earlier, explicit branch, which is what src/chat/slack/adapter.ts's own
 * handlers now do for the outcomes that do not belong in a given context.
 */
export const GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS: Record<
  'not_found' | 'already_resolved' | 'expired' | 'unauthorized' | 'option_not_allowed',
  string
> = {
  not_found: 'This approval could not be found.',
  already_resolved: 'This approval was already resolved by someone else.',
  expired: 'This approval has expired. The run is paused, waiting on a new decision.',
  unauthorized: 'You are not authorized to resolve this approval.',
  option_not_allowed: 'This approval takes approve or deny only.',
}

/**
 * A human-readable description of every outcome resolveApproval can
 * produce OTHER than `resolved`, which renders its own card via
 * renderResolvedCard instead of going through this map. Exhaustive over
 * `ResolveOutcome` by construction: this object's type requires every
 * non-`resolved` member to have an entry, so adding a new outcome to the
 * store without adding a description here is a compile error at this one
 * definition. Used directly only where a caller has independently proven
 * (via its own explicit, narrowing branches) that every outcome reaching
 * it is contextually valid; see GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS's
 * own doc comment for the narrower map most call sites should reach for
 * instead at their own final, generic fallback.
 */
export const UNRESOLVED_OUTCOME_DESCRIPTIONS: Record<Exclude<ResolveOutcome, 'resolved'>, string> = {
  ...GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS,
  confirmation_required: CONFIRMATION_REQUIRED_MESSAGE,
  confirmation_mismatch: CONFIRMATION_MISMATCH_MESSAGE,
  invalid_input: EDIT_VALIDATION_MESSAGE,
}

export type PausedRunSummaryFields = {
  runId: string
  sessionId: string
  /** What the run is waiting for, e.g. "approval to run rm -rf ~/Downloads/old-exports". */
  waitingFor: string
  /** What has been done so far, rendered as a bullet list. */
  doneSoFar: readonly string[]
  /** What remains, rendered as a bullet list. */
  remaining: readonly string[]
  waitingSinceIso: string
  resumeActionId?: string
}

/**
 * Renders FR-APR-10's "paused, waiting on you" summary: what it is waiting
 * for, what has been done so far, what remains, how long it has been
 * waiting, and a Resume control. A paused run must never look like a
 * working one, so this card is deliberately distinct from
 * ProgressReporter's own in-place progress edit (src/chat/progress.ts):
 * it states plainly that the run is stopped, not merely between steps.
 *
 * This function only renders the summary; nothing in this module or
 * src/chat/slack/adapter.ts schedules WHEN it is posted (on an approval
 * timeout, a budget cap, a re-authentication need, or any other pause
 * cause). That trigger belongs to the run loop / policy seam, per the Task
 * 4 brief's "wiring is a later step"; see the task report.
 */
export function renderPausedRunSummary(fields: PausedRunSummaryFields): RenderedCard {
  const waitingFor = scrubSecrets(fields.waitingFor)
  const doneSoFar = fields.doneSoFar.map((entry) => scrubSecrets(entry))
  const remaining = fields.remaining.map((entry) => scrubSecrets(entry))

  const text = `Paused, waiting on you: ${waitingFor}`

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Paused, waiting on you', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Waiting for:*\n${waitingFor}` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Done so far:*\n${doneSoFar.length ? doneSoFar.map((entry) => `• ${entry}`).join('\n') : '_nothing yet_'}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Remaining:*\n${remaining.length ? remaining.map((entry) => `• ${entry}`).join('\n') : '_unknown_'}`,
      },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Waiting since ${fields.waitingSinceIso}` }] },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Resume', emoji: true },
          action_id: fields.resumeActionId ?? RESUME_RUN_ACTION_ID,
          value: JSON.stringify({ runId: fields.runId, sessionId: fields.sessionId }),
        },
      ],
    },
  ]

  return { text, blocks }
}
