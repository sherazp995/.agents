/**
 * Tests for src/cli/principals.ts, added in a fix round on Task 8. Before
 * this module existed, `provisionPrincipal` had no caller at all: an
 * unmapped operator was correctly refused and had no way back in. These
 * tests prove the one, deliberate way back in works, is idempotent, and
 * refuses cleanly rather than guessing when it cannot act safely.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolvePrincipal } from '../../src/chat/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { PrincipalsAddError, runPrincipalsAdd } from '../../src/cli/principals.js'
import { getTestDatabaseUrl } from '../support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'runPrincipalsAdd tests must fail, not silently skip, when it is absent.',
          )
        })
      })

function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run runPrincipalsAdd tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

describeDb('runPrincipalsAdd', () => {
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

  it('provisions a principal that resolvePrincipal then resolves', async () => {
    // A platform unique to this test, NOT the shared 'test' value. This is
    // the one test here that exercises the platform lookup path with no
    // explicit workspaceId, so it needs the platform to have exactly one
    // workspace row. Several test files share a worker, and therefore a
    // database (see test/support/database.ts), and many of them provision
    // workspaces under platform 'test': orchestrator.test.ts, agent/
    // loop.test.ts, runs/store.test.ts, runs/cancel.test.ts, and this
    // file's own later cases. Using 'test' here made the assertion depend
    // on worker assignment and file order, and it would start failing with
    // "Multiple workspaces found" the moment a second 'test' workspace
    // landed in the same database first.
    const platform = `single-${randomUUID()}`
    const teamId = `T_${randomUUID()}`
    const workspaceId = await resolveWorkspaceId(pool, platform, teamId)
    const platformUserId = `U_${randomUUID()}`

    const result = await runPrincipalsAdd(pool, {
      platform,
      platformUserId,
      displayName: 'Ada Operator',
      roles: ['operator'],
    })

    expect(result.workspaceId).toBe(workspaceId)
    await expect(resolvePrincipal(pool, workspaceId, platform, platformUserId)).resolves.toBe(
      result.principalId,
    )
  })

  it('is idempotent: running it twice returns the same principal id and creates only one row', async () => {
    const platform = 'test'
    const workspaceId = await resolveWorkspaceId(pool, platform, `T_${randomUUID()}`)
    const platformUserId = `U_${randomUUID()}`

    const first = await runPrincipalsAdd(pool, {
      platform,
      platformUserId,
      displayName: 'Ada Operator',
      roles: ['operator'],
      workspaceId,
    })
    const second = await runPrincipalsAdd(pool, {
      platform,
      platformUserId,
      displayName: 'A Different Name The Second Call Must Not Apply',
      roles: ['operator'],
      workspaceId,
    })

    expect(second.principalId).toBe(first.principalId)

    const { rows } = await pool.query<{ count: string; display_name: string }>(
      `SELECT count(*)::int AS count, max(display_name) AS display_name FROM principals ` +
        `WHERE workspace_id = $1 AND platform = $2 AND platform_user_id = $3`,
      [workspaceId, platform, platformUserId],
    )
    expect(Number(rows[0]?.count)).toBe(1)
    // provisionPrincipal's own documented behaviour: the second call's
    // displayName is silently ignored, not applied over the first.
    expect(rows[0]?.display_name).toBe('Ada Operator')
  })

  it('refuses cleanly against a platform with no workspace yet, rather than creating one', async () => {
    const platform = `nonexistent-${randomUUID()}`

    await expect(
      runPrincipalsAdd(pool, {
        platform,
        platformUserId: `U_${randomUUID()}`,
        displayName: 'Ada Operator',
        roles: ['operator'],
      }),
    ).rejects.toThrow(PrincipalsAddError)

    const { rows } = await pool.query('SELECT 1 FROM workspaces WHERE platform = $1', [platform])
    expect(rows).toHaveLength(0)
  })

  it('refuses cleanly, asking for --workspace-id, when more than one workspace exists for the platform', async () => {
    const platform = `multi-${randomUUID()}`
    await resolveWorkspaceId(pool, platform, `T_${randomUUID()}`)
    await resolveWorkspaceId(pool, platform, `T_${randomUUID()}`)

    await expect(
      runPrincipalsAdd(pool, {
        platform,
        platformUserId: `U_${randomUUID()}`,
        displayName: 'Ada Operator',
        roles: ['operator'],
      }),
    ).rejects.toThrow(/Multiple workspaces found/)
  })

  it('an explicit workspaceId bypasses the platform lookup entirely', async () => {
    const platform = 'test'
    const workspaceId = await resolveWorkspaceId(pool, platform, `T_${randomUUID()}`)
    const platformUserId = `U_${randomUUID()}`

    const result = await runPrincipalsAdd(pool, {
      platform,
      platformUserId,
      displayName: 'Ada Operator',
      roles: ['operator'],
      workspaceId,
    })

    expect(result.workspaceId).toBe(workspaceId)
  })
})
