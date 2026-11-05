/**
 * The agent loop: the reason this milestone exists. Drives headless Claude
 * Code (`claude -p`, per DEC-1, docs/decisions/open-questions.md) through a
 * planning phase and a sequence of persisted, timed, loop-protected steps,
 * executing exactly one governed capability per step. `src/agent/capabilities/echo.ts`
 * is the only capability this milestone ships; everything in this file
 * exists to be true regardless of which capability runs, per the Task 6
 * brief: "The point is the loop, its persistence, its limits, and its
 * governance, not the capability."
 *
 * ENGINE, stated because DEC-1 exists precisely to record it: there is no
 * Agent SDK and no API key. `runClaudeEngine` below spawns the `claude`
 * binary on the operator's already-authenticated session and reads its
 * `--output-format stream-json` event stream. Every behavioural test in
 * test/agent/loop.test.ts drives an injected fake Engine instead; exactly
 * one test, clearly labelled LIVE, spawns the real binary. See that file
 * for which is which, and this file's own header comment section "WHAT THIS
 * DOES NOT COVER" near the bottom for what the live test does and does not
 * prove.
 *
 * NO ENGINE-SIDE TURN OR LOOP BOUND. DEC-1 originally claimed `--max-turns`
 * bounds the engine's own turn count; that flag does not exist in the
 * installed CLI (verified against `claude -p --help`, corrected in DEC-1).
 * Two consequences, stated plainly rather than left implicit:
 *   1. FR-ORC-8's wall-clock step and run timeouts are enforced entirely by
 *      this file, via AbortController and a race against the capability
 *      and engine calls, never by an engine-side flag.
 *   2. FR-ORC-9's loop protection (countTrailingIdenticalSteps, from
 *      src/runs/state.ts) is the ONLY thing that stops a run stuck
 *      proposing the same step forever. Nothing in the engine helps here;
 *      if this file's detection has a gap, a stuck run has no other
 *      backstop in this milestone.
 *
 * PROMPT STRUCTURE, per AP-2. Every engine call splits its content into two
 * channels:
 *   - `--system-prompt`: fixed, Relay-authored governance text
 *     (buildPlanningSystemPrompt / buildDecisionSystemPrompt below). It
 *     never contains a single byte of dynamic or outside-originated
 *     content; both builders take only capability NAMES (Relay's own
 *     internal config) as input.
 *   - the `-p` user-turn prompt: `renderForModel(task)`'s output (the one
 *     sanctioned path outside content reaches a prompt, per AP-2 and
 *     src/agent/untrusted.ts), optionally followed by a short, static,
 *     Relay-authored progress note ("Steps completed so far: N.") that
 *     carries no outside-originated content of its own. The tagged data
 *     block is never concatenated into the system prompt, and nothing else
 *     is concatenated inside the tagged block itself.
 * Every engine call also passes `--tools ''`, which the CLI's own help text
 * documents as disabling every built-in tool. These calls exist to make a
 * governed decision in text, not to let the engine act on the operator's
 * machine as a side effect of being asked to plan; per-tool approval for
 * cases where the engine SHOULD act is P0.4's problem, per DEC-1
 * consequence 2, not this task's.
 *
 * SESSION CONTINUITY VIA `--resume`, per FR-SES-1. DEC-1 named this
 * mechanism and Task 6 deliberately left it unused; this is that gap
 * closed. `AgentLoopContext.resumeSessionId`, when the orchestrator
 * supplies one (the engine session id a PRIOR run in this same Relay
 * session last recorded, per src/sessions/store.ts's engineSessionId), is
 * passed as `--resume` on this run's first engine call, and every engine
 * call after that, in this run or a later one, chains onto whatever
 * session id the previous call itself returned. `AgentLoopResult.engineSessionId`
 * is what the orchestrator persists back onto the session row afterward, so
 * the chain survives across runs, not only across calls within one run.
 *
 * DEGRADING WHEN RESUME FAILS. An expired, missing, or rejected engine
 * session must not crash the run and must not silently pretend continuity
 * exists. Verified empirically against the installed binary: a `--resume`
 * value the engine does not recognise fails FAST and FREE, a `result`
 * event with `is_error: true` and `total_cost_usd: 0`, before any model
 * call is made, not a process exit failure. `callEngineResumable` below
 * treats exactly that shape (an error on a call that supplied a resume id,
 * reported at zero cost) as a resume rejection, retries the identical call
 * once with no resume id, and marks the run as having lost continuity so
 * the report can say so; any other failure shape is left to fail normally,
 * so a resume rejection is never confused with, and never masks, a real
 * planning or decision failure.
 *
 * WHAT THIS DOES NOT COVER, stated per FR-RPT-5's own spirit applied to
 * this task's report rather than only to a run's result:
 *   - `--json-schema` structured output is used for every plan and decision
 *     call, and is exercised by the live test (which uses the same code
 *     path production does), but this task's live check is a single
 *     invocation and cannot by itself prove the flag behaves identically
 *     across the range of prompts a real run would send; the fake-engine
 *     tests prove the LOOP's handling of both well-formed and malformed
 *     responses, not the real engine's adherence to the schema.
 *   - Per-tool-call approval, subagent delegation, budget enforcement
 *     (FR-ORC-7; `--max-budget-usd` exists and would be the natural
 *     mechanism, but is deliberately not reached for here since budget
 *     metering is out of this task's scope), and general replanning beyond
 *     the loop-protection trigger (FR-ORC-3) are all out of scope, per the
 *     plan's own self-review.
 */

