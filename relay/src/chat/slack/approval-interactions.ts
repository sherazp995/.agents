/**
 * Block Kit approval interactions for SlackAdapter: the approval card
 * buttons, the typed confirmation and edit-and-approve modal submissions,
 * outcome reporting back into the thread, and the resolved card. Each
 * handler is a function over the ApprovalInteractionContext SlackAdapter
 * passes in; SlackAdapter.start() registers them, outside its delivery queue.
 */
import type { Approval, ApprovalOption, ResolveApprovalResult, ResolveOutcome } from '../../approvals/store.js'
import {
  CONFIRM_MODAL_ACTION_ID,
  CONFIRM_MODAL_BLOCK_ID,
  CONFIRM_MODAL_CALLBACK_ID,
  EDIT_MODAL_ACTION_ID,
  EDIT_MODAL_BLOCK_ID,
  EDIT_MODAL_CALLBACK_ID,
  confirmationMismatchError,
  editValidationError,
  GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS,
  UNRESOLVED_OUTCOME_DESCRIPTIONS,
  parseModalMetadata,
  renderConfirmationModal,
  renderEditModal,
  renderResolvedCard,
} from '../../approvals/blockkit.js'
import type { ModalMetadata } from '../../approvals/blockkit.js'
import type { Logger } from '../../obs/logger.js'
import type { AdapterCapabilities } from '../contract.js'
import type {
  ApprovalInteractionRequest,
  SlackApiClient,
  SlackBlockActionEnvelope,
  SlackViewSubmissionEnvelope,
  SlackViewSubmissionResponse,
} from './types.js'

/** What the approval handlers need from SlackAdapter; `callApi` is its rate limit aware #callApi. */
export type ApprovalInteractionContext = {
  apiClient: SlackApiClient
  capabilities: AdapterCapabilities
  callApi: <T>(call: () => Promise<T>) => Promise<T>
  resolvePrincipalId: (platformUserId: string) => Promise<string | null>
  resolveApprovalInteraction: (request: ApprovalInteractionRequest) => Promise<ResolveApprovalResult | undefined>
  log: Logger | undefined
}

/**
 * Handles one Block Kit button click on an approval card. `option` is
 * fixed per action id, decided by which of the four listeners start()
 * registered, never decoded from the payload itself, so a malformed or
 * spoofed action_id can never be routed to the wrong option.
 *
 * For 'approve' on an approval whose card declared requiresTypedConfirmation
 * (encoded into the button's own value by renderApprovalCard, so no
 * lookup is needed to know this client side), this opens the confirmation
 * modal instead of resolving directly, per FR-APR-5. For 'edit_and_approve'
 * this always opens the edit modal, since collecting free text needs a
 * modal regardless of tier. Every other case resolves immediately.
 *
 * `action()` acks the click BEFORE this method ever runs (see
 * createLiveSlackBoltApp's own `action` wiring and its doc comment: Bolt's
 * three second ack budget can be shorter than a database round trip), so
 * by the time any code here executes, Slack has already told the operator
 * their click was received. Fix round 1, finding 4: an unhandled failure
 * from this point on used to be caught and only logged, which is a
 * genuinely dangerous shape specifically for Approve/Deny, not a merely
 * unpolished one: the operator sees their click register, nothing is
 * recorded, and they have no way to tell "not resolved yet" apart from
 * "silently dropped." Decode-and-validate failures (a malformed or
 * missing payload) stay silent, because there is no channel/messageTs to
 * report into and no legitimate click produces them; everything past that
 * point, where a channel and message ref are known, reports failure back
 * into the thread via reportResolutionFailure rather than only logging.
 */
