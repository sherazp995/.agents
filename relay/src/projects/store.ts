/**
 * Projects, the global persona library and each project's team, as the
 * local web page (src/ui) edits them. Every query is scoped by workspace
 * (AP-8). Writes take a PoolClient so the page can commit a change together
 * with its audit entry; reads take a Pool or a client.
 */

import type { Pool, PoolClient } from 'pg'
import type { AccountClient } from '../autonomous/accounts.js'

type Db = Pool | PoolClient

export type Project = {
  readonly id: string
  readonly name: string
  readonly slackChannel: string
  readonly folder: string
  readonly repos: readonly string[]
}

export type ProjectInput = {
  readonly name: string
  readonly slackChannel: string
  readonly folder: string
  readonly repos: readonly string[]
}

export type Persona = {
  readonly id: string
  readonly name: string
  readonly fileName: string
  /** Names of the projects whose team uses this persona. */
  readonly projects: readonly string[]
  /** Relay wrote it from an approved team proposal (not made by hand). */
  readonly writtenByRelay: boolean
}

export type TeamMember = {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly isLead: boolean
  readonly personaId: string
  readonly personaName: string
  /** The CLI this member runs on; only that client's logins are used. */
  readonly client: AccountClient
  /** A model for that CLI, or null for its default. */
  readonly model: string | null
}

export type TeamMemberInput = {
  readonly name: string
  readonly role: string
  readonly personaId: string
  readonly isLead: boolean
  /** Omitted: Claude for a new member; an update keeps the member's own. */
  readonly client?: AccountClient
  /** Omitted: none for a new member; an update keeps the member's own. Null clears it. */
  readonly model?: string | null
}

/** A save the database refused for a reason the page can name. */
export class StoreConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreConflict'
  }
}

const PG_UNIQUE_VIOLATION = '23505'
const PG_FOREIGN_KEY_VIOLATION = '23503'

function pgCode(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== 'object' || error === null) return {}
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return { ...(typeof code === 'string' ? { code } : {}), ...(typeof constraint === 'string' ? { constraint } : {}) }
}

/** Turns the database's own refusals into a message for the page; anything else is rethrown. */
function explain(error: unknown): never {
  const { code, constraint } = pgCode(error)
  if (code === PG_UNIQUE_VIOLATION && constraint === 'projects_workspace_id_slack_channel_key') {
    throw new StoreConflict('That Slack channel already belongs to another project.')
  }
  if (code === PG_UNIQUE_VIOLATION && constraint === 'team_members_one_lead') {
    throw new StoreConflict('This team already has a lead; a team has one.')
  }
  if (code === PG_FOREIGN_KEY_VIOLATION && constraint === 'team_members_workspace_id_persona_id_fkey') {
    throw new StoreConflict('That persona is not in this workspace\'s library.')
  }
  throw error
}

// Projects

type ProjectRow = { id: string; name: string; slack_channel: string; folder: string; repos: string[] | null }

const PROJECT_SELECT = `
  SELECT p.id, p.name, p.slack_channel, p.folder,
         array_remove(array_agg(r.repo_name ORDER BY r.repo_name), NULL) AS repos
  FROM projects p
  LEFT JOIN project_repos r ON r.project_id = p.id AND r.workspace_id = p.workspace_id`

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, slackChannel: row.slack_channel, folder: row.folder, repos: row.repos ?? [] }
}

export async function listProjects(db: Db, workspaceId: string): Promise<Project[]> {
  const { rows } = await db.query<ProjectRow>(`${PROJECT_SELECT} WHERE p.workspace_id = $1 GROUP BY p.id ORDER BY lower(p.name), p.id`, [workspaceId])
  return rows.map(toProject)
}

/** A project with its team at a glance, for the projects table. */
export type ProjectSummary = Project & { readonly lead: string | undefined; readonly teamSize: number }

