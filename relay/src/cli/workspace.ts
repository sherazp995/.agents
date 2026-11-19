/**
 * The workspace a configuration command (`relay env`, `relay channel`)
 * writes to: the one named by --workspace-id, or the only one. Unlike the
 * live commands, it never picks the oldest of several, because a stored env
 * or folder in the wrong workspace silently does nothing.
 */

import type { Pool } from 'pg'

export type WorkspaceChoice = { readonly kind: 'ok'; readonly workspaceId: string } | { readonly kind: 'refused'; readonly message: string }

type WorkspaceRow = { readonly id: string; readonly name: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Decides from the workspaces that exist (or, with `explicit`, the ones matching it). */
export function chooseWorkspace(rows: readonly WorkspaceRow[], explicit: string | undefined): WorkspaceChoice {
  const only = rows[0]
  if (explicit !== undefined) {
    return only === undefined ? { kind: 'refused', message: `No workspace has the id ${explicit}.` } : { kind: 'ok', workspaceId: only.id }
  }
  if (only === undefined) return { kind: 'refused', message: 'No workspace exists yet. Start Relay and send it one Slack message first.' }
  if (rows.length === 1) return { kind: 'ok', workspaceId: only.id }
  const listed = rows.map((row) => `  ${row.id}  ${row.name}`).join('\n')
  return { kind: 'refused', message: `There are ${rows.length} workspaces; pass --workspace-id with one of them:\n${listed}` }
}

export async function resolveCliWorkspace(pool: Pool, explicit: string | undefined): Promise<WorkspaceChoice> {
  if (explicit !== undefined && !UUID.test(explicit)) return { kind: 'refused', message: `--workspace-id must be a workspace uuid, got "${explicit}".` }
  const { rows } =
    explicit === undefined
      ? await pool.query<WorkspaceRow>('SELECT id, name FROM workspaces ORDER BY created_at, id')
      : await pool.query<WorkspaceRow>('SELECT id, name FROM workspaces WHERE id = $1', [explicit])
  return chooseWorkspace(rows, explicit)
}
