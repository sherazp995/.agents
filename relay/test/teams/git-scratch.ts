/** Scratch git repos under a temp folder for the team worktree and merge tests. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoEntrySchema, type RepoEntry } from '../../src/repos/schema.js'

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function scratchRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'relay-team-git-')))
}

/** A repo `name` under `root` on branch main with one commit, its user set. */
export function scratchRepo(root: string, name = 'web', aliases: string[] = []): RepoEntry {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  sh(path, 'init', '-q', '-b', 'main')
  sh(path, 'config', 'user.name', 'Relay Test')
  sh(path, 'config', 'user.email', 'relay-test@example.com')
  sh(path, 'config', 'commit.gpgsign', 'false')
  commitFile(path, 'README.md', 'line one\n', 'first')
  return repoEntrySchema.parse({ name, aliases, path, permitted_operations: ['read', 'write'] })
}

/** Writes a file and commits it; returns the new head. */
export function commitFile(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text)
  sh(cwd, 'add', file)
  sh(cwd, '-c', 'user.name=Relay Test', '-c', 'user.email=relay-test@example.com', 'commit', '-q', '-m', message)
  return sh(cwd, 'rev-parse', 'HEAD')
}
