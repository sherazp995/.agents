import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  buildSandboxProfile,
  describeSandboxRules,
  escapeSandboxString,
  resolveForProfile,
  SandboxProfileError,
} from '../../src/sandbox/profile.js'

/**
 * The profile is the thing doing the confining, so these tests are about the
 * ways it can be silently wrong: a path that does not match what it appears
 * to match, a grant that re-opens something the requirement closes, and a
 * name that escapes the profile syntax altogether.
 */

let worktree: string
let outside: string

beforeAll(() => {
  worktree = mkdtempSync(join(tmpdir(), 'relay-profile-wt-'))
  outside = mkdtempSync(join(tmpdir(), 'relay-profile-out-'))
})

afterAll(() => {
  rmSync(worktree, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('paths are resolved, because SBPL matches the resolved path', () => {
  it('writes the RESOLVED path into the profile, not the one it was handed', () => {
    // On macOS /tmp is a symlink to /private/tmp, so a profile granting
    // "/tmp/work" denies every write to the directory the caller believes
    // it just granted. Silent, and it looks like the sandbox is broken.
    const profile = buildSandboxProfile({ worktree })

    expect(profile).toContain(resolveForProfile(worktree))
  })

  it('REFUSES a path that does not exist rather than emitting one that cannot match', () => {
    expect(() => buildSandboxProfile({ worktree: join(outside, 'no-such-directory') })).toThrow(SandboxProfileError)
  })
})

describe('the profile closes what FR-SH-6 says must stay closed', () => {
  it('denies all writes before granting any', () => {
    const profile = buildSandboxProfile({ worktree })
    const denyAll = profile.indexOf('(deny file-write*)')
    const grant = profile.indexOf(`(allow file-write* (subpath "${resolveForProfile(worktree)}"))`)

    expect(denyAll).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(denyAll)
  })

  it('emits read-only denials AFTER the grants, so an overlapping grant cannot re-open them', () => {
    // Rule order is significant in SBPL: the last matching rule wins. The
    // operator's primary checkout must stay closed even if a careless grant
    // covers it.
    const profile = buildSandboxProfile({ worktree, writablePaths: [outside], readOnlyPaths: [outside] })
    const grant = profile.indexOf(`(allow file-write* (subpath "${resolveForProfile(outside)}"))`)
    const deny = profile.indexOf(`(deny file-write* (subpath "${resolveForProfile(outside)}"))`)

    expect(grant).toBeGreaterThan(-1)
    expect(deny).toBeGreaterThan(grant)
  })

  it('denies network by default', () => {
    expect(buildSandboxProfile({ worktree })).toContain('(deny network*)')
  })

  it('opens ONLY the loopback proxy port when one is given', () => {
    const profile = buildSandboxProfile({ worktree, proxyPort: 8899 })

    expect(profile).toContain('(allow network* (remote ip "localhost:8899"))')
    // The deny must still precede it, or the allow is meaningless.
    expect(profile.indexOf('(deny network*)')).toBeLessThan(profile.indexOf('localhost:8899'))
  })

  it('has no network at all when no proxy port is given, which is FR-SH-8\'s shape', () => {
    const profile = buildSandboxProfile({ worktree })

    expect(profile).toContain('(deny network*)')
    expect(profile).not.toContain('allow network*')
  })

  it('rejects a port that is not a usable TCP port', () => {
    expect(() => buildSandboxProfile({ worktree, proxyPort: 0 })).toThrow(SandboxProfileError)
    expect(() => buildSandboxProfile({ worktree, proxyPort: 70000 })).toThrow(SandboxProfileError)
  })
})

describe('the device grants are narrow on purpose', () => {
  it('allows /dev/null, because a blanket write deny stops every real command', () => {
    // Found by running it: `2>/dev/null` appears in practically everything a
    // toolchain does, and denying it made the sandbox stop runs working
    // rather than merely confine them.
    expect(buildSandboxProfile({ worktree })).toContain('/dev/null')
  })

  it('does NOT grant all of /dev, which would include the raw disks', () => {
    // A write to /dev/disk0 reaches every byte on the machine, which would
    // undo worktree confinement entirely.
    const profile = buildSandboxProfile({ worktree })

    expect(profile).not.toContain('(subpath "/dev")')
    expect(profile).not.toContain('/dev/disk')
  })
})

describe('a path cannot escape the profile syntax', () => {
  it('escapes quotes and backslashes, so a directory name cannot become profile source', () => {
    // Directory names are attacker-influenced often enough (a branch name, a
    // repository name) that an unescaped quote is an injection into the very
    // thing doing the confining.
    expect(escapeSandboxString('a"b')).toBe('a\\"b')
    expect(escapeSandboxString('a\\b')).toBe('a\\\\b')

    // The property that matters: after escaping, no quote can terminate the
    // SBPL string literal, so nothing in the path becomes profile source.
    const attack = 'x") (allow file-write* (subpath "/'
    const escaped = escapeSandboxString(attack)
    expect(escaped).not.toMatch(/(?<!\\)"/)
    expect(escaped).toContain('\\"')
  })
})

describe('the effective rules are reportable, per FR-SH-6', () => {
  it('states the network policy in words an operator can act on', () => {
    const rules = describeSandboxRules({ worktree, proxyPort: 8899 })

    expect(rules.worktree).toBe(resolveForProfile(worktree))
    expect(rules.networkPolicy).toContain('8899')
    expect(rules.networkPolicy).toContain('denied')
  })

  it('says plainly when a run has no network at all', () => {
    expect(describeSandboxRules({ worktree }).networkPolicy).toContain('all network egress denied')
  })
})
