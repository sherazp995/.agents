/**
 * The hook bridge route behind `relay team propose` (the teams UI plan,
 * step 8). A live chat turn asks Relay to propose a team for the project
 * whose Slack channel the turn's thread is in. The project comes from the
 * turn's own token, task and thread, never from the request body, so an
 * agent cannot name another project; and the turn's requester must be an
 * owner, since each run costs model credit and only an owner approves.
 */

import type { Pool } from 'pg'
import type { BridgeRoute, InvocationContext } from '../engine/hook-bridge.js'
import type { TeamProposer } from '../projects/proposals.js'
import { StoreConflict } from '../projects/store.js'
import { principalIsOwner } from '../tenancy/access.js'
import { loadTaskThread } from './operations.js'
import { loadTask, type AutonomousTask } from './store.js'

export const TEAM_PROPOSAL_PATH = '/team-proposal'

export type TeamProposalRouteDeps = {
  readonly pool: Pool
  /** The daemon's workspace: a token issued for any other (a probe's) is refused. */
  readonly workspaceId: string
  readonly teamProposer?: TeamProposer
  readonly now?: () => Date
}

type Answer = { status: number; body: { ok: boolean; message: string; proposalId?: string } }

const refuse = (status: number, message: string): Answer => ({ status, body: { ok: false, message } })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Why this invocation is not a live turn of a task in this workspace, or undefined when it is. */
export function notLiveReason(task: AutonomousTask | undefined, context: InvocationContext, now: Date): string | undefined {
  if (task === undefined || task.workspaceId !== context.workspaceId) return 'the task for this turn no longer exists'
  if (task.cancelRequestedAt !== null || task.phase === 'stopped') return 'this task was stopped'
  if (task.leaseGeneration !== context.leaseGeneration) return 'this worker was superseded'
  if (task.leaseOwner === null || task.leaseExpiresAt === null || task.leaseExpiresAt.getTime() <= now.getTime()) return 'this turn has finished'
  return undefined
}

export function teamProposalRoute(deps: TeamProposalRouteDeps): BridgeRoute {
  return async (context) => {
    const now = deps.now?.() ?? new Date()
    if (context.workspaceId !== deps.workspaceId || !UUID.test(context.taskId)) return refuse(403, 'This only works from a live Relay turn.')
    if (context.assignment !== undefined) return refuse(403, 'Team members cannot ask for a team proposal.')
    const task = await loadTask(deps.pool, context.taskId)
    if (task?.readOnly === true) return refuse(403, 'This task was started by a reminder and is read-only, so it cannot propose a team.')
    const reason = notLiveReason(task, context, now)
    if (reason !== undefined) return refuse(403, `This only works from a live Relay turn: ${reason}.`)
    if (deps.teamProposer === undefined) return refuse(503, 'Team proposals are not available on this Relay.')

    const thread = await loadTaskThread(deps.pool, context.taskId)
    const slackThread = thread?.ref.thread
    if (thread === undefined || slackThread === undefined) return refuse(403, 'This only works from a live Relay turn: its thread is gone.')
    const project = await projectForChannel(deps.pool, deps.workspaceId, thread.ref.channel)
    if (project === undefined) {
      return refuse(409, "This channel is not a project's channel, so there is no team to propose. The owner can set one up in the setup page (relay ui).")
    }
    if (!(await principalIsOwner(deps.pool, deps.workspaceId, thread.requesterPrincipalId))) {
      return refuse(403, 'Only the owner of this Relay can ask for a team proposal.')
    }
    try {
      const proposalId = await deps.teamProposer.propose(deps.workspaceId, {
        projectId: project.id,
        requestedBy: thread.requesterPrincipalId,
        source: 'slack',
        slackChannel: thread.ref.channel,
        slackThread,
      })
      return {
        status: 202,
        body: { ok: true, proposalId, message: `Relay is proposing a team for ${project.name}. The proposal is posted in this thread when it is ready; only the owner approves it.` },
      }
    } catch (error) {
      if (error instanceof StoreConflict) return refuse(409, error.message)
      throw error
    }
  }
}

/** The project whose Slack channel this is, within the workspace. */
export async function projectForChannel(pool: Pool, workspaceId: string, channel: string): Promise<{ id: string; name: string } | undefined> {
  const { rows } = await pool.query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE workspace_id = $1 AND slack_channel = $2', [workspaceId, channel])
  return rows[0]
}
