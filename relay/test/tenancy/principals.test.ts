import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal, resolvePrincipal } from '../../src/tenancy/principals.js'
import { getTestDatabaseUrl } from '../support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/**
 * Fails loudly instead of skipping when the var is absent, matching the
 * pattern test/db/migrate.test.ts and test/chat/principals.test.ts already
 * use. vitest.config.ts sets a local default, so this only fires when a
 * caller has explicitly overridden it to empty. A skipped test proves
 * nothing.
 */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'Principal provisioning tests must fail, not silently skip, when it is absent.',
          )
        })
      })

/** Mirrors the same guard in test/db/migrate.test.ts: never run against a database whose name does not mark it as disposable. */
function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run principal provisioning tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

describeDb('provisionPrincipal and resolvePrincipal (PRE-2)', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function createWorkspace(): Promise<string> {
    return resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
  }

  async function countPrincipals(workspaceId: string, platform: string, platformUserId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM principals
       WHERE workspace_id = $1 AND platform = $2 AND platform_user_id = $3`,
      [workspaceId, platform, platformUserId],
    )
    return Number(rows[0]?.count ?? '0')
  }

  it('an unmapped user still resolves to null, and resolving it does not provision a principal', async () => {
    const workspaceId = await createWorkspace()
    const platformUserId = `U_UNMAPPED_${randomUUID()}`

    await expect(resolvePrincipal(pool, workspaceId, 'slack', platformUserId)).resolves.toBeNull()
    expect(await countPrincipals(workspaceId, 'slack', platformUserId)).toBe(0)

    // Resolving twice must not be the thing that quietly provisions one
    // either: resolution and provisioning are two separate, deliberate acts.
    await expect(resolvePrincipal(pool, workspaceId, 'slack', platformUserId)).resolves.toBeNull()
    expect(await countPrincipals(workspaceId, 'slack', platformUserId)).toBe(0)
  })

  it('a provisioned principal then resolves, through the same resolvePrincipal this module re-exports', async () => {
    const workspaceId = await createWorkspace()
    const platformUserId = `U_PROVISIONED_${randomUUID()}`

    const principalId = await provisionPrincipal(
      pool,
      workspaceId,
      'slack',
      platformUserId,
      'Test Principal',
      ['operator'],
    )

    expect(principalId).toBeTruthy()
    await expect(resolvePrincipal(pool, workspaceId, 'slack', platformUserId)).resolves.toBe(principalId)
    expect(await countPrincipals(workspaceId, 'slack', platformUserId)).toBe(1)
  })

  it('provisioning the same identity twice is idempotent: it returns the original id and does not duplicate the row', async () => {
    const workspaceId = await createWorkspace()
    const platformUserId = `U_TWICE_${randomUUID()}`

    const first = await provisionPrincipal(pool, workspaceId, 'slack', platformUserId, 'First Name', ['operator'])
    const second = await provisionPrincipal(pool, workspaceId, 'slack', platformUserId, 'Second Name', ['admin'])

    expect(second).toBe(first)
    expect(await countPrincipals(workspaceId, 'slack', platformUserId)).toBe(1)

    const { rows } = await pool.query<{ display_name: string }>(
      'SELECT display_name FROM principals WHERE id = $1',
      [first],
    )
    // The second call's displayName is silently ignored, not applied: a
    // caller that genuinely wants to change it belongs to a dedicated
    // update path, not a second provisionPrincipal call.
    expect(rows[0]?.display_name).toBe('First Name')
  })

  it('scopes provisioning by workspace: the same platform user id in two workspaces provisions two different principals', async () => {
    const workspaceA = await createWorkspace()
    const workspaceB = await createWorkspace()
    const sharedPlatformUserId = `U_SHARED_${randomUUID()}`

    const principalA = await provisionPrincipal(pool, workspaceA, 'slack', sharedPlatformUserId, 'A', ['operator'])
    const principalB = await provisionPrincipal(pool, workspaceB, 'slack', sharedPlatformUserId, 'B', ['operator'])

    expect(principalA).not.toBe(principalB)
    await expect(resolvePrincipal(pool, workspaceA, 'slack', sharedPlatformUserId)).resolves.toBe(principalA)
    await expect(resolvePrincipal(pool, workspaceB, 'slack', sharedPlatformUserId)).resolves.toBe(principalB)
  })
})
