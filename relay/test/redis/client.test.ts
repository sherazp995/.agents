import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, Server, Socket } from 'net'
import type { Redis } from '../../src/redis/client.js'
import { closeRedis, createRedis, pingRedis, waitForReady } from '../../src/redis/client.js'
import { createLogger } from '../../src/obs/logger.js'

function captureLines(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  return {
    stream,
    lines: () => chunks.join('').split('\n').filter((line) => line.trim().length > 0),
  }
}

const url = process.env.RELAY_TEST_REDIS_URL

/**
 * `describeRedis` used to fall back to `describe.skip` when the var was
 * unset, so the suite could report a clean pass with the entire Redis
 * integration surface silently absent. vitest.config.ts now sets a local
 * default for RELAY_TEST_REDIS_URL, so this only fires when a caller has
 * explicitly overridden it to empty. When that happens, fail a named test
 * loudly instead of skipping, so `pnpm test` cannot report success with this
 * coverage missing.
 */
const describeRedis = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_REDIS_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_REDIS_URL is not set. vitest.config.ts provides a local default; this ' +
              'only fires when that default has been explicitly overridden to empty. Redis ' +
              'integration tests must fail, not silently skip, when it is absent.',
          )
        })
      })

describeRedis('redis client', () => {
  let redis: Redis

  // Constructed in beforeAll, never in the describe body. A skipped suite still
  // evaluates its body to collect tests, so connecting there would run even when
  // the suite is skipped and would throw on an undefined url.
  beforeAll(async () => {
    redis = createRedis(url as string)
    const ready = await waitForReady(redis)
    expect(ready).toBe(true)
  })

  afterAll(async () => {
    await closeRedis(redis)
  })

  it('responds to a ping', async () => {
    await expect(pingRedis(redis)).resolves.toBe(true)
  })

  it('round-trips a value', async () => {
    await redis.set('relay:test:key', 'value')
    await expect(redis.get('relay:test:key')).resolves.toBe('value')
    await redis.del('relay:test:key')
  })
})

describe('pingRedis on an unreachable server', () => {
  it('resolves false on connection refused rather than throwing', async () => {
    const redis = createRedis('redis://127.0.0.1:1')
    await expect(pingRedis(redis)).resolves.toBe(false)
    await closeRedis(redis)
  })
})

describe('pingRedis with a logger', () => {
  it('logs a failure reason without leaking the Redis URL or its password', async () => {
    const redis = createRedis('redis://user:s3cr3t-password@127.0.0.1:1')
    const { stream, lines } = captureLines()
    const log = createLogger('info', stream)

    await expect(pingRedis(redis, { log })).resolves.toBe(false)
    await closeRedis(redis)

    // Line count asserted before inspecting content, per the P0.1 finding 14
    // correction: a silent logger must not be able to satisfy this test.
    const emitted = lines()
    expect(emitted.length).toBeGreaterThan(0)
    const serialized = emitted.join('\n')
    expect(serialized).not.toContain('s3cr3t-password')
    expect(serialized).not.toContain('redis://user:s3cr3t-password@127.0.0.1:1')
  })
})

describe('waitForReady timeout behavior', () => {
  let silentServer: Server
  let silentPort: number
  const sockets = new Set<any>()

  beforeAll(async () => {
    return new Promise<void>((resolve) => {
      silentServer = createServer((socket) => {
        // Accept the connection but never speak the Redis protocol.
        // ioredis will complete TCP connection but never reach ready.
        sockets.add(socket)
        socket.on('close', () => {
          sockets.delete(socket)
        })
      })
      silentServer.listen(0, '127.0.0.1', () => {
        silentPort = (silentServer.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    return new Promise<void>((resolve) => {
      // Destroy all connected sockets to release the server
      for (const socket of sockets) {
        socket.destroy()
      }
      silentServer.close(() => {
        resolve()
      })
    })
  })

  it('timeout branch resolves false within bounded time', async () => {
    const redis = createRedis(`redis://127.0.0.1:${silentPort}`)
    const start = Date.now()
    const result = await waitForReady(redis, 200)
    const elapsed = Date.now() - start
    expect(result).toBe(false)
    // Assert the timeout path ran: at least 190ms elapsed (200ms timeout minus
    // some jitter), but well under 2 seconds (which would be an error path).
    expect(elapsed).toBeGreaterThanOrEqual(190)
    expect(elapsed).toBeLessThan(2000)
    await closeRedis(redis)
  })

  it('pingRedis on a silent server resolves false', async () => {
    const redis = createRedis(`redis://127.0.0.1:${silentPort}`)
    const result = await pingRedis(redis)
    expect(result).toBe(false)
    await closeRedis(redis)
  })
})

/**
 * Speaks just enough RESP to answer ioredis's pre-ready INFO command, so the
 * client reaches 'ready', but never answers anything else. This reproduces
 * the shape of the reviewer's finding precisely: a server that completes the
 * connection handshake and then withholds its reply to PING, as opposed to
 * the `waitForReady timeout behavior` suite above, whose server never even
 * lets the client reach ready.
 */
function createReadyThenSilentServer(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>()
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))

      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        for (;;) {
          const header = /^\*(\d+)\r\n/.exec(buffer)
          if (!header) break
          const argCount = Number(header[1])
          let cursor = header[0].length
          const args: string[] = []
          let complete = true
          for (let i = 0; i < argCount; i++) {
            const bulkHeader = /^\$(\d+)\r\n/.exec(buffer.slice(cursor))
            if (!bulkHeader) {
              complete = false
              break
            }
            const length = Number(bulkHeader[1])
            const valueStart = cursor + bulkHeader[0].length
            const valueEnd = valueStart + length
            if (buffer.length < valueEnd + 2) {
              complete = false
              break
            }
            args.push(buffer.slice(valueStart, valueEnd))
            cursor = valueEnd + 2
          }
          if (!complete) break
          buffer = buffer.slice(cursor)

          const command = (args[0] ?? '').toUpperCase()
          if (command === 'INFO') {
            // No `loading` field, so ioredis's ready check passes immediately.
            const body = 'role:master\r\nredis_version:7.0.0\r\n'
            socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`)
          }
          // Every other command, including PING, is read and discarded
          // without a reply: the withheld reply this test exists to probe.
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, port, sockets })
    })
  })
}

describe('pingRedis on a server that reaches ready but withholds its reply', () => {
  let server: Server
  let port: number
  let sockets: Set<Socket>

  beforeAll(async () => {
    ;({ server, port, sockets } = await createReadyThenSilentServer())
  })

  afterAll(async () => {
    return new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy()
      }
      server.close(() => resolve())
    })
  })

  it('resolves false within a bounded time instead of hanging on PING forever', async () => {
    const redis = createRedis(`redis://127.0.0.1:${port}`)
    const ready = await waitForReady(redis)
    // Confirms the fake server really did bring the client to 'ready', so
    // this test exercises the PING timeout path specifically, not the
    // ready-check timeout path already covered above.
    expect(ready).toBe(true)

    const start = Date.now()
    const result = await pingRedis(redis)
    const elapsed = Date.now() - start
    expect(result).toBe(false)
    expect(elapsed).toBeLessThan(8000)

    await closeRedis(redis)
  }, 15000)
})
