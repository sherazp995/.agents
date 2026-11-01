import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { memberRefusal, NOT_YOUR_THREAD_REPLY, OWNER_ONLY_REPLY, platformUserIsOwner, principalIsOwner } from '../../src/tenancy/access.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('principalIsOwner, platformUserIsOwner and memberRefusal', () => {
  let pool: Pool
  let workspaceId: string

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
    await applyMigrations(pool, 'src/db/migrations')
    workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function principal(roles: string[]): Promise<{ id: string; userId: string }> {
    const userId = `U_${randomUUID()}`
    const id = await provisionPrincipal(pool, workspaceId, 'slack', userId, 'someone', roles)
    return { id, userId }
  }

  it('answers true for owner and legacy operator, false for member and unknown roles', async () => {
    for (const [roles, expected] of [
      [['owner'], true],
      [['operator'], true],
      [['member'], false],
      [['admin'], false],
    ] as const) {
      const { id, userId } = await principal([...roles])
      expect(await principalIsOwner(pool, workspaceId, id)).toBe(expected)
      expect(await platformUserIsOwner(pool, workspaceId, 'slack', userId)).toBe(expected)
    }
  })

  it('fails closed for a principal or user that does not exist, or lives in another workspace', async () => {
    const { id, userId } = await principal(['owner'])
    const otherWorkspace = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    expect(await principalIsOwner(pool, workspaceId, 'prn_missing')).toBe(false)
    expect(await platformUserIsOwner(pool, workspaceId, 'slack', 'U_missing')).toBe(false)
    expect(await principalIsOwner(pool, otherWorkspace, id)).toBe(false)
    expect(await platformUserIsOwner(pool, otherWorkspace, 'slack', userId)).toBe(false)
  })

  it('lets a member post in a new thread or one they started, and refuses them elsewhere', async () => {
    const thread = (principalId: string, mode: 'governed' | 'autonomous' | 'direct') => ({ id: randomUUID(), principalId, mode })
    expect(await memberRefusal(pool, workspaceId, 'prn_member', null)).toBeUndefined()
    expect(await memberRefusal(pool, workspaceId, 'prn_member', thread('prn_member', 'autonomous'))).toBeUndefined()
    expect(await memberRefusal(pool, workspaceId, 'prn_member', thread('prn_owner', 'autonomous'))).toBe(NOT_YOUR_THREAD_REPLY)
    expect(await memberRefusal(pool, workspaceId, 'prn_member', thread('prn_member', 'direct'))).toBe(OWNER_ONLY_REPLY)
  })
})
