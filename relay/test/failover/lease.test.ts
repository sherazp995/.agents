import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations, newestMigrationName } from '../../src/db/migrate.js'
import { boundedLeaseDb, claimLease, otherHostsHaveRunningWorkers, raiseWantsBack, registerHost, releaseLease, renewLease } from '../../src/failover/lease.js'
import { randomUUID } from 'node:crypto'
import { intakeMention } from '../../src/autonomous/store.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

const BUILD = newestMigrationName('src/db/migrations')

describe('failover lease', () => {
  let pool: Pool

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
    await pool.query('UPDATE failover_lease SET holder = NULL, renewed_at = NULL, expires_at = NULL')
    await pool.query('DELETE FROM failover_hosts')
    await registerHost(pool, { name: 'hassan', home: '/Users/hassan', buildMigration: BUILD, preferred: true })
    await registerHost(pool, { name: 'zubair', home: '/Users/zubair', buildMigration: BUILD, preferred: false })
  })

  /** Stands in for 60 seconds of database time passing without a renewal. */
  async function expire(): Promise<void> {
    await pool.query("UPDATE failover_lease SET expires_at = now() - interval '1 second'")
  }

  it('lets exactly one of two laptops claiming at once hold the record', async () => {
    const results = await Promise.all([claimLease(pool, 'hassan'), claimLease(pool, 'zubair')])
    expect(results.filter((generation) => generation !== null)).toHaveLength(1)
    const { rows } = await pool.query<{ holder: string }>('SELECT holder FROM failover_lease')
    expect(rows[0]?.holder).toBe(results[0] !== null ? 'hassan' : 'zubair')
  })

  it('holds for 60 seconds of database time, then lets the other laptop take it with a new generation', async () => {
    const first = await claimLease(pool, 'zubair')
    const { rows } = await pool.query<{ ttl: number }>('SELECT extract(epoch FROM expires_at - renewed_at)::int AS ttl FROM failover_lease')
    expect(rows[0]?.ttl).toBe(60)
    expect(await claimLease(pool, 'hassan')).toBeNull()

    await expire()
    const second = await claimLease(pool, 'hassan')
    expect(BigInt(second ?? '0')).toBe(BigInt(first ?? '0') + 1n)
    // The old holder can neither renew nor revive it.
    expect(await renewLease(pool, 'zubair', first ?? '')).toMatchObject({ held: false, wantsBack: false })
  })

  it('a bounded request fails at its limit on a real connection, and the pool still answers', async () => {
    const db = boundedLeaseDb(pool, 100)
    const startedAt = Date.now()
    await expect(db.query('SELECT pg_sleep(5)')).rejects.toThrow()
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(95)
    expect(elapsed).toBeLessThan(2000)
    expect((await db.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 })
  })

  it('hands back only through release: the flag shows on renewal, then the preferred laptop claims', async () => {
    const generation = (await claimLease(pool, 'zubair')) ?? ''
    expect(await claimLease(pool, 'hassan')).toBeNull()
    await raiseWantsBack(pool, 'hassan')

    // The flag never takes the record from a holder.
    expect(await claimLease(pool, 'hassan')).toBeNull()
    expect(await renewLease(pool, 'zubair', generation)).toMatchObject({ held: true, wantsBack: true, otherSeen: true })

    expect(await releaseLease(pool, 'zubair', generation)).toBe(true)
    // Reserved for the preferred laptop: the one that just released cannot take it again.
    expect(await claimLease(pool, 'zubair')).toBeNull()
    expect(await claimLease(pool, 'hassan')).not.toBeNull()
    const { rows } = await pool.query<{ wants_back_at: Date | null }>("SELECT wants_back_at FROM failover_hosts WHERE name = 'hassan'")
    expect(rows[0]?.wants_back_at).toBeNull()
  })

  it('ignores the flag of a preferred laptop not seen for 60 seconds', async () => {
    await raiseWantsBack(pool, 'hassan')
    await pool.query("UPDATE failover_hosts SET last_seen_at = now() - interval '61 seconds' WHERE name = 'hassan'")
    expect(await claimLease(pool, 'zubair')).not.toBeNull()
  })
  it('makes migrations wait while the other laptop, seen recently, still runs a worker', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'R', ['member'])
    const intake = await intakeMention(pool, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
      event: { id: randomUUID(), principalId, text: 'x', ref: { channel: 'C1', message: '1.1' }, fileIds: [], receivedAt: '' },
      replyRef: { channel: 'C1', thread: '1.1' },
      files: [],
    })
    if (intake.kind !== 'created') throw new Error('no task')
    expect(await otherHostsHaveRunningWorkers(pool, 'hassan')).toBe(false)

    await pool.query("UPDATE autonomous_tasks SET worker_host = 'zubair', worker_pid = 4242, worker_pgid = 4242 WHERE id = $1", [intake.task.id])
    expect(await otherHostsHaveRunningWorkers(pool, 'hassan')).toBe(true)
    // Its own workers never hold up its own migrations.
    expect(await otherHostsHaveRunningWorkers(pool, 'zubair')).toBe(false)

    // A laptop gone quiet no longer holds them up either.
    await pool.query("UPDATE failover_hosts SET last_seen_at = now() - interval '61 seconds' WHERE name = 'zubair'")
    expect(await otherHostsHaveRunningWorkers(pool, 'hassan')).toBe(false)
    await pool.query('UPDATE autonomous_tasks SET worker_host = NULL, worker_pid = NULL, worker_pgid = NULL WHERE id = $1', [intake.task.id])
  })
})
