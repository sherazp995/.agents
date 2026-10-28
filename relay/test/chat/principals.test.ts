import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolvePrincipal } from '../../src/chat/principals.js'
import { getTestDatabaseUrl } from '../support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/**
 * Fails loudly instead of skipping when the var is absent, matching the
 * pattern test/db/migrate.test.ts and test/redis/client.test.ts already use.
 * vitest.config.ts sets a local default, so this only fires when a caller
 * has explicitly overridden it to empty. A skipped test proves nothing.
 */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'Principal mapping tests must fail, not silently skip, when it is absent.',
          )
        })
      })

/** Mirrors the same guard in test/db/migrate.test.ts: never run against a database whose name does not mark it as disposable. */
function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run principal tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

describeDb('resolvePrincipal', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    // test/db/migrate.test.ts drops and recreates the public schema in its
    // own beforeAll. Both files now get their own worker's database (see
    // test/support/database.ts), but this suite still never assumes a
    // starting state; it applies migrations itself so the schema is
    // present either way, and applyMigrations is idempotent so this is
    // safe to repeat.
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function createWorkspace(): Promise<string> {
    // platform and platform_team_id are NOT NULL as of 0003_orchestrator.sql
    // (src/tenancy/workspaces.ts's UNIQUE (platform, platform_team_id)
    // provisioning target), so this direct insert supplies a synthetic,
    // always distinct pair rather than going through resolveWorkspaceId:
    // this suite is testing resolvePrincipal, not workspace provisioning.
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO workspaces (name, platform, platform_team_id) VALUES ($1, $2, $3) RETURNING id',
      [`test-workspace-${randomUUID()}`, 'test', randomUUID()],
    )
    const id = rows[0]?.id
    if (!id) throw new Error('workspace insert returned no id')
    return id
  }

  async function createPrincipal(
    workspaceId: string,
    platform: string,
    platformUserId: string,
  ): Promise<string> {
    const id = `prn_${randomUUID()}`
    await pool.query(
      `INSERT INTO principals (id, workspace_id, platform, platform_user_id, display_name, roles)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, workspaceId, platform, platformUserId, 'Test Principal', ['operator']],
    )
    return id
  }

  it('resolves a mapped identity to its principal id', async () => {
    const workspaceId = await createWorkspace()
    const principalId = await createPrincipal(workspaceId, 'slack', 'U_MAPPED')

    await expect(resolvePrincipal(pool, workspaceId, 'slack', 'U_MAPPED')).resolves.toBe(
      principalId,
    )
  })

  it('resolves an unmapped identity to null rather than throwing, per FR-CA-4', async () => {
    const workspaceId = await createWorkspace()

    await expect(
      resolvePrincipal(pool, workspaceId, 'slack', 'U_NEVER_MAPPED'),
    ).resolves.toBeNull()
  })

  it('scopes a mapping by workspace: the same platform user id in two workspaces resolves to two different principals', async () => {
    const workspaceA = await createWorkspace()
    const workspaceB = await createWorkspace()
    const sharedPlatformUserId = `U_SHARED_${randomUUID()}`
    const principalA = await createPrincipal(workspaceA, 'slack', sharedPlatformUserId)
    const principalB = await createPrincipal(workspaceB, 'slack', sharedPlatformUserId)

    const resolvedA = await resolvePrincipal(pool, workspaceA, 'slack', sharedPlatformUserId)
    const resolvedB = await resolvePrincipal(pool, workspaceB, 'slack', sharedPlatformUserId)

    expect(resolvedA).toBe(principalA)
    expect(resolvedB).toBe(principalB)
    expect(resolvedA).not.toBe(resolvedB)
  })

  it('is case sensitive on platform user id, matching Slack ids', async () => {
    const workspaceId = await createWorkspace()
    const lowerId = `u_case_${randomUUID()}`
    const upperId = lowerId.toUpperCase()
    const principalId = await createPrincipal(workspaceId, 'slack', lowerId)

    await expect(resolvePrincipal(pool, workspaceId, 'slack', lowerId)).resolves.toBe(
      principalId,
    )
    await expect(resolvePrincipal(pool, workspaceId, 'slack', upperId)).resolves.toBeNull()
  })
})
