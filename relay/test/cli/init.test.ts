/**
 * Tests for src/cli/init.ts. Every side-effecting or blocking dependency
 * (prompts, the clock, home/platform for tier detection, and the final
 * doctor pass) is injected, so these run fast and hermetically: no real
 * terminal, no real Postgres or Redis, no dependency on this machine's own
 * home directory. Fixtures live under a fresh os.tmpdir() directory per
 * test, never under the repo's own config/.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadPolicy, loadRelayConfig } from '../../src/config/load.js'
import {
  DEFAULT_HARD_BLOCKED_ORIGINS,
  type DoctorRunner,
  type InitOptions,
  mergeHardBlockedOrigins,
  runInit,
} from '../../src/cli/init.js'

const okDoctor: DoctorRunner = async () => ({ results: [], exitCode: 0 })

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relay-init-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Every field a real InitOptions needs, so each test only overrides what it's testing. */
function baseOptions(overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    configPath: join(dir, 'relay.config.yaml'),
    policyPath: join(dir, 'policy.yaml'),
    profilesPath: join(dir, 'profiles.yaml'),
    profilesExamplePath: join(dir, 'profiles.example.yaml'),
    yes: true,
    force: false,
    skipProfiles: true,
    withExampleProfiles: false,
    hardBlockedOrigins: [],
    databaseUrl: 'postgres://relay:relay@localhost:5432/relay',
    redisUrl: 'redis://localhost:6379/13',
    isTTY: false,
    now: () => 0,
    runDoctorFn: okDoctor,
    ...overrides,
  }
}

describe('mergeHardBlockedOrigins', () => {
  it('refuses an empty result, per FR-SET-7', () => {
    expect(() => mergeHardBlockedOrigins([], [])).toThrow(/FR-SET-7/)
  })

  it('keeps the built-in defaults and adds operator-supplied origins on top', () => {
    const merged = mergeHardBlockedOrigins(['example.com'])
    expect(merged).toEqual(expect.arrayContaining([...DEFAULT_HARD_BLOCKED_ORIGINS, 'example.com']))
  })

  it('deduplicates case-insensitively and trims whitespace', () => {
    const merged = mergeHardBlockedOrigins([' Example.com ', 'example.com'])
    expect(merged.filter((o) => o.toLowerCase() === 'example.com')).toHaveLength(1)
  })
})

describe('runInit: never silently overwrites', () => {
  it('leaves an existing config file byte-identical when run non-interactively without --force', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const sentinel = 'this is the operators working config, do not touch\n'
    await writeFile(configPath, sentinel, 'utf8')

    const result = await runInit(baseOptions({ configPath }))

    await expect(readFile(configPath, 'utf8')).resolves.toBe(sentinel)
    expect(result.report).toContain('kept the existing')
    expect(result.report).toContain(configPath)
  })

  it('leaves an existing policy file byte-identical when run non-interactively without --force', async () => {
    const policyPath = join(dir, 'policy.yaml')
    const sentinel = 'version: 1\ndefaults:\n  unmatched: ask\nhard_blocked_origins:\n  - "custom.example"\n'
    await writeFile(policyPath, sentinel, 'utf8')

    await runInit(baseOptions({ policyPath }))

    await expect(readFile(policyPath, 'utf8')).resolves.toBe(sentinel)
  })

  it('overwrites only when --force is given', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    await writeFile(configPath, 'stale\n', 'utf8')

    const result = await runInit(baseOptions({ configPath, force: true }))

    const written = await readFile(configPath, 'utf8')
    expect(written).not.toBe('stale\n')
    expect(result.report).toContain('overwrote')
  })

  it('interactively overwrites only when the operator confirms', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    await writeFile(configPath, 'stale\n', 'utf8')

    await runInit(
      baseOptions({
        configPath,
        yes: false,
        isTTY: true,
        confirm: async () => false,
        promptLine: async () => '',
      }),
    )
    await expect(readFile(configPath, 'utf8')).resolves.toBe('stale\n')

    await runInit(
      baseOptions({
        configPath,
        yes: false,
        isTTY: true,
        confirm: async () => true,
        promptLine: async () => '',
      }),
    )
    await expect(readFile(configPath, 'utf8')).resolves.not.toBe('stale\n')
  })
})

