/**
 * Step execution for the agent loop: one governed capability call per step,
 * mediated by policy, raced against the step's own timeout, and persisted.
 */
import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { getCapability } from '../capabilities/registry.js'
import * as runsStore from '../runs/store.js'
import type { Run, Step, StepOutcome } from '../runs/store.js'
import type { StepState } from '../runs/state.js'
import { mediateCapabilityCall } from '../policy/engine.js'
import type { RequestApproval } from '../policy/engine.js'
import type { Policy } from '../config/schema.js'
import { errorMessage } from './engine.js'
import type { Capability } from './engine.js'

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

// DECISION: `input` is REQUIRED here, always present, even when nothing
// meaningful was decided, rather than optional. A capability's input is a
// real value the moment a step is about to be attempted; "the engine did
// not name one" and "the engine named one but it was empty" are different
// facts, and collapsing the first into `null` at the one place a Candidate
// is ever constructed (normalizeAction, below) keeps that distinction
// explicit and out of every downstream type. This is a deliberate choice
// over the alternative (letting `input` stay optional, matching zod's own
// output type for an unqualified `z.unknown()` field, and propagating that
// optionality through Candidate, LoopProtectionStep, and every call site
// that reads `.input`): threading "maybe absent" through persistence,
// loop-protection comparison, and capability invocation multiplies the
// number of places that must agree on what "absent" means, for a value
// that is functionally indistinguishable from `null` everywhere it is
// actually used (persisted as jsonb, compared by JSON.stringify equality,
// or handed to echo, which returns whatever it is given either way).
export type Candidate = { capability: string; input: unknown }

/**
 * The one place a PlanResponse or DecisionResponse's loosely-typed action
 * (`{ capability: string; input?: unknown }`, per the comment on Candidate
 * above) becomes a Candidate. Missing `input` normalizes to `null`, never
 * to `undefined`: `JSON.stringify` drops an `undefined` property entirely,
 * which would make two candidates that differ only in whether `input` was
 * present at all compare equal under countTrailingIdenticalSteps's
 * JSON.stringify-keyed comparison; `null` survives stringification and
 * keeps that distinction real, even though this task never constructs a
 * case where it matters.
 */
export function normalizeAction(action: { capability: string; input?: unknown }): Candidate {
  return { capability: action.capability, input: action.input ?? null }
}

/**
 * The one place a PlanResponse or DecisionResponse's optional `answer`
 * field becomes the value the rest of this file carries around. An absent
 * field and a present-but-blank one are collapsed into the same `undefined`
 * here, per the usability fix that added this field: whitespace is not a
 * usable answer, and treating it as one would let an empty string
 * masquerade as a real reply once it reaches buildFinalReport.
 */
