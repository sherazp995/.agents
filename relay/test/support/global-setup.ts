import pg from 'pg'
import type { GlobalSetupContext } from 'vitest/node'
import {
  maintenanceConnectionUrl,
  quoteDatabaseIdentifier,
  TEST_DATABASE_NAME_PATTERN,
} from './database-naming.js'
import { isProcessAlive } from './process-alive.js'

const { Client } = pg

/**
 * Registered as vitest.config.ts's globalSetup. Runs once per `pnpm test`
 * invocation in the main process: once before Vitest spawns any worker,
 * and once more (the function it returns) after every worker has finished.
 *
 * It does not create the per-worker databases itself. At the point this
 * function runs, Vitest has not yet decided how many workers it will
 * spawn, so there is nothing to create ahead of time; test/support/
 * database.ts creates each worker's database lazily, the first time a test
 * file in that worker asks for a connection URL. What only globalSetup can
 * do, since it alone spans the whole run, is:
 *
 *   - hand every worker this run's process id (relayTestRunId), so every
 *     worker computes database names that are unique to this invocation
 *   - sweep, at startup, any database a previous run left behind because
 *     it crashed before its own teardown could run
 *   - drop, at the end, every database this run created
 */
export default async function setup({
  provide,
  config,
}: GlobalSetupContext): Promise<() => Promise<void>> {
  const runId = String(process.pid)
  provide('relayTestRunId', runId)

  // globalSetup runs in the main process, before Vitest writes test.env
  // (vitest.config.ts's local default among them) into process.env for
  // any worker. That write only ever happens inside a worker, so reading
  // process.env.RELAY_TEST_DATABASE_URL here would silently miss the
  // default a fresh clone relies on. The resolved config carries the same
  // already-defaulted value instead; process.env is kept only as a
  // fallback for a caller that exported the var directly.
  const rawDatabaseUrl: string | undefined =
    (config.env as Record<string, string | undefined>)['RELAY_TEST_DATABASE_URL'] ??
    process.env.RELAY_TEST_DATABASE_URL

  const maintenanceUrl = maintenanceConnectionUrl(rawDatabaseUrl)
  if (maintenanceUrl) {
    await sweepStaleDatabases(maintenanceUrl)
  }

  return async () => {
    if (!maintenanceUrl) return
    await dropRunDatabases(maintenanceUrl, runId)
  }
}

/**
 * Drops any database matching the naming pattern whose encoded process id
 * is not a currently running process on this machine. That can only be
 * true for a database whose owning run's teardown never reached it, i.e. a
 * crash: a live concurrent `pnpm test` invocation's process is still
 * running, so this check correctly leaves it alone.
 */
async function sweepStaleDatabases(maintenanceUrl: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ datname: string }>('SELECT datname FROM pg_database')
    for (const { datname } of rows) {
      const match = TEST_DATABASE_NAME_PATTERN.exec(datname)
      if (!match) continue
      const pid = Number(match[1])
      if (isProcessAlive(pid)) continue
      await dropWithRetry(client, datname)
    }
  } finally {
    await client.end()
  }
}

/** Drops every database this run created, identified by this run's own process id. */
async function dropRunDatabases(maintenanceUrl: string, runId: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ datname: string }>('SELECT datname FROM pg_database')
    const ownDatabases = rows
      .map((row) => row.datname)
      .filter((name) => TEST_DATABASE_NAME_PATTERN.exec(name)?.[1] === runId)
    for (const name of ownDatabases) await dropWithRetry(client, name)
  } finally {
    await client.end()
  }
}

/**
 * FORCE cannot end a backend our non-superuser role has no rights over, such
 * as an autovacuum worker that just started on the freshly written database
 * (42501). It finishes in moments, so the drop is retried; one that still
 * fails is left to the next run's sweep rather than failing a green run.
 */
async function dropWithRetry(client: pg.Client, name: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(name)} WITH (FORCE)`)
      return
    } catch (error) {
      if ((error as { code?: string }).code !== '42501') throw error
      if (attempt === 5) {
        console.warn(`could not drop test database ${name} yet; the next run's sweep removes it`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}
