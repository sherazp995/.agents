import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations, MIGRATION_LOCK_KEY, selectPendingMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/obs/logger.js'
import { getTestDatabaseUrl } from '../support/database.js'
import type { Pool } from 'pg'

function captureLines(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  return {
    stream,
    lines: () => chunks.join('').split('\n').filter((line) => line.trim().length > 0),
  }
}

const url = process.env.RELAY_TEST_DATABASE_URL

/**
 * A small fixture directory with known filenames, used only by the
 * discovery ordering test below. Kept separate from src/db/migrations so
 * that test can assert an exact returned filename list against a hardcoded
 * literal instead of against readdirSync(directory).filter(...).sort() run
 * a second time, which is the exact discovery logic applyMigrations itself
 * uses: asserting against that logic's own output would let a bug in it go
 * undetected, since both the expectation and the implementation would be
 * wrong the same way.
 */
const DISCOVERY_FIXTURE_DIR = 'test/db/fixtures/discovery'

/**
 * `describeDb` used to fall back to `describe.skip` when the var was unset,
 * so the suite could report a clean pass with the entire database
 * integration surface silently absent. vitest.config.ts now sets a local
 * default for RELAY_TEST_DATABASE_URL, so this only fires when a caller has
 * explicitly overridden it to empty. When that happens, fail a named test
 * loudly instead of skipping, so `pnpm test` cannot report success with this
 * coverage missing.
 */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'Database integration tests must fail, not silently skip, when it is absent.',
          )
        })
      })

/**
 * Refuses to proceed unless the target database's name ends in _test. The
 * migrate test suite drops and recreates the public schema, which must
 * never happen to a dev or production database reached by misconfiguration.
 */
function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop the schema of database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

describe('assertTestDatabase', () => {
  it('refuses a database whose name does not end in _test', () => {
    expect(() => assertTestDatabase('postgres://relay:relay@localhost:5432/relay')).toThrow(
      /relay/,
    )
  })
})

/**
 * Unit tests the pure ordering and filtering function directly, with a hand
 * built unsorted array rather than through a real filesystem. This is what
 * closes the gap the fixture directory integration test above could not:
 * fs.readdirSync's enumeration order is not guaranteed, and on at least one
 * real filesystem (macOS APFS, confirmed empirically) it already returns
 * these filenames in sorted order regardless of write order, so removing
 * the .sort() call there did not fail. An array literal has no such luck:
 * it is only ever in the order this test wrote it in.
 */
describe('selectPendingMigrations', () => {
  it('sorts unsorted filenames into ascending order and drops non .sql entries', () => {
    const fileNames = ['0003_c.sql', '0001_a.sql', '0002_b.sql', 'notes.txt']

    expect(selectPendingMigrations(fileNames, new Set())).toEqual([
      '0001_a.sql',
      '0002_b.sql',
      '0003_c.sql',
    ])
  })

  it('removes names already present in the applied set, after sorting', () => {
    const fileNames = ['0003_c.sql', '0001_a.sql', '0002_b.sql']
    const applied = new Set(['0001_a.sql'])

    expect(selectPendingMigrations(fileNames, applied)).toEqual(['0002_b.sql', '0003_c.sql'])
  })
})

/**
 * Exercises the advisory unlock guard with a scripted fake client rather
 * than a real database, so it can force the unlock query itself to fail (a
 * connection-already-broken scenario that is hard to induce reliably against
 * a real server) and observe that the original migration error still wins.
 * Only the small surface applyMigrations actually calls (`connect`, `query`,
 * `release`) needs to be faked.
 */
