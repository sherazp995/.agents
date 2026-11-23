import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations, newestMigrationName } from '../../src/db/migrate.js'
import { claimLease, registerHost } from '../../src/failover/lease.js'
import { FailoverRunner, standbySleep, type FailoverTimings, type StepDownHooks } from '../../src/failover/run.js'
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
  function runner(name: string, preferred: boolean, buildMigration = BUILD, options: { db?: Pool; timings?: Partial<FailoverTimings>; sleep?: (ms: number) => Promise<void> } = {}): FailoverRunner {
    const created = new FailoverRunner({
      pool: options.db ?? pool,
      log: createLogger('fatal'),
      name,
      home: `/Users/${name}`,
      buildMigration,
      preferred,
      timings: { pollMs: POLL_MS, renewMs: RENEW_MS, ...options.timings },
      now: () => now,
      sleep: options.sleep ?? ((ms) => {
        if (ms === RENEW_MS) return new Promise(() => {})
        polls += 1
        return new Promise((resolve) => setImmediate(resolve))
      }),
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
      waitingOn: () => (rounds-- > 0 ? ['running turns'] : []),
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

  describe('recovering after a database blip', () => {
    type Mode = 'up' | 'down' | 'hang'

    /** A pool whose failover requests fail or hang on demand, with one kind of statement holdable. */
    function flakyPool() {
      const state: { mode: Mode; holdMatching: string | null; release: () => void; held: boolean; renewals: number; newerMigration: boolean; claimCommitsThenFails: boolean } = {
        mode: 'up',
        holdMatching: null,
        release: () => {},
        held: false,
        renewals: 0,
        newerMigration: false,
        claimCommitsThenFails: false,
      }
      const db = {
        query: async (config: { text: string; values?: unknown[] }) => {
          if (state.mode === 'down') throw new Error('database blip')
          if (state.mode === 'hang') return new Promise(() => {})
          if (config.text.includes('WITH renewed AS')) state.renewals += 1
          if (state.newerMigration && config.text.includes('FROM schema_migrations')) return { rows: [{ name: '9999_newer.sql' }], rowCount: 1 }
          if (state.holdMatching !== null && config.text.includes(state.holdMatching)) {
            state.holdMatching = null
            state.held = true
            await new Promise<void>((resolve) => (state.release = resolve))
          }
          if (state.claimCommitsThenFails && config.text.includes('WITH claimed AS')) {
            state.claimCommitsThenFails = false
            await pool.query(config.text, config.values)
            throw new Error('the reply to the claim timed out')
          }
          return pool.query(config.text, config.values)
        },
      }
      return { state, db: db as unknown as Pool }
    }

    async function answering(options: Parameters<typeof runner>[3] = {}) {
      const zubair = runner('zubair', false, BUILD, options)
      await zubair.register()
      expect(await zubair.waitForClaim()).toBe(true)
      const zubairHooks = hooks()
      zubair.attach(zubairHooks)
      return { zubair, zubairHooks }
    }

    async function generation(): Promise<string> {
      const { rows } = await pool.query<{ generation: string }>('SELECT generation::text AS generation FROM failover_lease')
      return rows[0]?.generation ?? ''
    }

    const expireRecord = () => pool.query("UPDATE failover_lease SET expires_at = now() - interval '1 second'")

    it('a failed role check with a fresh role starts nothing and does not step down', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db })
      state.mode = 'down'
      expect(await zubair.mayStartWork()).toBe(false)
      expect(zubair.holdsFresh()).toBe(true)
      expect(zubairHooks.calls).toEqual([])
    })

    it('stops trusting the role the moment recovery starts', async () => {
      const { state, db } = flakyPool()
      const { zubair } = await answering({ db })
      state.mode = 'down'
      now += 41_000
      await zubair.renew()
      now -= 41_000
      expect(zubair.holdsFresh()).toBe(false)
    })

    it('regains a role that is still its own, with the same generation and Slack never closed', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db })
      const before = await generation()
      state.mode = 'down'
      now += 41_000
      await zubair.renew()
      state.mode = 'up'
      await zubair.renew()
      expect(zubair.holdsFresh()).toBe(true)
      expect(await generation()).toBe(before)
      expect(zubairHooks.calls).toEqual([])
    })

    it('regains an expired role nobody took, and may start work on the new generation', async () => {
      const { zubair, zubairHooks } = await answering()
      const before = await generation()
      await expireRecord()
      await zubair.renew()
      expect(zubair.holdsFresh()).toBe(true)
      expect(BigInt(await generation())).toBe(BigInt(before) + 1n)
      expect(await zubair.mayStartWork()).toBe(true)
      expect(zubairHooks.calls).toEqual([])
    })

    it('disconnects at once when another laptop holds the role, and never takes it', async () => {
      const { zubair, zubairHooks } = await answering()
      await registerHost(pool, { name: 'hassan', home: '/Users/hassan', buildMigration: BUILD, preferred: false })
      await pool.query("UPDATE failover_lease SET holder = 'hassan', generation = generation + 1, expires_at = now() + interval '60 seconds'")
      await zubair.renew()
      await zubair.steppedDown()
      expect(zubairHooks.calls).toEqual(['closeSlack', 'exit 1'])
      expect(await holder()).toBe('hassan')
    })

    it('a handback seen during recovery is honoured', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db })
      const hassan = runner('hassan', true)
      await hassan.register()
      state.mode = 'down'
      now += 41_000
      await zubair.renew()
      state.mode = 'up'
      expect(await hassan.tryClaim()).toBe(false)
      await zubair.renew()
      await zubair.steppedDown()
      expect(zubair.holdsFresh()).toBe(false)
      expect(zubairHooks.calls).toEqual(['closeSlack', 'exit 1'])
      expect(await hassan.tryClaim()).toBe(true)
    })

    it('a database with a newer Relay version is never recovered into', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db })
      state.mode = 'down'
      now += 41_000
      await zubair.renew()
      state.mode = 'up'
      state.newerMigration = true
      await zubair.renew()
      await zubair.steppedDown()
      expect(zubairHooks.calls).toEqual(['closeSlack', 'exit 1'])
    })

    it('a role check that started before a recovery cannot pass after it', async () => {
      const { state, db } = flakyPool()
      const { zubair } = await answering({ db })
      state.holdMatching = 'SELECT 1 FROM failover_lease'
      const check = zubair.mayStartWork()
      await vi.waitFor(() => expect(state.held).toBe(true))
      const releaseCheck = state.release
      state.mode = 'down'
      now += 41_000
      await zubair.renew()
      state.mode = 'up'
      await zubair.renew()
      expect(zubair.holdsFresh()).toBe(true)
      releaseCheck()
      expect(await check).toBe(false)
    })

    it('stopping during a reclaim leaves the role released', async () => {
      const { state, db } = flakyPool()
      const { zubair } = await answering({ db })
      await expireRecord()
      state.holdMatching = 'WITH claimed AS'
      const renewing = zubair.renew()
      await vi.waitFor(() => expect(state.held).toBe(true))
      const stopping = zubair.stop()
      state.release()
      await Promise.all([renewing, stopping])
      expect(await holder()).toBeNull()
    })

    it('after recovery the real renewal loop keeps renewing', async () => {
      const { state, db } = flakyPool()
      const { zubair } = await answering({ db, sleep: () => new Promise((resolve) => setImmediate(resolve)) })
      state.mode = 'down'
      now += 41_000
      await vi.waitFor(() => expect(zubair.holdsFresh()).toBe(false))
      state.mode = 'up'
      await vi.waitFor(() => expect(zubair.holdsFresh()).toBe(true))
      const renewals = state.renewals
      await vi.waitFor(() => expect(state.renewals).toBeGreaterThan(renewals + 2))
      expect(zubair.holdsFresh()).toBe(true)
    })

    it('a database down past the limit ends in a step down, 75 seconds with another laptop around', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db })
      await registerHost(pool, { name: 'hassan', home: '/Users/hassan', buildMigration: BUILD, preferred: false })
      await zubair.renew()
      state.mode = 'down'
      await zubair.renew()
      now += 41_000
      await zubair.renew()
      now += 33_999
      await zubair.renew()
      expect(zubairHooks.calls).toEqual([])
      now += 1
      await zubair.renew()
      await vi.waitFor(() => expect(zubairHooks.calls).toEqual(['closeSlack']))
      state.mode = 'up'
      await zubair.steppedDown()
      expect(zubairHooks.calls).toEqual(['closeSlack', 'exit 1'])
    })

    it('a laptop working alone gets 2 minutes', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db })
      await zubair.renew()
      state.mode = 'down'
      await zubair.renew()
      now += 41_000
      await zubair.renew()
      now += 78_999
      await zubair.renew()
      expect(zubairHooks.calls).toEqual([])
      now += 1
      await zubair.renew()
      await vi.waitFor(() => expect(zubairHooks.calls).toEqual(['closeSlack']))
      state.mode = 'up'
      await zubair.steppedDown()
    })

    it('a claim that committed after its timeout does not step down from its own record, and is claimed again once it expires', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db })
      await expireRecord()
      state.claimCommitsThenFails = true
      await zubair.renew()
      await zubair.renew()
      expect(zubair.holdsFresh()).toBe(false)
      expect(zubairHooks.calls).toEqual([])
      await expireRecord()
      await zubair.renew()
      expect(zubair.holdsFresh()).toBe(true)
      expect(await zubair.mayStartWork()).toBe(true)
      expect(zubairHooks.calls).toEqual([])
    })

    it('a newer record under its own name with no claim in doubt is not its own, so it steps down', async () => {
      const { zubair, zubairHooks } = await answering()
      await pool.query('UPDATE failover_lease SET generation = generation + 1')
      await zubair.renew()
      await zubair.steppedDown()
      expect(zubairHooks.calls).toEqual(['closeSlack', 'exit 1'])
    })

    it('stopping while a recovery renewal sees a handback still releases the role', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db, sleep: () => new Promise(() => {}) })
      const hassan = runner('hassan', true)
      await hassan.register()
      state.mode = 'down'
      now += 41_000
      await zubair.renew()
      state.mode = 'up'
      expect(await hassan.tryClaim()).toBe(false)
      state.holdMatching = 'WITH renewed AS'
      const renewing = zubair.renew()
      await vi.waitFor(() => expect(state.held).toBe(true))
      const stopping = zubair.stop()
      state.release()
      await Promise.all([renewing, stopping])
      expect(await holder()).toBeNull()
      expect(zubairHooks.calls).toEqual([])
    })

    it('a request that hangs fails at its limit, and recovery still ends on time', async () => {
      const { state, db } = flakyPool()
      const { zubair, zubairHooks } = await answering({ db, timings: { queryMs: 60 } })
      state.mode = 'hang'
      const startedAt = Date.now()
      await zubair.renew()
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(55)
      now += 41_000
      await zubair.renew()
      now += 75_000
      await zubair.renew()
      await vi.waitFor(() => expect(zubairHooks.calls).toEqual(['closeSlack']))
      state.mode = 'up'
      await zubair.steppedDown()
      expect(zubairHooks.calls).toEqual(['closeSlack', 'exit 1'])
    })
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

describe('standby sleep', () => {
  it('keeps its timer referenced, so a standby daemon with nothing else open does not exit', async () => {
    const timers: NodeJS.Timeout[] = []
    const real = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = real(fn, ms)
      timers.push(timer)
      return timer
    }) as typeof setTimeout)
    try {
      await standbySleep(1)
    } finally {
      spy.mockRestore()
    }
    expect(timers).toHaveLength(1)
    expect(timers[0]!.hasRef()).toBe(true)
  })
})
