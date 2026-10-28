import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { repoEntrySchema } from '../../src/repos/schema.js'
import {
  branchSlug,
  createWorktree,
  MINIMUM_FREE_BYTES,
  worktreeBranchName,
  worktreePath,
} from '../../src/repos/worktree.js'

/**
 * The guarantee under test is NFR-20: zero observed modifications to the
 * operator's primary working tree or checked-out branch. The unit tests
 * below cover the refusals; the integration test at the bottom drives a REAL
 * git repository, because the isolation claim is about what git actually
 * does and cannot be proved against a stub.
 */

function repo(overrides: Record<string, unknown> = {}) {
  return repoEntrySchema.parse({
    name: 'relay',
    path: '/Users/op/code/relay',
    permitted_operations: ['read', 'write'],
    ...overrides,
  })
}

describe('branch naming', () => {
  it('produces a git-safe slug, since git rejects most of what a task title contains', () => {
    // The failure without this arrives as an opaque git error at worktree
    // creation rather than as anything about the title.
    expect(branchSlug('Fix the "thing" (urgent!)')).toBe('fix-the-thing-urgent')
    expect(branchSlug('   ')).toBe('task')
    expect(branchSlug('a'.repeat(200)).length).toBeLessThanOrEqual(40)
  })

  it('derives one shape, so a branch is always attributable to its run', () => {
    expect(worktreeBranchName('run-42', 'Add a thing')).toBe('relay/run-42-add-a-thing')
  })
})

describe('FR-CODE-16: the worktree lives outside the repository', () => {
  it('places it under a Relay-owned root, not in the repo', () => {
    const path = worktreePath('relay', 'run-1', '/Users/op/.relay/worktrees')

    expect(path).toBe('/Users/op/.relay/worktrees/relay/run-1')
  })

  it('REFUSES a worktree root that would put it inside the repository', () => {
    // A worktree inside the repo shows up in the operator's own git status,
    // and "no Relay file is ever written into the operator's working tree"
    // becomes false the moment it exists.
    const git = vi.fn(() => 'abc123')
    const result = createWorktree(repo(), 'run-1', 'task', {
      git,
      worktreeRoot: '/Users/op/code/relay/.relay-worktrees',
      pathExists: () => true,
      makeDirectory: () => {},
      freeBytes: () => MINIMUM_FREE_BYTES * 2,
    })

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.reason).toContain('FR-CODE-16')
    expect(git).not.toHaveBeenCalled()
  })
})

describe('FR-CODE-15: the disk-pressure guard', () => {
  it('refuses before creating anything when free space is below the floor', () => {
    const git = vi.fn(() => 'abc123')
    const result = createWorktree(repo(), 'run-1', 'task', {
      git,
      worktreeRoot: '/Users/op/.relay/worktrees',
      pathExists: () => true,
      makeDirectory: () => {},
      freeBytes: () => 100,
    })

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.reason).toContain('free disk space')
    expect(git).not.toHaveBeenCalled()
  })

  it('proceeds when the disk check cannot answer, rather than blocking every run', () => {
    // A check that cannot run should not be the thing that stops all coding
    // on a platform where statfs behaves differently.
    const result = createWorktree(repo(), 'run-1', 'task', {
      git: () => 'abc123',
      worktreeRoot: '/Users/op/.relay/worktrees',
      pathExists: () => true,
      makeDirectory: () => {},
      freeBytes: () => undefined,
    })

    expect(result.outcome).toBe('created')
  })
})

describe('refusals that are not about disk', () => {
  it('refuses a registered path that does not exist', () => {
    const result = createWorktree(repo(), 'run-1', 'task', { pathExists: () => false })

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.reason).toContain('does not exist')
  })

  it('refuses when the default branch cannot be resolved, naming the branch', () => {
    const result = createWorktree(repo({ default_branch: 'trunk' }), 'run-1', 'task', {
      git: () => {
        throw new Error('unknown revision')
      },
      pathExists: () => true,
      makeDirectory: () => {},
      freeBytes: () => MINIMUM_FREE_BYTES * 2,
      worktreeRoot: '/Users/op/.relay/worktrees',
    })

    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') return
    expect(result.reason).toContain('trunk')
  })
})

