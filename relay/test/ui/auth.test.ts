import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runUi } from '../../src/cli/ui.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { hashToken, loadSession, LOGIN_LINK_TTL_MS, mintLoginLink, redeemLoginLink, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../src/ui/auth.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('setup page login', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function owner(): Promise<{ workspaceId: string; principalId: string; slackUserId: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const slackUserId = `U_${randomUUID()}`
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', slackUserId, 'Owner', ['owner'])
    return { workspaceId, principalId, slackUserId }
  }

  const at = (start: Date, ms: number) => new Date(start.getTime() + ms)

  it('opens one session from a link, even when it is redeemed twice at the same moment, and stores only hashes', async () => {
    const { workspaceId, principalId } = await owner()
    const now = new Date()
    const token = await mintLoginLink(pool, workspaceId, principalId, now)

    const [a, b] = await Promise.all([redeemLoginLink(pool, token, now), redeemLoginLink(pool, token, now)])

    expect([a, b].filter((result) => result !== undefined)).toHaveLength(1)
    const { rows } = await pool.query('SELECT token_hash FROM web_login_links WHERE workspace_id = $1', [workspaceId])
    expect(rows).toEqual([{ token_hash: hashToken(token) }])
    const opened = a ?? b
    const { rows: sessions } = await pool.query('SELECT id_hash FROM web_sessions WHERE workspace_id = $1', [workspaceId])
    expect(sessions).toEqual([{ id_hash: hashToken(opened?.cookie ?? '') }])
  })

  it('refuses an expired link, and ends a session when idle, at its absolute limit, or when the person stops being an owner', async () => {
    const { workspaceId, principalId } = await owner()
    const start = new Date()
    const stale = await mintLoginLink(pool, workspaceId, principalId, start)
    expect(await redeemLoginLink(pool, stale, at(start, LOGIN_LINK_TTL_MS + 1))).toBeUndefined()

    const opened = await redeemLoginLink(pool, await mintLoginLink(pool, workspaceId, principalId, start), start)
    const cookie = opened?.cookie ?? ''
    // Each use pushes the idle limit out, but never past the absolute one.
    expect(await loadSession(pool, cookie, at(start, SESSION_IDLE_MS - 1000))).toMatchObject({ principalId })
    // Past the first idle limit, still alive because it was used.
    expect(await loadSession(pool, cookie, at(start, SESSION_IDLE_MS + 1000))).toMatchObject({ principalId })
    // Then left idle for longer than the limit.
    expect(await loadSession(pool, cookie, at(start, 2 * SESSION_IDLE_MS + 2000))).toBeUndefined()

    const fresh = await redeemLoginLink(pool, await mintLoginLink(pool, workspaceId, principalId, start), start)
    await pool.query('UPDATE web_sessions SET idle_expires_at = $2 WHERE id_hash = $1', [hashToken(fresh?.cookie ?? ''), at(start, SESSION_ABSOLUTE_MS + 60_000)])
    expect(await loadSession(pool, fresh?.cookie ?? '', at(start, SESSION_ABSOLUTE_MS + 1))).toBeUndefined()

    const demoted = await redeemLoginLink(pool, await mintLoginLink(pool, workspaceId, principalId, start), start)
    await pool.query(`UPDATE principals SET roles = '{member}' WHERE id = $1`, [principalId])
    expect(await loadSession(pool, demoted?.cookie ?? '', start)).toBeUndefined()
    expect(await redeemLoginLink(pool, await mintLoginLink(pool, workspaceId, principalId, start), start)).toBeUndefined()
  })

  it('relay ui mints a link for the one owner, or the one named, and refuses a non-owner and a run inside an agent turn', async () => {
    const { workspaceId, slackUserId } = await owner()
    const member = `U_${randomUUID()}`
    await provisionPrincipal(pool, workspaceId, 'slack', member, 'Member', ['member'])

    const link = await runUi(pool, { port: 7766, workspaceId, env: {} })
    expect(link).toMatchObject({ slackUserId, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:7766\/login\?token=[A-Za-z0-9_-]{43}$/) })
    await expect(runUi(pool, { port: 7766, workspaceId, as: member, env: {} })).rejects.toThrow('is not an owner')
    await expect(runUi(pool, { port: 7766, workspaceId, env: { RELAY_HOOK_TOKEN: 'turn-token' } })).rejects.toThrow("inside an agent's turn")

    const second = `U_${randomUUID()}`
    await provisionPrincipal(pool, workspaceId, 'slack', second, 'Owner 2', ['owner'])
    await expect(runUi(pool, { port: 7766, workspaceId, env: {} })).rejects.toThrow('More than one owner; pass --as')
    expect(await runUi(pool, { port: 7766, workspaceId, as: second, env: {} })).toMatchObject({ slackUserId: second })
  })
})