import type { Pool } from 'pg'
import type { Untrusted } from './untrusted.js'
import type { RunContext } from '../obs/context.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import * as runsStore from '../runs/store.js'
import type { Run, Step } from '../runs/store.js'
import type { RunState } from '../runs/state.js'
import { documentCapabilities } from '../capabilities/registry.js'
import { countTrailingIdenticalSteps } from '../runs/state.js'
import type { RequestApproval } from '../policy/engine.js'
import type { Policy } from '../config/schema.js'
import { isSessionPossiblyLive } from '../sessions/liveness.js'
import { errorMessage, runClaudeEngine, validateEngineCwd } from './engine.js'
import type { Capability, Engine } from './engine.js'
import { buildStepObservation, requestDecision, requestPlan } from './planner.js'
import type { PlanResponse } from './planner.js'
import { collectCapabilityNotices, denyForNoApprovalMechanism, executeStep, normalizeAction, normalizeAnswer } from './step.js'
import type { Candidate } from './step.js'

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export const DEFAULT_STEP_TIMEOUT_MS = 120_000
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_IDENTICAL_STEP_REPLAN_THRESHOLD = 3
export const DEFAULT_IDENTICAL_STEP_DEAD_LETTER_THRESHOLD = 6

/**
 * Gate fix, Blocker 6: the floor under a store call's derived timeout (see
 * remainingDbTimeoutMs below), so a call made close to the run's own
 * deadline still gets a fair, real window to complete a normal write
 * instead of an effectively-zero one. FR-ORC-8's own bound is minutes, so a
 * few seconds of floor costs nothing against it while still keeping a
 * genuinely blocked query from outliving the run by more than that floor.
 */
const DB_OP_TIMEOUT_FLOOR_MS = 5_000

/**
 * Gate fix, Blocker 6: the fixed budget given to the run's own terminal
 * write (finishRun), independent of "time remaining until the run's own
 * deadline". That call is frequently made AFTER the deadline has already
 * passed, precisely because it is what records that outcome, so bounding
 * it by the same remaining-deadline arithmetic every other store call in
 * this file uses would hand it a near-zero budget right when it most needs
 * to succeed. A fixed, generous, still-finite bound is what stops a
 * genuinely stuck terminal write from hanging the process forever without
 * being self-defeating against the very deadline that triggered it.
 */
const TERMINAL_WRITE_TIMEOUT_MS = 10_000

/** Bounds this loop enforces itself, per FR-ORC-8 and FR-ORC-9. Every field defaults to the spec's own default. */
export type AgentLoopLimits = {
  stepTimeoutMs?: number
  runTimeoutMs?: number
  identicalStepReplanThreshold?: number
  identicalStepDeadLetterThreshold?: number
}

