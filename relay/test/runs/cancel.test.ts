/**
 * Tests for src/runs/cancel.ts, and the GT-14 proof that src/agent/loop.ts
 * (Task 6) honours it. Two groups:
 *
 *   - CancellationToken / CancellationRegistry: pure, no database, no
 *     engine, no capability. These prove the primitive itself: idempotent
 *     cancel, safe no-op on an unknown or released run id.
 *   - The describeDb block below: real Postgres, a fake engine (never the
 *     real `claude` binary; this file spawns no LIVE test, matching the
 *     one-LIVE-test-total rule test/agent/loop.test.ts's header states),
 *     and, for the timing proof only, a deliberately slow test-support
 *     capability that spawns a real child process
 *     (test/support/slow-capability.ts). These prove FR-ORC-4 and GT-14
 *     against the actual loop: a Stop halts at a step boundary, aborts a
 *     genuinely long-running capability within five seconds (measured, not
 *     assumed), preserves whatever had already been persisted, and a
 *     malformed engine response arriving during cancellation does not throw
 *     out of the cancellation path.
 *
 * THE HONEST CLAIM, per DEC-1 and this task's brief: every test below that
 * says "cancelled" proves the run is recorded cancelled within the five
 * second bound with partial progress preserved. None of them prove the run
 * stopped cleanly, because it did not: cancellation here is termination.
 */

import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Pool } from 'pg'
import { afterAll, beforeAll } from 'vitest'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/obs/logger.js'
import { createRunContext } from '../../src/obs/context.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { createRun, listSteps } from '../../src/runs/store.js'
import { wrapUntrusted } from '../../src/agent/untrusted.js'
import type { Untrusted } from '../../src/agent/untrusted.js'
import { EngineResponseError, PLAN_JSON_SCHEMA, runAgentLoop } from '../../src/agent/loop.js'
import type { Engine, EngineResult } from '../../src/agent/loop.js'
import { echo } from '../../src/agent/capabilities/echo.js'
import { registerBuiltinCapabilities } from '../../src/capabilities/wiring.js'
import { registerCapability } from '../../src/capabilities/registry.js'
import { obliviousSlowCapability, resetSpawnedChildPids, slowCapability, spawnedChildPids } from '../support/slow-capability.js'
import { getTestDatabaseUrl } from '../support/database.js'
import { isProcessAlive } from '../support/process-alive.js'
import { CANCELLATION_BOUND_MS, CancellationRegistry, CancellationToken } from '../../src/runs/cancel.js'
import type { Policy } from '../../src/config/schema.js'

/**
 * AP-1: src/agent/loop.ts now mediates every capability call through
 * src/policy/engine.ts before invoking it, per Task 3. This policy imposes
 * no restriction at all, so every test in this file keeps exercising
 * exactly what it exercised before that seam existed: cancellation timing,
 * never governance. A restrictive policy has its own coverage in
 * test/agent/loop.test.ts's "AP-1: the mediation seam" describe block.
 */
const PERMISSIVE_POLICY: Policy = {
  version: 1,
  defaults: { unmatched: 'ask' },
  hard_blocked_origins: ['*.never-matched.invalid'],
}

// ---------------------------------------------------------------------------
// Pure tests: no database, no engine, no capability.
// ---------------------------------------------------------------------------

describe('CancellationToken', () => {
  it('starts unaborted, with no recorded reason', () => {
    const token = new CancellationToken('run-1')
    expect(token.cancelled).toBe(false)
    expect(token.signal.aborted).toBe(false)
    expect(token.cancellationReason).toBeUndefined()
  })

  it('cancel() aborts the signal and records the given reason', () => {
    const token = new CancellationToken('run-1')
    token.cancel('operator pressed stop')
    expect(token.cancelled).toBe(true)
    expect(token.signal.aborted).toBe(true)
    expect(token.cancellationReason).toBe('operator pressed stop')
  })

  it('cancel() defaults to a stated reason when none is given', () => {
    const token = new CancellationToken('run-1')
    token.cancel()
    expect(token.cancellationReason).toBe('stopped by operator')
  })

  it('cancel() is idempotent: a second call does not throw, and keeps the first reason', () => {
    const token = new CancellationToken('run-1')
    token.cancel('first reason')
    expect(() => token.cancel('second reason')).not.toThrow()
    expect(token.cancellationReason).toBe('first reason')
    expect(token.cancelled).toBe(true)
  })
})

