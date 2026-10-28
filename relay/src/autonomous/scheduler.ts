/**
 * The autonomous scheduler: a timer loop in the daemon that leases due
 * tasks and runs one step for each (a worker turn, or verification), with
 * the lease renewed while the step runs. Inbound handling never runs a
 * worker; it only wakes this loop.
 *
 * Fencing: every task write names the lease it holds. A holder whose renewal
 * fails kills its own worker tree at once and discards that turn's reply.
 * Before any holder opens a start gate on a task that still records a
 * worker, it kills that process group and waits for it to exit (one
 * takeover procedure for startup and for an ordinary lease expiry), so two
 * workers never run for one task.
 *
 * What a turn and its side effects do (spawning a CLI on an account,
 * binding a repo, posting a plan card, requesting a remote write,
 * verifying) is injected, so this file holds only the scheduling rules.
 */

import { execFileSync } from 'node:child_process'
import type { Pool } from 'pg'
import type { ChatAction, ChatRef } from '../chat/contract.js'
import type { Logger } from '../obs/logger.js'
import { killProcessGroup, processGroupAlive } from '../process/gated-spawn.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { isTerminal, MAX_VERIFICATION_ROUNDS, transitionFor, TURN_MODE, type Transition } from './phases.js'
import { buildTurnPrompt } from './prompt.js'
import type { PlanPayload, RemoteWrite } from './reply.js'
import {
  acquireLease,
  addNote,
  appendProgress,
  consumeNotes,
  listOpenTasks,
  clearWorker,
  consumeEvents,
  listDueWakeups,
  listTasksWithWorker,
  loadTask,
  markTaskStopped,
  recordWorker,
  releaseLease,
  renewLease,
  requestCancel,
  updateTask,
  type AutonomousTask,
  type Lease,
} from './store.js'
import type { TurnOutcome, WorkerMode } from './worker.js'

export const DEFAULT_LEASE_TTL_MS = 60_000
export const DEFAULT_TICK_MS = 2_000
const GROUP_EXIT_POLL_MS = 50
const GROUP_EXIT_TIMEOUT_MS = 10_000
const RETRY_LATER_MS = 30_000

export type TurnRequestContext = {
  task: AutonomousTask
  lease: Lease
  mode: WorkerMode
  prompt: string
  /** The prompt for a turn that cannot resume a session: `prompt` plus the Slack thread so far. Built only when needed. */
  freshPrompt?: () => Promise<string>
  signal: AbortSignal
  /** Fenced write of the worker's pid before its gate opens. */
  recordWorker: (pid: number, pgid: number) => Promise<boolean>
}

export type TurnResult =
  | { kind: 'outcome'; outcome: TurnOutcome; accountKey: string; runId: string; notes: readonly string[] }
  /** Every account is cooling down or ineligible. */
  | { kind: 'no_account'; wakeAtMs: number | null; reason: string }
  /** Admission refused: a budget cap would be passed. */
  | { kind: 'refused'; reason: string }

export type VerificationResult = { kind: 'passed' } | { kind: 'gaps'; gaps: readonly string[] } | { kind: 'blocked'; reason: string }

export type PlanBinding = { kind: 'bound'; repoName: string } | { kind: 'unbound'; reason: string }

/** Everything outside scheduling that a step needs. */
export interface SchedulerEffects {
  runTurn(context: TurnRequestContext): Promise<TurnResult>
  /** Downloads the task's pending files; returns lines for the thread about skipped ones. */
  downloadFiles(task: AutonomousTask, lease: Lease): Promise<readonly string[]>
  /** Resolves plan.repo against the registry. */
  bindPlan(task: AutonomousTask, plan: PlanPayload): Promise<PlanBinding>
  /** Stores the plan as a new version and posts its `plan` approval card, in one transaction. */
  postPlanForApproval(task: AutonomousTask, lease: Lease, plan: PlanPayload, repoName: string, runId: string): Promise<void>
  /** Applies a resolved plan approval, operation outcomes or expiries; returns notes for the next turn, or undefined when nothing changed. */
  settleApprovals(task: AutonomousTask, lease: Lease): Promise<{ notes: readonly string[]; phase?: AutonomousTask['phase'] } | undefined>
  /** Requests a remote write; returns the note for the worker (operation pending, refused, or verifying first). */
  requestRemoteWrite(task: AutonomousTask, lease: Lease, write: RemoteWrite, runId: string, signal: AbortSignal): Promise<string>
  /** Creates the worktree for an approved implement or review plan when it does not exist yet. */
  prepareWorktree(task: AutonomousTask, lease: Lease): Promise<void>
  /** Runs relay's own verification of the task's committed snapshot. */
  verify(task: AutonomousTask, lease: Lease, signal: AbortSignal): Promise<VerificationResult>
  /** Posts the final result: findings, uploads, reaction. */
  finish(task: AutonomousTask, outcome: 'done' | 'blocked', text: string): Promise<void>
  /** Stop's cleanup: cancels requested and approved operations and expires their approvals, deletes task secrets. */
  cleanupStopped(task: AutonomousTask): Promise<void>
  /** Once per tick: expires overdue approvals and wakes the tasks that wait on them. */
  sweep(): Promise<void>
  /** The thread's messages before `beforeTs`, rendered for the worker; null when there are none or they cannot be read. */
  threadHistory?(task: AutonomousTask, beforeTs: string | null): Promise<string | null>
}

