/**
 * Tests for src/orchestrator.ts, Task 8 of the P0.3 orchestrator milestone.
 * Every test drives real Postgres (the migrated schema, no mocked queries)
 * and an injected fake Engine, per DEC-1's own test discipline: no test in
 * this file spawns the real `claude` binary. The live Slack criterion this
 * task's brief requires is deliberately not claimed here; it needs a real
 * operator sending a real DM, which is not something an automated test can
 * honestly simulate. See the task report for the exact command.
 */

import { randomUUID } from 'node:crypto'
import { composeThreadRef } from '../src/chat/slack/adapter.js'
import { KillSwitchEngagedError } from '../src/killswitch.js'
import { listEngineSessions } from '../src/sessions/discovery.js'
import { SESSION_ATTACH_ACTION_ID } from '../src/chat/slack/session-attach.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { closePool, createPool } from '../src/db/pool.js'
import { applyMigrations } from '../src/db/migrate.js'
import { createLogger } from '../src/obs/logger.js'
import { resolveWorkspaceId } from '../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../src/tenancy/principals.js'
import { registerSecretValue, resetSecretScrubberForTests } from '../src/secrets/scrubber.js'
import { attachSessionToEngineChat, findOrCreateSession } from '../src/sessions/store.js'
import { claimLiveControl } from '../src/live/control.js'
import { createApproval } from '../src/approvals/store.js'
import { APPROVAL_ACTION_IDS } from '../src/approvals/blockkit.js'
import { createRun } from '../src/runs/store.js'
import { z } from 'zod'
import { echo } from '../src/agent/capabilities/echo.js'
import { PLAN_JSON_SCHEMA } from '../src/agent/loop.js'
import type { AgentLoopResult, Engine } from '../src/agent/loop.js'
import { wrapUntrusted } from '../src/agent/untrusted.js'
import { MockAdapter } from '../src/chat/mock.js'
import { OutboundDispatcher } from '../src/dispatch/outbound.js'
import { CancellationRegistry } from '../src/runs/cancel.js'
import { registerBuiltinCapabilities } from '../src/capabilities/wiring.js'
import { registerCapability } from '../src/capabilities/registry.js'
import type { Policy } from '../src/config/schema.js'
import { ConfigError } from '../src/config/errors.js'
import { loadPolicy } from '../src/config/load.js'
import { slowCapability } from './support/slow-capability.js'
import type { ChatAction, ChatAdapter, ChatActionResult, ChatEvent, ChatRef } from '../src/chat/contract.js'
import type { SecretProvider } from '../src/secrets/provider.js'
import type {
  SlackActionListener,
  SlackApiClient,
  SlackAuthIdentity,
  SlackBlockActionEnvelope,
  SlackBoltApp,
  SlackCommandEnvelope,
  SlackEventEnvelope,
  SlackEventListener,
  SlackPostMessageArgs,
  SlackUpdateMessageArgs,
  SlackUploadFileArgs,
} from '../src/chat/slack/adapter.js'
import {
  buildFinalReport,
  createProductionSlackAdapter,
  handleChatEvent,
  isKnownSessionQuery,
  scheduleOutboxDrain,
} from '../src/orchestrator.js'
import type { Drainable } from '../src/orchestrator.js'
import { getTestDatabaseUrl } from './support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/** Fails loudly instead of skipping, matching every other database suite in this repo. A skipped test proves nothing. */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'Orchestrator tests must fail, not silently skip, when it is absent.',
          )
        })
      })

function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run orchestrator tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

/**
 * Polls `check` until it resolves to a value other than `undefined` or
 * `false`, or throws once `timeoutMs` elapses. Used instead of a fixed
 * sleep so a test synchronizes on the real condition it needs (a run
 * actually reaching a given state) rather than a guessed delay, matching
 * test/runs/cancel.test.ts's own waitUntil.
 */
async function waitForCondition<T>(check: () => Promise<T | undefined | false>, timeoutMs: number): Promise<T> {
  const start = Date.now()
  for (;;) {
    const result = await check()
    if (result !== undefined && result !== false) return result
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForCondition: condition was not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Wraps `pool` so any query whose text `shouldFail` accepts rejects
 * instead of running, everything else passing through untouched. Gate fix
 * Blocker 6 moved several src/runs/store.ts writes (recordPlan, and every
 * run/step transition) off a bare `pool.query` and onto an explicit
 * `pool.connect()` client, so a Proxy that only wraps `pool.query` (this
 * project's original failure-injection technique, still correct for
 * anything that has not moved) can no longer see those calls at all: the
 * query is issued on the checked-out client, never on `pool` itself. This
 * wraps `pool.connect()` too, so a client obtained through it has its own
 * `.query` intercepted the same way, and a caller does not need to know or
 * care which path a given store function takes internally.
 */
function wrapFailingPool(pool: Pool, shouldFail: (sql: string) => boolean): Pool {
  const failMessage = 'simulated unexpected database failure'
  const wrapQuery =
    (queryFn: (...a: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      const first = args[0]
      const sql = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text
      if (typeof sql === 'string' && shouldFail(sql)) {
        return Promise.reject(new Error(failMessage))
      }
      return queryFn(...args)
    }

  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return wrapQuery((target.query as (...a: unknown[]) => unknown).bind(target))
      }
      if (prop === 'connect') {
        return async (...connectArgs: unknown[]) => {
          const client = await (target.connect as (...a: unknown[]) => Promise<PoolClient>)(...connectArgs)
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp === 'query') {
                return wrapQuery((clientTarget.query as (...a: unknown[]) => unknown).bind(clientTarget))
              }
              return Reflect.get(clientTarget, clientProp, clientReceiver)
            },
          })
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as Pool
}

function silentLogger(): ReturnType<typeof createLogger> {
  return createLogger('info', new Writable({ write(_chunk, _enc, cb) { cb() } }))
}

