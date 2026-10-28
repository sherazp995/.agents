/**
 * The scheduler: a timer loop in the daemon that leases due tasks (one per
 * Slack thread) and runs one chat turn for each, with the lease renewed
 * while the turn runs. Inbound handling never runs a worker; it only wakes
 * this loop.
 *
 * Fencing: every task write names the lease it holds. A holder whose renewal
 * fails kills its own worker tree at once and discards that turn's reply.
 * Before any holder opens a start gate on a task that still records a
 * worker, it kills that process group and waits for it to exit (one
 * takeover procedure for startup and for an ordinary lease expiry), so two
 * workers never run for one task.
 *
 * A message that arrives while a Claude turn runs is sent into that turn
 * (`TurnInbox`) and counted as read with it; on codex it waits for the
 * next turn.
 *
 * What a turn and its side effects do (spawning a CLI on an account,
 * downloading files, settling approvals) is injected, so this file holds
 * only the scheduling rules.
 */

import { execFileSync } from 'node:child_process'
import type { Pool, PoolClient } from 'pg'
import type { ChatAction, ChatRef } from '../chat/contract.js'
import type { Logger } from '../obs/logger.js'
import { killProcessGroup, processGroupAlive } from '../process/gated-spawn.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { buildTurnPrompt, renderNewMessages } from './prompt.js'
import {
  acquireLease,
  listOpenTasks,
  clearWorker,
  consumeTurnInput,
  inTransaction,
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
  type TaskUpdate,
} from './store.js'
import type { TurnInbox, TurnOutcome } from './worker.js'

export const DEFAULT_LEASE_TTL_MS = 60_000
export const DEFAULT_TICK_MS = 2_000
const GROUP_EXIT_POLL_MS = 50
const GROUP_EXIT_TIMEOUT_MS = 10_000
const RETRY_LATER_MS = 30_000

export type TurnRequestContext = {
  task: AutonomousTask
  lease: Lease
  prompt: string
  /** The prompt for a turn that cannot resume a session: `prompt` plus the Slack thread so far. Built only when needed. */
  freshPrompt?: () => Promise<string>
  signal: AbortSignal
  /** Fenced write of the worker's pid before its gate opens. */
  recordWorker: (pid: number, pgid: number) => Promise<boolean>
  /** Set by a worker that takes input while it runs. */
  inbox?: TurnInbox
  /** The messages already sent into this turn, rendered, for an account fallback to repeat in its prompt; '' when none. */
  sentSoFar?: () => string
}

export type TurnResult =
  | { kind: 'outcome'; outcome: TurnOutcome; accountKey: string; runId: string; notes: readonly string[] }
  /** Every account is cooling down or ineligible. */
  | { kind: 'no_account'; wakeAtMs: number | null; reason: string }