/** Everything the loop needs to talk to the outside world: Postgres, the run row it drives, a bound logger, and (injectable, for tests) the engine. */
export type AgentLoopContext = {
  readonly pool: Pool
  readonly run: Run
  readonly runContext: RunContext
  readonly engine?: Engine
  /**
   * FR-SES-1 / FR-ATT-5: the engine session id to resume, if any. Originally
   * always the engine session id a PRIOR run in this same Relay session
   * last recorded (src/sessions/store.ts's `Session.engineSessionId`); as
   * of FR-ATT-5 it can equally be a chat id src/sessions/discovery.ts found
   * on disk that Relay never produced itself. This file treats the two
   * identically: `--resume` takes any valid session id, and nothing here
   * needs to know or care which kind this one is. The orchestrator is the
   * one caller that supplies this in production; every test that omits it
   * gets exactly the previous, non-resuming behaviour.
   */
  readonly resumeSessionId?: string
  /**
   * FR-ATT-5 / FR-CFG-3: the directory the engine runs in for this run.
   * Absent means Relay's own working directory (every run before this field
   * existed, and every ordinary governed run with no attached folder).
   * Present means every engine call this run makes, planning, decision, and
   * any forced replan, runs there instead, via EngineInvocation.cwd; see
   * that field's own doc comment for why the directory matters as much as
   * the chat id. Validated once, before the first engine call, per
   * validateEngineCwd below: a directory that does not exist, is not a
   * directory, or is not readable/traversable fails the run immediately
   * with a stated reason, rather than surfacing as an opaque spawn error
   * from deep inside the first engine call.
   */
  readonly engineCwd?: string
  /**
   * FR-ATT-5's routing rule: consulted, only when both `resumeSessionId`
   * and `engineCwd` are present (an actual attach scenario; Relay's own
   * prior session, with no attached folder, is never touched by anything
   * else and never needs this), immediately before the run's first engine
   * call, to decide resume-in-place versus `--fork-session`. Defaults to
   * the real src/sessions/liveness.ts's `isSessionPossiblyLive`; injectable
   * so tests can script both branches deterministically. Whatever this
   * throws, or resolves `true`, forks; only a clean `false` resumes in
   * place, per this milestone's own investigation into why the asymmetry
   * (a false positive costs one harmless extra fork; a false negative
   * costs a silently, permanently lost turn) makes that the only
   * defensible default.
   */
  readonly checkSessionLiveness?: (params: { cwd: string; sessionId: string }) => Promise<boolean>
  /**
   * AP-1: REQUIRED, not defaulted. Every capability call this run attempts
   * is mediated against this policy (src/policy/engine.ts's
   * mediateCapabilityCall). There is deliberately no fallback value the way
   * `engine` has `runClaudeEngine`: a missing engine implementation has one
   * obviously correct default (the real one), but a missing policy has no
   * safe default at all, permissive or restrictive, that would not be a
   * silent, unreviewed governance decision made by this file instead of the
   * operator. Requiring the field at the type level is what makes "the loop
   * is structurally unable to invoke a capability without a policy
   * decision" true at compile time, not just true of the code as currently
   * written.
   */
  readonly policy: Policy
  /**
   * The approval seam for an 'ask' verdict. Optional: when absent, every
   * 'ask' verdict is refused by denyForNoApprovalMechanism (see executeStep)
   * rather than left unable to proceed either way. This IS a safe default,
   * unlike `policy` above, because "no approval mechanism configured" has
   * exactly one governance-correct behaviour (refuse) rather than a menu of
   * plausible ones.
   */
  readonly requestApproval?: RequestApproval
  /**
   * FR-POL-7's spend metering. Called after every engine invocation with
   * that invocation's own reported cost, and returns the scopes now over
   * their cap, if any.
   *
   * Optional, and its absence means no metering rather than a permissive
   * default, which is safe here in a way a missing `policy` would not be:
   * spend is recorded after the money is already gone, so there is nothing
   * to refuse retroactively, only something to report. The refusal this
   * enables is on the NEXT call, which is exactly where a cap can still
   * change an outcome.
   */
  readonly recordSpend?: (amountUsd: number) => Promise<readonly { scope: string; capUsd: number; spentUsd: number }[]>
}

export type AgentLoopParams = {
  readonly ctx: AgentLoopContext
  readonly task: Untrusted<string>
  readonly capabilities: Readonly<Record<string, Capability>>
  /**
   * The signal src/runs/cancel.ts's CancellationToken produces (Task 7).
   * Checked at loop-iteration boundaries and wired into every engine call
   * and capability invocation's combined AbortSignal via runCapability's
   * own abort race, which is what bounds a Stop to five seconds even
   * against a capability that never looks at this signal itself; see
   * runCapability's comment just above executeStep. Per DEC-1 consequence
   * 1, aborting this signal terminates rather than cooperates: an
   * in-flight engine subprocess is killed, not asked nicely, and a run
   * this produces is recorded cancelled with whatever progress had
   * already been persisted, never discarded.
   */
  readonly cancel?: AbortSignal
  readonly limits?: AgentLoopLimits
}

