import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
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
              'Workspace provisioning tests must fail, not silently skip, when it is absent.',
          )
        })
      })

/** Mirrors the same guard in test/db/migrate.test.ts: never run against a database whose name does not mark it as disposable. */
function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run workspace provisioning tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describeDb('resolveWorkspaceId', () => {
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

  async function countWorkspaces(platform: string, platformTeamId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM workspaces WHERE platform = $1 AND platform_team_id = $2',
      [platform, platformTeamId],
    )
    return Number(rows[0]?.count ?? '0')
  }

  it('provisions a workspace on first sight and returns a value that parses as a uuid', async () => {
    const platformTeamId = `T_FIRST_SIGHT_${randomUUID()}`

    const id = await resolveWorkspaceId(pool, 'slack', platformTeamId)

    expect(id).toMatch(UUID_PATTERN)
    expect(await countWorkspaces('slack', platformTeamId)).toBe(1)
  })

  it('maps the same team id to the same uuid across separate calls, rather than provisioning again', async () => {
    const platformTeamId = `T_REPEAT_${randomUUID()}`

    const first = await resolveWorkspaceId(pool, 'slack', platformTeamId)
    const second = await resolveWorkspaceId(pool, 'slack', platformTeamId)
    const third = await resolveWorkspaceId(pool, 'slack', platformTeamId)

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(await countWorkspaces('slack', platformTeamId)).toBe(1)
  })

  it('scopes provisioning by platform: the same team id string under two platforms resolves to two different workspaces', async () => {
    const sharedTeamId = `T_SHARED_${randomUUID()}`

    const slackId = await resolveWorkspaceId(pool, 'slack', sharedTeamId)
    const otherId = await resolveWorkspaceId(pool, 'other-platform', sharedTeamId)

    expect(slackId).not.toBe(otherId)
  })

  /**
   * The property most likely to be wrong, per the Task 1 brief: a check
   * then insert has a race, so two genuinely concurrent first sights of the
   * same (platform, platformTeamId) pair must still produce exactly one
   * workspaces row, not two, and both callers must agree on which uuid it
   * is. Promise.all starts both calls before either has a chance to
   * complete, so this is a real race against the database, not two
   * sequential calls that merely look concurrent.
   */
  it('produces exactly one workspace row when two calls race to provision the same team id concurrently', async () => {
    const platformTeamId = `T_CONCURRENT_${randomUUID()}`

    const [first, second] = await Promise.all([
      resolveWorkspaceId(pool, 'slack', platformTeamId),
      resolveWorkspaceId(pool, 'slack', platformTeamId),
    ])

    expect(first).toBe(second)
    expect(first).toMatch(UUID_PATTERN)
    expect(await countWorkspaces('slack', platformTeamId)).toBe(1)
  })

  it('produces exactly one workspace row under a wider concurrent race (ten callers, one first sight)', async () => {
    const platformTeamId = `T_CONCURRENT_WIDE_${randomUUID()}`

    const results = await Promise.all(
      Array.from({ length: 10 }, () => resolveWorkspaceId(pool, 'slack', platformTeamId)),
    )

    expect(new Set(results).size).toBe(1)
    expect(await countWorkspaces('slack', platformTeamId)).toBe(1)
  })
})