export type SchedulerDeps = {
  pool: Pool
  workspaceId: string
  /** This daemon's lease owner name. */
  owner: string
  post: (action: ChatAction) => Promise<void>
  /** Where the task's thread replies go. */
  replyRef: (task: AutonomousTask) => Promise<ChatRef>
  /** Re-reads the kill switch (an engage from the CLI) and answers whether it is engaged. */
  isKillSwitchEngaged: () => Promise<boolean>
  effects: SchedulerEffects
  log: Logger
  leaseTtlMs?: number
  tickMs?: number
}

export type Scheduler = {
  start(): Promise<void>
  /** Runs one pass now (the router calls it through wake()). */
  wake(): void
  /** Kills every running worker tree, then releases leases. */
  stop(): Promise<void>
  /** For tests: one pass, awaited. */
  tick(): Promise<void>
}

/** Kills a recorded worker's group when it is still ours, and waits for it to exit. */
export async function takeOverWorker(pool: Pool, task: Pick<AutonomousTask, 'id' | 'workerPgid'>): Promise<boolean> {
  const pgid = task.workerPgid
  if (pgid === null) return true
  if (processGroupAlive(pgid) && looksLikeWorker(pgid)) {
    killProcessGroup(pgid)
    const deadline = Date.now() + GROUP_EXIT_TIMEOUT_MS
    while (processGroupAlive(pgid)) {
      if (Date.now() > deadline) return false
      killProcessGroup(pgid)
      await new Promise((resolve) => setTimeout(resolve, GROUP_EXIT_POLL_MS))
    }
  }
  await clearWorker(pool, task.id, pgid)
  return true
}

/**
 * A reused pgid that is not one of relay's gated workers is never signalled.
 * Every member of the group is checked, because the leader may have exited
 * while its children survive.
 */
function looksLikeWorker(pgid: number): boolean {
  try {
    const members = execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).split('\n').filter((pid) => /^\d+$/.test(pid))
    if (members.length === 0) return false
    const commands = execFileSync('ps', ['-o', 'command=', '-p', members.join(',')], { encoding: 'utf8' })
    return /read -r go|claude|codex/.test(commands)
  } catch {
    return false
  }
}

/**
 * Stop for an autonomous task: durable cancel first (every later lease,
 * spawn, hook decision and dispatch checks it), then the worker tree, the
 * operations, and the final phase.
 */
