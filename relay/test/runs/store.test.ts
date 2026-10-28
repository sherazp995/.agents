import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { IllegalTransitionError } from '../../src/runs/state.js'
import {
  beginStep,
  completeStep,
  createRun,
  finishRun,
  listSteps,
  recordPlan,
  startRun,
} from '../../src/runs/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/** Fails loudly instead of skipping when the var is absent, matching every other database suite in this repo. A skipped test proves nothing. */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'Run store tests must fail, not silently skip, when it is absent.',
          )
        })
      })

function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run run-store tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

describeDb('src/runs/store.ts', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  /** Every run foreign-keys to a real workspace, session, and principal, so every test needs all three. */
  async function createFixtures(): Promise<{ workspaceId: string; sessionId: string; principalId: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(
      pool,
      workspaceId,
      'test',
      `U_${randomUUID()}`,
      'Test Principal',
      ['operator'],
    )
    const session = await findOrCreateSession(pool, {
      workspaceId,
      principalId,
      adapter: 'test',
      threadRef: `thread-${randomUUID()}`,
    })
    return { workspaceId, sessionId: session.id, principalId }
  }

  it('creates a run in state queued, with no started_at or ended_at yet', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })

    expect(run.state).toBe('queued')
    expect(run.workspaceId).toBe(workspaceId)
    expect(run.sessionId).toBe(sessionId)
    expect(run.principalId).toBe(principalId)
    expect(run.startedAt).toBeNull()
    expect(run.endedAt).toBeNull()
    expect(run.costUsd).toBeNull()
  })

  it('startRun transitions queued -> running and records started_at', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })

    const started = await startRun(pool, run.id)

    expect(started.state).toBe('running')
    expect(started.startedAt).not.toBeNull()
  })

  it('startRun refuses to run twice: the second call hits an illegal transition, not a silent no-op', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)

    await expect(startRun(pool, run.id)).rejects.toThrow(IllegalTransitionError)
  })

  it('finishRun transitions running -> succeeded and records ended_at and cost', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)

    const finished = await finishRun(pool, run.id, 'succeed', { costUsd: 0.42 })

    expect(finished.state).toBe('succeeded')
    expect(finished.endedAt).not.toBeNull()
    expect(finished.costUsd).toBe(0.42)
  })

  it('finishRun with dead_letter records the reason, distinct from a general failure reason', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)

    const finished = await finishRun(pool, run.id, 'dead_letter', {
      deadLetterReason: 'identical step repeated past the second threshold',
    })

    expect(finished.state).toBe('dead_letter')
    expect(finished.deadLetterReason).toBe('identical step repeated past the second threshold')
    expect(finished.failureReason).toBeNull()
  })

  it('finishRun with fail records a failure reason, and refuses a run already in a terminal state', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)
    await finishRun(pool, run.id, 'fail', { failureReason: 'run exceeded its timeout' })

    await expect(finishRun(pool, run.id, 'fail', { failureReason: 'again' })).rejects.toThrow(
      IllegalTransitionError,
    )
  })

  it('cancel is legal directly from queued, without ever starting the run', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })

    const cancelled = await finishRun(pool, run.id, 'cancel', {})

    expect(cancelled.state).toBe('cancelled')
  })

  it('recordPlan persists the plan onto the run row before any step exists, per FR-ORC-2', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    const plan = { goalRestatement: 'echo the input', plannedSteps: [{ capability: 'echo', description: 'x' }] }

    await recordPlan(pool, run.id, plan)

    const { rows } = await pool.query<{ plan: unknown }>('SELECT plan FROM runs WHERE id = $1', [run.id])
    expect(rows[0]?.plan).toEqual(plan)
  })

  it('beginStep persists a step already in state running, with a workspace_id scoped per AP-8', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)

    const step = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 'hello' })

    expect(step.state).toBe('running')
    expect(step.workspaceId).toBe(workspaceId)
    expect(step.capability).toBe('echo')
    expect(step.input).toBe('hello')
    expect(step.startedAt).not.toBeNull()
    expect(step.endedAt).toBeNull()
  })

  it('completeStep transitions running -> succeeded and records output and ended_at', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)
    const step = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 'hello' })

    const completed = await completeStep(pool, step.id, { event: 'succeed', output: 'hello' }, null)

    expect(completed.state).toBe('succeeded')
    expect(completed.output).toBe('hello')
    expect(completed.error).toBeNull()
    expect(completed.endedAt).not.toBeNull()
    expect(completed.policyDecision).toBeNull()
    expect(completed.policyReason).toBeNull()
  })

  it('completeStep transitions running -> timed_out and records the error, per FR-ORC-8', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)
    const step = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 'hello' })

    const completed = await completeStep(pool, step.id, { event: 'timeout', error: 'exceeded 120000ms' }, null)

    expect(completed.state).toBe('timed_out')
    expect(completed.error).toBe('exceeded 120000ms')
  })

  it('completeStep persists the mediation decision and reason, per Task 3', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)
    const step = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 'hello' })

    const completed = await completeStep(
      pool,
      step.id,
      { event: 'fail', error: 'denied by policy: capability "echo" is disabled by policy' },
      { decision: 'refuse', reason: 'capability "echo" is disabled by policy' },
    )

    expect(completed.policyDecision).toBe('refuse')
    expect(completed.policyReason).toBe('capability "echo" is disabled by policy')
  })

  it('assigns each step in a run a strictly increasing seq, in insertion order', async () => {
    const { workspaceId, sessionId, principalId } = await createFixtures()
    const run = await createRun(pool, { workspaceId, sessionId, principalId })
    await startRun(pool, run.id)

    const first = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 1 })
    const second = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 2 })
    const third = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 3 })

    expect(second.seq).toBeGreaterThan(first.seq)
    expect(third.seq).toBeGreaterThan(second.seq)

    const steps = await listSteps(pool, run.id)
    expect(steps.map((s) => s.input)).toEqual([1, 2, 3])
    expect(steps.map((s) => s.seq)).toEqual([first.seq, second.seq, third.seq])
  })

  it('listSteps scopes to its own run: a step from a different run never appears', async () => {
    const fixtures = await createFixtures()
    const runA = await createRun(pool, fixtures)
    const runB = await createRun(pool, fixtures)
    await startRun(pool, runA.id)
    await startRun(pool, runB.id)

    await beginStep(pool, { runId: runA.id, workspaceId: fixtures.workspaceId, capability: 'echo', input: 'a' })
    await beginStep(pool, { runId: runB.id, workspaceId: fixtures.workspaceId, capability: 'echo', input: 'b' })

    const stepsA = await listSteps(pool, runA.id)
    expect(stepsA).toHaveLength(1)
    expect(stepsA[0]?.input).toBe('a')
  })

  // -------------------------------------------------------------------------
  // Gate fix, Blocker 2: FR-ORC-1's monotonic per-run transition sequence.
  // -------------------------------------------------------------------------

  describe('transition_seq (Blocker 2)', () => {
    it('starts at 0 on creation, and startRun bumps it', async () => {
      const { workspaceId, sessionId, principalId } = await createFixtures()
      const run = await createRun(pool, { workspaceId, sessionId, principalId })
      expect(run.transitionSeq).toBe(0)

      const started = await startRun(pool, run.id)
      expect(started.transitionSeq).toBe(1)
    })

    it('completeStep increments the parent run transition_seq rather than silently updating, and stamps the value onto the step', async () => {
      const { workspaceId, sessionId, principalId } = await createFixtures()
      const run = await createRun(pool, { workspaceId, sessionId, principalId })
      const started = await startRun(pool, run.id)
      expect(started.transitionSeq).toBe(1)

      const stepOne = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 1 })
      expect(stepOne.runTransitionSeq).toBeNull() // not completed yet: no transition consumed

      const completedOne = await completeStep(pool, stepOne.id, { event: 'succeed', output: 1 }, null)
      expect(completedOne.runTransitionSeq).toBe(2)

      const stepTwo = await beginStep(pool, { runId: run.id, workspaceId, capability: 'echo', input: 2 })
      const completedTwo = await completeStep(pool, stepTwo.id, { event: 'succeed', output: 2 }, null)
      expect(completedTwo.runTransitionSeq).toBe(3)

      // Reading the run row directly proves the run's own counter, not just
      // the value handed back to each individual completeStep caller, moved.
      const { rows } = await pool.query<{ transition_seq: number }>(
        'SELECT transition_seq FROM runs WHERE id = $1',
        [run.id],
      )
      expect(rows[0]?.transition_seq).toBe(3)

      const finished = await finishRun(pool, run.id, 'succeed', {})
      expect(finished.transitionSeq).toBe(4)
    })
  })

  // -------------------------------------------------------------------------
  // Gate fix, Blocker 6: a run's own timeout must bound store operations,
  // not just the engine and capability calls.
  // -------------------------------------------------------------------------

  describe('timeoutMs bounds a blocked query (Blocker 6)', () => {
    it('startRun given a short timeoutMs fails fast rather than hanging on a row a concurrent transaction holds locked', async () => {
      const { workspaceId, sessionId, principalId } = await createFixtures()
      const run = await createRun(pool, { workspaceId, sessionId, principalId })

      // A second, independent connection takes and holds a row lock on this
      // run, deliberately never committing or rolling back for the
      // duration of this test: the deliberately blocked query the gate
      // finding asks for.
      const locker = await pool.connect()
      await locker.query('BEGIN')
      await locker.query('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [run.id])

      try {
        const startedAt = Date.now()
        await expect(startRun(pool, run.id, 200)).rejects.toThrow(/lock timeout|statement timeout/i)
        const elapsedMs = Date.now() - startedAt

        // Bounded near the 200ms budget given, not left hanging for however
        // long the lock holder keeps the row: a generous multiple of the
        // bound absorbs scheduler jitter without weakening the assertion
        // that this is bounded rather than unbounded.
        expect(elapsedMs).toBeLessThan(5_000)
      } finally {
        await locker.query('ROLLBACK')
        locker.release()
      }

      // The lock is released now: a normal, unbounded call succeeds,
      // proving the earlier failure was the timeout, not a broken run row.
      const started = await startRun(pool, run.id)
      expect(started.state).toBe('running')
    })
  })
})
