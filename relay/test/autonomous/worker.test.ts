import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { processGroupAlive, spawnGated } from '../../src/process/gated-spawn.js'
import { buildClaudeArgs, buildCodexArgs, buildWorkerEnv, renderWorkerGitConfig, runWorkerTurn, type TurnRequest } from '../../src/autonomous/worker.js'
import { normalizeCliReply, parseWorkerReply } from '../../src/autonomous/reply.js'
import type { Account } from '../../src/autonomous/accounts.js'

const CLAUDE: Account = { key: 'claude', client: 'claude', configDir: null, env: {} }
const CODEX: Account = { key: 'codex1', client: 'codex', configDir: '/x/.codex1', env: { CODEX_HOME: '/x/.codex1' } }

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'relay-worker-'))
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const REPLY = { status: 'progress', text: 'working', remote_write: null, findings: null, plan: null }

function turn(overrides: Partial<TurnRequest> & Pick<TurnRequest, 'bin' | 'account'>): TurnRequest {
  return {
    args: [],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 10_000,
    recordWorker: async () => true,
    allowedMcpServers: ['playwright'],
    reservedUsd: 1,
    codexUsdPerMtok: 10,
    ...overrides,
  }
}

describe('gated spawn', () => {
  it('never runs the CLI when the gate is refused', async () => {
    const dir = tempDir()
    const marker = join(dir, 'ran')
    const bin = script(dir, 'cli', `touch ${marker}`)

    const child = spawnGated({ bin, args: [], cwd: dir, env: process.env, timeoutMs: 5000, beforeStart: async () => false })
    const result = await child.done

    expect(result.killed).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it('runs the CLI only after the pid is recorded, with an empty closed stdin', async () => {
    const dir = tempDir()
    const stdinCopy = join(dir, 'stdin')
    const bin = script(dir, 'cli', `cat > ${stdinCopy}; echo done`)
    const recorded: number[] = []

    const child = spawnGated({
      bin,
      args: [],
      cwd: dir,
      env: process.env,
      timeoutMs: 5000,
      beforeStart: async (pid) => {
        recorded.push(pid)
        return !existsSync(stdinCopy)
      },
    })
    const result = await child.done

    expect(recorded).toEqual([child.pid])
    expect(result.stdout.trim()).toBe('done')
    expect(readFileSync(stdinCopy, 'utf8')).toBe('')
  })

  it('kills a forked grandchild with the process group', async () => {
    const dir = tempDir()
    const pidFile = join(dir, 'grandchild')
    const bin = script(dir, 'cli', `sleep 300 & echo $! > ${pidFile}; wait`)

    const child = spawnGated({ bin, args: [], cwd: dir, env: process.env, timeoutMs: 20_000 })
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    child.kill()
    await child.done

    await waitFor(() => !processGroupAlive(child.pgid))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })
})

describe('worker arguments and env', () => {
  it('builds claude args per mode with strict MCP and the budget', () => {
    const args = buildClaudeArgs({ prompt: 'p', brief: 'b', schemaJson: '{}', mode: 'read_only', maxBudgetUsd: 2, settingsJson: '{}', mcpConfigPath: '/m.json' })
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--strict-mcp-config', '--max-budget-usd', '2.00']))
    expect(args).not.toContain('--resume')
    const resumed = buildClaudeArgs({ prompt: 'p', brief: 'b', schemaJson: '{}', mode: 'bypass', maxBudgetUsd: 2, settingsJson: '{}', mcpConfigPath: '/m.json', resume: 's1' })
    expect(resumed).toEqual(expect.arrayContaining(['bypassPermissions', '--resume', 's1']))
  })

  it('puts codex global options before resume', () => {
    const args = buildCodexArgs({ prompt: 'go', schemaPath: '/s.json', mode: 'bypass', overrides: ['a=1'], resume: 'th1' })
    expect(args.indexOf('--dangerously-bypass-approvals-and-sandbox')).toBeLessThan(args.indexOf('resume'))
    expect(args.indexOf('-c')).toBeLessThan(args.indexOf('resume'))
    expect(args.slice(-3)).toEqual(['resume', 'th1', 'go'])
    expect(buildCodexArgs({ prompt: 'go', schemaPath: '/s.json', mode: 'read_only', overrides: [] })).toEqual(
      expect.arrayContaining(['--sandbox', 'read-only']),
    )
  })

  it.skipIf(spawnSync('which', ['codex']).status !== 0)('the real codex CLI parses global options before resume', () => {
    const args = buildCodexArgs({ prompt: 'x', schemaPath: '/s.json', mode: 'read_only', overrides: [], resume: 'id' })
    const help = spawnSync('codex', [...args.slice(0, args.indexOf('resume')), 'resume', '--help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
  })

  it('carries no write credentials or SSH agent, and selects the account login', () => {
    const env = buildWorkerEnv({
      account: CODEX,
      gitConfigPath: '/r/worker.gitconfig',
      readOnlyGithubToken: 'ro-token',
      hookUrl: 'http://127.0.0.1:1/hook',
      hookToken: 'tok',
      base: { PATH: '/bin', SSH_AUTH_SOCK: '/tmp/agent', GITHUB_TOKEN: 'write', RELAY_SECRET_X: 'x', CLAUDE_CONFIG_DIR: '/other' },
    })
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.RELAY_SECRET_X).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env).toMatchObject({ GH_TOKEN: 'ro-token', CODEX_HOME: '/x/.codex1', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
  })

  it('makes git credential lookups fail without prompting or reaching the operator credential helper', () => {
    const dir = tempDir()
    const marker = join(dir, 'helper-called')
    const operatorHome = join(dir, 'home')
    execFileSync('mkdir', ['-p', operatorHome])
    writeFileSync(join(operatorHome, '.gitconfig'), `[credential]\n\thelper = "!f() { touch ${marker}; echo password=leaked; }; f"\n`)
    const workerConfig = join(dir, 'worker.gitconfig')
    writeFileSync(workerConfig, renderWorkerGitConfig({ name: 'Op', email: 'op@example.com' }))
    const env = buildWorkerEnv({
      account: CLAUDE,
      gitConfigPath: workerConfig,
      hookUrl: 'http://x',
      hookToken: 't',
      base: { PATH: process.env.PATH ?? '', HOME: operatorHome },
    })

    const result = spawnSync('git', ['credential', 'fill'], { env, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 5000 })

    expect(result.status).not.toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(result.stdout).not.toContain('leaked')
  })
})

describe('worker reply schema', () => {
  it('accepts a plan reply with its plan and refuses an implement plan with no test command', () => {
    const plan = { summary: 's', task_type: 'implement', change_kind: 'fix', visible: false, scope: 'x', acceptance_criteria: ['a'], test_command: 'pnpm test', repo: 'relay' }
    expect(parseWorkerReply({ ...REPLY, status: 'plan', plan }).ok).toBe(true)
    expect(parseWorkerReply({ ...REPLY, status: 'plan', plan: { ...plan, test_command: null } }).ok).toBe(false)
    expect(parseWorkerReply({ ...REPLY, status: 'plan' }).ok).toBe(false)
    expect(parseWorkerReply({ ...REPLY, plan }).ok).toBe(false)
  })

  it('rejects an unknown remote_write kind', () => {
    expect(parseWorkerReply({ ...REPLY, remote_write: { kind: 'force_push', branch: 'main' } }).ok).toBe(false)
    expect(parseWorkerReply({ ...REPLY, remote_write: { kind: 'push', branch: 'fix-1' } }).ok).toBe(true)
  })

  it('drops the CLI-level fields a kind does not take, empty strings included', () => {
    const write = { kind: 'push', branch: 'fix-1', base: '', head: '', title: '', body: '', pr: null, issue: null, event: '', method: '', path: '' }
    expect(parseWorkerReply(normalizeCliReply({ ...REPLY, remote_write: write }))).toMatchObject({ ok: true, reply: { remote_write: { kind: 'push', branch: 'fix-1' } } })
  })
})

describe('worker environment', () => {
  it('lets no MCP env value replace a safety variable', () => {
    const env = buildWorkerEnv({
      account: CLAUDE,
      gitConfigPath: '/relay/gitconfig',
      hookUrl: 'http://x',
      hookToken: 't',
      extraEnv: { GIT_CONFIG_GLOBAL: '/evil', RELAY_HOOK_TOKEN: 'forged', API_KEY: 'k' },
      base: {},
    })
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: '/relay/gitconfig', RELAY_HOOK_TOKEN: 't', API_KEY: 'k' })
  })

  it('quotes the git identity and refuses a line break in it', () => {
    expect(renderWorkerGitConfig({ name: 'A "B"', email: 'a@b' })).toContain('name = "A \\"B\\""')
    expect(() => renderWorkerGitConfig({ name: 'x\n[credential]\n\thelper = evil', email: 'a@b' })).toThrow('line break')
  })
})

describe('runWorkerTurn', () => {
  const claudeResult = (structured: unknown) =>
    `echo '${JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'playwright' }] })}'; ` +
    `echo '${JSON.stringify({ type: 'result', session_id: 's1', total_cost_usd: 0.4, result: '', structured_output: structured })}'`

  it('reads a claude reply and its cost', async () => {
    const bin = script(tempDir(), 'claude', claudeResult(REPLY))
    const outcome = await runWorkerTurn(turn({ bin, account: CLAUDE }))
    expect(outcome).toMatchObject({ kind: 'reply', sessionId: 's1', costUsd: 0.4, reply: { status: 'progress' } })
  })

  it('reports a reply that fails the schema', async () => {
    const bin = script(tempDir(), 'claude', claudeResult({ status: 'nope', text: '' }))
    expect((await runWorkerTurn(turn({ bin, account: CLAUDE }))).kind).toBe('schema_invalid')
  })

  it('ends the turn when the claude init event lists an unwrapped MCP server', async () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'playwright' }, { name: 'playwright-extension' }] })
    const bin = script(tempDir(), 'claude', `echo '${init}'; sleep 30`)
    expect(await runWorkerTurn(turn({ bin, account: CLAUDE }))).toEqual({ kind: 'mcp_violation', servers: ['playwright-extension'] })
  })

  it('classifies a usage-limit exit as a blocked account', async () => {
    const bin = script(tempDir(), 'claude', 'echo "Claude usage limit reached" >&2; exit 1')
    expect(await runWorkerTurn(turn({ bin, account: CLAUDE }))).toMatchObject({ kind: 'account_blocked', reason: 'usage_limit' })
  })

  it('kills codex once metered usage reaches the reservation', async () => {
    const usage = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200_000, output_tokens: 0 } })
    const bin = script(tempDir(), 'codex', `echo '{"type":"thread.started","thread_id":"t1"}'; echo '${usage}'; sleep 30`)
    expect(await runWorkerTurn(turn({ bin, account: CODEX, reservedUsd: 1, codexUsdPerMtok: 5 }))).toEqual({ kind: 'over_budget', costUsd: 1 })
  })

  it('reads a codex reply from its last agent message', async () => {
    const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(REPLY) } })
    const bin = script(tempDir(), 'codex', `echo '{"type":"thread.started","thread_id":"t1"}'; echo '${message}'`)
    expect(await runWorkerTurn(turn({ bin, account: CODEX }))).toMatchObject({ kind: 'reply', sessionId: 't1', costUsd: null })
  })

  it('reads a turn with its answer as a reply even when stderr mentions a limit', async () => {
    const bin = script(tempDir(), 'claude', `${claudeResult(REPLY)}; echo "test: rate limit 429 handled" >&2; exit 1`)
    expect((await runWorkerTurn(turn({ bin, account: CLAUDE }))).kind).toBe('reply')
  })

  it('fails closed when claude never reports its MCP servers', async () => {
    const result = JSON.stringify({ type: 'result', session_id: 's1', total_cost_usd: 0.1, result: '', structured_output: REPLY })
    const bin = script(tempDir(), 'claude', `echo '${result}'`)
    expect((await runWorkerTurn(turn({ bin, account: CLAUDE }))).kind).toBe('mcp_violation')
  })

  it('reports a turn killed after it started as stopped, not as never started', async () => {
    const controller = new AbortController()
    const bin = script(tempDir(), 'claude', 'sleep 30')
    const pending = runWorkerTurn(turn({ bin, account: CLAUDE, signal: controller.signal }))
    setTimeout(() => controller.abort(), 300)
    expect((await pending).kind).toBe('stopped')
  })

  it('does not start when the worker record is refused', async () => {
    const dir = tempDir()
    const marker = join(dir, 'ran')
    const bin = script(dir, 'claude', `touch ${marker}`)
    expect((await runWorkerTurn(turn({ bin, account: CLAUDE, recordWorker: async () => false }))).kind).toBe('not_started')
    expect(existsSync(marker)).toBe(false)
  })
})
