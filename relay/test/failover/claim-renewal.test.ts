import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepClaimRenewed } from '../../src/failover/claim-renewal.js'

const TTL_MS = 60_000

describe('keepClaimRenewed', () => {
  let stop: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stop?.()
    vi.useRealTimers()
  })

  function keep(renew: () => Promise<boolean>) {
    const onLost = vi.fn()
    const onError = vi.fn()
    stop = keepClaimRenewed({ renew, ttlMs: TTL_MS, onLost, onError })
    return { onLost, onError }
  }

  it('keeps the turn through an outage far longer than the claim, and renews again once the database answers', async () => {
    let online = false
    const renew = vi.fn(() => (online ? Promise.resolve(true) : Promise.reject(new Error('ENOTFOUND'))))
    const { onLost, onError } = keep(renew)
    await vi.advanceTimersByTimeAsync(TTL_MS * 10)
    expect(onLost).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(30)
    online = true
    await vi.advanceTimersByTimeAsync(TTL_MS / 3)
    expect(renew).toHaveBeenCalledTimes(31)
    expect(onLost).not.toHaveBeenCalled()
  })

  it('a renewal that never answers counts as failed, so the next one still runs', async () => {
    let calls = 0
    const { onLost, onError } = keep(() => (calls++ === 0 ? new Promise(() => {}) : Promise.resolve(true)))
    await vi.advanceTimersByTimeAsync((TTL_MS / 3) * 2)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TTL_MS / 3)
    expect(calls).toBe(2)
    expect(onLost).not.toHaveBeenCalled()
  })

  it('ends at once on a confirmed loss, and only once', async () => {
    const { onLost } = keep(async () => false)
    await vi.advanceTimersByTimeAsync(TTL_MS / 3)
    expect(onLost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TTL_MS * 2)
    expect(onLost).toHaveBeenCalledTimes(1)
  })
})
