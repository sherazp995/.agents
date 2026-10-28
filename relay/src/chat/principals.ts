import type { Pool } from 'pg'

/**
 * Maps a platform identity to a Relay principal id, per FR-CA-4.
 *
 * The mapping is scoped by workspace and platform, matching the
 * UNIQUE (workspace_id, platform, platform_user_id) constraint on
 * principals from 0001_init.sql, so the same platform user id in two
 * workspaces resolves to two independent principals, per AP-8.
 *
 * An unmapped identity resolves to `null` rather than throwing or
 * auto-creating a principal. This is a deliberate fail closed rule: a
 * caller that gets `null` back must treat the user as unable to start
 * work, never as a reason to synthesise an identity on the fly.
 */
export async function resolvePrincipal(
  pool: Pool,
  workspaceId: string,
  adapter: string,
  platformUserId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM principals
     WHERE workspace_id = $1 AND platform = $2 AND platform_user_id = $3
     LIMIT 1`,
    [workspaceId, adapter, platformUserId],
  )
  return rows[0]?.id ?? null
}
