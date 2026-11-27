import { describe, expect, it, vi } from 'vitest'
import { isConnectionError, untilDatabaseAnswers } from '../../src/db/offline.js'

const unreachable = Object.assign(new Error('getaddrinfo ENOTFOUND aws-1-ap-northeast-1.pooler.supabase.com'), { code: 'ENOTFOUND' })

describe('untilDatabaseAnswers', () => {
  it('waits out an unreachable database and returns the write once it answers', async () => {
    let calls = 0
    const write = vi.fn(async () => {
      calls += 1
      if (calls < 4) throw unreachable
      return 'posted'
    })
    const onWait = vi.fn()
    expect(await untilDatabaseAnswers(write, { giveUp: () => false, onWait, sleep: async () => {} })).toBe('posted')
    expect(write).toHaveBeenCalledTimes(4)
    expect(onWait).toHaveBeenCalledTimes(3)
  })

  it('throws at once on an error that is not about reaching the database', async () => {
    const refused = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
    const write = vi.fn(async () => {
      throw refused
    })
    await expect(untilDatabaseAnswers(write, { giveUp: () => false, sleep: async () => {} })).rejects.toBe(refused)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('stops waiting once told to give up', async () => {
    let giveUp = false
    const write = vi.fn(async () => {
      giveUp = true
      throw unreachable
    })
    await expect(untilDatabaseAnswers(write, { giveUp: () => giveUp, sleep: async () => {} })).rejects.toBe(unreachable)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('reads the errors this laptop really logged during the outage as unreachable', () => {
    expect(isConnectionError(unreachable)).toBe(true)
    expect(isConnectionError(new Error('Connection terminated due to connection timeout'))).toBe(true)
    expect(isConnectionError(new Error('relation "x" does not exist'))).toBe(false)
  })
})
