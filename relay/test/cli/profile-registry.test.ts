import { describe, expect, it, vi } from 'vitest'

import {
  runProfileAdd,
  runProfileOrigins,
  runProfileRegistry,
  runProfileRemove,
} from '../../src/cli/profile-registry.js'

/**
 * These commands exist so that the registry deciding which signed-in browser
 * Relay may drive is maintained by a command rather than by copy-paste.
 *
 * The tests that matter most are the ones proving a REFUSED edit leaves the
 * file alone, and that a `client` profile is pinned to a tier where origin
 * scoping is enforced rather than merely detected.
 */

const EXISTING = `version: 1

profiles:
  - name: scratch
    description: Proving profile.
    user_data_dir: /Users/op/chrome-profiles/scratch
    profile_directory: Default
    classification: work
    allowed_origins:
      - example.com
    pinned_tier: 2
`

function harness(source: string | undefined = EXISTING) {
  const writes: Array<[string, string]> = []
  return {
    writes,
    deps: {
      readFile: () => source,
      writeFile: (path: string, contents: string) => writes.push([path, contents]),
    },
  }
}

describe('relay profile-add', () => {
  it('REFUSES a profile with no origins, and explains why the empty list is the problem', () => {
    // FR-PRF-1. An empty allowlist reads both as "nothing permitted" and as
    // "not configured yet", so it is refused rather than stored.
    const { deps, writes } = harness()

    const result = runProfileAdd({ name: 'acme', dir: '/Users/op/chrome-profiles/acme', origins: [], deps, pathExists: () => true })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('FR-PRF-1')
    expect(result.report).toContain('--origin')
    expect(writes).toEqual([])
  })

  it('refuses a directory that does not exist, rather than registering a profile that fails on first use', () => {
    const { deps, writes } = harness()

    const result = runProfileAdd({ name: 'acme', dir: '/nope', origins: ['acme.com'], deps, pathExists: () => false })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('no directory')
    expect(result.report).toContain('profile-clone')
    expect(writes).toEqual([])
  })

  it('pins a client profile to tier 2 by default, per FR-PRF-4a', () => {
    // A recommendation in a help string is not a control. On tier 2 scoping
    // is ENFORCED by the driver; on tier 1 it can only be detected after
    // the browser has already gone somewhere.
    const { deps, writes } = harness()

    const result = runProfileAdd({ name: 'acme', dir: '/Users/op/chrome-profiles/acme', origins: ['acme.com'], deps, pathExists: () => true })

    expect(result.exitCode).toBe(0)
    expect(writes[0]?.[1]).toContain('pinned_tier: 2')
    expect(writes[0]?.[1]).toContain('classification: client')
  })

  it('refuses a pin to tier 1, which could not be honoured', () => {
    const { deps, writes } = harness()

    const result = runProfileAdd({ name: 'acme', dir: '/x', origins: ['acme.com'], tier: 1, deps, pathExists: () => true })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('--tier must be 2 or 3')
    expect(writes).toEqual([])
  })

  it('registers a personal profile as unusable, since FR-PRF-5 excludes it from agent use', () => {
    // It is listed only so that a task naming it is refused loudly rather
    // than silently matching nothing, which is indistinguishable from a typo.
    const { deps, writes } = harness()

    const result = runProfileAdd({ name: 'mine', dir: '/x', origins: [], classification: 'personal', deps, pathExists: () => true })

    expect(result.exitCode).toBe(0)
    const written = writes[0]?.[1] ?? ''
    const personalEntry = written.slice(written.indexOf('name: mine'))
    expect(personalEntry).toContain('usable: false')
    // A tier pin on an excluded profile is meaningless, and the schema
    // refuses the combination outright.
    expect(personalEntry).not.toContain('pinned_tier')
  })

  it('rejects a classification that is not one of the three', () => {
    const { deps } = harness()

    const result = runProfileAdd({ name: 'acme', dir: '/x', origins: ['acme.com'], classification: 'clientt', deps, pathExists: () => true })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('not a classification')
  })

  it('refuses a duplicate name without --force and does not write', () => {
    const { deps, writes } = harness()

    const result = runProfileAdd({ name: 'scratch', dir: '/x', origins: ['example.org'], deps, pathExists: () => true })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('already registered')
    expect(writes).toEqual([])
  })
})

describe('a write that fails must not be reported as success', () => {
  it('says the file is unchanged when the write throws', () => {
    // The operator's next action depends on believing this. Reporting
    // success here would leave them scoping a profile that was never saved.
    const result = runProfileAdd({
      name: 'acme',
      dir: '/x',
      origins: ['acme.com'],
      pathExists: () => true,
      deps: {
        readFile: () => EXISTING,
        writeFile: () => {
          throw new Error('EACCES: permission denied')
        },
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('EACCES')
    expect(result.report).toContain('unchanged')
  })
})

describe('relay profile-origins', () => {
  it('adds an origin to an existing profile', () => {
    const { deps, writes } = harness()

    const result = runProfileOrigins({ name: 'scratch', allow: ['*.example.com'], deps })

    expect(result.exitCode).toBe(0)
    expect(writes[0]?.[1]).toContain('*.example.com')
  })

  it('refuses with guidance when no change was requested, rather than rewriting the file', () => {
    const { deps, writes } = harness()

    const result = runProfileOrigins({ name: 'scratch', deps })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('--allow')
    expect(writes).toEqual([])
  })

  it('does not write when the edit would empty the allowlist', () => {
    const { deps, writes } = harness()

    const result = runProfileOrigins({ name: 'scratch', remove: ['example.com'], deps })

    expect(result.exitCode).toBe(1)
    expect(writes).toEqual([])
  })
})

describe('relay profile-remove', () => {
  it('unregisters without deleting the cookies, and says so', () => {
    const { deps, writes } = harness()

    const result = runProfileRemove({ name: 'scratch', deps })

    expect(result.exitCode).toBe(0)
    expect(result.report).toContain('left on disk')
    expect(writes).toHaveLength(1)
  })
})

describe('relay profile-registry', () => {
  it('shows each profile with what it may reach', () => {
    const result = runProfileRegistry({ deps: { readFile: () => EXISTING } })

    expect(result.exitCode).toBe(0)
    expect(result.report).toContain('scratch')
    expect(result.report).toContain('example.com')
  })

  it('explains how to get started when nothing is registered, rather than printing an empty list', () => {
    const result = runProfileRegistry({ deps: { readFile: () => undefined } })

    expect(result.exitCode).toBe(0)
    expect(result.report).toContain('No profiles are registered')
    expect(result.report).toContain('profile-clone')
  })
})
