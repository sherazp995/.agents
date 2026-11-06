import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildLinuxLaunch, linuxSandboxAvailability, unsafeBindReason } from '../../src/sandbox/bwrap.js'
import { SandboxProfileError } from '../../src/sandbox/profile.js'

/**
 * The Linux launch is built as data, so these check the ways it can be
 * silently wrong: a grant that reopens a protected path, a path that brings
 * back a hidden folder, and a login left readable. That the kernel honours
 * the result is proven against the real tools in selftest.integration.
 */

let root: string
let worktree: string
let protectedDir: string
let home: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-bwrap-')))
  worktree = join(root, 'worktree')
  protectedDir = join(worktree, 'protected')
  home = join(root, 'home')
  mkdirSync(protectedDir, { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(join(home, '.claude2'), { recursive: true })
  writeFileSync(join(home, '.claude2', '.credentials.json'), '{}')
  writeFileSync(join(home, '.netrc'), '')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The bwrap part of the launch: everything after the bwrap binary. */
function bwrapArgs(launch: { args: readonly string[] }): readonly string[] {
  return launch.args.slice(launch.args.indexOf('/usr/bin/bwrap') + 1)
}

function launchFor(spec: Parameters<typeof buildLinuxLaunch>[0]['spec'], deps: Parameters<typeof buildLinuxLaunch>[1] = { home }) {
  return buildLinuxLaunch({ spec, filterPath: '/f.bpf', command: '/bin/echo', args: ['hi'] }, deps)
}

describe('buildLinuxLaunch', () => {
  it('binds protected paths read-only after the grants, so a grant cannot reopen them', () => {
    const args = bwrapArgs(launchFor({ worktree, readOnlyPaths: [protectedDir] }))

    const grant = args.findIndex((arg, i) => arg === '--bind' && args[i + 1] === worktree)
    const ro = args.findIndex((arg, i) => arg === '--ro-bind' && args[i + 1] === protectedDir)
    expect(grant).toBeGreaterThan(-1)
    expect(ro).toBeGreaterThan(grant)
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/'])
  })

  it('covers /run, /tmp and /var/tmp, and skips a hidden folder this machine does not have', () => {
    const all = bwrapArgs(launchFor({ worktree }))
    expect(all.join(' ')).toContain('--tmpfs /run --tmpfs /tmp --tmpfs /var/tmp')

    const noVarTmp = bwrapArgs(launchFor({ worktree }, { home, pathExists: (path) => path !== '/var/tmp' }))
    expect(noVarTmp).not.toContain('/var/tmp')
  })

  it('unshares every namespace bar the network pasta already made, and loads the filter', () => {
    const launch = launchFor({ worktree })
    const args = bwrapArgs(launch)
    for (const flag of ['--unshare-user', '--unshare-pid', '--die-with-parent', '--seccomp']) expect(args).toContain(flag)
    // A new session would take the run out of the runner's process group.
    expect(args).not.toContain('--new-session')
    expect(args.slice(-3)).toEqual(['--', '/bin/echo', 'hi'])
    expect(launch.args.slice(launch.args.indexOf('--') + 1, launch.args.indexOf('--') + 5)).toEqual([
      '/bin/sh', '-c', 'exec 9<"$0" && exec "$@"', '/f.bpf',
    ])
  })

  it('forwards only the proxy port, and nothing when there is no proxy', () => {
    expect(launchFor({ worktree, proxyPort: 4321 }).args.join(' ')).toContain('-t none -u none -T 4321 -U none')
    expect(launchFor({ worktree }).args.join(' ')).toContain('-t none -u none -T none -U none')
    expect(() => launchFor({ worktree, proxyPort: 70000 })).toThrow(SandboxProfileError)
  })

  it('covers login files unless the run needs them', () => {
    const covered = bwrapArgs(launchFor({ worktree })).join(' ')
    expect(covered).toContain(`--tmpfs ${home}/.ssh --remount-ro ${home}/.ssh`)
    expect(covered).toContain(`--ro-bind /dev/null ${home}/.claude2/.credentials.json`)
    expect(covered).toContain(`--ro-bind /dev/null ${home}/.netrc`)

    const exposed = bwrapArgs(launchFor({ worktree, exposeLogins: true })).join(' ')
    expect(exposed).not.toContain(home)
  })

  it('refuses a worktree under /run, equal to /tmp, or a symlink to one', () => {
    const link = join(root, 'to-run')
    symlinkSync('/run', link)

    for (const bad of ['/run', '/tmp', link]) expect(() => launchFor({ worktree: bad })).toThrow(SandboxProfileError)
    expect(() => launchFor({ worktree, readOnlyPaths: ['/var'] })).toThrow(/contains \/var\/tmp/)
  })

  it('refuses a path that does not exist rather than passing it through', () => {
    expect(() => launchFor({ worktree: join(root, 'missing') })).toThrow(SandboxProfileError)
  })
})

describe('unsafeBindReason', () => {
  it('allows a folder inside /tmp but not /tmp itself or its parents', () => {
    expect(unsafeBindReason('/tmp/relay-run')).toBeUndefined()
    expect(unsafeBindReason('/tmp')).toBeDefined()
    expect(unsafeBindReason('/')).toBeDefined()
    expect(unsafeBindReason('/run/user/1000')).toBeDefined()
  })
})

describe('linuxSandboxAvailability', () => {
  const present = { pathExists: () => true, probe: () => undefined }

  it('is available when the tools exist and the probe passes', () => {
    expect(linuxSandboxAvailability({ ...present, arch: 'x64' })).toEqual({ available: true })
  })

  it('names each cause when it is not', () => {
    const cases: Array<[Parameters<typeof linuxSandboxAvailability>[0], RegExp]> = [
      [{ ...present, arch: 'ia32' }, /supports x64 and arm64, and this machine is ia32/],
      [{ ...present, arch: 'x64', pathExists: (path) => !path.endsWith('bwrap') }, /install bubblewrap/],
      [{ ...present, arch: 'x64', pathExists: (path) => !path.endsWith('pasta') }, /install pasta/],
      [{ ...present, arch: 'x64', probe: () => 'probe said no' }, /probe said no/],
    ]
    for (const [deps, reason] of cases) {
      const result = linuxSandboxAvailability(deps)
      expect(result.available).toBe(false)
      if (!result.available) expect(result.reason).toMatch(reason)
    }
  })
})
