import { beforeEach, describe, expect, it } from 'vitest'
import { registerSecretValue, resetSecretScrubberForTests } from '../../src/secrets/scrubber.js'
import {
  APPROVAL_ACTION_IDS,
  CONFIRMATION_TOKEN,
  CONFIRM_MODAL_ACTION_ID,
  CONFIRM_MODAL_BLOCK_ID,
  CONFIRM_MODAL_CALLBACK_ID,
  EDIT_MODAL_ACTION_ID,
  EDIT_MODAL_BLOCK_ID,
  EDIT_MODAL_CALLBACK_ID,
  GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS,
  RESUME_RUN_ACTION_ID,
  UNRESOLVED_OUTCOME_DESCRIPTIONS,
  confirmationMismatchError,
  editValidationError,
  parseModalMetadata,
  renderApprovalCard,
  renderConfirmationModal,
  renderEditModal,
  renderPausedRunSummary,
  renderResolvedCard,
} from '../../src/approvals/blockkit.js'
import type { SlackBlock } from '../../src/approvals/blockkit.js'

/**
 * CONFIRMATION_TOKEN is re-exported from src/approvals/store.ts and used
 * here rather than the literal string, so a change to the token's value
 * cannot silently desynchronize this file's expectations from the module
 * that actually enforces it (src/approvals/store.ts's resolveApproval).
 */

function baseCardFields(overrides: Partial<Parameters<typeof renderApprovalCard>[0]> = {}) {
  return {
    approvalId: 'apr_123',
    capability: 'shell.exec',
    description: 'Delete old export files',
    target: 'rm -rf ~/Downloads/old-exports',
    tier: 'irreversible',
    escalationReason: 'irreversible-tier action always requires approval',
    runId: 'run_abc',
    sessionId: 'sess_def',
    requesterDisplayName: 'Hassan',
    requiresTypedConfirmation: false,
    ...overrides,
  }
}

function actionsBlock(blocks: SlackBlock[]): SlackBlock | undefined {
  return blocks.find((block) => block.type === 'actions')
}

function flattenText(blocks: SlackBlock[]): string {
  return JSON.stringify(blocks)
}

