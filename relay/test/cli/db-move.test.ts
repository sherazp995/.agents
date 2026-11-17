import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runDbMove, type DbResult } from '../../src/cli/db.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { daemonPidFilePath } from '../../src/secrets/keychain.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'
import { maintenanceConnectionUrl, quoteDatabaseIdentifier } from '../support/database-naming.js'

const MIGRATIONS = 'src/db/migrations'

/** A fresh database next to this worker's, so no other test file's connection is open to it (the move refuses those). */
async function freshDatabase(suffix: string): Promise<string> {
  const workerUrl = new URL(await getTestDatabaseUrl())
  const name = `${workerUrl.pathname.slice(1).replace(/_test$/, '')}_${suffix}_test`
  const admin = new pg.Client({ connectionString: maintenanceConnectionUrl(process.env.RELAY_TEST_DATABASE_URL) })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(name)} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${quoteDatabaseIdentifier(name)}`)
  } finally {
    await admin.end()
  }
  workerUrl.pathname = `/${name}`
  return workerUrl.toString()
}

async function dropDatabase(url: string): Promise<void> {
  const admin = new pg.Client({ connectionString: maintenanceConnectionUrl(process.env.RELAY_TEST_DATABASE_URL) })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(new URL(url).pathname.slice(1))} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}

/** Every row of every Relay table as text, so a lost microsecond or byte shows as a difference. */
async function snapshot(url: string): Promise<Record<string, string[]>> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(`SET TimeZone = 'UTC'`)
    const tables = await client.query<{ name: string }>(
      `SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations'`,
    )
    const result: Record<string, string[]> = {}
    for (const { name } of tables.rows) {
      const rows = await client.query<{ row: string }>(`SELECT t::text AS row FROM public.${client.escapeIdentifier(name)} t ORDER BY 1`)
      result[name] = rows.rows.map((row) => row.row)
    }
    return result
  } finally {
    await client.end()
  }
}

function writeConfig(databaseUrl: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'relay-db-move-')), 'relay.config.yaml')
  writeFileSync(
    path,
    '# operator comment kept\nmodel_provider:\n  name: anthropic\n  zero_data_retention: true\n' +
      `database:\n  url: ${databaseUrl}\nredis:\n  url: redis://localhost:6379/8\nlogging:\n  level: error\nsecrets:\n  provider: keychain\n`,
  )
  return path
}

describe('runDbMove', () => {
  let sourceUrl: string
  let targetUrl: string
  const stored = new Map<string, string>()
  const storeSecret = async (name: string, value: string): Promise<DbResult> => {
    stored.set(name, value)
    return { report: `Stored ${name}`, exitCode: 0 }
  }
  const relayHome = mkdtempSync(join(tmpdir(), 'relay-db-move-home-'))

  beforeEach(async () => {
    stored.clear()
    sourceUrl = await freshDatabase('movesrc')
    targetUrl = await freshDatabase('movedst')
    const source = createPool(sourceUrl)
    try {
      await applyMigrations(source, MIGRATIONS)
      const workspaceId = await resolveWorkspaceId(source, 'slack', 'T_MOVE')
      await source.query(
        `INSERT INTO failover_hosts (name, home, build_migration, last_seen_at) VALUES ('hassan-mbp', '/Users/hassan', '0030_failover.sql', '2026-11-17 10:00:00.123456+00')`,
      )
      await source.query(`INSERT INTO outbox_files (workspace_id, filename, content) VALUES ($1, 'a.bin', '\\x00ff10'::bytea)`, [workspaceId])
    } finally {
      await closePool(source)
    }
  })

  afterAll(async () => {
    await dropDatabase(sourceUrl)
    await dropDatabase(targetUrl)
  })

  it('copies every row into an empty database, then points config at it through the keystore', async () => {
    const configPath = writeConfig(sourceUrl)
    const before = await snapshot(sourceUrl)

    const result = await runDbMove({ configPath, targetUrl, migrationsDir: MIGRATIONS }, { relayHome, storeSecret })

    expect(result.exitCode, result.report).toBe(0)
    expect(await snapshot(targetUrl)).toEqual(before)
    expect(before.workspaces).toHaveLength(1)
    expect(result.report).toContain('outbox_files: 1 rows')
    expect(result.report).not.toContain(targetUrl)
    expect(stored).toEqual(new Map([['relay-database-local-url', sourceUrl], ['relay-database-url', targetUrl]]))
    const config = readFileSync(configPath, 'utf8')
    expect(config).toContain('url: keystore:relay-database-url')
    expect(config).toContain('# operator comment kept')
  })

  it('leaves config and the database URL item alone when storing the new URL fails', async () => {
    const configPath = writeConfig(sourceUrl)
    const failingStore = async (name: string, value: string): Promise<DbResult> =>
      name === 'relay-database-url' ? { report: 'keychain locked', exitCode: 1 } : storeSecret(name, value)

    const result = await runDbMove({ configPath, targetUrl, migrationsDir: MIGRATIONS }, { relayHome, storeSecret: failingStore })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('Relay still uses the local database')
    expect(stored).toEqual(new Map([['relay-database-local-url', sourceUrl]]))
    expect(readFileSync(configPath, 'utf8')).not.toContain('keystore:relay-database-url')
  })

  it('refuses while the daemon runs, and when the local database has a migration this checkout does not know', async () => {
    const configPath = writeConfig(sourceUrl)
    const home = mkdtempSync(join(tmpdir(), 'relay-db-move-running-'))
    // This test process stands in for a live daemon.
    mkdirSync(dirname(daemonPidFilePath(home)), { recursive: true })
    writeFileSync(daemonPidFilePath(home), `${process.pid}\n`)
    const running = await runDbMove({ configPath, targetUrl, migrationsDir: MIGRATIONS }, { relayHome: home, storeSecret })
    expect(running.exitCode).toBe(1)
    expect(running.report).toContain(`daemon is running (pid ${process.pid})`)

    const source = createPool(sourceUrl)
    try {
      await source.query(`INSERT INTO schema_migrations (name) VALUES ('9999_from_a_newer_relay.sql')`)
    } finally {
      await closePool(source)
    }
    const newer = await runDbMove({ configPath, targetUrl, migrationsDir: MIGRATIONS }, { relayHome, storeSecret })
    expect(newer.exitCode).toBe(1)
    expect(newer.report).toContain('9999_from_a_newer_relay.sql')

    expect(stored.size).toBe(0)
    expect(readFileSync(configPath, 'utf8')).not.toContain('keystore:relay-database-url')
  })

  it('refuses a target that already has Relay rows and leaves config and keystore untouched', async () => {
    const target = createPool(targetUrl)
    try {
      await applyMigrations(target, MIGRATIONS)
      await resolveWorkspaceId(target, 'slack', 'T_ALREADY_THERE')
    } finally {
      await closePool(target)
    }
    const configPath = writeConfig(sourceUrl)
    const configBefore = readFileSync(configPath, 'utf8')

    const result = await runDbMove({ configPath, targetUrl, migrationsDir: MIGRATIONS }, { relayHome, storeSecret })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('already has Relay rows (workspaces)')
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore)
    expect(stored.size).toBe(0)
  })
})
