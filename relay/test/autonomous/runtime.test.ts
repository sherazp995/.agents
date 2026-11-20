import { describe, expect, it } from 'vitest'
import type { Account } from '../../src/autonomous/accounts.js'
import { WORKER_BRIEF } from '../../src/autonomous/prompt.js'
import { buildSpawnPlan, planTurnWithEnv, withTeamStop } from '../../src/autonomous/runtime.js'
import type { SessionEnvOutcome } from '../../src/worker-env/sessions.js'
import type { AutonomousTask } from '../../src/autonomous/store.js'
import { taskSubject, type SpawnPlanParams, type TurnSubject } from '../../src/autonomous/turn-runner.js'
import { buildClaudeSettings, buildCodexHookOverrides } from '../../src/autonomous/worker-config.js'

const CLAUDE: Account = { key: 'claude', client: 'claude', configDir: null, env: {} }
const CODEX: Account = { key: 'codex', client: 'codex', configDir: null, env: {} }
const SETUP = { claudeBin: '/bin/claude', codexBin: '/bin/codex', hookCommand: 'hook', hookUrl: 'http://127.0.0.1:1' }

const task = { id: 't', chatCwd: '/work/web', engineSessionId: 's1', accountKey: 'claude', chatSessionId: null, agentPreference: null } as unknown as AutonomousTask

function params(account: Account, subject = taskSubject(task)): SpawnPlanParams {
  return { context: { task, lease: { taskId: 't', owner: 'o', generation: 1 }, prompt: 'hello', signal: new AbortController().signal, recordWorker: async () => true }, subject, account, hookToken: 'tok', resume: 's1' }
}

describe('the spawn plan', () => {
  it("gives a task's own subject exactly today's arguments, folder and brief", () => {
    const claude = buildSpawnPlan(SETUP, params(CLAUDE))
    expect(claude.cwd).toBe('/work/web')
    expect(claude.args).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', WORKER_BRIEF, '--permission-mode', 'bypassPermissions',
      '--settings', buildClaudeSettings({ hookCommand: 'hook' }), '--resume', 's1',
    ])
    const codex = buildSpawnPlan(SETUP, params(CODEX))
    expect(codex.args).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      ...buildCodexHookOverrides({ hookCommand: 'hook' }).flatMap((override) => ['-c', override]),
      'resume', 's1', `${WORKER_BRIEF}\n\nhello`,
    ])
  })

  it('asks Claude to echo each message it reads only for a turn that takes messages mid-turn', () => {
    const plain = params(CLAUDE)
    expect(buildSpawnPlan(SETUP, plain).args).not.toContain('--replay-user-messages')
    expect(buildSpawnPlan(SETUP, { ...plain, context: { ...plain.context, inbox: { send: null } } }).args).toContain('--replay-user-messages')
  })

  it("starts a member in its worktree with its brief, its model and no MCP servers", () => {
    const member = { ...taskSubject(task), cwd: '/wt/a1', brief: 'You are Theo.', model: 'opus', noMcp: true }
    const claude = buildSpawnPlan(SETUP, params(CLAUDE, member))
    expect(claude.cwd).toBe('/wt/a1')
    expect(claude.args).toEqual(expect.arrayContaining(['--append-system-prompt', 'You are Theo.', '--model', 'opus', '--strict-mcp-config']))
    expect(claude.args).not.toContain(WORKER_BRIEF)
    const codex = buildSpawnPlan(SETUP, params(CODEX, member))
    expect(codex.args).toEqual(expect.arrayContaining(['-c', 'mcp_servers={}', '-m', 'opus']))
    expect(codex.args.at(-1)).toBe('You are Theo.\n\nhello')
  })
})

