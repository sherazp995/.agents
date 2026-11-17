import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { checkFailover, newestMigration } from '../../../src/doctor/checks/failover.js'
import type { CheckContext } from '../../../src/doctor/registry.js'
import { applyMigrations } from '../../../src/db/migrate.js'
import { closePool, createPool } from '../../../src/db/pool.js'
import { getTestDatabaseUrl } from '../../support/database.js'

const MIGRATIONS = 'src/db/migrations'

function context(databaseUrl: string, failover?: { host: string; preferred: boolean }): CheckContext {
  return { config: { database: { url: databaseUrl }, ...(failover ? { failover } : {}) } } as unknown as CheckContext
}

describe('failover doctor check', () => {
  let databaseUrl: string
  let pool: Pool

  beforeAll(async () => {
    databaseUrl = await getTestDatabaseUrl()
    pool = createPool(databaseUrl)
    await applyMigrations(pool, MIGRATIONS)
  })

  beforeEach(async () => {
    await pool.query('UPDATE failover_lease SET holder = NULL, renewed_at = NULL, expires_at = NULL')
    await pool.query('DELETE FROM failover_hosts')
    await pool.query(
      `INSERT INTO failover_hosts (name, home, build_migration, preferred) VALUES
         ('hassan-mbp', '/Users/hassan', $1, true), ('sara-mbp', '/Users/sara', $1, false)`,
      [newestMigration(MIGRATIONS)],
    )
    await pool.query(
      `UPDATE failover_lease SET holder = 'hassan-mbp', generation = generation + 1,
         renewed_at = now() - interval '5 seconds', expires_at = now() + interval '55 seconds'`,
    )
  })

  afterAll(async () => {
    await pool.query('UPDATE failover_lease SET holder = NULL, renewed_at = NULL, expires_at = NULL')
    await pool.query('DELETE FROM failover_hosts')
    await closePool(pool)
  })

  it('reports off when config has no failover block', async () => {
    const result = await checkFailover().run(context(databaseUrl))

    expect(result).toEqual({ name: 'failover', status: 'ok', detail: 'off: this laptop answers alone' })
  })

  it('names the laptop holding the record, its renewal in database time, and this laptop', async () => {
    const result = await checkFailover({ buildMigration: newestMigration(MIGRATIONS) }).run(context(databaseUrl, { host: 'sara-mbp', preferred: false }))

    expect(result.status).toBe('ok')
    expect(result.detail).toMatch(/^hassan-mbp answers, renewed [56]s ago \(database time\); this laptop is sara-mbp, not preferred/)
  })

  it('fails when this build is older than the database', async () => {
    const result = await checkFailover({ buildMigration: '0029_task_read_only.sql' }).run(context(databaseUrl, { host: 'sara-mbp', preferred: false }))

    expect(result.status).toBe('failed')
    expect(result.detail).toContain('this laptop will not answer')
  })

  it('warns when the other laptop runs a build older than the database', async () => {
    await pool.query(`UPDATE failover_hosts SET build_migration = '0029_task_read_only.sql' WHERE name = 'sara-mbp'`)

    const result = await checkFailover({ buildMigration: newestMigration(MIGRATIONS) }).run(context(databaseUrl, { host: 'hassan-mbp', preferred: true }))

    expect(result.status).toBe('degraded')
    expect(result.detail).toContain('sara-mbp runs a build at 0029_task_read_only.sql')
  })
})