export async function handleApprovalButton(ctx: ApprovalInteractionContext, envelope: SlackBlockActionEnvelope, option: ApprovalOption): Promise<void> {
  const action = envelope.actions[0]
  if (!action?.value) {
    ctx.log?.warn({ option }, 'SlackAdapter: approval button click carried no value; ignoring')
    return
  }
  let decoded: { approvalId?: unknown; requiresTypedConfirmation?: unknown }
  try {
    decoded = JSON.parse(action.value) as { approvalId?: unknown; requiresTypedConfirmation?: unknown }
  } catch (error) {
    ctx.log?.error({ err: error, option }, 'SlackAdapter: approval button value was not valid JSON; ignoring')
    return
  }
  if (typeof decoded.approvalId !== 'string') {
    ctx.log?.error({ option }, 'SlackAdapter: approval button value carried no approvalId; ignoring')
    return
  }
  const channel = envelope.channel?.id
  const messageTs = envelope.message?.ts
  if (!channel || !messageTs) {
    ctx.log?.error({ option }, 'SlackAdapter: approval button click carried no channel/message ref; ignoring')
    return
  }

  // From here on, channel and messageTs are known, so any failure is
  // reported back into the thread rather than only logged; see this
  // method's own doc comment.
  try {
    const needsModal =
      (option === 'approve' && decoded.requiresTypedConfirmation === true) || option === 'edit_and_approve'
    if (needsModal) {
      if (!ctx.capabilities.modals) {
        ctx.log?.error(
          { option, approvalId: decoded.approvalId },
          'SlackAdapter: this action requires a modal but modals capability is false; refusing rather than ' +
            'bypassing the safeguard it exists to enforce',
        )
        await reportResolutionFailure(ctx, channel, messageTs, option)
        return
      }
      if (!envelope.trigger_id) {
        ctx.log?.error(
          { option },
          'SlackAdapter: approval button click carried no trigger_id, cannot open a modal; ignoring',
        )
        await reportResolutionFailure(ctx, channel, messageTs, option)
        return
      }
      const meta: ModalMetadata = { approvalId: decoded.approvalId, channel, messageTs }
      const view = option === 'edit_and_approve' ? renderEditModal(meta) : renderConfirmationModal(meta)
      await ctx.apiClient.openModal({ triggerId: envelope.trigger_id, view })
      return
    }

    await resolveAndRenderCard(ctx, {
      approvalId: decoded.approvalId,
      option,
      resolverPlatformUserId: envelope.user.id,
      channel,
      messageTs,
    })
  } catch (error) {
    ctx.log?.error({ err: error, option }, 'SlackAdapter: approval button handler threw')
    await reportResolutionFailure(ctx, channel, messageTs, option)
  }
}

/**
 * FR-APR-5's confirmation modal submission: validates the typed word
 * before resolving. A mismatch or a missing value keeps the modal open
 * with an inline error (Slack's `response_action: 'errors'`) rather than
 * silently closing on a wrong answer, per confirmationMismatchError's own
 * doc comment.
 *
 * Fix round 1, finding 4: this method must never resolve with `undefined`
 * ("accept, close the modal") for anything other than a genuine terminal
 * outcome (resolved, or a known non-resolving outcome that already has
 * its own visible handling). An unwired resolver or an unexpected
 * internal error used to fall through to a plain `undefined`, which
 * closes the modal exactly as if the decision had been recorded; both now
 * keep the modal open with a truthful "not recorded" error instead. This
 * is what actually closes the "unacked view() hangs" class of bug: this
 * method is the ONE thing createLiveSlackBoltApp's `view` wiring ever
 * awaits before it can call `ack()` at all, and it never throws (both
 * branches below return a value, they do not rethrow), so `ack()` is
 * always reached with a real response to give Slack, live wiring or not.
 */
