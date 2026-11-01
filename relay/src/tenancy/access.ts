import type { Pool } from 'pg'
import { isLiveControlled } from '../live/control.js'
import type { Session } from '../sessions/store.js'
import { isOwner } from './roles.js'

/**
 * Who may do what on this Relay, per src/tenancy/roles.ts. The chat
 * paths ask here instead of reading roles themselves, so every owner-only
 * gate answers the same way and fails closed the same way: a principal
 * that cannot be found, or holds no owner role, is not an owner.
 */

/** The reply a member gets on an owner-only path. */
export const OWNER_ONLY_REPLY = 'Only the owner of this Relay can do that.'

/** The reply a member gets in a thread someone else started. */
export const NOT_YOUR_THREAD_REPLY = 'This thread belongs to someone else. Start your own by mentioning me.'

export async function principalIsOwner(pool: Pool, workspaceId: string, principalId: string): Promise<boolean> {
  const { rows } = await pool.query<{ roles: string[] }>('SELECT roles FROM principals WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    principalId,
  ])
  return isOwner(rows[0]?.roles ?? [])
}

/** The same answer for a platform identity, for the adapter paths that never resolve a principal id. */
export async function platformUserIsOwner(pool: Pool, workspaceId: string, platform: string, platformUserId: string): Promise<boolean> {
  const { rows } = await pool.query<{ roles: string[] }>(
    'SELECT roles FROM principals WHERE workspace_id = $1 AND platform = $2 AND platform_user_id = $3',
    [workspaceId, platform, platformUserId],
  )
  return isOwner(rows[0]?.roles ?? [])
}

/**
 * Why a member may not post in `thread`, or undefined when they may. A
 * member acts only in a new thread (no session yet) or one they started,
 * and never in a direct or live chat thread, even their own: both reach
 * the owner's machine unmediated. An owner never reaches this check.
 */
export async function memberRefusal(
  pool: Pool,
  workspaceId: string,
  principalId: string,
  thread: Pick<Session, 'id' | 'principalId' | 'mode'> | null,
): Promise<string | undefined> {
  if (thread === null) return undefined
  if (thread.principalId !== principalId) return NOT_YOUR_THREAD_REPLY
  if (thread.mode === 'direct' || (await isLiveControlled(pool, thread.id, workspaceId))) return OWNER_ONLY_REPLY
  return undefined
}