describe("the spawn plan and the session's envs", () => {
  const ENV = { PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'stored-token-456', DATABASE_URL: 'postgres://app' }

  function fakeEnvs(outcome: SessionEnvOutcome = { kind: 'ready', env: ENV }) {
    const calls: { taskId: string; cwd: string; track: boolean }[] = []
    const forgotten: string[] = []
    return {
      calls,
      forgotten,
      forSession: async (call: { taskId: string; threadRef: string; cwd: string; track: boolean }) => (calls.push({ taskId: call.taskId, cwd: call.cwd, track: call.track }), outcome),
      forget: (taskId: string) => void forgotten.push(taskId),
    }
  }

  it("gives the thread's own worker its resolved envs, on Claude and on Codex, in its environment and never its arguments, and keeps it for the change check", async () => {
    for (const account of [CLAUDE, CODEX]) {
      const envs = fakeEnvs()
      const plan = await planTurnWithEnv(SETUP, envs, 'C1:1.1', params(account))
      if ('kind' in plan) throw new Error('expected a plan')
      expect(plan.env).toMatchObject(ENV)
      expect(plan.args.join(' ')).not.toContain('stored-token-456')
      expect(envs.calls).toEqual([{ taskId: 't', cwd: '/work/web', track: true }])
    }
  })

  it("gives a team member the envs of its worktree without keeping it for the thread's change check", async () => {
    const member = { ...taskSubject(task), cwd: '/wt/a1', brief: 'You are Theo.', model: null, noMcp: true, assignment: { id: 'a1', leaseGeneration: 1 } }
    const envs = fakeEnvs()
    const plan = await planTurnWithEnv(SETUP, envs, 'C1:1.1', params(CLAUDE, member))
    if ('kind' in plan) throw new Error('expected a plan')
    expect(plan.env.DATABASE_URL).toBe('postgres://app')
    expect(envs.calls).toEqual([{ taskId: 't', cwd: '/wt/a1', track: false }])
  })

  it('refuses the turn when a stored env cannot be read', async () => {
    const plan = await planTurnWithEnv(SETUP, fakeEnvs({ kind: 'unreadable', reason: 'cannot read TOKEN' }), 'C1:1.1', params(CLAUDE))
    expect(plan).toEqual({ kind: 'env_unreadable', reason: 'cannot read TOKEN' })
  })
})

describe("Stop's cleanup", () => {
  it("stops the task's team members before the rest of the cleanup", async () => {
    const calls: string[] = []
    const cleanup = withTeamStop({ stopTask: async (taskId) => void calls.push(`team:${taskId}`) }, async (stopped) => void calls.push(`ops:${stopped.id}`))
    await cleanup(task)
    expect(calls).toEqual(['team:t', 'ops:t'])
  })
})

describe("the spawn plan for a reminder's read-only task", () => {
  const readOnly = { ...task, readOnly: true } as AutonomousTask
  const readOnlyParams = (account: Account, subject: TurnSubject = { ...taskSubject(readOnly), client: 'claude', noMcp: true }): SpawnPlanParams => ({
    ...params(account, subject),
    context: { ...params(account).context, task: readOnly },
  })

  it('runs Claude with no MCP servers and the hook on every tool, not only Bash', () => {
    const plan = buildSpawnPlan(SETUP, readOnlyParams(CLAUDE))
    expect(plan.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--settings', buildClaudeSettings({ hookCommand: 'hook', allTools: true })]))
    expect(JSON.parse(buildClaudeSettings({ hookCommand: 'hook', allTools: true })).hooks.PreToolUse[0].matcher).toBe('*')
    expect(JSON.parse(buildClaudeSettings({ hookCommand: 'hook' })).hooks.PreToolUse[0].matcher).toBe('Bash')
  })

  it('gives it no stored or description envs, without resolving any', async () => {
    const resolved: string[] = []
    const envs = { forSession: async () => (resolved.push('x'), { kind: 'ready' as const, env: { TOKEN: 'stored-token-456' } }), forget: () => undefined }
    const plan = await planTurnWithEnv(SETUP, envs, 'C1:1.1', readOnlyParams(CLAUDE))
    if ('kind' in plan) throw new Error('expected a plan')
    expect(plan.env.TOKEN).toBeUndefined()
    expect(resolved).toEqual([])
    expect(buildSpawnPlan(SETUP, readOnlyParams(CLAUDE), { TOKEN: 'stored-token-456' }).env.TOKEN).toBeUndefined()
  })

  it('refuses a plan on Codex or with MCP servers', () => {
    expect(() => buildSpawnPlan(SETUP, readOnlyParams(CODEX))).toThrow('read-only')
    expect(() => buildSpawnPlan(SETUP, readOnlyParams(CLAUDE, taskSubject(readOnly)))).toThrow('read-only')
  })
})