/** A logger whose emitted lines are captured and parseable, for tests that assert on log content rather than merely on the absence of a crash. */
function capturingLogger(): { log: ReturnType<typeof createLogger>; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: unknown, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return {
    log: createLogger('info', stream),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

/**
 * A fake engine that plans a completed run with zero steps: `firstAction`
 * is `null`, so runAgentLoop's own decision loop never executes and the run
 * finishes 'succeeded' after exactly one engine call. This is deliberately
 * the fastest legal run shape a fake engine can produce, since most tests
 * in this file care about the orchestration around the loop, not the loop's
 * own step machinery, which test/agent/loop.test.ts already covers
 * thoroughly.
 */
function buildImmediateSuccessEngine(costUsd = 0.001): Engine {
  return async (invocation) => {
    const isPlan = invocation.jsonSchema === PLAN_JSON_SCHEMA
    const resultText = isPlan
      ? JSON.stringify({
          goalRestatement: 'test goal',
          plannedSteps: [],
          riskTier: 'low',
          estimatedCost: 'negligible',
          firstAction: null,
        })
      : JSON.stringify({ done: true })
    return {
      sessionId: 'fake-session',
      numTurns: 1,
      stopReason: 'end_turn',
      totalCostUsd: costUsd,
      usage: {},
      permissionDenials: [],
      resultText,
      isError: false,
      errors: [],
    }
  }
}

/**
 * A fake engine that plans and executes exactly one `echo` step, then
 * reports done on the following decision call: the smallest run shape that
 * still exercises the full FR-SL-6 bookkeeping block (stepsExecuted > 0),
 * as opposed to buildImmediateSuccessEngine's deliberately zero-step,
 * compact-format shape.
 */
function buildSteppedSuccessEngine(costUsd = 0.001): Engine {
  return async (invocation) => {
    const isPlan = invocation.jsonSchema === PLAN_JSON_SCHEMA
    const resultText = isPlan
      ? JSON.stringify({
          goalRestatement: 'test goal',
          plannedSteps: [{ capability: 'echo', description: 'echo the input once' }],
          riskTier: 'low',
          estimatedCost: 'negligible',
          firstAction: { capability: 'echo', input: 'hello' },
        })
      : JSON.stringify({ done: true })
    return {
      sessionId: 'fake-session',
      numTurns: 1,
      stopReason: 'end_turn',
      totalCostUsd: costUsd,
      usage: {},
      permissionDenials: [],
      resultText,
      isError: false,
      errors: [],
    }
  }
}

function buildEvent(params: {
  workspaceId: string
  principalId: string | null
  channel?: string
  message?: string
  thread?: string
  text?: string
  /** The raw platform sender id this event's `raw` payload carries under `user`, mirroring a real SlackRawEvent. Defaults to a fresh id so every test gets a distinct one unless it cares. */
  platformUserId?: string
  mentionsBot?: boolean
}): ChatEvent {
  const channel = params.channel ?? `C_${randomUUID()}`
  const message = params.message ?? `${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`
  const ref: ChatRef = params.thread !== undefined ? { channel, thread: params.thread, message } : { channel, message }
  const platformUserId = params.platformUserId ?? `U_${randomUUID()}`
  return {
    kind: params.thread !== undefined ? 'thread_reply' : 'message',
    adapter: 'test',
    workspaceId: params.workspaceId,
    platformTeamId: 'T_TEST',
    principalId: params.principalId,
    ref,
    text: wrapUntrusted(params.text ?? 'do the thing'),
    files: [],
    raw: wrapUntrusted({ type: 'message', user: platformUserId, channel, ts: message, text: params.text ?? 'do the thing' }),
    receivedAt: new Date().toISOString(),
    mentionsBot: params.mentionsBot ?? false,
    platformEventId: `${channel}:${message}`,
  }
}

/**
 * AP-1, Task 3: OrchestratorDeps.policy is now required, mirroring
 * AgentLoopContext.policy. This policy imposes no restriction at all, so
 * every test in this file keeps exercising exactly what it exercised
 * before the mediation seam existed: the orchestrator's own wiring, never
 * governance. Mediation itself has its own coverage in
 * test/agent/loop.test.ts's "AP-1: the mediation seam" describe block.
 */
const PERMISSIVE_POLICY: Policy = {
  version: 1,
  defaults: { unmatched: 'ask' },
  hard_blocked_origins: ['*.never-matched.invalid'],
}

function writeTempPolicy(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-orchestrator-policy-'))
  const path = join(dir, 'policy.yaml')
  writeFileSync(path, contents, 'utf8')
  return path
}

/**
 * AP-1 / FR-POL-2: an invalid policy prevents startup. No database needed:
 * this proves the exact sequence scripts/relay-orchestrator.ts's main()
 * uses in production, `const policy = loadPolicy(POLICY_PATH)` BEFORE
 * anything else (a pool, a migration, startOrchestrator itself) is ever
 * reached, throws for an invalid file and never reaches what comes after.
 * loadPolicy's own validation is Task 1/2's (test/config/load.test.ts
 * covers its full range of rejected shapes); what is new here is proving
 * this is actually load-bearing for STARTUP, not merely a function that
 * exists: nothing downstream of the throw ever runs.
 */
describe('AP-1 / FR-POL-2: an invalid policy prevents startup', () => {
  it('loadPolicy throws for a policy file missing the required hard-blocked list, before anything that would start the orchestrator is ever reached', () => {
    const badPolicyPath = writeTempPolicy('version: 1\ndefaults:\n  unmatched: ask\nhard_blocked_origins: []\n')

    let reachedStartupCode = false
    expect(() => {
      // Exactly scripts/relay-orchestrator.ts's own first line of main().
      const policy = loadPolicy(badPolicyPath)
      // Nothing after this point in a real process (createPool,
      // applyMigrations, startOrchestrator) can ever execute if the line
      // above throws, which is the actual guarantee this test proves.
      reachedStartupCode = true
      void policy
    }).toThrow(ConfigError)
    expect(reachedStartupCode).toBe(false)
  })

  it('loadPolicy throws for a policy file that is not even valid YAML, the same way', () => {
    const badPolicyPath = writeTempPolicy('this: is: not: valid: yaml: [')

    let reachedStartupCode = false
    expect(() => {
      const policy = loadPolicy(badPolicyPath)
      reachedStartupCode = true
      void policy
    }).toThrow(ConfigError)
    expect(reachedStartupCode).toBe(false)
  })
})

describeDb('orchestrator', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
    // AP-1: the mediation seam looks 'echo'/'slow' up in the real
    // capability registry for their declared tier, independent of whether
    // a given test's own `capabilities` map substitutes a fake function
    // under that name. 'slow' mirrors test/runs/cancel.test.ts's own
    // test-only registration (test/support/slow-capability.ts), used here
    // only for the Stop-mid-capability test in this file.
    registerBuiltinCapabilities()
    registerCapability({
      name: 'slow',
      description: 'test-only capability, see test/support/slow-capability.ts',
      inputSchema: z.object({ seconds: z.number() }),
      outputSchema: z.unknown(),
      riskTier: 'read',
      idempotencyClass: 'safe',
      requiredRunnerFeatures: [],
      costHint: 'free',
      requiresMachineLock: false,
      run: slowCapability,
    })
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function createFixtures(): Promise<{ workspaceId: string; principalId: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(
      pool,
      workspaceId,
      'test',
      `U_${randomUUID()}`,
      'Test Principal',
      ['operator'],
    )
    return { workspaceId, principalId }
  }

  async function runCount(workspaceId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM runs WHERE workspace_id = $1',
      [workspaceId],
    )
    return Number(rows[0]?.count ?? 0)
  }

  // -------------------------------------------------------------------------
  // PRE-2: fail closed without a mapped principal.
  // -------------------------------------------------------------------------

  describe('handleChatEvent: autonomous routing', () => {
    function fakeAutonomous(answer: 'handled' | 'not_autonomous') {
      const routed: string[] = []
      const adopted: boolean[] = []
      const stopped: string[] = []
      return {
        routed,
        adopted,
        stopped,
        routing: {
          async route(event: ChatEvent, _thread: unknown, options?: { adopt?: boolean }) {
            routed.push(event.platformEventId)
            adopted.push(options?.adopt === true)
            return answer
          },
          async stopSession(sessionId: string) {
            stopped.push(sessionId)
            return true
          },
        },
      }
    }

    it.each([
      ['a mention', true],
      ['a DM without a mention', false],
    ])('routes %s to autonomous mode and creates no governed session or run', async (_label, mentionsBot) => {
      const { workspaceId, principalId } = await createFixtures()
      const auto = fakeAutonomous('handled')
      const adapter = new MockAdapter()

      await handleChatEvent(
        { pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, policy: PERMISSIVE_POLICY, autonomous: auto.routing },
        buildEvent({ workspaceId, principalId, mentionsBot }),
      )

      expect(auto.routed).toHaveLength(1)
      expect(await runCount(workspaceId)).toBe(0)
      const { rows } = await pool.query('SELECT 1 FROM sessions WHERE workspace_id = $1', [workspaceId])
      expect(rows).toHaveLength(0)
    })

    it('keeps the governed loop for a mention in an existing governed thread', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const auto = fakeAutonomous('not_autonomous')
      const adapter = new MockAdapter()

      await handleChatEvent(
        { pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, policy: PERMISSIVE_POLICY, engine: buildImmediateSuccessEngine(), autonomous: auto.routing },
        buildEvent({ workspaceId, principalId, mentionsBot: true }),
      )

      expect(auto.routed).toHaveLength(1)
      expect(await runCount(workspaceId)).toBe(1)
    })

    it('parks a message in a thread attached to an open chat instead of routing it, with only 👀', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const auto = fakeAutonomous('handled')
      const adapter = new MockAdapter()
      const event = buildEvent({ workspaceId, principalId })
      const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'test', threadRef: composeThreadRef(event.ref.channel, event.ref.message ?? '') })
      await claimLiveControl(pool, workspaceId, session.id)

      await handleChatEvent({ pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, policy: PERMISSIVE_POLICY, autonomous: auto.routing, liveControlGraceMs: 60_000 }, event)

      expect(auto.routed).toEqual([])
      expect(adapter.performed).toEqual([expect.objectContaining({ kind: 'react', name: 'eyes' })])
      const { rows } = await pool.query('SELECT 1 FROM live_control_messages WHERE session_id = $1', [session.id])
      expect(rows).toHaveLength(1)
    })

    it('adopts an attached thread whose chat is closed as its autonomous task', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const auto = fakeAutonomous('handled')
      const event = buildEvent({ workspaceId, principalId })
      const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'test', threadRef: composeThreadRef(event.ref.channel, event.ref.message ?? '') })
      await attachSessionToEngineChat(pool, session.id, randomUUID(), `/nonexistent-relay-test-${randomUUID()}`)

      await handleChatEvent({ pool, dispatcher: new MockAdapter(), log: silentLogger(), capabilities: { echo }, policy: PERMISSIVE_POLICY, autonomous: auto.routing }, event)

      expect(auto.adopted).toEqual([true])
    })

    it('stops the autonomous task on Stop in its thread, without a cancellation registry', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const auto = fakeAutonomous('handled')
      const adapter = new MockAdapter()
      const event = buildEvent({ workspaceId, principalId, text: 'stop' })
      const threadRef = composeThreadRef(event.ref.channel, event.ref.message ?? '')
      const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'test', threadRef })
      await pool.query(`UPDATE sessions SET mode = 'autonomous' WHERE id = $1`, [session.id])

      await handleChatEvent({ pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, policy: PERMISSIVE_POLICY, autonomous: auto.routing }, event)

      expect(auto.stopped).toEqual([session.id])
      expect((adapter.performed[0] as { text: string }).text).toContain('Stopped')
    })
  })

  describe('handleChatEvent: FR-POL-9 kill switch', () => {
    /** Only the one method the orchestrator depends on, so this stands in for a real KillSwitch without a database or a run canceller. */
    function engagedSwitch(reason: string) {
      return {
        refuseIfEngaged(): void {
          throw new KillSwitchEngagedError(reason)
        },
      }
    }

    it('refuses new work while engaged, telling the operator why, and creates no session or run', async () => {
      const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
      const principalId = await provisionPrincipal(pool, workspaceId, 'test', `U_${randomUUID()}`, 'Op', ['operator'])
      const adapter = new MockAdapter()

      await handleChatEvent(
        {
          pool,
          dispatcher: adapter,
          log: silentLogger(),
          capabilities: { echo },
          policy: PERMISSIVE_POLICY,
          killSwitch: engagedSwitch('deploying a hotfix'),
        },
        buildEvent({ workspaceId, principalId }),
      )

      // Named, not merely refused: KillSwitchEngagedError carries the
      // reason precisely so the operator is not left guessing whether
      // Relay is broken or deliberately stopped.
      expect(adapter.performed).toHaveLength(1)
      expect(adapter.performed[0]).toMatchObject({ kind: 'post' })
      expect((adapter.performed[0] as { text: string }).text).toContain('deploying a hotfix')

      // Refused BEFORE persistence, so a refused message leaves nothing to
      // reconcile when service is restored.
      expect(await runCount(workspaceId)).toBe(0)
      const { rows } = await pool.query('SELECT 1 FROM sessions WHERE workspace_id = $1', [workspaceId])
      expect(rows).toHaveLength(0)
    })

    it('still honours Stop while engaged, because stopping is not new work', async () => {
      const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
      const principalId = await provisionPrincipal(pool, workspaceId, 'test', `U_${randomUUID()}`, 'Op', ['operator'])
      const adapter = new MockAdapter()

      await handleChatEvent(
        {
          pool,
          dispatcher: adapter,
          log: silentLogger(),
          capabilities: { echo },
          policy: PERMISSIVE_POLICY,
          killSwitch: engagedSwitch('deploying a hotfix'),
        },
        buildEvent({ workspaceId, principalId, text: 'stop' }),
      )

      // A kill switch that blocked Stop would be actively unhelpful: "stop
      // everything" and "now let me stop this one thing" are the same
      // intent. The reply is the Stop branch's own, never the refusal.
      expect(adapter.performed).toHaveLength(1)
      expect((adapter.performed[0] as { text: string }).text).not.toContain('deploying a hotfix')
    })

  })

  describe('handleChatEvent: PRE-2 fail closed', () => {
    it('an unmapped principal gets no reply and no run row', async () => {
      const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
      const adapter = new MockAdapter()
      const event = buildEvent({ workspaceId, principalId: null })

      await handleChatEvent(
        { pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo },
              policy: PERMISSIVE_POLICY,
            },
        event,
      )

      expect(adapter.performed).toHaveLength(0)

      expect(await runCount(workspaceId)).toBe(0)

      const { rows: sessionRows } = await pool.query('SELECT 1 FROM sessions WHERE workspace_id = $1', [
        workspaceId,
      ])
      expect(sessionRows).toHaveLength(0)
    })

    // SELF-ATTACK evidence lives in the task report: making handleChatEvent
    // create a run for a null principalId before this check runs is exactly
    // what makes the `runCount(workspaceId)).toBe(0)` assertion above fail.

    // Fix round finding: an unmapped principal was refused correctly, but
    // nothing ever recorded the ONE piece of information an operator needs
    // to fix it, the platform's own user id. Without it `relay principals
    // add` (src/cli/principals.ts) is unreachable in practice: the operator
    // has no argument to pass it.
    it('logs the platform user id on the fail closed path, and names the command that provisions it', async () => {
      const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
      const adapter = new MockAdapter()
      const platformUserId = `U_${randomUUID()}`
      const event = buildEvent({ workspaceId, principalId: null, platformUserId })
      const { log, lines } = capturingLogger()

      await handleChatEvent({ pool, dispatcher: adapter, log, capabilities: { echo },
              policy: PERMISSIVE_POLICY,
            }, event)

      const warnLine = lines().find((line) => line.msg === undefined ? false : String(line.msg).includes('unmapped principal'))
      expect(warnLine).toBeDefined()
      expect(warnLine?.platformUserId).toBe(platformUserId)
      expect(String(warnLine?.msg)).toContain('relay principals add')
      expect(String(warnLine?.msg)).toContain(`--user ${platformUserId}`)
      expect(String(warnLine?.msg)).toContain('--platform test')

      // Never message content: the event's own text ("do the thing" by
      // default) must not appear anywhere in the emitted line.
      expect(JSON.stringify(warnLine)).not.toContain('do the thing')
    })
  })

  // -------------------------------------------------------------------------
  // AP-5 / FR-ORC-1: a run is persisted before any Slack call.
  // -------------------------------------------------------------------------

  describe('handleChatEvent: ordering', () => {
    it('a run row is visible in a fresh Postgres read before the first dispatcher.perform call', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const inner = new MockAdapter()
      let observedRunCountAtFirstSend: number | undefined

      // Wraps MockAdapter rather than replacing it, so post/edit still
      // behave exactly like a real adapter (issuing message ids, etc);
      // only the FIRST perform() call additionally reads runs directly
      // from Postgres, from inside perform() itself, the same technique
      // test/agent/loop.test.ts's own AP-5 proof uses for steps: a query
      // issued from inside the very call being ordered against cannot see
      // a write that has not committed yet.
      const spy: ChatAdapter = {
        name: inner.name,
        capabilities: inner.capabilities,
        start: (handler) => inner.start(handler),
        stop: () => inner.stop(),
        async perform(action: ChatAction): Promise<ChatActionResult> {
          if (observedRunCountAtFirstSend === undefined) {
            observedRunCountAtFirstSend = await runCount(workspaceId)
          }
          return inner.perform(action)
        },
      }

      const event = buildEvent({ workspaceId, principalId })
      await handleChatEvent(
        {
          pool,
          dispatcher: spy,
          log: silentLogger(),
          capabilities: { echo },
          engine: buildImmediateSuccessEngine(),
              policy: PERMISSIVE_POLICY,
            },
        event,
      )

      expect(observedRunCountAtFirstSend).toBe(1)
      expect(inner.performed.length).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // FR-SL-3: the reply thread is the session.
  // -------------------------------------------------------------------------

  describe('handleChatEvent: sessions', () => {
    it('a second message in the same thread joins the same session, not a new one', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const adapter = new MockAdapter()
      const channel = `C_${randomUUID()}`
      const rootTs = `${Date.now()}.000001`

      const rootEvent = buildEvent({ workspaceId, principalId, channel, message: rootTs })
      const replyEvent = buildEvent({
        workspaceId,
        principalId,
        channel,
        thread: rootTs,
        message: `${Date.now()}.000002`,
      })

      const deps = {
        pool,
        dispatcher: adapter,
        log: silentLogger(),
        capabilities: { echo },
        engine: buildImmediateSuccessEngine(),
        policy: PERMISSIVE_POLICY,
      }
      await handleChatEvent(deps, rootEvent)
      await handleChatEvent(deps, replyEvent)

      const { rows: sessionRows } = await pool.query<{ id: string }>(
        `SELECT id FROM sessions WHERE workspace_id = $1 AND adapter = 'test' AND thread_ref = $2`,
        [workspaceId, `${channel}:${rootTs}`],
      )
      expect(sessionRows).toHaveLength(1)

      const { rows: runRows } = await pool.query<{ session_id: string }>(
        'SELECT session_id FROM runs WHERE workspace_id = $1 ORDER BY created_at',
        [workspaceId],
      )
      expect(runRows).toHaveLength(2)
      expect(runRows[0]?.session_id).toBe(sessionRows[0]?.id)
      expect(runRows[1]?.session_id).toBe(sessionRows[0]?.id)
    })
  })

  // -------------------------------------------------------------------------
  // FR-SES-1: engine session continuity across two runs in the same thread.
  // DEC-1 named `--resume` and Task 6 left it unused; this is that gap
  // closed, proved end to end through handleChatEvent, not only at the
  // loop layer (test/agent/loop.test.ts covers that layer directly).
  // -------------------------------------------------------------------------

  describe('handleChatEvent: FR-SES-1 engine session resume', () => {
    /** A fake engine that plans a zero-step conversational answer, and whose answer reveals whether it actually saw `resume` set to `expectedResume`, exactly the way a real resumed engine would recall a prior turn versus a fresh one starting cold. */
    function buildRecallEngine(expectedResume: string | undefined): { engine: Engine; calls: { resume: string | undefined }[] } {
      const calls: { resume: string | undefined }[] = []
      const engine: Engine = async (invocation) => {
        calls.push({ resume: invocation.resume })
        return {
          sessionId: `recall-session-${calls.length}`,
          numTurns: 1,
          stopReason: 'end_turn',
          totalCostUsd: 0.001,
          usage: {},
          permissionDenials: [],
          resultText: JSON.stringify({
            goalRestatement: 'answer directly',
            plannedSteps: [],
            riskTier: 'low',
            estimatedCost: 'negligible',
            firstAction: null,
            answer:
              invocation.resume !== undefined && invocation.resume === expectedResume
                ? 'You previously asked about the Q3 numbers.'
                : "I don't have any record of a previous message from you.",
          }),
          isError: false,
          errors: [],
        }
      }
      return { engine, calls }
    }

    it('a second run in the same thread resumes the first run\'s engine session and can answer about the first message', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const adapter = new MockAdapter()
      const channel = `C_${randomUUID()}`
      const rootTs = `${Date.now()}.000001`

      const rootEvent = buildEvent({
        workspaceId,
        principalId,
        channel,
        message: rootTs,
        text: 'What were the Q3 numbers?',
      })
      const replyEvent = buildEvent({
        workspaceId,
        principalId,
        channel,
        thread: rootTs,
        message: `${Date.now()}.000002`,
        text: 'Okay what did I ask you in previous message?',
      })

      // Run 1: no prior session, so its engine is never asked to resume
      // anything; it plants a session id of its own.
      const run1 = buildRecallEngine(undefined)
      await handleChatEvent(
        { pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, engine: run1.engine,
              policy: PERMISSIVE_POLICY,
            },
        rootEvent,
      )
      expect(run1.calls).toHaveLength(1)
      expect(run1.calls[0]?.resume).toBeUndefined()

      const { rows: sessionRows } = await pool.query<{ id: string; engine_session_id: string | null }>(
        `SELECT id, engine_session_id FROM sessions WHERE workspace_id = $1 AND adapter = 'test' AND thread_ref = $2`,
        [workspaceId, `${channel}:${rootTs}`],
      )
      const persistedEngineSessionId = sessionRows[0]?.engine_session_id
      expect(persistedEngineSessionId).toBe('recall-session-1')

      // Run 2: same thread, so handleChatEvent must read that persisted id
      // back and pass it as `resume`, OBSERVED directly on the second
      // engine's own recorded call, per the mutation-check requirement,
      // not inferred only from the answer text below.
      const run2 = buildRecallEngine(persistedEngineSessionId ?? undefined)
      await handleChatEvent(
        { pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, engine: run2.engine,
              policy: PERMISSIVE_POLICY,
            },
        replyEvent,
      )
      expect(run2.calls).toHaveLength(1)
      expect(run2.calls[0]?.resume).toBe(persistedEngineSessionId)

      const finalAction = adapter.performed.at(-1)
      const text = finalAction && 'text' in finalAction ? finalAction.text : ''
      expect(text).toContain('Answer: You previously asked about the Q3 numbers.')
    })

    it('the engine session id is persisted and reused across two independent orchestrator invocations against the same database, not merely in memory', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const adapter = new MockAdapter()
      const channel = `C_${randomUUID()}`
      const rootTs = `${Date.now()}.000001`

      const rootEvent = buildEvent({ workspaceId, principalId, channel, message: rootTs })
      const replyEvent = buildEvent({
        workspaceId,
        principalId,
        channel,
        thread: rootTs,
        message: `${Date.now()}.000002`,
      })

      // Two separate Pool instances, both pointed at the SAME physical test
      // database, standing in for two separate orchestrator process
      // invocations: nothing here shares a JS module cache or a process
      // between the two handleChatEvent calls below, only the database
      // does. A value only readable back through poolB after being written
      // through poolA was genuinely committed to Postgres, not held in
      // some in-process variable this test's own single pool could have
      // masked.
      const databaseUrl = await getTestDatabaseUrl()
      const poolA = createPool(databaseUrl)
      const poolB = createPool(databaseUrl)
      try {
        const run1 = buildRecallEngine(undefined)
        await handleChatEvent(
          { pool: poolA, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, engine: run1.engine,
              policy: PERMISSIVE_POLICY,
            },
          rootEvent,
        )

        const { rows } = await poolB.query<{ engine_session_id: string | null }>(
          `SELECT engine_session_id FROM sessions WHERE workspace_id = $1 AND adapter = 'test' AND thread_ref = $2`,
          [workspaceId, `${channel}:${rootTs}`],
        )
        const persisted = rows[0]?.engine_session_id
        expect(persisted).toBe('recall-session-1')

        const run2 = buildRecallEngine(persisted ?? undefined)
        await handleChatEvent(
          { pool: poolB, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, engine: run2.engine,
              policy: PERMISSIVE_POLICY,
            },
          replyEvent,
        )

        expect(run2.calls[0]?.resume).toBe(persisted)
      } finally {
        await closePool(poolA)
        await closePool(poolB)
      }
    })

    it('a rejected resume degrades to a fresh session, the run still succeeds, and the operator is told continuity was lost', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const adapter = new MockAdapter()
      const channel = `C_${randomUUID()}`
      const rootTs = `${Date.now()}.000001`
      const rootEvent = buildEvent({ workspaceId, principalId, channel, message: rootTs })
      const replyEvent = buildEvent({
        workspaceId,
        principalId,
        channel,
        thread: rootTs,
        message: `${Date.now()}.000002`,
      })

      await handleChatEvent(
        { pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, engine: buildImmediateSuccessEngine(),
              policy: PERMISSIVE_POLICY,
            },
        rootEvent,
      )

      // Simulate a session whose engine conversation has since expired or
      // vanished: overwrite the persisted pointer directly with a value no
      // real engine session will ever recognise.
      await pool.query(
        `UPDATE sessions SET engine_session_id = 'engine-session-stale-and-gone' WHERE workspace_id = $1 AND adapter = 'test'`,
        [workspaceId],
      )

      const rejectThenSucceed: Engine = async (invocation) => {
        if (invocation.resume === 'engine-session-stale-and-gone') {
          return {
            sessionId: invocation.resume,
            numTurns: 0,
            stopReason: 'error_during_execution',
            totalCostUsd: 0,
            usage: {},
            permissionDenials: [],
            resultText: '',
            isError: true,
            errors: ['No conversation found with session ID: engine-session-stale-and-gone'],
          }
        }
        return {
          sessionId: 'engine-session-fresh-after-degrade',
          numTurns: 1,
          stopReason: 'end_turn',
          totalCostUsd: 0.001,
          usage: {},
          permissionDenials: [],
          resultText: JSON.stringify({
            goalRestatement: 'answer directly',
            plannedSteps: [],
            riskTier: 'low',
            estimatedCost: 'negligible',
            firstAction: null,
            answer: 'Starting fresh, since I could not recall our prior conversation.',
          }),
          isError: false,
          errors: [],
        }
      }

      await handleChatEvent(
        { pool, dispatcher: adapter, log: silentLogger(), capabilities: { echo }, engine: rejectThenSucceed,
              policy: PERMISSIVE_POLICY,
            },
        replyEvent,
      )

      const finalAction = adapter.performed.at(-1)
      expect(finalAction).toBeDefined()
      const text = finalAction && 'text' in finalAction ? finalAction.text : ''
      // The run still succeeds and still answers; it does not crash.
      expect(text).toContain('Answer: Starting fresh, since I could not recall our prior conversation.')
      // And the operator is told, in the same message, that continuity was
      // lost, rather than the reply silently reading as if nothing had
      // happened.
      expect(text).toContain('could not be resumed')
      expect(text).toContain('fresh engine session')

      // Self-healing: the stale pointer was replaced by the fresh session
      // id this run's successful retry actually got.
      const { rows } = await pool.query<{ engine_session_id: string | null }>(
        `SELECT engine_session_id FROM sessions WHERE workspace_id = $1 AND adapter = 'test'`,
        [workspaceId],
      )
      expect(rows[0]?.engine_session_id).toBe('engine-session-fresh-after-degrade')
    })
  })

  // -------------------------------------------------------------------------
  // FR-SL-6 / FR-RPT-5 / FR-RPT-10: the final report.
  // -------------------------------------------------------------------------

  describe('buildFinalReport', () => {
    it('carries outcome, what was done, what changed, cost, duration, and warnings, each on its own line', () => {
      const result: AgentLoopResult = {
        runId: 'run_1',
        state: 'succeeded',
        costUsd: 0.0125,
        stepsExecuted: 2,
        notVerified: ['Relay verified only that each capability call completed, failed, or timed out.'],
        warnings: ['step "echo" (seq 1) failed: boom'],
        capabilityNotices: [],
        capabilitiesUsed: ['echo'],
      }
      const report = buildFinalReport(
        result,
        new Date('2026-08-09T00:00:00.000Z'),
        new Date('2026-08-09T00:01:30.000Z'),
      )

      expect(report).toContain('Outcome: succeeded')
      expect(report).toContain('What was done: 2 steps executed.')
      // Derived from the registry rather than hardcoded. The sentence this
      // replaced said "this milestone's only capability, echo, ... never
      // modifies anything", which stopped being true the moment a second
      // capability existed.
      expect(report).toContain('What changed: nothing.')
      expect(report).toContain('echo')
      expect(report).toContain('Cost: $0.0125')
      expect(report).toContain('Duration: 1m 30s')
      expect(report).toContain('Warnings: step "echo" (seq 1) failed: boom')
      expect(report).toContain('Not independently verified:')
      // FR-RPT-10: no diff or raw log marker ever appears in a report body.
      expect(report).not.toMatch(/```|diff --git/)
    })

    it('reports "Warnings: none" when a stepped run produced no warnings', () => {
      // stepsExecuted: 1, not 0: this exercises the full bookkeeping block,
      // where an empty warnings list is still stated plainly as "none"
      // rather than omitted. A zero-step run's compact format has its own
      // dedicated tests below, where an empty warnings list is instead
      // dropped entirely.
      const result: AgentLoopResult = {
        runId: 'run_2',
        state: 'succeeded',
        costUsd: 0,
        stepsExecuted: 1,
        notVerified: ['nothing else was executed'],
        warnings: [],
        capabilityNotices: [],
        capabilitiesUsed: [],
      }
      const report = buildFinalReport(result, new Date(0), new Date(1000))
      expect(report).toContain('Warnings: none')
    })

    // -----------------------------------------------------------------------
    // Usability fix: the answer leads the report, is bounded, and is
    // scrubbed. See src/orchestrator.ts's own doc comments on
    // formatAnswerLine and boundAnswerForChat for the reasoning behind each
    // rule these tests hold it to.
    // -----------------------------------------------------------------------

    afterEach(() => {
      resetSecretScrubberForTests()
    })

    function baseResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
      return {
        runId: 'run_answer',
        state: 'succeeded',
        costUsd: 0.01,
        stepsExecuted: 0,
        notVerified: ['nothing needed independent verification'],
        warnings: [],
        capabilityNotices: [],
        capabilitiesUsed: [],
        ...overrides,
      }
    }

    it('the report contains the engine answer, and it appears before the bookkeeping', () => {
      // stepsExecuted: 1 forces the full block (baseResult defaults to 0,
      // the compact shape, which has no "Outcome:" line for this test's own
      // ordering assertion to compare against).
      const result = baseResult({
        stepsExecuted: 1,
        answer: 'Relay can currently echo a message back to you.',
      })
      const report = buildFinalReport(result, new Date(0), new Date(1000))

      expect(report).toContain('Answer: Relay can currently echo a message back to you.')
      const answerIndex = report.indexOf('Answer:')
      const outcomeIndex = report.indexOf('Outcome:')
      expect(answerIndex).toBeGreaterThanOrEqual(0)
      expect(outcomeIndex).toBeGreaterThan(answerIndex)
    })

    it('a zero-step, purely conversational answer leads the compact report too, as its very first line', () => {
      const result = baseResult({ answer: 'Relay can currently echo a message back to you.' })
      const report = buildFinalReport(result, new Date(0), new Date(1000))
      expect(report.startsWith('Answer: Relay can currently echo a message back to you.')).toBe(true)
    })

    it('states plainly that no answer was recorded, rather than a bare or blank Answer line', () => {
      const result = baseResult()
      const report = buildFinalReport(result, new Date(0), new Date(1000))
      expect(report).toContain('Answer: Relay did not record a direct answer for this run.')
    })

    it('an answer exceeding the length bound is summarised with an explicit note, never silently cut', () => {
      const longAnswer = 'x'.repeat(3000)
      const result = baseResult({ answer: longAnswer })
      const report = buildFinalReport(result, new Date(0), new Date(1000))

      // Not present verbatim: the full 3000-character run of "x" was not
      // silently included past the bound.
      expect(report).not.toContain(longAnswer)
      // The shortening is stated plainly, not hidden.
      expect(report).toMatch(/Answer shortened: the full answer was \d+ bytes/)
      // What IS shown is still a real prefix of the original answer, not a
      // placeholder standing in for it.
      expect(report).toContain('Answer: xxxx')
    })

    it('a registered sentinel secret in the answer is scrubbed before it reaches the outbound action', () => {
      const sentinel = 'sk-live-sentinel-secret-value-001'
      registerSecretValue(sentinel)
      const result = baseResult({ answer: `Here is what I found, using token ${sentinel} along the way.` })
      const report = buildFinalReport(result, new Date(0), new Date(1000))

      expect(report).not.toContain(sentinel)
      expect(report).toContain('[redacted secret]')
    })

    it('a failed run still reports failure clearly even when an answer is present', () => {
      const result = baseResult({
        state: 'failed',
        answer: 'I found three matching records before the failure.',
      })
      const report = buildFinalReport(result, new Date(0), new Date(1000))

      expect(report).toContain('Answer: I found three matching records before the failure.')
      expect(report).toContain('Outcome: failed')
      expect(report).not.toContain('Outcome: succeeded')
    })

    // -----------------------------------------------------------------------
    // Adaptive report fix: a zero-step SUCCEEDED run (a purely conversational
    // reply) gets the compact format; any run that executed a step, or that
    // failed or was cancelled regardless of step count, keeps the full
    // FR-SL-6 block. See src/orchestrator.ts's isCompactReport doc comment.
    // -----------------------------------------------------------------------

    it('a zero-step succeeded run produces the compact format: answer, cost, and duration, with no audit block', () => {
      const result = baseResult({
        stepsExecuted: 0,
        state: 'succeeded',
        answer: 'Right now Relay can echo a message back to you; nothing else is wired up yet.',
      })
      const report = buildFinalReport(
        result,
        new Date('2026-08-09T00:00:00.000Z'),
        new Date('2026-08-09T00:00:19.000Z'),
      )

      expect(report).toContain('Answer: Right now Relay can echo a message back to you; nothing else is wired up yet.')
      expect(report).toContain('Cost: $0.0100')
      expect(report).toContain('Duration: 19s')
      // The audit block a conversational reply has nothing real to say for
      // is gone entirely, not merely thinned out.
      expect(report).not.toContain('Outcome:')
      expect(report).not.toContain('What was done:')
      expect(report).not.toContain('What changed:')
      expect(report).not.toContain('Not independently verified:')
      // No warnings were produced, so unlike the full block's explicit
      // "Warnings: none", the compact block omits the line altogether.
      expect(report).not.toContain('Warnings:')
    })

    it('a zero-step succeeded run still surfaces a real warning in the compact format, e.g. a lost resume', () => {
      const result = baseResult({
        stepsExecuted: 0,
        state: 'succeeded',
        answer: 'Yesterday you asked about the Q3 numbers.',
        warnings: [
          'the prior conversation for this thread could not be resumed (the engine session had ' +
            'expired, was missing, or was rejected); this run continued with a fresh engine session instead',
        ],
      })
      const report = buildFinalReport(result, new Date(0), new Date(1000))

      expect(report).toContain('Warnings: the prior conversation for this thread could not be resumed')
      expect(report).not.toContain('Outcome:')
    })

    it('a run that executed at least one step always keeps the full block, even though it succeeded', () => {
      const result = baseResult({ stepsExecuted: 1, state: 'succeeded', answer: 'Done.' })
      const report = buildFinalReport(result, new Date(0), new Date(1000))

      expect(report).toContain('Outcome: succeeded')
      expect(report).toContain('What was done: 1 step executed.')
      expect(report).toContain('Not independently verified:')
    })

    it('a failed run at zero steps still states its outcome prominently, never the compact format', () => {
      const result = baseResult({
        stepsExecuted: 0,
        state: 'failed',
      })
      const report = buildFinalReport(result, new Date(0), new Date(1000))

      expect(report).toContain('Outcome: failed')
      expect(report).toContain('What was done: 0 steps executed.')
      expect(report).toContain('Not independently verified:')
    })

    it('a cancelled run at zero steps still states its outcome prominently, never the compact format', () => {
      const result = baseResult({ stepsExecuted: 0, state: 'cancelled' })
      const report = buildFinalReport(result, new Date(0), new Date(1000))

      expect(report).toContain('Outcome: cancelled')
      expect(report).toContain('What was done: 0 steps executed.')
    })

    // -----------------------------------------------------------------------
    // FR-ATT-5: the operator is told plainly which of resume-in-place or
    // fork actually happened, every time, never presented as though a fork
    // were an ordinary resume. Both the compact (zero-step, conversational)
    // and full report shapes are covered, since attachment can produce
    // either.
    // -----------------------------------------------------------------------

    it('discloses a plain resume in the compact (zero-step) report', () => {
      const result = baseResult({ attachmentOutcome: 'resumed' })
      const report = buildFinalReport(result, new Date(0), new Date(1000))
      expect(report).toContain('Attachment: continued the existing chat in that folder.')
    })

    it('discloses a fork in the compact (zero-step) report, distinct wording from a plain resume', () => {
      const result = baseResult({ attachmentOutcome: 'forked' })
      const report = buildFinalReport(result, new Date(0), new Date(1000))
      expect(report).toContain('Attachment: started a new chat branching from the existing one')
      expect(report).not.toContain('continued the existing chat')
    })

    it('discloses a fork in the full (stepped) report too, not only the compact one', () => {
      const result = baseResult({ stepsExecuted: 1, attachmentOutcome: 'forked' })
      const report = buildFinalReport(result, new Date(0), new Date(1000))
      expect(report).toContain('Outcome: succeeded')
      expect(report).toContain('Attachment: started a new chat branching from the existing one')
    })

    it('omits the Attachment line entirely for an ordinary run with no attach scenario', () => {
      const result = baseResult()
      const report = buildFinalReport(result, new Date(0), new Date(1000))
      expect(report).not.toContain('Attachment:')
    })
  })

  describe('handleChatEvent: final report reaches the thread', () => {
    it('a run that executed a step sends the full FR-SL-6 field set', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const adapter = new MockAdapter()
      const event = buildEvent({ workspaceId, principalId })

      await handleChatEvent(
        {
          pool,
          dispatcher: adapter,
          log: silentLogger(),
          capabilities: { echo },
          engine: buildSteppedSuccessEngine(0.0042),
              policy: PERMISSIVE_POLICY,
            },
        event,
      )

      const finalAction = adapter.performed.at(-1)
      expect(finalAction).toBeDefined()
      const text = finalAction && 'text' in finalAction ? finalAction.text : ''
      expect(text).toContain('Outcome: succeeded')
      expect(text).toContain('What was done:')
      expect(text).toContain('What changed:')
      // Two engine calls happen for a one-step run (plan, then decision),
      // each costing buildSteppedSuccessEngine's fixed per-call amount, so
      // the total is double it, not the per-call figure.
      expect(text).toContain('Cost: $0.0084')
      expect(text).toContain('Duration:')
      expect(text).toContain('Warnings:')
    })

    // Adaptive report fix: a zero-step conversational run reaches the
    // thread in the compact format, not the full FR-SL-6 block above.
    // buildImmediateSuccessEngine plans firstAction: null, exactly a
    // conversational reply's shape.
    it('a zero-step conversational run sends the compact format, not the full block', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const adapter = new MockAdapter()
      const event = buildEvent({ workspaceId, principalId })

      await handleChatEvent(
        {
          pool,
          dispatcher: adapter,
          log: silentLogger(),
          capabilities: { echo },
          engine: buildImmediateSuccessEngine(0.0042),
              policy: PERMISSIVE_POLICY,
            },
        event,
      )

      const finalAction = adapter.performed.at(-1)
      expect(finalAction).toBeDefined()
      const text = finalAction && 'text' in finalAction ? finalAction.text : ''
      expect(text).toContain('Cost: $0.0042')
      expect(text).toContain('Duration:')
      expect(text).not.toContain('Outcome:')
      expect(text).not.toContain('What was done:')
      expect(text).not.toContain('What changed:')
      expect(text).not.toContain('Not independently verified:')
    })

    // runAgentLoop's own internal engine-call try/catches already turn a
    // failing plan or decision call into a normal, terminal AgentLoopResult
    // (state 'failed'), so a throwing fake Engine cannot exercise this
    // branch; only a failure runAgentLoop itself does not catch can, which
    // is exactly the gap this test targets. src/runs/store.ts's
    // recordPlan (called directly after the planning call, outside its
    // try/catch) is one such call, so this proxies `pool.query` to make
    // just that one statement reject, leaving every other query (session
    // and run creation, the plan insert's own SELECT machinery, and
    // finishRun's own UPDATE, a different statement entirely) untouched.
    //
    // Gate fix, High 4: the final assertion in this test was INVERTED,
    // deliberately, not merely adjusted. It used to assert the run row was
    // left `'running'` forever after an unexpected loop failure, and that
    // assertion is exactly the bug the P0.3 gate review caught: Slack was
    // told "failed" while the database still said "running", a disagreement
    // an operator querying the run row would see directly. handleChatEvent's
    // catch now transitions the run to 'failed' itself before rethrowing, so
    // the two now agree.
    it('still posts a final report, and transitions the run row to failed, when runAgentLoop throws unexpectedly, instead of leaving the thread on "getting started" forever and the row stuck running', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const adapter = new MockAdapter()
      const event = buildEvent({ workspaceId, principalId })

      const failingPool = wrapFailingPool(pool, (sql) => sql.includes('UPDATE runs SET plan'))

      await expect(
        handleChatEvent(
          {
            pool: failingPool,
            dispatcher: adapter,
            log: silentLogger(),
            capabilities: { echo },
            engine: buildImmediateSuccessEngine(),
              policy: PERMISSIVE_POLICY,
            },
          event,
        ),
      ).rejects.toThrow('simulated unexpected database failure')

      const finalAction = adapter.performed.at(-1)
      expect(finalAction).toBeDefined()
      const text = finalAction && 'text' in finalAction ? finalAction.text : ''
      expect(text).toContain('Outcome: failed')
      expect(text).toContain('simulated unexpected database failure')

      // The run row itself now agrees with what Slack was told: 'failed',
      // not left stuck 'running' forever the way it was before this fix.
      const { rows } = await pool.query<{ state: string; failure_reason: string | null }>(
        'SELECT state, failure_reason FROM runs WHERE workspace_id = $1',
        [workspaceId],
      )
      expect(rows).toEqual([
        expect.objectContaining({
          state: 'failed',
          failure_reason: expect.stringContaining('simulated unexpected database failure'),
        }),
      ])
    })

    it(
      'logs, but does not throw a second error, when the run cannot even be transitioned to failed ' +
        'after runAgentLoop throws unexpectedly (the write-can-also-fail case the gate finding asks to state)',
      async () => {
        const { workspaceId, principalId } = await createFixtures()
        const adapter = new MockAdapter()
        const event = buildEvent({ workspaceId, principalId })
        const { log, lines } = capturingLogger()

        // Every write after the run is created fails: the loop's own plan
        // write (making runAgentLoop throw unexpectedly, exactly like the
        // test above) AND handleChatEvent's own recovery attempt
        // (finishRun's UPDATE) both reject. 'UPDATE runs SET plan' is
        // recordPlan's own statement; 'dead_letter_reason = COALESCE'
        // appears only in finishRun's UPDATE (see src/runs/store.ts), which
        // targets handleChatEvent's own recovery attempt without also
        // catching startRun's unrelated UPDATE, sharing the same "UPDATE
        // runs SET state" prefix.
        const failingPool = wrapFailingPool(
          pool,
          (sql) => sql.includes('UPDATE runs SET plan') || sql.includes('dead_letter_reason = COALESCE'),
        )

        await expect(
          handleChatEvent(
            { pool: failingPool, dispatcher: adapter, log, capabilities: { echo }, engine: buildImmediateSuccessEngine(),
              policy: PERMISSIVE_POLICY,
            },
            event,
          ),
          // The ORIGINAL error is what still propagates, never the
          // secondary transition failure: a caller catching this sees
          // exactly the same failure it would have without the High 4 fix.
        ).rejects.toThrow('simulated unexpected database failure')

        const warnLine = lines().find(
          (line) =>
            typeof line.msg === 'string' &&
            line.msg.includes('could not transition the run to failed after runAgentLoop threw unexpectedly'),
        )
        expect(warnLine).toBeDefined()

        const { rows } = await pool.query<{ state: string }>('SELECT state FROM runs WHERE workspace_id = $1', [
          workspaceId,
        ])
        // Left non-terminal, a real, disclosed gap (per the gate finding's
        // own "if that write itself can fail, say what happens then"), not
        // silently hidden: the log line above is where an operator finds it.
        expect(rows).toEqual([{ state: 'running' }])
      },
    )
  })

  // -------------------------------------------------------------------------
  // PRE-4: isKnownSession backed by the real session store.
  // -------------------------------------------------------------------------

  describe('isKnownSessionQuery', () => {
    it('answers true for a real active session\'s threadRef and false for an unrelated one, scoped by workspace and adapter', async () => {
      const { workspaceId, principalId } = await createFixtures()
      const threadRef = `thread-${randomUUID()}`
      await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'test', threadRef })

      await expect(isKnownSessionQuery(pool, workspaceId, 'test', threadRef)).resolves.toBe(true)
      await expect(
        isKnownSessionQuery(pool, workspaceId, 'test', `unrelated-${randomUUID()}`),
      ).resolves.toBe(false)

      // SELF-ATTACK evidence lives in the task report: forcing
      // isKnownSessionQuery to `return true` unconditionally makes exactly
      // the second assertion above fail, the same blocker P0.2's gate
      // caught, now reproduced against the real query Task 8 wires in.
    })

    it('does not answer true for the same threadRef in a different workspace', async () => {
      const { workspaceId: workspaceA, principalId } = await createFixtures()
      const workspaceB = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
      const threadRef = `thread-${randomUUID()}`
      await findOrCreateSession(pool, { workspaceId: workspaceA, principalId, adapter: 'test', threadRef })

      await expect(isKnownSessionQuery(pool, workspaceB, 'test', threadRef)).resolves.toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // PRE-2 (resolution half, re-proven at the wiring level), PRE-3, PRE-4:
  // createProductionSlackAdapter.
  // -------------------------------------------------------------------------

  describe('createProductionSlackAdapter', () => {
    class StubBoltApp implements SlackBoltApp {
      readonly #listeners = new Map<string, SlackEventListener[]>()
      event(eventType: string, listener: SlackEventListener): void {
        const list = this.#listeners.get(eventType) ?? []
        list.push(listener)
        this.#listeners.set(eventType, list)
      }
      // Task 4 (P0.4) addition to SlackBoltApp: Block Kit interactions.
      // Nothing in this file drives one, so these are no-op registrations,
      // present only so this stub still structurally satisfies the
      // interface SlackAdapter.start() now depends on.
      readonly actions = new Map<string, SlackActionListener>()
      action(actionId: string, listener: SlackActionListener): void {
        this.actions.set(actionId, listener)
      }
      readonly commands = new Map<string, (envelope: SlackCommandEnvelope) => Promise<void>>()
      command(commandName: string, listener: (envelope: SlackCommandEnvelope) => Promise<void>): void {
        this.commands.set(commandName, listener)
      }
      /** Drives one registered slash command the way Slack would. */
      async dispatchCommand(commandName: string, envelope: SlackCommandEnvelope): Promise<void> {
        const listener = this.commands.get(commandName)
        if (!listener) throw new Error(`no listener registered for command ${commandName}`)
        await listener(envelope)
      }
      view(): void {}
      /** Drives one registered Block Kit action the way Socket Mode would. */
      async dispatchAction(actionId: string, envelope: SlackBlockActionEnvelope): Promise<void> {
        const listener = this.actions.get(actionId)
        if (!listener) throw new Error(`no listener registered for action ${actionId}`)
        await listener(envelope)
      }
      async start(): Promise<unknown> {
        return undefined
      }
      async stop(): Promise<void> {}
      async dispatch(eventType: string, envelope: SlackEventEnvelope): Promise<void> {
        const list = this.#listeners.get(eventType) ?? []
        for (const listener of list) await listener(envelope)
      }
    }

    class StubApiClient implements SlackApiClient {
      #identity: SlackAuthIdentity
      constructor(identity: SlackAuthIdentity) {
        this.#identity = identity
      }
      async authTest(): Promise<SlackAuthIdentity> {
        return this.#identity
      }
      async postMessage(args: SlackPostMessageArgs): Promise<{ ts: string }> {
        void args
        return { ts: `${Date.now()}.000001` }
      }
      async updateMessage(args: SlackUpdateMessageArgs): Promise<{ ts: string }> {
        return { ts: args.ts }
      }
      async uploadFile(): Promise<void> {}
      // Task 4 (P0.4) addition to SlackApiClient: opening a Block Kit
      // modal. Nothing in this file exercises it; see StubBoltApp's own
      // comment above.
      async openModal(): Promise<void> {}
      async addReaction(): Promise<void> {}
    }

    function fakeSecrets(): SecretProvider {
      return {
        kind: 'env',
        async get() {
          return 'fake-token'
        },
        async has() {
          return true
        },
      }
    }

    /**
     * FR-ATT-5: the picker's two real implementations must be wired HERE,
     * in the one place production builds an adapter. Everything else about
     * attachment was complete and tested for hours while this was missing,
     * and the symptom was not an error: listing reported "no sessions
     * found" and attaching reported "not available right now", which both
     * read as an empty machine rather than as absent wiring. This test
     * drives the real registered button listener and asserts the row it
     * writes, so the wiring cannot silently fall back to the defaults
     * again.
     */
    it('wires the session picker so a real Attach click binds the thread to a chat and its folder', async () => {
      const teamId = `T_${randomUUID()}`
      const boltApp = new StubBoltApp()
      const apiClient = new StubApiClient({ botUserId: 'UBOTFAKE', platformTeamId: teamId })
      const { adapter, workspaceId } = await createProductionSlackAdapter(pool, fakeSecrets(), {
        boltApp,
        apiClient,
      })

      const platformUserId = `U_${randomUUID()}`
      const principalId = await provisionPrincipal(pool, workspaceId, 'slack', platformUserId, 'Op', ['operator'])
      await adapter.start(async () => {})

      // A real session on this machine, so the handler's re-derivation of
      // the folder from discovery finds something to bind to.
      const discovered = await listEngineSessions({ limit: 1 })
      const target = discovered[0]
      expect(target, 'expected at least one Claude Code session on this machine').toBeDefined()

      const channel = `D_${randomUUID().slice(0, 8)}`
      const messageTs = '4000.000001'
      await boltApp.dispatchAction(SESSION_ATTACH_ACTION_ID, {
        actions: [
          {
            action_id: SESSION_ATTACH_ACTION_ID,
            type: 'button',
            value: JSON.stringify({
              engineSessionId: target?.sessionId,
              engineCwd: '/tmp/ignored-by-design',
              channel: 'C_IGNORED_BY_DESIGN',
              thread: '9999.999999',
            }),
          },
        ],
        user: { id: platformUserId },
        channel: { id: channel },
        message: { ts: messageTs },
      })

      const { rows } = await pool.query<{ engine_session_id: string | null; engine_cwd: string | null; principal_id: string }>(
        `SELECT engine_session_id, engine_cwd, principal_id FROM sessions
           WHERE workspace_id = $1 AND adapter = 'slack' AND thread_ref = $2`,
        [workspaceId, composeThreadRef(channel, messageTs)],
      )

      expect(rows).toHaveLength(1)
      expect(rows[0]?.engine_session_id).toBe(target?.sessionId)
      // Re-derived from discovery, never the payload's own path, and bound
      // to the thread Slack stamped on the click, never the payload's.
      expect(rows[0]?.engine_cwd).toBe(target?.cwd)
      expect(rows[0]?.principal_id).toBe(principalId)

      await adapter.stop()
    })

    it('wires approval clicks so a real Approve click resolves the row and reports it', async () => {
      const teamId = `T_${randomUUID()}`
      const boltApp = new StubBoltApp()
      const apiClient = new StubApiClient({ botUserId: 'UBOTFAKE', platformTeamId: teamId })
      const resolved: string[] = []
      const { adapter, workspaceId } = await createProductionSlackAdapter(pool, fakeSecrets(), {
        boltApp,
        apiClient,
        onApprovalResolved: async (result) => {
          if (result.approval) resolved.push(result.approval.id)
        },
      })
      const platformUserId = `U_${randomUUID()}`
      const principalId = await provisionPrincipal(pool, workspaceId, 'slack', platformUserId, 'Op', ['operator'])
      const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: `C:${randomUUID()}` })
      const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId })
      const approval = await createApproval(pool, {
        workspaceId,
        runId: run.id,
        sessionId: session.id,
        requesterPrincipalId: principalId,
        capability: 'autonomous.plan',
        description: 'approve plan v1',
        target: 'plan v1',
        tier: 'write',
        escalationReason: 'plan approval',
        requiredRoles: ['operator'],
        timeoutMs: 60_000,
        kind: 'plan',
        allowedPrincipalIds: [principalId],
      })
      await adapter.start(async () => {})

      await boltApp.dispatchAction(APPROVAL_ACTION_IDS.approve, {
        actions: [
          {
            action_id: APPROVAL_ACTION_IDS.approve,
            type: 'button',
            value: JSON.stringify({ approvalId: approval.id, requiresTypedConfirmation: false }),
          },
        ],
        user: { id: platformUserId },
        channel: { id: 'C_CLICK' },
        message: { ts: '7000.000001' },
      })

      const { rows } = await pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [approval.id])
      expect(rows[0]?.status).toBe('approved')
      expect(resolved).toEqual([approval.id])
      await adapter.stop()
    })

    it('wires resolveWorkspaceId, resolvePrincipalId, and isKnownSession to real Postgres', async () => {
      const teamId = `T_${randomUUID()}`
      const botUserId = 'UBOTFAKE'
      const boltApp = new StubBoltApp()
      const apiClient = new StubApiClient({ botUserId, platformTeamId: teamId })

      const { adapter, workspaceId } = await createProductionSlackAdapter(pool, fakeSecrets(), {
        boltApp,
        apiClient,
      })

      // PRE-3: a real uuid, never the raw Slack team id.
      expect(workspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

      const mappedUserId = `U_${randomUUID()}`
      const principalId = await provisionPrincipal(
        pool,
        workspaceId,
        'slack',
        mappedUserId,
        'Mapped User',
        ['operator'],
      )

      const events: ChatEvent[] = []
      await adapter.start(async (event) => {
        events.push(event)
      })

      // PRE-2 (resolution half): a mapped user resolves to its real principal id.
      await boltApp.dispatch('app_mention', {
        event: { type: 'app_mention', channel: 'C1', user: mappedUserId, text: `<@${botUserId}> hi`, ts: '1.000001' },
        body: {},
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.principalId).toBe(principalId)
      expect(events[0]?.workspaceId).toBe(workspaceId)

      // An unmapped user still gets a ChatEvent (suppression is
      // handleChatEvent's job, per PRE-2's other half), but with a null
      // principalId.
      await boltApp.dispatch('app_mention', {
        event: {
          type: 'app_mention',
          channel: 'C1',
          user: `U_unmapped_${randomUUID()}`,
          text: `<@${botUserId}> hi`,
          ts: '2.000001',
        },
        body: {},
      })
      expect(events).toHaveLength(2)
      expect(events[1]?.principalId).toBeNull()

      // PRE-4: a reply into a real, known session's thread is accepted...
      await findOrCreateSession(pool, {
        workspaceId,
        principalId,
        adapter: 'slack',
        threadRef: 'CKNOWN:100.000001',
      })
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CKNOWN',
          user: mappedUserId,
          text: 'reply',
          ts: '100.000002',
          thread_ts: '100.000001',
        },
        body: {},
      })
      expect(events).toHaveLength(3)

      // ...and a reply into an unrelated thread is still ignored: the
      // blocker case, now proven against the real wiring, not a hand
      // injected boolean.
      await boltApp.dispatch('message', {
        event: {
          type: 'message',
          channel: 'CUNRELATED',
          user: mappedUserId,
          text: 'reply',
          ts: '200.000002',
          thread_ts: '200.000001',
        },
        body: {},
      })
      expect(events).toHaveLength(3)
    })

    // -----------------------------------------------------------------------
    // Gate fix, Blocker 1: the production Stop path. GT-14's own headline
    // criterion: a Stop message must reach and cancel a long-running run,
    // within five seconds, THROUGH THE REAL INBOUND PATH, not by calling
    // CancellationRegistry.cancel directly. That last part is the point
    // (see the finding's own wording): a prior test proved the cancellation
    // mechanism worked in isolation; this proves it is actually reachable
    // from a real inbound Slack event.
    // -----------------------------------------------------------------------

    it(
      'a Stop message arriving while a long-running run is active cancels it, measured under five ' +
        'seconds, through adapter.start()/boltApp.dispatch(), never by calling the registry directly',
      async () => {
        const teamId = `T_${randomUUID()}`
        const botUserId = 'UBOTSTOP'
        const boltApp = new StubBoltApp()
        const apiClient = new StubApiClient({ botUserId, platformTeamId: teamId })

        const { adapter, workspaceId } = await createProductionSlackAdapter(pool, fakeSecrets(), {
          boltApp,
          apiClient,
        })
        const mappedUserId = `U_${randomUUID()}`
        await provisionPrincipal(pool, workspaceId, 'slack', mappedUserId, 'Stop Tester', ['operator'])

        const cancellationRegistry = new CancellationRegistry()

        // Plans a single step using slowCapability (test/support/slow-capability.ts):
        // a real `sleep 30` child process, far longer than the five second
        // cancellation bound, so the only way this run ends quickly is a
        // genuine cancellation, never the step simply finishing on its own.
        const slowRunEngine: Engine = async (invocation) => {
          const isPlan = invocation.jsonSchema === PLAN_JSON_SCHEMA
          const resultText = isPlan
            ? JSON.stringify({
                goalRestatement: 'run long enough to prove Stop reaches it',
                plannedSteps: [{ capability: 'slow', description: 'sleep' }],
                riskTier: 'low',
                estimatedCost: 'negligible',
                firstAction: { capability: 'slow', input: { seconds: 30 } },
              })
            : JSON.stringify({ done: true })
          return {
            sessionId: 'slow-run-session',
            numTurns: 1,
            stopReason: 'end_turn',
            totalCostUsd: 0.001,
            usage: {},
            permissionDenials: [],
            resultText,
            isError: false,
            errors: [],
          }
        }

        // adapter itself (not an OutboundDispatcher/Outbox) is the
        // dispatcher here: this test is about the INBOUND path (a Stop
        // reaching and cancelling a run), which does not need the durable
        // outbox to observe; the real SlackAdapter's own perform() already
        // resolves synchronously against the stub API client.
        await adapter.start(async (event) => {
          await handleChatEvent(
            {
              pool,
              dispatcher: adapter,
              log: silentLogger(),
              capabilities: { slow: slowCapability },
              cancellationRegistry,
              engine: slowRunEngine,
              policy: PERMISSIVE_POLICY,
            },
            event,
          )
        })

        const channel = 'D_STOP_TEST'
        const rootTs = `${Date.now()}.000001`

        // Fired without awaiting: this handler runs for up to 30 real
        // seconds unless cancelled, and boltApp.dispatch awaits its own
        // listener, so awaiting this call directly would hang the test.
        // Errors are swallowed here deliberately (a cancelled run's own
        // handleChatEvent call resolves normally; nothing here needs its
        // result), matching the fire-and-forget shape this scenario needs.
        void boltApp
          .dispatch('message', {
            event: { type: 'message', channel, user: mappedUserId, text: 'go slowly', ts: rootTs },
            body: {},
          })
          .catch(() => {})

        // Waits for the run to actually be under way (state 'running',
        // meaning startRun has already committed) before sending Stop, so
        // the measured window below is "Stop sent" to "cancelled observed"
        // and not inflated by however long session/run creation itself
        // takes.
        const runId = await waitForCondition(async () => {
          const { rows } = await pool.query<{ id: string }>(
            `SELECT id FROM runs WHERE workspace_id = $1 AND state = 'running' LIMIT 1`,
            [workspaceId],
          )
          return rows[0]?.id
        }, 5000)

        const stopSentAt = Date.now()
        // A reply in the same DM thread: per #isChannelEntryAllowed, a DM
        // channel (starting with 'D') is always accepted regardless of
        // thread status, so this needs no isKnownSession round trip to
        // land in the same session findOrCreateSession already created for
        // the root message above.
        await boltApp.dispatch('message', {
          event: {
            type: 'message',
            channel,
            user: mappedUserId,
            text: 'stop',
            ts: `${Date.now()}.000002`,
            thread_ts: rootTs,
          },
          body: {},
        })

        await waitForCondition(async () => {
          const { rows } = await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])
          return rows[0]?.state === 'cancelled' ? true : undefined
        }, 5000)
        const elapsedMs = Date.now() - stopSentAt

        expect(elapsedMs).toBeLessThan(5000)

        const { rows } = await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])
        expect(rows[0]?.state).toBe('cancelled')
      },
      15_000,
    )
  })

  // -------------------------------------------------------------------------
  // PRE-1: scheduling the drain.
  // -------------------------------------------------------------------------

  describe('scheduleOutboxDrain', () => {
    /**
     * Deliberately real timers, not vi.useFakeTimers(): the property under
     * test is that a background schedule, running the way a real process
     * runs it, is what delivers an enqueued action with nobody ever calling
     * drain() by hand. A real, short interval plus a real wait proves that
     * directly; mixing fake timers with a real Postgres round trip (a real
     * socket, not a JS timer) only adds a source of flakiness with no
     * benefit here, since nothing about the interval's exact length is
     * being measured. Bounded well under this test's own timeout either way.
     */
    it('an enqueued outbound action reaches the adapter because the scheduler drains it, with no manual drain() call', async () => {
      const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
      const adapter = new MockAdapter()
      await adapter.start(async () => {})
      const named: ChatAdapter = {
        name: `mock-${randomUUID()}`,
        capabilities: adapter.capabilities,
        start: (handler) => adapter.start(handler),
        stop: () => adapter.stop(),
        perform: (action) => adapter.perform(action),
      }
      const dispatcher = new OutboundDispatcher(pool, named, workspaceId)

      await dispatcher.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'drain me' })
      expect(adapter.performed).toHaveLength(0)

      const scheduler = scheduleOutboxDrain(dispatcher, { intervalMs: 20 })
      try {
        await vi.waitFor(() => expect(adapter.performed).toHaveLength(1), { timeout: 2000, interval: 20 })
        expect(adapter.performed[0]).toMatchObject({ kind: 'post', text: 'drain me' })
      } finally {
        scheduler.stop()
      }

      // stop() actually halts scheduling: a further enqueue is not
      // auto-delivered once stopped.
      await dispatcher.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'should not auto-drain' })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(adapter.performed).toHaveLength(1)
    })

    // SELF-ATTACK evidence lives in the task report: removing the
    // `scheduleOutboxDrain(dispatcher, ...)` call above (simulating "nothing
    // schedules the drain") makes the first `expect(adapter.performed).toHaveLength(1)`
    // fail, since nothing but the scheduler ever calls drain() in this test.

    it('survives a failed drain cycle: scheduling continues, and a later cycle still delivers', async () => {
      vi.useFakeTimers()
      try {
        let calls = 0
        const errors: unknown[] = []
        const drainable: Drainable = {
          async drain() {
            calls += 1
            if (calls === 1) throw new Error('simulated drain failure')
            return { sent: 1, failed: 0 }
          },
        }

        const scheduler = scheduleOutboxDrain(drainable, {
          intervalMs: 50,
          onError: (error) => errors.push(error),
        })
        try {
          await vi.advanceTimersByTimeAsync(60)
          expect(calls).toBe(1)
          expect(errors).toHaveLength(1)

          await vi.advanceTimersByTimeAsync(60)
          expect(calls).toBe(2)
        } finally {
          scheduler.stop()
        }
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('buildFinalReport: what the CAPABILITIES tell the operator, not what the model chose to say', () => {
  function resultWith(overrides: Partial<AgentLoopResult>): AgentLoopResult {
    return {
      runId: 'run_notices',
      state: 'succeeded',
      costUsd: 0.01,
      stepsExecuted: 1,
      notVerified: ['nothing was independently verified'],
      warnings: [],
      capabilityNotices: [],
      capabilitiesUsed: ['browser'],
      ...overrides,
    }
  }

  const START = new Date('2026-08-11T00:00:00.000Z')
  const END = new Date('2026-08-11T00:00:30.000Z')

  it('states that a page needed a human EVEN WHEN the model answered as though all was well', () => {
    // The failure this prevents: FR-BR-8's detection reached the model and
    // stopped there. A model that summarised the bot wall as if it were the
    // page produced a report with no sign anything was wrong.
    const report = buildFinalReport(
      resultWith({
        answer: 'There are 4 pending invoices.',
        capabilityNotices: [
          'Acted in the "acme-client" browser profile on tier 2.',
          'Human action needed on admin.acme.com, in the "acme-client" profile: captcha (likely, the page contains Google reCAPTCHA markup). Complete it yourself.',
        ],
      }),
      START,
      END,
    )

    expect(report).toContain('Human action needed')
    expect(report).toContain('captcha')
    // And it is not buried inside the model's answer, which is where it
    // would previously have had to be.
    expect(report.indexOf('Human action needed')).toBeGreaterThan(report.indexOf('Answer:'))
  })

  it('FR-PRF-10: names the profile that acted', () => {
    const report = buildFinalReport(
      resultWith({ capabilityNotices: ['Acted in the "westside" browser profile on tier 2.'] }),
      START,
      END,
    )

    expect(report).toContain('"westside" browser profile')
  })

  it('says a run with a mutating capability could have had real effects, rather than claiming nothing changed', () => {
    registerBuiltinCapabilities()
    const report = buildFinalReport(resultWith({ capabilitiesUsed: ['browser'] }), START, END)

    expect(report).toContain('can have real effects outside Relay')
    expect(report).not.toContain("nothing on the operator's machine")
  })

  it('bounds how many notices reach a chat message, and says it truncated rather than cutting silently', () => {
    const report = buildFinalReport(
      resultWith({ capabilityNotices: Array.from({ length: 20 }, (_value, index) => `note ${index}`) }),
      START,
      END,
    )

    expect(report).toContain('note 0')
    expect(report).not.toContain('note 19')
    expect(report).toContain('further notes are on the run record')
  })

  it('adds no Noted section at all when there is nothing to note', () => {
    const report = buildFinalReport(resultWith({}), START, END)
    expect(report).not.toContain('Noted:')
  })
})