/** Every project with its lead's name and team size, in one query. */
export async function listProjectSummaries(db: Db, workspaceId: string): Promise<ProjectSummary[]> {
  const { rows } = await db.query<ProjectRow & { lead: string | null; team_size: string }>(
    `SELECT p.id, p.name, p.slack_channel, p.folder,
            COALESCE((SELECT array_agg(r.repo_name ORDER BY r.repo_name) FROM project_repos r WHERE r.project_id = p.id AND r.workspace_id = p.workspace_id), '{}') AS repos,
            (SELECT m.name FROM team_members m WHERE m.team_id = t.id AND m.workspace_id = p.workspace_id AND m.is_lead LIMIT 1) AS lead,
            (SELECT count(*) FROM team_members m WHERE m.team_id = t.id AND m.workspace_id = p.workspace_id) AS team_size
     FROM projects p
     LEFT JOIN teams t ON t.project_id = p.id AND t.workspace_id = p.workspace_id
     WHERE p.workspace_id = $1
     ORDER BY lower(p.name), p.id`,
    [workspaceId],
  )
  return rows.map((row) => ({ ...toProject(row), lead: row.lead ?? undefined, teamSize: Number(row.team_size) }))
}

export async function getProject(db: Db, workspaceId: string, projectId: string): Promise<Project | undefined> {
  const { rows } = await db.query<ProjectRow>(`${PROJECT_SELECT} WHERE p.workspace_id = $1 AND p.id = $2 GROUP BY p.id`, [workspaceId, projectId])
  const row = rows[0]
  return row === undefined ? undefined : toProject(row)
}

/** The folder of the project that owns this Slack channel, if one does. */
export async function projectFolderForChannel(db: Db, workspaceId: string, channel: string): Promise<string | undefined> {
  const { rows } = await db.query<{ folder: string }>('SELECT folder FROM projects WHERE workspace_id = $1 AND slack_channel = $2', [workspaceId, channel])
  return rows[0]?.folder
}

export async function createProject(client: PoolClient, workspaceId: string, input: ProjectInput): Promise<string> {
  try {
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO projects (workspace_id, name, slack_channel, folder) VALUES ($1, $2, $3, $4) RETURNING id',
      [workspaceId, input.name, input.slackChannel, input.folder],
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('createProject: INSERT returned no id')
    await setProjectRepos(client, workspaceId, id, input.repos)
    return id
  } catch (error) {
    explain(error)
  }
}

export async function updateProject(client: PoolClient, workspaceId: string, projectId: string, input: ProjectInput): Promise<boolean> {
  try {
    const { rowCount } = await client.query(
      'UPDATE projects SET name = $3, slack_channel = $4, folder = $5, updated_at = now() WHERE workspace_id = $1 AND id = $2',
      [workspaceId, projectId, input.name, input.slackChannel, input.folder],
    )
    if (rowCount === 0) return false
    await setProjectRepos(client, workspaceId, projectId, input.repos)
    return true
  } catch (error) {
    explain(error)
  }
}

async function setProjectRepos(client: PoolClient, workspaceId: string, projectId: string, repos: readonly string[]): Promise<void> {
  await client.query('DELETE FROM project_repos WHERE workspace_id = $1 AND project_id = $2', [workspaceId, projectId])
  for (const repo of new Set(repos)) {
    await client.query('INSERT INTO project_repos (workspace_id, project_id, repo_name) VALUES ($1, $2, $3)', [workspaceId, projectId, repo])
  }
}

export async function deleteProject(client: PoolClient, workspaceId: string, projectId: string): Promise<boolean> {
  const { rowCount } = await client.query('DELETE FROM projects WHERE workspace_id = $1 AND id = $2', [workspaceId, projectId])
  return (rowCount ?? 0) > 0
}

// Personas

type PersonaRow = { id: string; name: string; file_name: string; written_by_relay: boolean; projects: string[] | null }