describe('applyMigrations advisory unlock guard', () => {
  it('propagates the migration failure, not a secondary unlock failure, per the ROLLBACK guard pattern', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-migrate-unlock-'))
    writeFileSync(join(directory, '0001_boom.sql'), 'CREATE TABLE will_fail_to_apply (id int);\n')

    const fakeClient = {
      query: async (sql: string) => {
        if (sql.startsWith('SELECT pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] }
        }
        if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
          return { rows: [] }
        }
        if (sql.startsWith('SELECT name FROM schema_migrations')) {
          return { rows: [] }
        }
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return { rows: [] }
        }
        if (sql.includes('CREATE TABLE will_fail_to_apply')) {
          throw new Error('simulated migration failure')
        }
        if (sql.startsWith('SELECT pg_advisory_unlock')) {
          throw new Error('simulated unlock failure: connection already broken')
        }
        throw new Error(`unexpected query in fake client: ${sql}`)
      },
      release: () => {},
    }
    const fakePool = { connect: async () => fakeClient } as unknown as Pool

    let caught: Error | undefined
    try {
      await applyMigrations(fakePool, directory)
      throw new Error('expected applyMigrations to reject')
    } catch (error) {
      caught = error as Error
    }
    expect(caught?.message).toMatch(/simulated migration failure/)
    expect(caught?.message).not.toMatch(/simulated unlock failure/)
  })
})

