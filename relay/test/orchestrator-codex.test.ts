// A Slack reply in a thread linked to a `relay codex` chat (tmp/plans/agents-main-relay-codex-parity.md):
// queued into the open chat with `codex queue`, or answered once by Relay's own loop when it cannot be.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { wrapUntrusted } from '../src/agent/untrusted.js'
import type { Engine } from '../src/agent/engine.js'
import { PLAN_JSON_SCHEMA } from '../src/agent/planner.js'
import { echo } from '../src/agent/capabilities/echo.js'
import { registerBuiltinCapabilities } from '../src/capabilities/wiring.js'
import type { ChatEvent, ChatRef } from '../src/chat/contract.js'
import { MockAdapter } from '../src/chat/mock.js'
import { composeThreadRef } from '../src/chat/slack/events.js'
import type { Policy } from '../src/config/schema.js'
import { applyMigrations } from '../src/db/migrate.js'
import { closePool, createPool } from '../src/db/pool.js'
import type { QueueCall } from '../src/live/codex-queue.js'
import type { CodexChatRecord } from '../src/live/open-codex.js'
import { createLogger } from '../src/obs/logger.js'
import { handleChatEvent, type OrchestratorDeps } from '../src/orchestrator.js'
import { attachSessionToEngineChat, findOrCreateSession } from '../src/sessions/store.js'
import { OWNER_ONLY_REPLY } from '../src/tenancy/access.js'
import { provisionPrincipal } from '../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from './support/database.js'

const describeDb = process.env.RELAY_TEST_DATABASE_URL ? describe : describe.skip

const POLICY: Policy = { version: 1, defaults: { unmatched: 'ask' }, hard_blocked_origins: ['*.never-matched.invalid'] }
const CODEX_HOME = '/Users/op/.codex1'

const silentLogger = () => createLogger('info', new Writable({ write(_chunk, _enc, cb) { cb() } }))

async function until(condition: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The records Codex writes for a turn started by `codex queue` (measured: rollout-2026-11-20T21-08-52-01a1f9b7-...). */
function queueTurn(text: string, at: Date = new Date()): string {
  const timestamp = at.toISOString()
  return [
    JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'task_started', turn_attribution: { turn_trigger: 'queue' } } }),
    JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
  ].join('\n')
}

const immediateSuccess: Engine = async (invocation) => ({
  sessionId: 'fake-session',
  numTurns: 1,
  stopReason: 'end_turn',
  totalCostUsd: 0.001,
  usage: {},
  permissionDenials: [],
  resultText: invocation.jsonSchema === PLAN_JSON_SCHEMA ? JSON.stringify({ goalRestatement: 'g', plannedSteps: [], riskTier: 'low', estimatedCost: 'negligible', firstAction: null }) : JSON.stringify({ done: true }),
  isError: false,
  errors: [],
})