export async function handleConfirmModalSubmission(ctx: ApprovalInteractionContext, envelope: SlackViewSubmissionEnvelope): Promise<SlackViewSubmissionResponse> {
  let meta: ModalMetadata
  try {
    meta = parseModalMetadata(envelope.view.private_metadata)
  } catch (error) {
    // No channel/messageTs to report into at all: a malformed
    // private_metadata means this is not a modal this adapter ever
    // opened, an adversarial or corrupted payload, not a legitimate
    // operator flow. Logging is the honest ceiling here.
    ctx.log?.error({ err: error }, 'SlackAdapter: confirmation modal submission carried malformed private_metadata')
    return undefined
  }

  try {
    const typed = envelope.view.state.values[CONFIRM_MODAL_BLOCK_ID]?.[CONFIRM_MODAL_ACTION_ID]?.value ?? undefined

    const resolverPrincipalId = await ctx.resolvePrincipalId(envelope.user.id)
    const result = await ctx.resolveApprovalInteraction({
      approvalId: meta.approvalId,
      option: 'approve',
      resolverPlatformUserId: envelope.user.id,
      resolverPrincipalId,
      // Conditionally spread, not `typedConfirmation: typed`: same
      // exactOptionalPropertyTypes reasoning as createLiveSlackBoltApp's
      // `action` wiring above.
      ...(typed !== undefined ? { typedConfirmation: typed } : {}),
    })

    if (!result) {
      ctx.log?.warn(
        { approvalId: meta.approvalId },
        'SlackAdapter: no approval resolver is wired; ignoring modal submission',
      )
      return { response_action: 'errors', errors: internalErrorResponse(CONFIRM_MODAL_CALLBACK_ID) }
    }
    if (result.outcome === 'confirmation_required' || result.outcome === 'confirmation_mismatch') {
      return { response_action: 'errors', errors: confirmationMismatchError() }
    }
    if (result.outcome === 'resolved') {
      if (!result.approval) {
        ctx.log?.error(
          { approvalId: meta.approvalId },
          'SlackAdapter: resolveApproval returned resolved with no approval row, which should be unreachable',
        )
        return { response_action: 'errors', errors: internalErrorResponse(CONFIRM_MODAL_CALLBACK_ID) }
      }
      await renderResolvedApprovalCard(ctx, result.approval, meta.channel, meta.messageTs, envelope.user.id)
      return undefined
    }
    if (result.outcome === 'invalid_input') {
      // Fix round 2: `invalid_input` names an edit-and-approve outcome,
      // and this modal only ever submits option 'approve' (see the
      // resolveApprovalInteraction call above); resolveApproval's own
      // edit_and_approve branch is the only place that outcome comes
      // from. Reaching it here should be unreachable, and treating it as
      // an ordinary generic outcome would have rendered the EDIT modal's
      // "could not validate this as JSON" wording for an operator who
      // typed a confirmation phrase, not JSON, which is exactly the
      // wrong-surface-wording bug this branch exists to rule out.
      ctx.log?.error(
        { approvalId: meta.approvalId },
        'SlackAdapter: confirmation modal submission produced invalid_input, which should be unreachable for an approve-only resolution',
      )
      return { response_action: 'errors', errors: internalErrorResponse(CONFIRM_MODAL_CALLBACK_ID) }
    }
    // Every remaining outcome (not_found, already_resolved, expired,
    // unauthorized) used to fall through to a bare log line, closing the
    // modal as if the decision had been recorded, per fix round 1.
    // GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS's narrower type (fix round
    // 2) is what actually enforces this branch excludes every
    // context-specific outcome first: indexing it with `result.outcome`
    // only compiles once TypeScript has narrowed that type down to
    // exactly these four, which the three branches above (and 'resolved'
    // further up) are what do that narrowing.
    ctx.log?.info(
      { approvalId: meta.approvalId, outcome: result.outcome },
      'SlackAdapter: confirmation modal submission did not resolve',
    )
    return {
      response_action: 'errors',
      errors: { [CONFIRM_MODAL_BLOCK_ID]: GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS[result.outcome] },
    }
  } catch (error) {
    ctx.log?.error({ err: error }, 'SlackAdapter: confirmation modal handler threw')
    return { response_action: 'errors', errors: internalErrorResponse(CONFIRM_MODAL_CALLBACK_ID) }
  }
}

/**
 * FR-APR-2's edit-and-approve modal submission: collects the operator's
 * JSON-text replacement and resolves with it. `invalid_input` (the edited
 * value failed the capability's own schema, per
 * src/approvals/store.ts's resolveApproval) keeps the modal open with
 * editValidationError's inline message, the same non-closing shape
 * confirmationMismatchError already uses. See
 * handleConfirmModalSubmission's own doc comment for why this method
 * also never resolves `undefined` on an unwired resolver or an internal
 * error.
 */
