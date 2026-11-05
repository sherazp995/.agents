/**
 * The shared shapes of a running team (teams phase 2): what a team run
 * copies in at start, an assignment, and the role table that says which
 * `relay team` commands each role may run. The route and the guard both
 * read the role table, so the rule lives in one place.
 */

import type { Pool } from 'pg'
import type { AccountClient } from '../autonomous/accounts.js'
import type { TurnRequestContext, TurnResult } from '../autonomous/scheduler.js'
import type { Logger } from '../obs/logger.js'
import type { RepoEntry } from '../repos/schema.js'

export const MACHINE_MEMBER_LIMIT = 6

/** One member as copied into a run at start. */
export type SnapshotMember = {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly isLead: boolean
  readonly client: AccountClient
  readonly model: string | null
  readonly personaName: string
  /** The persona text copied for this run, under Relay's home `team-runs/<run>/personas/`. */
  readonly personaPath: string
}

export type RunSnapshot = {
  readonly members: readonly SnapshotMember[]
  readonly memberLimit: number
  /** The team's id, so the member limit is counted per team across threads. */
  readonly teamId: string
}

export type TeamRunKind = 'build' | 'pr-review'
export type TeamRunStatus = 'open' | 'finished' | 'cancelled'

export type TeamRun = {
  readonly id: string
  readonly workspaceId: string
  readonly taskId: string
  readonly projectId: string
  readonly title: string
  readonly kind: TeamRunKind
  readonly repoName: string
  readonly repoPath: string
  readonly prRef: string | null
  readonly baseCommit: string
  readonly worktreePath: string | null
  readonly branch: string | null
  readonly snapshot: RunSnapshot
  readonly status: TeamRunStatus
  readonly createdAt: Date
}

export const ASSIGNMENT_KINDS = ['build', 'review', 'qa'] as const
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number]
export type AssignmentState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
/** States in which an assignment may still run or hold a process. */
export const LIVE_ASSIGNMENT_STATES: readonly AssignmentState[] = ['queued', 'running', 'waiting']

export type Assignment = {
  readonly id: string
  readonly workspaceId: string
  readonly runId: string
  readonly taskId: string
  readonly projectId: string
  readonly memberId: string
  readonly memberName: string
  readonly kind: AssignmentKind
  readonly brief: string
  readonly idemKey: string
  readonly state: AssignmentState
  readonly worktreePath: string | null
  readonly branch: string | null
  readonly startCommit: string | null
  readonly resultText: string | null
  readonly resultCommit: string | null
  readonly checkedCommit: string | null
  readonly question: string | null
  readonly pendingNotes: readonly string[]
  readonly answers: readonly string[]
  readonly engineSessionId: string | null
  readonly accountKey: string | null
  readonly leaseOwner: string | null
  readonly leaseGeneration: number
  readonly leaseExpiresAt: Date | null
  readonly workerPid: number | null
  readonly workerPgid: number | null
  readonly attempts: number
  /** Times a restart interrupted it while running. */
  readonly restarts: number
  readonly nextWakeupAt: Date | null
  readonly loginWaitTold: boolean
  readonly createdAt: Date
}

/** What a member's lease holder names on every write. */
export type AssignmentLease = { readonly assignmentId: string; readonly owner: string; readonly generation: number }

/** The hook bridge path behind every `relay team` command but `propose`. */
export const TEAM_PATH = '/team'

/** `relay team` commands by who may run them. `propose` has its own route and is the lead's (the thread's agent). */
export const TEAM_COMMANDS = {
  lead: ['start', 'assign', 'answer', 'merge', 'cancel', 'finish', 'status', 'propose'],
  member: ['ask-lead'],
} as const

export type TeamRole = keyof typeof TEAM_COMMANDS

export function mayRun(role: TeamRole, command: string): boolean {
  return (TEAM_COMMANDS[role] as readonly string[]).includes(command)
}

/** What the autonomous scheduler calls on the team scheduler (src/teams/scheduler.ts). */
export type TeamHooks = {
  /** One pass: runs due assignments within the team and machine limits. */
  tick(): Promise<void>
  /** Stop for one task: cancels its assignments and runs, kills their process groups, aborts their turns. */
  stopTask(taskId: string): Promise<void>
  /** The kill switch: the same for every live assignment in the workspace, whatever its task's phase. */
  killAll(): Promise<void>
  /** Startup: kills recorded member process groups, then reruns a running assignment once or fails it. */
  recover(): Promise<void>
  /** Daemon shutdown: aborts every running member turn and waits for it. */
  stop(): Promise<void>
}

export type TeamSchedulerDeps = {
  readonly pool: Pool
  readonly workspaceId: string
  /** This daemon's lease owner name. */
  readonly owner: string
  /** One turn on the account pool (runTurnOnPool), given a member subject. */
  readonly runTurn: (context: TurnRequestContext) => Promise<TurnResult>
  /** Makes the assignment's worktree on first run (src/teams/worktrees.ts). */
  readonly ensureWorktree: (run: TeamRun, assignment: Assignment) => Promise<MemberWorktree>
  /** The head of a worktree, read after a member's turn. */
  readonly headOf: (worktreePath: string) => Promise<string | null>
  readonly log: Logger
  readonly leaseTtlMs?: number
  /** Machine-wide member limit; MACHINE_MEMBER_LIMIT unless a test sets it. */
  readonly machineLimit?: number
}

export type MemberWorktree = { readonly path: string; readonly branch: string | null; readonly startCommit: string }

export type TeamRouteDeps = {
  readonly pool: Pool
  /** The daemon's workspace: a token issued for any other (a probe's) is refused. */
  readonly workspaceId: string
  /** Relay's home: copied persona texts go under `team-runs/<run>/personas/`. */
  readonly relayHome: string
  /** The global persona library. */
  readonly personasDir: string
  /** A repo registry entry by name. */
  readonly repo: (name: string) => RepoEntry | undefined
  /** Tells the scheduler an assignment is due. */
  readonly wake: () => void
  /** Kills process groups of cancelled assignments. */
  readonly killGroups: (pgids: readonly number[]) => Promise<void>
  readonly now?: () => Date
}