describeDb('a Slack reply to a relay codex chat', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
    await applyMigrations(pool, 'src/db/migrations')
    registerBuiltinCapabilities()
  })

  afterAll(async () => {
    await closePool(pool)
  })

  /** A thread linked to a Codex chat, a fake `codex queue` that writes what the chat would, and a fake router. */
  async function linkedThread(options: { call?: QueueCall; writesTurn?: boolean; linked?: boolean; cwd?: string; turnAgeMs?: number; turnWaitMs?: number; routeAnswer?: 'handled' | 'not_autonomous' } = {}) {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'test', `U_${randomUUID()}`, 'Owner', ['operator'])
    const channel = `C_${randomUUID()}`
    const root = `${Date.now()}.1`
    const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'test', threadRef: composeThreadRef(channel, root) })
    const chatId = randomUUID()
    if (options.linked !== false) await attachSessionToEngineChat(pool, session.id, chatId, options.cwd ?? '/Users/op/shop', null, 'codex')

    const sessions = mkdtempSync(join(tmpdir(), 'relay-codex-sessions-'))
    const rollout = join(sessions, '2026', '11', '20', `rollout-2026-11-20T21-00-00-${chatId}.jsonl`)
    mkdirSync(join(sessions, '2026', '11', '20'), { recursive: true })
    appendFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: chatId } })}\n`)

    const state = { open: true }
    const calls: { args: readonly string[]; home: string | undefined }[] = []
    const routed: { id: string; adopt: boolean }[] = []
    let routeFailures = 0
    const record: CodexChatRecord = { chatId, pid: 1, startedAt: 'x', codexHome: CODEX_HOME }
    const deps: OrchestratorDeps = {
      pool,
      dispatcher: new MockAdapter(),
      log: silentLogger(),
      capabilities: { echo },
      policy: POLICY,
      engine: immediateSuccess,
      handoverRetryMs: 20,
      codexChat: async (id) => (state.open && id === chatId ? record : null),
      codexDelivery: {
        bin: '/opt/homebrew/bin/codex',
        sessionsRoot: sessions,
        pollMs: 20,
        ...(options.turnWaitMs !== undefined ? { turnWaitMs: options.turnWaitMs } : {}),
        queue: async (_bin, args, env) => {
          calls.push({ args, home: env.CODEX_HOME })
          const text = (args.find((arg) => arg.startsWith('--message=')) ?? '').slice('--message='.length)
          if (options.writesTurn !== false) appendFileSync(rollout, `${queueTurn(text, new Date(Date.now() - (options.turnAgeMs ?? 0)))}\n`)
          return { call: options.call ?? 'accepted', detail: '' }
        },
      },
      autonomous: {
        route: async (event, _thread, routeOptions) => {
          if (routeFailures > 0) {
            routeFailures--
            throw new Error('database hiccup')
          }
          routed.push({ id: event.platformEventId, adopt: routeOptions?.adopt === true })
          return options.routeAnswer ?? 'handled'
        },
        stopSession: async () => true,
        pauseSession: async () => 'paused',
      },
    }
    const reply = (text: string, principal = principalId): ChatEvent => {
      const message = `${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`
      const ref: ChatRef = { channel, thread: root, message }
      return {
        kind: 'thread_reply',
        adapter: 'test',
        workspaceId,
        platformTeamId: 'T_TEST',
        principalId: principal,
        ref,
        text: wrapUntrusted(text),
        files: [],
        raw: wrapUntrusted({ type: 'message', user: 'U1', channel, ts: message, text }),
        receivedAt: new Date().toISOString(),
        mentionsBot: false,
        platformEventId: `${channel}:${message}`,
      }
    }
    const messages = async () => (await pool.query<{ claimed: boolean; body: string }>('SELECT claimed_at IS NOT NULL AS claimed, body FROM live_control_messages WHERE session_id = $1 ORDER BY created_at', [session.id])).rows
    return {
      workspaceId,
      session,
      chatId,
      deps,
      state,
      calls,
      routed,
      rollout,
      reply,
      messages,
      failRoutes: (count: number) => {
        routeFailures = count
      },
    }
  }

  it("queues the reply into the open chat on the chat's login, and Relay's loop does not answer it", async () => {
    const t = await linkedThread()

    await handleChatEvent(t.deps, t.reply('what changed?'))
    await until(async () => (await t.messages())[0]?.claimed === true)

    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]?.home).toBe(CODEX_HOME)
    expect(t.calls[0]?.args.slice(0, 3)).toEqual(['queue', '--thread', t.chatId])
    expect(t.calls[0]?.args[3]).toContain('what changed?')
    expect(t.calls[0]?.args[3]).toContain('relay live say --channel')
    expect(await t.messages()).toEqual([{ claimed: true, body: '' }])
    expect(t.routed).toEqual([])
  })

  it('delivers two replies sent at once, each once', async () => {
    const t = await linkedThread()

    await Promise.all([handleChatEvent(t.deps, t.reply('first')), handleChatEvent(t.deps, t.reply('second'))])
    await until(async () => (await t.messages()).every((message) => message.claimed))

    expect(t.calls).toHaveLength(2)
    expect(await t.messages()).toEqual([{ claimed: true, body: '' }, { claimed: true, body: '' }])
    expect(t.routed).toEqual([])
  })

  it("does not count an older queue turn or one with other text; when the chat then closes, Relay's loop answers once", async () => {
    // The turn holding this message's text is dated before the call, and the current one holds another message.
    const t = await linkedThread({ turnAgeMs: 60_000 })
    appendFileSync(t.rollout, `${queueTurn('Relay message 00000000-0000-0000-0000-000000000000')}\n`)
    const event = t.reply('are you there?')

    await handleChatEvent(t.deps, event)
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Accepted and the chat still open: Relay waits, rather than answering a message the chat may yet take.
    expect(t.routed).toEqual([])
    t.state.open = false
    await until(() => t.routed.length > 0)

    expect(t.routed).toEqual([{ id: event.platformEventId, adopt: true }])
    expect(await t.messages()).toEqual([{ claimed: true, body: '' }])
  })

  it("answers with Relay's loop at once when codex queue refuses the message", async () => {
    const t = await linkedThread({ call: 'refused', writesTurn: false })
    const event = t.reply('hello?')

    await handleChatEvent(t.deps, event)
    await until(() => t.routed.length > 0)

    expect(t.routed).toEqual([{ id: event.platformEventId, adopt: true }])
  })

  it('waits for the queue turn after codex queue timed out, instead of answering twice', async () => {
    const t = await linkedThread({ call: 'unknown' })

    await handleChatEvent(t.deps, t.reply('slow one'))
    await until(async () => (await t.messages())[0]?.claimed === true)

    expect(await t.messages()).toEqual([{ claimed: true, body: '' }])
    expect(t.routed).toEqual([])
  })

  it('counts a taken message delivered once the wait for its turn runs out with the chat still open, rather than answering twice', async () => {
    const t = await linkedThread({ writesTurn: false, turnWaitMs: 150 })

    await handleChatEvent(t.deps, t.reply('no turn record'))
    await until(async () => (await t.messages())[0]?.claimed === true)
    t.state.open = false
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(await t.messages()).toEqual([{ claimed: true, body: '' }])
    expect(t.routed).toEqual([])
  })

  it("answers with a governed run when the thread's task will not take the message back", async () => {
    const t = await linkedThread({ call: 'refused', writesTurn: false, routeAnswer: 'not_autonomous', cwd: mkdtempSync(join(tmpdir(), 'relay-codex-folder-')) })

    await handleChatEvent(t.deps, t.reply('anyone?'))
    await until(async () => (await pool.query('SELECT 1 FROM runs WHERE session_id = $1', [t.session.id])).rows.length === 1)
    await until(async () => (await t.messages())[0]?.body === '')

    expect(await t.messages()).toEqual([{ claimed: true, body: '' }])
  })

  it("sends a reply to Relay's loop, not to codex queue, before the chat is linked or once it has closed", async () => {
    const unlinked = await linkedThread({ linked: false })
    await handleChatEvent(unlinked.deps, unlinked.reply('early'))
    const closed = await linkedThread()
    closed.state.open = false
    await handleChatEvent(closed.deps, closed.reply('late'))

    expect(unlinked.calls).toEqual([])
    expect(closed.calls).toEqual([])
    expect(closed.routed).toEqual([{ id: expect.any(String), adopt: true }])
  })

  it('keeps an open Codex thread owner-only, like a Claude one', async () => {
    const t = await linkedThread()
    const member = await provisionPrincipal(pool, t.workspaceId, 'test', `U_${randomUUID()}`, 'Member', ['member'])
    await pool.query('UPDATE sessions SET principal_id = $2 WHERE id = $1', [t.session.id, member])
    const adapter = new MockAdapter()

    await handleChatEvent({ ...t.deps, dispatcher: adapter }, t.reply('let me in', member))

    expect(adapter.performed.map((action) => (action as { text?: string }).text)).toEqual([OWNER_ONLY_REPLY])
    expect(t.calls).toEqual([])
  })

  it('keeps a taken-back message whose hand-over throws, and answers it once on the next try', async () => {
    const t = await linkedThread({ call: 'refused', writesTurn: false })
    t.failRoutes(1)
    const event = t.reply('do not lose me')

    await handleChatEvent(t.deps, event)
    await until(() => t.routed.length > 0)
    await until(async () => (await t.messages())[0]?.body === '')

    expect(t.routed).toEqual([{ id: event.platformEventId, adopt: true }])
    expect(await t.messages()).toEqual([{ claimed: true, body: '' }])
  })

  it('leaves the message queued with its text when every hand-over fails', async () => {
    const t = await linkedThread({ call: 'refused', writesTurn: false })
    t.failRoutes(3)

    await handleChatEvent(t.deps, t.reply('still here'))
    await until(async () => (await t.messages())[0]?.claimed === false, 3_000).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(t.routed).toEqual([])
    expect(await t.messages()).toEqual([{ claimed: false, body: 'still here' }])
  })

  it('with autonomous mode off, answers a message the closed chat could not take with a fresh governed run, never resuming the Codex chat', async () => {
    // A real folder: the governed run refuses to start in one that does not exist.
    const t = await linkedThread({ call: 'refused', writesTurn: false, cwd: mkdtempSync(join(tmpdir(), 'relay-codex-folder-')) })
    const resumed: (string | undefined)[] = []
    const engine: Engine = async (invocation) => {
      resumed.push(invocation.resume)
      return immediateSuccess(invocation)
    }
    const { autonomous: _off, ...rest } = t.deps

    await handleChatEvent({ ...rest, engine }, t.reply('answer me'))
    await until(async () => (await t.messages())[0]?.body === '')
    await until(async () => (await pool.query('SELECT 1 FROM runs WHERE session_id = $1', [t.session.id])).rows.length === 1)

    // The first call starts fresh; later calls in the run resume the run's own new session, never the Codex chat.
    expect(resumed.length).toBeGreaterThan(0)
    expect(resumed[0]).toBeUndefined()
    expect(resumed).not.toContain(t.chatId)
  })
})