const PERSONA_SELECT = `
  SELECT pe.id, pe.name, pe.file_name, pe.written_by_relay,
         array_remove(array_agg(DISTINCT p.name), NULL) AS projects
  FROM personas pe
  LEFT JOIN team_members m ON m.persona_id = pe.id AND m.workspace_id = pe.workspace_id
  LEFT JOIN teams t ON t.id = m.team_id AND t.workspace_id = pe.workspace_id
  LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = pe.workspace_id`

function toPersona(row: PersonaRow): Persona {
  return { id: row.id, name: row.name, fileName: row.file_name, projects: [...(row.projects ?? [])].sort(), writtenByRelay: row.written_by_relay }
}

export async function listPersonas(db: Db, workspaceId: string): Promise<Persona[]> {
  const { rows } = await db.query<PersonaRow>(`${PERSONA_SELECT} WHERE pe.workspace_id = $1 GROUP BY pe.id ORDER BY lower(pe.name), pe.id`, [workspaceId])
  return rows.map(toPersona)
}

export async function getPersona(db: Db, workspaceId: string, personaId: string): Promise<Persona | undefined> {
  const { rows } = await db.query<PersonaRow>(`${PERSONA_SELECT} WHERE pe.workspace_id = $1 AND pe.id = $2 GROUP BY pe.id`, [workspaceId, personaId])
  const row = rows[0]
  return row === undefined ? undefined : toPersona(row)
}

export async function insertPersona(client: PoolClient, workspaceId: string, input: { name: string; fileName: string }): Promise<string> {
  const { rows } = await client.query<{ id: string }>('INSERT INTO personas (workspace_id, name, file_name) VALUES ($1, $2, $3) RETURNING id', [workspaceId, input.name, input.fileName])
  const id = rows[0]?.id
  if (id === undefined) throw new Error('insertPersona: INSERT returned no id')
  return id
}

