import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { processGroupAlive, spawnGated } from '../../src/process/gated-spawn.js'
import { buildClaudeArgs, buildCodexArgs, buildWorkerEnv, claudeUserLine, runWorkerTurn, type TurnInbox, type TurnRequest } from '../../src/autonomous/worker.js'
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

function turn(overrides: Partial<TurnRequest> & Pick<TurnRequest, 'bin' | 'account'>): TurnRequest {
  return {
    args: [],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 10_000,
    recordWorker: async () => true,
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

  it('keeps stdin open after the gate for input, and closes it on endInput', async () => {
    const dir = tempDir()
    const stdinCopy = join(dir, 'stdin')
    const bin = script(dir, 'cli', `cat > ${stdinCopy}; echo done`)

    const child = spawnGated({ bin, args: [], cwd: dir, env: process.env, timeoutMs: 5000, input: 'first\n' })
    await waitFor(() => child.write('second\n'))
    child.endInput()
    const result = await child.done

    expect(result.stdout.trim()).toBe('done')
    expect(readFileSync(stdinCopy, 'utf8')).toBe('first\nsecond\n')
    expect(child.write('late\n')).toBe(false)
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
  it('runs claude as a regular chat in bypass mode with the hook settings', () => {
    const args = buildClaudeArgs({ brief: 'b', settingsJson: '{"hooks":{}}' })
    expect(args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--permission-mode', 'bypassPermissions', '--settings', '{"hooks":{}}', '--append-system-prompt', 'b']))
    for (const flag of ['--resume', '--json-schema', '--max-budget-usd', '--mcp-config', '--strict-mcp-config']) expect(args).not.toContain(flag)
    expect(buildClaudeArgs({ brief: 'b', settingsJson: '{}', resume: 's1' }).slice(-2)).toEqual(['--resume', 's1'])
  })

  it('puts codex global options before resume', () => {
    const args = buildCodexArgs({ prompt: 'go', overrides: ['a=1'], resume: 'th1' })
    expect(args.indexOf('--dangerously-bypass-approvals-and-sandbox')).toBeLessThan(args.indexOf('resume'))
    expect(args.indexOf('-c')).toBeLessThan(args.indexOf('resume'))
    expect(args.slice(-3)).toEqual(['resume', 'th1', 'go'])
    expect(args).not.toContain('--output-schema')
  })

  it.skipIf(spawnSync('which', ['codex']).status !== 0)('the real codex CLI parses global options before resume', () => {
    const args = buildCodexArgs({ prompt: 'x', overrides: [], resume: 'id' })
    const help = spawnSync('codex', [...args.slice(0, args.indexOf('resume')), 'resume', '--help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
  })

  it("keeps the operator's own environment, drops relay's secrets, selects the account login and adds the hook", () => {
    const env = buildWorkerEnv({
      account: CODEX,
      hookUrl: 'http://127.0.0.1:1/hook',
      hookToken: 'tok',
      base: { PATH: '/bin', SSH_AUTH_SOCK: '/tmp/agent', RELAY_SECRET_X: 'x', CLAUDE_CONFIG_DIR: '/other' },
    })
    expect(env.RELAY_SECRET_X).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/bin', SSH_AUTH_SOCK: '/tmp/agent', CODEX_HOME: '/x/.codex1', RELAY_HOOK_URL: 'http://127.0.0.1:1/hook', RELAY_HOOK_TOKEN: 'tok' })
  })
})

describe('runWorkerTurn', () => {
  const claudeResult = (text: string) => `echo '${JSON.stringify({ type: 'result', session_id: 's1', total_cost_usd: 0.4, result: text })}'`

  it("reads a claude reply as the chat's final text", async () => {
    const bin = script(tempDir(), 'claude', claudeResult('All *done*.'))
    expect(await runWorkerTurn(turn({ bin, account: CLAUDE }))).toEqual({ kind: 'reply', text: 'All *done*.', sessionId: 's1' })
  })

  it('sends the prompt and a mid-turn message on stdin, and closes it at the result', async () => {
    const dir = tempDir()
    const [first, second, after] = ['first', 'second', 'after'].map((name) => join(dir, name)) as [string, string, string]
    const bin = script(dir, 'claude', `read -r a; printf '%s' "$a" > ${first}; read -r b; printf '%s' "$b" > ${second}; ${claudeResult('both')}; if read -r c; then echo open > ${after}; else echo closed > ${after}; fi`)
    const inbox: TurnInbox = { send: null }

    const pending = runWorkerTurn(turn({ bin, account: CLAUDE, input: claudeUserLine('hello'), inbox }))
    await waitFor(() => existsSync(first))
    expect(inbox.send?.('one more')).toBe(true)

    expect(await pending).toEqual({ kind: 'reply', text: 'both', sessionId: 's1' })
    expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual({ type: 'user', message: { role: 'user', content: 'hello' } })
    expect(JSON.parse(readFileSync(second, 'utf8')).message.content).toBe('one more')
    expect(readFileSync(after, 'utf8').trim()).toBe('closed')
    expect(inbox.send).toBeNull()
  })

  it('joins the texts when a message in the pipe started a second result', async () => {
    const bin = script(tempDir(), 'claude', `read -r a; ${claudeResult('first answer')}; ${claudeResult('second answer')}`)
    expect(await runWorkerTurn(turn({ bin, account: CLAUDE, input: claudeUserLine('hi') }))).toEqual({ kind: 'reply', text: 'first answer\n\nsecond answer', sessionId: 's1' })
  })

  it('classifies a usage-limit exit as a blocked account', async () => {
    const bin = script(tempDir(), 'claude', 'echo "Claude usage limit reached" >&2; exit 1')
    expect(await runWorkerTurn(turn({ bin, account: CLAUDE }))).toMatchObject({ kind: 'account_blocked', reason: 'usage_limit' })
  })

  it('reads a codex reply from its last agent message', async () => {
    const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi there' } })
    const bin = script(tempDir(), 'codex', `echo '{"type":"thread.started","thread_id":"t1"}'; echo '${message}'; echo '{"type":"turn.completed"}'`)
    expect(await runWorkerTurn(turn({ bin, account: CODEX }))).toEqual({ kind: 'reply', text: 'hi there', sessionId: 't1' })
  })

  it('fails a codex turn that failed after a message, and a claude error result', async () => {
    const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'half done' } })
    const failed = JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } })
    const codex = script(tempDir(), 'codex', `echo '{"type":"thread.started","thread_id":"t1"}'; echo '${message}'; echo '${failed}'; exit 1`)
    expect(await runWorkerTurn(turn({ bin: codex, account: CODEX }))).toMatchObject({ kind: 'failed', reason: 'stream disconnected' })
    const claude = script(tempDir(), 'claude', `echo '${JSON.stringify({ type: 'result', session_id: 's1', is_error: true, result: 'Claude usage limit reached' })}'; exit 1`)
    expect(await runWorkerTurn(turn({ bin: claude, account: CLAUDE }))).toMatchObject({ kind: 'account_blocked', reason: 'usage_limit' })
  })

  it('reads a turn with its answer as a reply even when stderr mentions a limit', async () => {
    const bin = script(tempDir(), 'claude', `${claudeResult('ok')}; echo "test: rate limit 429 handled" >&2; exit 1`)
    expect((await runWorkerTurn(turn({ bin, account: CLAUDE }))).kind).toBe('reply')
  })

  it('fails a claude turn that ends with no result', async () => {
    const bin = script(tempDir(), 'claude', 'exit 0')
    expect((await runWorkerTurn(turn({ bin, account: CLAUDE }))).kind).toBe('failed')
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
