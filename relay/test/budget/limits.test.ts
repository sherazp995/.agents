import type { Redis } from '../../src/redis/client.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  capabilityCallCount,
  checkCapabilityCallCount,
  checkOriginRate,
  DEFAULT_ORIGIN_RATE_WINDOW_SECONDS,
} from '../../src/budget/limits.js'
import { closeRedis, createRedis, waitForReady } from '../../src/redis/client.js'

/**
 * Driven against a real Redis, because these are about behaviour at a
 * boundary in time and a fake would only prove the fake agrees with itself.
 * `now` is injected rather than read inside, so the window can be tested
 * without sleeping: the difference between proving the boundary and hoping.
 */

const url = process.env.RELAY_TEST_REDIS_URL ?? 'redis://localhost:6379/8'

describe('FR-POL-7 rate and count limits', () => {
  let redis: Redis

  beforeAll(async () => {
    redis = createRedis(url)
    await waitForReady(redis)
  })

  afterAll(async () => {
    await closeRedis(redis)
  })

  beforeEach(async () => {
    const keys = await redis.keys('relay:ratelimit:*')
    const counts = await redis.keys('relay:callcount:*')
    if (keys.length > 0) await redis.del(...keys)
    if (counts.length > 0) await redis.del(...counts)
  })

  describe('per-origin rate limit', () => {
    it('allows up to the limit and refuses the next one', async () => {
      const workspace = `ws-${Math.random().toString(36).slice(2)}`
      for (let index = 0; index < 3; index += 1) {
        expect((await checkOriginRate(redis, workspace, 'example.com', { limit: 3 })).allowed).toBe(true)
      }

      const refused = await checkOriginRate(redis, workspace, 'example.com', { limit: 3 })

      expect(refused.allowed).toBe(false)
      if (refused.allowed) return
      expect(refused.reason).toContain('rate limit')
    })

    it('SLIDES, so a burst straddling a boundary does not get double the allowance', async () => {
      // A fixed bucket resets on the hour: a limit of 3 would permit 6
      // across two seconds either side of the boundary, which is exactly the
      // burst that gets an operator's account blocked.
      const workspace = `ws-${Math.random().toString(36).slice(2)}`
      const start = 1_000_000_000_000

      for (let index = 0; index < 3; index += 1) {
        await checkOriginRate(redis, workspace, 'example.com', { limit: 3, windowSeconds: 60, now: start })
      }

      // One second later, still inside the window: still refused.
      expect((await checkOriginRate(redis, workspace, 'example.com', { limit: 3, windowSeconds: 60, now: start + 1000 })).allowed).toBe(false)

      // Past the window: allowed again.
      expect((await checkOriginRate(redis, workspace, 'example.com', { limit: 3, windowSeconds: 60, now: start + 61_000 })).allowed).toBe(true)
    })

    it('says when room next opens, rather than "try again later"', async () => {
      const workspace = `ws-${Math.random().toString(36).slice(2)}`
      const start = 1_000_000_000_000
      await checkOriginRate(redis, workspace, 'example.com', { limit: 1, windowSeconds: 60, now: start })

      const refused = await checkOriginRate(redis, workspace, 'example.com', { limit: 1, windowSeconds: 60, now: start + 10_000 })

      expect(refused.allowed).toBe(false)
      if (refused.allowed) return
      expect(refused.retryAfterSeconds).toBe(50)
    })

    it('counts two requests in the SAME millisecond as two', async () => {
      // Collapsing them into one sorted-set entry would undercount exactly
      // when the limiter is under most pressure.
      const workspace = `ws-${Math.random().toString(36).slice(2)}`
      const now = 1_000_000_000_000

      await checkOriginRate(redis, workspace, 'example.com', { limit: 2, now })
      await checkOriginRate(redis, workspace, 'example.com', { limit: 2, now })

      expect((await checkOriginRate(redis, workspace, 'example.com', { limit: 2, now })).allowed).toBe(false)
    })

    it('keeps origins and workspaces separate', async () => {
      const workspace = `ws-${Math.random().toString(36).slice(2)}`
      await checkOriginRate(redis, workspace, 'a.example', { limit: 1 })

      expect((await checkOriginRate(redis, workspace, 'b.example', { limit: 1 })).allowed).toBe(true)
      expect((await checkOriginRate(redis, `${workspace}-other`, 'a.example', { limit: 1 })).allowed).toBe(true)
    })

    it('has a window default that is stated rather than magic', () => {
      expect(DEFAULT_ORIGIN_RATE_WINDOW_SECONDS).toBe(60)
    })
  })

  describe('per-capability call count', () => {
    it('allows up to the cap and refuses beyond it', async () => {
      const runId = `run-${Math.random().toString(36).slice(2)}`
      for (let index = 0; index < 3; index += 1) {
        expect((await checkCapabilityCallCount(redis, runId, 'browser', { cap: 3 })).allowed).toBe(true)
      }

      expect((await checkCapabilityCallCount(redis, runId, 'browser', { cap: 3 })).allowed).toBe(false)
    })

    it('names a LOOP rather than a cap, because that changes what the operator does', async () => {
      // "Cap reached" makes an operator reach for a bigger cap. "This looks
      // like a loop" makes them go and look at the run.
      const runId = `run-${Math.random().toString(36).slice(2)}`
      await checkCapabilityCallCount(redis, runId, 'browser', { cap: 1 })
      const refused = await checkCapabilityCallCount(redis, runId, 'browser', { cap: 1 })

      expect(refused.allowed).toBe(false)
      if (refused.allowed) return
      expect(refused.reason).toContain('looped')
      expect(refused.reason).toContain('can still report what it has done')
    })

    it('counts each capability and each run separately', async () => {
      const runId = `run-${Math.random().toString(36).slice(2)}`
      await checkCapabilityCallCount(redis, runId, 'browser', { cap: 1 })

      expect((await checkCapabilityCallCount(redis, runId, 'shell', { cap: 1 })).allowed).toBe(true)
      expect((await checkCapabilityCallCount(redis, `${runId}-other`, 'browser', { cap: 1 })).allowed).toBe(true)
    })

    it('reports the count without consuming one', async () => {
      const runId = `run-${Math.random().toString(36).slice(2)}`
      await checkCapabilityCallCount(redis, runId, 'browser', { cap: 5 })
      await checkCapabilityCallCount(redis, runId, 'browser', { cap: 5 })

      expect(await capabilityCallCount(redis, runId, 'browser')).toBe(2)
      // Still 2: reading did not consume.
      expect(await capabilityCallCount(redis, runId, 'browser')).toBe(2)
    })
  })
})