export function normalizeAnswer(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/**
 * Races `fn(input, signal)` against `signal` itself, so a capability that
 * ignores the signal entirely (echo does; it is synchronous in effect) is
 * still bound by whatever timeout produced that signal. The abandoned
 * promise, if the capability later settles anyway, is simply never awaited
 * again: the same accepted risk src/chat/outbox.ts's withTimeout documents
 * for its own timeout race.
 */
function runCapability(fn: Capability, input: unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('capability aborted before it started'))
      return
    }
    const onAbort = (): void => reject(new Error('capability aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    fn(input, signal).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * AP-1's fail-closed default when no requestApproval was wired into this
 * run's context at all: an 'ask' verdict refuses immediately rather than
 * proceeding, defaulting to allow, or hanging on a promise nothing will
 * ever resolve. Per FR-POL-2, absence of an approval mechanism is not
 * license to skip governance; it is exactly the kind of gap that must fail
 * closed. Production wiring (src/orchestrator.ts) is expected to always
 * supply a real one; every test in this file that deliberately omits
 * requestApproval is proving THIS function's own behaviour, not a
 * production gap.
 */
export const denyForNoApprovalMechanism: RequestApproval = () =>
  Promise.resolve({
    outcome: 'denied',
    reason:
      'no approval mechanism is configured for this run; refusing rather than proceeding or hanging indefinitely (FR-POL-2)',
  })

/**
 * Executes one step end to end: persists it BEFORE invoking the
 * capability, mediates it through the policy engine (AP-1), races an
 * allowed capability against this step's own timeout (combined with the
 * run's outer signal), and persists the outcome AFTER it settles, per AP-5.
 *
 * MEDIATION RUNS BEFORE THE `capabilityFn` CHECK, not after: this is the
 * structural guarantee the whole task exists for. `mediateCapabilityCall`
 * (src/policy/engine.ts) independently refuses a capability absent from the
 * capability REGISTRY before it ever consults policy, which is a different,
 * stricter question than "does THIS loop invocation's own `capabilities`
 * map happen to have a function under that name" (still handled by the
 * `capabilityFn` fallback below, preserved for a capability that is known
 * to governance but was not wired into this particular call). A denied or
 * refused-on-approval verdict never reaches `runCapability` at all: there is
 * no code path from "the engine named a capability" to "the capability ran"
 * that skips the `await mediateCapabilityCall(...)` line below.
 *
 * The `ask` branch inside mediateCapabilityCall is where a step can now
 * spend an arbitrary amount of time awaiting a human, per AP-1's "suspends
 * the run pending an approval rather than proceeding or failing": this
 * function's own await simply does not return until that resolves, which is
 * what suspends the ENTIRE run (the caller, runAgentLoop's while loop, is
 * itself awaiting this call).
 */

/**
 * The outside destination a proposed call will reach, if its capability
 * declares one.
 *
 * Failure here must never become a permit. A capability whose extractor
 * throws yields `undefined`, which means the policy engine evaluates the
 * call with no destination: it still applies every capability-level rule,
 * and the capability's own origin enforcement still runs, so the call is
 * governed rather than waved through. Letting the exception propagate would
 * instead fail the whole step, turning a bad extractor into an outage.
 */
function destinationOfCandidate(candidate: { capability: string; input: unknown }): string | undefined {
  const definition = getCapability(candidate.capability)
  if (!definition?.destinationOf) return undefined
  try {
    return definition.destinationOf(candidate.input)
  } catch {
    return undefined
  }
}

export async function executeStep(
  pool: Pool,
  run: Run,
  candidate: Candidate,
  capabilityFn: Capability | undefined,
  stepTimeoutMs: number,
  outerSignal: AbortSignal,
  log: Logger,
  dbTimeoutMs: number,
  policy: Policy,
  requestApproval: RequestApproval,
): Promise<Step> {
  const step = await runsStore.beginStep(
    pool,
    {
      runId: run.id,
      workspaceId: run.workspaceId,
      capability: candidate.capability,
      input: candidate.input,
    },
    dbTimeoutMs,
  )
  log.info({ stepId: step.id, capability: candidate.capability, seq: step.seq }, 'step persisted before execution')

  // FR-PRF-4 and FR-POL-4: the destination reaches the policy engine BEFORE
  // the capability runs, so the hard-blocked list, the denylist, and
  // first-contact escalation all apply at the mediation seam rather than
  // only inside whichever capability remembered to check. A capability
  // enforcing its own origins is defence in depth; it is not a substitute
  // for the seam, and relying on it would mean each new capability could
  // silently opt out of governance by not implementing the check.
  const destination = destinationOfCandidate(candidate)
  const verdict = await mediateCapabilityCall({
    capability: candidate.capability,
    policy,
    runId: run.id,
    workspaceId: run.workspaceId,
    sessionId: run.sessionId,
    principalId: run.principalId,
    ...(destination !== undefined ? { destination } : {}),
    requestApproval,
  })
  // FR-CAP-4: every mediated call is logged with its decision and reason.
  // `tier` is absent only for the registry-refusal case (there is no
  // declared tier to report for a capability that was never registered),
  // matching MediationVerdict's own doc comment.
  log.info(
    { stepId: step.id, capability: candidate.capability, decision: verdict.outcome, reason: verdict.reason, tier: verdict.tier },
    'capability invocation mediated by policy',
  )
  // Persisted alongside the terminal write below (StepMediation), per Task
  // 3's second review round: the audit question this milestone has to
  // answer is not only "what was blocked" but "what was permitted, and on
  // what grounds", and a rotated log file cannot answer that months later.
  const mediation: runsStore.StepMediation = { decision: verdict.outcome, reason: verdict.reason }

  let outcome: StepOutcome

  if (verdict.outcome === 'refuse') {
    // AP-1: a denied or refused-on-approval call never reaches
    // runCapability. The reason is persisted directly on this step's own
    // `error` column too, the same field every other failed step already
    // uses: "denied by policy" is what a reader of `error` alone still
    // sees, even without querying the dedicated policy_decision/policy_reason
    // columns.
    outcome = { event: 'fail', error: `denied by policy: ${verdict.reason}` }
  } else if (!capabilityFn) {
    outcome = { event: 'fail', error: `unknown capability "${candidate.capability}"; Relay has no such capability registered` }
  } else {
    // FR-APR-1 edit-and-approve: `verdict.input`, when present, REPLACES
    // the originally proposed input for the actual capability call. The
    // step row's own `input` column, already committed by beginStep above
    // before mediation was known, still reflects what was ORIGINALLY
    // proposed, not necessarily what the capability was actually given
    // when an edit occurred; see this task's report for that disclosed as
    // a gap rather than silently glossed over. No production caller drives
    // an edit today (Task 4 has not wired the Slack UX for it yet), so this
    // is exercised by this file's own tests, not by anything reachable in
    // production yet.
    const effectiveInput = verdict.outcome === 'proceed' && 'input' in verdict ? verdict.input : candidate.input
    const stepController = new AbortController()
    const stepTimer = setTimeout(
      () => stepController.abort(new Error(`step exceeded its ${stepTimeoutMs}ms timeout`)),
      stepTimeoutMs,
    )
    const combinedSignal = AbortSignal.any([outerSignal, stepController.signal])
    try {
      const output = await runCapability(capabilityFn, effectiveInput, combinedSignal)
      outcome = { event: 'succeed', output }
    } catch (error) {
      if (stepController.signal.aborted) {
        outcome = { event: 'timeout', error: `step exceeded its ${stepTimeoutMs}ms timeout and was aborted` }
      } else if (outerSignal.aborted) {
        outcome = { event: 'cancel', error: 'the run was cancelled or its overall timeout elapsed while this step was executing' }
      } else {
        outcome = { event: 'fail', error: scrubSecrets(errorMessage(error)) }
      }
    } finally {
      clearTimeout(stepTimer)
    }
  }

  const completed = await runsStore.completeStep(pool, step.id, outcome, mediation, dbTimeoutMs)
  log.info({ stepId: step.id, state: completed.state }, 'step outcome persisted after execution')
  return completed
}

/**
 * Asks a capability to describe its own result for the operator, per
 * `CapabilityDefinition.reportLines`.
 *
 * Defensive on every axis, because this runs inside the loop's hot path and
 * a capability's reporting must never be able to fail a run that otherwise
 * worked: a reportLines that throws, returns the wrong shape, or returns a
 * thousand lines is contained here and logged, not propagated. Scrubbed,
 * because these lines go into a chat message.
 */
export function collectCapabilityNotices(
  into: string[],
  capabilityName: string,
  step: { readonly state: StepState; readonly output: unknown },
  log: Logger,
): void {
  if (step.state !== 'succeeded') return
  const definition = getCapability(capabilityName)
  if (definition?.reportLines === undefined) return

  try {
    const lines = definition.reportLines(step.output)
    if (!Array.isArray(lines)) return
    for (const line of lines.slice(0, MAX_CAPABILITY_NOTICES_PER_STEP)) {
      if (typeof line !== 'string' || line.trim().length === 0) continue
      into.push(scrubSecrets(line.trim()))
    }
  } catch (error) {
    log.warn(
      { capability: capabilityName, err: error },
      'a capability\'s reportLines threw; the run is unaffected but its operator-facing notes were lost',
    )
  }
}

/** A bound on how much one step may add to a chat report. A capability that wanted more than this is describing itself, not reporting. */
export const MAX_CAPABILITY_NOTICES_PER_STEP = 6

