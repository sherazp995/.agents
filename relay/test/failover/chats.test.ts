import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Account, CooldownStore } from '../../src/autonomous/accounts.js'
import type { TurnRequestContext } from '../../src/autonomous/scheduler.js'
import { acquireLease, intakeMention, type AutonomousTask } from '../../src/autonomous/store.js'
import { runTurnOnPool, turnCwd, type TurnRunnerDeps } from '../../src/autonomous/turn-runner.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { claudeProjectFolder, createChatSync, pruneChats, saveChat } from '../../src/failover/chats.js'
import { createLogger } from '../../src/obs/logger.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

const noCooldowns: CooldownStore = { cooldownUntil: async () => null, coolDown: async () => undefined }

/** One laptop: its own home with a Claude login and the project's folder, as a different username would have. */
type Laptop = { host: string; account: Account; cwd: string; projects: string }

function laptop(host: string, options: { projects?: boolean; accountKey?: string } = {}): Laptop {
  const home = mkdtempSync(join(tmpdir(), `relay-${host}-`))
  const configDir = join(home, '.claude')
  if (options.projects !== false) mkdirSync(join(configDir, 'projects'), { recursive: true })
  const cwd = join(home, 'code', 'shop')
  mkdirSync(cwd, { recursive: true })
  return { host, account: { key: options.accountKey ?? `claude-${host}`, client: 'claude', configDir, env: {} }, cwd, projects: join(configDir, 'projects') }
}

/** The chat file Claude keeps for `cwd` under this laptop's login. */
const chatFile = (place: Laptop, sessionId: string): string => join(realpathSync(place.projects), claudeProjectFolder(realpathSync(place.cwd)), `${sessionId}.jsonl`)