describeDb('applyMigrations', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  it('applies every migration once and is idempotent on a second run', async () => {
    const first = await applyMigrations(pool, 'src/db/migrations')
    expect(first).toContain('0001_init.sql')

    const second = await applyMigrations(pool, 'src/db/migrations')
    expect(second).toEqual([])
  })

  /**
   * Query behind the AP-8 tenancy guard. Exported at module scope, rather
   * than inlined in the test, so the "add a violating table, watch it fail"
   * verification below can run it directly against a table this test
   * created and dropped, without duplicating the SQL.
   *
   * A table is a violation if it lacks a NOT NULL workspace_id column, or
   * lacks a foreign key from that column to workspaces(id). Checking only
   * column existence, as the original guard did, would pass a nullable
   * workspace_id with no foreign key: a column that provides no tenancy
   * guarantee at all.
   */
  const AP8_VIOLATIONS_SQL = `
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND t.table_name NOT IN ('schema_migrations', 'workspaces')
      AND (
        NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name = t.table_name
            AND c.column_name = 'workspace_id'
            AND c.is_nullable = 'NO'
        )
        OR NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
           AND tc.table_schema = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND tc.table_name = t.table_name
            AND kcu.column_name = 'workspace_id'
            AND ccu.table_name = 'workspaces'
        )
      )
  `

  it('gives every domain table a workspace_id that is NOT NULL and foreign-keyed to workspaces, per AP-8', async () => {
    await applyMigrations(pool, 'src/db/migrations')
    const { rows } = await pool.query<{ table_name: string }>(AP8_VIOLATIONS_SQL)
    expect(rows.map((r) => r.table_name)).toEqual([])
  })

  it('the AP-8 guard actually fails for a table with a nullable workspace_id and no foreign key', async () => {
    // Proves the strengthened guard catches what the column-existence-only
    // check would have missed. Creates a violating table, confirms the
    // guard query flags it by name, then drops it so the schema is left as
    // applyMigrations produced it.
    await pool.query(`
      CREATE TABLE ap8_violation_probe (
        id           text PRIMARY KEY,
        workspace_id uuid
      )
    `)
    try {
      const { rows } = await pool.query<{ table_name: string }>(AP8_VIOLATIONS_SQL)
      expect(rows.map((r) => r.table_name)).toEqual(['ap8_violation_probe'])
    } finally {
      await pool.query('DROP TABLE ap8_violation_probe')
    }
  })

  it('rejects a principal whose workspace does not exist', async () => {
    await applyMigrations(pool, 'src/db/migrations')
    await expect(
      pool.query(
        `INSERT INTO principals (id, workspace_id, platform, platform_user_id, display_name, roles)
         VALUES ('prn_x', '00000000-0000-0000-0000-000000000000', 'slack', 'U1', 'Nobody', ARRAY['operator'])`,
      ),
    ).rejects.toThrow(/foreign key/i)
  })

  it('serializes concurrent callers so the loser sees no pending work instead of crashing', async () => {
    // Reproduces the reviewer's empirical finding: two processes racing
    // against a fresh schema used to give one fulfilled result and one
    // rejection on a duplicate key. With the advisory lock in place, exactly
    // one caller applies every pending migration and the other, having
    // acquired the lock after the first released it, finds nothing pending.
    //
    // Points at DISCOVERY_FIXTURE_DIR rather than src/db/migrations so the
    // expected list below is an independent hardcoded literal (see that
    // constant's comment for why). The fixture's three files are written to
    // disk out of alphabetical order (gamma, then alpha, then beta), so a
    // correct result here also proves applyMigrations sorts by filename
    // rather than trusting whatever order the filesystem enumerates.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')

    const [first, second] = await Promise.all([
      applyMigrations(pool, DISCOVERY_FIXTURE_DIR),
      applyMigrations(pool, DISCOVERY_FIXTURE_DIR),
    ])

    const results = [first, second].sort((a, b) => b.length - a.length)
    expect(results[0]).toEqual(['0001_alpha.sql', '0002_beta.sql', '0003_gamma.sql'])
    expect(results[1]).toEqual([])
  })

  it('rejects a migration file that contains its own transaction control statement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-migrate-'))
    writeFileSync(join(directory, '0001_bad.sql'), 'CREATE TABLE bad (id int);\nCOMMIT;\n')

    await expect(applyMigrations(pool, directory)).rejects.toThrow(/0001_bad\.sql/)
    await expect(applyMigrations(pool, directory)).rejects.toThrow(/COMMIT/)
  })

  it('times out rather than hanging when the advisory lock is held by another connection', async () => {
    const holder = await pool.connect()
    await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      const start = Date.now()
      await expect(applyMigrations(pool, 'src/db/migrations', { lockTimeoutMs: 300 })).rejects.toThrow(
        /timed out/i,
      )
      const elapsed = Date.now() - start
      // Bounded: comfortably above the 300ms lock timeout, comfortably
      // below a value that would indicate it fell back to hanging.
      expect(elapsed).toBeGreaterThanOrEqual(290)
      expect(elapsed).toBeLessThan(5000)
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      holder.release()
    }
  }, 15000)

  it('emits a log line naming each applied migration when a logger is supplied', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    const { stream, lines } = captureLines()
    const log = createLogger('info', stream)

    const applied = await applyMigrations(pool, 'src/db/migrations', { log })
    expect(applied).toContain('0001_init.sql')

    // Line count asserted before inspecting content, per the P0.1 finding 14
    // correction: a silent logger must not be able to satisfy this test.
    const emitted = lines()
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.some((line) => line.includes('0001_init.sql'))).toBe(true)
  })

  it('rolls back a migration that fails partway, leaving neither the created object nor the bookkeeping row', async () => {
    // The migration's own DDL and the runner's bookkeeping INSERT are two
    // separate client.query() calls, not one multi-statement string, so
    // Postgres's implicit per-call atomicity cannot paper over a missing
    // explicit BEGIN/COMMIT/ROLLBACK here the way it would for a single
    // query string. A trigger that fails only the bookkeeping INSERT
    // isolates exactly the guarantee this test exists to cover: that the
    // migration's DDL and its bookkeeping row commit or roll back together.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    // Ensures schema_migrations exists before the trigger is attached to it.
    await applyMigrations(pool, 'src/db/migrations')

    const probeName = '0001_rollback_probe.sql'
    await pool.query(`
      CREATE OR REPLACE FUNCTION relay_test_block_one_bookkeeping_row() RETURNS trigger AS $$
      BEGIN
        IF NEW.name = '${probeName}' THEN
          RAISE EXCEPTION 'simulated bookkeeping failure for %', NEW.name;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await pool.query(`
      CREATE TRIGGER relay_test_block_one_bookkeeping_row_trigger
      BEFORE INSERT ON schema_migrations
      FOR EACH ROW EXECUTE FUNCTION relay_test_block_one_bookkeeping_row()
    `)

    try {
      const directory = mkdtempSync(join(tmpdir(), 'relay-migrate-partial-'))
      writeFileSync(join(directory, probeName), 'CREATE TABLE rollback_probe (id int);\n')

      await expect(applyMigrations(pool, directory)).rejects.toThrow(new RegExp(probeName.replace('.', '\\.')))

      const table = await pool.query<{ reg: string | null }>(
        `SELECT to_regclass('public.rollback_probe') AS reg`,
      )
      expect(table.rows[0]?.reg).toBeNull()

      const bookkeeping = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [probeName])
      expect(bookkeeping.rows).toHaveLength(0)
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS relay_test_block_one_bookkeeping_row_trigger ON schema_migrations')
      await pool.query('DROP FUNCTION IF EXISTS relay_test_block_one_bookkeeping_row()')
    }
  })
})