describe('against a REAL git repository, which is where the guarantee lives', () => {
  let origin: string
  let worktrees: string

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), 'relay-git-repo-'))
    worktrees = mkdtempSync(join(tmpdir(), 'relay-git-worktrees-'))
    const run = (args: string[]) => execFileSync('git', args, { cwd: origin, stdio: 'ignore' })
    run(['init', '--initial-branch=main'])
    run(['config', 'user.email', 'test@example.com'])
    run(['config', 'user.name', 'Test'])
    writeFileSync(join(origin, 'README.md'), '# original\n')
    run(['add', 'README.md'])
    run(['commit', '-m', 'first'])
  })

  afterEach(() => {
    rmSync(origin, { recursive: true, force: true })
    rmSync(worktrees, { recursive: true, force: true })
  })

  it('creates a real worktree on a named branch at the recorded base commit', () => {
    const entry = repoEntrySchema.parse({ name: 'fixture', path: origin, permitted_operations: ['read', 'write'] })

    const result = createWorktree(entry, 'run-7', 'Add a feature', { worktreeRoot: worktrees })

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(existsSync(join(result.path, 'README.md'))).toBe(true)
    expect(result.branch).toBe('relay/run-7-add-a-feature')

    // FR-CODE-11: the recorded base is the commit the worktree really sits on.
    const head = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.path, encoding: 'utf8' })).trim()
    expect(head).toBe(result.baseCommit)
  })

  it('LEAVES THE OPERATOR\'S CHECKOUT UNTOUCHED, which is NFR-20', () => {
    const entry = repoEntrySchema.parse({ name: 'fixture', path: origin, permitted_operations: ['read', 'write'] })
    const before = {
      head: String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin, encoding: 'utf8' })).trim(),
      branch: String(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: origin, encoding: 'utf8' })).trim(),
      status: String(execFileSync('git', ['status', '--porcelain'], { cwd: origin, encoding: 'utf8' })),
    }

    const result = createWorktree(entry, 'run-8', 'Change things', { worktreeRoot: worktrees })
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return

    // Work in the worktree, as a coding run would.
    writeFileSync(join(result.path, 'README.md'), '# changed by the run\n')
    writeFileSync(join(result.path, 'new-file.txt'), 'added by the run\n')

    const after = {
      head: String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin, encoding: 'utf8' })).trim(),
      branch: String(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: origin, encoding: 'utf8' })).trim(),
      status: String(execFileSync('git', ['status', '--porcelain'], { cwd: origin, encoding: 'utf8' })),
    }

    expect(after).toEqual(before)
    expect(String(execFileSync('cat', [join(origin, 'README.md')], { encoding: 'utf8' }))).toBe('# original\n')
    expect(existsSync(join(origin, 'new-file.txt'))).toBe(false)
  })

  it('FR-CODE-12: two concurrent runs on one repository do not interfere', () => {
    const entry = repoEntrySchema.parse({ name: 'fixture', path: origin, permitted_operations: ['read', 'write'] })

    const first = createWorktree(entry, 'run-a', 'First', { worktreeRoot: worktrees })
    const second = createWorktree(entry, 'run-b', 'Second', { worktreeRoot: worktrees })

    expect(first.outcome).toBe('created')
    expect(second.outcome).toBe('created')
    if (first.outcome !== 'created' || second.outcome !== 'created') return

    writeFileSync(join(first.path, 'a.txt'), 'from a')
    writeFileSync(join(second.path, 'b.txt'), 'from b')

    expect(existsSync(join(first.path, 'b.txt'))).toBe(false)
    expect(existsSync(join(second.path, 'a.txt'))).toBe(false)
    expect(first.branch).not.toBe(second.branch)
  })
})
