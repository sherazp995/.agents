import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { wrapUntrusted } from '../../src/agent/untrusted.js'
import { echo } from '../../src/agent/capabilities/echo.js'
import type { ChatEvent } from '../../src/chat/contract.js'
import { MockAdapter } from '../../src/chat/mock.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { createLogger } from '../../src/obs/logger.js'
import { handleChatEvent, PAUSED_TEXT, type OrchestratorDeps } from '../../src/orchestrator.js'
import type { Policy } from '../../src/policy/schema.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { SHELL_NEEDS_KILL_SWITCH_TEXT, SHELL_OWNER_ONLY_TEXT } from '../../src/shell/chat-route.js'
import { ShellJobs } from '../../src/shell/job.js'
import type { LineResult, RunLineOptions } from '../../src/shell/types.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/** Fails loudly instead of skipping when the var is absent, like every other database suite here. */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error('RELAY_TEST_DATABASE_URL is not set; this suite must fail, not silently skip.')
        })
      })

const log = createLogger('error', new Writable({ write(_chunk, _encoding, callback) { callback() } }))
const POLICY: Policy = { version: 1, defaults: { unmatched: 'ask' }, hard_blocked_origins: ['*.never-matched.invalid'] }
const noKillSwitch = { refuseIfEngaged: () => undefined }

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describeDb('handleChatEvent with the shell from Slack', () => {
  let pool: Pool
  let home: string

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
    await applyMigrations(pool, 'src/db/migrations')
    home = realpathSync(mkdtempSync(join(tmpdir(), 'shell-route-')))
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function fixtures() {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    const owner = await provisionPrincipal(pool, workspaceId, 'test', `U_${randomUUID()}`, 'Owner', ['owner'])
    const member = await provisionPrincipal(pool, workspaceId, 'test', `U_${randomUUID()}`, 'Member', ['member'])
    return { workspaceId, owner, member }
  }

  /** Real ShellJobs with a fake line runner (`wait` runs until stopped) and a fake Slack. */
  function shell(): { jobs: ShellJobs; ran: string[]; edits: string[] } {
    const ran: string[] = []
    const edits: string[] = []
    const runLine = async (options: RunLineOptions): Promise<LineResult> => {
      ran.push(options.command)
      const output = { head: 'out', tail: '', omittedBytes: 0 }
      if (options.command !== 'wait') return { command: options.command, outcome: { kind: 'exited', code: 0 }, output, folderAfter: options.cwd }
      return new Promise((resolve) => {
        const done = (): void => resolve({ command: options.command, outcome: { kind: 'killed', why: 'cancelled', reason: String(options.signal?.reason) }, output, folderAfter: options.cwd })
        if (options.signal?.aborted) done()
        options.signal?.addEventListener('abort', done)
      })
    }
    const jobs = new ShellJobs({
      pool,
      log,
      replies: () => ({ post: async ({ channel }) => ({ channel, ts: '9.9' }), update: async ({ text }) => void edits.push(text) }),
      renderBlocks: (text) => [{ type: 'markdown', text }],
      principalFor: async () => null,
      home,
      runLine,
      startAskpass: async () => ({ sudo: { binDir: '/nonexistent', env: {} }, close: async () => {} }),
    })
    return { jobs, ran, edits }
  }

  function event(params: { workspaceId: string; principalId: string; text: string; thread?: string; channel?: string; mentionsBot?: boolean; origin?: 'reminder' }): ChatEvent {
    const channel = params.channel ?? `C_${randomUUID()}`
    const message = `${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`
    return {
      kind: params.thread !== undefined ? 'thread_reply' : 'message',
      adapter: 'test',
      workspaceId: params.workspaceId,
      platformTeamId: 'T_TEST',
      principalId: params.principalId,
      ref: params.thread !== undefined ? { channel, thread: params.thread, message } : { channel, message },
      text: wrapUntrusted(params.text),
      files: [],
      raw: wrapUntrusted({ type: 'message', channel, ts: message, text: params.text }),
      receivedAt: new Date().toISOString(),
      mentionsBot: params.mentionsBot ?? false,
      platformEventId: `${channel}:${message}`,
      ...(params.origin ? { origin: params.origin } : {}),
    }
  }

  function deps(adapter: MockAdapter, jobs: ShellJobs, extra: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return { pool, dispatcher: adapter, log, capabilities: { echo }, policy: POLICY, killSwitch: noKillSwitch, shell: jobs, ...extra }
  }

  async function rowCount(table: 'sessions' | 'runs', workspaceId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE workspace_id = $1`, [workspaceId])
    return rows.length
  }

  it('runs the owner `! pwd` with no session or run created', async () => {
    const { workspaceId, owner } = await fixtures()
    const { jobs, ran } = shell()
    const adapter = new MockAdapter()
    await handleChatEvent(deps(adapter, jobs), event({ workspaceId, principalId: owner, text: '! pwd' }))
    await until(() => !jobs.busy())
    expect(ran).toEqual(['pwd'])
    expect(adapter.performed).toEqual([])
    expect(await rowCount('sessions', workspaceId)).toBe(0)
    expect(await rowCount('runs', workspaceId)).toBe(0)
  })

  it('refuses a member, and refuses when no kill switch can stop the lines', async () => {
    const { workspaceId, owner, member } = await fixtures()
    const { jobs, ran } = shell()
    const adapter = new MockAdapter()
    await handleChatEvent(deps(adapter, jobs), event({ workspaceId, principalId: member, text: '! pwd' }))
    const { killSwitch: _none, ...withoutKillSwitch } = deps(adapter, jobs)
    await handleChatEvent(withoutKillSwitch, event({ workspaceId, principalId: owner, text: '! pwd' }))
    expect(ran).toEqual([])
    expect(adapter.performed.map((action) => (action.kind === 'post' ? action.text : action.kind))).toEqual([SHELL_OWNER_ONLY_TEXT, SHELL_NEEDS_KILL_SWITCH_TEXT])
  })

  it('never runs a reminder as shell lines', async () => {
    const { workspaceId, owner } = await fixtures()
    const { jobs, ran } = shell()
    await handleChatEvent(deps(new MockAdapter(), jobs), event({ workspaceId, principalId: owner, text: '! pwd', origin: 'reminder' }))
    expect(ran).toEqual([])
  })

  it('stop kills the running line, says nothing more in a shell only thread, and a member cannot stop it', async () => {
    const { workspaceId, owner, member } = await fixtures()
    const { jobs, ran, edits } = shell()
    const adapter = new MockAdapter()
    const channel = `C_${randomUUID()}`
    const root = event({ workspaceId, principalId: owner, text: '! wait', channel })
    const thread = String(root.ref.message)
    await handleChatEvent(deps(adapter, jobs), root)
    await until(() => ran.length === 1)
    await handleChatEvent(deps(adapter, jobs), event({ workspaceId, principalId: member, text: 'stop', channel, thread }))
    expect(jobs.busy()).toBe(true)
    adapter.performed.length = 0
    await handleChatEvent(deps(adapter, jobs), event({ workspaceId, principalId: owner, text: 'stop', channel, thread }))
    await until(() => !jobs.busy())
    expect(edits.at(-1)).toContain('stopped from Slack')
    expect(adapter.performed).toEqual([])
  })

  it('stop kills the shell line and still pauses an autonomous task in the same thread', async () => {
    const { workspaceId, owner } = await fixtures()
    const { jobs, ran } = shell()
    const adapter = new MockAdapter()
    const channel = `C_${randomUUID()}`
    const root = event({ workspaceId, principalId: owner, text: '! wait', channel })
    const thread = String(root.ref.message)
    const session = await findOrCreateSession(pool, { workspaceId, principalId: owner, adapter: 'test', threadRef: `${channel}:${thread}` })
    await pool.query("UPDATE sessions SET mode = 'autonomous' WHERE id = $1", [session.id])
    const paused: string[] = []
    const autonomous = {
      route: async () => 'handled' as const,
      stopSession: async () => true,
      pauseSession: async (id: string) => {
        paused.push(id)
        return 'paused' as const
      },
    }
    await handleChatEvent(deps(adapter, jobs, { autonomous }), root)
    await until(() => ran.length === 1)
    await handleChatEvent(deps(adapter, jobs, { autonomous }), event({ workspaceId, principalId: owner, text: 'stop', channel, thread }))
    await until(() => !jobs.busy())
    expect(paused).toEqual([session.id])
    expect(adapter.performed.map((action) => (action.kind === 'post' ? action.text : action.kind))).toEqual([PAUSED_TEXT])
  })

  it('starts in the folder of the thread autonomous task, and runs commands written after a note', async () => {
    const { workspaceId, owner } = await fixtures()
    const ran: Array<{ command: string; cwd: string }> = []
    const taskFolder = realpathSync(mkdtempSync(join(tmpdir(), 'shell-task-')))
    const jobs = new ShellJobs({
      pool,
      log,
      replies: () => ({ post: async ({ channel }) => ({ channel, ts: '9.9' }), update: async () => undefined }),
      renderBlocks: (text) => [{ type: 'markdown', text }],
      principalFor: async () => null,
      home,
      runLine: async (options) => {
        ran.push({ command: options.command, cwd: options.cwd })
        return { command: options.command, outcome: { kind: 'exited', code: 0 }, output: { head: '', tail: '', omittedBytes: 0 }, folderAfter: options.cwd }
      },
      startAskpass: async () => ({ sudo: { binDir: '/nonexistent', env: {} }, close: async () => {} }),
    })
    const channel = `C_${randomUUID()}`
    const thread = `${Date.now()}.1`
    const session = await findOrCreateSession(pool, { workspaceId, principalId: owner, adapter: 'test', threadRef: `${channel}:${thread}` })
    await pool.query("UPDATE sessions SET mode = 'autonomous' WHERE id = $1", [session.id])
    await pool.query('INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id, chat_cwd) VALUES ($1, $2, $3, $4)', [workspaceId, session.id, owner, taskFolder])
    const autonomous = { route: async () => 'handled' as const, stopSession: async () => true, pauseSession: async () => 'paused' as const }
    await handleChatEvent(deps(new MockAdapter(), jobs, { autonomous }), event({ workspaceId, principalId: owner, text: '<@U_SOMEONE> ye dekh\n\n!pwd', channel, thread }))
    await until(() => !jobs.busy())
    expect(ran).toEqual([{ command: 'pwd', cwd: taskFolder }])
  })

  it('falls back to home when the thread autonomous task has no folder', async () => {
    const { workspaceId, owner } = await fixtures()
    const { jobs, ran } = shell()
    const channel = `C_${randomUUID()}`
    const thread = `${Date.now()}.2`
    const session = await findOrCreateSession(pool, { workspaceId, principalId: owner, adapter: 'test', threadRef: `${channel}:${thread}` })
    await pool.query("UPDATE sessions SET mode = 'autonomous' WHERE id = $1", [session.id])
    await pool.query('INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id) VALUES ($1, $2, $3)', [workspaceId, session.id, owner])
    const autonomous = { route: async () => 'handled' as const, stopSession: async () => true, pauseSession: async () => 'paused' as const }
    await handleChatEvent(deps(new MockAdapter(), jobs, { autonomous }), event({ workspaceId, principalId: owner, text: '! pwd', channel, thread }))
    await until(() => !jobs.busy())
    expect(ran).toEqual(['pwd'])
    const { rows } = await pool.query('SELECT folder FROM shell_folders WHERE workspace_id = $1', [workspaceId])
    // The route has no home of its own here, so it falls back to this laptop's home.
    expect(rows).toEqual([{ folder: homedir() }])
  })

  it('drops a plain unmentioned reply in a thread with only shell history', async () => {
    const { workspaceId, owner } = await fixtures()
    const { jobs } = shell()
    const adapter = new MockAdapter()
    const channel = `C_${randomUUID()}`
    const root = event({ workspaceId, principalId: owner, text: '! pwd', channel })
    await handleChatEvent(deps(adapter, jobs), root)
    await until(() => !jobs.busy())
    await handleChatEvent(deps(adapter, jobs, { engine: async () => { throw new Error('no agent work expected') } }), event({ workspaceId, principalId: owner, text: 'hello there', channel, thread: String(root.ref.message) }))
    expect(adapter.performed).toEqual([])
    expect(await rowCount('sessions', workspaceId)).toBe(0)
  })
})
