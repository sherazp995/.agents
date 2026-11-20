import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { dropDatabaseWithRetry } from './database-naming.js'

const refused = Object.assign(new Error('permission denied to terminate process'), { code: '42501' })

function clientRefusing(times: number): { client: pg.Client; calls: () => number } {
  let calls = 0
  const client = {
    query: async () => {
      calls += 1
      if (calls <= times) throw refused
      return { rows: [] }
    },
  } as unknown as pg.Client
  return { client, calls: () => calls }
}

describe('dropDatabaseWithRetry', () => {
  it('retries while autovacuum holds the database, and drops it once it lets go', async () => {
    const { client, calls } = clientRefusing(2)
    await dropDatabaseWithRetry(client, 'relay_r1_w1_x_test', { waitMs: 0 })
    expect(calls()).toBe(3)
  })

  it('after five refusals warns and returns, or throws when the sweep would never clean it up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await dropDatabaseWithRetry(clientRefusing(5).client, 'relay_r1_w1_test', { waitMs: 0 })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
    await expect(dropDatabaseWithRetry(clientRefusing(5).client, 'relay_r1_w1_x_test', { waitMs: 0, throwOnGiveUp: true })).rejects.toBe(refused)
  })
})
