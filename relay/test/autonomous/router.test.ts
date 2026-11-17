import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { wrapUntrusted } from '../../src/agent/untrusted.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { IntakeFailedError, type ChatAction, type ChatEvent } from '../../src/chat/contract.js'
import { loadTask, loadTaskBySession, markTaskStopped, requestCancel, type IntakeOutbox } from '../../src/autonomous/store.js'
import { findActiveSession } from '../../src/sessions/store.js'
import { EXTENSION_ONLY_NOTE } from '../../src/autonomous/extension-token.js'
import { REMINDER_NO_FOLDER_TEXT, routeAutonomousEvent, STILL_STOPPING_TEXT, STOPPED_TEXT, type RouterDeps } from '../../src/autonomous/router.js'
import { attachSessionToEngineChat, ReadOnlySessionError } from '../../src/sessions/store.js'
import { createLogger } from '../../src/obs/logger.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('autonomous router', () => {
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
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const requester = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Requester', ['member'])
    const member = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Member', ['member'])
    return { workspaceId, requester, member }
  }

  /** Queues in the caller's transaction like Outbox.enqueue. */
  function outbox(): IntakeOutbox & { queued: (workspaceId: string) => Promise<ChatAction[]> } {
    return {
      async enqueue(action: ChatAction, workspaceId: string, executor?: PoolClient) {
        const { rows } = await (executor ?? pool).query<{ id: string }>(
          `INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'test', $2, now()) RETURNING id`,
          [workspaceId, action],
        )
        return rows[0]?.id ?? ''
      },
      async queued(workspaceId) {
        const { rows } = await pool.query<{ action: ChatAction }>(`SELECT action FROM outbox WHERE workspace_id = $1 ORDER BY created_at, id`, [workspaceId])
        return rows.map((row) => row.action)
      },
    }
  }

  /** The test pool, except the first `failures` intake transactions fail their task insert. */
  function failingIntakePool(failures: number): Pool {
    let remaining = failures
    const connect = async (): Promise<PoolClient> => {
      const client = await pool.connect()
      const query = (text: unknown, ...rest: unknown[]) => {
        if (typeof text === 'string' && text.includes('INSERT INTO autonomous_tasks') && remaining > 0) {
          remaining -= 1
          return Promise.reject(new Error('injected intake failure'))
        }
        return (client.query as (...args: unknown[]) => Promise<unknown>).call(client, text, ...rest)
      }
      return Object.assign(Object.create(client) as PoolClient, { query, release: () => client.release() })
    }
    return Object.assign(Object.create(pool) as Pool, { connect })
  }

  function deps(overrides: Partial<RouterDeps> = {}): RouterDeps & { wakes: number } {
    const result = {
      pool,
      outbox: outbox(),
      chatFolder: (text: string) => (text.includes('winad') ? '/repos/winad' : '/repos/agents'),
      reminderFolder: (text: string) => (text.includes('winad') ? '/repos/winad' : undefined),
      wakes: 0,
      wake: () => {
        result.wakes += 1
      },
      log: createLogger('fatal'),
      sleep: async () => undefined,
      ...overrides,
    }
    return result
  }

  function event(workspaceId: string, principalId: string, text: string, ts = `${Date.now()}.000001`): ChatEvent {
    return {
      kind: 'message',
      adapter: 'slack',
      workspaceId,
      principalId,
      ref: { channel: 'C1', message: ts },
      text: wrapUntrusted(text),
      files: [],
      raw: wrapUntrusted({}),
      receivedAt: new Date().toISOString(),
      mentionsBot: true,
      platformEventId: `C1:${ts}`,
    } as unknown as ChatEvent
  }

  const thread = (ts: string) => ({ threadRef: `slack:C1:${ts}:${randomUUID()}`, replyRef: { channel: 'C1', thread: ts } })

  describe('extension token and profile words', () => {
    const TOKEN = 'k3y-AbCdEf_0123456789'
    const dm = (workspaceId: string, principalId: string, text: string, ts: string) => {
      const base = event(workspaceId, principalId, text, ts)
      return { ...base, ref: { channel: 'D1', message: ts }, platformEventId: `D1:${ts}` } as ChatEvent
    }
    const dmThread = (ts: string) => ({ threadRef: `D1:${ts}${randomUUID()}`, replyRef: { channel: 'D1', thread: ts } })
    async function storedText(workspaceId: string, threadRef: string): Promise<string | undefined> {
      const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef })
      return (await loadTaskBySession(pool, session?.id ?? ''))?.pendingEvents[0]?.text
    }
    function extension(owner: boolean) {
      const remembered: { threadRef: string; browser: unknown }[] = []
      return {
        remembered,
        isOwner: async () => owner,
        rememberDm: (threadRef: string, browser: unknown) => void remembered.push({ threadRef, browser }),
      }
    }

    it("remembers the owner's DM values before intake opens its transaction and stores the message without them", async () => {
      const { workspaceId, requester } = await setup()
      const where = dmThread('30.1')
      const ext = extension(true)
      let intakeStarted = false
      let intakeStartedAtRemember: boolean | undefined
      const watchedPool = Object.assign(Object.create(pool) as Pool, {
        connect: () => {
          intakeStarted = true
          return pool.connect()
        },
      })
      const rememberDm = (threadRef: string, browser: unknown) => {
        intakeStartedAtRemember = intakeStarted
        ext.rememberDm(threadRef, browser)
      }

      await routeAutonomousEvent(deps({ pool: watchedPool, extension: { isOwner: ext.isOwner, rememberDm } }), dm(workspaceId, requester, `fix it PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN} PLAYWRIGHT_MCP_PROFILE_DIR_NAME="Profile 3"`, '30.1'), where)

      expect(ext.remembered).toEqual([{ threadRef: where.threadRef, browser: { token: TOKEN, profile: 'Profile 3' } }])
      expect(intakeStarted).toBe(true)
      expect(intakeStartedAtRemember).toBe(false)
      expect(await storedText(workspaceId, where.threadRef)).toBe('fix it')
    })

    it("strips a member's DM values and does not use them", async () => {
      const { workspaceId, member } = await setup()
      const where = dmThread('30.2')
      const ext = extension(false)

      await routeAutonomousEvent(deps({ extension: ext }), dm(workspaceId, member, `fix it PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`, '30.2'), where)

      expect(ext.remembered).toEqual([])
      expect(await storedText(workspaceId, where.threadRef)).toBe('fix it')
    })

    it('strips the words from a channel message without using them, and stores a note for a message that held nothing else', async () => {
      const { workspaceId, requester } = await setup()
      const where = thread('30.3')
      const ext = extension(true)

      await routeAutonomousEvent(deps({ extension: ext }), event(workspaceId, requester, `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`, '30.3'), where)

      expect(ext.remembered).toEqual([])
      expect(await storedText(workspaceId, where.threadRef)).toBe(EXTENSION_ONLY_NOTE)
    })

    it('leaves remembered values alone for a DM message without the words', async () => {
      const { workspaceId, requester } = await setup()
      const where = dmThread('30.4')
      const ext = extension(true)

      await routeAutonomousEvent(deps({ extension: ext }), dm(workspaceId, requester, 'just fix it', '30.4'), where)

      expect(ext.remembered).toEqual([])
      expect(await storedText(workspaceId, where.threadRef)).toBe('just fix it')
    })
  })

  it('creates the task in the folder its first message names, queues no reaction, records the agent preference and wakes the scheduler', async () => {
    const { workspaceId, requester } = await setup()
    const d = deps()
    const where = thread('10.1')

    expect(await routeAutonomousEvent(d, event(workspaceId, requester, 'use codex to fix the login bug', '10.1'), where)).toBe('handled')

    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
    const task = await loadTaskBySession(pool, session?.id ?? '')
    expect(task?.agentPreference).toBe('codex')
    expect(task?.chatCwd).toBe('/repos/agents')
    expect(await (d.outbox as ReturnType<typeof outbox>).queued(workspaceId)).toEqual([])
    expect(d.wakes).toBe(1)
  })

  it('creates the task in a folder decided before routing, over the one the message names', async () => {
    const { workspaceId, requester } = await setup()
    const where = thread('10.2')

    await routeAutonomousEvent(deps(), event(workspaceId, requester, 'fix winad', '10.2'), where, { chatCwd: '/repos/channel' })

    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
    expect((await loadTaskBySession(pool, session?.id ?? ''))?.chatCwd).toBe('/repos/channel')
  })

  it('still handles a created task when recording its agent preference fails', async () => {
    const { workspaceId, requester } = await setup()
    const where = thread('10.3')
    const failingPreference = Object.assign(Object.create(pool) as Pool, {
      query: (text: unknown, ...rest: unknown[]) =>
        typeof text === 'string' && text.includes('SET agent_preference') ? Promise.reject(new Error('injected')) : (pool.query as (...args: unknown[]) => Promise<unknown>).call(pool, text, ...rest),
    })
    const d = deps({ pool: failingPreference })

    expect(await routeAutonomousEvent(d, event(workspaceId, requester, 'use codex to fix it', '10.3'), where)).toBe('handled')
    expect(d.wakes).toBe(1)
  })

  it('retries a failed intake and creates exactly one task', async () => {
    const { workspaceId, requester } = await setup()
    const d = deps({ pool: failingIntakePool(1) })
    const where = thread('13.1')

    expect(await routeAutonomousEvent(d, event(workspaceId, requester, 'fix it', '13.1'), where)).toBe('handled')

    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM autonomous_tasks WHERE workspace_id = $1', [workspaceId])
    expect(rows[0]?.n).toBe('1')
  })

  it('throws IntakeFailedError after three failures and leaves no session or task', async () => {
    const { workspaceId, requester } = await setup()
    const d = deps({ pool: failingIntakePool(3) })

    await expect(routeAutonomousEvent(d, event(workspaceId, requester, 'fix it', '14.1'), thread('14.1'))).rejects.toBeInstanceOf(IntakeFailedError)

    for (const table of ['sessions', 'autonomous_tasks', 'runs']) {
      const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = $1`, [workspaceId])
      expect(rows[0]?.n).toBe('0')
    }
  })

  it('leaves a governed thread to the governed loop', async () => {
    const { workspaceId, requester } = await setup()
    const where = thread('15.1')
    await findOrCreateSession(pool, { workspaceId, principalId: requester, adapter: 'slack', threadRef: where.threadRef })

    expect(await routeAutonomousEvent(deps(), event(workspaceId, requester, 'more', '15.2'), where)).toBe('not_autonomous')
  })

  it('answers a message to a stopped task without waking the scheduler', async () => {
    const { workspaceId, requester } = await setup()
    const box = outbox()
    const d = deps({ outbox: box })
    const where = thread('17.1')
    await routeAutonomousEvent(d, event(workspaceId, requester, 'fix it', '17.1'), where)
    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
    await markTaskStopped(pool, (await loadTaskBySession(pool, session?.id ?? ''))?.id ?? '')

    expect(await routeAutonomousEvent(d, event(workspaceId, requester, 'go on', '17.2'), where)).toBe('handled')

    expect(d.wakes).toBe(1)
    const posts = (await box.queued(workspaceId)).filter((action) => action.kind === 'post')
    expect(posts.at(-1)).toMatchObject({ text: STOPPED_TEXT })
  })

  it('keeps a message sent while a Stop is still in progress and answers that messages sent after the stop are kept, without waking the scheduler', async () => {
    const { workspaceId, requester } = await setup()
    const box = outbox()
    const d = deps({ outbox: box })
    const where = thread('18.1')
    await routeAutonomousEvent(d, event(workspaceId, requester, 'fix it', '18.1'), where)
    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
    const taskId = (await loadTaskBySession(pool, session?.id ?? ''))?.id ?? ''
    await requestCancel(pool, taskId)

    expect(await routeAutonomousEvent(d, event(workspaceId, requester, 'and the disk?', '18.2'), where)).toBe('handled')

    expect(d.wakes).toBe(1)
    const posts = (await box.queued(workspaceId)).filter((action) => action.kind === 'post')
    expect(posts.at(-1)).toMatchObject({ text: STILL_STOPPING_TEXT })
    expect((await loadTask(pool, taskId))?.pendingEvents.map((pending) => pending.text)).toContain('and the disk?')
  })

  it('a duplicate delivery runs once', async () => {
    const { workspaceId, requester } = await setup()
    const d = deps()
    const where = thread('16.1')
    const first = event(workspaceId, requester, 'fix it', '16.1')

    await routeAutonomousEvent(d, first, where)
    await routeAutonomousEvent(d, first, where)

    expect(d.wakes).toBe(1)
  })

  describe('a Slackbot reminder', () => {
    const reminder = (workspaceId: string, principalId: string, text: string, ts: string): ChatEvent => ({ ...event(workspaceId, principalId, text, ts), origin: 'reminder' })

    it('starts a read-only task that stays read-only after a reply in its thread, and keeps the reminder as its source', async () => {
      const { workspaceId, requester } = await setup()
      const where = thread('20.1')

      expect(await routeAutonomousEvent(deps(), reminder(workspaceId, requester, 'Reminder: status update for winad', '20.1'), where)).toBe('handled')
      await routeAutonomousEvent(deps(), event(workspaceId, requester, 'now push it', '20.2'), where)

      const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
      const task = await loadTaskBySession(pool, session?.id ?? '')
      expect(task).toMatchObject({ readOnly: true, chatCwd: '/repos/winad' })
      expect(task?.pendingEvents.map((pending) => pending.origin ?? null)).toEqual(['reminder', null])
    })

    it('leaves a task a person starts as not read-only', async () => {
      const { workspaceId, requester } = await setup()
      const where = thread('20.3')
      await routeAutonomousEvent(deps(), event(workspaceId, requester, 'fix winad', '20.3'), where)
      const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
      expect((await loadTaskBySession(pool, session?.id ?? ''))?.readOnly).toBe(false)
    })

    it('never joins a thread that already has a session', async () => {
      const { workspaceId, requester } = await setup()
      const where = thread('20.4')
      await routeAutonomousEvent(deps(), event(workspaceId, requester, 'fix winad', '20.4'), where)

      expect(await routeAutonomousEvent(deps(), reminder(workspaceId, requester, 'Reminder: winad', '20.5'), where)).toBe('not_autonomous')
      const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
      expect((await loadTaskBySession(pool, session?.id ?? ''))?.pendingEvents).toHaveLength(1)
    })

    it('replies once and starts nothing when its text names no folder, instead of falling back to the first repository', async () => {
      const { workspaceId, requester } = await setup()
      const d = deps()
      const where = thread('20.6')

      expect(await routeAutonomousEvent(d, reminder(workspaceId, requester, 'Reminder: status update', '20.6'), where)).toBe('handled')
      expect(await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })).toBeNull()
      expect(await (d.outbox as ReturnType<typeof outbox>).queued(workspaceId)).toEqual([{ kind: 'post', ref: where.replyRef, text: REMINDER_NO_FOLDER_TEXT }])
    })

    it('cannot be attached to a terminal chat, while a normal thread still can', async () => {
      const { workspaceId, requester } = await setup()
      const readOnly = thread('20.7')
      const normal = thread('20.8')
      await routeAutonomousEvent(deps(), reminder(workspaceId, requester, 'Reminder: winad', '20.7'), readOnly)
      await routeAutonomousEvent(deps(), event(workspaceId, requester, 'fix winad', '20.8'), normal)
      const readOnlySession = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: readOnly.threadRef })
      const normalSession = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: normal.threadRef })

      await expect(attachSessionToEngineChat(pool, readOnlySession?.id ?? '', 'chat-1', '/repos/winad')).rejects.toBeInstanceOf(ReadOnlySessionError)
      await expect(attachSessionToEngineChat(pool, normalSession?.id ?? '', 'chat-1', '/repos/winad')).resolves.toBeUndefined()
    })
  })
})
