/**
 * Login for the setup page. `relay ui` mints a one-time link for a
 * workspace owner; redeeming it (once, atomically) opens a session held in
 * an HttpOnly, SameSite=Strict cookie. Only hashes of the link token and the
 * session id are stored. A session ends after 12 hours idle or 7 days, on
 * logout, or as soon as the person is no longer an owner (checked on every
 * request).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import { OWNER_ROLE_NAMES } from '../tenancy/roles.js'

export const LOGIN_LINK_TTL_MS = 10 * 60 * 1000
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = 'relay_ui'

function secret(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Stores a hashed one-time token for this owner and returns the token itself. */
export async function mintLoginLink(pool: Pool, workspaceId: string, principalId: string, now: Date = new Date()): Promise<string> {
  const token = secret()
  await pool.query('INSERT INTO web_login_links (token_hash, workspace_id, principal_id, expires_at) VALUES ($1, $2, $3, $4)', [
    hashToken(token),
    workspaceId,
    principalId,
    new Date(now.getTime() + LOGIN_LINK_TTL_MS),
  ])
  return token
}

export type Session = { readonly workspaceId: string; readonly principalId: string; readonly csrf: string }

/** Spends the link (once) and opens a session for a person who is still an owner; undefined for anything else. */
export async function redeemLoginLink(pool: Pool, token: string, now: Date = new Date()): Promise<{ cookie: string; session: Session } | undefined> {
  // One UPDATE both checks and spends the link, so two redemptions at the same moment open one session.
  const { rows } = await pool.query<{ workspace_id: string; principal_id: string }>(
    `UPDATE web_login_links SET used_at = $2
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
     RETURNING workspace_id, principal_id`,
    [hashToken(token), now],
  )
  const link = rows[0]
  if (link === undefined || !(await isStillOwner(pool, link.workspace_id, link.principal_id))) return undefined
  const cookie = secret()
  const csrf = secret()
  await pool.query(
    `INSERT INTO web_sessions (id_hash, workspace_id, principal_id, csrf_token, last_seen_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [hashToken(cookie), link.workspace_id, link.principal_id, csrf, now, new Date(now.getTime() + SESSION_IDLE_MS), new Date(now.getTime() + SESSION_ABSOLUTE_MS)],
  )
  return { cookie, session: { workspaceId: link.workspace_id, principalId: link.principal_id, csrf } }
}

/** The live session for this cookie, extending its idle time; undefined when expired, unknown or no longer an owner's. */
export async function loadSession(pool: Pool, cookie: string, now: Date = new Date()): Promise<Session | undefined> {
  const { rows } = await pool.query<{ workspace_id: string; principal_id: string; csrf_token: string }>(
    `UPDATE web_sessions SET last_seen_at = $2, idle_expires_at = LEAST($3::timestamptz, absolute_expires_at)
     WHERE id_hash = $1 AND idle_expires_at > $2 AND absolute_expires_at > $2
     RETURNING workspace_id, principal_id, csrf_token`,
    [hashToken(cookie), now, new Date(now.getTime() + SESSION_IDLE_MS)],
  )
  const row = rows[0]
  if (row === undefined) return undefined
  if (!(await isStillOwner(pool, row.workspace_id, row.principal_id))) {
    await endSession(pool, cookie)
    return undefined
  }
  return { workspaceId: row.workspace_id, principalId: row.principal_id, csrf: row.csrf_token }
}

export async function endSession(pool: Pool, cookie: string): Promise<void> {
  await pool.query('DELETE FROM web_sessions WHERE id_hash = $1', [hashToken(cookie)])
}

async function isStillOwner(pool: Pool, workspaceId: string, principalId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM principals WHERE workspace_id = $1 AND id = $2 AND roles && $3::text[]', [workspaceId, principalId, OWNER_ROLE_NAMES])
  return rows.length > 0
}

/** Compares a submitted CSRF token to the session's in constant time. */
export function csrfMatches(expected: string, submitted: string | undefined): boolean {
  if (submitted === undefined) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(submitted)
  return a.length === b.length && timingSafeEqual(a, b)
}
