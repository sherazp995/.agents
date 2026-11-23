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
    stop = keepClaimRenewed({ renew, ttlMs: TTL_MS, claimedAt: Date.now(), onLost, onError })
    return { onLost, onError }
  }

  it('survives failed renewals until the claim has really expired', async () => {
    const { onLost, onError } = keep(() => Promise.reject(new Error('blip')))
    await vi.advanceTimersByTimeAsync(TTL_MS - 1)
    expect(onLost).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it('ends at the deadline even when a renewal never answers', async () => {
    const { onLost } = keep(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(TTL_MS)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it('ends at once on a confirmed loss, and only once', async () => {
    const { onLost } = keep(async () => false)
    await vi.advanceTimersByTimeAsync(TTL_MS / 3)
    expect(onLost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TTL_MS * 2)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it('a successful renewal moves the deadline to when that renewal started', async () => {
    let healthy = true
    const { onLost } = keep(() => (healthy ? Promise.resolve(true) : Promise.reject(new Error('blip'))))
    await vi.advanceTimersByTimeAsync(TTL_MS / 3)
    healthy = false
    await vi.advanceTimersByTimeAsync(TTL_MS - 1)
    expect(onLost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onLost).toHaveBeenCalledTimes(1)
  })
})