export async function handleEditModalSubmission(ctx: ApprovalInteractionContext, envelope: SlackViewSubmissionEnvelope): Promise<SlackViewSubmissionResponse> {
  let meta: ModalMetadata
  try {
    meta = parseModalMetadata(envelope.view.private_metadata)
  } catch (error) {
    ctx.log?.error({ err: error }, 'SlackAdapter: edit modal submission carried malformed private_metadata')
    return undefined
  }

  try {
    const edited = envelope.view.state.values[EDIT_MODAL_BLOCK_ID]?.[EDIT_MODAL_ACTION_ID]?.value ?? ''

    const resolverPrincipalId = await ctx.resolvePrincipalId(envelope.user.id)
    const result = await ctx.resolveApprovalInteraction({
      approvalId: meta.approvalId,
      option: 'edit_and_approve',
      resolverPlatformUserId: envelope.user.id,
      resolverPrincipalId,
      editedArguments: edited,
    })

    if (!result) {
      ctx.log?.warn(
        { approvalId: meta.approvalId },
        'SlackAdapter: no approval resolver is wired; ignoring modal submission',
      )
      return { response_action: 'errors', errors: internalErrorResponse(EDIT_MODAL_CALLBACK_ID) }
    }
    if (result.outcome === 'invalid_input') {
      return { response_action: 'errors', errors: editValidationError() }
    }
    if (result.outcome === 'resolved') {
      if (!result.approval) {
        ctx.log?.error(
          { approvalId: meta.approvalId },
          'SlackAdapter: resolveApproval returned resolved with no approval row, which should be unreachable',
        )
        return { response_action: 'errors', errors: internalErrorResponse(EDIT_MODAL_CALLBACK_ID) }
      }
      await renderResolvedApprovalCard(ctx, result.approval, meta.channel, meta.messageTs, envelope.user.id)
      return undefined
    }
    if (result.outcome === 'confirmation_required' || result.outcome === 'confirmation_mismatch') {
      // Fix round 2: the mirror image of handleConfirmModalSubmission's
      // own invalid_input guard. resolveApproval only ever gates typed
      // confirmation for option 'approve' (see its own doc comment), and
      // this modal always submits 'edit_and_approve', so either
      // confirmation outcome here should be unreachable; treating it as
      // generic would have rendered neither the confirmation wording nor
      // anything about the edited JSON, just whichever text happened to
      // sit at that key, which is not an honest description of what the
      // operator just did.
      ctx.log?.error(
        { approvalId: meta.approvalId, outcome: result.outcome },
        'SlackAdapter: edit modal submission produced a confirmation outcome, which should be unreachable for an edit-and-approve resolution',
      )
      return { response_action: 'errors', errors: internalErrorResponse(EDIT_MODAL_CALLBACK_ID) }
    }
    // Same exhaustive, narrowed fallback as handleConfirmModalSubmission's own; see its comment.
    ctx.log?.info(
      { approvalId: meta.approvalId, outcome: result.outcome },
      'SlackAdapter: edit modal submission did not resolve',
    )
    return {
      response_action: 'errors',
      errors: { [EDIT_MODAL_BLOCK_ID]: GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS[result.outcome] },
    }
  } catch (error) {
    ctx.log?.error({ err: error }, 'SlackAdapter: edit modal handler threw')
    return { response_action: 'errors', errors: internalErrorResponse(EDIT_MODAL_CALLBACK_ID) }
  }
}

/**
 * The block id a modal's own inline error should attach to, keyed by
 * which modal's callback id is currently open: Slack's `response_action:
 * 'errors'` contract requires the key to name a real block in the
 * CURRENTLY OPEN view, so a generic "something went wrong" message still
 * has to be addressed to the right block or Slack rejects the ack itself.
 */
function internalErrorResponse(callbackId: string): Record<string, string> {
  const blockId = callbackId === EDIT_MODAL_CALLBACK_ID ? EDIT_MODAL_BLOCK_ID : CONFIRM_MODAL_BLOCK_ID
  return { [blockId]: 'Something went wrong recording this decision. Your decision was not recorded; please try again.' }
}

