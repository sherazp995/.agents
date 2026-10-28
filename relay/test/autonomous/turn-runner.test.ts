import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import type { ChatAction } from '../../src/chat/contract.js'
import type { Account, CooldownStore } from '../../src/autonomous/accounts.js'
import { acquireLease, intakeMention, type AutonomousTask, type IntakeOutbox } from '../../src/autonomous/store.js'
import { runQaOnPool, runTurnOnPool, type SpawnPlanParams, type TurnRunnerDeps } from '../../src/autonomous/turn-runner.js'
import type { TurnRequestContext } from '../../src/autonomous/scheduler.js'
import type { TurnOutcome, TurnRequest } from '../../src/autonomous/worker.js'
import { getTestDatabaseUrl } from '../support/database.js'

const CLAUDE: Account = { key: 'claude', client: 'claude', configDir: null, env: {} }
const CODEX: Account = { key: 'codex1', client: 'codex', configDir: '/h/.codex1', env: { CODEX_HOME: '/h/.codex1' } }
const REPLY: TurnOutcome = { kind: 'reply', reply: { status: 'question', text: 'q' }, sessionId: 's', costUsd: 0.25 }

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

  const outbox: IntakeOutbox = {
    async enqueue(action: ChatAction, workspaceId: string, executor?: PoolClient) {
      await (executor ?? pool).query(`INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'test', $2, now())`, [workspaceId, action])
      return ''
    },
  }

  async function context(): Promise<TurnRequestContext> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'R', ['member'])
    const result = await intakeMention(pool, outbox, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
      event: { id: randomUUID(), principalId, text: 'x', ref: { channel: 'C1', message: '1.1' }, fileIds: [], receivedAt: '' },
      mentionRef: { channel: 'C1', message: '1.1' },
      replyRef: { channel: 'C1', thread: '1.1' },
      files: [],
    })
    if (result.kind !== 'created') throw new Error('no task')
    const lease = await acquireLease(pool, result.task.id, 'test', 60_000)
    if (!lease) throw new Error('no lease')
    return { task: result.task as AutonomousTask, lease, mode: 'read_only', prompt: 'p', signal: new AbortController().signal, recordWorker: async () => true }
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
    const d: TurnRunnerDeps & { lensAllowanceUsd: number } = {
      pool,
      readAccounts: async () => [CLAUDE, CODEX],
      cooldowns: memoryCooldowns(),
      isCodexEligible: async () => true,
      caps: async () => ({ runCapUsd: 5, sessionCapUsd: 20, principalDayCapUsd: 50 }),
      fallbackUsd: 1,
      codexUsdPerMtok: 10,
      turnTimeoutMs: 10_000,
      issueToken: () => 'token',
      revokeToken: () => undefined,
      async spawnPlan(params) {
        plans.push(params)
        return { bin: 'x', args: [], cwd: '/', env: {}, allowedMcpServers: [] }
      },
      async runTurn(request) {
        requests.push(request)
        const next = outcomes.shift()
        if (!next) throw new Error('no scripted outcome')
        return next(request)
      },
      lensAllowanceUsd: 2,
      ...overrides,
    }
    return { d, plans, requests }
  }

  async function charged(taskId: string): Promise<{ purpose: string; account_key: string; amount_usd: string; nested_allowance_usd: string }[]> {
    const { rows } = await pool.query(`SELECT purpose, account_key, amount_usd, nested_allowance_usd FROM autonomous_invocations WHERE task_id = $1 ORDER BY started_at`, [taskId])
    return rows
  }

  it('falls back from a usage-limited claude to codex, cools claude down, announces it, and charges each invocation once', async () => {
    const ctx = await context()
    const { d } = deps([() => ({ kind: 'account_blocked', reason: 'usage_limit', stderrTail: '' }), () => REPLY])

    const result = await runTurnOnPool(d, ctx)

    expect(result).toMatchObject({ kind: 'outcome', accountKey: 'codex1', notes: [expect.stringContaining('claude is blocked (usage limit)')] })
    expect(await d.cooldowns.cooldownUntil('claude')).not.toBeNull()
    expect((await charged(ctx.task.id)).map((row) => [row.account_key, Number(row.amount_usd)])).toEqual([['claude', 1], ['codex1', 0.25]])
  })

  it('gives a fresh session the thread so far, and a resumed one only the new prompt', async () => {
    const ctx = await context()
    const fresh = { ...ctx, prompt: 'new', freshPrompt: async () => 'thread + new' }
    const { d, plans } = deps([() => REPLY, () => REPLY])

    await runTurnOnPool(d, fresh)
    await runTurnOnPool(d, { ...fresh, task: { ...fresh.task, engineSessionId: 'sess-1', accountKey: 'claude' } })

    expect(plans.map((plan) => [plan.resume, plan.context.prompt])).toEqual([[undefined, 'thread + new'], ['sess-1', 'new']])
  })

  it('refuses a turn the budget cannot cover and names the scope', async () => {
    const ctx = await context()
    const { d, requests } = deps([], { caps: async () => ({ runCapUsd: 0.5, sessionCapUsd: 20, principalDayCapUsd: 50 }) })
    expect(await runTurnOnPool(d, ctx)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('run budget') })
    expect(requests).toHaveLength(0)
  })

  it('runs review on a claude account even when the worker is codex, with CODEX_HOME and the lens allowance charged once', async () => {
    const ctx = await context()
    const { d, plans } = deps([() => ({ kind: 'reply', reply: { status: 'done', text: '/ledger/record.md' }, sessionId: 's', costUsd: 0.5 })], { readAccounts: async () => [CODEX, CLAUDE] })

    expect(await runQaOnPool(d, ctx, { purpose: 'review', cwd: '/qa' })).toEqual({ kind: 'report', reportPath: '/ledger/record.md' })
    expect(plans[0]?.account.key).toBe('claude')
    expect(plans[0]?.qa).toMatchObject({ cwd: '/qa', extraEnv: { CODEX_HOME: '/h/.codex1' } })
    expect(await charged(ctx.task.id)).toEqual([{ purpose: 'review', account_key: 'claude', amount_usd: '2.5', nested_allowance_usd: '2' }].map((row) => expect.objectContaining({ ...row, amount_usd: expect.stringMatching(/^2\.50*$/), nested_allowance_usd: expect.stringMatching(/^2(\.0*)?$/) })))
  })

  it('refuses a QA report outside the QA checkout, ~/.agents and the temp folder', async () => {
    const ctx = await context()
    const { d } = deps([() => ({ kind: 'reply', reply: { status: 'done', text: '/etc/hosts' }, sessionId: 's', costUsd: 0.5 })])
    expect(await runQaOnPool(d, ctx, { purpose: 'video_qa', cwd: '/qa' })).toMatchObject({ kind: 'failed', reason: expect.stringContaining('outside the QA checkout') })
  })

  it('charges the fallback once and closes the run when the spawn throws', async () => {
    const ctx = await context()
    const { d } = deps([], { spawnPlan: async () => { throw new Error('no settings file') } })
    await expect(runTurnOnPool(d, ctx)).rejects.toThrow('no settings file')
    expect((await charged(ctx.task.id)).map((row) => Number(row.amount_usd))).toEqual([1])
    const { rows } = await pool.query<{ state: string }>(`SELECT r.state FROM runs r JOIN autonomous_invocations i ON i.run_id = r.id WHERE i.task_id = $1`, [ctx.task.id])
    expect(rows.map((row) => row.state)).toEqual(['failed'])
  })

  it('ends a lens invocation blocked when no codex account is eligible, before spawning', async () => {
    const ctx = await context()
    const { d, requests } = deps([], { isCodexEligible: async () => false })
    expect(await runQaOnPool(d, ctx, { purpose: 'visual_qa', cwd: '/qa' })).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('no eligible codex account') })
    expect(requests).toHaveLength(0)
    expect(await charged(ctx.task.id)).toEqual([])
  })
})