describe('saved chats', () => {
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

  async function newTask(): Promise<TurnRequestContext> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'R', ['member'])
    const result = await intakeMention(pool, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
      event: { id: randomUUID(), principalId, text: 'x', ref: { channel: 'C1', message: '1.1' }, fileIds: [], receivedAt: '' },
      replyRef: { channel: 'C1', thread: '1.1' },
      files: [],
    })
    if (result.kind !== 'created') throw new Error('no task')
    const lease = await acquireLease(pool, result.task.id, 'test', 60_000)
    if (!lease) throw new Error('no lease')
    return { task: result.task, lease, prompt: 'new messages', freshPrompt: async () => 'thread history and new messages', signal: new AbortController().signal, recordWorker: async () => true }
  }

  /**
   * One turn on `place`, with a fake Claude that appends a line to the chat it
   * resumes (or a new one) and writes a tool result into the chat's folder, as
   * the real CLI does. `state` stands in for what the scheduler records.
   */
  async function turn(place: Laptop, context: TurnRequestContext, state: { sessionId: string | null; accountKey: string | null }): Promise<{ resumed: string | undefined; prompt: string }> {
    let resumed: string | undefined
    let prompt = ''
    const deps: TurnRunnerDeps = {
      pool,
      readAccounts: async () => [place.account],
      cooldowns: noCooldowns,
      isCodexEligible: async () => false,
      turnTimeoutMs: 10_000,
      issueToken: () => 'token',
      revokeToken: () => undefined,
      chats: createChatSync(pool, place.host, createLogger('fatal')),
      async spawnPlan(params) {
        resumed = params.resume
        prompt = params.context.prompt
        return { bin: 'claude', args: [], cwd: turnCwd(params.context, params.subject), env: {} }
      },
      async runTurn(request) {
        // The real CLI makes its projects folder on first use.
        mkdirSync(place.projects, { recursive: true })
        const sessionId = resumed ?? randomUUID()
        const file = chatFile(place, sessionId)
        mkdirSync(join(file, '..', sessionId, 'tool-results'), { recursive: true })
        appendFileSync(file, `turn on ${place.host}\n`)
        writeFileSync(join(file, '..', sessionId, 'tool-results', `${place.host}.txt`), place.host)
        expect(request.cwd).toBe(place.cwd)
        return { kind: 'reply', text: 'done', sessionId }
      },
    }
    const task: AutonomousTask = { ...context.task, chatCwd: place.cwd, engineSessionId: state.sessionId, accountKey: state.accountKey }
    const result = await runTurnOnPool(deps, { ...context, task })
    if (result.kind !== 'outcome' || result.outcome.kind !== 'reply') throw new Error('expected a reply')
    state.sessionId = result.outcome.sessionId
    state.accountKey = result.accountKey
    return { resumed, prompt }
  }

  it("continues one chat across two laptops: A's chat, continued on B, picked up on A again holds B's turn", async () => {
    const context = await newTask()
    const a = laptop('laptop-a')
    const b = laptop('laptop-b')
    const state = { sessionId: null as string | null, accountKey: null as string | null }

    await turn(a, context, state)
    const sessionId = state.sessionId ?? ''
    // B has no login named like A's: it resumes only because the chat was restored into its own login.
    const onB = await turn(b, context, state)
    const backOnA = await turn(a, context, state)

    expect(onB.resumed).toBe(sessionId)
    expect(onB.prompt).toBe('new messages')
    expect(backOnA.resumed).toBe(sessionId)
    expect(readFileSync(chatFile(a, sessionId), 'utf8')).toBe('turn on laptop-a\nturn on laptop-b\nturn on laptop-a\n')
    expect(readFileSync(join(chatFile(a, sessionId), '..', sessionId, 'tool-results', 'laptop-b.txt'), 'utf8')).toBe('laptop-b')
    const { rows } = await pool.query('SELECT revision, saved_by FROM failover_chats WHERE task_id = $1', [context.task.id])
    expect(rows).toEqual([{ revision: '3', saved_by: 'laptop-a' }])
  })

  it('refuses a save built on an older copy than the stored one', async () => {
    const context = await newTask()
    const a = laptop('laptop-a')
    const b = laptop('laptop-b')
    const state = { sessionId: null as string | null, accountKey: null as string | null }
    await turn(a, context, state)
    await turn(b, context, state)
    const sessionId = state.sessionId ?? ''

    // A never restored B's turn: its copy is at revision 1, the stored one at 2.
    const stale = await saveChat(pool, { taskId: context.task.id, workspaceId: context.task.workspaceId, sessionId, cwd: a.cwd, projectsDir: realpathSync(a.projects), host: 'laptop-a' })

    expect(stale).toBe('refused')
    const { rows } = await pool.query('SELECT revision, saved_by FROM failover_chats WHERE task_id = $1', [context.task.id])
    expect(rows).toEqual([{ revision: '2', saved_by: 'laptop-b' }])
  })

  it("starts fresh instead of resuming this laptop's older copy when the newer stored chat cannot be restored", async () => {
    const context = await newTask()
    // Both laptops call their default login "claude", as real ones do, so A's login matches the task's.
    const a = laptop('laptop-a', { accountKey: 'claude' })
    const b = laptop('laptop-b', { accountKey: 'claude' })
    const state = { sessionId: null as string | null, accountKey: null as string | null }
    await turn(a, context, state)
    await turn(b, context, state)
    await pool.query("UPDATE failover_chats SET archive = 'not a tarball'::bytea WHERE task_id = $1", [context.task.id])

    // A still has its own revision 1 copy and its login matches, so only the failed restore stops the resume.
    const backOnA = await turn(a, context, state)

    expect(backOnA.resumed).toBeUndefined()
    expect(backOnA.prompt).toBe('thread history and new messages')
  })

  it("starts a fresh chat with the thread's history when this laptop's Claude folder is missing", async () => {
    const context = await newTask()
    const a = laptop('laptop-a')
    const b = laptop('laptop-b', { projects: false })
    const state = { sessionId: null as string | null, accountKey: null as string | null }
    await turn(a, context, state)
    const first = state.sessionId

    const onB = await turn(b, context, state)

    expect(onB.resumed).toBeUndefined()
    expect(onB.prompt).toBe('thread history and new messages')
    expect(state.sessionId).not.toBe(first)
  })

  it('drops chats saved more than a week ago, then the oldest beyond the size cap', async () => {
    // The cap counts every saved chat, so the earlier examples' ones would use it up.
    await pool.query('DELETE FROM failover_chats')
    const tasks = [await newTask(), await newTask(), await newTask()]
    const insert = (context: TurnRequestContext, age: string, bytes: number) =>
      pool.query(
        `INSERT INTO failover_chats (task_id, workspace_id, session_id, cwd, revision, archive, size_bytes, saved_by, saved_at)
         VALUES ($1, $2, 's', '/x', 1, $5, $3, 'laptop-a', now() - $4::interval)`,
        [context.task.id, context.task.workspaceId, bytes, age, Buffer.from([0])],
      )
    const [old, older, newest] = tasks as [TurnRequestContext, TurnRequestContext, TurnRequestContext]
    await insert(old, '8 days', 10)
    await insert(older, '2 days', 600)
    await insert(newest, '1 day', 600)

    await pruneChats(pool, { totalBytes: 1000 })

    const { rows } = await pool.query<{ task_id: string }>('SELECT task_id FROM failover_chats WHERE task_id = ANY ($1)', [tasks.map((context) => context.task.id)])
    expect(rows.map((row) => row.task_id)).toEqual([newest.task.id])
  })
})