export async function renamePersona(client: PoolClient, workspaceId: string, personaId: string, name: string): Promise<boolean> {
  const { rowCount } = await client.query('UPDATE personas SET name = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, personaId, name])
  return (rowCount ?? 0) > 0
}

/** Removes a persona no team uses; refuses one still on a team, naming the projects. */
export async function deletePersona(client: PoolClient, workspaceId: string, personaId: string): Promise<boolean> {
  const persona = await getPersona(client, workspaceId, personaId)
  if (persona === undefined) return false
  if (persona.projects.length > 0) throw new StoreConflict(`"${persona.name}" is on the team of ${persona.projects.join(', ')}; take it off first.`)
  try {
    const { rowCount } = await client.query('DELETE FROM personas WHERE workspace_id = $1 AND id = $2', [workspaceId, personaId])
    return (rowCount ?? 0) > 0
  } catch (error) {
    const { code } = pgCode(error)
    // A member added since the check above: the database's RESTRICT holds the line.
    if (code === PG_FOREIGN_KEY_VIOLATION) throw new StoreConflict(`"${persona.name}" is on a team; take it off first.`)
    throw error
  }
}

// Teams

/**
 * The project's team, made on first use (one per project). The upsert also
 * locks the team row until the transaction ends, so every member write and a
 * proposal's approval take turns on the same team.
 */
export async function ensureTeam(client: PoolClient, workspaceId: string, projectId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teams (workspace_id, project_id) VALUES ($1, $2)
     ON CONFLICT (project_id) DO UPDATE SET project_id = EXCLUDED.project_id
     RETURNING id`,
    [workspaceId, projectId],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('ensureTeam: INSERT returned no id')
  return id
}

type MemberRow = { id: string; name: string; role: string; is_lead: boolean; persona_id: string; persona_name: string; client: AccountClient; model: string | null }

export async function listMembers(db: Db, workspaceId: string, projectId: string): Promise<TeamMember[]> {
  const { rows } = await db.query<MemberRow>(
    `SELECT m.id, m.name, m.role, m.is_lead, m.persona_id, pe.name AS persona_name, m.client, m.model
     FROM team_members m
     JOIN teams t ON t.id = m.team_id AND t.workspace_id = m.workspace_id
     JOIN personas pe ON pe.id = m.persona_id AND pe.workspace_id = m.workspace_id
     WHERE m.workspace_id = $1 AND t.project_id = $2
     ORDER BY m.is_lead DESC, m.created_at, m.id`,
    [workspaceId, projectId],
  )
  return rows.map((row) => ({ id: row.id, name: row.name, role: row.role, isLead: row.is_lead, personaId: row.persona_id, personaName: row.persona_name, client: row.client, model: row.model }))
}

export async function addMember(client: PoolClient, workspaceId: string, projectId: string, input: TeamMemberInput): Promise<string> {
  const teamId = await ensureTeam(client, workspaceId, projectId)
  try {
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO team_members (workspace_id, team_id, persona_id, name, role, is_lead, client, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [workspaceId, teamId, input.personaId, input.name, input.role, input.isLead, input.client ?? 'claude', input.model ?? null],
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('addMember: INSERT returned no id')
    return id
  } catch (error) {
    explain(error)
  }
}

export async function updateMember(client: PoolClient, workspaceId: string, projectId: string, memberId: string, input: TeamMemberInput): Promise<boolean> {
  await ensureTeam(client, workspaceId, projectId)
  try {
    const { rowCount } = await client.query(
      `UPDATE team_members m SET persona_id = $4, name = $5, role = $6, is_lead = $7,
              client = COALESCE($8, m.client), model = CASE WHEN $9::boolean THEN $10::text ELSE m.model END
       FROM teams t
       WHERE m.workspace_id = $1 AND m.id = $3 AND t.id = m.team_id AND t.workspace_id = m.workspace_id AND t.project_id = $2`,
      [workspaceId, projectId, memberId, input.personaId, input.name, input.role, input.isLead, input.client ?? null, input.model !== undefined, input.model ?? null],
    )
    return (rowCount ?? 0) > 0
  } catch (error) {
    explain(error)
  }
}

export async function removeMember(client: PoolClient, workspaceId: string, projectId: string, memberId: string): Promise<boolean> {
  await ensureTeam(client, workspaceId, projectId)
  const { rowCount } = await client.query(
    `DELETE FROM team_members m USING teams t
     WHERE m.workspace_id = $1 AND m.id = $3 AND t.id = m.team_id AND t.workspace_id = m.workspace_id AND t.project_id = $2`,
    [workspaceId, projectId, memberId],
  )
  return (rowCount ?? 0) > 0
}

/** How many members of the project's team may work at once (1 to 6; 3 until set). */
export async function getMemberLimit(db: Db, workspaceId: string, projectId: string): Promise<number> {
  const { rows } = await db.query<{ member_limit: number }>('SELECT member_limit FROM teams WHERE workspace_id = $1 AND project_id = $2', [workspaceId, projectId])
  return rows[0]?.member_limit ?? 3
}

export async function setMemberLimit(client: PoolClient, workspaceId: string, projectId: string, limit: number): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new StoreConflict('A team runs 1 to 6 members at once.')
  await ensureTeam(client, workspaceId, projectId)
  await client.query('UPDATE teams SET member_limit = $3 WHERE workspace_id = $1 AND project_id = $2', [workspaceId, projectId, limit])
}

/** The project that owns this Slack channel, with its repos. */
export async function projectForChannelWithRepos(db: Db, workspaceId: string, channel: string): Promise<Project | undefined> {
  const { rows } = await db.query<ProjectRow>(`${PROJECT_SELECT} WHERE p.workspace_id = $1 AND p.slack_channel = $2 GROUP BY p.id`, [workspaceId, channel])
  const row = rows[0]
  return row === undefined ? undefined : toProject(row)
}