export type AgentLoopResult = {
  readonly runId: string
  readonly state: Exclude<RunState, 'queued' | 'running'>
  readonly costUsd: number
  readonly stepsExecuted: number
  /** FR-RPT-5: what this run could not verify, stated plainly rather than left implicit. Always non-empty. */
  readonly notVerified: readonly string[]
  readonly warnings: readonly string[]
  /**
   * Operator-facing lines the CAPABILITIES themselves produced, per
   * `CapabilityDefinition.reportLines`.
   *
   * Separate from `warnings` because these are not faults: "acted in
   * profile acme-client" is a fact the operator is entitled to (FR-PRF-10),
   * and "this page showed a CAPTCHA" is something they must be told
   * (FR-BR-8) whether or not the run otherwise succeeded. Kept out of
   * `answer` deliberately: the answer is the model's, and a safety property
   * that depends on a model remembering to mention something is not a
   * safety property.
   */
  readonly capabilityNotices: readonly string[]
  /** Every capability this run actually executed, in order of first use. What the report's "what changed" line is derived from, instead of a sentence hardcoded when echo was the only capability. */
  readonly capabilitiesUsed: readonly string[]
  /**
   * The engine's own natural-language answer for the person who asked,
   * per the usability fix that added this field: the last non-empty
   * `answer` any plan or decision call in this run produced (see
   * normalizeAnswer). `undefined`, not an empty string, is how this field
   * says "the engine never gave usable answer text for this run", for
   * example when planning itself failed before any call could return one.
   * A defined answer is not on its own evidence of success: a run can fail
   * after a step that already produced one, so a caller building a report
   * from this field must still lead with `state`, never let a defined
   * answer imply the run succeeded.
   */
  readonly answer?: string
  /**
   * FR-SES-1: the freshest engine session id this run knows about, for the
   * orchestrator to persist back onto the session row so the NEXT run in
   * this thread can resume it. Initialized from `resumeSessionId` and
   * updated after every engine call that returns one, so a run whose own
   * first engine call fails before returning anything still reports
   * whatever session id it started with, unchanged, rather than losing a
   * perfectly good pointer to an internal error. `undefined` only when
   * neither a prior session nor any call in this run ever produced one, for
   * example a spawn failure on a session's very first run.
   */
  readonly engineSessionId?: string
  /**
   * FR-ATT-5: which of the routing rule's two outcomes this run's first
   * engine call actually took, so the caller (src/orchestrator.ts) can tell
   * the operator plainly which one they got. `undefined` when there was no
   * attach scenario to route at all (no resumeSessionId, or no engineCwd):
   * an ordinary governed run says nothing about this, same as it always
   * has. Per the team's own framing: what the operator asked for was their
   * message landing in the chat that is already open; what a fork actually
   * gives them is a NEW chat carrying the full prior context, a good
   * outcome but not the one they asked for in those words, and a fork that
   * presents identically to a resume would be its own quiet deception.
   */
  readonly attachmentOutcome?: 'resumed' | 'forked'
}

const BASE_NOT_VERIFIED_NOTE =
  'Relay verified only that each capability call completed, failed, or timed out; it did not independently verify the real-world correctness of any capability output.'

/**
 * Drives one run from 'queued' to a terminal state, per the Task 6 brief.
 * See this file's header comment for the engine, prompt boundary, and
 * loop-protection design; see the three inline SCOPE / DECISION comments
 * below for the specific choices made while executing it.
 */