export async function stopAutonomousTask(pool: Pool, effects: Pick<SchedulerEffects, 'cleanupStopped'>, taskId: string): Promise<AutonomousTask | undefined> {
  const cancelled = await requestCancel(pool, taskId)
  if (!cancelled) return undefined
  if (cancelled.workerPgid !== null) killProcessGroup(cancelled.workerPgid)
  const stopped = await markTaskStopped(pool, taskId)
  if (stopped) await effects.cleanupStopped(stopped)
  return stopped
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const ttlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>()
  /** schema_invalid retries per task, in memory: one retry, then blocked. */
  const schemaRetries = new Map<string, number>()
  let timer: NodeJS.Timeout | undefined
  let stopping = false
  let ticking: Promise<void> | undefined

  const post = async (task: AutonomousTask, text: string): Promise<void> => {
    if (text.trim() === '') return
    await deps.post({ kind: 'post', ref: await deps.replyRef(task), text: scrubSecrets(text) })
  }

  async function tick(): Promise<void> {
    if (stopping) return
    if (await deps.isKillSwitchEngaged()) {
      for (const { controller } of running.values()) controller.abort()
      for (const task of await listOpenTasks(deps.pool, deps.workspaceId)) {
        const stopped = await stopAutonomousTask(deps.pool, deps.effects, task.id)
        if (stopped) await deps.effects.finish(stopped, 'blocked', 'Stopped: the kill switch is engaged.')
      }
      return
    }
    await deps.effects.sweep()
    const due = await listDueWakeups(deps.pool, deps.workspaceId)
    for (const task of due) {
      if (running.has(task.id) || stopping) continue
      const controller = new AbortController()
      const done = runStep(task.id, controller).catch((error: unknown) => {
        deps.log.error({ err: error, taskId: task.id }, 'autonomous step failed')
      })
      running.set(task.id, { controller, done: done.finally(() => running.delete(task.id)) })
    }
  }

  async function runStep(taskId: string, controller: AbortController): Promise<void> {
    const lease = await acquireLease(deps.pool, taskId, deps.owner, ttlMs)
    if (!lease) return
    let lost = false
    const renewal = setInterval(() => {
      void renewLease(deps.pool, lease, ttlMs).then(
        (held) => {
          if (held) return
          lost = true
          controller.abort()
        },
        () => {
          lost = true
          controller.abort()
        },
      )
    }, Math.max(1000, Math.floor(ttlMs / 3)))
    renewal.unref()
    try {
      const task = await loadTask(deps.pool, taskId)
      if (!task || task.leaseGeneration !== lease.generation) return
      if (!(await takeOverWorker(deps.pool, task))) {
        deps.log.error({ taskId }, 'a recorded worker did not exit; not starting another')
        await updateTask(deps.pool, lease, { nextWakeupAt: new Date(Date.now() + RETRY_LATER_MS) })
        return
      }
      await step({ ...task, workerPid: null, workerPgid: null }, lease, controller.signal, () => lost)
    } finally {
      clearInterval(renewal)
      if (!lost) await releaseLease(deps.pool, lease).catch(() => undefined)
    }
  }

  async function step(task: AutonomousTask, lease: Lease, signal: AbortSignal, isLost: () => boolean): Promise<void> {
    if (task.cancelRequestedAt !== null || task.phase === 'stopped' || (isTerminal(task.phase) && task.pendingEvents.length === 0)) {
      await updateTask(deps.pool, lease, { nextWakeupAt: null })
      return
    }

    // A message after done or blocked reopens the task with its stored findings, rechecked by id.
    if (isTerminal(task.phase)) {
      task = (await updateTask(deps.pool, lease, { phase: 'working', reviewRounds: 0 })) ?? task
      if (task.findings.length > 0) {
        await addNote(deps.pool, lease, `Reopened. Recheck each stored finding by id and report it as fixed or still_open:\n${task.findings.map((finding) => `- ${finding.id} ${finding.severity} ${finding.file}:${finding.line ?? ''} ${finding.summary}`).join('\n')}`)
      }
    }

    const skipped = await deps.effects.downloadFiles(task, lease)
    for (const line of skipped) await post(task, line)

    const settled = await deps.effects.settleApprovals(task, lease)
    for (const note of settled?.notes ?? []) await addNote(deps.pool, lease, note)
    if (settled?.phase !== undefined) task = (await updateTask(deps.pool, lease, { phase: settled.phase })) ?? task
    task = (await loadTask(deps.pool, task.id)) ?? task

    if (task.phase === 'verifying') {
      await runVerification(task, lease, signal)
      return
    }
    // Parked on a decision: nothing new for the worker.
    if ((task.phase === 'awaiting_plan_approval' || task.phase === 'waiting_on_approval') && task.pendingNotes.length === 0 && task.pendingEvents.length === 0) {
      await updateTask(deps.pool, lease, { nextWakeupAt: null })
      return
    }
    if (task.phase === 'intake') task = (await updateTask(deps.pool, lease, { phase: 'interview' })) ?? task
    if (task.phase === 'waiting_on_approval' || task.phase === 'awaiting_plan_approval') {
      task = (await updateTask(deps.pool, lease, { phase: task.phase === 'waiting_on_approval' ? 'working' : 'interview' })) ?? task
    }
    if (task.phase === 'working') await deps.effects.prepareWorktree(task, lease)
    const fresh = (await loadTask(deps.pool, task.id)) ?? task

    await runTurn(fresh, lease, signal, isLost)
  }

  async function runTurn(task: AutonomousTask, lease: Lease, signal: AbortSignal, isLost: () => boolean): Promise<void> {
    const mode = TURN_MODE[task.phase] ?? 'read_only'
    const consumed = task.pendingEvents.map((event) => event.id)
    const notesRead = task.pendingNotes.length
    const result = await deps.effects.runTurn({
      task,
      lease,
      mode,
      prompt: buildTurnPrompt(task, task.pendingNotes),
      freshPrompt: async () => buildTurnPrompt(task, task.pendingNotes, await deps.effects.threadHistory?.(task, firstPendingTs(task)) ?? null),
      signal,
      recordWorker: (pid, pgid) => recordWorker(deps.pool, lease, pid, pgid),
    })
    if (isLost()) return

    if (result.kind === 'no_account') {
      await post(task, result.reason)
      await updateTask(deps.pool, lease, { nextWakeupAt: result.wakeAtMs === null ? null : new Date(result.wakeAtMs) })
      return
    }
    if (result.kind === 'refused') return block(task, lease, result.reason)
    // Account fallbacks are relay's business, not the thread's.
    for (const note of result.notes) deps.log.info({ taskId: task.id }, note)

    const outcome = result.outcome
    switch (outcome.kind) {
      case 'reply': {
        schemaRetries.delete(task.id)
        // Consumed only while the lease still holds, so a lost lease leaves the events for the next holder.
        const updated = await updateTask(deps.pool, lease, { engineSessionId: outcome.sessionId, accountKey: result.accountKey })
        if (!updated) return
        await consumeEvents(deps.pool, lease, consumed)
        await consumeNotes(deps.pool, lease, notesRead)
        if (outcome.reply.findings) {
          const findings = outcome.reply.findings.map(({ inScope, ...finding }) => (inScope === undefined ? finding : { ...finding, inScope }))
          await updateTask(deps.pool, lease, { findings })
        }
        await apply(updated, lease, transitionFor(updated, outcome.reply), result.runId, signal)
        return
      }
      case 'schema_invalid': {
        const retries = (schemaRetries.get(task.id) ?? 0) + 1
        schemaRetries.set(task.id, retries)
        if (retries > 1) return block(task, lease, `the worker's reply did not match the reply schema twice: ${outcome.error}`)
        await addNote(deps.pool, lease, `Your last reply did not match the reply schema (${outcome.error}). Reply again with a valid reply object.`)
        await updateTask(deps.pool, lease, { nextWakeupAt: 'now', ...(outcome.sessionId !== null ? { engineSessionId: outcome.sessionId } : {}) })
        return
      }
      case 'resume_rejected':
        // The next turn starts a fresh session with the same pending events.
        await updateTask(deps.pool, lease, { engineSessionId: null, nextWakeupAt: 'now' })
        return
      case 'not_started':
      case 'account_blocked':
        await updateTask(deps.pool, lease, { nextWakeupAt: new Date(Date.now() + RETRY_LATER_MS) })
        return
      case 'stopped':
        return
      case 'mcp_violation':
        return block(task, lease, `the worker started with MCP servers relay does not wrap: ${outcome.servers.join(', ')}`)
      case 'over_budget':
        return block(task, lease, `the turn reached its budget reservation ($${outcome.costUsd.toFixed(2)}) and was stopped`)
      case 'failed':
        return block(task, lease, `the worker failed: ${outcome.reason}`)
    }
  }

  async function apply(task: AutonomousTask, lease: Lease, transition: Transition, runId: string, signal: AbortSignal): Promise<void> {
    switch (transition.kind) {
      case 'ask':
        await post(task, transition.text)
        await updateTask(deps.pool, lease, { nextWakeupAt: null })
        return
      case 'plan': {
        const binding = await deps.effects.bindPlan(task, transition.plan)
        if (binding.kind === 'unbound') {
          await post(task, binding.reason)
          await resume(task, lease, `The plan's repo could not be bound: ${binding.reason} Propose the plan again with a registered repo.`)
          return
        }
        await deps.effects.postPlanForApproval(task, lease, transition.plan, binding.repoName, runId)
        await updateTask(deps.pool, lease, { phase: 'awaiting_plan_approval', nextWakeupAt: null })
        return
      }
      case 'progress':
        await appendProgress(deps.pool, lease, transition.text)
        await post(task, transition.text)
        await updateTask(deps.pool, lease, { nextWakeupAt: 'now' })
        return
      case 'remote_write': {
        const note = await deps.effects.requestRemoteWrite(task, lease, transition.write, runId, signal)
        await post(task, transition.text)
        await resume(task, lease, note)
        return
      }
      case 'wait':
        await post(task, transition.text)
        await updateTask(deps.pool, lease, { phase: 'waiting_on_approval', nextWakeupAt: null })
        return
      case 'done_review':
        await updateTask(deps.pool, lease, { phase: 'done', nextWakeupAt: null })
        await deps.effects.finish(task, 'done', transition.text)
        return
      case 'verify':
        await post(task, transition.text)
        await updateTask(deps.pool, lease, { phase: 'verifying', nextWakeupAt: 'now' })
        return
      case 'blocked':
        return finishBlocked(task, lease, transition.text)
      case 'correct':
        await resume(task, lease, transition.resume)
        return
    }
  }

  /** The next turn runs at once with this note first. */
  async function resume(_task: AutonomousTask, lease: Lease, note: string): Promise<void> {
    await addNote(deps.pool, lease, note)
  }

  async function runVerification(task: AutonomousTask, lease: Lease, signal: AbortSignal): Promise<void> {
    let result: Awaited<ReturnType<SchedulerEffects['verify']>>
    try {
      result = await deps.effects.verify(task, lease, signal)
    } catch (error) {
      // A verification that cannot run blocks once instead of retrying every tick.
      if (signal.aborted) return
      return block(task, lease, `verification could not run: ${(error as Error).message}`)
    }
    if (result.kind === 'passed') {
      await updateTask(deps.pool, lease, { phase: 'done', nextWakeupAt: null })
      // The worker's own done text was posted when verification started; only the findings and ✅ follow.
      await deps.effects.finish(task, 'done', '')
      return
    }
    if (result.kind === 'blocked') return block(task, lease, result.reason)
    const rounds = task.reviewRounds + 1
    if (rounds >= MAX_VERIFICATION_ROUNDS) return block(task, lease, `verification failed three rounds:\n${result.gaps.map((gap) => `- ${gap}`).join('\n')}`)
    await updateTask(deps.pool, lease, { reviewRounds: rounds, phase: 'working' })
    await resume(task, lease, `Verification found gaps; fix them and say done again:\n${result.gaps.map((gap) => `- ${gap}`).join('\n')}`)
  }

  /** Relay's own reason for blocking the task. */
  async function block(task: AutonomousTask, lease: Lease, reason: string): Promise<void> {
    await finishBlocked(task, lease, `Blocked: ${reason}`)
  }

  /** Posts the text as is: the worker's own words, or relay's prefixed reason. */
  async function finishBlocked(task: AutonomousTask, lease: Lease, text: string): Promise<void> {
    const updated = await updateTask(deps.pool, lease, { phase: 'blocked', nextWakeupAt: null })
    if (updated) await deps.effects.finish(updated, 'blocked', text)
  }

  return {
    async start() {
      // Startup recovery: no recorded worker survives a restart unkilled.
      for (const task of await listTasksWithWorker(deps.pool, deps.workspaceId)) {
        if (!(await takeOverWorker(deps.pool, task))) deps.log.error({ taskId: task.id }, 'a recorded worker did not exit at startup')
      }
      timer = setInterval(() => this.wake(), tickMs)
      timer.unref()
      this.wake()
    },
    wake() {
      if (ticking || stopping) return
      ticking = tick()
        .catch((error: unknown) => deps.log.error({ err: error }, 'autonomous tick failed'))
        .finally(() => {
          ticking = undefined
        })
    },
    async stop() {
      stopping = true
      if (timer) clearInterval(timer)
      for (const { controller } of running.values()) controller.abort()
      await Promise.all([...running.values()].map((entry) => entry.done))
      await ticking
    },
    tick: async () => {
      await tick()
      await Promise.all([...running.values()].map((entry) => entry.done))
    },
  }
}

/** The earliest new message the worker gets anyway, so the history stops before it. */
function firstPendingTs(task: AutonomousTask): string | null {
  const stamps = task.pendingEvents.map((event) => event.ref.message ?? event.ref.thread).filter((ts): ts is string => ts !== undefined)
  return stamps.length === 0 ? null : stamps.reduce((min, ts) => (Number(ts) < Number(min) ? ts : min))
}
