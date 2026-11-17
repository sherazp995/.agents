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
 * Failover (README, "Failover"): a tick starts work only while this laptop
 * holds the "who is answering" record (`failover.mayStartWork()`); when it
 * does not, it starts nothing and steps down, while turns already running
 * keep renewing their leases and post their replies. `drain()` is the step
 * down's wait for them. A laptop signals and waits only on its own workers;
 * a turn a gone laptop left mid-way is marked interrupted and its thread told
 * once (markInterruptedTasks).
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
import { ALWAYS_ACTIVE, type FailoverGate } from '../failover/types.js'
import { killProcessGroup, processGroupAlive } from '../process/gated-spawn.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { buildTurnPrompt, renderNewMessages } from './prompt.js'
import {
  acquireLease,
  listOpenTasks,
  clearWorker,
  consumeTurnInput,
  inTransaction,
  isOwnWorker,
  listDueWakeups,
  listTasksWithWorker,
  loadTask,
  markInterruptedTasks,
  markTaskPaused,
  markTaskStopped,
  parkTask,
  recordWorker,
  releaseLease,
  renewLease,
  requestCancel,
  updateTask,
  type AutonomousTask,
  type Lease,
  type PauseResult,
  type TaskUpdate,
} from './store.js'
import type { TurnInbox, TurnOutcome } from './worker.js'
import type { TurnSubject } from './turn-runner.js'
import type { TeamHooks } from '../teams/types.js'
import { splitForSlack } from '../chat/slack/split.js'

export const DEFAULT_LEASE_TTL_MS = 60_000
export const DEFAULT_TICK_MS = 2_000
const GROUP_EXIT_POLL_MS = 50
const GROUP_EXIT_TIMEOUT_MS = 10_000
const RETRY_LATER_MS = 30_000

/** The one note a thread gets when the laptop running its turn went quiet mid-turn. */
export const INTERRUPTED_NOTE = 'The laptop running this went offline mid-turn; mention me to continue.'

export type TurnRequestContext = {
  task: AutonomousTask
  lease: Lease
  prompt: string
  /** The prompt for a turn that cannot resume a session: `prompt` plus the Slack thread so far. Built only when needed. */
  freshPrompt?: () => Promise<string>
  signal: AbortSignal
  /** Fenced write of the worker's pid before its gate opens. */
  recordWorker: (pid: number, pgid: number) => Promise<boolean>
  /** Whose turn this is; omitted for the task's own (taskSubject). */
  subject?: TurnSubject
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
  /** Sends `text` into a terminal chat open on the task's session; false when none is open or it was not delivered. */
  deliverToOpenChat?(task: AutonomousTask, text: string): Promise<boolean>
  /** True when the channel's extension token is no longer the one the running worker started with; its new messages then wait for the next worker. */
  extensionTokenChanged?(task: AutonomousTask): Promise<boolean>
  /**
   * The task as its turn runs on this laptop: its stored folder mapped to
   * this laptop's home, or moved when missing here. Null when no turn can run
   * (the thread was asked for a folder); the step then sleeps until the next
   * message. Without it the stored folder is used as is.
   */
  placeTurn?(task: AutonomousTask, lease: Lease): Promise<AutonomousTask | null>
}

export type SchedulerDeps = {
  pool: Pool
  workspaceId: string
  /** This daemon's lease owner name. */
  owner: string
  /** Queues an action, inside `executor`'s transaction when given; for a post, returns its dispatch id, which a later post can name as `after`. */
  post: (action: ChatAction, executor?: PoolClient) => Promise<string>
  /** Where the task's thread replies go. */
  replyRef: (task: AutonomousTask) => Promise<ChatRef>
  /** Re-reads the kill switch (an engage from the CLI) and answers whether it is engaged. */
  isKillSwitchEngaged: () => Promise<boolean>
  effects: SchedulerEffects
  /** The project teams' members: run each tick, stopped with the daemon, killed by the kill switch, recovered at startup. */
  team?: TeamHooks
  log: Logger
  leaseTtlMs?: number
  tickMs?: number
  /** Whether this laptop may start work, and its name on the workers it starts; ALWAYS_ACTIVE when failover is off. */
  failover?: FailoverGate
}

export type Scheduler = {
  start(): Promise<void>
  /** Runs one pass now (the router calls it through wake()). */
  wake(): void
  /** Starts nothing new from now on and resolves once every running turn has ended and posted. */
  drain(): Promise<void>
  /** Kills every running worker tree, then releases leases. */
  stop(): Promise<void>
  /** For tests: one pass, awaited. */
  tick(): Promise<void>
}

