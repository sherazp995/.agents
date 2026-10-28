import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  binaryName,
  buildShellEnv,
  capOutput,
  MAX_SHELL_OUTPUT_CHARACTERS,
  policyAllowedHosts,
  protectedPaths,
  shell,
  shellRefusalReason,
  validateWorktree,
} from '../../../src/agent/capabilities/shell.js'
import { sandboxAvailability } from '../../../src/sandbox/exec.js'

/**
 * FR-SH-1's acceptance criterion is that a denylisted command is refused
 * with an explanation BEFORE execution, so most of this file is refusals and
 * each asserts the reason rather than just the refusal.
 *
 * The capability is also the sandbox's first caller, so the tests that
 * matter most are the ones proving it cannot run unconfined.
 */

function run(input: Record<string, unknown>, signal: AbortSignal = new AbortController().signal) {
  return shell(input, signal) as Promise<{
    ok: boolean
    refused?: string
    stdout?: string
    exit_code?: number | null
    sandbox?: Record<string, unknown>
  }>
}

describe('a dangerous binary is refused before it runs', () => {
  it('refuses sudo, and says the allowlist cannot override it', async () => {
    const result = await run({ command: 'sudo', args: ['ls'], working_directory: tmpdir() })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('refused for any task')
    expect(result.refused).toContain('cannot override')
  })

  it('refuses a denylisted binary given by ABSOLUTE PATH, not just by bare name', async () => {
    // A denylist keyed on the string "sudo" that misses "/usr/bin/sudo" is
    // not a denylist.
    const result = await run({ command: '/usr/bin/sudo', args: ['ls'], working_directory: tmpdir() })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('refused for any task')
  })

  it('refuses a shell, because accepting one reintroduces the command line this design avoids', async () => {
    for (const name of ['sh', 'bash', 'zsh']) {
      const result = await run({ command: name, args: ['-c', 'echo hi'], working_directory: tmpdir() })
      expect(result.ok).toBe(false)
    }
  })

  it('refuses a binary that is simply not on the allowlist, and lists what is', async () => {
    const result = await run({ command: 'curl', args: ['https://example.com'], working_directory: tmpdir() })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('not in the permitted binary list')
    expect(result.refused).toContain('git')
  })

  it('refuses rm and points at the capability that previews and uses a trash directory', async () => {
    const result = await run({ command: 'rm', args: ['-rf', '/'], working_directory: tmpdir() })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('recoverable trash')
  })
})

describe('an allowed binary can still be refused for what it was asked to do', () => {
  it('refuses inline program text, which is a shell by another name', async () => {
    // `node -e` executes arbitrary source, walking straight around the
    // argv-only design that makes pipes and chaining impossible.
    const result = await run({ command: 'node', args: ['-e', 'require("child_process").execSync("id")'], working_directory: tmpdir() })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('shell by another name')
  })

  it('refuses a remote git operation, so the reason is a sentence and not a network error', async () => {
    const result = await run({ command: 'git', args: ['push', 'origin', 'main'], working_directory: tmpdir() })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('publish gate')
  })

  it('ALLOWS a local git operation, or the capability would be useless', () => {
    expect(shellRefusalReason('git', ['status', '--short'])).toBeUndefined()
    expect(shellRefusalReason('git', ['log', '-1'])).toBeUndefined()
  })

  it('refuses a global package install, which by definition writes outside the worktree', async () => {
    const result = await run({ command: 'npm', args: ['install', '-g', 'something'], working_directory: tmpdir() })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('outside the worktree')
  })

  it('allows a project-local install, which is how a build works', () => {
    expect(shellRefusalReason('pnpm', ['install'])).toBeUndefined()
  })
})

describe('binaryName', () => {
  it('takes the last path segment, case-insensitively', () => {
    expect(binaryName('/usr/bin/SUDO')).toBe('sudo')
    expect(binaryName('git')).toBe('git')
    expect(binaryName('  /opt/homebrew/bin/node  ')).toBe('node')
  })
})

describe('the environment is an allowlist, per FR-SH-1', () => {
  it('drops an inherited secret rather than passing it to a command whose output the model reads', () => {
    // An operator's shell profile routinely exports tokens. A command's
    // output is read by the model, so an inherited environment is a direct
    // path from their profile into a prompt.
    const env = buildShellEnv({ PATH: '/usr/bin', HOME: '/Users/op', AWS_SECRET_ACCESS_KEY: 'nope', GITHUB_TOKEN: 'nope' })

    expect(env.PATH).toBe('/usr/bin')
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })

  it('signals non-interactivity, which is FR-SH-1\'s "no interactive TTY" as tools actually read it', () => {
    expect(buildShellEnv({}).CI).toBe('1')
  })
})

describe('output is capped, keeping the tail', () => {
  it('keeps the END, which is where a failing build says why', () => {
    const capped = capOutput(`${'x'.repeat(MAX_SHELL_OUTPUT_CHARACTERS)}THE-ACTUAL-ERROR`)

    expect(capped.truncated).toBe(true)
    expect(capped.text).toContain('THE-ACTUAL-ERROR')
    expect(capped.text).toContain('trimmed from the start')
  })

  it('leaves short output alone', () => {
    expect(capOutput('short').truncated).toBe(false)
    expect(capOutput('short').text).toBe('short')
  })
})

