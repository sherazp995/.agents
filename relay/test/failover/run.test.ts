import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations, newestMigrationName } from '../../src/db/migrate.js'
import { claimLease, registerHost, setPauseRequest } from '../../src/failover/lease.js'
import { FailoverRunner, roundSleep, type FailoverTimings, type RoleHooks } from '../../src/failover/run.js'
import { createLogger } from '../../src/obs/logger.js'
import { getTestDatabaseUrl } from '../support/database.js'

const BUILD = newestMigrationName('src/db/migrations')

describe('failover runner (default laptop role)', () => {
  let pool: Pool
  let now: number
  const runners: FailoverRunner[] = []
  const extraPools: Pool[] = []

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
    await Promise.all(extraPools.splice(0).map((extra) => closePool(extra)))
  })

  beforeEach(async () => {
    now = 1_000_000
    await pool.query('UPDATE failover_lease SET holder = NULL, renewed_at = NULL, expires_at = NULL')
    await pool.query('DELETE FROM failover_hosts')
  })

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((runner) => runner.stop()))
  })

  /** Rounds are driven by hand: the loop's own sleep never resolves. */
  function runner(name: string, preferred: boolean, options: { buildMigration?: string; db?: Pool; timings?: Partial<FailoverTimings> } = {}): FailoverRunner {
    const created = new FailoverRunner({
      pool: options.db ?? pool,
      log: createLogger('fatal'),
      name,
      home: `/Users/${name}`,
      buildMigration: options.buildMigration ?? BUILD,
      preferred,
      reminderChannels: ['C_REM'],
      timings: { queryMs: 1_000, ...options.timings },
      now: () => now,
      sleep: () => new Promise(() => {}),
    })
    runners.push(created)
    return created
  }

  function hooks(): RoleHooks & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      setSlack: async (connected) => void calls.push(connected ? 'slack on' : 'slack off'),
      setPaused: async (paused) => void calls.push(paused ? 'paused' : 'resumed'),
    }
  }

  async function holder(): Promise<string | null> {
    const { rows } = await pool.query<{ holder: string | null }>('SELECT holder FROM failover_lease WHERE expires_at > now()')
    return rows[0]?.holder ?? null
  }

  it('claims a free record and counts itself the default for 40 seconds of its own clock', async () => {
    const zubair = runner('zubair', false)
    await zubair.register()
    await zubair.round()
    expect(zubair.isDefault()).toBe(true)
    expect(await holder()).toBe('zubair')
    now += 40_000
    expect(zubair.isDefault()).toBe(true)
    now += 1
    expect(zubair.isDefault()).toBe(false)
  })

  it('losing the record only stops it being the default: Slack stays on and nothing exits', async () => {
    const zubair = runner('zubair', false)
    const zubairHooks = hooks()
    await zubair.register()
    await zubair.round()
    await pool.query("UPDATE failover_lease SET expires_at = now() - interval '1 second'")
    await registerHost(pool, { name: 'hassan', home: '/Users/hassan', buildMigration: BUILD, preferred: false })
    expect(await claimLease(pool, 'hassan')).not.toBeNull()

    // attach starts a round at once; awaiting round() joins it.
    zubair.attach(zubairHooks)
    await zubair.round()
    expect(zubair.isDefault()).toBe(false)
    expect(zubairHooks.calls).toEqual([])
    expect(await holder()).toBe('hassan')
  })

  it('hands the record back to the returning preferred laptop, which takes it on its next round', async () => {
    const zubair = runner('zubair', false)
    await zubair.register()
    await zubair.round()
    const hassan = runner('hassan', true)
    await hassan.register()
    await hassan.round()
    expect(hassan.isDefault()).toBe(false)

    await zubair.round()
    expect(zubair.isDefault()).toBe(false)
    await hassan.round()
    expect(hassan.isDefault()).toBe(true)
    expect(await holder()).toBe('hassan')
  })

  it('leaves Slack once the database has not answered for 40 seconds, and only once', async () => {
    const dead = createPool('postgres://relay:relay@127.0.0.1:1/relay_test', { connectTimeoutMs: 200 })
    extraPools.push(dead)
    const zubair = runner('zubair', false, { db: dead })
    const zubairHooks = hooks()
    await zubair.round()
    zubair.attach(zubairHooks)
    await zubair.round()
    expect(zubairHooks.calls).toEqual([])
    now += 40_001
    await zubair.round()
    expect(zubairHooks.calls).toEqual(['slack off'])
    await zubair.round()
    expect(zubairHooks.calls).toEqual(['slack off'])
  })

  it('reconnects Slack on the first round the database answers again', async () => {
    let failing = true
    const flaky = {
      query: (...args: Parameters<Pool['query']>) => (failing ? Promise.reject(new Error('ENOTFOUND')) : (pool.query as (...a: unknown[]) => unknown)(...args)),
    } as unknown as Pool
    const zubair = runner('zubair', false, { db: flaky })
    const zubairHooks = hooks()
    await zubair.register().catch(() => {})
    now += 40_001
    zubair.attach(zubairHooks)
    await zubair.round()
    expect(zubairHooks.calls).toEqual(['slack off'])
    failing = false
    await zubair.register()
    await zubair.round()
    expect(zubairHooks.calls).toEqual(['slack off', 'slack on'])
  })

  it('an older build leaves Slack, pauses its work, gives up the record and never asks for it back', async () => {
    const hassan = runner('hassan', true, { buildMigration: '0029_task_read_only.sql' })
    const hassanHooks = hooks()
    await hassan.register()
    hassan.attach(hassanHooks)
    await hassan.round()
    // Paused too: its schedulers and router would otherwise run its own threads on a schema it does not know.
    expect(hassanHooks.calls.sort()).toEqual(['paused', 'slack off'])
    expect(hassan.isDefault()).toBe(false)
    expect(await holder()).toBeNull()
    const { rows } = await pool.query<{ wants_back_at: Date | null }>("SELECT wants_back_at FROM failover_hosts WHERE name = 'hassan'")
    expect(rows[0]?.wants_back_at).toBeNull()
  })

  it('pauses for the other laptop\'s migration, acknowledges it, and resumes once it is withdrawn', async () => {
    const zubair = runner('zubair', false)
    const zubairHooks = hooks()
    await zubair.register()
    await registerHost(pool, { name: 'hassan', home: '/Users/hassan', buildMigration: BUILD, preferred: true })
    await setPauseRequest(pool, 'hassan', true)
    // attach starts the first round at once; the request exists before it.
    zubair.attach(zubairHooks)

    await zubair.round()
    expect(zubairHooks.calls).toEqual(['paused'])
    expect(zubair.isPaused()).toBe(true)
    const paused = await pool.query<{ paused_at: Date | null }>("SELECT paused_at FROM failover_hosts WHERE name = 'zubair'")
    expect(paused.rows[0]?.paused_at).not.toBeNull()

    await setPauseRequest(pool, 'hassan', false)
    await zubair.round()
    expect(zubairHooks.calls).toEqual(['paused', 'resumed'])
    expect(zubair.isPaused()).toBe(false)
  })

  it('releases the record at once on a clean stop', async () => {
    const zubair = runner('zubair', false)
    await zubair.register()
    await zubair.round()
    await zubair.stop()
    expect(await holder()).toBeNull()
  })
})

describe('round sleep', () => {
  it('keeps its timer referenced, so a daemon that closed Slack does not exit', async () => {
    const timers: NodeJS.Timeout[] = []
    const real = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = real(fn, ms)
      timers.push(timer)
      return timer
    }) as typeof setTimeout)
    try {
      await roundSleep(1)
    } finally {
      spy.mockRestore()
    }
    expect(timers).toHaveLength(1)
    expect(timers[0]!.hasRef()).toBe(true)
  })
})
