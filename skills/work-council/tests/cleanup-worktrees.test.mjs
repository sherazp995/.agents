// Runs cleanup-worktrees.sh against throwaway git repos. Run: node --test tests/cleanup-worktrees.test.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const script = fileURLToPath(new URL('../cleanup-worktrees.sh', import.meta.url))
const RUN = 'wf_abc123-514'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const cleanup = (cwd, ...args) => execFileSync('bash', [script, ...args], { cwd, encoding: 'utf8' })

const repo = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-cleanup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}
const addWorktree = (dir, name) =>
  git(dir, 'worktree', 'add', '-q', '-b', `worktree-${name}`, join(dir, '.claude', 'worktrees', name))
const branches = (dir) => git(dir, 'branch', '--format=%(refname:short)').trim().split('\n')

test('removes the run and deletes .claude/worktrees once it is empty', (t) => {
  const dir = repo(t)
  addWorktree(dir, `${RUN}-1`)
  addWorktree(dir, `${RUN}-2`)
  cleanup(dir, RUN)
  assert.equal(existsSync(join(dir, '.claude', 'worktrees')), false)
  assert.deepEqual(branches(dir), ['main'])
})

test('keeps .claude/worktrees and other runs when it still has contents', (t) => {
  const dir = repo(t)
  addWorktree(dir, `${RUN}-1`)
  addWorktree(dir, 'wf_other-9-1')
  cleanup(dir, RUN)
  assert.equal(existsSync(join(dir, '.claude', 'worktrees', `${RUN}-1`)), false)
  assert.equal(existsSync(join(dir, '.claude', 'worktrees', 'wf_other-9-1')), true)
  assert.deepEqual(branches(dir), ['main', 'worktree-wf_other-9-1'])
})

test('keeps .claude/worktrees when it holds a plain file', (t) => {
  const dir = repo(t)
  addWorktree(dir, `${RUN}-1`)
  writeFileSync(join(dir, '.claude', 'worktrees', 'note.txt'), 'keep me\n')
  cleanup(dir, RUN)
  assert.equal(existsSync(join(dir, '.claude', 'worktrees', 'note.txt')), true)
})

test('--list prints the run worktrees and removes nothing', (t) => {
  const dir = repo(t)
  addWorktree(dir, `${RUN}-1`)
  const out = cleanup(dir, RUN, '--list')
  assert.match(out, new RegExp(`${RUN}-1`))
  assert.equal(existsSync(join(dir, '.claude', 'worktrees', `${RUN}-1`)), true)
})

test('never touches a run whose id extends this one', (t) => {
  const dir = repo(t)
  addWorktree(dir, 'wf_a-1-1')
  addWorktree(dir, 'wf_a-1-2-1')
  addWorktree(dir, 'wf_a-12-1')
  writeFileSync(join(dir, '.claude', 'worktrees', 'wf_a-1-2-1', 'dirty.txt'), 'unsaved\n')
  cleanup(dir, 'wf_a-1')
  assert.equal(existsSync(join(dir, '.claude', 'worktrees', 'wf_a-1-1')), false)
  assert.equal(existsSync(join(dir, '.claude', 'worktrees', 'wf_a-1-2-1', 'dirty.txt')), true)
  assert.deepEqual(branches(dir), ['main', 'worktree-wf_a-1-2-1', 'worktree-wf_a-12-1'])
})

test('rejects an unknown option or extra arguments without removing anything', (t) => {
  const dir = repo(t)
  addWorktree(dir, `${RUN}-1`)
  assert.throws(() => cleanup(dir, RUN, '--lis'), { status: 2 })
  assert.throws(() => cleanup(dir, RUN, '--list', 'extra'), { status: 2 })
  assert.equal(existsSync(join(dir, '.claude', 'worktrees', `${RUN}-1`)), true)
  assert.deepEqual(branches(dir), ['main', `worktree-${RUN}-1`])
})

test('rejects a run id that is not a workflow run id', (t) => {
  const dir = repo(t)
  assert.throws(() => cleanup(dir, ''), { status: 2 })
  assert.throws(() => cleanup(dir, '*'), { status: 2 })
})
