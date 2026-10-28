/**
 * The run and step state machines, per the Task 6 brief: pure transitions,
 * no IO. src/runs/store.ts is the only caller that touches Postgres; this
 * module knows nothing about a database, a clock, or a subprocess, so it is
 * testable with plain values and cannot itself be the reason a test needs a
 * running Postgres instance.
 *
 * Keeping the transition tables as data (TRANSITIONS below), rather than a
 * switch statement per state, means the legal graph is readable in one
 * place and a test can assert against it directly instead of reverse
 * engineering it from a dozen `if` branches.
 */

/** A run's lifecycle. Every run starts 'queued' and ends in exactly one of the four terminal states. */
export type RunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dead_letter'

/**
 * A step's lifecycle. AP-5 needs two persisted writes per step, one before
 * execution and one after, so 'running' is a real, separately-observable
 * state, not a transient value that only ever exists in memory.
 */
export type StepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled'

export type RunEvent = 'start' | 'succeed' | 'fail' | 'cancel' | 'dead_letter'
export type StepEvent = 'start' | 'succeed' | 'fail' | 'timeout' | 'cancel'

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'dead_letter',
])

const TERMINAL_STEP_STATES: ReadonlySet<StepState> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
])

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state)
}

export function isTerminalStepState(state: StepState): boolean {
  return TERMINAL_STEP_STATES.has(state)
}

/**
 * The legal run transition graph. A run can be cancelled from 'queued' or
 * 'running' (a Stop can arrive before the loop ever executes a step), and
 * 'dead_letter' is reachable only from 'running', per FR-ORC-9: it is what
 * loop protection's second threshold does to an already-running run, never
 * an initial state.
 */
const RUN_TRANSITIONS: Readonly<Record<RunState, Readonly<Partial<Record<RunEvent, RunState>>>>> = {
  queued: { start: 'running', cancel: 'cancelled' },
  running: { succeed: 'succeeded', fail: 'failed', cancel: 'cancelled', dead_letter: 'dead_letter' },
  succeeded: {},
  failed: {},
  cancelled: {},
  dead_letter: {},
}

/**
 * The legal step transition graph. A step can be cancelled from 'pending'
 * (a Stop lands between persisting the row and actually invoking the
 * capability) or from 'running' (mid-execution). 'timeout' only applies to
 * a step already 'running', per FR-ORC-8: nothing times out before it has
 * started.
 */
const STEP_TRANSITIONS: Readonly<Record<StepState, Readonly<Partial<Record<StepEvent, StepState>>>>> = {
  pending: { start: 'running', cancel: 'cancelled' },
  running: { succeed: 'succeeded', fail: 'failed', timeout: 'timed_out', cancel: 'cancelled' },
  succeeded: {},
  failed: {},
  timed_out: {},
  cancelled: {},
}

/** Thrown by transitionRun / transitionStep for any transition not present in the tables above. */
export class IllegalTransitionError extends Error {
  constructor(kind: 'run' | 'step', state: string, event: string) {
    super(`illegal ${kind} transition: cannot apply event "${event}" from state "${state}"`)
    this.name = 'IllegalTransitionError'
  }
}

/**
 * Applies `event` to `state`, returning the resulting RunState. Throws
 * IllegalTransitionError for any pair not in RUN_TRANSITIONS, including
 * every event from a terminal state: a terminal run state has no outgoing
 * edges by construction (RUN_TRANSITIONS lists them as `{}`), so this
 * function alone is what guarantees a terminal run can never be reopened,
 * with no separate "is this terminal" check needed at every call site.
 */
export function transitionRun(state: RunState, event: RunEvent): RunState {
  const next = RUN_TRANSITIONS[state][event]
  if (next === undefined) throw new IllegalTransitionError('run', state, event)
  return next
}

/** Applies `event` to `state`, returning the resulting StepState. Same contract as transitionRun. */
export function transitionStep(state: StepState, event: StepEvent): StepState {
  const next = STEP_TRANSITIONS[state][event]
  if (next === undefined) throw new IllegalTransitionError('step', state, event)
  return next
}

/**
 * The minimal shape countTrailingIdenticalSteps needs from a step: enough
 * to decide whether two consecutive steps are "identical" for loop
 * protection purposes, per FR-ORC-9. Compared by capability name plus a
 * JSON-serialised input rather than by reference, since two distinct step
 * records with equal content are exactly what a stuck loop repeats.
 */
