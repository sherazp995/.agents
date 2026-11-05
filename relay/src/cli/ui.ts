/**
 * `relay ui`: a one-time login link to the local setup page for a workspace
 * owner (the Slack user Relay already treats as owner). The link works once,
 * for ten minutes. It refuses to run inside an agent's turn; the worker
 * guard also blocks it in agent shells.
 */

import type { Pool } from 'pg'
import { listWorkspacesForPlatform } from '../tenancy/workspaces.js'
import { OWNER_ROLE_NAMES } from '../tenancy/roles.js'
import { mintLoginLink } from '../ui/auth.js'

const PLATFORM = 'slack'

export class UiCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UiCommandError'
  }
}

export type UiParams = {
  readonly port: number
  /** A Slack user id; must be an owner. Defaults to the workspace's one owner. */
  readonly as?: string
  readonly workspaceId?: string
  readonly env?: NodeJS.ProcessEnv
  readonly now?: Date
}

export type UiLink = { readonly url: string; readonly slackUserId: string }

export async function runUi(pool: Pool, params: UiParams): Promise<UiLink> {
  const env = params.env ?? process.env
  // Set in every agent turn Relay runs (src/autonomous/worker.ts).
  if (env.RELAY_HOOK_TOKEN !== undefined && env.RELAY_HOOK_TOKEN !== '') {
    throw new UiCommandError('relay ui cannot run inside an agent\'s turn; run it yourself in a terminal.')
  }
  const workspaceId = params.workspaceId ?? (await onlySlackWorkspace(pool))
  const owners = await ownersOf(pool, workspaceId)
  const owner = params.as !== undefined ? owners.find((candidate) => candidate.slackUserId === params.as) : owners.length === 1 ? owners[0] : undefined
  if (owner === undefined) {
    if (params.as !== undefined) throw new UiCommandError(`${params.as} is not an owner in this workspace.`)
    if (owners.length === 0) throw new UiCommandError('No owner is mapped in this workspace; add one with `relay principals add --role owner`.')
    throw new UiCommandError(`More than one owner; pass --as with one of: ${owners.map((candidate) => candidate.slackUserId).join(', ')}.`)
  }
  const token = await mintLoginLink(pool, workspaceId, owner.principalId, params.now)
  return { url: `http://127.0.0.1:${params.port}/login?token=${token}`, slackUserId: owner.slackUserId }
}

async function onlySlackWorkspace(pool: Pool): Promise<string> {
  const workspaces = await listWorkspacesForPlatform(pool, PLATFORM)
  const only = workspaces[0]
  if (only === undefined) throw new UiCommandError('No Slack workspace yet: start the relay daemon once so it connects.')
  if (workspaces.length > 1) throw new UiCommandError('More than one Slack workspace exists; pass --workspace-id.')
  return only.id
}

async function ownersOf(pool: Pool, workspaceId: string): Promise<{ principalId: string; slackUserId: string }[]> {
  const { rows } = await pool.query<{ id: string; platform_user_id: string }>(
    'SELECT id, platform_user_id FROM principals WHERE workspace_id = $1 AND platform = $2 AND roles && $3::text[] ORDER BY platform_user_id',
    [workspaceId, PLATFORM, OWNER_ROLE_NAMES],
  )
  return rows.map((row) => ({ principalId: row.id, slackUserId: row.platform_user_id }))
}
