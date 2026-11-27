import { describe, expect, it } from 'vitest'
import { idleIfBehind, migrateWithFailover, type MigrationSteps } from '../../scripts/relay-orchestrator.js'
import { applyMigrations, newestMigrationName } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { getTestDatabaseUrl } from '../support/database.js'

type World = { pending: number; supported: boolean; others: { name: string; buildMigration: string }[][]; paused: boolean[]; running: boolean[] }

function steps(world: World): MigrationSteps & { applied: () => number; requests: boolean[]; warnings: string[]; waits: () => number } {
  let applied = 0
  let waits = 0
  let round = 0
  const requests: boolean[] = []
  const warnings: string[] = []
  const at = <T>(list: T[]): T => list[Math.min(round, list.length - 1)] as T
  return {
    pending: async () => world.pending,
    pauseSupported: async () => world.supported,
    others: async () => at(world.others),
    setPauseRequest: async (requested) => void requests.push(requested),
    othersPaused: async () => at(world.paused),
    othersRunning: async () => at(world.running),
    apply: async () => void (applied += 1),
    log: { info: () => undefined, warn: (...args: unknown[]) => void warnings.push(String(args[1] ?? args[0])) },
    sleep: async () => {
      waits += 1
      round += 1
    },
    applied: () => applied,
    requests,
    warnings,
    waits: () => waits,
  }
}

const NEW = { name: 'zubair-mbp', buildMigration: '0034_both_laptops_answer.sql' }
const OLD = { name: 'zubair-mbp', buildMigration: '0033_something.sql' }

describe('migrateWithFailover', () => {
  it('does nothing when there is nothing to migrate', async () => {
    const s = steps({ pending: 0, supported: true, others: [[NEW]], paused: [false], running: [true] })
    await migrateWithFailover(s)
    expect([s.applied(), s.requests]).toEqual([0, []])
  })

  it('applies at once when no other laptop is online', async () => {
    const s = steps({ pending: 1, supported: true, others: [[]], paused: [false], running: [false] })
    await migrateWithFailover(s)
    expect(s.applied()).toBe(1)
    expect(s.waits()).toBe(0)
  })

  it('asks the other laptop to pause, waits until it paused and its turns ended, applies, and withdraws the request', async () => {
    const s = steps({ pending: 1, supported: true, others: [[NEW]], paused: [false, true, true], running: [true, true, false] })
    await migrateWithFailover(s)
    expect(s.waits()).toBe(2)
    expect(s.applied()).toBe(1)
    expect(s.requests.at(0)).toBe(true)
    expect(s.requests.at(-1)).toBe(false)
  })

  it('never migrates while a laptop on a build from before 0034 is online, says to stop or update it, and migrates once it is offline', async () => {
    const s = steps({ pending: 1, supported: false, others: [[OLD], [OLD], []], paused: [false], running: [false] })
    await migrateWithFailover(s)
    expect(s.waits()).toBe(2)
    expect(s.applied()).toBe(1)
    expect(s.warnings.some((line) => line.includes('stop Relay on zubair-mbp or update it first'))).toBe(true)
    // The database had no pause columns yet: no request was written.
    expect(s.requests).toEqual([])
  })

  it('treats a laptop whose build cannot pause as old even after 0034 is applied', async () => {
    const s = steps({ pending: 1, supported: true, others: [[OLD], []], paused: [true], running: [false] })
    await migrateWithFailover(s)
    expect(s.waits()).toBe(1)
    expect(s.applied()).toBe(1)
  })
})

describe('idleIfBehind', () => {
  it('idles a build older than the database without connecting, and lets a current one start', async () => {
    const pool = createPool(await getTestDatabaseUrl())
    try {
      await applyMigrations(pool, 'src/db/migrations')
      const attached: unknown[] = []
      const failover = { host: 'zubair-mbp', attach: (hooks: unknown) => void attached.push(hooks) }
      const errors: unknown[] = []
      const log = { error: (...args: unknown[]) => void errors.push(args) }
      expect(await idleIfBehind(pool, newestMigrationName('src/db/migrations'), failover, log)).toBe(false)
      expect(attached).toEqual([])
      expect(await idleIfBehind(pool, '0033_older.sql', failover, log)).toBe(true)
      expect(attached).toHaveLength(1)
      expect(errors).toHaveLength(1)
    } finally {
      await closePool(pool)
    }
  })
})
