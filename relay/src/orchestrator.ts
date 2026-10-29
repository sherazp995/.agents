/**
 * Wires a ChatEvent end to end: resolve workspace and principal, fail
 * closed if unmapped, find or create a session for its thread, create a
 * run, build a bound context, execute the loop, report progress through
 * the dispatcher into the session's thread, and post a final report. This
 * is Task 8 of the P0.3 orchestrator milestone, and the file that makes a
 * Slack message become a real run rather than a canned reply.
 *
 * Three commitments close here, per docs/decisions/open-questions.md:
 *
 *   - PRE-1 (wire the durable outbox into production). scheduleOutboxDrain
 *     below is what actually calls OutboundDispatcher.drain() in a running
 *     process. Nothing before this task ever did; an enqueued action sat in
 *     Postgres forever.
 *   - PRE-2 (fail closed without a mapped principal). handleChatEvent's
 *     first branch below is the enforcement half; Task 1 already did the
 *     provisioning half.
 *   - PRE-4 (wire isKnownSession to the real session store).
 *     createProductionSlackAdapter's isKnownSession closure, backed by
 *     isKnownSessionQuery, is what replaces Task 3's always-false default.
 *
 * PRE-5 (bind a RunContext at the session boundary) closes here too, but
 * indirectly: sessionRunContext (src/sessions/context.ts) already existed
 * with no production caller. handleChatEvent below is that caller.
 */

import { startAutonomousRuntime, type AutonomousRuntime, type AutonomousRuntimeOptions } from './autonomous/runtime.js'
import type { Pool } from 'pg'
import type { Capability, AgentLoopLimits, AgentLoopResult, Engine } from './agent/loop.js'
import { runAgentLoop } from './agent/loop.js'
// Fix round 1 addendum, item 1: an explicit call, not a bare side-effect
// import. registerBuiltinCapabilities() (src/capabilities/wiring.ts) is
// where every capability module this milestone ships actually gets
// registered; defaultCapabilities() below calls it directly, so nothing
// here depends on import order or on some other file having imported a
// capability module first.
import { registerBuiltinCapabilities } from './capabilities/wiring.js'
import { buildCapabilityMap, getCapability } from './capabilities/registry.js'
import { unwrapForAudit } from './agent/untrusted.js'
import type { RequestApproval } from './policy/engine.js'
import type { Policy } from './config/schema.js'
import type { ChatAdapter, ChatEvent, ChatRef } from './chat/contract.js'
import { isStopInstruction, sessionRefFor } from './chat/contract.js'
import type { OutboxDrainResult } from './chat/outbox.js'
import { ProgressReporter, truncateToBytes } from './chat/progress.js'
import { resolvePrincipal } from './chat/principals.js'
import type { SecretProvider } from './secrets/provider.js'
import { SlackAdapter, composeThreadRef } from './chat/slack/adapter.js'
import { createRealAttachThreadToSession, listRecentEngineSessions } from './chat/slack/session-attach.js'
import type { SlackAdapterCreateOptions } from './chat/slack/adapter.js'
import { OutboundDispatcher } from './dispatch/outbound.js'
import type { OutboundDispatcherOptions } from './dispatch/outbound.js'
import type { Logger } from './obs/logger.js'
import { scrubSecrets } from './secrets/scrubber.js'
import type { RelayConfig } from './config/schema.js'
import { resolveApproval, type ResolveApprovalResult } from './approvals/store.js'
import { sessionRunContext } from './sessions/context.js'
import { findActiveSession, findOrCreateSession, markSessionDirect, setSessionEngineSessionId } from './sessions/store.js'
import { continueDirectSession, startDirectSession } from './live/direct-router.js'
import { CancellationRegistry } from './runs/cancel.js'
import {
  buildReplyCommand,
  enqueueLiveControlMessage,
  isLiveControlled,
  takeBackMessage,
  waitForClaim,
} from './live/control.js'
import { deliverViaCourier } from './live/courier.js'
import { findOpenSessionName } from './live/open-session.js'
import { KillSwitchEngagedError, PostgresKillSwitchStore, createKillSwitch } from './killswitch.js'
import type { KillSwitch } from './killswitch.js'
import { createRun, finishRun, findActiveRunForSession } from './runs/store.js'
import { resolveWorkspaceId } from './tenancy/workspaces.js'

/**
 * How long a parked message waits for a live session to collect it before
 * Relay answers it itself.
 *
 * This was 20 seconds, chosen for a consumer blocked on a queue, which wakes
 * in milliseconds. That was wrong for the consumer that actually matters. A
 * Stop hook collects at TURN BOUNDARIES, and a turn can run for minutes, so
 * a 20 second grace meant Relay reliably took the message back and answered
 * from a cold session before the live one ever had a chance. Observed: the
 * operator's message was answered by the fallback while the live session was
 * mid-turn, which is the exact opposite of what attaching a session is for.
 *
 * Three minutes covers a long turn. The cost of being generous here is a
 * slower fallback for a genuinely dead session, and that cost is paid for by
 * the immediate acknowledgement below: the operator is never left wondering
 * whether anything is happening, which was the real problem a short grace
 * was trying to solve.
 */
const DEFAULT_LIVE_CONTROL_GRACE_MS = 180_000

// ---------------------------------------------------------------------------
// PRE-4: isKnownSession backed by the real session store.
// ---------------------------------------------------------------------------

/**
 * Answers SlackAdapter's `isKnownSession(threadRef)` question against the
 * real `sessions` table, per PRE-4. Mirrors the exact predicate
 * `sessions_workspace_adapter_thread_active_key` (0004_sessions.sql)
 * indexes on: workspace, adapter, thread_ref, state = 'active'. An archived
 * session's thread therefore reads as "not known" here too, matching
 * findOrCreateSession's own documented behaviour that a later message in an
 * archived thread starts a fresh session rather than resurrecting the old
 * one.
 */
