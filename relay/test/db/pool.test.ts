import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, createPool } from '../../src/db/pool.js'
import { getTestDatabaseUrl } from '../support/database.js'
import type { Pool } from 'pg'

const url = process.env.RELAY_TEST_DATABASE_URL

describe('pool error handling', () => {
  if (!url) {
    it('requires RELAY_TEST_DATABASE_URL to be set', () => {
      throw new Error(
        'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts sets a local default, so ' +
          'this only fires when that default has been explicitly overridden to empty.',
      )
    })
    return
  }

  let pool: Pool | undefined

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
  })

  afterAll(async () => {
    if (pool) await closePool(pool)
  })

  it(
    'survives a released client whose backend is terminated out from under it, and keeps serving queries',
    async () => {
      // beforeAll assigns pool before any it() body runs; if it threw
      // instead, Vitest fails this test without invoking this callback.
      if (!pool) throw new Error('pool was not created; beforeAll must have failed')

      // Hold both clients checked out at once so the pool is forced to open
      // two distinct physical connections. If the second connect() reused
      // the first client's connection (which it would if the first were
      // released first, since pool.connect() prefers an idle connection),
      // the "killer" would end up terminating its own backend instead.
      const client = await pool.connect()
      const killer = await pool.connect()

      const {
        rows: [row],
      } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = row?.pid
      expect(pid).toBeTypeOf('number')

      // Release the target client back to the pool so it sits there idle.
      // This reproduces the exact shape of the reviewer's finding: the
      // crash only happens for a client idle in the pool, not one currently
      // checked out.
      client.release()

      // Terminate that backend from the second connection, the way an admin
      // restarting Postgres or killing a stuck session would. Without a
      // pool 'error' listener, the idle client raising this as an unhandled
      // 'error' event would crash the whole process, taking this test
      // process down with it rather than failing a single assertion.
      await killer.query('SELECT pg_terminate_backend($1)', [pid])
      killer.release()

      // Give the pool a moment to observe the dropped connection.
      await new Promise((resolve) => setTimeout(resolve, 200))

      // The pool must still serve a later query, using a fresh client since
      // the terminated one is gone.
      const result = await pool.query('SELECT 1 AS one')
      expect(result.rows[0]).toEqual({ one: 1 })
    },
    15000,
  )
})