/** Everything outside scheduling that a step needs. */
export interface SchedulerEffects {
  runTurn(context: TurnRequestContext): Promise<TurnResult>
  /** Downloads the task's pending files; returns lines for the thread about skipped ones. */
  downloadFiles(task: AutonomousTask, lease: Lease): Promise<readonly string[]>
  /** Applies resolved approvals and expiries; returns notes for the next turn. */
  settleApprovals(task: AutonomousTask, lease: Lease): Promise<void>
  /** Stop's cleanup: cancels requested and approved operations and expires their approvals. */
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
  /** Queues a post; with `executor`, inside that transaction. */
  post: (action: ChatAction, executor?: PoolClient) => Promise<void>
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
        if (stopped) await post(stopped, 'Stopped: the kill switch is engaged.')
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
    if (task.cancelRequestedAt !== null || task.phase === 'stopped') {
      await updateTask(deps.pool, lease, { nextWakeupAt: null })
      return
    }
    const skipped = await deps.effects.downloadFiles(task, lease)
    for (const line of skipped) await post(task, line)
    await deps.effects.settleApprovals(task, lease)
    const fresh = (await loadTask(deps.pool, task.id)) ?? task
    // The wakeup this step started on: one set after it (a message or an approval meanwhile) is kept.
    const dueAt = task.nextWakeupAt
    if (fresh.pendingEvents.length === 0 && fresh.pendingNotes.length === 0) {
      await consumeTurnInput(deps.pool, lease, { eventIds: [], notesRead: 0, dueAt })
      return
    }
    await runTurn(fresh, lease, dueAt, signal, isLost)
  }

  async function runTurn(task: AutonomousTask, lease: Lease, dueAt: Date | null, signal: AbortSignal, isLost: () => boolean): Promise<void> {
    const consumed = task.pendingEvents.map((event) => event.id)
    const notesRead = task.pendingNotes.length
    const inbox: TurnInbox = { send: null }
    // Messages sent into the running turn: read with its reply, kept pending when it fails.
    const sent: { events: AutonomousTask['pendingEvents']; files: AutonomousTask['files'] } = { events: [], files: [] }
    const feeder = feedRunningTurn(task.id, lease, inbox, consumed, sent)
    let result: TurnResult
    try {
      result = await deps.effects.runTurn({
        task,
        lease,
        prompt: buildTurnPrompt(task, task.pendingNotes),
        freshPrompt: async () => buildTurnPrompt(task, task.pendingNotes, await deps.effects.threadHistory?.(task, firstPendingTs(task)) ?? null),
        signal,
        recordWorker: (pid, pgid) => recordWorker(deps.pool, lease, pid, pgid),
        inbox,
        sentSoFar: () => renderNewMessages(sent.events, sent.files),
      })
    } finally {
      await feeder.stop()
    }
    if (isLost()) return

    if (result.kind === 'no_account') {
      await post(task, result.reason)
      await updateTask(deps.pool, lease, { nextWakeupAt: result.wakeAtMs === null ? null : new Date(result.wakeAtMs) })
      return
    }
    // Account fallbacks are relay's business, not the thread's.
    for (const note of result.notes) deps.log.info({ taskId: task.id }, note)

    const outcome = result.outcome
    switch (outcome.kind) {
      case 'reply':
        await finishTurn(task, lease, { eventIds: [...consumed, ...sent.events.map((event) => event.id)], notesRead, dueAt }, { engineSessionId: outcome.sessionId, accountKey: result.accountKey }, outcome.text)
        return
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
      case 'failed':
        // The turn's own messages are dropped with the failure, so the next message starts clean instead of looping.
        // Messages sent into it mid-turn stay pending: the failed worker may never have read them.
        await finishTurn(task, lease, { eventIds: consumed, notesRead, dueAt }, {}, `That turn failed: ${outcome.reason}`)
        return
    }
  }

  /**
   * While a turn runs, sends the thread's new messages into it every tick
   * and records them in `sent`. A message waits until its files are
   * downloaded. Nothing is sent while `inbox.send` is null: before the gate,
   * after the result, and for codex.
   */
  function feedRunningTurn(
    taskId: string,
    lease: Lease,
    inbox: TurnInbox,
    consumed: readonly string[],
    sent: { events: AutonomousTask['pendingEvents']; files: AutonomousTask['files'] },
  ): { stop(): Promise<void> } {
    let feeding: Promise<void> | undefined
    const feed = async (): Promise<void> => {
      if (inbox.send === null) return
      const isNew = (event: AutonomousTask['pendingEvents'][number]): boolean => !consumed.includes(event.id) && !sent.events.some((done) => done.id === event.id)
      const current = await loadTask(deps.pool, taskId)
      if (!current?.pendingEvents.some(isNew)) return
      if (current.files.some((file) => file.status === 'pending')) {
        for (const line of await deps.effects.downloadFiles(current, lease)) await post(current, line)
      }
      const fresh = (await loadTask(deps.pool, taskId)) ?? current
      const fileOf = new Map(fresh.files.map((file) => [file.slackFileId, file]))
      // A file that arrived after the download is still pending: its message waits for the next tick.
      const events = fresh.pendingEvents.filter(isNew).filter((event) => event.fileIds.every((id) => fileOf.get(id)?.status !== 'pending'))
      if (events.length === 0) return
      const files = events.flatMap((event) => event.fileIds.flatMap((id) => fileOf.get(id) ?? []))
      if (!inbox.send?.(renderNewMessages(events, files))) return
      sent.events.push(...events)
      sent.files.push(...files)
    }
    const timer = setInterval(() => {
      if (feeding) return
      feeding = feed()
        .catch((error: unknown) => deps.log.error({ err: error, taskId }, 'could not send a message into the running turn'))
        .finally(() => {
          feeding = undefined
        })
    }, tickMs)
    timer.unref()
    return {
      async stop() {
        clearInterval(timer)
        await feeding
      },
    }
  }

  /**
   * Records the turn, marks its input read and queues its reply in one
   * transaction, all fenced by the lease: a crash loses none of them, and a
   * holder whose lease was taken over posts nothing.
   */
  async function finishTurn(task: AutonomousTask, lease: Lease, input: Parameters<typeof consumeTurnInput>[2], update: TaskUpdate, text: string): Promise<void> {
    const ref = await deps.replyRef(task)
    await inTransaction(deps.pool, async (client) => {
      if (Object.keys(update).length > 0 && !(await updateTask(client, lease, update))) return
      if (!(await consumeTurnInput(client, lease, input))) return
      if (text.trim() !== '') await deps.post({ kind: 'post', ref, text: scrubSecrets(text) }, client)
    })
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