export async function isKnownSessionQuery(
  pool: Pool,
  workspaceId: string,
  adapter: string,
  threadRef: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM sessions WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3 AND state = 'active' LIMIT 1`,
    [workspaceId, adapter, threadRef],
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Wiring a real SlackAdapter: resolveWorkspaceId, resolvePrincipalId, and
// isKnownSession, all backed by Postgres, closing PRE-2's resolution half,
// PRE-3, and PRE-4 at the one place they compose.
// ---------------------------------------------------------------------------

export type CreateProductionSlackAdapterOptions = Omit<
  SlackAdapterCreateOptions,
  'resolveWorkspaceId' | 'resolvePrincipalId' | 'isKnownSession' | 'resolveApprovalInteraction'
> & {
  /** The daemon's approval receipt key; when set, every resolved approval is signed (src/approvals/receipt.ts). */
  approvalReceiptKey?: Uint8Array
  /** Told about every resolution, so the autonomous scheduler can wake the task an approval belongs to. */
  onApprovalResolved?: (result: ResolveApprovalResult) => Promise<void>
}

/**
 * Builds a real SlackAdapter whose workspace mapping, principal resolution,
 * and thread recognition all read from `pool` rather than from the
 * always-false and always-null defaults SlackAdapter itself ships with.
 *
 * THE ORDERING TRICK, stated because it looks like a chicken-and-egg
 * problem until it is not: `resolvePrincipalId` and `isKnownSession` both
 * need this adapter's own workspace uuid, but that uuid is not known until
 * `resolveWorkspaceId` itself resolves, which happens INSIDE
 * `SlackAdapter.create`, using the very options object being built here.
 * The fix is a single closure variable, `resolvedWorkspaceId`, written by
 * `resolveWorkspaceId`'s own callback and read by the other two. This is
 * safe, not a race, because of `SlackAdapter.create`'s own documented
 * sequencing: it awaits `resolveWorkspaceId` and only then constructs the
 * adapter, and `resolvePrincipalId`/`isKnownSession` are never called until
 * `adapter.start()` runs later, well after `create` has returned. By then
 * `resolvedWorkspaceId` is always set; the `undefined` branches below exist
 * only so the type checker sees a total function, not because that branch
 * is ever reachable in practice.
 */
export async function createProductionSlackAdapter(
  pool: Pool,
  secrets: SecretProvider,
  options: CreateProductionSlackAdapterOptions = {},
): Promise<{ adapter: SlackAdapter; workspaceId: string }> {
  let resolvedWorkspaceId: string | undefined

  const { approvalReceiptKey, onApprovalResolved, ...adapterOptions } = options
  const adapter = await SlackAdapter.create(secrets, {
    ...adapterOptions,
    resolveWorkspaceId: async (platform, platformTeamId) => {
      resolvedWorkspaceId = await resolveWorkspaceId(pool, platform, platformTeamId)
      return resolvedWorkspaceId
    },
    resolvePrincipalId: async (platformUserId) => {
      if (!resolvedWorkspaceId) return null
      return resolvePrincipal(pool, resolvedWorkspaceId, 'slack', platformUserId)
    },
    isKnownSession: async (threadRef) => {
      if (!resolvedWorkspaceId) return false
      return isKnownSessionQuery(pool, resolvedWorkspaceId, 'slack', threadRef)
    },
    // FR-ATT-5: the session picker's two real implementations. Without
    // these the adapter falls back to its own documented defaults, an empty
    // list and an undefined attach, so every listing reports "no sessions
    // found" and every attach reports "not available right now". Both
    // failures look like an empty machine rather than like missing wiring,
    // which is exactly the shape this project has twice mistaken for
    // working functionality.
    //
    // `attachThreadToSession` uses the same closure variable as the two
    // above, and for the same reason it is safe: it is never called until
    // `adapter.start()` runs, well after `create` has returned and set it.
    listRecentSessions: listRecentEngineSessions,
    // `/direct` (FR-ATT-30). The handler posts its own first message,
    // because that message's ts becomes the thread this session lives in,
    // and only here is it known what to record against it.
    onDirectCommand: async ({ channelId, userId, text, post }) => {
      if (!resolvedWorkspaceId) {
        await post('Relay is still starting up. Try again in a moment.')
        return
      }

      const outcome = await startDirectSession({ text, defaultDirectory: process.cwd() })
      if (outcome.outcome !== 'started') {
        await post(outcome.text)
        return
      }

      // Resolved BEFORE the session is posted about, so an unknown principal
      // fails before a thread exists claiming to be a working session.
      const principalId = await resolvePrincipal(pool, resolvedWorkspaceId, 'slack', userId)
      if (principalId === null) {
        // Unmapped senders get no reply, as in handleChatEvent.
        options.log?.warn({ workspaceId: resolvedWorkspaceId, platformUserId: userId }, 'ignored /direct from an unmapped principal')
        return
      }

      const posted = await post(outcome.text)
      const session = await findOrCreateSession(pool, {
        workspaceId: resolvedWorkspaceId,
        principalId,
        adapter: 'slack',
        threadRef: composeThreadRef(channelId, posted.ts),
      })
      await markSessionDirect(pool, session.id, outcome.sessionId, outcome.cwd)

      // Posted INTO the thread the message above just created, so the
      // session's first answer is where every later one will be. Scrubbed
      // for the same reason every other reply path here is: this text came
      // from a session that reads arbitrary files.
      if (outcome.reply !== undefined && outcome.reply.trim() !== '') {
        await post(scrubSecrets(outcome.reply), posted.ts)
      }
    },
    attachThreadToSession: async (params) => {
      if (!resolvedWorkspaceId) return undefined
      return createRealAttachThreadToSession(pool, resolvedWorkspaceId)(params)
    },
    // A click resolves the approval row it names. Until this binding the
    // adapter's default resolver was a no-op, so no click resolved anything.
    resolveApprovalInteraction: async (request) => {
      if (!resolvedWorkspaceId) return undefined
      const result = await resolveApproval(pool, {
        workspaceId: resolvedWorkspaceId,
        approvalId: request.approvalId,
        option: request.option,
        resolverPrincipalId: request.resolverPrincipalId,
        ...(request.typedConfirmation !== undefined ? { typedConfirmation: request.typedConfirmation } : {}),
        ...(request.editedArguments !== undefined ? { editedArguments: request.editedArguments } : {}),
        ...(approvalReceiptKey !== undefined ? { receiptKey: approvalReceiptKey } : {}),
      })
      // The decision is already committed; a failed wakeup must not read as a failed click.
      if (result.outcome === 'resolved' && onApprovalResolved) {
        await onApprovalResolved(result).catch((error: unknown) => {
          options.log?.error({ err: error, approvalId: request.approvalId }, 'approval resolved but notifying the scheduler failed')
        })
      }
      return result
    },
  })

  if (!resolvedWorkspaceId) {
    throw new Error(
      'createProductionSlackAdapter: SlackAdapter.create returned without ever resolving a ' +
        'workspace id. This should be impossible: create() always awaits resolveWorkspaceId ' +
        'before returning.',
    )
  }

  return { adapter, workspaceId: resolvedWorkspaceId }
}

// ---------------------------------------------------------------------------
// PRE-2: fail closed without a mapped principal.
// ---------------------------------------------------------------------------

/**
 * Reads the platform's own sender id back out of `event.raw`, for a log
 * line only, via `unwrapForAudit`: exactly that function's own sanctioned
 * "I am reading this for audit, not to build a prompt with it" use case.
 *
 * WHY THIS EXISTS, per a fix round finding: `resolvePrincipal` correctly
 * refuses to auto-create an identity, and the fail closed branch below
 * correctly refuses to act for one, but until this existed there was no
 * way for an operator to discover the id `relay principals add`
 * (src/cli/principals.ts) needs to provision themselves with. `ChatEvent`
 * carries no first-class platform user id field, and per FR-SLA-5 the
 * Slack app is never granted `users:read`, so there is no API path to look
 * one up either; `event.raw` is the only source of truth left.
 *
 * Reads ONLY the `user` field, and only for a log line, never anything
 * else from the raw payload and never a value that reaches chat: a Slack
 * user id is an opaque, workspace-scoped identifier Slack's own UI already
 * displays to every member, not a secret, but the message TEXT sitting
 * right next to it in the same raw payload very much can be (a pasted
 * password, for instance), which is exactly the shape of leak an earlier
 * gate already caught once in scripts/slack-smoke.ts. This function must
 * never grow into reading anything beyond `user`.
 */
function extractPlatformUserId(event: ChatEvent): string | undefined {
  const raw = unwrapForAudit(event.raw)
  if (typeof raw !== 'object' || raw === null) return undefined
  const userId = (raw as Record<string, unknown>).user
  return typeof userId === 'string' ? userId : undefined
}

// ---------------------------------------------------------------------------
// The final report, per FR-SL-6 and FR-RPT-5.
// ---------------------------------------------------------------------------

const RUN_STATE_OUTCOME: Record<AgentLoopResult['state'], string> = {
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  dead_letter: 'dead-lettered: the run got stuck repeating the same step and could not make progress',
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/**
 * FR-RPT-10's bound on the answer specifically, independent of whatever
 * byte limit the chat adapter enforces on the report as a whole
 * (ProgressReporter's own summarizeForLimit, keyed off
 * ChatAdapter.capabilities.maxMessageBytes, Slack's 40,000 byte ceiling).
 * An answer anywhere near that ceiling would already read as long content
 * on a phone screen long before the whole report got there. 1,500 bytes is
 * generous for a direct paragraph or two, small enough that even a
 * maximally verbose engine reply still reads as a chat message, not a
 * document.
 */
const ANSWER_MAX_BYTES = 1_500

/**
 * Bounds `answer` to ANSWER_MAX_BYTES without ever cutting it off silently.
 * An answer over the bound is cut to a byte safe prefix and a marker is
 * appended that states plainly it was shortened and by how much, matching
 * src/chat/progress.ts's summarizeForLimit, which solves the identical
 * problem for a whole outbound message; this is the answer specific
 * version, so an oversized answer is dealt with honestly here rather than
 * only being caught later by that whole message limit, well after the
 * bookkeeping lines below it would already have been at risk of being cut
 * along with it.
 */
function boundAnswerForChat(answer: string): string {
  const bytes = Buffer.byteLength(answer, 'utf8')
  if (bytes <= ANSWER_MAX_BYTES) return answer

  const marker =
    `\n[Answer shortened: the full answer was ${bytes} bytes, over this report's ${ANSWER_MAX_BYTES} ` +
    'byte bound for chat, so only the beginning is shown here.]'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const prefixBudget = Math.max(0, ANSWER_MAX_BYTES - markerBytes)
  return truncateToBytes(answer, prefixBudget) + marker
}

/**
 * The report's leading line, per this file's usability fix: the engine's
 * own answer, scrubbed and bounded, or an explicit statement that none was
 * recorded.
 *
 * Scrubbed through scrubSecrets BEFORE boundAnswerForChat, not after: the
 * answer is untrusted output reasoning over untrusted input (AP-2), the
 * same as every other outbound text this file composes (see
 * buildUnexpectedFailureReport's own scrubSecrets call just below), and
 * scrubbing after bounding could cut a registered secret exactly at its own
 * boundary, leaving half of it, still readable, in the shortened prefix.
 *
 * `undefined` (AgentLoopResult.answer's own contract: the engine gave no
 * usable answer text for this run) is rendered as an explicit sentence
 * rather than a bare "Answer:" line, so a reader can tell "nothing was
 * recorded" apart from a formatting bug.
 */
function formatAnswerLine(answer: string | undefined): string {
  if (answer === undefined) return 'Answer: Relay did not record a direct answer for this run.'
  return `Answer: ${boundAnswerForChat(scrubSecrets(answer))}`
}

/**
 * FR-ATT-5's disclosure requirement, stated by the team as its own
 * principle: what the operator asked for was their message landing in the
 * chat that is already open; what a fork actually gives them, when the
 * routing rule chose it, is a NEW chat carrying the full prior context. A
 * good outcome, and the honest one given the concurrency risk this
 * milestone's own investigation demonstrated, but not literally what they
 * asked for, and a fork that presents identically to a resume would be its
 * own quiet deception, the same principle FR-APR-10 states for a paused
 * run never looking like a working one. `undefined` (no attach scenario at
 * all for this run) omits the line entirely, same as every other
 * conditional line in this report.
 */
function formatAttachmentLine(outcome: AgentLoopResult['attachmentOutcome']): string | undefined {
  if (outcome === 'resumed') return 'Attachment: continued the existing chat in that folder.'
  if (outcome === 'forked') {
    return 'Attachment: started a new chat branching from the existing one in that folder, ' +
      'since it looked like it might already be in use.'
  }
  return undefined
}

/**
 * Whether `result` gets the compact report format below rather than the
 * full FR-SL-6 bookkeeping block. Compact applies to exactly one shape: a
 * SUCCEEDED run that executed zero steps, which is what a purely
 * conversational reply looks like (the plan's `firstAction` was null, so
 * the decision loop never ran at all; see loop.ts's own PlanResponse
 * doc comment). Every other shape, including a zero-step FAILED or
 * CANCELLED run (planning itself failed or was cancelled before any step
 * was attempted), gets the full block, because a failure must always state
 * its outcome prominently regardless of step count, and the full block is
 * what puts "Outcome:" on its own line right under the answer.
 */
function isCompactReport(result: AgentLoopResult): boolean {
  return result.state === 'succeeded' && result.stepsExecuted === 0
}

/**
 * Turns one AgentLoopResult into the message FR-SL-6 requires. The answer
 * leads, per this file's usability fix: an operator who asked a question
 * wants to read what Relay concluded before the machinery that produced it.
 *
 * ADAPTIVE, per the fix that added isCompactReport: a zero-step
 * conversational answer is not an audit of a run that did something, it IS
 * the reply, so the bookkeeping tail that follows it is trimmed to what
 * still matters for a message the operator pays real money for, cost and
 * duration, rather than restating "0 steps executed", a "what changed"
 * line that can only ever describe a capability that never ran, and a "not
 * independently verified" line whose entire subject (capability calls)
 * does not exist for this run. A run that executed at least one step, or
 * that failed or was cancelled at any step count, keeps the full block:
 * outcome, what was done, what changed, cost, duration, warnings, and not
 * independently verified, each on its own labelled line so a reader, or a
 * test, can find any one of them without parsing free text. A defined
 * answer never stands in for the outcome line in the full block: a failed
 * or cancelled run still states that plainly right below the answer, which
 * is additional context, not a replacement verdict.
 *
 * FR-RPT-5: the loop's own `notVerified` list, always non-empty per
 * AgentLoopResult's own contract, is included as its own line in the full
 * block rather than folded silently into "what was done", so a run that
 * succeeded still states plainly what it did not independently verify.
 * Dropped entirely from the compact block, per the fix above: a run with no
 * capability calls has nothing for that line to honestly describe.
 *
 * WARNINGS is the one line the compact block still carries when non-empty,
 * for example the FR-SES-1 resume-degrade note loop.ts's `noteResumeDegraded`
 * adds: "brief" must never mean "hides that continuity was lost", so a
 * zero-step run still surfaces a real warning; it only omits the line
 * entirely, rather than printing "Warnings: none", when there is nothing to
 * say.
 *
 * FR-RPT-10: nothing here can ever be a diff, a file body, or a raw log.
 * AgentLoopResult carries only a state, counts, a cost, and short strings
 * the loop itself already composed (see loop.ts's own warnings, answer, and
 * notVerified entries), so there is no long content this function could
 * accidentally surface beyond the answer itself, which formatAnswerLine
 * already bounds. "What changed" is always the same honest line, because
 * echo, the one capability this milestone ships, never touches anything on
 * the operator's machine; a future capability that does would need this
 * function to say something real here instead.
 */
/**
 * FR-PRF-10 and FR-BR-8, in the one place the operator actually reads.
 *
 * These lines come from the capabilities themselves
 * (`CapabilityDefinition.reportLines`), not from the model's answer. That
 * distinction is the point: "this page showed a CAPTCHA" and "acted in the
 * acme-client profile" both used to reach the model and then depend on it
 * choosing to repeat them. A safety property that holds only when a model
 * remembers is not a safety property.
 *
 * Bounded, because a chat message is not a log file, and stated as
 * truncated rather than silently cut.
 */
const MAX_REPORTED_NOTICES = 8

function formatNoticeLines(notices: readonly string[]): readonly string[] {
  if (notices.length === 0) return []
  const shown = notices.slice(0, MAX_REPORTED_NOTICES)
  const lines = shown.map((notice) => `- ${notice}`)
  if (notices.length > shown.length) {
    lines.push(`- (${notices.length - shown.length} further notes are on the run record.)`)
  }
  return ['Noted:', ...lines]
}

/**
 * What this run could have changed on the operator's machine, derived from
 * the capabilities it actually used.
 *
 * THIS LINE WAS A HARDCODED LIE for exactly as long as it took to add a
 * second capability. It read "nothing on the operator's machine. This
 * milestone's only capability, echo, reads its input back and never
 * modifies anything", which stopped being true the moment `browser` could
 * drive a real browser, sign into real sites and write downloaded files to
 * disk. It is now derived from the registry's own idempotency classes, so
 * it cannot fall out of step with what Relay can do.
 */
function formatWhatChangedLine(capabilitiesUsed: readonly string[]): string {
  if (capabilitiesUsed.length === 0) {
    return 'What changed: nothing; no capability was executed.'
  }

  const mutating = capabilitiesUsed.filter((name) => {
    const definition = getCapability(name)
    return definition !== undefined && definition.idempotencyClass !== 'safe'
  })

  if (mutating.length === 0) {
    return `What changed: nothing. Every capability this run used (${capabilitiesUsed.join(', ')}) is registered as having no observable effect.`
  }
  return (
    `What changed: this run used ${mutating.join(', ')}, which can have real effects outside Relay. ` +
    'See the notes above and the run record for what each call actually did.'
  )
}

export function buildFinalReport(result: AgentLoopResult, startedAt: Date, endedAt: Date): string {
  const costLine = `Cost: $${result.costUsd.toFixed(4)}`
  const durationLine = `Duration: ${formatDuration(endedAt.getTime() - startedAt.getTime())}`

  const attachmentLine = formatAttachmentLine(result.attachmentOutcome)

  if (isCompactReport(result)) {
    const lines = [formatAnswerLine(result.answer)]
    if (attachmentLine !== undefined) lines.push(attachmentLine)
    lines.push(...formatNoticeLines(result.capabilityNotices))
    lines.push(costLine, durationLine)
    if (result.warnings.length > 0) lines.push(`Warnings: ${result.warnings.join(' ')}`)
    return lines.join('\n')
  }

  const stepWord = result.stepsExecuted === 1 ? 'step' : 'steps'
  const lines = [formatAnswerLine(result.answer)]
  if (attachmentLine !== undefined) lines.push(attachmentLine)
  lines.push(...formatNoticeLines(result.capabilityNotices))
  lines.push(
    `Outcome: ${RUN_STATE_OUTCOME[result.state]}`,
    `What was done: ${result.stepsExecuted} ${stepWord} executed.`,
    formatWhatChangedLine(result.capabilitiesUsed),
    costLine,
    durationLine,
    `Warnings: ${result.warnings.length > 0 ? result.warnings.join(' ') : 'none'}`,
    `Not independently verified: ${result.notVerified.join(' ')}`,
  )
  return lines.join('\n')
}

/**
 * The report handleChatEvent posts when runAgentLoop itself throws, rather
 * than returning a normal AgentLoopResult: an unexpected exception (a
 * database blip mid-run, for one) that the loop's own try/finally does not
 * convert into a terminal run state. Without this, the thread would be left
 * showing only the opening "getting started" message forever, which reads
 * to the operator as Relay having silently hung, indistinguishable from a
 * process that crashed with no trace. `error`'s message is scrubbed before
 * it can reach chat, per FR-SEC-2: an unexpected exception has had no
 * chance to pass through any of the loop's own construction-site redaction.
 */
function buildUnexpectedFailureReport(error: unknown, startedAt: Date, endedAt: Date): string {
  const message = error instanceof Error ? error.message : String(error)
  const lines = [
    'Outcome: failed',
    'What was done: the run could not complete because of an unexpected internal error.',
    "What changed: nothing on the operator's machine.",
    'Cost: unknown; the run did not finish normally.',
    `Duration: ${formatDuration(endedAt.getTime() - startedAt.getTime())}`,
    'Warnings: none',
    `Not independently verified: ${scrubSecrets(message)}`,
  ]
  return lines.join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Gate fix, Blocker 1: the production Stop path. See
// src/chat/contract.ts's isStopInstruction for how a Stop is expressed, and
// src/chat/slack/adapter.ts's #handleRawEnvelope for why it bypasses
// #deliveryQueue to reach here at all: without that, a Stop for a
// long-running run would queue behind the very run it is trying to cancel
// and could never arrive in time to meet GT-14's five second bound.
// ---------------------------------------------------------------------------

/**
 * Handles a Stop instruction: finds the active session for the thread it
 * arrived in, finds that session's currently running run, and cancels it
 * through `cancellationRegistry`. A lookup only, never a creating act
 * (findActiveSession, not findOrCreateSession): a Stop must never conjure a
 * session or a run into existence, only interrupt one that already exists.
 *
 * Every branch replies with exactly one short, durable message (through
 * `dispatcher`, so it survives a crash the same way every other outbound
 * message in this file does), so the sender always learns the outcome:
 * nothing to stop, or a cancellation was requested. `cancellationRegistry`
 * absent (a caller that did not wire one) is reported rather than silently
 * doing nothing, because a Stop instruction that appears to be honoured but
 * is not would be worse than one that visibly failed.
 */
async function handleStopInstruction(
  deps: OrchestratorDeps,
  event: ChatEvent,
  threadRef: string,
  replyRef: ChatRef,
): Promise<void> {
  const { pool, dispatcher, log, cancellationRegistry } = deps

  // An autonomous task has no in-process run to cancel: its Stop is durable
  // (worker tree killed, operations cancelled, approvals expired) and needs
  // no cancellation registry.
  const session = await findActiveSession(pool, { workspaceId: event.workspaceId, adapter: event.adapter, threadRef })
  if (session && session.mode === 'autonomous' && deps.autonomous && (await deps.autonomous.stopSession(session.id))) {
    log.info({ sessionId: session.id }, 'received a Stop instruction; autonomous task stopped')
    await dispatcher.perform({ kind: 'post', ref: replyRef, text: 'Stopped.' })
    return
  }

  if (!cancellationRegistry) {
    log.error({ workspaceId: event.workspaceId, adapter: event.adapter }, 'received a Stop instruction but no CancellationRegistry was wired into this process; cannot cancel anything')
    await dispatcher.perform({
      kind: 'post',
      ref: replyRef,
      text: 'Stop is not available right now, so nothing was cancelled.',
    })
    return
  }

  if (!session) {
    await dispatcher.perform({ kind: 'post', ref: replyRef, text: 'Nothing to stop here.' })
    return
  }

  const run = await findActiveRunForSession(pool, session.id)
  if (!run) {
    await dispatcher.perform({ kind: 'post', ref: replyRef, text: 'Nothing to stop here.' })
    return
  }

  cancellationRegistry.cancel(run.id, 'stopped by operator via chat')
  log.info({ runId: run.id, sessionId: session.id }, 'received a Stop instruction; cancellation requested')
  await dispatcher.perform({
    kind: 'post',
    ref: replyRef,
    text: 'Stopping.',
  })
}

// ---------------------------------------------------------------------------
// handleChatEvent: the pipeline itself.
// ---------------------------------------------------------------------------

export type OrchestratorDeps = {
  readonly pool: Pool
  /** Every outbound send goes through this, per PRE-1: production code always passes an OutboundDispatcher, never a raw ChatAdapter. */
  readonly dispatcher: ChatAdapter
  readonly log: Logger
  readonly capabilities: Readonly<Record<string, Capability>>
  readonly limits?: AgentLoopLimits
  /** Injected for tests, per DEC-1's own test discipline: production never sets this, so runAgentLoop falls back to the real claude engine. */
  readonly engine?: Engine
  readonly cancellationRegistry?: CancellationRegistry
  /**
   * FR-POL-9's global stop. Optional: absent means no kill switch is
   * installed and every event proceeds, which is the behaviour every
   * milestone before this one had. Present means an engaged switch refuses
   * new work before any session or run row is created.
   */
  readonly killSwitch?: Pick<KillSwitch, 'refuseIfEngaged'> & Partial<Pick<KillSwitch, 'refresh'>>
  /** How long a parked message waits for a live session before Relay answers it itself. Injected so a test does not spend the real grace period. */
  readonly liveControlGraceMs?: number
  readonly now?: () => Date
  /**
   * AP-1, Task 3: required, not defaulted, mirroring
   * AgentLoopContext.policy's own doc comment for why. startOrchestrator
   * loads this once at process startup via src/config/load.ts's loadPolicy,
   * which already throws ConfigError (fails closed, per FR-POL-2) for a
   * missing or invalid policy file; this field is what makes that failure
   * actually prevent the orchestrator from starting, rather than the
   * validated value having nowhere to go.
   */
  readonly policy: Policy
  /** Task 4's approval seam. Optional: see AgentLoopContext.requestApproval's own doc comment for the fail-closed default this gets when absent. */
  readonly requestApproval?: RequestApproval
  /** Present when `autonomous.enabled`: mentions start or continue autonomous tasks instead of governed runs. */
  readonly autonomous?: AutonomousRouting
}

/** The orchestrator's view of autonomous mode (src/autonomous/router.ts and scheduler.ts behind it). */
export type AutonomousRouting = {
  /** Takes the event into its thread's autonomous task; `not_autonomous` when the thread belongs to another mode. Throws IntakeFailedError when intake failed after retries. */
  route(event: ChatEvent, thread: { threadRef: string; replyRef: ChatRef }, options?: { adopt?: boolean }): Promise<'handled' | 'not_autonomous'>
  /** Stops the session's autonomous task; false when the session has none. */
  stopSession(sessionId: string): Promise<boolean>
}

/**
 * Drives one ChatEvent from inbound arrival to a posted final report.
 *
 * ORDERING, stated because a test proves it directly: the run row is
 * created (runsStore.createRun, a real committed INSERT) strictly before
 * this function ever calls `dispatcher.perform` for the first time (the
 * ProgressReporter's opening `update`). AP-5 and FR-ORC-1 both depend on a
 * run being persisted before any of its externally visible effects, and the
 * first externally visible effect of a run is that opening chat message.
 *
 * PRE-2, fail closed: `event.principalId === null` returns immediately,
 * with a log line and no reply, before a
 * session or a run is ever created. No amount of retrying that branch can
 * ever produce a run row, because the function returns before
 * `findOrCreateSession` or `createRun` is reached at all.
 */
export async function handleChatEvent(deps: OrchestratorDeps, event: ChatEvent): Promise<void> {
  const { pool, dispatcher, log, capabilities, limits, engine, cancellationRegistry, policy, requestApproval, killSwitch } =
    deps
  const liveControlGraceMs = deps.liveControlGraceMs ?? DEFAULT_LIVE_CONTROL_GRACE_MS
  const now = deps.now ?? ((): Date => new Date())

  if (event.principalId === null) {
    // Only the agent speaks in Slack, so an unmapped sender gets no reply; the operator finds them in the log.
    const platformUserId = extractPlatformUserId(event)
    log.warn(
      { workspaceId: event.workspaceId, adapter: event.adapter, platformUserId },
      platformUserId
        ? 'ignored an inbound event from an unmapped principal, per FR-CA-4; no session or run was ' +
            `created. To map this user, run: relay principals add --platform ${event.adapter} ` +
            `--user ${platformUserId} --display-name "<name>" --role operator`
        : 'ignored an inbound event from an unmapped principal, per FR-CA-4; no session or run was ' +
            'created, and the platform user id could not be read from the raw event',
    )
    return
  }

  const principalId = event.principalId
  // sessionRefFor always returns a ref carrying `thread` (it throws rather
  // than omitting one, see contract.ts's own doc comment); ChatRef's type
  // still declares `thread` optional, so this is asserted rather than
  // narrowed, matching how the rest of this codebase treats sessionRefFor's
  // documented postcondition.
  const replyRef = sessionRefFor(event)
  const threadTs = replyRef.thread
  if (threadTs === undefined) {
    throw new Error('handleChatEvent: sessionRefFor returned a ref with no thread; this should be impossible')
  }
  const threadRef = composeThreadRef(event.ref.channel, threadTs)

  // Gate fix, Blocker 1: recognised, and fully handled, BEFORE a session or
  // a run is ever created. No amount of retrying this branch can produce a
  // run row, the same "fail closed before persistence" shape PRE-2's own
  // branch above uses.
  if (isStopInstruction(event.text)) {
    await handleStopInstruction(deps, event, threadRef, replyRef)
    return
  }

  // FR-POL-9: refuse new work while the kill switch is engaged, checked
  // AFTER the Stop branch above and BEFORE any session or run row exists.
  //
  // The ordering is deliberate on both sides. Stop must still work while
  // engaged, because "stop everything" and "then let me stop one thing"
  // are the same intent and a kill switch that blocked Stop would be
  // actively unhelpful. And refusing before persistence means a refused
  // message leaves nothing behind: no session, no run, nothing to
  // reconcile when service is restored, the same fail-closed-before-
  // persistence shape the unmapped-principal branch above uses.
  //
  // The operator is told why, not merely that: KillSwitchEngagedError
  // carries the engagement reason precisely so this reply can name it.
  if (killSwitch) {
    try {
      // Picks up an engage or clear made from the CLI since the last tick.
      // A store that cannot be read refuses the event rather than guessing.
      await killSwitch.refresh?.()
    } catch (error) {
      log.error({ err: error, workspaceId: event.workspaceId }, 'could not read the kill switch; refusing the inbound event')
      await dispatcher.perform({ kind: 'post', ref: replyRef, text: 'Relay is paused right now.' })
      return
    }
    try {
      killSwitch.refuseIfEngaged()
    } catch (error) {
      if (error instanceof KillSwitchEngagedError) {
        await dispatcher.perform({ kind: 'post', ref: replyRef, text: `Relay is paused: ${error.reason}` })
        log.warn({ workspaceId: event.workspaceId, reason: error.reason }, 'refused an inbound event, per FR-POL-9')
        return
      }
      throw error
    }
  }

  // A thread attached to a Claude chat (/sessions Attach, `relay notify`)
  // belongs to that chat while it is open: its messages park for it below.
  const existing = await findActiveSession(pool, { workspaceId: event.workspaceId, adapter: event.adapter, threadRef })
  const liveAttached = existing !== null && existing.mode !== 'direct' && (await isLiveControlled(pool, existing.id, event.workspaceId))

  // With autonomous mode on, every other conversation the adapter accepts (a
  // mention, a DM, a reply in a known thread) is an autonomous task, unless
  // its thread already belongs to another mode (governed or direct), which
  // keeps its path. An attached thread whose chat has closed is adopted as
  // the thread's autonomous task, so the thread keeps one session.
  if (deps.autonomous && !liveAttached) {
    const adopt = existing !== null && existing.mode === 'governed' && existing.engineCwd !== null
    if ((await deps.autonomous.route(event, { threadRef, replyRef }, adopt ? { adopt } : undefined)) === 'handled') return
  }

  const session = await findOrCreateSession(pool, {
    workspaceId: event.workspaceId,
    principalId,
    adapter: event.adapter,
    threadRef,
  })

  // A reply without a mention in an autonomous thread.
  if (session.mode === 'autonomous' && !liveAttached) {
    if (deps.autonomous && (await deps.autonomous.route(event, { threadRef, replyRef })) === 'handled') return
    await dispatcher.perform({ kind: 'post', ref: replyRef, text: 'Autonomous mode is off on this Relay.' })
    return
  }

  // A DIRECT thread carries the message straight to its Claude Code session
  // and answers with the reply. Checked before live-control parking, because
  // a direct thread already IS the session: parking would queue a message
  // for something that is not waiting on one.
  //
  // The mode was decided once, when /direct created the thread, and is read
  // rather than re-derived. A conversation whose execution model can change
  // halfway through is the one thing a conversation must not be.
  if (session.mode === 'direct' && session.engineSessionId !== null && session.engineCwd !== null) {
    const reply = await continueDirectSession(
      session.engineCwd,
      session.engineSessionId,
      unwrapForAudit(event.text),
    )
    // Scrubbed like every other reply path in this file. A direct session is
    // unmediated and reads whatever the operator's account can read, which
    // makes this the likeliest place for a brokered secret to reach Slack.
    // The scrubber only knows values Relay itself brokered, so this narrows
    // the exposure rather than closing it, and that limit is why a direct
    // thread is labelled unmediated at creation.
    await dispatcher.perform({ kind: 'post', ref: replyRef, text: scrubSecrets(reply.text), markdown: true })
    log.info({ workspaceId: event.workspaceId, sessionId: session.id }, 'answered from a direct Claude Code session')
    return
  }

  // FR-ATT-40: a live-controlled thread parks its message for the session
  // that claimed it, instead of running Relay's own loop. That session is
  // already open, already holds the context the operator wants used, and is
  // blocked waiting on exactly this. Relay running its own loop here would
  // answer from a cold session and be the wrong answer, correctly produced.
  //
  // No run row is created: the work happens in the claiming session, and a
  // run row here would claim a governed execution that never occurred.
  // Decided once above (liveAttached), so a parked event costs one process scan, not two.
  if (liveAttached || (!deps.autonomous && (await isLiveControlled(pool, session.id, event.workspaceId)))) {
    const messageId = await enqueueLiveControlMessage(pool, {
      workspaceId: event.workspaceId,
      sessionId: session.id,
      principalId,
      body: unwrapForAudit(event.text),
      replyRef: JSON.stringify(replyRef),
    })
    log.info({ workspaceId: event.workspaceId, sessionId: session.id }, 'parked an event for a live-controlled session')

    // No acknowledgement from Relay: the open chat chooses its own first
    // reply (a short ack, a reaction, or just the answer).

    // Parking is only correct if something actually collects it. A live
    // process in the folder means a session is OPEN, not that it has a
    // consumer blocked on this queue, and those are different facts. When
    // they diverge the operator gets silence, which is the worst outcome
    // available: they cannot tell "working on it" from "swallowed", and
    // nothing ever arrives to resolve it.
    //
    // So the park is provisional. If nobody claims the message within the
    // grace period, Relay takes it back and answers with its own loop. A
    // late answer from a cold session beats no answer at all, and the
    // operator is told which they got.
    // Detached, NOT awaited. Waiting inline held the inbound event handler,
    // and a pool connection, for the whole grace period. At 20 seconds that
    // was merely wasteful; at three minutes it would serialise every other
    // inbound event behind one parked message and risk exceeding platform
    // request timeouts. Nothing downstream is waiting on this either.
    void (async () => {
      try {
        /**
         * PUSH FIRST, then fall back to the pull.
         *
         * DETACHED, and that is a correction rather than a preference. The
         * first version awaited the courier inline, in the inbound event
         * handler, for up to ninety seconds. That is precisely what the
         * comment above this block says must never happen, and for the same
         * reasons: it holds a pool connection, serialises every other
         * inbound event behind one message, and risks exceeding the
         * platform's own request timeout. The fallback was deliberately
         * detached to avoid exactly that, and the push was written directly
         * above it doing the opposite.
         *
         * The park happened before any of this, so a push that fails costs
         * a delay rather than the message.
         */
        // The chat that is open on this thread's session, found by its id:
        // a chat open in the terminal gets the message and answers it.
        const openName = session.engineSessionId !== null ? await findOpenSessionName(session.engineSessionId) : null
        const courierOutcome =
          session.engineCwd !== null
            ? await deliverViaCourier(
                {
                  targetCwd: session.engineCwd,
                  ...(session.courierTarget !== null ? { targetPeer: session.courierTarget } : {}),
                  ...(openName !== null ? { targetName: openName } : {}),
                  body: unwrapForAudit(event.text),
                  // The SAME builder `relay live drain` uses, so the command
                  // a pushed session is told to run cannot differ from the
                  // one a drained session is told to run.
                  replyCommand: buildReplyCommand(replyRef),
                  senderLabel: 'your operator',
                },
                { log },
              )
            : ({ outcome: 'not_delivered', reason: 'the session has no recorded working directory to address' } as const)

        if (courierOutcome.outcome === 'delivered') {
          /**
           * The claim's own answer decides what happened, rather than being
           * discarded.
           *
           * `takeBackMessage` returns false when something else claimed the
           * row first, which here means a concurrent `relay live drain`
           * collected it between the park and the push. The session has then
           * received the SAME message twice, once by each path. That is a
           * real outcome of running two delivery mechanisms over one queue,
           * and the honest response is to record it rather than to post
           * "Delivered" as though the push were the only thing that
           * happened.
           */
          const claimed = await takeBackMessage(pool, messageId)
          if (!claimed) {
            log.warn(
              { workspaceId: event.workspaceId, sessionId: session.id, peer: courierOutcome.peer },
              'pushed an event into the attached session, but it had already been drained by a hook: the session ' +
                'received it twice. Remove the Stop hook, or the push, so exactly one path delivers.',
            )
            return
          }

          log.info(
            { workspaceId: event.workspaceId, sessionId: session.id, peer: courierOutcome.peer },
            'pushed an event into the attached session',
          )
          return
        }

        log.warn(
          { workspaceId: event.workspaceId, sessionId: session.id, reason: courierOutcome.reason },
          'could not push into the attached session; falling back to the parked queue',
        )

        // A thread pushed to one exact chat has nobody else to collect it:
        // when that chat is closed, the thread's autonomous task answers now.
        if (session.courierTarget === null) {
          const collected = await waitForClaim(pool, messageId, liveControlGraceMs)
          if (collected) return
        }
        if (!(await takeBackMessage(pool, messageId))) return
        log.warn(
          { workspaceId: event.workspaceId, sessionId: session.id },
          'no live session collected the parked message; handing it to the thread\'s autonomous task',
        )
        // The same session becomes the thread's autonomous task, which reads
        // the thread so far. Without autonomous mode there is no one to answer.
        if (deps.autonomous) await deps.autonomous.route(event, { threadRef, replyRef }, { adopt: true })
      } catch (error) {
        // This path exists to prevent silence, so its own failure must be
        // visible rather than becoming the silence it guards against.
        log.error({ err: error, sessionId: session.id }, 'the live-control fallback failed')
      }
    })()
    return
  }

  // FR-ORC-1 / AP-5: committed before anything below can reach the
  // dispatcher. See this function's own doc comment for the ordering test.
  const run = await createRun(pool, {
    workspaceId: event.workspaceId,
    sessionId: session.id,
    principalId,
  })

  // Gate fix, High 5: bound from `run`, never from `session`. See
  // sessionRunContext's own doc comment for why: a session's principalId is
  // fixed to whoever opened it, but this run's own principalId (set two
  // lines above from `principalId`, the CURRENT event's sender) is what
  // FR-OBS-1 requires every line this run logs to actually carry.
  const runContext = sessionRunContext(log, session, run, 'loop')
  const cancelToken = cancellationRegistry?.register(run.id)
  const reporter = new ProgressReporter(dispatcher, replyRef, { log: runContext.log })
  const startedAt = now()

  try {
    await reporter.update("Relay received this and is getting started. I'll post a final report here when I'm done.")

    let result: AgentLoopResult
    try {
      result = await runAgentLoop({
        ctx: {
          pool,
          run,
          runContext,
          policy,
          ...(requestApproval ? { requestApproval } : {}),
          ...(engine ? { engine } : {}),
          // FR-SES-1: resume the engine session a PRIOR run in this same
          // thread last recorded, if there is one. `session` was read (or
          // created) once, above, before this run started, so this is
          // always the pointer as of the start of THIS run, never a value
          // this run itself produced.
          ...(session.engineSessionId ? { resumeSessionId: session.engineSessionId } : {}),
          // FR-ATT-5: run the engine in the folder this thread is attached
          // to, when it is attached to one. Null for every session that
          // predates attachment, which keeps today's behaviour of running
          // in Relay's own directory.
          //
          // The folder is not cosmetic. It is what gives a resumed session
          // that project's own skills, agents, and settings, including
          // gitignored ones, which is exactly what the operator asked for.
          // Resuming the right chat in the wrong directory produces a
          // session that looks correct and behaves differently, so
          // validateEngineCwd in the loop refuses a directory that is
          // missing or unusable rather than silently spawning elsewhere.
          ...(session.engineCwd ? { engineCwd: session.engineCwd } : {}),
        },
        task: event.text,
        capabilities,
        ...(cancelToken ? { cancel: cancelToken.signal } : {}),
        ...(limits ? { limits } : {}),
      })
    } catch (error) {
      // FR-SL-6: a final report always lands, even when the loop itself
      // throws instead of returning a terminal AgentLoopResult. Without
      // this, the thread would be stuck on the opening "getting started"
      // message forever, indistinguishable from Relay having hung.
      log.error({ err: error }, 'runAgentLoop threw unexpectedly; reporting a failure rather than leaving the thread without a final message')
      await reporter.finish(buildUnexpectedFailureReport(error, startedAt, now()))

      // Gate fix, High 4: the run row itself is transitioned to failed
      // here too, not only the chat report. Before this fix, an unexpected
      // loop failure reported "failed" to Slack while the run row stayed
      // 'running' forever, a disagreement between what the operator was
      // told and what the database actually recorded.
      try {
        await finishRun(pool, run.id, 'fail', {
          failureReason: `unexpected internal error: ${scrubSecrets(errorMessage(error))}`,
        })
      } catch (transitionError) {
        // WHAT HAPPENS THEN, stated because the brief asks for it
        // explicitly: this write can itself fail (the same database
        // problem that made runAgentLoop throw in the first place, most
        // plausibly, or the run already reached a terminal state through
        // some other path, which is a legal, expected IllegalTransitionError
        // rather than a surprise). Logged, never thrown: the ORIGINAL error
        // is what this function must still rethrow below, and a run left
        // 'running' after a failed recovery attempt is a real, disclosed
        // gap, visible to any operator who queries the runs table, rather
        // than a silently swallowed one.
        log.error(
          { err: transitionError, runId: run.id },
          'could not transition the run to failed after runAgentLoop threw unexpectedly; the run row may be left in a non-terminal state',
        )
      }
      throw error
    }

    // FR-SES-1: persist whatever engine session id this run ended up with,
    // so the NEXT run in this thread can resume it. Best effort, never
    // allowed to cost the operator their final report: losing continuity
    // for the next run is a real, disclosed gap (the next run simply
    // starts fresh, per this file's own resume-degrade handling), but
    // losing the reply to THIS message over it would be worse.
    if (result.engineSessionId) {
      try {
        await setSessionEngineSessionId(pool, session.id, result.engineSessionId)
      } catch (error) {
        log.error(
          { err: error, runId: run.id, sessionId: session.id },
          'could not persist the engine session id for continuity; the next run in this thread will start a fresh engine session',
        )
      }
    }

    await reporter.finish(buildFinalReport(result, startedAt, now()))
  } finally {
    if (cancelToken) cancellationRegistry?.release(run.id)
  }
}

// ---------------------------------------------------------------------------
// PRE-1: scheduling the outbox drain in a running process.
// ---------------------------------------------------------------------------

export type Drainable = { drain(): Promise<OutboxDrainResult> }

export type DrainSchedulerOptions = {
  /** How long to wait after one drain cycle ends before starting the next. Defaults to two seconds: frequent enough that a posted progress message reaches Slack promptly, cheap enough that an idle outbox costs one no-op query per cycle. */
  intervalMs?: number
  log?: Logger
  /** Called, in addition to being logged, whenever a drain cycle throws. Lets a test observe a failure without parsing log output. */
  onError?: (error: unknown) => void
}

const DEFAULT_DRAIN_INTERVAL_MS = 2000

/**
 * Calls `drainable.drain()` on a repeating interval for as long as the
 * process runs, closing PRE-1: before this function existed, nothing in
 * any running Relay process ever called `drain()` at all, so an enqueued
 * outbound action was durable but never delivered.
 *
 * SURVIVES A FAILED DRAIN, per the Task 8 brief's own requirement. This is
 * a self-rescheduling `setTimeout` chain, not a bare `setInterval`: each
 * cycle only schedules the next one after the current `drain()` call has
 * settled, successfully or not, inside a try/catch that logs and reports
 * the error through `onError` rather than letting it propagate. A rejected
 * `drain()` call therefore costs one skipped cycle, never the scheduler
 * itself: the next cycle still runs on schedule, and every following one
 * after that. A bare `setInterval` calling an async function has two
 * separate problems this avoids: an unhandled rejection from a failed call
 * (Node treats that as a process-level event, not something `setInterval`
 * itself catches), and unbounded overlap if one cycle runs longer than
 * `intervalMs` (a second `drain()` call starting before the first
 * finished, racing to claim the same rows `FOR UPDATE SKIP LOCKED` already
 * makes safe to run concurrently, but with no benefit over simply not
 * starting the next cycle early).
 */
export function scheduleOutboxDrain(
  drainable: Drainable,
  options: DrainSchedulerOptions = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? DEFAULT_DRAIN_INTERVAL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const runCycle = async (): Promise<void> => {
    try {
      const result = await drainable.drain()
      if (result.sent > 0 || result.failed > 0) {
        options.log?.info({ sent: result.sent, failed: result.failed }, 'outbox drain cycle completed')
      }
    } catch (error) {
      options.log?.error({ err: error }, 'outbox drain cycle threw; the schedule continues regardless')
      options.onError?.(error)
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          void runCycle()
        }, intervalMs)
      }
    }
  }

  timer = setTimeout(() => {
    void runCycle()
  }, intervalMs)

  return {
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

// ---------------------------------------------------------------------------
// The production entry point: wires a real SlackAdapter, a real
// OutboundDispatcher, the drain scheduler, and handleChatEvent together.
// scripts/relay-orchestrator.ts is the runnable script that calls this.
// ---------------------------------------------------------------------------

export type StartOrchestratorOptions = {
  /**
   * AP-1, Task 3: required, not optional or defaulted, mirroring
   * OrchestratorDeps.policy's own doc comment. scripts/relay-orchestrator.ts
   * is the one production caller, and it loads this via
   * src/config/load.ts's loadPolicy before ever reaching this call, so an
   * invalid or missing policy file throws ConfigError and the orchestrator
   * never starts at all, per FR-POL-2.
   */
  policy: Policy
  /** The runtime config's `autonomous` section; enables thread mentions and requires the kill switch store. */
  autonomous?: RelayConfig['autonomous']
  /** What autonomous mode needs beyond the config; required when `autonomous.enabled`. */
  autonomousRuntime?: Omit<AutonomousRuntimeOptions, 'pool' | 'workspaceId' | 'dispatcher' | 'log' | 'config' | 'killSwitch' | 'secrets'>
  /** Task 4's approval seam; see OrchestratorDeps.requestApproval's own doc comment. */
  requestApproval?: RequestApproval
  capabilities?: Readonly<Record<string, Capability>>
  limits?: AgentLoopLimits
  drainIntervalMs?: number
  dispatcherOptions?: OutboundDispatcherOptions
  slackAdapterOptions?: CreateProductionSlackAdapterOptions
}

/**
 * FR-CAP-1's acceptance criterion made real: "the model's tool list ...
 * derive from it [the registry]." Every capability currently registered in
 * the process-wide capability registry, as an executable map keyed by
 * name, exactly what buildCapabilityMap() returns. registerBuiltinCapabilities()
 * runs first and is idempotent (see its own comment), so this function
 * itself is safe to call more than once, which matters here specifically:
 * startOrchestrator can be invoked repeatedly in one process (each test
 * that calls it, for instance), and this being the one place wiring
 * happens must never make the second call crash. A thin, exported wrapper
 * rather than inlining the call at startOrchestrator's one call site, so a
 * test can prove this resolves from the registry (see
 * test/capabilities/registry.test.ts and
 * test/orchestrator-default-capabilities.test.ts) without needing a live
 * Postgres pool, secret provider, or Slack adapter, which is everything
 * else startOrchestrator needs to run at all.
 */
export function defaultCapabilities(): Readonly<Record<string, Capability>> {
  registerBuiltinCapabilities()
  return buildCapabilityMap()
}

/**
 * Starts the whole pipeline against a real Slack workspace: resolves the
 * workspace and wires principal/session lookups (createProductionSlackAdapter),
 * routes every outbound send through the durable outbox (OutboundDispatcher),
 * schedules the drain that actually delivers it (scheduleOutboxDrain), and
 * dispatches every inbound event through handleChatEvent. Returns a stop()
 * that shuts every piece down in the right order: the drain scheduler
 * first (so no new drain cycle starts once the adapter is stopping), then
 * the adapter itself.
 */
export async function startOrchestrator(
  pool: Pool,
  secrets: SecretProvider,
  log: Logger,
  options: StartOrchestratorOptions,
): Promise<{ stop(): Promise<void>; checkConnectivity(): Promise<void> }> {
  const capabilities = options.capabilities ?? defaultCapabilities()
  const cancellationRegistry = new CancellationRegistry()
  const autonomousEnabled = options.autonomous?.enabled === true

  // Bound once the runtime exists; an approval click before then has no task to wake.
  let autonomousRuntime: AutonomousRuntime | undefined
  const { adapter, workspaceId } = await createProductionSlackAdapter(pool, secrets, {
    log,
    acceptThreadMentions: autonomousEnabled,
    ...(options.autonomousRuntime ? { approvalReceiptKey: options.autonomousRuntime.receiptKey } : {}),
    onApprovalResolved: async (result) => {
      await autonomousRuntime?.onApprovalResolved(result)
    },
    ...options.slackAdapterOptions,
  })

  // FR-POL-9, now live: built once the workspace is known, on the store the
  // `relay kill` CLI writes. Autonomous mode refuses to start without it, so
  // a store that cannot be read at startup is fatal there.
  const killSwitch = await createKillSwitch({
    runCanceller: cancellationRegistry,
    store: new PostgresKillSwitchStore(pool, workspaceId),
  }).catch((error: unknown) => {
    if (autonomousEnabled) throw error
    log.error({ err: error }, 'kill switch store unreadable at startup; continuing without a kill switch (autonomous mode is off)')
    return undefined
  })

  const dispatcher = new OutboundDispatcher(pool, adapter, workspaceId, {
    log,
    ...options.dispatcherOptions,
  })

  // Gate fix, Medium 1: every in-flight handleChatEvent call is tracked
  // here, so stop() below can wait for them rather than tearing everything
  // down while one is still mid-run. Deleted from the set once it settles,
  // success or failure, so the set at any instant is exactly "what stop()
  // still needs to wait for".
  if (autonomousEnabled) {
    if (!options.autonomous || !options.autonomousRuntime || !killSwitch) throw new Error('autonomous mode is enabled but its runtime options or kill switch are missing')
    autonomousRuntime = await startAutonomousRuntime({
      ...options.autonomousRuntime,
      pool,
      workspaceId,
      dispatcher,
      log,
      config: options.autonomous,
      killSwitch,
      secrets,
    })
  }

  const activeHandlers = new Set<Promise<void>>()

  await dispatcher.start(async (event) => {
    const handlerPromise = handleChatEvent(
      {
        pool,
        dispatcher,
        log,
        capabilities,
        cancellationRegistry,
        policy: options.policy,
        ...(killSwitch ? { killSwitch } : {}),
        ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(autonomousRuntime ? { autonomous: autonomousRuntime.routing } : {}),
      },
      event,
    )
    activeHandlers.add(handlerPromise)
    try {
      await handlerPromise
    } finally {
      activeHandlers.delete(handlerPromise)
    }
  })

  const drainOptions = { log, ...(options.drainIntervalMs !== undefined ? { intervalMs: options.drainIntervalMs } : {}) }
  const drainScheduler = scheduleOutboxDrain(dispatcher, drainOptions)
  const uploadDrainScheduler = scheduleOutboxDrain({ drain: () => dispatcher.drainUploads() }, drainOptions)

  return {
    /**
     * Proves Slack is still reachable, rather than inferring it from the
     * absence of errors. Socket Mode can stop delivering while the process
     * stays alive and logs nothing, and a websocket that has gone deaf is
     * indistinguishable from a quiet workspace: observed in production,
     * where every inbound message was dropped and nothing reported it.
     *
     * Rejects when Slack is unreachable, so the caller decides what to do.
     * Deliberately not self-healing here: reconnecting in place is one more
     * thing that can fail silently, and the whole problem being solved is a
     * silent failure.
     */
    async checkConnectivity(): Promise<void> {
      await adapter.checkConnectivity()
    },

    /**
     * Shuts every piece down in order, per gate fix Medium 1. Before this
     * fix, stop() only stopped the schedulers and the adapter: it neither
     * cancelled a run still in flight nor waited for one to actually
     * finish settling, so a shutdown mid-run could cut off persistence and
     * the final chat report the same run's own `finally` block is
     * responsible for.
     *
     *   1. Stop scheduling new drain cycles, so nothing new starts while
     *      shutting down.
     *   2. Cancel every run this process is currently driving. GT-14's own
     *      five second bound is what makes step 3 below actually finite in
     *      the common case, not this call itself: cancelling only fires
     *      the AbortSignal each run's loop is racing against.
     *   3. Await every tracked handler promise, bounded by
     *      SHUTDOWN_SETTLE_TIMEOUT_MS so a handler that, despite
     *      cancellation, never settles cannot hang shutdown forever. Logged
     *      if that bound is hit, never thrown: shutdown proceeds regardless.
     *   4. Only then stop the adapter (which itself now awaits its own
     *      inbound delivery queue, see SlackAdapter.stop) and, via this
     *      function's own caller (scripts/relay-orchestrator.ts), close the
     *      pool and exit.
     */
    async stop(): Promise<void> {
      drainScheduler.stop()
      uploadDrainScheduler.stop()
      cancellationRegistry.cancelAll('orchestrator is shutting down')
      // Kills every running worker tree before leases are released.
      await autonomousRuntime?.stop()
      await settleActiveHandlers([...activeHandlers], SHUTDOWN_SETTLE_TIMEOUT_MS, log)
      await dispatcher.stop()
    },
  }
}

/**
 * Bounds how long startOrchestrator's stop() waits for every in-flight
 * handleChatEvent call to settle after cancellation, per gate fix Medium 1.
 * Deliberately more generous than CANCELLATION_BOUND_MS (src/runs/cancel.ts,
 * 5 seconds): that bound is how fast a run STOPS RUNNING, not how long it
 * then takes to persist a terminal state and post a final chat report,
 * both of which still involve real I/O after cancellation fires.
 */
const SHUTDOWN_SETTLE_TIMEOUT_MS = 15_000

/**
 * Waits for every promise in `promises` to settle (resolve OR reject; a
 * rejected handleChatEvent is not this function's problem to surface, only
 * to wait for), up to `timeoutMs`. Never rejects itself: a handler that
 * ultimately throws is exactly what shutdown must still be able to proceed
 * past, not be blocked by.
 */
async function settleActiveHandlers(
  promises: readonly Promise<void>[],
  timeoutMs: number,
  log: Logger,
): Promise<void> {
  if (promises.length === 0) return
  const settled = Promise.allSettled(promises).then(() => 'settled' as const)
  const timedOut = new Promise<'timed-out'>((resolve) => {
    setTimeout(() => resolve('timed-out'), timeoutMs)
  })
  const outcome = await Promise.race([settled, timedOut])
  if (outcome === 'timed-out') {
    log.warn(
      { activeCount: promises.length, timeoutMs },
      'shutdown: not every in-flight run settled within the bounded wait; proceeding with shutdown regardless',
    )
  }
}