describe('runInit: hard-blocked origins, FR-SET-7', () => {
  it('writes a policy file whose hard_blocked_origins is never empty and validates', async () => {
    const policyPath = join(dir, 'policy.yaml')
    await runInit(baseOptions({ policyPath }))

    const policy = loadPolicy(policyPath)
    expect(policy.hard_blocked_origins.length).toBeGreaterThan(0)
    expect(policy.hard_blocked_origins).toEqual(expect.arrayContaining([...DEFAULT_HARD_BLOCKED_ORIGINS]))
  })

  it('includes operator-supplied additions from --hard-blocked-origin', async () => {
    const policyPath = join(dir, 'policy.yaml')
    await runInit(baseOptions({ policyPath, hardBlockedOrigins: ['internal.acme.corp'] }))

    const policy = loadPolicy(policyPath)
    expect(policy.hard_blocked_origins).toContain('internal.acme.corp')
  })
})

describe('runInit: writes a valid runtime config', () => {
  it('produces a config that loadRelayConfig accepts, with the given URLs', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    await runInit(
      baseOptions({
        configPath,
        databaseUrl: 'postgres://relay:relay@localhost:5432/relay',
        redisUrl: 'redis://localhost:6379/13',
      }),
    )

    const config = loadRelayConfig(configPath)
    expect(config.database.url).toBe('postgres://relay:relay@localhost:5432/relay')
    expect(config.redis.url).toBe('redis://localhost:6379/13')
    expect(config.secrets.provider).toBe('keychain')
  })
})

describe('runInit: browser tier availability, FR-PRF-6a and FR-PRF-4a', () => {
  const fakeHome = '/Users/faketestoperator'

  async function writeProfiles(path: string, yaml: string): Promise<void> {
    await writeFile(path, yaml, 'utf8')
  }

  it('reports an honourable pin as honoured and completes successfully', async () => {
    const profilesPath = join(dir, 'profiles.yaml')
    await writeProfiles(
      profilesPath,
      `version: 1
profiles:
  - name: acme
    description: dedicated automation profile
    user_data_dir: /Users/faketestoperator/chrome-profiles/acme
    profile_directory: Default
    classification: client
    allowed_origins: ['*.acme.com']
    pinned_tier: 2
`,
    )

    const result = await runInit(
      baseOptions({ profilesPath, skipProfiles: true, home: fakeHome, platform: 'darwin' }),
    )

    expect(result.exitCode).toBe(0)
    expect(result.report).toContain('tier 2 available')
    expect(result.report).toContain('Pinned to tier 2, honoured')
  })

  it('refuses to complete when a pin cannot be honoured, using validatePin', async () => {
    const profilesPath = join(dir, 'profiles.yaml')
    await writeProfiles(
      profilesPath,
      `version: 1
profiles:
  - name: work
    description: everyday profile pointed at Chrome's own default directory
    user_data_dir: /Users/faketestoperator/Library/Application Support/Google/Chrome
    profile_directory: Default
    classification: client
    allowed_origins: ['*.acme.com']
    pinned_tier: 2
`,
    )

    const result = await runInit(
      baseOptions({ profilesPath, skipProfiles: true, home: fakeHome, platform: 'darwin' }),
    )

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('PIN FAILURE')
    expect(result.report).toContain('relay init did not complete')
  })

  it('with --with-example-profiles, copies the worked example non-interactively when none exists yet', async () => {
    const profilesPath = join(dir, 'profiles.yaml')
    const profilesExamplePath = join(dir, 'profiles.example.yaml')
    await writeFile(
      profilesExamplePath,
      `version: 1
profiles:
  - name: acme
    description: dedicated automation profile from the example
    user_data_dir: /Users/faketestoperator/chrome-profiles/acme
    profile_directory: Default
    classification: client
    allowed_origins: ['*.acme.com']
`,
      'utf8',
    )

    const result = await runInit(
      baseOptions({ profilesPath, profilesExamplePath, skipProfiles: false, withExampleProfiles: true }),
    )

    await expect(readFile(profilesPath, 'utf8')).resolves.toContain('name: acme')
    expect(result.report).toContain(`wrote ${profilesPath}`)
    expect(result.report).toContain('browser tier availability')
  })

  it('without --with-example-profiles, leaves profiles unconfigured non-interactively rather than guessing', async () => {
    const profilesPath = join(dir, 'profiles.yaml')
    const profilesExamplePath = join(dir, 'profiles.example.yaml')
    await writeFile(profilesExamplePath, 'version: 1\nprofiles: []\n', 'utf8')

    const result = await runInit(baseOptions({ profilesPath, profilesExamplePath, skipProfiles: false }))

    expect(existsSync(profilesPath)).toBe(false)
    expect(result.report).toContain('no profile registry written')
  })

  it('reports an empty registry as a safe, non-blocking state', async () => {
    const profilesPath = join(dir, 'profiles.yaml')
    await writeProfiles(profilesPath, 'version: 1\nprofiles: []\n')

    const result = await runInit(baseOptions({ profilesPath, skipProfiles: true }))

    expect(result.exitCode).toBe(0)
    expect(result.report).toContain('no profiles configured yet')
    expect(result.report).not.toContain('PIN FAILURE')
  })

  it('reports "no profiles configured" as safe when no file exists at all and profiles are skipped', async () => {
    const result = await runInit(baseOptions({ skipProfiles: true }))
    expect(result.exitCode).toBe(0)
    expect(result.report).toContain('skipped')
    expect(result.report).not.toContain('PIN FAILURE')
  })
})

