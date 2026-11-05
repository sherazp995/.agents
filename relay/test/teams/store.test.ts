import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acquireLease, markTaskStopped } from '../../src/autonomous/store.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import {
  acquireAssignmentLease,
  answerAssignment,
  cancelTaskAssignments,
  closeRun,
  findOrCreateMerge,
  insertAssignment,
  listLiveAssignments,
  loadAssignment,
  updateAssignmentAndTellLead,
} from '../../src/teams/store.js'
import { loadTask } from '../../src/autonomous/store.js'
import { getTestDatabaseUrl } from '../support/database.js'
import { openRun, teamFixture } from './fixture.js'

describe('team store', () => {
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

  it('refuses a second open run for a task, and allows a new one once it is finished', async () => {
    const fixture = await teamFixture(pool)
    const first = await openRun(pool, fixture)
    await expect(openRun(pool, fixture, { title: 'other' })).rejects.toThrow('already has an open team request')
    await closeRun(pool, first.id, 'finished')
    expect((await openRun(pool, fixture, { title: 'other' })).status).toBe('open')
  })

  it('takes a repeated assign key once', async () => {
    const fixture = await teamFixture(pool)
    const run = await openRun(pool, fixture)
    const input = { workspaceId: fixture.workspaceId, run, memberId: 'm0', memberName: 'Theo', kind: 'build' as const, brief: 'add it', idemKey: 'k1' }
    const first = await insertAssignment(pool, input)
    const again = await insertAssignment(pool, { ...input, brief: 'different' })
    expect(first.created).toBe(true)
    expect(again).toMatchObject({ created: false, assignment: { id: first.assignment.id, brief: 'add it' } })
  })

  it('refuses a second merge record for one assignment and commit, at the database', async () => {
    const fixture = await teamFixture(pool)
    const run = await openRun(pool, fixture)
    const { assignment } = await insertAssignment(pool, { workspaceId: fixture.workspaceId, run, memberId: 'm0', memberName: 'Theo', kind: 'build', brief: 'b', idemKey: 'k' })
    const merge = await findOrCreateMerge(pool, fixture.workspaceId, assignment.id, 'c1')
    expect((await findOrCreateMerge(pool, fixture.workspaceId, assignment.id, 'c1')).id).toBe(merge.id)
    await expect(pool.query('INSERT INTO team_merges (workspace_id, assignment_id, member_commit) VALUES ($1, $2, $3)', [fixture.workspaceId, assignment.id, 'c1'])).rejects.toThrow()
  })

  it('writes a member result and its note to the lead together; a stale lease or a cancelled task writes neither', async () => {
    const fixture = await teamFixture(pool)
    const run = await openRun(pool, fixture)
    const { assignment } = await insertAssignment(pool, { workspaceId: fixture.workspaceId, run, memberId: 'm0', memberName: 'Theo', kind: 'build', brief: 'b', idemKey: 'k' })
    const held = await acquireAssignmentLease(pool, assignment.id, 'relay-1', 60_000)
    if (!held) throw new Error('no lease')
    // The lead is mid-turn: it holds its own lease, and the note still lands for its next turn.
    const leadLease = await acquireLease(pool, fixture.task.id, 'relay-1', 60_000)
    expect(leadLease).toBeDefined()

    const stale = { ...held.lease, generation: held.lease.generation - 1 }
    expect(await updateAssignmentAndTellLead(pool, stale, { state: 'done', resultText: 'stale' }, 'stale note')).toBe(false)
    expect(await updateAssignmentAndTellLead(pool, held.lease, { state: 'done', resultText: 'did it', releaseLease: true }, 'Theo finished')).toBe(true)

    expect((await loadAssignment(pool, assignment.id))?.resultText).toBe('did it')
    expect((await loadTask(pool, fixture.task.id))?.pendingNotes).toEqual(['Theo finished'])

    // After Stop, a late result writes nothing.
    const second = await insertAssignment(pool, { workspaceId: fixture.workspaceId, run, memberId: 'm1', memberName: 'Iris', kind: 'build', brief: 'b', idemKey: 'k2' })
    const late = await acquireAssignmentLease(pool, second.assignment.id, 'relay-1', 60_000)
    if (!late) throw new Error('no lease')
    await markTaskStopped(pool, fixture.task.id)
    expect(await updateAssignmentAndTellLead(pool, late.lease, { state: 'done', resultText: 'late' }, 'late note')).toBe(false)
    expect((await loadAssignment(pool, second.assignment.id))?.resultText).toBeNull()
    expect((await loadTask(pool, fixture.task.id))?.pendingNotes).toEqual(['Theo finished'])
  })

  it('an answer requeues a waiting member and is kept among its answers', async () => {
    const fixture = await teamFixture(pool)
    const run = await openRun(pool, fixture)
    const { assignment } = await insertAssignment(pool, { workspaceId: fixture.workspaceId, run, memberId: 'm0', memberName: 'Theo', kind: 'build', brief: 'b', idemKey: 'k' })
    await pool.query(`UPDATE team_assignments SET state = 'waiting', question = 'which?' WHERE id = $1`, [assignment.id])
    const answered = await answerAssignment(pool, assignment.id, 'the blue one')
    expect(answered).toMatchObject({ state: 'queued', question: null, pendingNotes: ['the blue one'], answers: ['the blue one'] })
  })

  it('Stop cancels every live assignment and bumps its generation; the kill switch query finds live ones whatever the task phase', async () => {
    const fixture = await teamFixture(pool)
    const run = await openRun(pool, fixture)
    const { assignment } = await insertAssignment(pool, { workspaceId: fixture.workspaceId, run, memberId: 'm0', memberName: 'Theo', kind: 'build', brief: 'b', idemKey: 'k' })
    const held = await acquireAssignmentLease(pool, assignment.id, 'relay-1', 60_000)
    if (!held) throw new Error('no lease')
    await pool.query(`UPDATE team_assignments SET worker_pgid = 4242 WHERE id = $1`, [assignment.id])
    await pool.query(`UPDATE autonomous_tasks SET phase = 'done' WHERE id = $1`, [fixture.task.id])

    expect((await listLiveAssignments(pool, fixture.workspaceId)).map((a) => a.id)).toEqual([assignment.id])
    expect(await cancelTaskAssignments(pool, fixture.task.id)).toEqual([4242])
    const after = await loadAssignment(pool, assignment.id)
    expect(after?.state).toBe('cancelled')
    expect(after?.leaseGeneration).toBe(held.lease.generation + 1)
  })
})
