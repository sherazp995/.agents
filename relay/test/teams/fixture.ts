/** A task in a project channel with a team, for the team tests. */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { intakeMention, type AutonomousTask } from '../../src/autonomous/store.js'
import { addMember, createProject, insertPersona } from '../../src/projects/store.js'
import { insertRun } from '../../src/teams/store.js'
import type { RunSnapshot, SnapshotMember, TeamRun } from '../../src/teams/types.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'

export type TeamFixture = { workspaceId: string; principalId: string; channel: string; task: AutonomousTask; projectId: string; teamId: string }

export async function inTx<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** A workspace with an owner, a project on `channel` with a lead and two developers, and one task in a thread there. */
export async function teamFixture(pool: Pool, options: { folder?: string; repos?: string[]; workspaceId?: string; channel?: string } = {}): Promise<TeamFixture> {
  const workspaceId = options.workspaceId ?? (await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`))
  const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Owner', ['owner'])
  const channel = options.channel ?? `C${randomUUID().slice(0, 8)}`
  const projectId = await inTx(pool, async (client) => {
    const id = await createProject(client, workspaceId, { name: 'Web', slackChannel: channel, folder: options.folder ?? '/tmp', repos: options.repos ?? ['web'] })
    const persona = await insertPersona(client, workspaceId, { name: 'Engineer', fileName: `engineer-${randomUUID().slice(0, 6)}.md` })
    await addMember(client, workspaceId, id, { name: 'Maya', role: 'Lead', personaId: persona, isLead: true })
    await addMember(client, workspaceId, id, { name: 'Theo', role: 'Developer', personaId: persona, isLead: false })
    await addMember(client, workspaceId, id, { name: 'Iris', role: 'Developer', personaId: persona, isLead: false })
    return id
  })
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM teams WHERE project_id = $1', [projectId])
  const thread = `${channel}:${Date.now()}.${Math.floor(Math.random() * 1e6)}`
  const message = thread.split(':')[1] ?? '1.1'
  const result = await intakeMention(pool, {
    workspaceId,
    principalId,
    adapter: 'slack',
    threadRef: thread,
    event: { id: `${thread}:e`, principalId, text: 'build it', ref: { channel, message }, fileIds: [], receivedAt: new Date().toISOString() },
    replyRef: { channel, thread: message },
    files: [],
  })
  if (result.kind !== 'created') throw new Error('fixture: task not created')
  return { workspaceId, principalId, channel, task: result.task, projectId, teamId: rows[0]?.id ?? '' }
}

export function snapshot(teamId: string, memberLimit = 3, members: Partial<SnapshotMember>[] = [{ name: 'Theo' }, { name: 'Iris' }]): RunSnapshot {
  return {
    teamId,
    memberLimit,
    members: [
      { id: 'lead', name: 'Maya', role: 'Lead', isLead: true, client: 'claude', model: null, personaName: 'Engineer', personaPath: '/tmp/p.md' },
      ...members.map((member, index) => ({ id: `m${index}`, name: `M${index}`, role: 'Developer', isLead: false, client: 'claude' as const, model: null, personaName: 'Engineer', personaPath: '/tmp/p.md', ...member })),
    ],
  }
}

export async function openRun(pool: Pool, fixture: TeamFixture, overrides: Partial<Parameters<typeof insertRun>[1]> = {}): Promise<TeamRun> {
  return insertRun(pool, {
    id: randomUUID(),
    workspaceId: fixture.workspaceId,
    taskId: fixture.task.id,
    projectId: fixture.projectId,
    title: 'add a button',
    kind: 'build',
    repoName: 'web',
    repoPath: '/tmp/web',
    prRef: null,
    baseCommit: 'abc',
    worktreePath: '/tmp/web-add-a-button',
    branch: 'relay/x-add-a-button',
    snapshot: snapshot(fixture.teamId),
    ...overrides,
  })
}
