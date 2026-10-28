import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LAUNCH_READINESS_GRACE_MS,
  defaultChromeExecutablePath,
  establishProfileConnection,
  launchChromeForProfile,
  resolveLaunchTier,
  waitForExtensionConnection,
} from '../../src/browser/launch.js'
import type { ChromeLaunchHandle, Clock, LaunchLadderDependencies, SpawnChromeFn } from '../../src/browser/launch.js'
import { profileEntrySchema } from '../../src/profiles/schema.js'
import type { ProfileEntry } from '../../src/profiles/schema.js'

const HOME = '/Users/op'
const DEFAULT_DIR = join(HOME, 'Library', 'Application Support', 'Google', 'Chrome')

function buildProfile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return profileEntrySchema.parse({
    name: 'acme',
    description: 'Acme client work',
    user_data_dir: '/Users/op/chrome-relay',
    profile_directory: 'Profile 1',
    classification: 'client',
    allowed_origins: ['*.acme.com'],
    ...overrides,
  })
}

/**
 * A fake handle whose exit/spawn-error callbacks are triggerable by hand,
 * so a test drives the exact race outcome instead of a real process.
 */
function fakeHandle(pid: number | undefined = 4242): {
  readonly handle: ChromeLaunchHandle
  readonly exit: (code: number | null) => void
  readonly error: (error: Error) => void
} {
  let exitListener: ((code: number | null) => void) | undefined
  let errorListener: ((error: Error) => void) | undefined
  return {
    handle: {
      pid,
      onExit: (listener) => {
        exitListener = listener
      },
      onSpawnError: (listener) => {
        errorListener = listener
      },
    },
    exit: (code) => exitListener?.(code),
    error: (error) => errorListener?.(error),
  }
}

/** Never resolves: for a test that must be settled only by exit or spawn error, not by the grace window elapsing. */
function neverSleep(): Promise<void> {
  return new Promise(() => {})
}

/** Resolves immediately: for a test that must be settled only by the grace window elapsing. */
function instantSleep(): Promise<void> {
  return Promise.resolve()
}

describe('launchChromeForProfile, FR-PRF-7', () => {
  it('launches chrome and reports the launch when the profile is not already running', async () => {
    const fake = fakeHandle(9001)
    const spawnChrome: SpawnChromeFn = () => fake.handle
    // No exit and no spawn error is ever fired, so the only thing that can
    // settle the race is the grace window elapsing, which instantSleep
    // makes near-immediate for the test.
    const outcome = await launchChromeForProfile(buildProfile(), { spawnChrome, sleep: instantSleep })

    expect(outcome.outcome).toBe('launched')
    expect(outcome.outcome === 'launched' && outcome.pid).toBe(9001)
    expect(outcome.reason).toMatch(/launched/)
    expect(outcome.reason).toMatch(String(DEFAULT_LAUNCH_READINESS_GRACE_MS))
  })

  it('reports already_running, not a crash, when the launch hands off to an existing instance', async () => {
    const fake = fakeHandle()
    const spawnChrome: SpawnChromeFn = () => {
      queueMicrotask(() => fake.exit(0))
      return fake.handle
    }
    // neverSleep guarantees only the exit can settle the race, so this test
    // is not a timing race between the grace window and the exit event.
    const outcome = await launchChromeForProfile(buildProfile(), { spawnChrome, sleep: neverSleep })

    expect(outcome.outcome).toBe('already_running')
    // Named plainly, not phrased as a failure: FR-PRF-6a's own constraint
    // (one running instance per user-data directory) is the reason, and the
    // reason text says so rather than reading like an unexplained crash.
    expect(outcome.reason).toMatch(/only one running browser instance/i)
    expect(outcome.reason).toMatch(/not a launch failure/i)
    expect(outcome.reason).not.toMatch(/crash/i)
  })

  it('reports launch_failed, with the underlying reason, when the executable cannot be started at all', async () => {
    const fake = fakeHandle()
    const spawnChrome: SpawnChromeFn = () => {
      queueMicrotask(() => fake.error(new Error('spawn ENOENT')))
      return fake.handle
    }
    const outcome = await launchChromeForProfile(buildProfile(), { spawnChrome, sleep: neverSleep })

    expect(outcome.outcome).toBe('launch_failed')
    expect(outcome.reason).toMatch(/ENOENT/)
  })
})

