import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/**
 * Maps a chat platform's own tenant id (Slack's `team_id`, for instance) to
 * this workspace's Relay uuid, per PRE-3 (docs/decisions/open-questions.md).
 * Provisions a `workspaces` row the first time a given (platform,
 * platformTeamId) pair is seen, so a caller never has to provision a
 * workspace separately before it can be resolved.
 *
 * Idempotent under concurrency: two callers racing to provision the same
 * pair for the first time must produce exactly one `workspaces` row, not
 * two. A check then insert cannot guarantee that on its own, since both
 * callers can see "not found" before either commits, so this leans on the
 * UNIQUE (platform, platform_team_id) constraint added by
 * src/db/migrations/0003_orchestrator.sql: the INSERT below is what
 * Postgres actually serializes the race against, not application logic.
 *
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING id` returns no row for
 * whichever caller loses the race, because DO NOTHING has nothing to
 * RETURNING from. A naive implementation that stopped there would resolve
 * to undefined for the loser instead of the row the winner created. This
 * function instead falls back to a plain SELECT in that case, which is safe
 * precisely because it only runs after the INSERT has already been
 * attempted and the database round trip for it has completed: by then,
 * either this call won the race and its own row already exists, or it lost
 * and the winner's INSERT has already committed, so the row this SELECT
 * looks for is guaranteed to be present.
 */
export async function resolveWorkspaceId(
  pool: Pool,
  platform: string,
  platformTeamId: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (id, name, platform, platform_team_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (platform, platform_team_id) DO NOTHING
     RETURNING id`,
    [randomUUID(), `${platform}:${platformTeamId}`, platform, platformTeamId],
  )
  const insertedId = inserted.rows[0]?.id
  if (insertedId) return insertedId

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE platform = $1 AND platform_team_id = $2`,
    [platform, platformTeamId],
  )
  const existingId = rows[0]?.id
  if (!existingId) {
    throw new Error(
      `resolveWorkspaceId: no workspaces row for platform "${platform}" and platform_team_id ` +
        `"${platformTeamId}" was found after an INSERT ... ON CONFLICT DO NOTHING lost its race. ` +
        'This should be impossible: the winning INSERT must already have committed by the time ' +
        'this SELECT runs.',
    )
  }
  return existingId
}

/**
 * A pure lookup, never a provisioning act, unlike resolveWorkspaceId. Used
 * by `relay principals add` (src/cli/principals.ts): provisioning a
 * principal into a workspace that does not exist yet would silently create
 * a workspace nobody's adapter will ever match again (a fresh uuid, never
 * mapped to a real platform_team_id), so the caller needs to know whether a
 * workspace is genuinely there before acting, not have one manufactured on
 * its behalf. Returns every workspace row for `platform`, oldest first, so
 * a caller can both detect "none yet" (empty array) and "more than one,
 * disambiguate" (more than one row) rather than only ever seeing a single
 * guessed answer.
 */
export async function listWorkspacesForPlatform(
  pool: Pool,
  platform: string,
): Promise<{ id: string; platformTeamId: string }[]> {
  const { rows } = await pool.query<{ id: string; platform_team_id: string }>(
    'SELECT id, platform_team_id FROM workspaces WHERE platform = $1 ORDER BY created_at',
    [platform],
  )
  return rows.map((row) => ({ id: row.id, platformTeamId: row.platform_team_id }))
}
