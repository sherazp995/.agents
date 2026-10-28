import { Redis } from 'ioredis'
import type { MaybeLogger } from '../obs/context.js'

export type { Redis }

/**
 * Creates the Redis client. Retries are bounded and lazy connection is off,
 * so an unreachable server surfaces quickly in `relay doctor` rather than
 * retrying forever behind a healthy-looking process.
 */
export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 2 ? null : 100),
    lazyConnect: false,
    enableOfflineQueue: false,
  })
  // Swallow error events from unreachable servers. This module's contract is
  // to report unreachability (via pingRedis resolving false or waitForReady
  // timing out) rather than to throw, so clients don't need to add handlers.
  redis.on('error', () => {})
  return redis
}

/** Closes the client. Safe to call on a client that never connected. */
export async function closeRedis(redis: Redis): Promise<void> {
  redis.disconnect()
}

/**
 * Waits for the Redis client to reach the ready state. Resolves true when
 * ready, false on an error event or when the timeout elapses, whichever comes
 * first. Never throws or hangs past the timeout. Removes its own listeners
 * before resolving so it leaks nothing.
 */
export async function waitForReady(
  redis: Redis,
  timeoutMs = 5000
): Promise<boolean> {
  return new Promise((resolve) => {
    if (redis.status === 'ready') {
      resolve(true)
      return
    }

    const readyHandler = () => {
      clearTimeout(timer)
      redis.off('ready', readyHandler)
      redis.off('error', errorHandler)
      resolve(true)
    }

    const errorHandler = () => {
      clearTimeout(timer)
      redis.off('ready', readyHandler)
      redis.off('error', errorHandler)
      resolve(false)
    }

    const timer = setTimeout(() => {
      redis.off('ready', readyHandler)
      redis.off('error', errorHandler)
      resolve(false)
    }, timeoutMs)

    redis.on('ready', readyHandler)
    redis.on('error', errorHandler)
  })
}

const PING_TIMEOUT_MS = 5000

/**
 * Races a promise against a bounded timeout. Rejects on timeout rather than
 * hanging; the original promise is left to settle on its own (its
 * settlement, whenever it happens, is a no-op against this already-settled
 * result), so nothing here holds a socket or command open longer than it
 * otherwise would have.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Health probe. Resolves false rather than throwing, because the caller is a
 * diagnostic that must report every check, not abort on the first failure.
 * If the client is not yet ready, awaits readiness first with a bounded
 * timeout. The PING itself is also bounded: a server that completes the
 * connection handshake and reaches 'ready' but then withholds its reply to a
 * command would otherwise leave this promise pending forever, since ioredis
 * has no built-in command timeout.
 *
 * `options.log`, when supplied, receives one line explaining why the probe
 * failed whenever this resolves false. This function never sees the Redis
 * URL, only the already-connected client, so nothing logged here can carry
 * the password a Redis URL may embed. Optional and unused by default: a
 * caller that omits it gets exactly the previous behaviour.
 */
export async function pingRedis(redis: Redis, options: MaybeLogger = {}): Promise<boolean> {
  try {
    if (redis.status !== 'ready') {
      const ready = await waitForReady(redis)
      if (!ready) {
        options.log?.warn('redis ping failed: client never became ready')
        return false
      }
    }
    const alive = (await withTimeout(redis.ping(), PING_TIMEOUT_MS)) === 'PONG'
    if (!alive) {
      options.log?.warn('redis ping failed: unexpected reply to PING')
    }
    return alive
  } catch (error) {
    options.log?.warn({ reason: (error as Error).message }, 'redis ping failed')
    return false
  }
}
