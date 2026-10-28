import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../src/db/migrate.js'
import { closePool, createPool } from '../src/db/pool.js'
import { createKillSwitch, KillSwitch, PostgresKillSwitchStore } from '../src/killswitch.js'
import { resolveWorkspaceId } from '../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from './support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/** Fails loudly instead of skipping when the var is absent, matching every other database suite in this repo (see test/runs/store.test.ts). A skipped test proves nothing. */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error('RELAY_TEST_DATABASE_URL is not set; this suite must fail, not silently skip.')
        })
      })

describeDb('PostgresKillSwitchStore', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function buildWorkspaceId(): Promise<string> {
    return resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
  }

  it('loadState reports cleared for a workspace with no kill_switch row at all', async () => {
    const workspaceId = await buildWorkspaceId()
    const store = new PostgresKillSwitchStore(pool, workspaceId)
    expect(await store.loadState()).toEqual({ engaged: false })
  })

  it('recordEngaged then loadState round-trips the reason and timestamp', async () => {
    const workspaceId = await buildWorkspaceId()
    const store = new PostgresKillSwitchStore(pool, workspaceId)
    const engagedAt = new Date('2026-03-01T12:00:00.000Z')
    await store.recordEngaged('security incident', engagedAt, 'operator-1')
    const state = await store.loadState()
    expect(state.engaged).toBe(true)
    if (!state.engaged) throw new Error('expected engaged')
    expect(state.reason).toBe('security incident')
    expect(state.engagedAt.toISOString()).toBe(engagedAt.toISOString())
  })

  it('recordCleared then loadState reports cleared', async () => {
    const workspaceId = await buildWorkspaceId()
    const store = new PostgresKillSwitchStore(pool, workspaceId)
    await store.recordEngaged('test', new Date(), 'operator-1')
    await store.recordCleared(new Date())
    expect(await store.loadState()).toEqual({ engaged: false })
  })

  it('recordEngaged is upsert-safe: engaging twice for the same workspace does not create two rows', async () => {
    const workspaceId = await buildWorkspaceId()
    const store = new PostgresKillSwitchStore(pool, workspaceId)
    await store.recordEngaged('first', new Date(), 'operator-1')
    await store.recordEngaged('second', new Date(), 'operator-2')
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM kill_switch WHERE workspace_id = $1', [
      workspaceId,
    ])
    expect(rows[0]?.n).toBe(1)
    const state = await store.loadState()
    expect(state.engaged).toBe(true)
    if (!state.engaged) throw new Error('expected engaged')
    expect(state.reason).toBe('second')
  })

  it(
    'required proof: a durable engagement survives a simulated process restart, another KillSwitch ' +
      'instance built from the same store starts already engaged',
    async () => {
      const workspaceId = await buildWorkspaceId()
      const store = new PostgresKillSwitchStore(pool, workspaceId)
      const firstProcess = new KillSwitch({ runCanceller: { cancelAll: () => {} }, store })
      await firstProcess.engage('engaged before the simulated restart')

      // A brand new KillSwitch instance, standing in for the process
      // restarting: nothing but the durable store carries state across
      // this boundary.
      const afterRestart = await createKillSwitch({ runCanceller: { cancelAll: () => {} }, store })
      expect(afterRestart.isEngaged()).toBe(true)
      expect(() => afterRestart.refuseIfEngaged()).toThrow(/engaged before the simulated restart/)
    },
  )

  it('two workspaces do not interfere: engaging one leaves the other cleared', async () => {
    const workspaceA = await buildWorkspaceId()
    const workspaceB = await buildWorkspaceId()
    const storeA = new PostgresKillSwitchStore(pool, workspaceA)
    const storeB = new PostgresKillSwitchStore(pool, workspaceB)

    await storeA.recordEngaged('workspace A incident', new Date(), 'operator-1')

    expect((await storeA.loadState()).engaged).toBe(true)
    expect((await storeB.loadState()).engaged).toBe(false)
  })

  it('the kill_switch table satisfies AP-8: workspace_id is NOT NULL and foreign-keyed to workspaces', async () => {
    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT t.table_name
      FROM information_schema.tables t
      WHERE t.table_schema = 'public'
        AND t.table_name = 'kill_switch'
        AND (
          NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.table_name
              AND c.column_name = 'workspace_id' AND c.is_nullable = 'NO'
          )
          OR NOT EXISTS (
            SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
              AND tc.table_name = t.table_name AND kcu.column_name = 'workspace_id'
              AND ccu.table_name = 'workspaces'
          )
        )
    `)
    expect(rows).toEqual([])
  })
})
