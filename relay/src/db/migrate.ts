import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import type { Logger } from '../obs/logger.js'

/**
 * Fixed advisory lock key that all callers of applyMigrations agree on for a
 * given database. The value is arbitrary; what matters is that it never
 * changes, so unrelated processes racing to migrate the same database
 * serialize against each other rather than colliding. Exported so tests can
 * take the lock from a second connection without duplicating the constant.
 */
export const MIGRATION_LOCK_KEY = 891_204_733

/**
 * Default bound on how long applyMigrations waits to acquire the advisory
 * lock before giving up. Every other wait in this milestone is bounded; an
 * unbounded `pg_advisory_lock` would let a stuck migrator hang startup
 * forever. Overridable per call so tests can use a short bound instead of
 * waiting thirty seconds for a timeout to prove.
 */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30_000

const LOCK_POLL_INTERVAL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Acquires the migration advisory lock, polling with `pg_try_advisory_lock`
 * instead of blocking on `pg_advisory_lock`, so a stuck holder produces a
 * timeout error rather than an indefinite hang.
 */
async function acquireMigrationLock(client: PoolClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [MIGRATION_LOCK_KEY],
    )
    if (rows[0]?.acquired) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the migration advisory lock. ` +
          'Another process may be migrating this database, or a previous run crashed while holding it.',
      )
    }
    await sleep(Math.min(LOCK_POLL_INTERVAL_MS, remaining))
  }
}

/**
 * Applies pending SQL migrations in filename order.
 *
 * Concurrent callers are serialized with a Postgres session-level advisory
 * lock held for the whole call, so two processes racing to migrate the same
 * database do not both try to create the same objects. The lock is acquired
 * before the pending set is computed and released in a finally block; a
 * caller that had to wait re-reads schema_migrations after acquiring the
 * lock, so it correctly sees work a concurrent caller already finished and
 * returns an empty array instead of failing.
 *
 * Each migration runs inside its own transaction together with its
 * bookkeeping row, so a failure leaves neither a half-applied schema nor a
 * false record of success. That guarantee only holds if the migration file
 * does not manage its own transaction, so a file containing its own BEGIN,
 * COMMIT, or ROLLBACK is rejected before it runs rather than silently
 * breaking out of the runner's transaction. If rolling back after a failure
 * itself throws, for example because the connection is already broken, that
 * secondary error is discarded so it never masks the original failure.
 *
 * Returns the migrations applied by this call. An empty array means the
 * schema was already current, whether because nothing was pending or
 * because a concurrent caller applied everything first.
 *
 * `options.log`, when supplied, receives one line naming each migration as
 * it applies, per FR-OBS-1. It is optional and unused by default: a caller
 * that omits it gets exactly the previous behaviour, no default logger is
 * created here, and nothing is written to stdout on its behalf.
 */
export async function applyMigrations(
  pool: Pool,
  directory: string,
  options: { lockTimeoutMs?: number; log?: Logger } = {},
): Promise<string[]> {
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS
  const client = await pool.connect()
  try {
    await acquireMigrationLock(client, lockTimeoutMs)
    try {
      return await applyMigrationsHoldingLock(client, directory, options.log)
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      } catch {
        // Mirrors the ROLLBACK guard below: the connection may already be
        // broken, in which case the unlock itself throws. Discard that
        // secondary error so a failing migration propagates its own error
        // rather than being masked by a failed unlock.
      }
    }
  } finally {
    client.release()
  }
}

async function applyMigrationsHoldingLock(
  client: PoolClient,
  directory: string,
  log?: Logger,
): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  // Re-read now that the lock is held: a concurrent caller may have applied
  // migrations while this call was waiting for the lock.
  const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
  const applied = new Set(rows.map((row) => row.name))

  const pending = selectPendingMigrations(readdirSync(directory), applied)

  const run: string[] = []
  for (const name of pending) {
    const sql = readFileSync(join(directory, name), 'utf8')
    assertNoOwnTransactionControl(name, sql)
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
      await client.query('COMMIT')
      run.push(name)
      log?.info({ migration: name }, `applied migration ${name}`)
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The connection may already be broken, in which case ROLLBACK
        // itself throws. Discard that secondary error so the caller sees
        // the original failure below, not a rollback failure that hides it.
      }
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`)
    }
  }
  return run
}

/**
 * Selects the migrations still to apply, in the order they must run.
 *
 * A pure function over its two inputs rather than reading the directory or
 * the database itself, so migration ordering and already applied filtering
 * can be unit tested directly with an array literal instead of through a
 * real filesystem, whose directory enumeration order is not guaranteed to
 * expose a missing sort the way a hand built unsorted array reliably does.
 *
 * Filters to `.sql` files, sorts by filename so migrations run in a fixed
 * and predictable order regardless of directory enumeration order, then
 * removes names already recorded in schema_migrations.
 */
export function selectPendingMigrations(
  fileNames: readonly string[],
  applied: ReadonlySet<string>,
): string[] {
  return fileNames
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !applied.has(name))
}

/**
 * Rejects a migration file that contains its own transaction control
 * statement. Migrations run inside a transaction owned by the runner, so a
 * migration that issues its own BEGIN, COMMIT, or ROLLBACK would commit or
 * abort early and break the all or nothing guarantee described above.
 *
 * The match is deliberately conservative: it flags the keyword anywhere in
 * the file, including inside a comment or a string literal, because
 * reliably telling those apart from a real statement would need a full SQL
 * parser rather than a regular expression. A migration that legitimately
 * needs the word in a comment should reword the comment.
 */
function assertNoOwnTransactionControl(name: string, sql: string): void {
  const match = /\b(BEGIN|COMMIT|ROLLBACK)\b/i.exec(sql)
  if (!match) return
  const keyword = (match[1] ?? match[0]).toUpperCase()
  throw new Error(
    `Migration ${name} contains its own ${keyword} statement. Migrations run ` +
      'inside a transaction managed by the runner and must not begin, commit, ' +
      'or roll back their own.',
  )
}
