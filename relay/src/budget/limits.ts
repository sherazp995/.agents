/**
 * FR-POL-7's rate and count controls: "per-origin request rate limits;
 * per-capability call-count caps."
 *
 * The currency and token caps live in `meter.ts`, in Postgres, because money
 * spent must survive a restart and must be reconciled exactly. These two are
 * different in kind and live in Redis for the same reason: they are about
 * the SHAPE of activity in a window, they are worthless once the window
 * passes, and losing them on a restart costs nothing worse than a run
 * briefly getting a fresh allowance.
 *
 * WHY A SLIDING WINDOW RATHER THAN A FIXED ONE. A fixed bucket resets on the
 * hour, so a limit of 60 per minute permits 120 requests across two seconds
 * that happen to straddle the boundary. Against a real site that is the
 * burst that gets an operator's account rate-limited or blocked, which is
 * the exact outcome the cap exists to avoid. The sorted-set approach here
 * costs one extra command and has no boundary.
 *
 * WHAT A REFUSAL MEANS. Both of these refuse the CALL, not the run. A run
 * that hits a per-capability cap has almost certainly gone into a loop, and
 * the useful thing is to stop that capability and let the run report what it
 * has, rather than to kill the run and lose the work.
 */

import type { Redis } from '../redis/client.js'

/** Sensible defaults. Deliberately generous: a cap that fires during ordinary work is one an operator raises without reading. */
export const DEFAULT_ORIGIN_RATE_LIMIT = 60
export const DEFAULT_ORIGIN_RATE_WINDOW_SECONDS = 60
export const DEFAULT_CAPABILITY_CALL_CAP = 200

export type LimitDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly reason: string; readonly retryAfterSeconds?: number }

function originKey(workspaceId: string, origin: string): string {
  return `relay:ratelimit:origin:${workspaceId}:${origin.toLowerCase()}`
}

function capabilityKey(runId: string, capability: string): string {
  return `relay:callcount:${runId}:${capability}`
}

/**
 * FR-POL-7's per-origin request rate limit, as a sliding window.
 *
 * Implemented with a sorted set keyed by timestamp: drop everything older
 * than the window, count what is left, and add this request only if there is
 * room. The `now` parameter is injected rather than read here so the window
 * behaviour is testable without sleeping, which is the difference between a
 * test that proves the boundary and one that hopes.
 */
export async function checkOriginRate(
  redis: Redis,
  workspaceId: string,
  origin: string,
  options: { readonly limit?: number; readonly windowSeconds?: number; readonly now?: number } = {},
): Promise<LimitDecision> {
  const limit = options.limit ?? DEFAULT_ORIGIN_RATE_LIMIT
  const windowSeconds = options.windowSeconds ?? DEFAULT_ORIGIN_RATE_WINDOW_SECONDS
  const now = options.now ?? Date.now()
  const key = originKey(workspaceId, origin)
  const cutoff = now - windowSeconds * 1000

  const pipeline = redis.multi()
  pipeline.zremrangebyscore(key, 0, cutoff)
  pipeline.zcard(key)
  const results = await pipeline.exec()
  const used = Number(results?.[1]?.[1] ?? 0)

  if (used >= limit) {
    // The oldest entry decides when room next appears, which is a far more
    // useful answer than "try again later".
    const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES')
    const oldestAt = Number(oldest[1] ?? now)
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestAt + windowSeconds * 1000 - now) / 1000))
    return {
      allowed: false,
      retryAfterSeconds,
      reason:
        `${limit} requests to ${origin} in the last ${windowSeconds}s is this workspace's rate limit (FR-POL-7), so ` +
        `this one was not sent. Room opens in about ${retryAfterSeconds}s. The cap exists to stop a run getting the ` +
        'operator\'s account rate-limited or blocked by the site itself.',
    }
  }

  // A distinct member per request, since two requests in the same
  // millisecond would otherwise collapse into one sorted-set entry and the
  // window would undercount exactly when it is under most pressure.
  await redis.zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 10)}`)
  await redis.expire(key, windowSeconds * 2)

  return { allowed: true, remaining: limit - used - 1 }
}

/**
 * FR-POL-7's per-capability call-count cap, per run.
 *
 * A run that hits this has almost certainly looped: a real task does not
 * call one capability two hundred times. So the message says so, because an
 * operator reading "cap reached" reaches for a bigger cap, and an operator
 * reading "this looks like a loop" goes and looks at the run.
 */
export async function checkCapabilityCallCount(
  redis: Redis,
  runId: string,
  capability: string,
  options: { readonly cap?: number; readonly ttlSeconds?: number } = {},
): Promise<LimitDecision> {
  const cap = options.cap ?? DEFAULT_CAPABILITY_CALL_CAP
  const key = capabilityKey(runId, capability)

  const used = await redis.incr(key)
  // Set on first use only, so a long run does not keep pushing its own
  // expiry out and outlive the retention it was meant to have.
  if (used === 1) await redis.expire(key, options.ttlSeconds ?? 24 * 60 * 60)

  if (used > cap) {
    return {
      allowed: false,
      reason:
        `this run has called "${capability}" ${used - 1} times, which is its cap (FR-POL-7), so the call was ` +
        'refused. A task that needs one capability this many times has almost certainly looped rather than made ' +
        'progress; the run can still report what it has done so far.',
    }
  }

  return { allowed: true, remaining: cap - used }
}

/** Reads the current count without consuming one, for reporting. */
export async function capabilityCallCount(redis: Redis, runId: string, capability: string): Promise<number> {
  const value = await redis.get(capabilityKey(runId, capability))
  return value === null ? 0 : Number(value)
}
