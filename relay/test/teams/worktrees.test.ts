import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Assignment, TeamRun } from '../../src/teams/types.js'
import { createRequestWorktree, ensureMemberWorktree, fetchPrHead, headOf, parsePrNumber } from '../../src/teams/worktrees.js'
import { snapshot } from './fixture.js'
import { commitFile, scratchRepo, scratchRoot, sh } from './git-scratch.js'

function teamRun(overrides: Partial<TeamRun>): TeamRun {
  return {
    id: randomUUID(), workspaceId: 'w', taskId: 't', projectId: 'p', title: 'Add a button', kind: 'build', repoName: 'web', repoPath: '/nowhere',
    prRef: null, baseCommit: '', worktreePath: null, branch: null, snapshot: snapshot('team'), status: 'open', createdAt: new Date(), ...overrides,
  }
}

function assignment(run: TeamRun, overrides: Partial<Assignment> = {}): Assignment {
  return { id: randomUUID(), runId: run.id, memberName: 'Theo', kind: 'build', startCommit: null, ...overrides } as Assignment
}

async function buildRun() {
  const root = scratchRoot()
  const repo = scratchRepo(root)
  const id = randomUUID()
  const made = await createRequestWorktree(repo, id, 'Add a button!')
  if (!made.ok) throw new Error(made.reason)
  return { root, repo, made, run: teamRun({ id, repoPath: repo.path, baseCommit: made.baseCommit, worktreePath: made.path, branch: made.branch }) }
}

describe('team worktrees', () => {
  it('makes the request worktree next to the repo from the local default branch, named by the run', async () => {
    const { root, repo, made, run } = await buildRun()
    const short = run.id.slice(0, 8)
    expect(made).toEqual({ ok: true, path: join(root, `web-add-a-button-${short}`), branch: `relay/${short}-add-a-button`, baseCommit: sh(repo.path, 'rev-parse', 'main') })
    expect(sh(made.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(made.branch)
    expect(sh(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('refuses a path that is not this run\'s worktree, and a branch the main checkout has checked out', async () => {
    const root = scratchRoot()
    const repo = scratchRepo(root)
    const id = randomUUID()
    const short = id.slice(0, 8)
    mkdirSync(join(root, `web-add-a-button-${short}`))
    expect(await createRequestWorktree(repo, id, 'add a button')).toMatchObject({ ok: false, reason: expect.stringContaining('is not this team run') })

    const other = randomUUID()
    sh(repo.path, 'worktree', 'add', '-q', '-b', 'someone-else', join(root, `web-fix-it-${other.slice(0, 8)}`))
    expect(await createRequestWorktree(repo, other, 'fix it')).toMatchObject({ ok: false, reason: expect.stringContaining('is not this team run') })

    const third = randomUUID()
    sh(repo.path, 'checkout', '-q', '-b', `relay/${third.slice(0, 8)}-ship-it`)
    expect(await createRequestWorktree(repo, third, 'ship it')).toMatchObject({ ok: false, reason: expect.stringContaining('main checkout') })
  })

  it('reuses its own request worktree on a retry', async () => {
    const { repo, made, run } = await buildRun()
    expect(await createRequestWorktree(repo, run.id, 'Add a button!')).toEqual(made)
  })

  it('gives a build member its own branch from the request head, and review a detached checkout of it; both reused', async () => {
    const { root, run, made } = await buildRun()
    const head = commitFile(made.path, 'lead.txt', 'lead\n', 'lead work')
    const wtRoot = join(root, 'relay-home', 'worktrees')
    const build = assignment(run, { memberName: 'Theo Ray' })
    const built = await ensureMemberWorktree(run, build, wtRoot)
    expect(built).toEqual({ path: join(wtRoot, 'web', build.id), branch: `relay/${run.id.slice(0, 8)}-${build.id.slice(0, 8)}-theo-ray`, startCommit: head })
    expect(sh(built.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(built.branch)
    commitFile(built.path, 'theo.txt', 'theo\n', 'theo work')
    expect(await ensureMemberWorktree(run, { ...build, startCommit: head }, wtRoot)).toEqual(built)

    const review = assignment(run, { kind: 'review', memberName: 'Iris' })
    const reviewed = await ensureMemberWorktree(run, review, wtRoot)
    expect(reviewed).toEqual({ path: join(wtRoot, 'web', review.id), branch: null, startCommit: head })
    expect(await headOf(reviewed.path)).toBe(head)
    expect(sh(reviewed.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(await ensureMemberWorktree(run, review, wtRoot)).toEqual(reviewed)
  })

  it('refuses a member path that exists and is not a worktree of the repo', async () => {
    const { root, run } = await buildRun()
    const wtRoot = join(root, 'home')
    const build = assignment(run)
    mkdirSync(join(wtRoot, 'web', build.id), { recursive: true })
    await expect(ensureMemberWorktree(run, build, wtRoot)).rejects.toThrow('is not a worktree')
  })

  it("puts a PR review run's members at the PR head fetched from origin", async () => {
    const root = scratchRoot()
    const repo = scratchRepo(root)
    sh(root, 'init', '-q', '--bare', 'origin.git')
    sh(repo.path, 'remote', 'add', 'origin', join(root, 'origin.git'))
    sh(repo.path, 'checkout', '-q', '-b', 'feature')
    const prHead = commitFile(repo.path, 'feature.txt', 'f\n', 'feature')
    sh(repo.path, 'push', '-q', 'origin', 'feature:refs/pull/1/head')
    sh(repo.path, 'checkout', '-q', 'main')
    sh(repo.path, 'branch', '-q', '-D', 'feature')

    expect(await fetchPrHead(repo, parsePrNumber('https://github.com/acme/web/pull/1') ?? 0)).toEqual({ ok: true, commit: prHead })
    expect(await fetchPrHead(repo, 2)).toMatchObject({ ok: false })
    const run = teamRun({ kind: 'pr-review', repoPath: repo.path, baseCommit: prHead, prRef: '1' })
    const qa = await ensureMemberWorktree(run, assignment(run, { kind: 'qa', memberName: 'Iris' }), join(root, 'home'))
    expect(qa.branch).toBeNull()
    expect(await headOf(qa.path)).toBe(prHead)
    expect(existsSync(join(qa.path, 'feature.txt'))).toBe(true)
  })

  it('reads PR numbers and links, and nothing else', () => {
    expect(parsePrNumber(42)).toBe(42)
    expect(parsePrNumber('#7')).toBe(7)
    expect(parsePrNumber('https://github.com/acme/web/pull/12/files')).toBe(12)
    expect(parsePrNumber('https://evil.example/acme/web/pull/12')).toBeUndefined()
    expect(parsePrNumber('12; rm -rf /')).toBeUndefined()
  })
})
