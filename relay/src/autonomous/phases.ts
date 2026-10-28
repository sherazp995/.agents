/**
 * What a worker reply means for its task, as data: no I/O here, so every
 * phase rule is testable on its own. The scheduler performs the effect.
 *
 * Before plan approval the worker is read only and may only ask, restate,
 * propose a plan or report it is blocked. After approval it works, reports
 * progress, asks for a remote write, or says it is done; an implement task's
 * `done` starts relay's own verification, a review task's `done` posts its
 * findings.
 */

import type { AutonomousPhase, AutonomousTask } from './store.js'
import type { PlanPayload, RemoteWrite, WorkerReply } from './reply.js'
import type { WorkerMode } from './worker.js'

/** Phases a worker turn runs in, and in which mode. */
export const TURN_MODE: Partial<Record<AutonomousPhase, WorkerMode>> = {
  intake: 'read_only',
  interview: 'read_only',
  awaiting_plan_approval: 'read_only',
  working: 'bypass',
}

export const TERMINAL_PHASES: readonly AutonomousPhase[] = ['done', 'blocked', 'stopped']

export function isTerminal(phase: AutonomousPhase): boolean {
  return TERMINAL_PHASES.includes(phase)
}

export type Transition =
  /** Post the text and wait for the next message from the thread. */
  | { kind: 'ask'; text: string }
  /** Bind the plan's repository, store it as a new version and post its approval card. */
  | { kind: 'plan'; plan: PlanPayload; text: string }
  /** Post a rate-limited update and run the next turn with "continue". */
  | { kind: 'progress'; text: string }
  /** Ask for a per-operation approval; the worker may keep working locally meanwhile. */
  | { kind: 'remote_write'; write: RemoteWrite; text: string }
  /** Park until an operation the worker is waiting on is resolved. */
  | { kind: 'wait'; text: string }
  /** A review task's findings, posted in the thread. */
  | { kind: 'done_review'; text: string }
  /** An implement task said done: relay verifies before anything is reported as done. */
  | { kind: 'verify'; text: string }
  | { kind: 'blocked'; text: string }
  /** The reply broke a phase rule; the worker is resumed with this correction. */
  | { kind: 'correct'; resume: string }

export function transitionFor(task: Pick<AutonomousTask, 'phase' | 'taskType'>, reply: WorkerReply): Transition {
  const readOnly = TURN_MODE[task.phase] === 'read_only'
  if (readOnly) {
    if (reply.remote_write) return { kind: 'correct', resume: 'Remote writes are possible only after the plan is approved. Finish the interview and propose a plan.' }
    switch (reply.status) {
      case 'question':
      case 'restate':
        return { kind: 'ask', text: reply.text }
      case 'plan':
        // parseWorkerReply guarantees the plan is present for this status.
        return { kind: 'plan', plan: reply.plan as PlanPayload, text: reply.text }
      case 'blocked':
        return { kind: 'blocked', text: reply.text }
      default:
        return { kind: 'correct', resume: `Status ${reply.status} is not available before the plan is approved. Ask, restate, or propose a plan.` }
    }
  }

  if (reply.remote_write) return { kind: 'remote_write', write: reply.remote_write, text: reply.text }
  switch (reply.status) {
    case 'progress':
      return { kind: 'progress', text: reply.text }
    case 'question':
    case 'restate':
      return { kind: 'ask', text: reply.text }
    case 'waiting_on_approval':
      return { kind: 'wait', text: reply.text }
    case 'done':
      return task.taskType === 'implement' ? { kind: 'verify', text: reply.text } : { kind: 'done_review', text: reply.text }
    case 'blocked':
      return { kind: 'blocked', text: reply.text }
    case 'plan':
      return { kind: 'correct', resume: 'The plan is already approved. Work within it; if the scope must change, say so as a question.' }
  }
}

/** Verification rounds before a task is blocked with its gaps. */
export const MAX_VERIFICATION_ROUNDS = 3

/** The fields an approved plan copies onto the task; completion reads only these. */
export function approvedPlanFields(plan: PlanPayload) {
  return {
    approvedScope: plan.scope,
    taskType: plan.task_type,
    changeKind: plan.change_kind,
    visible: plan.visible,
    acceptanceCriteria: plan.acceptance_criteria,
    testCommand: plan.test_command,
  }
}