describe('CancellationRegistry', () => {
  it('register() returns a token carrying the run id, and has() reflects registration', () => {
    const registry = new CancellationRegistry()
    expect(registry.has('run-1')).toBe(false)
    const token = registry.register('run-1')
    expect(token.runId).toBe('run-1')
    expect(registry.has('run-1')).toBe(true)
  })

  it('cancel() on a run id that was never registered is a safe no-op', () => {
    const registry = new CancellationRegistry()
    expect(() => registry.cancel('never-registered')).not.toThrow()
  })

  it("cancel() reaches the registered run's own token", () => {
    const registry = new CancellationRegistry()
    const token = registry.register('run-1')
    registry.cancel('run-1', 'stop')
    expect(token.cancelled).toBe(true)
    expect(token.cancellationReason).toBe('stop')
  })

  it('release() removes the token, so a later cancel() for that run id becomes a safe no-op', () => {
    const registry = new CancellationRegistry()
    const token = registry.register('run-1')
    registry.release('run-1')
    expect(registry.has('run-1')).toBe(false)
    expect(() => registry.cancel('run-1', 'too late')).not.toThrow()
    expect(token.cancelled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration tests: real Postgres, a fake (never live) engine, and the
// real runAgentLoop from src/agent/loop.ts.
// ---------------------------------------------------------------------------

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
              'Cancellation tests must fail, not silently skip, when it is absent.',
          )
        })
      })

function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run cancellation tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

function fakeResult(resultText: string, overrides: Partial<EngineResult> = {}): EngineResult {
  return {
    sessionId: `fake-${randomUUID()}`,
    numTurns: 1,
    stopReason: 'end_turn',
    totalCostUsd: 0.001,
    usage: {},
    permissionDenials: [],
    resultText,
    isError: false,
    errors: [],
    ...overrides,
  }
}

function planJson(firstAction: { capability: string; input?: unknown }): string {
  return JSON.stringify({
    goalRestatement: 'exercise cancellation',
    plannedSteps: [{ capability: firstAction.capability, description: 'first step' }],
    riskTier: 'low',
    estimatedCost: 'negligible',
    firstAction,
  })
}

function decisionJson(overrides: { done?: boolean; capability?: string; input?: unknown } = {}): string {
  return JSON.stringify({ done: false, ...overrides })
}

function isPlanCall(jsonSchema: string): boolean {
  return jsonSchema === PLAN_JSON_SCHEMA
}