/**
 * Posts a threaded reply stating that a button-click resolution did not
 * happen, per fix round 1: the ONE place handleApprovalButton's own
 * failure paths (an unwired resolver, a modal that could not be opened,
 * an unexpected throw) reach, so a click that fails never looks
 * indistinguishable from one that quietly succeeded. Threaded off the
 * approval card's own message (`thread: messageTs`), not a bare channel
 * post, so it reads as attached to the card it is about, and best-effort:
 * a failure reporting the failure is logged, not thrown, since there is
 * no further fallback surface left to report THAT to.
 */
async function reportResolutionFailure(ctx: ApprovalInteractionContext, channel: string, messageTs: string, option: ApprovalOption): Promise<void> {
  await postThreadNotice(ctx, 
    channel,
    messageTs,
    `Your "${option}" could not be recorded due to an internal error. ` +
      'The approval is still pending; please try again.',
  )
}

/**
 * Reports a known, non-'resolved' store outcome (not_found,
 * already_resolved, expired, or unauthorized; the confirmation/edit
 * outcomes have their own dedicated modal handling and never reach a
 * button-click caller of this method) back into the thread. Fix round 1:
 * these four used to produce only a log line, indistinguishable from the
 * operator's own eyes from a click that was still silently in flight.
 * expired and already_resolved in particular are easy to conflate ("you
 * were too late" vs. "someone else already answered"), which is exactly
 * why each gets its own wording from UNRESOLVED_OUTCOME_DESCRIPTIONS
 * rather than one generic "did not work" message.
 */
async function reportOutcome(ctx: ApprovalInteractionContext, channel: string, messageTs: string, outcome: Exclude<ResolveOutcome, 'resolved'>): Promise<void> {
  await postThreadNotice(ctx, channel, messageTs, UNRESOLVED_OUTCOME_DESCRIPTIONS[outcome])
}

/** Shared by reportResolutionFailure and reportOutcome: posts `text` threaded off the approval card's own message, best-effort (a failure here is logged, not thrown, since there is no further fallback surface left to report THAT to). */
async function postThreadNotice(ctx: ApprovalInteractionContext, channel: string, messageTs: string, text: string): Promise<void> {
  try {
    await ctx.callApi(() => ctx.apiClient.postMessage({ channel, thread: messageTs, text }))
  } catch (error) {
    ctx.log?.error({ err: error }, 'SlackAdapter: failed to post an approval status notice back to the thread')
  }
}

/**
 * The shared "resolve directly, then update the card" path for deny,
 * plain approve, and approve-all-session: none of these need a modal,
 * per handleApprovalButton's own needsModal check. Throws are left to
 * propagate to handleApprovalButton's own try/catch, which is what
 * reports failure back into the thread; an unwired resolver is not a
 * throw, so it is reported here directly instead, per fix round 1.
 */
