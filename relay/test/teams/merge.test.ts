import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { markTaskStopped } from '../../src/autonomous/store.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { mergeAssignment, mergeMessage } from '../../src/teams/merge.js'
import { closeRun, insertAssignment, listRunMerges, loadAssignment } from '../../src/teams/store.js'
import type { Assignment, TeamRun } from '../../src/teams/types.js'
import { createRequestWorktree, ensureMemberWorktree } from '../../src/teams/worktrees.js'
import { getTestDatabaseUrl } from '../support/database.js'
import { openRun, teamFixture } from './fixture.js'
import { commitFile, scratchRepo, scratchRoot, sh } from './git-scratch.js'

describe('merging a member into the request branch', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function setup() {
    const fixture = await teamFixture(pool)
    const root = scratchRoot()
    const repo = scratchRepo(root)
    const id = randomUUID()
    const made = await createRequestWorktree(repo, id, 'add a button')
    if (!made.ok) throw new Error(made.reason)
    const run = await openRun(pool, fixture, { id, repoPath: repo.path, baseCommit: made.baseCommit, worktreePath: made.path, branch: made.branch })
    /** A member who commits `file` with `text` in its own worktree and is done. */
    const work = async (member: string, file: string, text: string, brief = `do ${file}`): Promise<Assignment> => {
      const { assignment } = await insertAssignment(pool, { workspaceId: fixture.workspaceId, run, memberId: `m-${member}`, memberName: member, kind: 'build', brief, idemKey: randomUUID() })
      const tree = await ensureMemberWorktree(run, assignment, join(root, 'home'))
      const commit = commitFile(tree.path, file, text, `${member} work`)
      await pool.query(`UPDATE team_assignments SET state = 'done', result_commit = $2 WHERE id = $1`, [assignment.id, commit])
      return (await loadAssignment(pool, assignment.id)) as Assignment
    }
    return { fixture, repo, run, work, tree: made.path }
  }

  const head = (run: TeamRun) => sh(run.worktreePath as string, 'rev-parse', 'HEAD')
  const clean = (run: TeamRun) => sh(run.worktreePath as string, 'status', '--porcelain') === ''

  it("merges two members' commits with --no-ff, and a repeat changes nothing", async () => {
    const { run, work } = await setup()
    const theo = await work('Theo', 'a.txt', 'a\n', 'Add the button\nmore detail')
    const iris = await work('Iris', 'b.txt', 'b\n')
    const first = await mergeAssignment(pool, run, theo)
    expect(first).toMatchObject({ kind: 'merged', already: false })
    expect(await mergeAssignment(pool, run, iris)).toMatchObject({ kind: 'merged', already: false })
    const after = head(run)
    expect(sh(run.worktreePath as string, 'log', '--merges', '--format=%s')).toBe("Merge Iris's work: do b.txt\nMerge Theo's work: Add the button")
    expect(await mergeAssignment(pool, run, theo)).toEqual({ kind: 'merged', head: first.kind === 'merged' ? first.head : '', already: true })
    expect(head(run)).toBe(after)
    expect((await listRunMerges(pool, run.id)).map((merge) => merge.state)).toEqual(['merged', 'merged'])
  })

  it('aborts a conflict, names the files and leaves the branch as it was', async () => {
    const { run, work } = await setup()
    const theo = await work('Theo', 'README.md', 'theo\n')
    const iris = await work('Iris', 'README.md', 'iris\n')
    await mergeAssignment(pool, run, theo)
    const before = head(run)
    expect(await mergeAssignment(pool, run, iris)).toEqual({ kind: 'conflict', files: ['README.md'] })
    expect(head(run)).toBe(before)
    expect(clean(run)).toBe(true)
    expect((await listRunMerges(pool, run.id))[0]).toMatchObject({ state: 'conflict', conflictFiles: ['README.md'], headBefore: before, headAfter: before })
  })

  it('records as merged a commit git merged before the record was saved', async () => {
    const { run, work } = await setup()
    const theo = await work('Theo', 'a.txt', 'a\n')
    sh(run.worktreePath as string, 'merge', '-q', '--no-ff', '-m', 'by hand', theo.resultCommit as string)
    const merged = head(run)
    expect(await mergeAssignment(pool, run, theo)).toEqual({ kind: 'merged', head: merged, already: true })
    expect(head(run)).toBe(merged)
    expect((await listRunMerges(pool, run.id))[0]).toMatchObject({ state: 'merged', headAfter: merged })
  })

  it('aborts a half-done merge left in the worktree and merges again', async () => {
    const { run, work } = await setup()
    const theo = await work('Theo', 'a.txt', 'a\n')
    const before = head(run)
    sh(run.worktreePath as string, 'merge', '-q', '--no-ff', '--no-commit', theo.resultCommit as string)
    expect(sh(run.worktreePath as string, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBe(theo.resultCommit)
    expect(await mergeAssignment(pool, run, theo)).toMatchObject({ kind: 'merged', already: false })
    expect(sh(run.worktreePath as string, 'rev-parse', 'HEAD^1')).toBe(before)
    expect(sh(run.worktreePath as string, 'rev-parse', 'HEAD^2')).toBe(theo.resultCommit)
    expect(clean(run)).toBe(true)
  })

  it('refuses after Stop and once the run is finished, merging nothing', async () => {
    const stopped = await setup()
    const theo = await stopped.work('Theo', 'a.txt', 'a\n')
    const before = head(stopped.run)
    await markTaskStopped(pool, stopped.fixture.task.id)
    expect(await mergeAssignment(pool, stopped.run, theo)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('stopped') })
    expect(head(stopped.run)).toBe(before)

    const finished = await setup()
    const iris = await finished.work('Iris', 'b.txt', 'b\n')
    await closeRun(pool, finished.run.id, 'finished')
    expect(await mergeAssignment(pool, finished.run, iris)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('finished') })
  })

  it('refuses a PR review run, an unfinished assignment and a review', async () => {
    const { run, work, fixture } = await setup()
    const theo = await work('Theo', 'a.txt', 'a\n')
    expect(await mergeAssignment(pool, { ...run, kind: 'pr-review', worktreePath: null, branch: null }, theo)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('PR review') })
    expect(await mergeAssignment(pool, run, { ...theo, state: 'running' })).toMatchObject({ kind: 'refused' })
    expect(await mergeAssignment(pool, run, { ...theo, kind: 'review' })).toMatchObject({ kind: 'refused' })
    expect(fixture.task.id).toBe(run.taskId)
  })

  it('trims the brief line in the merge message', () => {
    expect(mergeMessage({ memberName: 'Theo', brief: `\n  ${'x'.repeat(80)}  \nmore` })).toBe(`Merge Theo's work: ${'x'.repeat(60)}`)
  })
})
