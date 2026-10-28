import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCodeTask } from '../../../src/agent/capabilities/code.js'

/**
 * The assembly point. Each piece is tested on its own elsewhere; what these
 * check is that the ORDER holds, because the order is the safety property:
 * resolution and permission before a worktree exists, the worktree before
 * the engine runs.
 *
 * The engine itself is not invoked here. Doing so would spend real money on
 * every test run, and what a coding agent produces is not a thing to assert
 * on anyway. The gates in front of it are.
 */

let workspace: string
let repoPath: string
let reposFile: string
let worktrees: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'relay-code-'))
  repoPath = join(workspace, 'fixture-repo')
  worktrees = join(workspace, 'worktrees')
  reposFile = join(workspace, 'repos.yaml')

  const run = (args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' })
  execFileSync('mkdir', ['-p', repoPath])
  run(['init', '--initial-branch=main'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n')
  run(['add', 'README.md'])
  run(['commit', '-m', 'first'])
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function writeRegistry(entry: Record<string, unknown>) {
  writeFileSync(
    reposFile,
    `version: 1\nrepos:\n  - name: ${entry.name}\n    path: ${entry.path}\n    permitted_operations: [${(entry.permitted_operations as string[]).join(', ')}]\n`,
  )
}

describe('the gates run before anything is created', () => {
  it('refuses an unregistered repository, and never makes a worktree for it', async () => {
    writeRegistry({ name: 'fixture', path: repoPath, permitted_operations: ['read', 'write'] })

    const result = await runCodeTask({ repo: 'not-registered', task: 'do a thing' }, undefined, {
      reposPath: reposFile,
      worktreeRoot: worktrees,
    })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('never operates a repository absent from the registry')
    expect(result.worktree).toBeUndefined()
  })

  it('refuses a repository that does not permit writing, before creating a worktree', async () => {
    // Permission is a property of the registry, so it is checked before any
    // filesystem work rather than after.
    writeRegistry({ name: 'fixture', path: repoPath, permitted_operations: ['read'] })

    const result = await runCodeTask({ repo: 'fixture', task: 'do a thing' }, undefined, {
      reposPath: reposFile,
      worktreeRoot: worktrees,
    })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('not a permitted operation')
    expect(result.worktree).toBeUndefined()
  })

  it('refuses when no registry exists at all, rather than inventing a repository', async () => {
    const result = await runCodeTask({ repo: 'anything', task: 'x' }, undefined, {
      reposPath: join(workspace, 'no-such-file.yaml'),
      worktreeRoot: worktrees,
    })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('Registered: none')
  })

  it('requires a repository to be NAMED, since Relay never infers one', async () => {
    const result = await runCodeTask({ task: 'do a thing' }, undefined, { reposPath: reposFile, worktreeRoot: worktrees })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('name the repository')
  })

  it('refuses an ambiguous name rather than picking one', async () => {
    writeFileSync(
      reposFile,
      `version: 1\nrepos:\n  - name: fixture-one\n    path: ${repoPath}\n    permitted_operations: [read, write]\n` +
        `  - name: fixture-two\n    path: ${repoPath}\n    permitted_operations: [read, write]\n`,
    )

    const result = await runCodeTask({ repo: 'fixture', task: 'x' }, undefined, { reposPath: reposFile, worktreeRoot: worktrees })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('will not choose between them')
  })
})

describe('a refused run leaves the operator\'s checkout exactly as it was', () => {
  it('changes nothing in the repository when the gates refuse', async () => {
    writeRegistry({ name: 'fixture', path: repoPath, permitted_operations: ['read'] })
    const before = String(execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8' }))

    await runCodeTask({ repo: 'fixture', task: 'x' }, undefined, { reposPath: reposFile, worktreeRoot: worktrees })

    expect(String(execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8' }))).toBe(before)
  })
})
