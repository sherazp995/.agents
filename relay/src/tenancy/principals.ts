import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { resolvePrincipal as resolvePrincipalImpl } from '../chat/principals.js'

/**
 * Re-exported unchanged, per PRE-2 (docs/decisions/open-questions.md), so
 * every caller has one place, src/tenancy, to look for both halves of
 * principal handling: resolving an identity that may or may not already be
 * mapped, and provisioning one deliberately. This is a direct re-export,
 * not a wrapper, so resolvePrincipal's contract (null for unmapped, never
 * throws, never auto-creates) is exactly what it already was.
 */
export { resolvePrincipal } from '../chat/principals.js'

/**
 * Explicitly creates a principal. Per PRE-2, this is a separate deliberate
 * act from resolution: resolvePrincipal never auto-creates, precisely so an
 * unknown platform user cannot silently become a known one just by being
 * looked up. Something has to call provisionPrincipal on purpose first.
 *
 * Idempotent on the same (workspaceId, platform, platformUserId) identity,
 * matching the UNIQUE constraint principals already carries from
 * 0001_init.sql: a second call for an identity already provisioned returns
 * the existing principal id rather than throwing a duplicate key error, and
 * silently leaves the already stored displayName and roles untouched rather
 * than overwriting them with whatever this call happened to pass. A caller
 * that genuinely wants to change either belongs to a dedicated update path,
 * not a second call to this function.
 */
export async function provisionPrincipal(
  pool: Pool,
  workspaceId: string,
  platform: string,
  platformUserId: string,
  displayName: string,
  roles: string[],
): Promise<string> {
  const id = `prn_${randomUUID()}`
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO principals (id, workspace_id, platform, platform_user_id, display_name, roles)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, platform, platform_user_id) DO NOTHING
     RETURNING id`,
    [id, workspaceId, platform, platformUserId, displayName, roles],
  )
  const insertedId = inserted.rows[0]?.id
  if (insertedId) return insertedId

  const existingId = await resolvePrincipalImpl(pool, workspaceId, platform, platformUserId)
  if (!existingId) {
    throw new Error(
      `provisionPrincipal: no principals row for workspace "${workspaceId}", platform ` +
        `"${platform}", platform_user_id "${platformUserId}" was found after an INSERT ... ON ` +
        'CONFLICT DO NOTHING lost its race. This should be impossible: the winning INSERT must ' +
        'already have committed by the time this lookup runs.',
    )
  }
  return existingId
}
