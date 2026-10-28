import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import type { Account, CooldownStore } from '../../src/autonomous/accounts.js'
import { acquireLease, intakeMention, type AutonomousTask } from '../../src/autonomous/store.js'
import { runTurnOnPool, type SpawnPlanParams, type TurnRunnerDeps } from '../../src/autonomous/turn-runner.js'
import type { TurnRequestContext } from '../../src/autonomous/scheduler.js'
import type { TurnOutcome, TurnRequest } from '../../src/autonomous/worker.js'
import { getTestDatabaseUrl } from '../support/database.js'

const CLAUDE: Account = { key: 'claude', client: 'claude', configDir: null, env: {} }
const CODEX: Account = { key: 'codex1', client: 'codex', configDir: '/h/.codex1', env: { CODEX_HOME: '/h/.codex1' } }
const REPLY: TurnOutcome = { kind: 'reply', text: 'q', sessionId: 's' }

describe('turn runner', () => {
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


  async function context(): Promise<TurnRequestContext> {
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
    return { task: result.task as AutonomousTask, lease, prompt: 'p', signal: new AbortController().signal, recordWorker: async () => true }
  }

  function memoryCooldowns(): CooldownStore & { cooling: Map<string, number> } {
    const cooling = new Map<string, number>()
    return {
      cooling,
      async cooldownUntil(key) {
        const until = cooling.get(key)
        return until !== undefined && until > Date.now() ? until : null
      },
      async coolDown(key, until) {
        cooling.set(key, until)
      },
    }
  }

  function deps(outcomes: ((request: TurnRequest) => TurnOutcome)[], overrides: Partial<TurnRunnerDeps> = {}) {
    const plans: SpawnPlanParams[] = []
    const requests: TurnRequest[] = []
    const d: TurnRunnerDeps = {
      pool,
      readAccounts: async () => [CLAUDE, CODEX],
      cooldowns: memoryCooldowns(),
      isCodexEligible: async () => true,
      turnTimeoutMs: 10_000,
      issueToken: () => 'token',
      revokeToken: () => undefined,
      async spawnPlan(params) {
        plans.push(params)
        return { bin: 'x', args: [], cwd: '/', env: {} }
      },
      async runTurn(request) {
        requests.push(request)
        const next = outcomes.shift()
        if (!next) throw new Error('no scripted outcome')
        return next(request)
      },
      ...overrides,
    }
    return { d, plans, requests }
  }

  async function runStates(taskId: string): Promise<string[]> {
    const { rows } = await pool.query<{ state: string }>(
      `SELECT r.state FROM runs r JOIN autonomous_tasks t ON t.session_id = r.session_id WHERE t.id = $1 ORDER BY r.created_at`,
      [taskId],
    )
    return rows.map((row) => row.state)
  }

  it('falls back from a usage-limited claude to codex, cools claude down, notes it, and records each turn as a run', async () => {
    const ctx = await context()
    const { d } = deps([() => ({ kind: 'account_blocked', reason: 'usage_limit', stderrTail: '' }), () => REPLY])

    const result = await runTurnOnPool(d, ctx)

    expect(result).toMatchObject({ kind: 'outcome', accountKey: 'codex1', notes: [expect.stringContaining('claude is blocked (usage limit)')] })
    expect(await d.cooldowns.cooldownUntil('claude')).not.toBeNull()
    expect(await runStates(ctx.task.id)).toEqual(['failed', 'succeeded'])
  })

  it("repeats the messages sent into a blocked attempt in the fallback account's prompt", async () => {
    const ctx = await context()
    let sent = ''
    const { d, plans } = deps([
      () => {
        sent = 'New messages in the thread:\n- also add a chart'
        return { kind: 'account_blocked', reason: 'usage_limit', stderrTail: '' }
      },
      () => REPLY,
    ])

    await runTurnOnPool(d, { ...ctx, prompt: 'build the report', sentSoFar: () => sent })

    expect(plans.map((plan) => plan.context.prompt)).toEqual(['build the report', 'build the report\n\nNew messages in the thread:\n- also add a chart'])
  })

  it('gives a fresh session the thread so far, and a resumed one only the new prompt', async () => {
    const ctx = await context()
    const fresh = { ...ctx, prompt: 'new', freshPrompt: async () => 'thread + new' }
    const { d, plans } = deps([() => REPLY, () => REPLY])

    await runTurnOnPool(d, fresh)
    await runTurnOnPool(d, { ...fresh, task: { ...fresh.task, engineSessionId: 'sess-1', accountKey: 'claude' } })

    expect(plans.map((plan) => [plan.resume, plan.context.prompt])).toEqual([[undefined, 'thread + new'], ['sess-1', 'new']])
  })

  it('resumes a taken-over chat on any Claude login sharing its projects folder, and points codex at its transcript', async () => {
    const ctx = await context()
    const taken = { ...ctx, prompt: 'new', freshPrompt: async () => 'transcript + thread + new', task: { ...ctx.task, chatSessionId: 'chat-1', chatCwd: '/p', engineSessionId: 'chat-1', accountKey: null } }
    const claude2: Account = { key: 'claude2', client: 'claude', configDir: '/h/.claude2', env: {} }
    const shared = async (account: Account) => (account.client === 'claude' ? '/h/.claude/projects' : null)
    const { d, plans } = deps([() => REPLY, () => REPLY], { readAccounts: async () => [claude2, CODEX], projectsDir: shared })

    await runTurnOnPool(d, taken)
    await runTurnOnPool(d, { ...taken, task: { ...taken.task, agentPreference: 'codex' } })

    expect(plans.map((plan) => [plan.account.key, plan.resume, plan.context.prompt])).toEqual([
      ['claude2', 'chat-1', 'new'],
      ['codex1', undefined, 'transcript + thread + new'],
    ])
  })

  it('goes back to the taken-over chat after a codex turn, with the thread, but never retries a rejected resume', async () => {
    const ctx = await context()
    const base = { ...ctx, prompt: 'new', freshPrompt: async () => 'thread + new' }
    const claude2: Account = { key: 'claude2', client: 'claude', configDir: '/h/.claude2', env: {} }
    const shared = async (account: Account) => (account.client === 'claude' ? '/h/.claude/projects' : null)
    // Codex, the owner, is unavailable, so Claude takes the next turn.
    const { d, plans } = deps([() => REPLY, () => REPLY], { readAccounts: async () => [claude2], projectsDir: shared })

    await runTurnOnPool(d, { ...base, task: { ...ctx.task, chatSessionId: 'chat-1', chatCwd: '/p', engineSessionId: 'codex-sess', accountKey: 'codex1' } })
    await runTurnOnPool(d, { ...base, task: { ...ctx.task, chatSessionId: 'chat-1', chatCwd: '/p', engineSessionId: null, accountKey: null } })

    expect(plans.map((plan) => [plan.resume, plan.context.prompt])).toEqual([['chat-1', 'thread + new'], [undefined, 'thread + new']])
  })

  it('closes the run when the spawn throws', async () => {
    const ctx = await context()
    const { d } = deps([], { spawnPlan: async () => { throw new Error('no settings file') } })
    await expect(runTurnOnPool(d, ctx)).rejects.toThrow('no settings file')
    expect(await runStates(ctx.task.id)).toEqual(['failed'])
  })
})
