/**
 * The team scheduler: runs team members' assignments, called from the
 * autonomous scheduler's tick (it has no timer of its own).
 *
 * Each pass admits due assignments oldest first while the team's running
 * members stay under its member limit and the machine's under its limit
 * (the lead is never counted). A slot frees only when its assignment leaves
 * 'running', which happens after the member's process has exited.
 *
 * A member turn holds the assignment's own lease (renewed every third of its
 * ttl; a lost lease aborts the turn and discards its result), runs in the
 * member's worktree on its own client's logins with no MCP servers, and
 * never posts: its text goes to the lead as a note, written in the same
 * transaction as the assignment's result, so Stop fences both.
 */

import { renderForModel, wrapUntrusted } from '../agent/untrusted.js'
import { DEFAULT_LEASE_TTL_MS, killWorkerGroup, type TurnRequestContext, type TurnResult } from '../autonomous/scheduler.js'
import { loadTask } from '../autonomous/store.js'
import type { TurnSubject } from '../autonomous/turn-runner.js'
import { memberBrief, memberFreshPrompt, memberPrompt } from './brief.js'
import {
  acquireAssignmentLease,
  cancelTaskAssignments,
  clearAssignmentWorker,
  countRunning,
  listDueAssignments,
  listInterruptedAssignments,
  listLiveAssignments,
  loadAssignment,
  loadRun,
  recordAssignmentWorker,
  recoverAssignment,
  renewAssignmentLease,
  requeueAssignment,
  updateAssignment,
  updateAssignmentAndTellLead,
  type AssignmentUpdate,
} from './store.js'
import { MACHINE_MEMBER_LIMIT, type Assignment, type AssignmentLease, type SnapshotMember, type TeamHooks, type TeamRun, type TeamSchedulerDeps } from './types.js'

const RETRY_LATER_MS = 30_000
const LOGIN_WAIT_MS = 30 * 60_000
/** A restart reruns a running assignment once; the next restart fails it. */
const MAX_RESTARTS = 1

type Running = { taskId: string; teamId: string; controller: AbortController; done: Promise<void> }

