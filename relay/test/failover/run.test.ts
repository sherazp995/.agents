import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations, newestMigrationName } from '../../src/db/migrate.js'
import { claimLease, registerHost } from '../../src/failover/lease.js'
import { FailoverRunner, type StepDownHooks } from '../../src/failover/run.js'
import { createLogger } from '../../src/obs/logger.js'
import { startWithFailover } from '../../scripts/relay-orchestrator.js'
import { getTestDatabaseUrl } from '../support/database.js'

const BUILD = newestMigrationName('src/db/migrations')
const POLL_MS = 15_000
const RENEW_MS = 14_000

describe('failover runner', () => {
  let pool: Pool
  let now: number
  let polls: number
  const runners: FailoverRunner[] = []

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  beforeEach(async () => {
    now = 1_000_000
    polls = 0
    await pool.query('UPDATE failover_lease SET holder = NULL, renewed_at = NULL, expires_at = NULL')
    await pool.query('DELETE FROM failover_hosts')
  })

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((runner) => runner.stop()))
  })

  /** The renew loop stays parked so each test renews by hand; standby and drain polls pass at once. */
  function runner(name: string, preferred: boolean, buildMigration = BUILD): FailoverRunner {
    const created = new FailoverRunner({
      pool,
      log: createLogger('fatal'),
      name,
      home: `/Users/${name}`,
      buildMigration,
      preferred,
      timings: { pollMs: POLL_MS, renewMs: RENEW_MS },
      now: () => now,
      sleep: (ms) => {
        if (ms === RENEW_MS) return new Promise(() => {})
        polls += 1
        return new Promise((resolve) => setImmediate(resolve))
      },
    })
    runners.push(created)
    return created
  }

  function hooks(busyRounds = 0): StepDownHooks & { calls: string[] } {
    const calls: string[] = []
    let rounds = busyRounds
    return {
      calls,
      closeSlack: async () => void calls.push('closeSlack'),
      busy: () => rounds-- > 0,
      exit: (code) => void calls.push(`exit ${code}`),
    }
  }

  async function holder(): Promise<string | null> {
    const { rows } = await pool.query<{ holder: string | null }>('SELECT holder FROM failover_lease')
    return rows[0]?.holder ?? null
  }

  it('stops trusting its claim after 40 seconds of its own clock without a renewal', async () => {
    const zubair = runner('zubair', false)
    await zubair.register()
    expect(await zubair.waitForClaim()).toBe(true)
    expect(await zubair.mayStartWork()).toBe(true)

    now += 40_000
    expect(zubair.holdsFresh()).toBe(true)
    now += 1
    expect(zubair.holdsFresh()).toBe(false)
    expect(await zubair.mayStartWork()).toBe(false)
    // The record itself still runs on database time.
    expect(await holder()).toBe('zubair')
  })

  it('refuses work once the generation in the database is no longer its own', async () => {
    const zubair = runner('zubair', false)
    await zubair.register()
    await zubair.waitForClaim()
    await pool.query('UPDATE failover_lease SET generation = generation + 1')
    expect(zubair.holdsFresh()).toBe(true)
    expect(await zubair.mayStartWork()).toBe(false)
  })

  it('releases on the renewal that sees the hand back flag, and the preferred laptop then claims', async () => {
    const zubair = runner('zubair', false)
    const hassan = runner('hassan', true)
    await zubair.register()
    await hassan.register()
    await zubair.waitForClaim()
    const zubairHooks = hooks()
    zubair.attach(zubairHooks)

    expect(await hassan.tryClaim()).toBe(false)
    await zubair.renew()
    await zubair.steppedDown()

    expect(zubair.holdsFresh()).toBe(false)
    expect(zubairHooks.calls).toEqual(['closeSlack', 'exit 1'])
    expect(await hassan.tryClaim()).toBe(true)
    expect(await holder()).toBe('hassan')
  })

  it('steps down once, keeps waiting while work runs, then exits with code 1', async () => {
    const zubair = runner('zubair', false)
    await zubair.register()
    await zubair.waitForClaim()
    const zubairHooks = hooks(3)
    zubair.attach(zubairHooks)

    zubair.stepDown('lost')
    zubair.stepDown('lost again')
    await zubair.steppedDown()

    expect(polls).toBe(3)
    expect(zubairHooks.calls).toEqual(['closeSlack', 'exit 1'])
    expect(await holder()).toBeNull()
  })

  it('an older build stays on standby and neither claims nor asks for the record back', async () => {
    const hassan = runner('hassan', true, '0029_task_read_only.sql')
    await hassan.register()
    expect(await hassan.tryClaim()).toBe(false)
    expect(await holder()).toBeNull()
    const { rows } = await pool.query<{ wants_back_at: Date | null }>("SELECT wants_back_at FROM failover_hosts WHERE name = 'hassan'")
    expect(rows[0]?.wants_back_at).toBeNull()
  })

  it('a waiting laptop never starts the orchestrator', async () => {
    await registerHost(pool, { name: 'hassan', home: '/Users/hassan', buildMigration: BUILD, preferred: true })
    await claimLease(pool, 'hassan')
    const zubair = runner('zubair', false)
    const start = vi.fn(async () => 'started')
    const migrateAsHolder = vi.fn(async () => {})

    const pending = startWithFailover({ gate: zubair, tablesExist: async () => true, migrateAll: async () => {}, migrateAsHolder, start })
    await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(2))
    await zubair.stop()

    expect(await pending).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
    expect(migrateAsHolder).not.toHaveBeenCalled()
  })

  it('a laptop that claims migrates and then starts', async () => {
    const zubair = runner('zubair', false)
    const order: string[] = []
    const started = await startWithFailover({
      gate: zubair,
      tablesExist: async () => false,
      migrateAll: async () => void order.push('migrateAll'),
      migrateAsHolder: async () => void order.push('migrateAsHolder'),
      start: async () => {
        order.push('start')
        return 'handle'
      },
    })
    expect(started).toBe('handle')
    expect(order).toEqual(['migrateAll', 'migrateAsHolder', 'start'])
  })
})
