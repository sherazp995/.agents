import pg from 'pg'

const { Client } = pg

/**
 * The naming, maintenance-connection, and create/drop primitives shared by
 * test/support/database.ts (the per-test helper, imported from test files
 * running inside a Vitest worker) and test/support/global-setup.ts (the
 * globalSetup module, which runs in a separate context that cannot import
 * the "vitest" package itself: doing so throws "Vitest failed to access
 * its internal state" because globalSetup has no worker to attach to).
 * This module imports only "pg" and Node builtins so both callers can
 * share it safely.
 */

const NAME_PREFIX = 'relay_r'

/** Matches every database name this module can produce, across every run
 *  and worker. Used to find databases to sweep or drop; never itself used
 *  to build a connection string. */
export const TEST_DATABASE_NAME_PATTERN = /^relay_r(\d+)_w\d+_test$/

/** The name a given run and worker's database has. Ends in `_test` so it
 *  satisfies the existing assertTestDatabase guards in the test files that
 *  drop and recreate a schema. */
export function buildDatabaseName(runId: string, workerId: string): string {
  return `${NAME_PREFIX}${runId}_w${workerId}_test`
}

/**
 * Connects to Postgres's `relay` maintenance database, using the same
 * host, port, and credentials as the given RELAY_TEST_DATABASE_URL value.
 * CREATE DATABASE and DROP DATABASE cannot run inside a transaction and
 * cannot target the database the connection itself is using, so every
 * create/drop goes through this URL rather than a per-worker `_test` one.
 *
 * Takes the raw URL as a parameter rather than reading
 * process.env.RELAY_TEST_DATABASE_URL itself, because the two callers see
 * different values there: test/support/database.ts runs inside a Vitest
 * worker, where vitest.config.ts's `test.env` (including its local
 * default) has already been written into process.env; test/support/
 * global-setup.ts runs in the main process before that happens, so it
 * reads the same already-defaulted value from GlobalSetupContext's
 * resolved config instead and passes it in here.
 *
 * Returns undefined, rather than throwing, when the value is absent or is
 * not a valid URL, so callers each choose how loudly to fail: the
 * describeDb guards already in the test files fail a named test when the
 * var is absent, and must keep doing that rather than have this function
 * throw first and pre-empt that message.
 */
export function maintenanceConnectionUrl(rawDatabaseUrl: string | undefined): string | undefined {
  if (!rawDatabaseUrl) return undefined
  try {
    const url = new URL(rawDatabaseUrl)
    url.pathname = '/relay'
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * CREATE DATABASE and DROP DATABASE cannot be parameterized, so every
 * caller that interpolates a database name into DDL goes through this
 * guard first. Our generated names are always
 * `relay_r<digits>_w<digits>_test`, so this rejects anything else before
 * it can reach raw SQL.
 */
export function quoteDatabaseIdentifier(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to use "${name}" as a SQL identifier: unexpected characters.`)
  }
  return `"${name}"`
}

/**
 * Creates the named database if it does not already exist. Idempotent: a
 * second caller's "database already exists" (Postgres error 42P04) is
 * swallowed rather than treated as a failure, since several test files
 * sharing one worker will all call this for the same worker database.
 */
export async function createDatabaseIfMissing(maintenanceUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE ${quoteDatabaseIdentifier(name)}`)
  } catch (error) {
    if (!isDuplicateDatabaseError(error)) throw error
  } finally {
    await client.end()
  }
}

function isDuplicateDatabaseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '42P04'
  )
}