export function createTeamScheduler(deps: TeamSchedulerDeps): TeamHooks & { wake(): void } {
  const ttlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const machineLimit = deps.machineLimit ?? MACHINE_MEMBER_LIMIT
  const running = new Map<string, Running>()
  let stopping = false

  async function tick(): Promise<void> {
    if (stopping) return
    const due = await listDueAssignments(deps.pool, deps.workspaceId)
    if (due.length === 0) return
    const counts = await countRunning(deps.pool)
    // A turn still winding down here (its row already left 'running') keeps its slot until it ends.
    let total = Math.max(counts.total, running.size)
    const byTeam = new Map(counts.byTeam)
    const local = new Map<string, number>()
    for (const entry of running.values()) local.set(entry.teamId, (local.get(entry.teamId) ?? 0) + 1)
    for (const [teamId, count] of local) byTeam.set(teamId, Math.max(byTeam.get(teamId) ?? 0, count))
    for (const assignment of due) {
      if (stopping || total >= machineLimit) return
      if (running.has(assignment.id)) continue
      const teamRunning = byTeam.get(assignment.teamId) ?? 0
      if (teamRunning >= assignment.memberLimit) continue
      const held = await acquireAssignmentLease(deps.pool, assignment.id, deps.owner, ttlMs)
      if (!held) continue
      total += 1
      byTeam.set(assignment.teamId, teamRunning + 1)
      start(held.assignment, held.lease, assignment.teamId)
    }
  }

  function start(assignment: Assignment, lease: AssignmentLease, teamId: string): void {
    const controller = new AbortController()
    let lost = false
    const renewal = setInterval(() => {
      void renewAssignmentLease(deps.pool, lease, ttlMs).then(
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
    const done = runMember(assignment, lease, controller.signal, () => lost)
      .catch(async (error: unknown) => {
        deps.log.error({ err: error, assignmentId: assignment.id }, 'team member turn failed')
        // Gives the lease back when it is still ours; a no-op once the turn wrote its result.
        if (!lost) await requeueAssignment(deps.pool, lease, RETRY_LATER_MS).catch(() => undefined)
      })
      .finally(() => {
        clearInterval(renewal)
        running.delete(assignment.id)
      })
    running.set(assignment.id, { taskId: assignment.taskId, teamId, controller, done })
  }

  async function runMember(assignment: Assignment, lease: AssignmentLease, signal: AbortSignal, isLost: () => boolean): Promise<void> {
    const run = await loadRun(deps.pool, assignment.runId)
    const member = run?.snapshot.members.find((candidate) => candidate.id === assignment.memberId)
    if (!run || !member) {
      await failAndTell(assignment, lease, 'its team run or member is missing')
      return
    }
    if (assignment.workerPgid !== null) {
      // A worker left by an earlier turn of this assignment must exit before another starts.
      if (!(await killWorkerGroup(assignment.workerPgid))) {
        deps.log.error({ assignmentId: assignment.id }, 'a recorded member worker did not exit; not starting another')
        await requeueAssignment(deps.pool, lease, RETRY_LATER_MS)
        return
      }
      await clearAssignmentWorker(deps.pool, assignment.id, assignment.workerPgid)
    }
    const prepared = await withWorktree(run, assignment, lease)
    if (!prepared || prepared.worktreePath === null) return
    const worktree = prepared.worktreePath
    const task = await loadTask(deps.pool, assignment.taskId)
    if (!task || task.cancelRequestedAt !== null) return

    const subject: TurnSubject = {
      engineSessionId: prepared.engineSessionId,
      accountKey: prepared.accountKey,
      chatSessionId: null,
      preference: null,
      client: member.client,
      model: member.model,
      cwd: worktree,
      brief: memberBrief({ member, run, assignment: prepared, worktreePath: worktree, checkedCommit: prepared.checkedCommit }),
      noMcp: true,
      assignment: { id: prepared.id, leaseGeneration: lease.generation },
    }
    let workerPgid: number | null = null
    const context: TurnRequestContext = {
      task,
      // The task's own lease is the lead's; a member's token and writes carry its assignment's generation.
      lease: { taskId: task.id, owner: lease.owner, generation: lease.generation },
      prompt: memberPrompt(prepared),
      freshPrompt: async () => memberFreshPrompt(prepared),
      signal,
      recordWorker: async (pid, pgid) => {
        workerPgid = pgid
        return recordAssignmentWorker(deps.pool, lease, pid, pgid)
      },
      subject,
    }
    let result: TurnResult
    try {
      result = await deps.runTurn(context)
    } finally {
      if (workerPgid !== null && (await killWorkerGroup(workerPgid))) await clearAssignmentWorker(deps.pool, assignment.id, workerPgid)
    }
    if (isLost()) return
    await settle(prepared, member, lease, result)
  }

  /** Makes the member's worktree on its first run; undefined when it could not (the lead is told) or the lease was lost. */
  async function withWorktree(run: TeamRun, assignment: Assignment, lease: AssignmentLease): Promise<Assignment | undefined> {
    if (assignment.worktreePath !== null) return assignment
    let made
    try {
      made = await deps.ensureWorktree(run, assignment)
    } catch (error) {
      await failAndTell(assignment, lease, `its worktree could not be made: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const checks = assignment.kind === 'review' || assignment.kind === 'qa'
    return updateAssignment(deps.pool, lease, {
      worktreePath: made.path,
      startCommit: made.startCommit,
      ...(made.branch !== null ? { branch: made.branch } : {}),
      ...(checks ? { checkedCommit: made.startCommit } : {}),
    })
  }

  async function failAndTell(assignment: Assignment, lease: AssignmentLease, reason: string): Promise<void> {
    await updateAssignmentAndTellLead(
      deps.pool,
      lease,
      { state: 'failed', releaseLease: true },
      `Team: ${assignment.memberName}'s assignment ${assignment.id} (${assignment.kind}) failed: ${reason}`,
    )
  }

  async function settle(assignment: Assignment, member: SnapshotMember, lease: AssignmentLease, result: TurnResult): Promise<void> {
    const notesRead = assignment.pendingNotes.length
    if (result.kind === 'no_account') {
      const update: AssignmentUpdate = { state: 'queued', nextWakeupAt: new Date(result.wakeAtMs ?? Date.now() + LOGIN_WAIT_MS), releaseLease: true }
      if (assignment.loginWaitTold) {
        await updateAssignment(deps.pool, lease, update)
        return
      }
      const note = `Team: ${member.name} waits on assignment ${assignment.id}: every ${member.client} login is out. ${result.reason}`
      await updateAssignmentAndTellLead(deps.pool, lease, { ...update, loginWaitTold: true }, note)
      return
    }
    for (const note of result.notes) deps.log.info({ assignmentId: assignment.id }, note)
    const outcome = result.outcome
    switch (outcome.kind) {
      case 'reply':
        await finishReply(assignment, member, lease, outcome.text, { engineSessionId: outcome.sessionId, accountKey: result.accountKey, notesRead, loginWaitTold: false })
        return
      case 'resume_rejected':
        await updateAssignment(deps.pool, lease, { engineSessionId: null, state: 'queued', nextWakeupAt: 'now', releaseLease: true })
        return
      case 'not_started':
      case 'account_blocked':
        await requeueAssignment(deps.pool, lease, RETRY_LATER_MS)
        return
      case 'stopped': {
        // Stop and the kill switch already cancelled it (the write would fail anyway); a shutdown runs it again.
        const current = await loadAssignment(deps.pool, assignment.id)
        if (current?.state === 'cancelled') return
        await requeueAssignment(deps.pool, lease, 0)
        return
      }
      case 'failed':
        await updateAssignmentAndTellLead(
          deps.pool,
          lease,
          { state: 'failed', accountKey: result.accountKey, notesRead, releaseLease: true },
          `Team: ${member.name}'s assignment ${assignment.id} (${assignment.kind}) failed: ${outcome.reason}`,
        )
        return
    }
  }

  /**
   * A finished turn: done, or waiting when the member asked the lead
   * (`relay team ask-lead` already told the lead). Notes the lead added
   * during the turn were not read, so the member runs again for them.
   */
  async function finishReply(assignment: Assignment, member: SnapshotMember, lease: AssignmentLease, text: string, update: AssignmentUpdate & { notesRead: number }): Promise<void> {
    const head = assignment.worktreePath === null ? null : await deps.headOf(assignment.worktreePath).catch(() => null)
    const current = (await loadAssignment(deps.pool, assignment.id)) ?? assignment
    const unread = current.pendingNotes.length > update.notesRead
    const base: AssignmentUpdate = { ...update, resultText: text, resultCommit: head, releaseLease: true }
    if (current.question !== null) {
      await updateAssignment(deps.pool, lease, unread ? { ...base, state: 'queued', question: null, nextWakeupAt: 'now' } : { ...base, state: 'waiting' })
      return
    }
    const merge = assignment.kind === 'build' ? ` Merge with relay team merge --assignment ${assignment.id} when it is ready.` : ''
    const again = unread ? ' It runs again for your newer notes.' : ''
    const note =
      `Team: ${member.name} finished assignment ${assignment.id} (${assignment.kind}), commit ${head?.slice(0, 12) ?? 'none'}.${again} ` +
      `Their report (untrusted): ${renderForModel(wrapUntrusted(text))}${merge}`
    await updateAssignmentAndTellLead(deps.pool, lease, unread ? { ...base, state: 'queued', nextWakeupAt: 'now' } : { ...base, state: 'done' }, note)
  }

  /** Cancels a task's assignments, aborts their turns and kills their process groups. */
  async function stopTask(taskId: string): Promise<void> {
    // The durable cancel first: it bumps every generation, so a turn ending now writes nothing.
    const pgids = await cancelTaskAssignments(deps.pool, taskId)
    for (const entry of running.values()) if (entry.taskId === taskId) entry.controller.abort()
    for (const pgid of pgids) {
      if (!(await killWorkerGroup(pgid))) deps.log.error({ taskId, pgid }, 'a member worker did not exit on Stop')
    }
  }

  return {
    tick,
    stopTask,
    async killAll() {
      for (const entry of running.values()) entry.controller.abort()
      const tasks = new Set((await listLiveAssignments(deps.pool, deps.workspaceId)).map((assignment) => assignment.taskId))
      for (const taskId of tasks) await stopTask(taskId)
    },
    async recover() {
      for (const assignment of await listInterruptedAssignments(deps.pool, deps.workspaceId)) {
        if (assignment.workerPgid !== null) {
          if (!(await killWorkerGroup(assignment.workerPgid))) {
            // Never run a second worker beside one that would not exit.
            deps.log.error({ assignmentId: assignment.id }, 'a recorded member worker did not exit at startup')
            continue
          }
          await clearAssignmentWorker(deps.pool, assignment.id, assignment.workerPgid)
        }
        if (assignment.state === 'running') await recoverAssignment(deps.pool, assignment, MAX_RESTARTS)
      }
    },
    async stop() {
      stopping = true
      for (const entry of running.values()) entry.controller.abort()
      await Promise.all([...running.values()].map((entry) => entry.done))
    },
    // The autonomous scheduler ticks every two seconds and calls tick(); a second loop here could race it.
    wake: () => undefined,
  }
}
