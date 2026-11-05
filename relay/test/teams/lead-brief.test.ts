import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKER_BRIEF } from '../../src/autonomous/prompt.js'
import { intakeMention, loadTask } from '../../src/autonomous/store.js'
import { taskSubject } from '../../src/autonomous/turn-runner.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { NO_LEAD_NOTE, leadTurnSubject } from '../../src/teams/lead-brief.js'
import { getTestDatabaseUrl } from '../support/database.js'
import { openRun, teamFixture } from './fixture.js'

describe("the lead's turn", () => {
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

  it("gives a thread outside any project exactly today's subject", async () => {
    const fixture = await teamFixture(pool)
    const result = await intakeMention(pool, {
      workspaceId: fixture.workspaceId,
      principalId: fixture.principalId,
      adapter: 'slack',
      threadRef: `CX:${randomUUID()}`,
      event: { id: randomUUID(), principalId: fixture.principalId, text: 'hi', ref: { channel: 'C_NO_PROJECT', message: '2.2' }, fileIds: [], receivedAt: '' },
      replyRef: { channel: 'C_NO_PROJECT', thread: '2.2' },
      files: [],
    })
    if (result.kind !== 'created') throw new Error('no task')
    expect(await leadTurnSubject(pool, result.task)).toEqual(taskSubject(result.task))
  })

  it("runs a lead on the lead member's client and model, with the roster, commands and the open request's worktree, also after a restart", async () => {
    const fixture = await teamFixture(pool)
    await pool.query(`UPDATE team_members SET client = 'codex', model = 'gpt-6' WHERE team_id = $1 AND is_lead`, [fixture.teamId])
    const before = await leadTurnSubject(pool, fixture.task)
    expect(before).toMatchObject({ client: 'codex', model: 'gpt-6', noMcp: false, cwd: null })
    expect(before.brief?.startsWith(WORKER_BRIEF)).toBe(true)
    expect(before.brief).toContain('You lead this project\'s team: Web. You are Maya (Lead).')
    expect(before.brief).toContain('- Theo: Developer')
    expect(before.brief).toContain('relay team assign --member <name>')
    expect(before.brief).not.toContain('Open request:')

    await openRun(pool, fixture, { worktreePath: '/repos/web-add-a-button-1234abcd', branch: 'relay/1234abcd-add-a-button' })
    // A restart re-reads everything from the database.
    const task = await loadTask(pool, fixture.task.id)
    if (!task) throw new Error('no task')
    expect((await leadTurnSubject(pool, task)).brief).toContain('Open request: "add a button" (build) in web, request worktree /repos/web-add-a-button-1234abcd on branch relay/1234abcd-add-a-button')
  })

  it('a team with no lead runs as today and says so once', async () => {
    const fixture = await teamFixture(pool)
    await pool.query('UPDATE team_members SET is_lead = false WHERE team_id = $1', [fixture.teamId])
    const subject = await leadTurnSubject(pool, fixture.task)
    expect(subject).toEqual({ ...taskSubject(fixture.task), brief: `${WORKER_BRIEF}\n\n${NO_LEAD_NOTE}` })
  })

  it('an empty team runs exactly as today', async () => {
    const fixture = await teamFixture(pool)
    await pool.query('DELETE FROM team_members WHERE team_id = $1', [fixture.teamId])
    expect(await leadTurnSubject(pool, fixture.task)).toEqual(taskSubject(fixture.task))
  })
})