/** Polls `predicate` until it is true, or throws once `timeoutMs` elapses. Used instead of a fixed sleep so every test synchronizes on the real condition it needs, not a guessed delay. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition was not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describeDb('src/runs/cancel.ts + src/agent/loop.ts', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
    // AP-1: src/agent/loop.ts's mediation seam refuses any capability
    // absent from the capability registry before invoking it (see
    // src/policy/engine.ts's mediate()), which is now true regardless of
    // whether the policy itself would have allowed the call. 'echo' is
    // registered via the normal built-in path; 'oblivious' and 'slow'
    // (test/support/slow-capability.ts) exist only for this file's own
    // GT-14 timing proof and were never meant to be production
    // capabilities, so they get a minimal, permissive, test-only
    // registration here rather than joining the real built-in list.
    registerBuiltinCapabilities()
    const testOnlySlowCapabilitySchema = z.object({ seconds: z.number() })
    for (const name of ['oblivious', 'slow']) {
      registerCapability({
        name,
        description: `test-only capability (${name}), see test/support/slow-capability.ts`,
        inputSchema: testOnlySlowCapabilitySchema,
        outputSchema: z.unknown(),
        riskTier: 'read',
        idempotencyClass: 'safe',
        requiredRunnerFeatures: [],
        costHint: 'free',
        requiresMachineLock: false,
        run: name === 'oblivious' ? obliviousSlowCapability : slowCapability,
      })
    }
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function buildRun(): Promise<{
    run: Awaited<ReturnType<typeof createRun>>
    runContext: ReturnType<typeof createRunContext>
  }> {
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
    const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId })
    // A discard sink: these tests assert against persisted rows and
    // returned results, never log content, so nothing needs to capture
    // what this logger writes.
    const discard = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const logger = createLogger('error', discard)
    const runContext = createRunContext(logger, {
      runId: run.id,
      sessionId: session.id,
      stepId: 'cancel-test',
      principalId,
    })
    return { run, runContext }
  }

  it(
    'FR-ORC-4: a Stop that arrives at a step boundary halts the run before the next step starts, ' +
      'recorded cancelled, with the already-completed step preserved',
    async () => {
      const { run, runContext } = await buildRun()
      const task: Untrusted<string> = wrapUntrusted('stop between two steps')
      const registry = new CancellationRegistry()
      const token = registry.register(run.id)

      let decisionCalls = 0
      const engine: Engine = (invocation) => {
        if (isPlanCall(invocation.jsonSchema)) {
          return Promise.resolve(fakeResult(planJson({ capability: 'echo', input: 'first' })))
        }
        decisionCalls += 1
        // The Stop arrives exactly as the loop asks "what's next", i.e. at
        // the boundary between the first step's completion and the
        // second's start. The engine itself has no idea a Stop happened,
        // matching a real engine call that would simply keep answering.
        token.cancel('stop at boundary')
        return Promise.resolve(fakeResult(decisionJson({ done: false, capability: 'echo', input: 'second' })))
      }

      const result = await runAgentLoop({
        ctx: { pool, run, runContext, engine, policy: PERMISSIVE_POLICY },
        task,
        capabilities: { echo },
        cancel: token.signal,
      })

      expect(result.state).toBe('cancelled')
      expect(decisionCalls).toBe(1)

      const steps = await listSteps(pool, run.id)
      expect(steps).toHaveLength(1)
      expect(steps[0]?.input).toBe('first')
      expect(steps[0]?.state).toBe('succeeded')

      registry.release(run.id)
    },
  )

  it(
    'GT-14 / FR-ORC-4: a Stop during a long-running capability halts the run within the five second ' +
      'bound, measured, against a capability that never looks at the AbortSignal at all and would ' +
      'otherwise run far longer',
    async () => {
      const { run, runContext } = await buildRun()
      const task: Untrusted<string> = wrapUntrusted('stop mid an oblivious slow capability')
      const registry = new CancellationRegistry()
      const token = registry.register(run.id)

      // 30 seconds, six times the five second bound, and obliviousSlowCapability
      // never inspects the AbortSignal it is given: the ONLY thing that can
      // make this run stop within five seconds is src/agent/loop.ts's
      // runCapability racing the capability's own promise against the
      // signal and abandoning it. This is the specific mechanism this
      // task's self-attack removes; see the task report for that run.
      const engine: Engine = (invocation) =>
        Promise.resolve(
          fakeResult(
            isPlanCall(invocation.jsonSchema)
              ? planJson({ capability: 'oblivious', input: { seconds: 30 } })
              : decisionJson({ done: true }),
          ),
        )

      const runPromise = runAgentLoop({
        ctx: { pool, run, runContext, engine, policy: PERMISSIVE_POLICY },
        task,
        capabilities: { oblivious: obliviousSlowCapability },
        cancel: token.signal,
      })

      await waitUntil(async () => {
        const steps = await listSteps(pool, run.id)
        return steps.some((step) => step.state === 'running')
      })

      const cancelledAt = Date.now()
      registry.cancel(run.id, 'operator stop mid-capability')
      const result = await runPromise
      const elapsedMs = Date.now() - cancelledAt

      // Printed deliberately: GT-14 requires the bound to be measured, not
      // merely asserted, so the actual number belongs in visible test
      // output, not only in the expect() below.
      console.log(`GT-14 measured cancellation elapsed=${elapsedMs}ms bound=${CANCELLATION_BOUND_MS}ms`)

      expect(result.state).toBe('cancelled')
      expect(elapsedMs).toBeLessThan(CANCELLATION_BOUND_MS)

      const steps = await listSteps(pool, run.id)
      expect(steps).toHaveLength(1)
      expect(steps[0]?.capability).toBe('oblivious')
      expect(steps[0]?.state).toBe('cancelled')

      registry.release(run.id)
    },
    15_000,
  )

  it(
    'a capability that DOES wire the signal, matching runClaudeEngine\'s own pattern, has its real ' +
      'child process genuinely killed within the five second bound: no leaked process',
    async () => {
      resetSpawnedChildPids()
      const { run, runContext } = await buildRun()
      const task: Untrusted<string> = wrapUntrusted('stop mid a signal-aware slow capability')
      const registry = new CancellationRegistry()
      const token = registry.register(run.id)

      const engine: Engine = (invocation) =>
        Promise.resolve(
          fakeResult(
            isPlanCall(invocation.jsonSchema)
              ? planJson({ capability: 'slow', input: { seconds: 30 } })
              : decisionJson({ done: true }),
          ),
        )

      const runPromise = runAgentLoop({
        ctx: { pool, run, runContext, engine, policy: PERMISSIVE_POLICY },
        task,
        capabilities: { slow: slowCapability },
        cancel: token.signal,
      })

      await waitUntil(async () => {
        const steps = await listSteps(pool, run.id)
        return steps.some((step) => step.state === 'running')
      })

      const cancelledAt = Date.now()
      registry.cancel(run.id, 'operator stop mid-capability')
      const result = await runPromise
      const elapsedMs = Date.now() - cancelledAt

      expect(result.state).toBe('cancelled')
      expect(elapsedMs).toBeLessThan(CANCELLATION_BOUND_MS)
      expect(spawnedChildPids).toHaveLength(1)

      // The real OS process is genuinely gone, not merely abandoned by a
      // wrapping promise: process.kill(pid, 0) throws ESRCH once the
      // kernel has reaped it, which is exactly what isProcessAlive checks.
      // sleep exits promptly on SIGTERM, so a short wait covers reaping.
      const pid = spawnedChildPids[0] as number
      await waitUntil(() => !isProcessAlive(pid), 2_000)
      expect(isProcessAlive(pid)).toBe(false)

      registry.release(run.id)
    },
    15_000,
  )

  it(
    'a truncated or malformed engine response arriving during cancellation does not throw out of the ' +
      'cancellation path: the run still resolves cancelled, never a rejected promise',
    async () => {
      const { run, runContext } = await buildRun()
      const task: Untrusted<string> = wrapUntrusted('stop while the engine response is malformed')
      const registry = new CancellationRegistry()
      const token = registry.register(run.id)

      let decisionCallStarted = false
      const engine: Engine = (invocation) => {
        if (isPlanCall(invocation.jsonSchema)) {
          return Promise.resolve(fakeResult(planJson({ capability: 'echo', input: 'first' })))
        }
        decisionCallStarted = true
        // Stands in for src/agent/loop.ts's runClaudeEngine reading a
        // stream-json response truncated mid-object by a killed
        // subprocess: the call never resolves cleanly, it rejects with
        // exactly the error parseJsonResponse throws for genuinely
        // malformed JSON, arriving at the same moment cancellation fires.
        return new Promise((_resolve, reject) => {
          if (invocation.signal.aborted) {
            reject(new EngineResponseError('response was not valid JSON: truncated by cancellation'))
            return
          }
          invocation.signal.addEventListener(
            'abort',
            () => reject(new EngineResponseError('response was not valid JSON: truncated by cancellation')),
            { once: true },
          )
        })
      }

      const runPromise = runAgentLoop({
        ctx: { pool, run, runContext, engine, policy: PERMISSIVE_POLICY },
        task,
        capabilities: { echo },
        cancel: token.signal,
      })

      await waitUntil(() => decisionCallStarted)
      registry.cancel(run.id, 'stop while malformed response is in flight')

      // The assertion IS that this resolves rather than rejects: a
      // cancellation that kills the process but then throws while
      // recording the outcome has not cancelled cleanly, it has crashed,
      // per this task's brief.
      await expect(runPromise).resolves.toMatchObject({ state: 'cancelled' })

      const steps = await listSteps(pool, run.id)
      expect(steps).toHaveLength(1)
      expect(steps[0]?.state).toBe('succeeded')

      registry.release(run.id)
    },
  )

  it('cancelling an already-finished run is a safe no-op, and does not change its persisted state', async () => {
    const { run, runContext } = await buildRun()
    const task: Untrusted<string> = wrapUntrusted('finish normally, then try to cancel')
    const registry = new CancellationRegistry()
    const token = registry.register(run.id)

    const engine: Engine = (invocation) =>
      Promise.resolve(
        fakeResult(isPlanCall(invocation.jsonSchema) ? planJson({ capability: 'echo', input: 'done-fast' }) : decisionJson({ done: true })),
      )

    const result = await runAgentLoop({
      ctx: { pool, run, runContext, engine, policy: PERMISSIVE_POLICY },
      task,
      capabilities: { echo },
      cancel: token.signal,
    })
    expect(result.state).toBe('succeeded')

    registry.release(run.id)

    // The run already finished, and its token was released, before either
    // call below. Both the registry (no token left to find) and the token
    // itself (idempotent cancel) must make this a safe no-op, never a
    // throw, and never a change to the run's already-terminal state.
    expect(() => registry.cancel(run.id, 'too late')).not.toThrow()
    expect(() => token.cancel('too late, direct')).not.toThrow()

    const { rows } = await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [run.id])
    expect(rows[0]?.state).toBe('succeeded')
  })

  it('cancelling twice is a safe no-op: the second call keeps the first reason and does not re-abort anything', async () => {
    const { run, runContext } = await buildRun()
    const task: Untrusted<string> = wrapUntrusted('stop, then stop again')
    const registry = new CancellationRegistry()
    const token = registry.register(run.id)

    let decisionCallStarted = false
    const engine: Engine = (invocation) => {
      if (isPlanCall(invocation.jsonSchema)) {
        return Promise.resolve(fakeResult(planJson({ capability: 'echo', input: 'first' })))
      }
      decisionCallStarted = true
      return new Promise((_resolve, reject) => {
        if (invocation.signal.aborted) {
          reject(new Error('decision call aborted'))
          return
        }
        invocation.signal.addEventListener('abort', () => reject(new Error('decision call aborted')), {
          once: true,
        })
      })
    }

    const runPromise = runAgentLoop({
      ctx: { pool, run, runContext, engine, policy: PERMISSIVE_POLICY },
      task,
      capabilities: { echo },
      cancel: token.signal,
    })

    await waitUntil(() => decisionCallStarted)

    registry.cancel(run.id, 'first stop')
    registry.cancel(run.id, 'second stop')
    expect(token.cancellationReason).toBe('first stop')

    const result = await runPromise
    expect(result.state).toBe('cancelled')

    const steps = await listSteps(pool, run.id)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.state).toBe('succeeded')

    registry.release(run.id)
  })
})