export type LoopProtectionStep = {
  readonly capability: string
  readonly input: unknown
}

/**
 * Counts how many steps at the end of `steps`, read oldest-first, are
 * identical to the one immediately before them, per FR-ORC-9's "identical
 * consecutive steps" trigger. A pure function over an ordered array rather
 * than a database query, so the threshold logic itself needs no Postgres
 * connection to test: src/runs/store.ts supplies the ordered steps (by its
 * monotonic `seq` column, see that module's header comment), and
 * src/agent/loop.ts is the only caller that decides what to do with the
 * count.
 *
 * Returns 0 for fewer than two steps, since there is nothing to compare a
 * single step against. Comparison is by JSON.stringify equality on
 * `{ capability, input }`; this is deliberately blunt (two inputs that
 * differ only in key order would compare unequal) because the loop
 * protection threshold this feeds is itself a blunt backstop against a
 * literally-stuck loop, not a semantic similarity judge, and a false
 * negative here only costs one more repeat before the next comparison
 * catches it.
 *
 * DECISION (fix round 1 on Task 6, examined deliberately rather than left
 * as an accident of the first implementation): exact equality is kept,
 * not loosened into a fuzzy or structural "near-identical" comparison.
 * Stated plainly what that does and does not catch, per FR-ORC-9's own
 * "identical or near-identical" wording (the Task 6 brief narrowed scope to
 * "identical" only; this decision is about the "near-identical" half that
 * narrowing left out):
 *
 *   - CATCHES: the classic no-progress loop, an engine (or a broken
 *     capability) proposing the exact same capability and input over and
 *     over with no variation at all. This is the failure mode FR-ORC-9
 *     exists for, and exact equality catches it perfectly and cheaply,
 *     with no risk of a false positive: two calls that really are
 *     byte-identical really are the same step repeated.
 *   - MISSES: a runaway that varies any field on every attempt, most
 *     plausibly an incrementing counter, a timestamp, or a random id folded
 *     into the input, while making no actual progress. Such a run is
 *     never flagged by this function, no matter how many times it repeats.
 *
 * The alternative on the table was a structural or fuzzy comparison
 * (capability name plus a normalised input, ignoring fields that look like
 * counters or timestamps). Rejected: this milestone ships exactly one
 * capability (echo), so "same capability, roughly the same shape of input"
 * is a description that fits nearly every legitimate multi-step run just as
 * well as it fits a stuck one; loosening the comparison trades a
 * detection gap for a false-positive risk that dead-letters healthy work,
 * which is the worse failure mode of the two; a dead-lettered healthy run
 * is loud, visible, and requires human intervention to even notice it was
 * wrong, whereas an undetected slow-varying runaway is bounded and stops
 * itself. Getting a fuzzy comparison genuinely right (telling "an
 * incrementing counter with no real progress" apart from "the Nth of ten
 * legitimately different inputs") is a real design problem, not a small
 * tweak, and was not attempted here.
 *
 * What actually bounds a "near-identical" runaway that evades this
 * function: FR-ORC-8's run-level wall-clock timeout (default 30 minutes,
 * enforced in src/agent/loop.ts, independent of this function entirely).
 * That is a real bound, not a hope: a degenerate loop that keeps varying
 * its input just enough to dodge this comparison still cannot run past
 * the run timeout, so the worst case is bounded cost over a bounded
 * window, never an unbounded run. It is a materially worse outcome than
 * catching the runaway at step 4 or 7 the way an exact repeat would be,
 * stated here rather than left implicit.
 *
 * Walks from the end backwards so a run whose early steps happened to
 * repeat but later ones diverged is not penalised for history that no
 * longer describes what the run is doing right now; only a run currently
 * stuck, this instant, on the same step over and over, trips the count.
 */
export function countTrailingIdenticalSteps(steps: readonly LoopProtectionStep[]): number {
  if (steps.length < 2) return 0

  const key = (step: LoopProtectionStep): string =>
    JSON.stringify({ capability: step.capability, input: step.input })

  const lastKey = key(steps[steps.length - 1] as LoopProtectionStep)
  let count = 1
  for (let i = steps.length - 2; i >= 0; i--) {
    if (key(steps[i] as LoopProtectionStep) !== lastKey) break
    count += 1
  }
  return count
}