describe('runInit: secrets guidance', () => {
  it('names the exact Keychain service names and never prints a token value', async () => {
    const result = await runInit(baseOptions())
    expect(result.report).toContain('relay-slack-bot-token')
    expect(result.report).toContain('relay-slack-app-token')
    expect(result.report).toContain('security add-generic-password')
    // The guidance always ends -w with nothing after it: no placeholder or
    // real value is ever assembled into the command relay prints.
    expect(result.report).toMatch(/-w\n/)
  })
})

describe('runInit: no TTY', () => {
  it('completes without ever constructing a prompt when there is no terminal', async () => {
    // Deliberately does NOT inject confirm/promptLine, so this exercises the
    // real readline-backed defaults. isTTY: false must stop them from ever
    // being called; if it did not, this test would hang against the test
    // runner's own stdin instead of completing.
    const configPath = join(dir, 'relay.config.yaml')
    await writeFile(configPath, 'stale\n', 'utf8')

    const result = await runInit(
      baseOptions({ configPath, yes: false, isTTY: false }),
    )

    await expect(readFile(configPath, 'utf8')).resolves.toBe('stale\n')
    expect(result.report).toContain('kept the existing')
  }, 5000)

  it('writes fresh defaults with no prompt when nothing exists yet and there is no terminal', async () => {
    const result = await runInit(
      baseOptions({ yes: false, isTTY: false }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.report).toContain('wrote')
  }, 5000)
})

describe('runInit: doctor integration', () => {
  it('reports doctor output but does not fail relay init on a degraded doctor result', async () => {
    const degradedDoctor: DoctorRunner = async () => ({
      results: [{ name: 'postgres', status: 'failed', detail: 'connection refused', remediation: 'Run `docker compose up -d`.' }],
      exitCode: 1,
    })

    const result = await runInit(baseOptions({ runDoctorFn: degradedDoctor }))

    expect(result.exitCode).toBe(0)
    expect(result.report).toContain('docker compose up -d')
    expect(result.report).toContain('relay init does not fail on them')
  })
})
