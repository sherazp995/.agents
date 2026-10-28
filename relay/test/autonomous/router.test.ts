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
import { loadTaskBySession, markTaskStopped, type IntakeOutbox } from '../../src/autonomous/store.js'
import { findActiveSession } from '../../src/sessions/store.js'
import { extensionTokenKey, parseExtensionToken, type TaskSecretStore } from '../../src/autonomous/extension-grant.js'
import { routeAutonomousEvent, STOPPED_TEXT, type RouterDeps } from '../../src/autonomous/router.js'
import { scrubSecrets } from '../../src/secrets/scrubber.js'
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

  function memorySecrets(): TaskSecretStore & { values: Map<string, string> } {
    const values = new Map<string, string>()
    return {
      values,
      async get(name) {
        return values.get(name)
      },
      async set(name, value) {
        values.set(name, value)
      },
      async delete(name) {
        values.delete(name)
      },
    }
  }

  /** Queues in the caller's transaction like Outbox.enqueue; the first `failures` react enqueues throw. */
  function outbox(failures = 0): IntakeOutbox & { queued: (workspaceId: string) => Promise<ChatAction[]> } {
    let remaining = failures
    return {
      async enqueue(action: ChatAction, workspaceId: string, executor?: PoolClient) {
        if (action.kind === 'react' && remaining > 0) {
          remaining -= 1
          throw new Error('injected intake failure')
        }
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

  function deps(overrides: Partial<RouterDeps> = {}): RouterDeps & { wakes: number } {
    const result = {
      pool,
      outbox: outbox(),
      secrets: memorySecrets(),
      isOperator: async () => false,
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

  it('creates the task, queues only 👀, records the agent preference and wakes the scheduler', async () => {
    const { workspaceId, requester } = await setup()
    const d = deps()
    const where = thread('10.1')

    expect(await routeAutonomousEvent(d, event(workspaceId, requester, 'use codex to fix the login bug', '10.1'), where)).toBe('handled')

    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
    const task = await loadTaskBySession(pool, session?.id ?? '')
    expect(task?.agentPreference).toBe('codex')
    expect((await (d.outbox as ReturnType<typeof outbox>).queued(workspaceId)).map((action) => action.kind).sort()).toEqual(['react'])
    expect(d.wakes).toBe(1)
  })

  it('redacts a requester token before storing it, keeps it in the keystore and scrubs it from posts', async () => {
    const { workspaceId, requester } = await setup()
    const secrets = memorySecrets()
    const d = deps({ secrets })
    const where = thread('11.1')
    const token = `ext-${randomUUID()}`

    await routeAutonomousEvent(d, event(workspaceId, requester, `use playwright-extension PLAYWRIGHT_MCP_EXTENSION_TOKEN=${token}`, '11.1'), where)

    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: where.threadRef })
    const task = await loadTaskBySession(pool, session?.id ?? '')
    expect(task?.pendingEvents[0]?.text).toBe('use playwright-extension PLAYWRIGHT_MCP_EXTENSION_TOKEN=[redacted]')
    expect(secrets.values.get(extensionTokenKey(task?.id ?? ''))).toBe(token)
    expect(scrubSecrets(`the token is ${token}`)).not.toContain(token)
    const { rows } = await pool.query<{ extension_granted_by: string }>('SELECT extension_granted_by FROM autonomous_tasks WHERE id = $1', [task?.id])
    expect(rows[0]?.extension_granted_by).toBe(requester)
  })

  it('ignores a token from a member who is not the requester, stores nothing and says so', async () => {
    const { workspaceId, requester, member } = await setup()
    const secrets = memorySecrets()
    const box = outbox()
    const d = deps({ secrets, outbox: box })
    const where = thread('12.1')
    await routeAutonomousEvent(d, event(workspaceId, requester, 'review PR 3', '12.1'), where)

    await routeAutonomousEvent(d, { ...event(workspaceId, member, 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=abc123', '12.2'), ref: { channel: 'C1', message: '12.2', thread: '12.1' } }, where)

    expect(secrets.values.size).toBe(0)
    const posts = (await box.queued(workspaceId)).filter((action) => action.kind === 'post')
    expect(posts.at(-1)).toMatchObject({ text: expect.stringContaining('Only the requester or an operator') })
  })

  it('retries a failed intake and creates exactly one task', async () => {
    const { workspaceId, requester } = await setup()
    const d = deps({ outbox: outbox(1) })
    const where = thread('13.1')

    expect(await routeAutonomousEvent(d, event(workspaceId, requester, 'fix it', '13.1'), where)).toBe('handled')

    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM autonomous_tasks WHERE workspace_id = $1', [workspaceId])
    expect(rows[0]?.n).toBe('1')
  })

  it('throws IntakeFailedError after three failures and leaves no session or task', async () => {
    const { workspaceId, requester } = await setup()
    const d = deps({ outbox: outbox(3) })

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

  it('a duplicate delivery runs once', async () => {
    const { workspaceId, requester } = await setup()
    const d = deps()
    const where = thread('16.1')
    const first = event(workspaceId, requester, 'fix it', '16.1')

    await routeAutonomousEvent(d, first, where)
    await routeAutonomousEvent(d, first, where)

    expect(d.wakes).toBe(1)
  })

  it('parses the last token assignment and redacts every one', () => {
    expect(parseExtensionToken('PLAYWRIGHT_MCP_EXTENSION_TOKEN=a and PLAYWRIGHT_MCP_EXTENSION_TOKEN = "b"')).toEqual({
      text: 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=[redacted] and PLAYWRIGHT_MCP_EXTENSION_TOKEN=[redacted]',
      token: 'b',
    })
  })
})
