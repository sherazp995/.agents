import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildLinuxLaunch } from '../../src/sandbox/bwrap.js'
import { runSandboxed, sandboxAvailability } from '../../src/sandbox/exec.js'
import { runSandboxSelfTest } from '../../src/sandbox/selftest.js'

/**
 * Everything in `profile.test.ts` proves the profile TEXT is right. None of
 * it proves the kernel honoured it. These do, against the real
 * `sandbox-exec` on this machine, because FR-SH-6's whole claim is that a
 * denial comes from the OS rather than from the engine's cooperation, and
 * that claim cannot be checked by reading a string.
 *
 * They skip rather than fail where confinement is unavailable, since a
 * non-macOS machine is a platform limitation and not a broken sandbox.
 */

const available = sandboxAvailability().available
const describeIfSandboxed = available ? describe : describe.skip

if (!available) {
  // Silence is the worst failure: a skipped suite should say why.
  console.warn('sandbox integration tests skipped: OS-level confinement is unavailable on this platform')
}

describeIfSandboxed('the sandbox actually confines, on this machine', () => {
  it('ALLOWS a write inside the worktree, or a real run could not do its work', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-sb-allow-'))
    try {
      const result = await runSandboxed({
        spec: { worktree },
        command: '/bin/sh',
        args: ['-c', `printf 'inside' > "${join(worktree, 'f.txt')}"`],
        timeoutMs: 20_000,
      })

      expect(result.outcome).toBe('ran')
      expect(readFileSync(join(worktree, 'f.txt'), 'utf8')).toBe('inside')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('DENIES a write outside the worktree at the kernel, not by cooperation', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-sb-deny-'))
    const outside = mkdtempSync(join(tmpdir(), 'relay-sb-outside-'))
    const target = join(outside, 'escaped.txt')
    try {
      const result = await runSandboxed({
        spec: { worktree, readOnlyPaths: [outside] },
        command: '/bin/sh',
        args: ['-c', `printf 'escaped' > "${target}" && echo WROTE`],
        timeoutMs: 20_000,
      })

      expect(result.outcome).toBe('ran')
      if (result.outcome !== 'ran') return
      expect(result.stdout).not.toContain('WROTE')
      expect(() => readFileSync(target, 'utf8')).toThrow()
    } finally {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  }, 30_000)

  it('DENIES a write to a path nobody listed, which is what the blanket deny is for', async () => {
    // THIS TEST EXISTS BECAUSE ITS ABSENCE WAS CAUGHT BY A SELF-ATTACK.
    // Deleting `(deny file-write*)` from the profile broke NOTHING: the
    // only escape test passed the target in `readOnlyPaths`, so an explicit
    // deny caught it and the blanket deny was never exercised. A run
    // writing to the operator's home directory would have been allowed and
    // no test would have noticed.
    //
    // So this one names no grant and no denial. The home directory is
    // exactly the shape FR-SH-2 cares about, and nothing here should be
    // able to touch it.
    const worktree = mkdtempSync(join(tmpdir(), 'relay-sb-unlisted-'))
    const target = join(homedir(), '.relay-sandbox-escape-probe')
    try {
      const result = await runSandboxed({
        spec: { worktree },
        command: '/bin/sh',
        args: ['-c', `printf 'escaped' > "${target}" && echo WROTE; echo DONE`],
        timeoutMs: 20_000,
      })

      expect(result.outcome).toBe('ran')
      if (result.outcome !== 'ran') return
      expect(result.stdout).toContain('DONE')
      expect(result.stdout).not.toContain('WROTE')
      expect(existsSync(target)).toBe(false)
    } finally {
      // Only ever present if confinement failed, which is the assertion above.
      rmSync(target, { force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('gives the run scratch space, but NOT the whole of TMPDIR', async () => {
    // Granting os.tmpdir() wholesale made every concurrent run mutually
    // writable. The run gets its own directory via TMPDIR instead.
    const worktree = mkdtempSync(join(tmpdir(), 'relay-sb-scratch-'))
    const sibling = mkdtempSync(join(tmpdir(), 'relay-sb-sibling-'))
    try {
      const result = await runSandboxed({
        spec: { worktree },
        command: '/bin/sh',
        args: ['-c', `printf 'x' > "$TMPDIR/ok.txt" && echo SCRATCH_OK; printf 'y' > "${join(sibling, 'no.txt')}" && echo SIBLING_WRITABLE; echo DONE`],
        timeoutMs: 20_000,
      })

      expect(result.outcome).toBe('ran')
      if (result.outcome !== 'ran') return
      expect(result.stdout).toContain('SCRATCH_OK')
      expect(result.stdout).not.toContain('SIBLING_WRITABLE')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(sibling, { recursive: true, force: true })
    }
  }, 30_000)

  it('DENIES direct network egress, which is what makes the proxy unbypassable', async () => {
    // FR-SH-6: "Opening a direct socket to bypass the proxy fails, because
    // the sandbox denies direct outbound networking."
    const worktree = mkdtempSync(join(tmpdir(), 'relay-sb-net-'))
    try {
      const result = await runSandboxed({
        spec: { worktree },
        command: '/bin/sh',
        args: ['-c', '/usr/bin/curl -s -m 5 -o /dev/null https://example.com && echo CONNECTED; echo DONE'],
        timeoutMs: 25_000,
      })

      expect(result.outcome).toBe('ran')
      if (result.outcome !== 'ran') return
      expect(result.stdout).toContain('DONE')
      expect(result.stdout).not.toContain('CONNECTED')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 35_000)

  it('lets a command write to /dev/null, since otherwise nothing real runs', async () => {
    // The regression this pins: the first profile denied it, and every probe
    // failed with "/dev/null: Operation not permitted".
    const worktree = mkdtempSync(join(tmpdir(), 'relay-sb-devnull-'))
    try {
      const result = await runSandboxed({
        spec: { worktree },
        command: '/bin/sh',
        args: ['-c', 'echo hidden > /dev/null 2>/dev/null && echo REDIRECTED'],
        timeoutMs: 20_000,
      })

      expect(result.outcome).toBe('ran')
      if (result.outcome !== 'ran') return
      expect(result.stdout).toContain('REDIRECTED')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('passes the FR-SH-7 self-test, which is what gates a run starting at all', async () => {
    const outcome = await runSandboxSelfTest()

    expect(outcome.outcome).toBe('passed')
  }, 40_000)
})

const describeIfLinuxSandboxed = available && process.platform === 'linux' ? describe : describe.skip

/** One BPF instruction, `return ALLOW`: a filter that filters nothing. */
const ALLOW_ALL_FILTER = Buffer.from([0x06, 0, 0, 0, 0x00, 0x00, 0xff, 0x7f])

describeIfLinuxSandboxed('the Linux layers, each proven to matter', () => {
  it('fails the self-test, naming the local socket, when the socket filter lets everything through', async () => {
    const outcome = await runSandboxSelfTest({ linux: { unixSocketFilter: () => ALLOW_ALL_FILTER } })

    expect(outcome.outcome).toBe('failed')
    if (outcome.outcome !== 'failed') return
    expect(outcome.reason).toContain('local (Unix) socket')
  }, 40_000)

  it('fails the self-test, naming the forbidden write, when the root is bound writable', async () => {
    const outcome = await runSandboxSelfTest({
      linux: {
        buildLaunch: (request, deps) => {
          const launch = buildLinuxLaunch(request, deps)
          const args = [...launch.args]
          const at = args.findIndex((arg, i) => arg === '--ro-bind' && args[i + 1] === '/' && args[i + 2] === '/')
          args[at] = '--bind'
          return { command: launch.command, args }
        },
      },
    })

    expect(outcome.outcome).toBe('failed')
    if (outcome.outcome !== 'failed') return
    expect(outcome.reason).toContain('OUTSIDE the worktree, SUCCEEDED')
  }, 40_000)

  it('leaves no process behind when a run is cancelled, even one that started its own session', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-sb-cancel-'))
    const controller = new AbortController()
    try {
      const run = runSandboxed({
        spec: { worktree },
        command: '/bin/sh',
        args: ['-c', 'setsid sleep 3071 & sleep 3071'],
        timeoutMs: 20_000,
        signal: controller.signal,
      })
      // Whole lines: a substring would also match any shell whose command text mentions it.
      const sleepers = (): number =>
        execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter((line) => line.trim() === 'sleep 3071').length
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(sleepers()).toBe(2)
      controller.abort()
      await run
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(sleepers()).toBe(0)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('hides login files from a run unless it is the engine, which needs its own', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-sb-logins-'))
    const home = mkdtempSync(join(homedir(), '.relay-sb-home-'))
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_test'), 'PRIVATE-KEY-MARKER')
    const read = { command: '/bin/sh', args: ['-c', `cat "${join(home, '.ssh', 'id_test')}" 2>/dev/null; echo DONE`], timeoutMs: 20_000 }
    try {
      const hidden = await runSandboxed({ spec: { worktree }, ...read }, { linux: { home } })
      const exposed = await runSandboxed({ spec: { worktree, exposeLogins: true }, ...read }, { linux: { home } })

      expect(hidden.outcome === 'ran' && hidden.stdout).toBe('DONE\n')
      expect(exposed.outcome === 'ran' && exposed.stdout).toBe('PRIVATE-KEY-MARKERDONE\n')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('confinement availability is reported with a reason', () => {
  it('refuses on a platform with no confinement rather than running unconfined', () => {
    // FR-SH-7: a run cannot execute with confinement unavailable; it fails
    // closed with a stated reason. A fallback to unconfined is the path that
    // would eventually always run.
    const result = sandboxAvailability({ platform: 'win32' })

    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('FR-SH-7')
  })

  it('refuses on Linux when bubblewrap is missing', () => {
    const result = sandboxAvailability({ platform: 'linux', pathExists: () => false })

    expect(result.available).toBe(false)
    if (result.available) return
    expect(result.reason).toContain('bubblewrap')
  })

  it('refuses when sandbox-exec is missing', () => {
    const result = sandboxAvailability({ platform: 'darwin', pathExists: () => false })

    expect(result.available).toBe(false)
  })

  it('never returns a result that would let a caller run unconfined by accident', async () => {
    const outcome = await runSandboxed(
      { spec: { worktree: tmpdir() }, command: '/bin/echo', args: ['hi'] },
      { platform: 'win32' },
    )

    expect(outcome.outcome).toBe('unavailable')
  })
})