describe('src/approvals/blockkit.ts', () => {
  beforeEach(() => {
    resetSecretScrubberForTests()
  })

  describe('renderApprovalCard', () => {
    it('carries every FR-APR-1 field: capability, description, exact target, tier, escalation reason, run and session identity, requester', () => {
      const { text, blocks } = renderApprovalCard(baseCardFields())
      const rendered = text + flattenText(blocks)

      expect(rendered).toContain('shell.exec')
      expect(rendered).toContain('Delete old export files')
      expect(rendered).toContain('rm -rf ~/Downloads/old-exports')
      expect(rendered).toContain('Irreversible')
      expect(rendered).toContain('irreversible-tier action always requires approval')
      expect(rendered).toContain('run_abc')
      expect(rendered).toContain('sess_def')
      expect(rendered).toContain('Hassan')
    })

    it('renders exactly FR-APR-2\'s four options as buttons, each carrying the approval id', () => {
      const { blocks } = renderApprovalCard(baseCardFields())
      const actions = actionsBlock(blocks)
      expect(actions).toBeDefined()
      const elements = actions?.elements as Array<Record<string, unknown>>
      expect(elements).toHaveLength(4)

      const byActionId = Object.fromEntries(elements.map((element) => [element.action_id, element]))
      expect(byActionId[APPROVAL_ACTION_IDS.approve]).toBeDefined()
      expect(byActionId[APPROVAL_ACTION_IDS.deny]).toBeDefined()
      expect(byActionId[APPROVAL_ACTION_IDS.approveAllSession]).toBeDefined()
      expect(byActionId[APPROVAL_ACTION_IDS.editAndApprove]).toBeDefined()

      for (const element of elements) {
        const value = JSON.parse(element.value as string) as { approvalId: string }
        expect(value.approvalId).toBe('apr_123')
      }
    })

    it('encodes requiresTypedConfirmation into the Approve button value, so the adapter can decide to open a modal without a second lookup', () => {
      const { blocks } = renderApprovalCard(baseCardFields({ requiresTypedConfirmation: true }))
      const actions = actionsBlock(blocks)
      const elements = actions?.elements as Array<Record<string, unknown>>
      const approveButton = elements.find((element) => element.action_id === APPROVAL_ACTION_IDS.approve)
      const value = JSON.parse(approveButton?.value as string) as { requiresTypedConfirmation: boolean }
      expect(value.requiresTypedConfirmation).toBe(true)
    })

    it('mentions the fixed confirmation token when requiresTypedConfirmation is true, and omits any such mention otherwise', () => {
      const withConfirmation = renderApprovalCard(baseCardFields({ requiresTypedConfirmation: true }))
      expect(flattenText(withConfirmation.blocks)).toContain(CONFIRMATION_TOKEN)

      const without = renderApprovalCard(baseCardFields({ requiresTypedConfirmation: false }))
      expect(flattenText(without.blocks)).not.toContain(CONFIRMATION_TOKEN)
    })

    it('routes description, target, and escalationReason through the process-wide secret scrubber', () => {
      registerSecretValue('sk_live_verysecrettoken123456')
      const { text, blocks } = renderApprovalCard(
        baseCardFields({
          target: 'https://api.example.com?key=sk_live_verysecrettoken123456',
          description: 'Use sk_live_verysecrettoken123456 to charge the card',
          escalationReason: 'credential sk_live_verysecrettoken123456 detected in arguments',
        }),
      )
      const rendered = text + flattenText(blocks)
      expect(rendered).not.toContain('sk_live_verysecrettoken123456')
      expect(rendered).toContain('[redacted secret]')
    })

    it('includes a screenshot block only when screenshotUrl is supplied', () => {
      const without = renderApprovalCard(baseCardFields())
      expect(without.blocks.some((block) => block.type === 'image')).toBe(false)

      const withScreenshot = renderApprovalCard(baseCardFields({ screenshotUrl: 'https://example.com/shot.png' }))
      const imageBlock = withScreenshot.blocks.find((block) => block.type === 'image')
      expect(imageBlock).toMatchObject({ image_url: 'https://example.com/shot.png' })
    })
  })

  describe('renderResolvedCard', () => {
    function resolvedFields(overrides: Partial<Parameters<typeof renderResolvedCard>[0]> = {}) {
      return {
        ...baseCardFields(),
        status: 'approved' as const,
        selectedOption: 'approve' as const,
        resolverDisplayName: 'Hassan',
        resolvedAtIso: '2026-08-10T12:00:00.000Z',
        ...overrides,
      }
    }

    it('carries no action buttons: a resolved approval cannot be resolved again', () => {
      const { blocks } = renderResolvedCard(resolvedFields())
      expect(actionsBlock(blocks)).toBeUndefined()
    })

    it('states who resolved it, when, and with which option, for each of the four options', () => {
      const approve = renderResolvedCard(resolvedFields({ selectedOption: 'approve', status: 'approved' }))
      expect(approve.text).toContain('Approved by Hassan')

      const deny = renderResolvedCard(resolvedFields({ selectedOption: 'deny', status: 'denied' }))
      expect(deny.text).toContain('Denied by Hassan')

      const approveAll = renderResolvedCard(
        resolvedFields({ selectedOption: 'approve_all_session', status: 'approved' }),
      )
      expect(flattenText(approveAll.blocks)).toContain('all of this type for this session')

      const editApprove = renderResolvedCard(
        resolvedFields({
          selectedOption: 'edit_and_approve',
          status: 'approved',
          editedArguments: 'revised target text',
        }),
      )
      expect(flattenText(editApprove.blocks)).toContain('revised target text')
    })

    it('scrubs a registered secret from the edited arguments it echoes back', () => {
      registerSecretValue('sk_live_verysecrettoken123456')
      const { blocks } = renderResolvedCard(
        resolvedFields({
          selectedOption: 'edit_and_approve',
          editedArguments: 'key sk_live_verysecrettoken123456',
        }),
      )
      expect(flattenText(blocks)).not.toContain('sk_live_verysecrettoken123456')
    })
  })

  describe('modals', () => {
    const meta = { approvalId: 'apr_123', channel: 'C123', messageTs: '1700000000.000100' }

    it('renderConfirmationModal round-trips its metadata through parseModalMetadata and prompts for the fixed token', () => {
      const view = renderConfirmationModal(meta)
      expect(view.callback_id).toBe(CONFIRM_MODAL_CALLBACK_ID)
      expect(parseModalMetadata(view.private_metadata as string)).toEqual(meta)
      expect(JSON.stringify(view.blocks)).toContain(CONFIRMATION_TOKEN)
      const inputBlock = (view.blocks as SlackBlock[]).find((block) => block.block_id === CONFIRM_MODAL_BLOCK_ID)
      expect((inputBlock?.element as Record<string, unknown>).action_id).toBe(CONFIRM_MODAL_ACTION_ID)
    })

    it('confirmationMismatchError keys its message to the confirmation modal\'s own block id, so Slack re-shows the error inline', () => {
      const errors = confirmationMismatchError()
      expect(Object.keys(errors)).toEqual([CONFIRM_MODAL_BLOCK_ID])
      expect(errors[CONFIRM_MODAL_BLOCK_ID]).toContain(CONFIRMATION_TOKEN)
    })

    it('renderEditModal pre-fills the (scrubbed) current target and round-trips its metadata', () => {
      registerSecretValue('sk_live_verysecrettoken123456')
      const view = renderEditModal(meta, 'https://example.com?key=sk_live_verysecrettoken123456')
      expect(view.callback_id).toBe(EDIT_MODAL_CALLBACK_ID)
      expect(parseModalMetadata(view.private_metadata as string)).toEqual(meta)

      const inputBlock = (view.blocks as SlackBlock[]).find((block) => block.block_id === EDIT_MODAL_BLOCK_ID)
      const element = inputBlock?.element as Record<string, unknown>
      expect(element.action_id).toBe(EDIT_MODAL_ACTION_ID)
      expect(element.initial_value).not.toContain('sk_live_verysecrettoken123456')
    })

    it('parseModalMetadata throws on malformed private_metadata rather than returning a partial object', () => {
      expect(() => parseModalMetadata('not json')).toThrow()
      expect(() => parseModalMetadata(JSON.stringify({ approvalId: 'apr_123' }))).toThrow()
    })
  })

  describe('renderPausedRunSummary', () => {
    it('states what it is waiting for, what has been done, what remains, how long it has waited, and a Resume control, per FR-APR-10', () => {
      const { text, blocks } = renderPausedRunSummary({
        runId: 'run_abc',
        sessionId: 'sess_def',
        waitingFor: 'approval to run rm -rf ~/Downloads/old-exports',
        doneSoFar: ['Listed files in ~/Downloads', 'Identified 12 exports older than 90 days'],
        remaining: ['Delete the identified files', 'Report the result'],
        waitingSinceIso: '2026-08-10T12:00:00.000Z',
      })

      expect(text).toContain('Paused, waiting on you')
      const rendered = flattenText(blocks)
      expect(rendered).toContain('Listed files in ~/Downloads')
      expect(rendered).toContain('Identified 12 exports older than 90 days')
      expect(rendered).toContain('Delete the identified files')
      expect(rendered).toContain('2026-08-10T12:00:00.000Z')

      const actions = actionsBlock(blocks)
      const elements = actions?.elements as Array<Record<string, unknown>>
      expect(elements).toHaveLength(1)
      expect(elements[0]?.action_id).toBe(RESUME_RUN_ACTION_ID)
      const value = JSON.parse(elements[0]?.value as string) as { runId: string; sessionId: string }
      expect(value).toEqual({ runId: 'run_abc', sessionId: 'sess_def' })
    })

    it('scrubs a registered secret out of waitingFor, doneSoFar, and remaining', () => {
      registerSecretValue('sk_live_verysecrettoken123456')
      const { blocks } = renderPausedRunSummary({
        runId: 'run_abc',
        sessionId: 'sess_def',
        waitingFor: 'approval using sk_live_verysecrettoken123456',
        doneSoFar: ['fetched with sk_live_verysecrettoken123456'],
        remaining: ['finish with sk_live_verysecrettoken123456'],
        waitingSinceIso: '2026-08-10T12:00:00.000Z',
      })
      expect(flattenText(blocks)).not.toContain('sk_live_verysecrettoken123456')
    })

    it('renders honest placeholders rather than empty sections when nothing has been done yet or remaining is unknown', () => {
      const { blocks } = renderPausedRunSummary({
        runId: 'run_abc',
        sessionId: 'sess_def',
        waitingFor: 'operator re-authentication',
        doneSoFar: [],
        remaining: [],
        waitingSinceIso: '2026-08-10T12:00:00.000Z',
      })
      const rendered = flattenText(blocks)
      expect(rendered).toContain('nothing yet')
      expect(rendered).toContain('unknown')
    })
  })

  /**
   * Fix round 2: GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS must cover exactly
   * the four context-independent outcomes, no more and no fewer, and
   * UNRESOLVED_OUTCOME_DESCRIPTIONS's own confirmation/edit-specific
   * entries must read the SAME wording confirmationMismatchError and
   * editValidationError actually return, not a value that happened to
   * agree by coincidence. An earlier version derived those entries by
   * calling the helper functions and indexing the result with `as
   * string`, which would have silently produced `undefined` if either
   * helper's own block id key ever diverged from what this map assumed;
   * these tests would have caught that by construction, since they
   * compare the map's value against the helper's own real return value,
   * not a hand-copied literal.
   */
  describe('outcome description maps (fix round 2)', () => {
    it('GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS covers exactly the five context-independent outcomes', () => {
      expect(Object.keys(GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS).sort()).toEqual(
        ['already_resolved', 'expired', 'not_found', 'option_not_allowed', 'unauthorized'].sort(),
      )
    })

    it("UNRESOLVED_OUTCOME_DESCRIPTIONS.confirmation_mismatch matches confirmationMismatchError's own real wording", () => {
      expect(UNRESOLVED_OUTCOME_DESCRIPTIONS.confirmation_mismatch).toBe(
        confirmationMismatchError()[CONFIRM_MODAL_BLOCK_ID],
      )
    })

    it("UNRESOLVED_OUTCOME_DESCRIPTIONS.invalid_input matches editValidationError's own real wording", () => {
      expect(UNRESOLVED_OUTCOME_DESCRIPTIONS.invalid_input).toBe(editValidationError()[EDIT_MODAL_BLOCK_ID])
    })

    it('UNRESOLVED_OUTCOME_DESCRIPTIONS agrees with GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS on every outcome the two share', () => {
      for (const [outcome, text] of Object.entries(GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS)) {
        expect(UNRESOLVED_OUTCOME_DESCRIPTIONS[outcome as keyof typeof GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS]).toBe(text)
      }
    })
  })
})
