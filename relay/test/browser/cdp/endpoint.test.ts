import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DEVTOOLS_ACTIVE_PORT_FILE,
  launchTier2Chrome,
  parseDevToolsActivePort,
  tier2ChromeArgs,
} from '../../../src/browser/cdp/endpoint.js'
import type { SpawnTier2ChromeFn, Tier2ChromeHandle } from '../../../src/browser/cdp/endpoint.js'
import { profileEntrySchema } from '../../../src/profiles/schema.js'
import type { ProfileEntry } from '../../../src/profiles/schema.js'

const HOME = '/Users/op'
const DEFAULT_CHROME_DIR = join(HOME, 'Library', 'Application Support', 'Google', 'Chrome')
const AUTOMATION_DIR = '/Users/op/chrome-relay/acme'

function buildProfile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return profileEntrySchema.parse({
    name: 'acme',
    description: 'Acme client work',
    user_data_dir: AUTOMATION_DIR,
    profile_directory: 'Default',
    classification: 'client',
    allowed_origins: ['*.acme.com'],
    ...overrides,
  })
}

/** A spawned process the test drives by hand: it can exit, fail to spawn, or simply stay up. */
function fakeHandle(pid: number | undefined = 7777): {
  readonly handle: Tier2ChromeHandle
  exit(code: number | null): void
  spawnError(error: Error): void
  readonly killCalls: number
} {
  const exitListeners: Array<(code: number | null) => void> = []
  const errorListeners: Array<(error: Error) => void> = []
  let killCalls = 0
  return {
    handle: {
      pid,
      onExit: (listener) => {
        exitListeners.push(listener)
      },
      onSpawnError: (listener) => {
        errorListeners.push(listener)
      },
      kill: () => {
        killCalls++
      },
    },
    exit: (code) => {
      for (const listener of exitListeners) listener(code)
    },
    spawnError: (error) => {
      for (const listener of errorListeners) listener(error)
    },
    get killCalls() {
      return killCalls
    },
  }
}

/**
 * A fake filesystem for the one file this module reads. `writeAfter` makes
 * the port file appear only once the poll loop has read it that many times,
 * which is how a test exercises "waited, then found it" without waiting.
 */
function fakePortFile(options: { readonly contents?: string; readonly appearAfterReads?: number } = {}): {
  readonly readPortFile: (path: string) => string | undefined
  readonly removePortFile: (path: string) => void
  readonly removed: string[]
  readonly reads: string[]
} {
  const removed: string[] = []
  const reads: string[] = []
  const appearAfter = options.appearAfterReads ?? 0
  return {
    readPortFile: (path) => {
      reads.push(path)
      if (options.contents === undefined) return undefined
      return reads.length > appearAfter ? options.contents : undefined
    },
    removePortFile: (path) => {
      removed.push(path)
    },
    removed,
    reads,
  }
}

function instantSleep(): Promise<void> {
  return Promise.resolve()
}

/** A clock that advances by a fixed step every time it is read, so a timeout is reached deterministically without wall time. */
function steppingClock(stepMs: number): () => number {
  let current = 0
  return () => {
    const value = current
    current += stepMs
    return value
  }
}

describe('parseDevToolsActivePort', () => {
  it('builds the browser websocket url from the two lines chrome writes', () => {
    expect(parseDevToolsActivePort('54321\n/devtools/browser/9f0a-1234\n')).toEqual({
      webSocketDebuggerUrl: 'ws://127.0.0.1:54321/devtools/browser/9f0a-1234',
      port: 54321,
    })
  })

  it('rejects a half-written file rather than inventing a url from it', () => {
    expect(parseDevToolsActivePort('54321')).toBeUndefined()
    expect(parseDevToolsActivePort('')).toBeUndefined()
  })

  it('rejects a second line that is not a devtools browser path', () => {
    expect(parseDevToolsActivePort('54321\n/json/version')).toBeUndefined()
  })

  it('rejects a port that is not a usable tcp port', () => {
    expect(parseDevToolsActivePort('0\n/devtools/browser/x')).toBeUndefined()
    expect(parseDevToolsActivePort('70000\n/devtools/browser/x')).toBeUndefined()
    expect(parseDevToolsActivePort('not-a-port\n/devtools/browser/x')).toBeUndefined()
  })
})

describe('tier2ChromeArgs', () => {
  it('asks chrome for an ephemeral debugging port so two profiles never collide on a fixed one', () => {
    const args = tier2ChromeArgs({ userDataDir: AUTOMATION_DIR, profileDirectory: 'Default', headless: true })
    expect(args).toContain('--remote-debugging-port=0')
    expect(args).toContain(`--user-data-dir=${AUTOMATION_DIR}`)
    expect(args).toContain('--profile-directory=Default')
  })

  it('adds the headless switch only when headless was asked for', () => {
    const headless = tier2ChromeArgs({ userDataDir: AUTOMATION_DIR, profileDirectory: 'Default', headless: true })
    const headful = tier2ChromeArgs({ userDataDir: AUTOMATION_DIR, profileDirectory: 'Default', headless: false })
    expect(headless).toContain('--headless=new')
    expect(headful).not.toContain('--headless=new')
  })

  it('switches off the background traffic no declared egress destination covers', () => {
    const args = tier2ChromeArgs({ userDataDir: AUTOMATION_DIR, profileDirectory: 'Default', headless: true })
    expect(args).toContain('--disable-background-networking')
    expect(args).toContain('--disable-component-update')
    expect(args).toContain('--disable-sync')
  })
})