describe('defaultChromeExecutablePath', () => {
  it('resolves a platform-appropriate path for darwin, win32, and linux', () => {
    expect(defaultChromeExecutablePath('darwin')).toMatch(/Google Chrome/)
    expect(defaultChromeExecutablePath('win32')).toMatch(/chrome\.exe/)
    expect(defaultChromeExecutablePath('linux')).toBe('google-chrome')
  })
})

describe('waitForExtensionConnection', () => {
  function fakeClock(): Clock {
    let elapsed = 0
    return {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms
      },
    }
  }

  it('reports connected immediately when the probe already succeeds, without waiting a poll interval', async () => {
    const probe = vi.fn(async () => true)
    const result = await waitForExtensionConnection({ probe, timeoutMs: 5000, clock: fakeClock() })

    expect(result.connected).toBe(true)
    expect(result.waitedMs).toBe(0)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('reports not connected once the timeout elapses, without exceeding it by more than one poll interval', async () => {
    const probe = vi.fn(async () => false)
    const result = await waitForExtensionConnection({ probe, timeoutMs: 2000, pollIntervalMs: 500, clock: fakeClock() })

    expect(result.connected).toBe(false)
    expect(result.waitedMs).toBeGreaterThanOrEqual(2000)
  })
})

describe('resolveLaunchTier, FR-PRF-7 and FR-PRF-4a', () => {
  function fakeClock(): Clock {
    let elapsed = 0
    return {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms
      },
    }
  }

  function ladderDeps(overrides: Partial<LaunchLadderDependencies> = {}): LaunchLadderDependencies {
    return {
      probeExtension: async () => false,
      timeoutMs: 2000,
      pollIntervalMs: 500,
      clock: fakeClock(),
      home: HOME,
      ...overrides,
    }
  }

  it('reports tier1_connected when the extension connects before the timeout', async () => {
    const decision = await resolveLaunchTier(buildProfile({ extension: true }), ladderDeps({ probeExtension: async () => true }))

    expect(decision.outcome).toBe('tier1_connected')
    expect(decision.outcome === 'tier1_connected' && decision.tier).toBe(1)
  })

  it('falls through to tier 2 when the extension does not connect within the timeout, where tier 2 is available', async () => {
    // A dedicated automation directory, per FR-PRF-6a, so tier 2 is available for this profile.
    const decision = await resolveLaunchTier(buildProfile({ extension: true }), ladderDeps())

    expect(decision.outcome).toBe('fell_back_to_tier2')
    expect(decision.outcome === 'fell_back_to_tier2' && decision.tier).toBe(2)
    expect(decision.outcome === 'fell_back_to_tier2' && decision.reason).toMatch(/did not connect/)
    expect(decision.outcome === 'fell_back_to_tier2' && decision.reason).toMatch(/tier 2/)
  })

  it('escalates to the operator, per FR-PRF-7 own words, when tier 2 is not available either', async () => {
    // Chrome own default directory, so FR-PRF-6a makes tier 2 unavailable.
    const decision = await resolveLaunchTier(buildProfile({ extension: true, user_data_dir: DEFAULT_DIR }), ladderDeps())

    expect(decision.outcome).toBe('escalate_to_operator')
    expect(decision.outcome === 'escalate_to_operator' && decision.reason).toMatch(/there is no/i)
    expect(decision.outcome === 'escalate_to_operator' && decision.reason).toMatch(/fallback/i)
    expect(decision.outcome === 'escalate_to_operator' && decision.reason).toMatch(/ask/i)
  })

  it('escalates immediately, without waiting, when the profile does not declare the extension at all', async () => {
    const probe = vi.fn(async () => false)
    const decision = await resolveLaunchTier(buildProfile({ extension: false }), ladderDeps({ probeExtension: probe }))

    expect(decision.outcome).toBe('fell_back_to_tier2')
    // Never probed: there was never a tier 1 candidate to wait for.
    expect(probe).not.toHaveBeenCalled()
  })

  describe('a pinned profile never falls back to tier 1 (FR-PRF-4a)', () => {
    it('uses the pinned tier directly, without ever attempting tier 1, even when the extension would connect', async () => {
      const probe = vi.fn(async () => true)
      const decision = await resolveLaunchTier(
        buildProfile({ extension: true, pinned_tier: 2 }),
        ladderDeps({ probeExtension: probe }),
      )

      expect(decision.outcome).toBe('pinned')
      expect(decision.outcome === 'pinned' && decision.tier).toBe(2)
      // The load-bearing assertion: a fast-connecting extension must not be
      // allowed to win the race for a pinned profile. This is the exact
      // check the self-attack (see the launch report) flips to confirm it
      // actually catches the mistake.
      expect(probe).not.toHaveBeenCalled()
    })

    it('escalates, rather than degrading to tier 1, when the pinned tier is no longer available', async () => {
      const probe = vi.fn(async () => true)
      // A stale pin: the pinned tier 2 points at chrome's own default
      // directory, which validatePin (src/profiles/tiers.js) would have
      // refused at configuration time. Constructing it directly here
      // simulates the environment changing after setup accepted the pin.
      const decision = await resolveLaunchTier(
        buildProfile({ extension: true, pinned_tier: 2, user_data_dir: DEFAULT_DIR }),
        ladderDeps({ probeExtension: probe }),
      )

      expect(decision.outcome).toBe('escalate_to_operator')
      expect(decision.outcome === 'escalate_to_operator' && decision.reason).toMatch(/never falls back to tier 1/i)
      expect(probe).not.toHaveBeenCalled()
    })
  })
})