async function resolveAndRenderCard(ctx: ApprovalInteractionContext, params: {
  approvalId: string
  option: ApprovalOption
  resolverPlatformUserId: string
  channel: string
  messageTs: string
}): Promise<void> {
  const resolverPrincipalId = await ctx.resolvePrincipalId(params.resolverPlatformUserId)
  const result = await ctx.resolveApprovalInteraction({
    approvalId: params.approvalId,
    option: params.option,
    resolverPlatformUserId: params.resolverPlatformUserId,
    resolverPrincipalId,
  })

  if (!result) {
    ctx.log?.warn(
      { approvalId: params.approvalId },
      'SlackAdapter: no approval resolver is wired; ignoring interaction',
    )
    await reportResolutionFailure(ctx, params.channel, params.messageTs, params.option)
    return
  }
  if (result.outcome === 'resolved') {
    if (!result.approval) {
      // Should be impossible: resolveApproval's own contract only omits
      // `approval` for 'not_found'. Reported the same way an internal
      // failure is, rather than silently doing nothing, if it ever
      // happens anyway.
      ctx.log?.error(
        { approvalId: params.approvalId },
        'SlackAdapter: resolveApproval returned resolved with no approval row, which should be unreachable',
      )
      await reportResolutionFailure(ctx, params.channel, params.messageTs, params.option)
      return
    }
    await renderResolvedApprovalCard(ctx, result.approval, params.channel, params.messageTs, params.resolverPlatformUserId)
    return
  }
  if (result.outcome === 'invalid_input') {
    // Fix round 2: unreachable in practice. This path only ever resolves
    // 'deny', 'approve' (with the button's own value already having
    // established requiresTypedConfirmation is false), or
    // 'approve_all_session' (see handleApprovalButton's needsModal
    // check, which sends 'edit_and_approve' to a modal unconditionally,
    // never here). resolveApproval only ever returns invalid_input for
    // option 'edit_and_approve'.
    ctx.log?.error(
      { approvalId: params.approvalId },
      'SlackAdapter: button-click resolution produced invalid_input, which should be unreachable outside edit_and_approve',
    )
    await reportResolutionFailure(ctx, params.channel, params.messageTs, params.option)
    return
  }
  if (result.outcome === 'confirmation_required' || result.outcome === 'confirmation_mismatch') {
    // Fix round 2, a deliberate decision, not a side effect: this path
    // is entered when the button's OWN encoded value said
    // requiresTypedConfirmation is false (see handleApprovalButton's
    // needsModal check), so under normal operation resolveApproval
    // should never disagree, since that field is fixed at approval
    // creation and never changes afterward. It CAN still happen if a
    // caller renders a stale or mismatched card. Rather than silently
    // doing nothing on that mismatch (the pre-fix-round-1 behaviour this
    // whole class of finding is about), this posts the same wording the
    // confirmation modal itself would show. The text is accurate
    // regardless of which surface displays it ("type CONFIRM to
    // approve" is true whether read in a modal or a thread reply), so
    // this is not the wrong-surface-wording bug the invalid_input branch
    // above guards against; it is a legitimate fallback for a state that
    // should not arise, kept visible rather than silent. Tested
    // explicitly in test/chat/slack/adapter.test.ts.
    ctx.log?.warn(
      { approvalId: params.approvalId, outcome: result.outcome },
      'SlackAdapter: button-click resolution required typed confirmation the button itself did not request; reporting rather than silently dropping',
    )
    await reportOutcome(ctx, params.channel, params.messageTs, result.outcome)
    return
  }
  ctx.log?.info(
    { approvalId: params.approvalId, outcome: result.outcome },
    'SlackAdapter: approval interaction did not resolve',
  )
  await postThreadNotice(ctx, params.channel, params.messageTs, GENERIC_UNRESOLVED_OUTCOME_DESCRIPTIONS[result.outcome])
}

/**
 * Replaces a resolved approval's card in place, per FR-SL-5: the card
 * must stop looking pending the moment it is acted on. Bypasses the
 * ChatAction contract (src/chat/contract.ts's 'edit' carries text only,
 * no blocks) and calls the Slack API client directly, since Block Kit
 * rendering is specific to the Slack adapter's own approval handling, not
 * something the platform-neutral contract supports yet; see
 * SlackUpdateMessageArgs's own doc comment.
 */
async function renderResolvedApprovalCard(
  ctx: ApprovalInteractionContext,
  approval: Approval,
  channel: string,
  messageTs: string,
  resolverPlatformUserId: string,
): Promise<void> {
  if (!approval.selectedOption) return
  const card = renderResolvedCard({
    approvalId: approval.id,
    capability: approval.capability,
    description: approval.description,
    target: approval.target,
    tier: approval.tier,
    escalationReason: approval.escalationReason,
    runId: approval.runId,
    sessionId: approval.sessionId,
    // The card only has the requester's Relay principal id available here,
    // not a nice display name: that lookup belongs to whoever posts the
    // ORIGINAL card (a later wiring task, per the
    // resolveApprovalInteraction doc comment), which has the display name
    // to hand already. resolverDisplayName below is different: it comes
    // straight from this interaction's own Slack payload, so it can be a
    // real mention.
    requesterDisplayName: approval.requesterPrincipalId,
    requiresTypedConfirmation: approval.requiresTypedConfirmation,
    status: approval.status,
    selectedOption: approval.selectedOption,
    resolverDisplayName: `<@${resolverPlatformUserId}>`,
    resolvedAtIso: approval.resolvedAt ?? new Date().toISOString(),
    editedArguments: approval.editedArguments,
  })
  await ctx.callApi(() =>
    ctx.apiClient.updateMessage({ channel, ts: messageTs, text: card.text, blocks: card.blocks }),
  )
}
