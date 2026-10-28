import { inject } from 'vitest'
import {
  buildDatabaseName,
  createDatabaseIfMissing,
  maintenanceConnectionUrl,
} from './database-naming.js'

declare module 'vitest' {
  export interface ProvidedContext {
    relayTestRunId: string
  }
}

/**
 * Every database test asks this module for its connection URL instead of
 * reading RELAY_TEST_DATABASE_URL directly or hardcoding relay_test. Each
 * Vitest worker gets its own database, named from this run's process id
 * (the relayTestRunId that test/support/global-setup.ts injects) plus this
 * worker's VITEST_WORKER_ID. That closes two hazards:
 *
 *   - Vitest's default file parallelism can no longer let one file's
 *     `DROP SCHEMA public CASCADE` land under a different file's rows: two
 *     files in different workers are in different databases, and files
 *     sharing one worker always run one at a time.
 *   - two concurrent `pnpm test` invocations, from two agents in two
 *     worktrees, never collide either, because their process ids differ.
 *
 * Confirmed against Vitest 2.1.8's own source
 * (node_modules/vitest/dist/worker.js): `execute()` sets
 * `process.env.VITEST_WORKER_ID = String(ctx.workerId)` before running any
 * test in that worker, and ctx.workerId is the pool's stable per-worker
 * slot id, unchanged across every file that worker goes on to run. This
 * was also confirmed empirically by printing process.env from inside a
 * test file during two concurrent `pnpm test` runs; see the task report.
 */

function workerId(): string {
  const id = process.env.VITEST_WORKER_ID
  if (!id) {
    throw new Error(
      'VITEST_WORKER_ID is not set. test/support/database.ts computes a database name per ' +
        'worker from this variable, so it must run inside an actual Vitest worker.',
    )
  }
  return id
}

function runId(): string {
  const id = inject('relayTestRunId')
  if (!id) {
    throw new Error(
      'relayTestRunId was not provided by globalSetup. test/support/global-setup.ts must be ' +
        'registered as vitest.config.ts\'s globalSetup for database tests to run.',
    )
  }
  return id
}

/**
 * Ensures this worker's database exists and returns its connection URL.
 * Safe to call once per test file even though several files share a
 * worker: database creation itself is idempotent (see
 * database-naming.ts's createDatabaseIfMissing).
 */
export async function getTestDatabaseUrl(): Promise<string> {
  const maintenanceUrl = maintenanceConnectionUrl(process.env.RELAY_TEST_DATABASE_URL)
  if (!maintenanceUrl) {
    throw new Error(
      'RELAY_TEST_DATABASE_URL is not set or is not a valid URL. vitest.config.ts sets a ' +
        'local default; this only fires when that default has been explicitly overridden. ' +
        'Database tests must fail, not silently skip, when it is unusable.',
    )
  }

  const name = buildDatabaseName(runId(), workerId())
  await createDatabaseIfMissing(maintenanceUrl, name)

  const url = new URL(process.env.RELAY_TEST_DATABASE_URL as string)
  url.pathname = `/${name}`
  return url.toString()
}