describe('launchTier2Chrome', () => {
  it('reports the endpoint once the port file appears', async () => {
    const fake = fakeHandle(4242)
    const spawnChrome: SpawnTier2ChromeFn = vi.fn(() => fake.handle)
    const files = fakePortFile({ contents: '61000\n/devtools/browser/abc\n' })

    const result = await launchTier2Chrome(buildProfile(), {
      spawnChrome,
      readPortFile: files.readPortFile,
      removePortFile: files.removePortFile,
      sleep: instantSleep,
      home: HOME,
      platform: 'darwin',
    })

    expect(result.outcome).toBe('ready')
    if (result.outcome !== 'ready') return
    expect(result.endpoint.webSocketDebuggerUrl).toBe('ws://127.0.0.1:61000/devtools/browser/abc')
    expect(result.pid).toBe(4242)
  })

  it('SELF-ATTACK, the stale-file trap: removes the port file BEFORE spawning, so a leftover port from a dead browser is never read as this launch', async () => {
    const fake = fakeHandle()
    const order: string[] = []
    const spawnChrome: SpawnTier2ChromeFn = () => {
      order.push('spawn')
      return fake.handle
    }

    await launchTier2Chrome(buildProfile(), {
      spawnChrome,
      readPortFile: () => {
        order.push('read')
        return '61000\n/devtools/browser/abc\n'
      },
      removePortFile: () => {
        order.push('remove')
      },
      sleep: instantSleep,
      home: HOME,
      platform: 'darwin',
    })

    expect(order[0]).toBe('remove')
    expect(order.indexOf('remove')).toBeLessThan(order.indexOf('spawn'))
  })

  it('removes the port file from the profile\'s own user-data directory, not somewhere else', async () => {
    const fake = fakeHandle()
    const files = fakePortFile({ contents: '61000\n/devtools/browser/abc\n' })

    await launchTier2Chrome(buildProfile(), {
      spawnChrome: () => fake.handle,
      readPortFile: files.readPortFile,
      removePortFile: files.removePortFile,
      sleep: instantSleep,
      home: HOME,
      platform: 'darwin',
    })

    expect(files.removed).toEqual([join(AUTOMATION_DIR, DEVTOOLS_ACTIVE_PORT_FILE)])
  })

  it('keeps polling while the file is still half-written rather than failing on the first unreadable read', async () => {
    const fake = fakeHandle()
    const files = fakePortFile({ contents: '61000\n/devtools/browser/abc\n', appearAfterReads: 3 })

    const result = await launchTier2Chrome(buildProfile(), {
      spawnChrome: () => fake.handle,
      readPortFile: files.readPortFile,
      removePortFile: files.removePortFile,
      sleep: instantSleep,
      home: HOME,
      platform: 'darwin',
    })

    expect(result.outcome).toBe('ready')
    expect(files.reads.length).toBeGreaterThan(3)
  })

  it('refuses outright for a default chrome user-data directory, and starts no browser at all', async () => {
    const spawnChrome = vi.fn()

    const result = await launchTier2Chrome(buildProfile({ user_data_dir: DEFAULT_CHROME_DIR }), {
      spawnChrome: spawnChrome as unknown as SpawnTier2ChromeFn,
      home: HOME,
      platform: 'darwin',
    })

    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') return
    expect(result.reason).toContain('FR-PRF-6a')
    expect(result.handle).toBeUndefined()
    expect(spawnChrome).not.toHaveBeenCalled()
  })

  it('reports the single-instance hand-off when chrome exits before writing the port file', async () => {
    const fake = fakeHandle()
    const files = fakePortFile()

    const promise = launchTier2Chrome(buildProfile(), {
      spawnChrome: () => {
        // Exits on the next tick, after the loop has started polling.
        queueMicrotask(() => {
          fake.exit(0)
        })
        return fake.handle
      },
      readPortFile: files.readPortFile,
      removePortFile: files.removePortFile,
      sleep: instantSleep,
      home: HOME,
      platform: 'darwin',
    })

    const result = await promise
    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') return
    expect(result.reason).toContain('before writing DevToolsActivePort')
    expect(result.reason).toContain('FR-PRF-6a')
  })

  it('reports a spawn failure as a launch failure, naming the underlying error', async () => {
    const fake = fakeHandle()
    const files = fakePortFile()

    const result = await launchTier2Chrome(buildProfile(), {
      spawnChrome: () => {
        queueMicrotask(() => {
          fake.spawnError(new Error('ENOENT: no chrome here'))
        })
        return fake.handle
      },
      readPortFile: files.readPortFile,
      removePortFile: files.removePortFile,
      sleep: instantSleep,
      home: HOME,
      platform: 'darwin',
    })

    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') return
    expect(result.reason).toContain('ENOENT: no chrome here')
  })

  it('gives up with a stated reason rather than polling forever when the port file never appears', async () => {
    const fake = fakeHandle()
    const files = fakePortFile()

    const result = await launchTier2Chrome(buildProfile(), {
      spawnChrome: () => fake.handle,
      readPortFile: files.readPortFile,
      removePortFile: files.removePortFile,
      sleep: instantSleep,
      now: steppingClock(100),
      readyTimeoutMs: 1_000,
      home: HOME,
      platform: 'darwin',
    })

    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') return
    expect(result.reason).toContain('did not write DevToolsActivePort within 1000ms')
    // The handle is returned on a timeout precisely so the caller can kill a
    // browser that came up but never became drivable, instead of leaking it.
    expect(result.handle).toBeDefined()
  })
})