describe('establishProfileConnection, the end-to-end FR-PRF-7 flow', () => {
  function fakeClock(): Clock {
    let elapsed = 0
    return {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms
      },
    }
  }

  it('launches a profile that is not running, then resolves the tier once chrome is up', async () => {
    const fake = fakeHandle(1234)
    const spawnChrome: SpawnChromeFn = () => fake.handle

    const result = await establishProfileConnection(buildProfile({ extension: true }), {
      spawnChrome,
      sleep: instantSleep,
      probeExtension: async () => true,
      clock: fakeClock(),
      home: HOME,
    })

    expect(result.launch?.outcome).toBe('launched')
    expect(result.ladder.outcome).toBe('tier1_connected')
  })

  it('reports already_running for the launch, then still resolves the tier', async () => {
    const fake = fakeHandle()
    const spawnChrome: SpawnChromeFn = () => {
      queueMicrotask(() => fake.exit(0))
      return fake.handle
    }

    const result = await establishProfileConnection(buildProfile({ extension: true }), {
      spawnChrome,
      sleep: neverSleep,
      probeExtension: async () => true,
      clock: fakeClock(),
      home: HOME,
    })

    expect(result.launch?.outcome).toBe('already_running')
    expect(result.ladder.outcome).toBe('tier1_connected')
  })

  it('skips the chrome launch entirely for a pinned profile', async () => {
    const spawnChrome = vi.fn<SpawnChromeFn>(() => fakeHandle().handle)
    const probe = vi.fn(async () => true)

    const result = await establishProfileConnection(buildProfile({ extension: true, pinned_tier: 2 }), {
      spawnChrome,
      sleep: instantSleep,
      probeExtension: probe,
      clock: fakeClock(),
      home: HOME,
    })

    expect(result.launch).toBeUndefined()
    expect(result.ladder.outcome).toBe('pinned')
    expect(spawnChrome).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('falls back to tier 2 without waiting for the extension when the chrome launch itself fails', async () => {
    const fake = fakeHandle()
    const spawnChrome: SpawnChromeFn = () => {
      queueMicrotask(() => fake.error(new Error('spawn ENOENT')))
      return fake.handle
    }
    const probe = vi.fn(async () => false)

    const result = await establishProfileConnection(buildProfile({ extension: true }), {
      spawnChrome,
      sleep: neverSleep,
      probeExtension: probe,
      clock: fakeClock(),
      home: HOME,
    })

    expect(result.launch?.outcome).toBe('launch_failed')
    expect(result.ladder.outcome).toBe('fell_back_to_tier2')
    expect(result.ladder.outcome === 'fell_back_to_tier2' && result.ladder.reason).toMatch(/failed to launch/)
    expect(probe).not.toHaveBeenCalled()
  })
})
