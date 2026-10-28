import { describe, expect, it, vi } from 'vitest'

import { runProfileLogin } from '../../src/cli/profile-login.js'
import { profileRegistrySchema } from '../../src/profiles/schema.js'
import type { ProfileEntry, ProfileRegistry } from '../../src/profiles/schema.js'

/**
 * `relay profile-login`'s job is to refuse the cases where signing in would
 * be wasted or misleading, so most of this file is refusals.
 *
 * The one that matters most is the default-directory case. Opening Chrome's
 * everyday profile and signing in there SUCCEEDS as a login and leaves a
 * profile Relay can never drive (FR-PRF-6a). That is the worst possible
 * outcome, because it looks like the setup worked.
 */

const HOME = '/Users/op'

function buildRegistry(profiles: readonly Partial<ProfileEntry>[]): ProfileRegistry {
  return profileRegistrySchema.parse({
    version: 1,
    profiles: profiles.map((profile) => ({
      name: 'acme',
      description: 'Acme automation profile',
      user_data_dir: '/Users/op/chrome-profiles/acme',
      profile_directory: 'Default',
      classification: 'client',
      allowed_origins: ['*.acme.com'],
      ...profile,
    })),
  })
}

function run(options: {
  name?: string
  profiles?: readonly Partial<ProfileEntry>[]
  spawnChrome?: (executablePath: string, args: readonly string[]) => { readonly pid: number | undefined }
  existingEndpoint?: (userDataDir: string) => { readonly port: number } | undefined
  browserIsRunningOn?: (userDataDir: string, platform: NodeJS.Platform) => boolean | undefined
}) {
  return runProfileLogin({
    name: options.name ?? 'acme',
    home: HOME,
    platform: 'darwin',
    executablePath: '/fake/Chrome',
    loadRegistry: () => buildRegistry(options.profiles ?? [{}]),
    spawnChrome: options.spawnChrome ?? (() => ({ pid: 4242 })),
    ...(options.existingEndpoint !== undefined ? { existingEndpoint: options.existingEndpoint } : { existingEndpoint: () => undefined }),
    // Defaults to "a browser really is there", so a test that supplies an
    // endpoint is testing the refusal rather than the staleness check.
    browserIsRunningOn: options.browserIsRunningOn ?? (() => true),
  })
}

describe('relay profile-login', () => {
  it('opens the browser at the profile\'s OWN user-data directory, so the flag cannot be got wrong by hand', () => {
    const seen: string[][] = []
    const spawnChrome = (_executablePath: string, args: readonly string[]): { readonly pid: number | undefined } => {
      seen.push([...args])
      return { pid: 4242 }
    }

    const result = run({ spawnChrome })

    expect(result.exitCode).toBe(0)
    expect(seen[0]).toContain('--user-data-dir=/Users/op/chrome-profiles/acme')
    expect(seen[0]).toContain('--profile-directory=Default')
  })

  it('tells the operator the one thing that actually breaks a login: a session-only cookie', () => {
    // Relay closes the browser when a run ends, so a cookie that expires
    // with the session does not survive to the next run. An operator who
    // signs in without "remember me" will find the login gone and have no
    // way to know why.
    const result = run({})

    expect(result.report).toContain('remember me')
    expect(result.report).toContain('will not survive')
    expect(result.report).toContain('quit this browser window')
  })

  it('names the origins the profile is scoped to, so the operator signs into the right sites', () => {
    const result = run({ profiles: [{ allowed_origins: ['*.acme.com', 'billing.acme.test'] }] })

    expect(result.report).toContain('*.acme.com')
    expect(result.report).toContain('billing.acme.test')
  })

  it('REFUSES a profile pointing at Chrome\'s default directory, rather than leaving a working login on a broken profile', () => {
    const spawnChrome = vi.fn(() => ({ pid: 1 }))

    const result = run({
      profiles: [{ user_data_dir: `${HOME}/Library/Application Support/Google/Chrome`, classification: 'work' }],
      spawnChrome,
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('FR-PRF-6a')
    expect(result.report).toContain('chrome-profiles/acme')
    // Nothing was opened: the operator must not spend ten minutes signing
    // into a profile that can never be driven.
    expect(spawnChrome).not.toHaveBeenCalled()
  })

  it('refuses a personal profile, which is in the registry only to be excluded', () => {
    const spawnChrome = vi.fn(() => ({ pid: 1 }))

    const result = run({
      profiles: [{ classification: 'personal', usable: false, allowed_origins: ['localhost'] }],
      spawnChrome,
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('FR-PRF-5')
    expect(spawnChrome).not.toHaveBeenCalled()
  })

  it('refuses when a browser is already open on that user-data directory, instead of silently handing off and exiting', () => {
    const spawnChrome = vi.fn(() => ({ pid: 1 }))

    const result = run({ existingEndpoint: () => ({ port: 51234 }), spawnChrome })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('only one running browser instance')
    expect(result.report).toContain('51234')
    expect(spawnChrome).not.toHaveBeenCalled()
  })

  it('opens anyway when the port file is STALE, since Chrome never removes it on exit', () => {
    // Chrome writes DevToolsActivePort on start and leaves it behind on any
    // unclean shutdown. Treating the file as proof made this command refuse
    // forever after the first crash, naming a port nothing was listening on,
    // curable only by deleting a file the operator has no reason to know
    // exists. Seen on a real machine.
    const spawnChrome = vi.fn(() => ({ pid: 7 }))

    const result = run({ existingEndpoint: () => ({ port: 51234 }), browserIsRunningOn: () => false, spawnChrome })

    expect(result.exitCode).toBe(0)
    expect(spawnChrome).toHaveBeenCalledTimes(1)
  })

  it('still refuses when it CANNOT tell whether a browser is running, since a false refusal is the safer error', () => {
    const spawnChrome = vi.fn(() => ({ pid: 7 }))

    const result = run({ existingEndpoint: () => ({ port: 51234 }), browserIsRunningOn: () => undefined, spawnChrome })

    expect(result.exitCode).toBe(1)
    expect(spawnChrome).not.toHaveBeenCalled()
  })

  it('names the profiles that DO exist when asked for one that does not', () => {
    const result = run({ name: 'typo', profiles: [{ name: 'acme' }, { name: 'westside' }] })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('acme')
    expect(result.report).toContain('westside')
  })

  it('points at relay init when no profiles are configured at all', () => {
    const result = runProfileLogin({
      name: 'anything',
      home: HOME,
      platform: 'darwin',
      loadRegistry: () => profileRegistrySchema.parse({ version: 1, profiles: [] }),
      spawnChrome: () => ({ pid: 1 }),
      existingEndpoint: () => undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('relay init')
  })
})