export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const { ctx, task, capabilities, cancel, limits } = params
  const { pool, run, runContext, policy, engineCwd, recordSpend } = ctx
  const engine = ctx.engine ?? runClaudeEngine
  // AP-1: the fallback here, unlike `engine`'s, is deny-closed, never a live
  // approval mechanism: an absent requestApproval falls back to
  // denyForNoApprovalMechanism, which refuses every 'ask' verdict rather
  // than approving one, hanging, or silently behaving as if no approval
  // were needed. See AgentLoopContext.requestApproval's own doc comment for
  // why that specific fallback is safe (it has exactly one governance-
  // correct behaviour) where AgentLoopContext.policy's absence is not (a
  // permissive OR a restrictive default would both be silent, unreviewed
  // governance decisions this file has no business making on its own).
  const requestApproval = ctx.requestApproval ?? denyForNoApprovalMechanism
  const log = runContext.log

  const stepTimeoutMs = limits?.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const runTimeoutMs = limits?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const replanThreshold = limits?.identicalStepReplanThreshold ?? DEFAULT_IDENTICAL_STEP_REPLAN_THRESHOLD
  const deadLetterThreshold =
    limits?.identicalStepDeadLetterThreshold ?? DEFAULT_IDENTICAL_STEP_DEAD_LETTER_THRESHOLD

  const capabilityNames = Object.keys(capabilities)
  // FR-CAP-1: the model's tool list derives from the registry, not from a
  // hand-kept list. A name the registry does not know (a test's own
  // injected capability) simply gets no documentation; see
  // describeCapabilities.
  const capabilityDocs = documentCapabilities(capabilityNames)
  /** See AgentLoopResult.capabilityNotices. */
  const capabilityNotices: string[] = []
  const capabilitiesUsed: string[] = []

  const runTimeoutController = new AbortController()
  const runTimeoutTimer = setTimeout(
    () => runTimeoutController.abort(new Error(`run exceeded its ${runTimeoutMs}ms timeout`)),
    runTimeoutMs,
  )
  const outerSignal: AbortSignal = cancel
    ? AbortSignal.any([cancel, runTimeoutController.signal])
    : runTimeoutController.signal

  // Gate fix, Blocker 6: derives each store call's own statement/lock
  // timeout from how much of the run's own budget is left, so a blocked
  // query cannot outlive the run deadline the way an unbounded pool.query
  // could before this fix. See DB_OP_TIMEOUT_FLOOR_MS's own comment for why
  // this is floored rather than allowed toward zero.
  const runDeadlineAt = Date.now() + runTimeoutMs
  function remainingDbTimeoutMs(): number {
    return Math.max(DB_OP_TIMEOUT_FLOOR_MS, runDeadlineAt - Date.now())
  }

  const notVerified: string[] = [BASE_NOT_VERIFIED_NOTE]
  const warnings: string[] = []
  let totalCost = 0
  let budgetBreach: string | undefined
  const executedSteps: { capability: string; input: unknown }[] = []
  // Task 3, second review round: a step policy REFUSED is a governed
  // outcome, not a malfunction of the loop, so it must never trip FR-ORC-9's
  // repeat-detection the way a genuinely stuck loop does; an operator who
  // denies the same request twice in a row must not have that denial itself
  // terminate their run as a side effect. `executedSteps` above stays the
  // full history (used for stepsExecuted and the engine's own "steps
  // completed so far" prompt, both of which should still count an attempted
  // step regardless of its outcome); this SEPARATE array is what loop
  // protection actually reads, and a refused step is never pushed onto it.
  const loopProtectionSteps: { capability: string; input: unknown }[] = []
  // Gate fix, Blocker 5: the last step this run actually completed, tracked
  // across the whole loop so the natural-completion branch below can tell
  // "the engine said done" apart from "the engine said done right after its
  // only action failed". See that branch for the full rule.
  let lastStep: Step | undefined
  // Usability fix: the last non-empty `answer` any plan or decision call
  // gave, per normalizeAnswer's own "empty means absent" rule. A later
  // non-empty answer always replaces an earlier one; a later blank one
  // never erases a real answer that already arrived, since a forced replan
  // or an ambiguous decision has no reason to blank out a genuine reply.
  let finalAnswer: string | undefined
  // FR-SES-1: the freshest known engine session id, seeded from whatever
  // the orchestrator persisted for a prior run in this thread and updated
  // after every engine call that returns one; see AgentLoopResult.engineSessionId's
  // own doc comment for exactly what "freshest known" means when a call
  // fails before returning anything.
  let engineSessionId: string | undefined = ctx.resumeSessionId
  // FR-ATT-5: set once, by the routing decision made just before the run's
  // first engine call (see below), and never revisited afterward: only
  // that first call can ever fork, per requestPlan's/requestDecision's own
  // forkSession parameter.
  let attachmentOutcome: 'resumed' | 'forked' | undefined

  /**
   * Records a resume-degrade warning exactly once per occurrence, shared by
   * every call site below rather than repeated at each one. Per this file's
   * header comment, a degraded call already recovered on its own (a fresh,
   * successful, non-resumed call); this only makes sure the operator is
   * told continuity was lost rather than the run silently behaving as if it
   * had not been.
   */
  function noteResumeDegraded(): void {
    warnings.push(
      'the prior conversation for this thread could not be resumed (the engine session had ' +
        'expired, was missing, or was rejected); this run continued with a fresh engine session instead',
    )
  }


  /**
   * FR-POL-7: records this invocation's spend and reports whether any scope
   * is now over its cap. The engine call that just happened is never
   * refused, because the money is already spent by the time its cost is
   * known. What a breach does is stop the run BEFORE the next engine call,
   * which is the only point where a cap can still change an outcome.
   */
  async function meterSpend(amountUsd: number): Promise<string | undefined> {
    if (!recordSpend) return undefined
    const exceeded = await recordSpend(amountUsd)
    if (exceeded.length === 0) return undefined
    const worst = exceeded[0]
    if (!worst) return undefined
    return `budget cap reached for ${worst.scope}: spent $${worst.spentUsd.toFixed(4)} against a $${worst.capUsd.toFixed(2)} cap`
  }

  async function stopFor(
    event: 'cancel' | 'fail' | 'dead_letter',
    patch: runsStore.FinishRunPatch,
  ): Promise<AgentLoopResult> {
    const finished = await runsStore.finishRun(
      pool,
      run.id,
      event,
      { ...patch, costUsd: totalCost },
      TERMINAL_WRITE_TIMEOUT_MS,
    )
    return {
      runId: run.id,
      state: finished.state as Exclude<RunState, 'queued' | 'running'>,
      costUsd: totalCost,
      ...(finalAnswer !== undefined ? { answer: finalAnswer } : {}),
      stepsExecuted: executedSteps.length,
      notVerified,
      warnings,
      capabilityNotices,
      capabilitiesUsed,
      ...(engineSessionId !== undefined ? { engineSessionId } : {}),
      ...(attachmentOutcome !== undefined ? { attachmentOutcome } : {}),
    }
  }

  try {
    // If the run was already cancelled before this loop ever got to run
    // it (a Stop arrived while it was still queued), reflect that directly
    // rather than transitioning through 'running' first.
    if (cancel?.aborted) {
      notVerified.push('the run was cancelled before it started; nothing was executed or verified')
      return await stopFor('cancel', {})
    }

    // FR-ORC-1: this write must complete, and be committed, before the loop
    // does anything else, including the planning call below.
    await runsStore.startRun(pool, run.id, remainingDbTimeoutMs())
    log.info({ runId: run.id }, 'run persisted as running before any step or plan call')

    // FR-ATT-5, item 3: validated once, before the FIRST engine call, not
    // per call. A run attached to a folder that has since been deleted or
    // become unreadable fails here, with a stated reason, rather than as an
    // opaque spawn error the first time requestPlan below tries to use it,
    // and rather than failing silently N times, once per engine call this
    // run would otherwise attempt.
    if (engineCwd !== undefined) {
      try {
        await validateEngineCwd(engineCwd)
      } catch (error) {
        notVerified.push('the run could not start because its attached working directory could not be used; no step was attempted')
        return await stopFor('fail', { failureReason: scrubSecrets(errorMessage(error)) })
      }
    }

    // FR-ATT-5's routing rule, decided as late as possible (immediately
    // before the first engine call, not at routing time in the
    // orchestrator) to narrow the time-of-check-to-time-of-use window
    // between this decision and the actual spawn: only relevant when this
    // run is attaching to BOTH a prior chat AND a folder (Relay's own
    // session continuity, with no attached folder, is never touched by
    // anything else and is always a plain resume). `checkSessionLiveness`
    // resolving `true`, or throwing at all, both fork; only a clean `false`
    // resumes in place, per the accepted asymmetry: an unnecessary fork
    // costs nothing but a new session id, a wrongly-skipped one costs a
    // silently, permanently lost turn (see attach-report.md).
    let initialForkSession = false
    if (engineSessionId !== undefined && engineCwd !== undefined) {
      const checkLiveness = ctx.checkSessionLiveness ?? isSessionPossiblyLive
      let possiblyLive: boolean
      try {
        possiblyLive = await checkLiveness({ cwd: engineCwd, sessionId: engineSessionId })
      } catch {
        possiblyLive = true
      }
      initialForkSession = possiblyLive
      attachmentOutcome = possiblyLive ? 'forked' : 'resumed'
      if (possiblyLive) {
        log.info({ runId: run.id, engineCwd }, 'FR-ATT-5: the attached session looked possibly live; forking rather than resuming in place')
      }
    }

    let plan: PlanResponse
    try {
      const planned = await requestPlan(
        engine,
        task,
        capabilityNames,
        capabilityDocs,
        stepTimeoutMs,
        outerSignal,
        false,
        engineSessionId,
        engineCwd,
        initialForkSession,
      )
      plan = planned.plan
      totalCost += planned.costUsd
      budgetBreach = (await meterSpend(planned.costUsd)) ?? budgetBreach
      finalAnswer = normalizeAnswer(plan.answer) ?? finalAnswer
      engineSessionId = planned.sessionId
      if (planned.resumeDegraded) noteResumeDegraded()
    } catch (error) {
      if (outerSignal.aborted) {
        const timedOutDuringPlanning = runTimeoutController.signal.aborted
        const patch: runsStore.FinishRunPatch = timedOutDuringPlanning
          ? { failureReason: `run exceeded its ${runTimeoutMs}ms timeout during planning` }
          : {}
        return await stopFor(timedOutDuringPlanning ? 'fail' : 'cancel', patch)
      }
      notVerified.push('the planning call failed, so no step in this run could be attempted or verified')
      return await stopFor('fail', { failureReason: `planning failed: ${scrubSecrets(errorMessage(error))}` })
    }
    await runsStore.recordPlan(pool, run.id, plan, remainingDbTimeoutMs())
    log.info({ runId: run.id, riskTier: plan.riskTier }, 'plan persisted before execution')

    let nextAction: Candidate | null = plan.firstAction ? normalizeAction(plan.firstAction) : null

    // DECISION, stated because getting this ordering backwards is exactly
    // the bug a first draft of this loop had: loop protection is evaluated
    // AFTER a candidate step has been executed and persisted, never before.
    // A "check then skip" version, where a candidate whose streak already
    // exceeds replanThreshold is replanned away without ever running,
    // sounds equivalent but is not: executedSteps then never grows past
    // whatever it was when the streak first crossed the threshold, so the
    // streak recomputed against a still-stuck engine's fresh "replanned"
    // proposal is identical to what it was a moment ago, and the run
    // replans forever without ever reaching deadLetterThreshold. Executing
    // first means every proposal, including the ones that trip loop
    // protection, is genuinely attempted, persisted, and counted, which is
    // both what AP-5 requires (a step is persisted and executed, not
    // conjured) and what makes dead-letter actually reachable.
    while (nextAction) {
      // FR-POL-7: a breached cap stops the run here, before the next engine
      // call, rather than at the call that discovered it. The discovering
      // call's money was already spent; this is the first point where
      // stopping still saves anything. The run is recorded as stopped by
      // budget, not as a failure, because hitting a cap the operator set is
      // the system working, and the final report must not read as a fault.
      if (budgetBreach !== undefined) {
        return await stopFor('fail', { failureReason: budgetBreach })
      }
      if (outerSignal.aborted) break

      const candidate: Candidate = nextAction

      const step = await executeStep(
        pool,
        run,
        candidate,
        capabilities[candidate.capability],
        stepTimeoutMs,
        outerSignal,
        log,
        remainingDbTimeoutMs(),
        policy,
        requestApproval,
      )
      executedSteps.push(candidate)
      lastStep = step
      if (!capabilitiesUsed.includes(candidate.capability)) capabilitiesUsed.push(candidate.capability)
      collectCapabilityNotices(capabilityNotices, candidate.capability, step, log)
      const wasRefusedByPolicy = step.policyDecision === 'refuse'
      if (!wasRefusedByPolicy) loopProtectionSteps.push(candidate)

      if (wasRefusedByPolicy) {
        // A distinct, explicit line, per Task 3's second review round: the
        // operator reads this as governance working as designed, not as an
        // ordinary failure lumped in with the generic branch below.
        warnings.push(`step "${candidate.capability}" (seq ${step.seq}) was refused by policy: ${step.policyReason ?? 'no reason recorded'}`)
      } else if (step.state === 'timed_out') {
        notVerified.push(
          `step "${candidate.capability}" (seq ${step.seq}) was aborted after exceeding its ${stepTimeoutMs}ms timeout; whether it would have succeeded could not be verified`,
        )
      } else if (step.state === 'failed') {
        warnings.push(`step "${candidate.capability}" (seq ${step.seq}) failed: ${step.error ?? 'no error detail recorded'}`)
      } else if (step.state === 'cancelled') {
        notVerified.push(`step "${candidate.capability}" (seq ${step.seq}) was cancelled before it could be verified`)
      }

      if (outerSignal.aborted) break

      const streak = countTrailingIdenticalSteps(loopProtectionSteps)

      if (streak > deadLetterThreshold) {
        const reason =
          `identical step "${candidate.capability}" was executed ${streak} times in a row, past the ` +
          `dead-letter threshold of ${deadLetterThreshold}; the run could not make forward progress`
        log.error({ runId: run.id, streak, deadLetterThreshold }, 'loop protection dead-lettered the run')
        notVerified.push(
          'the run dead-lettered under loop protection; steps already executed were completed and persisted, but the task as a whole was not verified complete',
        )
        return await stopFor('dead_letter', { deadLetterReason: reason })
      }

      if (streak > replanThreshold) {
        warnings.push(
          `identical step "${candidate.capability}" was executed ${streak} times in a row; forced a replan per FR-ORC-9`,
        )
        log.warn({ runId: run.id, streak, replanThreshold }, 'loop protection forced a replan')
        try {
          const replanned = await requestPlan(
            engine,
            task,
            capabilityNames,
            capabilityDocs,
            stepTimeoutMs,
            outerSignal,
            true,
            engineSessionId,
            engineCwd,
            // FR-ATT-5: a forced replan never forks. By this point the run
            // already owns whatever session id its own first call
            // established (resumed or forked); forking again here would
            // branch away from the run's own prior steps, not away from
            // anything external.
            false,
          )
          plan = replanned.plan
          totalCost += replanned.costUsd
          budgetBreach = (await meterSpend(replanned.costUsd)) ?? budgetBreach
          finalAnswer = normalizeAnswer(plan.answer) ?? finalAnswer
          engineSessionId = replanned.sessionId
          if (replanned.resumeDegraded) noteResumeDegraded()
          await runsStore.recordPlan(pool, run.id, plan, remainingDbTimeoutMs())
        } catch (error) {
          if (outerSignal.aborted) break
          notVerified.push('a forced replan failed, so the run could not recover from a stuck loop')
          return await stopFor('fail', { failureReason: `forced replan failed: ${scrubSecrets(errorMessage(error))}` })
        }
        nextAction = plan.firstAction ? normalizeAction(plan.firstAction) : null
        continue
      }

      try {
        const decided = await requestDecision(
          engine,
          task,
          capabilityNames,
          capabilityDocs,
          executedSteps.length,
          stepTimeoutMs,
          outerSignal,
          engineSessionId,
          engineCwd,
          // The step that just ran, so the decision and the final answer
          // are based on what the capability actually returned rather than
          // on the step count alone. See buildStepObservation.
          buildStepObservation(step),
        )
        totalCost += decided.costUsd
        budgetBreach = (await meterSpend(decided.costUsd)) ?? budgetBreach
        finalAnswer = normalizeAnswer(decided.decision.answer) ?? finalAnswer
        engineSessionId = decided.sessionId
        if (decided.resumeDegraded) noteResumeDegraded()
        nextAction = decided.decision.done
          ? null
          : decided.decision.capability
            ? normalizeAction({ capability: decided.decision.capability, input: decided.decision.input })
            : null
        if (!decided.decision.done && !decided.decision.capability) {
          warnings.push('the engine reported the task was not done but named no next capability; treating the run as complete')
          notVerified.push('the run ended because the engine gave an ambiguous decision, not because completion was independently confirmed')
        }
      } catch (error) {
        if (outerSignal.aborted) break
        notVerified.push('a decision call failed partway through the run, so later intended steps were never attempted')
        return await stopFor('fail', { failureReason: `decision call failed: ${scrubSecrets(errorMessage(error))}` })
      }
    }

    if (outerSignal.aborted) {
      const timedOut = runTimeoutController.signal.aborted
      notVerified.push(
        timedOut
          ? `the run was aborted after exceeding its ${runTimeoutMs}ms overall timeout; work after that point was not attempted or verified`
          : 'the run was cancelled before it finished; work after the cancellation point was not attempted or verified',
      )
      const patch: runsStore.FinishRunPatch = timedOut
        ? { failureReason: `run exceeded its ${runTimeoutMs}ms timeout` }
        : {}
      return await stopFor(timedOut ? 'fail' : 'cancel', patch)
    }

    // Gate fix, Blocker 5: an unresolved failed, timed-out, or cancelled
    // step makes the run terminally failed unless a LATER step actually
    // recorded a success; the engine reporting "done" is not, on its own,
    // evidence the task was accomplished. Before this fix, reaching this
    // point at all (the loop exited normally and outerSignal never
    // aborted) unconditionally recorded the run 'succeeded', regardless of
    // whether its own last recorded step ever did: a run whose only action
    // failed or timed out reported "Outcome: succeeded" to the operator.
    // executedSteps.length === 0 (the plan's firstAction was null; nothing
    // needed doing) still succeeds here, since there is no step to be
    // unresolved.
    if (lastStep !== undefined && lastStep.state !== 'succeeded') {
      // Task 3, second review round: a policy refusal gets its own wording,
      // distinct from the generic "did not succeed" branch below. The run
      // still ends recorded 'failed' (this file owns no terminal RunState
      // of its own to add, and a refusal genuinely did not complete the
      // task), but the OPERATOR-FACING text says plainly that policy
      // refused the step, not that the step itself malfunctioned.
      if (lastStep.policyDecision === 'refuse') {
        log.warn(
          { runId: run.id, lastStepId: lastStep.id },
          'the run reached natural completion but its own last step was refused by policy; recording the run failed, with that reason stated plainly',
        )
        notVerified.push(
          `the run ended after its last step "${lastStep.capability}" (seq ${lastStep.seq}) was refused by ` +
            `policy: ${lastStep.policyReason ?? 'no reason recorded'}; the run is recorded failed, not because ` +
            'anything malfunctioned, but because governance did not permit the task to complete',
        )
        return await stopFor('fail', {
          failureReason:
            `the run's last step, "${lastStep.capability}" (seq ${lastStep.seq}), was refused by policy: ` +
            `${lastStep.policyReason ?? 'no reason recorded'}`,
        })
      }

      log.warn(
        { runId: run.id, lastStepId: lastStep.id, lastStepState: lastStep.state },
        'the run reached natural completion (the engine reported done, or gave an ambiguous decision) ' +
          'but its own last recorded step did not succeed; recording the run failed rather than succeeded',
      )
      notVerified.push(
        `the run ended after its last step "${lastStep.capability}" (seq ${lastStep.seq}) did not succeed ` +
          `(state: ${lastStep.state}); the run is recorded failed rather than succeeded, because nothing ` +
          'after it established completion',
      )
      return await stopFor('fail', {
        failureReason:
          `the run's last step, "${lastStep.capability}" (seq ${lastStep.seq}), ended in state ` +
          `"${lastStep.state}" rather than succeeded`,
      })
    }

    const finished = await runsStore.finishRun(
      pool,
      run.id,
      'succeed',
      { costUsd: totalCost },
      TERMINAL_WRITE_TIMEOUT_MS,
    )
    log.info({ runId: run.id, stepsExecuted: executedSteps.length, costUsd: totalCost }, 'run succeeded')
    return {
      runId: run.id,
      state: finished.state as Exclude<RunState, 'queued' | 'running'>,
      costUsd: totalCost,
      stepsExecuted: executedSteps.length,
      notVerified,
      warnings,
      capabilityNotices,
      capabilitiesUsed,
      ...(finalAnswer !== undefined ? { answer: finalAnswer } : {}),
      ...(engineSessionId !== undefined ? { engineSessionId } : {}),
      ...(attachmentOutcome !== undefined ? { attachmentOutcome } : {}),
    }
  } finally {
    clearTimeout(runTimeoutTimer)
  }
}