/**
 * Kills a recorded worker's group when it is still ours, and waits for it to
 * exit. A worker another laptop recorded is never signalled: a pgid means
 * nothing here, and holding the task's lease already shows that laptop's
 * turn is over (a cut-off one is markInterruptedTasks').
 */
export async function takeOverWorker(pool: Pool, task: Pick<AutonomousTask, 'id' | 'workerPgid' | 'workerHost'>, host: string | null = null): Promise<boolean> {
  const pgid = task.workerPgid
  if (pgid === null || !isOwnWorker(task.workerHost, host)) return true
  if (!(await killWorkerGroup(pgid))) return false
  await clearWorker(pool, task.id, pgid)
  return true
}

/** Kills a recorded worker's process group when it is still one of relay's workers, and waits for it to exit; false when it would not. */
export async function killWorkerGroup(pgid: number): Promise<boolean> {
  if (!processGroupAlive(pgid) || !looksLikeWorker(pgid)) return true
  killProcessGroup(pgid)
  const deadline = Date.now() + GROUP_EXIT_TIMEOUT_MS
  while (processGroupAlive(pgid)) {
    if (Date.now() > deadline) return false
    killProcessGroup(pgid)
    await new Promise((resolve) => setTimeout(resolve, GROUP_EXIT_POLL_MS))
  }
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
export async function stopAutonomousTask(pool: Pool, effects: Pick<SchedulerEffects, 'cleanupStopped'>, taskId: string, host: string | null = null): Promise<AutonomousTask | undefined> {
  const cancelled = await requestCancel(pool, taskId)
  if (!cancelled) return undefined
  // Another laptop's worker is fenced by markTaskStopped's new generation: its own lease renewal fails and it kills its worker there.
  if (cancelled.workerPgid !== null && isOwnWorker(cancelled.workerHost, host)) killProcessGroup(cancelled.workerPgid)
  const stopped = await markTaskStopped(pool, taskId)
  if (stopped) await effects.cleanupStopped(stopped)
  return stopped
}

/**
 * Stop for an autonomous task that stays open: the same durable cancel,
 * worker kill and cleanup as stopAutonomousTask, then markTaskPaused instead
 * of the final "stopped" phase, so the thread's next message carries on.
 *
 * The cancel flag stays set until the worker group has exited and the
 * cleanup (team members, operations, approvals) is done, because clearing it
 * is what lets every later lease, spawn and dispatch through again. A worker
 * that will not exit leaves nothing safe to reopen, so the task is ended
 * instead, exactly as "relay end" would.
 */
export async function pauseAutonomousTask(pool: Pool, effects: Pick<SchedulerEffects, 'cleanupStopped'>, taskId: string, stoppedAt: string, host: string | null = null): Promise<PauseResult> {
  const existing = await loadTask(pool, taskId)
  if (!existing) return { kind: 'missing' }
  if (existing.phase === 'stopped') return { kind: 'ended' }
  const cancelled = await requestCancel(pool, taskId)
  if (!cancelled) return { kind: 'missing' }
  // Another laptop's worker is left to it: markTaskPaused's new generation fails its lease renewal, and it kills the worker there.
  if (cancelled.workerPgid !== null && isOwnWorker(cancelled.workerHost, host)) {
    if (!(await killWorkerGroup(cancelled.workerPgid))) {
      await stopAutonomousTask(pool, effects, taskId, host)
      return { kind: 'ended' }
    }
    await clearWorker(pool, taskId, cancelled.workerPgid)
  }
  await effects.cleanupStopped(cancelled)
  return markTaskPaused(pool, taskId, stoppedAt)
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const ttlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS
  const gate = deps.failover ?? ALWAYS_ACTIVE
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>()
  let timer: NodeJS.Timeout | undefined
  let stopping = false
  let draining = false
  let ticking: Promise<void> | undefined

  const post = async (task: AutonomousTask, text: string): Promise<void> => {
    if (text.trim() === '') return
    await deps.post({ kind: 'post', ref: await deps.replyRef(task), text: scrubSecrets(text) })
  }

  async function tick(): Promise<void> {
    if (stopping) return
    if (await deps.isKillSwitchEngaged()) {
      for (const { controller } of running.values()) controller.abort()
      // Members of every task, done and blocked ones included.
      await deps.team?.killAll()
      for (const task of await listOpenTasks(deps.pool, deps.workspaceId)) {
        const stopped = await stopAutonomousTask(deps.pool, deps.effects, task.id, gate.host)
        if (stopped) await post(stopped, 'Stopped: the kill switch is engaged.')
      }
      return
    }
    if (draining) return
    // Every pass that could start a turn asks first; a laptop that lost the record starts nothing and steps down.
    if (!(await gate.mayStartWork())) {
      gate.stepDown('the autonomous scheduler may no longer start work')
      return
    }
    await markInterrupted()
    await deps.effects.sweep()
    const due = await listDueWakeups(deps.pool, deps.workspaceId, gate.host)
    for (const task of due) {
      if (running.has(task.id) || stopping || draining) continue
      const controller = new AbortController()
      const done = runStep(task.id, controller).catch((error: unknown) => {
        deps.log.error({ err: error, taskId: task.id }, 'autonomous step failed')
      })
      running.set(task.id, { controller, done: done.finally(() => running.delete(task.id)) })
    }
    if (!stopping && !draining) await deps.team?.tick()
  }

  /** Turns a gone laptop left mid-way: fenced, parked and their thread told, each once, in one transaction. */
  async function markInterrupted(): Promise<void> {
    const host = gate.host
    if (host === null) return
    const tasks = await inTransaction(deps.pool, async (client) => {
      const interrupted = await markInterruptedTasks(client, deps.workspaceId, host)
      for (const task of interrupted) await deps.post({ kind: 'post', ref: await deps.replyRef(task), text: INTERRUPTED_NOTE }, client)
      return interrupted
    })
    for (const task of tasks) deps.log.warn({ taskId: task.id }, 'a turn was cut off on a laptop that went quiet; the thread was told')
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
      if (!(await takeOverWorker(deps.pool, task, gate.host))) {
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
    if (await deliveredToOpenChat(fresh, lease, dueAt)) return
    const placed = deps.effects.placeTurn ? await deps.effects.placeTurn(fresh, lease) : fresh
    if (placed === null) {
      await parkTask(deps.pool, lease, dueAt)
      return
    }
    await runTurn(placed, lease, dueAt, signal, isLost)
  }

  /**
   * A chat open in a terminal on this task's session gets the new messages
   * and answers them itself, so no headless worker runs on the same
   * transcript. Relay's notes stay pending for a headless turn: they are
   * about that worker's own requests.
   */
  async function deliveredToOpenChat(task: AutonomousTask, lease: Lease, dueAt: Date | null): Promise<boolean> {
    // A read-only task's messages go only to its own limited worker, never to a terminal chat without the limit.
    if (task.readOnly || !deps.effects.deliverToOpenChat || task.pendingEvents.length === 0) return false
    const fileOf = new Map(task.files.map((file) => [file.slackFileId, file]))
    const files = task.pendingEvents.flatMap((event) => event.fileIds.flatMap((id) => fileOf.get(id) ?? []))
    if (!(await deps.effects.deliverToOpenChat(task, renderNewMessages(task.pendingEvents, files)))) return false
    await consumeTurnInput(deps.pool, lease, { eventIds: task.pendingEvents.map((event) => event.id), notesRead: 0, dueAt })
    return true
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
        recordWorker: (pid, pgid) => recordWorker(deps.pool, lease, pid, pgid, gate.host),
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
      // A changed or removed token must not reach these messages: they stay pending for a worker started with the current one.
      if (await deps.effects.extensionTokenChanged?.(current)) {
        inbox.send = null
        return
      }
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
      if (text.trim() === '') return
      // A whole turn's text can pass one Slack message's limit: post it in parts, each sent only after the one before it.
      let after: string | undefined
      for (const part of splitForSlack(scrubSecrets(text))) {
        after = await deps.post({ kind: 'post', ref, text: part, markdown: true, ...(after !== undefined ? { after } : {}) }, client)
      }
    })
  }

  return {
    async start() {
      // Startup recovery: none of this laptop's recorded workers survives a restart unkilled; another laptop's are never signalled.
      for (const task of await listTasksWithWorker(deps.pool, deps.workspaceId)) {
        if (!(await takeOverWorker(deps.pool, task, gate.host))) deps.log.error({ taskId: task.id }, 'a recorded worker did not exit at startup')
      }
      // Taking over: turns the other laptop left mid-way when it went quiet.
      await markInterrupted()
      await deps.team?.recover()
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
    async drain() {
      draining = true
      await ticking
      await Promise.all([...running.values()].map((entry) => entry.done))
    },
    async stop() {
      stopping = true
      if (timer) clearInterval(timer)
      for (const { controller } of running.values()) controller.abort()
      await Promise.all([...running.values()].map((entry) => entry.done))
      await ticking
      await deps.team?.stop()
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