const available = sandboxAvailability().available
const describeIfSandboxed = available ? describe : describe.skip

describeIfSandboxed('a permitted command really runs, and really is confined', () => {
  it('runs and returns output', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-shell-'))
    try {
      const result = await run({ command: 'echo', args: ['hello-from-shell'], working_directory: worktree })

      expect(result.ok).toBe(true)
      expect(result.stdout).toContain('hello-from-shell')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('can write INSIDE the working directory it was given', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-shell-write-'))
    try {
      // `git init` is a real toolchain action that writes a tree of files.
      const result = await run({ command: 'git', args: ['init', '--quiet'], working_directory: worktree })

      expect(result.ok).toBe(true)
      expect(readFileSync(join(worktree, '.git', 'HEAD'), 'utf8')).toContain('ref:')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('RUNS THE EGRESS PROXY, so the destination list is enforced rather than merely built', async () => {
    // The regression this pins: the proxy shipped complete, tested, and with
    // no production caller, while shell passed no proxyPort at all. Every
    // real run therefore got the no-network profile, and the "enforced
    // destination list" enforced nothing. The effective rules naming a
    // loopback port is what proves the proxy was actually wired in.
    const worktree = mkdtempSync(join(tmpdir(), 'relay-shell-proxy-'))
    try {
      const result = await run({ command: 'echo', args: ['x'], working_directory: worktree })

      expect(String(result.sandbox?.networkPolicy)).toContain('loopback port')
      expect(String(result.sandbox?.networkPolicy)).not.toContain('no proxy configured')
      expect(result.sandbox?.egress_attempts).toBeDefined()
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps Relay\'s own installation read-only, whatever working directory it was given', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-shell-protected-'))
    try {
      const result = await run({ command: 'echo', args: ['x'], working_directory: worktree })

      expect(result.sandbox?.readOnlyPaths).toBeDefined()
      expect((result.sandbox?.readOnlyPaths as string[]).length).toBeGreaterThan(0)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('reports the effective sandbox rules, per FR-SH-6', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'relay-shell-rules-'))
    try {
      const result = await run({ command: 'echo', args: ['x'], working_directory: worktree })

      expect(result.sandbox).toBeDefined()
      expect(String(result.sandbox?.networkPolicy)).toContain('denied')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 30_000)

  it('has NO network, so a command cannot reach out on its own', async () => {
    // curl is not on the allowlist, so this uses node, which is. The point
    // is that even a permitted binary gets no egress.
    const worktree = mkdtempSync(join(tmpdir(), 'relay-shell-net-'))
    try {
      const script = join(worktree, 'probe.js')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(script, 'fetch("https://example.com").then(()=>console.log("REACHED")).catch(()=>console.log("BLOCKED"))')

      const result = await run({ command: 'node', args: [script], working_directory: worktree, timeout_seconds: 30 })

      expect(result.stdout).toContain('BLOCKED')
      expect(result.stdout).not.toContain('REACHED')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 40_000)
})

describe('the working directory is validated, since it becomes the write grant', () => {
  it('refuses a directory that does not exist rather than confining a run to nothing', () => {
    const missing = validateWorktree('/no/such/place')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.reason).toContain('does not exist')
  })

  it('refuses a path that is not a directory', () => {
    const notADirectory = validateWorktree('/x', { stat: () => ({ isDirectory: () => false }) })
    expect(notADirectory.ok).toBe(false)
    if (notADirectory.ok) return
    expect(notADirectory.reason).toContain('not a directory')
  })

  it('REFUSES the home directory and the filesystem root, which would make confinement meaningless', () => {
    // The value arrives from a model that may have been reading an
    // attacker-controlled page, and it is the single thing deciding what the
    // run may write to.
    const stat = () => ({ isDirectory: () => true })

    for (const path of ['/', '/Users/op']) {
      const result = validateWorktree(path, { stat, home: '/Users/op' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('too broad')
    }
  })

  it('accepts an ordinary project directory, returning the RESOLVED path', () => {
    const accepted = validateWorktree('/Users/op/code/../code/project', {
      stat: () => ({ isDirectory: () => true }),
      home: '/Users/op',
    })

    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.path).toBe('/Users/op/code/project')
  })
})

describe("the egress destination list comes from policy, never from the call", () => {
  it('is empty when policy declares no allowed origins, so nothing is reachable by default', () => {
    // A run's network reach should be something an operator granted, not
    // something it inherited.
    expect(policyAllowedHosts('/no/such/policy.yaml')).toEqual([])
  })

  it('protects Relay\'s own installation from the run, whatever the working directory is', () => {
    // A run that could edit the policy file or the profile registry could
    // widen every other boundary in this system from inside the sandbox.
    expect(protectedPaths('/Users/op/.relay')).toContain('/Users/op/.relay')
  })
})
