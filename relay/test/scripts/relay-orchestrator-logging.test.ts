import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../../src/obs/logger.js'
import { createDaemonLogger, withStartupDeadline } from '../../scripts/relay-orchestrator.js'
import type { RelayConfig } from '../../src/config/schema.js'

/**
 * A minimal, valid RelayConfig with only `logging` varying per test.
 * `Partial<RelayConfig['logging']>` rather than the full config type, since
 * createDaemonLogger only ever reads `config.logging`.
 */
function configWithLogging(logging: RelayConfig['logging']): RelayConfig {
  return {
    model_provider: { name: 'anthropic', zero_data_retention: true },
    database: { url: 'postgres://localhost:5432/relay' },
    redis: { url: 'redis://localhost:6379' },
    logging,
    secrets: { provider: 'keychain' },
  }
}

describe('createDaemonLogger (FR-OBS-1: wiring rotation into the daemon)', () => {
  const dirsToClean: string[] = []

  afterEach(() => {
    while (dirsToClean.length > 0) {
      const dir = dirsToClean.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves stdout logging unchanged when logging.file is not configured', async () => {
    const originalWrite = process.stdout.write.bind(process.stdout)
    const chunks: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const logger = await createDaemonLogger(configWithLogging({ level: 'info' }))
      logger.info('daemon-logging-test-stdout-marker')
    } finally {
      process.stdout.write = originalWrite
    }

    expect(chunks.join('')).toContain('daemon-logging-test-stdout-marker')
  })

  it('wires a configured logging.file to a real rotating destination on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-daemon-log-'))
    dirsToClean.push(dir)
    const file = join(dir, 'relay.log')

    // createDaemonLogger only resolves once the underlying stream has
    // actually opened (see its own probeOpens), so the file's existence
    // right after awaiting it is a direct proof of the wiring, independent
    // of pino's own write timing.
    await createDaemonLogger(configWithLogging({ level: 'info', file }))

    expect(existsSync(file)).toBe(true)
  })

  it('respects configured rotation caps rather than only ever using the module defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-daemon-log-caps-'))
    dirsToClean.push(dir)
    const file = join(dir, 'relay.log')

    const logger = await createDaemonLogger(
      configWithLogging({ level: 'info', file, max_size_bytes: 500, max_files: 2 }),
    )
    // A line comfortably larger than max_size_bytes forces at least one
    // rotation, proving the configured cap (not the 20 MiB module default)
    // is the one actually in effect.
    for (let i = 0; i < 20; i++) logger.info('x'.repeat(100))
    await new Promise((resolve) => setTimeout(resolve, 200))

    const rotatedFiles = readdirSync(dir).filter((name) => name !== 'relay.log' && !name.endsWith('.history'))
    expect(rotatedFiles.length).toBeGreaterThanOrEqual(1)
  })

  it('fails to start rather than silently dropping logs when the configured file cannot be opened', async () => {
    const unopenable = join('/nonexistent-relay-daemon-log-dir-xyz', 'relay.log')
    await expect(createDaemonLogger(configWithLogging({ level: 'info', file: unopenable }))).rejects.toThrow(
      /could not open configured log file/,
    )
  })
})

describe('withStartupDeadline: a startup that finishes after being given up on', () => {
  function silentLogger(): { logger: Logger; warnings: string[]; errors: string[] } {
    const warnings: string[] = []
    const errors: string[] = []
    const logger = {
      info: () => {},
      warn: (first: unknown, second?: unknown) => {
        warnings.push(typeof first === 'string' ? first : String(second ?? ''))
      },
      error: (first: unknown, second?: unknown) => {
        errors.push(typeof first === 'string' ? first : String(second ?? ''))
      },
      debug: () => {},
      fatal: () => {},
      trace: () => {},
    } as unknown as Logger
    return { logger, warnings, errors }
  }

  it('STOPS the orphan, so it cannot install timers on resources that were already torn down', async () => {
    // The production failure this pins down. Racing a pending startup
    // against a deadline abandons the startup, it does not cancel it. Slack's
    // websocket completed two minutes after the deadline had fired, and the
    // handle it returned installed its outbound-drain timer on a pool the
    // failure path had already closed. That timer threw every two seconds
    // AND held the event loop open, so the process ran forever, was listed
    // by pgrep, had never connected to Slack, and could not serve anything.
    // It looked alive.
    const { logger, warnings } = silentLogger()
    let stopped = false
    let resolveLate: ((value: { stop: () => Promise<void> }) => void) | undefined
    const pending = new Promise<{ stop: () => Promise<void> }>((resolve) => {
      resolveLate = resolve
    })

    await expect(
      withStartupDeadline(pending, 10, logger, (late) => late.stop()),
    ).rejects.toThrow(/startup did not complete within 10ms/)

    // The late arrival, long after the caller gave up.
    resolveLate?.({
      stop: async () => {
        stopped = true
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(stopped).toBe(true)
    expect(warnings.some((line) => line.includes('orphaned startup'))).toBe(true)
  })

  it('does NOT dispose a startup that finished in time, which is the ordinary case', async () => {
    const { logger } = silentLogger()
    let stopped = false

    const handle = await withStartupDeadline(
      Promise.resolve({ stop: async () => { stopped = true } }),
      10_000,
      logger,
      (late) => late.stop(),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(handle).toBeDefined()
    expect(stopped).toBe(false)
  })

  it('does not try to dispose a startup that failed on its own', async () => {
    const { logger } = silentLogger()
    const dispose = vi.fn()

    await expect(
      withStartupDeadline(Promise.reject(new Error('slack refused')), 10_000, logger, dispose),
    ).rejects.toThrow('slack refused')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(dispose).not.toHaveBeenCalled()
  })
})
