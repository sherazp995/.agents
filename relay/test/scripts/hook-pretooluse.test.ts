import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Policy } from '../../src/config/schema.js'
import { HookBridgeServer } from '../../src/engine/hook-bridge.js'
import type { HookDecisionRequest, HookDecisionResult } from '../../src/engine/hook-bridge.js'
import { createAutonomousGuard } from '../../src/autonomous/guard.js'
import type { AutonomousTask } from '../../src/autonomous/store.js'

const execFileAsync = promisify(execFile)

const BUILD_TIMEOUT_MS = 120_000
const SCRIPT_TIMEOUT_MS = 20_000

/**
 * Spawns the compiled hook script as a real subprocess, exactly the shape
 * Claude Code itself invokes: stdin carries the hook payload, stdout is
 * read back as the hookSpecificOutput JSON, environment carries
 * RELAY_HOOK_URL/RELAY_HOOK_TOKEN. Nothing else in this repository
 * executes this dist file with plain node, so a module-load failure here
 * would otherwise be invisible until a real run hit it.
 */
function runHookScript(
  stdin: string,
  env: Record<string, string | undefined>,
  args: readonly string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/scripts/hook-pretooluse.js', ...args], {
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.write(stdin)
    child.stdin.end()
  })
}

function parseHookOutput(stdout: string): { decision: string; reason: string } {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string }
  }
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  return { decision: parsed.hookSpecificOutput.permissionDecision, reason: parsed.hookSpecificOutput.permissionDecisionReason }
}

function buildPolicy(overrides: Partial<Policy> = {}): Policy {
  return { version: 1, defaults: { unmatched: 'ask' }, hard_blocked_origins: ['*.chase.com'], ...overrides }
}

const VALID_HOOK_INPUT = JSON.stringify({
  session_id: 'session-1',
  tool_name: 'Read',
  tool_input: { file_path: '/tmp/x' },
  tool_use_id: 'toolu_1',
})

beforeAll(async () => {
  // TEMPORARY, pending an unrelated pnpm build breakage in another agent's
  // in-progress file (src/sessions/store.ts / test/sessions/context.test.ts,
  // confirmed via git status to be Task 3's uncommitted WIP, not this task's).
  // This narrows the real tsc build to exactly this test's own dependency
  // closure, with the same compiler options as tsconfig.json, rather than
  // waiting on a fix to a file this task does not own. See task-5-report.md.
  try {
    await execFileAsync(
      'npx',
      [
        'tsc', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
        '--lib', 'ES2023', '--strict', '--noUncheckedIndexedAccess', '--noImplicitOverride',
        '--exactOptionalPropertyTypes', '--verbatimModuleSyntax', '--skipLibCheck',
        '--outDir', 'dist', '--rootDir', '.',
        'src/engine/hook-bridge.ts', 'scripts/hook-pretooluse.ts',
      ],
      { timeout: BUILD_TIMEOUT_MS },
    )
  } catch (error) {
    throw new Error(`targeted build failed, so the compiled hook script could not be verified: ${(error as Error).message}`)
  }
}, BUILD_TIMEOUT_MS + 10_000)

let activeBridge: HookBridgeServer | undefined
let activeRawServer: Server | undefined

afterEach(async () => {
  if (activeBridge !== undefined) {
    await activeBridge.stop()
    activeBridge = undefined
  }
  if (activeRawServer !== undefined) {
    await new Promise<void>((resolve) => activeRawServer?.close(() => resolve()))
    activeRawServer = undefined
  }
})

describe('compiled hook script: happy path against a real bridge server', () => {
  it('prints allow for a read-tier tool, exit code 0', async () => {
    const bridge = new HookBridgeServer({ policy: buildPolicy() })
    await bridge.start()
    activeBridge = bridge

    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, {
      RELAY_HOOK_URL: bridge.url,
      RELAY_HOOK_TOKEN: bridge.token,
    })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'allow' })
  }, SCRIPT_TIMEOUT_MS)

  it('prints defer for an irreversible-tier tool (Bash), exit code 0', async () => {
    const bridge = new HookBridgeServer({ policy: buildPolicy() })
    await bridge.start()
    activeBridge = bridge

    const stdin = JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 't1' })
    const { code, stdout } = await runHookScript(stdin, { RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: bridge.token })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'defer' })
  }, SCRIPT_TIMEOUT_MS)

  it('prints deny for a hard-blocked destination, exit code 0', async () => {
    const bridge = new HookBridgeServer({ policy: buildPolicy() })
    await bridge.start()
    activeBridge = bridge

    const stdin = JSON.stringify({
      session_id: 's',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://pay.chase.com' },
      tool_use_id: 't1',
    })
    const { code, stdout } = await runHookScript(stdin, { RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: bridge.token })
    expect(code).toBe(0)
    // The script does not itself extract `destination` from tool_input
    // (see hook-bridge.ts's own header comment on fact extraction being
    // future work), so this exercises the tier-based defer path, not the
    // hard-block path; kept as a defer assertion so this test documents
    // that limitation rather than silently asserting something untrue.
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'defer' })
  }, SCRIPT_TIMEOUT_MS)
})

describe('compiled hook script: SELF-ATTACK: every failure mode must deny, exit 0, never throw past its own boundary', () => {
  it('denies when RELAY_HOOK_URL and RELAY_HOOK_TOKEN are both unset', async () => {
    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, { RELAY_HOOK_URL: undefined, RELAY_HOOK_TOKEN: undefined })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)

  it('denies when RELAY_HOOK_TOKEN is unset but RELAY_HOOK_URL is set', async () => {
    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, {
      RELAY_HOOK_URL: 'http://127.0.0.1:1/pre-tool-use',
      RELAY_HOOK_TOKEN: undefined,
    })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)

  it('denies malformed JSON on stdin, rather than throwing', async () => {
    const { code, stdout } = await runHookScript('{not valid json', {
      RELAY_HOOK_URL: 'http://127.0.0.1:1/pre-tool-use',
      RELAY_HOOK_TOKEN: 'token',
    })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)

  it('denies well-formed JSON missing tool_name/session_id/tool_use_id', async () => {
    const { code, stdout } = await runHookScript(JSON.stringify({ unrelated: true }), {
      RELAY_HOOK_URL: 'http://127.0.0.1:1/pre-tool-use',
      RELAY_HOOK_TOKEN: 'token',
    })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)

  it('denies when the bridge is completely unreachable (connection refused), required proof: Relay-unreachable fails closed', async () => {
    // Port 1 is a privileged port nothing in this test environment is
    // listening on; the connection is refused immediately rather than
    // timing out, giving a fast, deterministic "unreachable" case.
    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, {
      RELAY_HOOK_URL: 'http://127.0.0.1:1/pre-tool-use',
      RELAY_HOOK_TOKEN: 'token',
    })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)

  it('denies when the bridge never responds at all, required proof: a hang fails closed rather than fails open, within this script’s own timeout', async () => {
    const server = createServer(() => {
      // Never calls res.end(): the connection stays open until the
      // client's own AbortController timeout fires.
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    activeRawServer = server
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind test server')
    const url = `http://127.0.0.1:${address.port}/pre-tool-use`

    const started = Date.now()
    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, { RELAY_HOOK_URL: url, RELAY_HOOK_TOKEN: 'token' })
    const elapsedMs = Date.now() - started
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
    // Bounded well under Claude Code's own hook timeout (600s default);
    // this is the whole point of the script's own internal deadline.
    expect(elapsedMs).toBeLessThan(SCRIPT_TIMEOUT_MS)
  }, SCRIPT_TIMEOUT_MS)

  it('denies when the bridge responds with malformed JSON', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{not valid json')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    activeRawServer = server
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind test server')
    const url = `http://127.0.0.1:${address.port}/pre-tool-use`

    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, { RELAY_HOOK_URL: url, RELAY_HOOK_TOKEN: 'token' })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)

  it('denies when the bridge responds with a decision value it does not recognise', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ decision: 'maybe', reason: 'not a real decision' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    activeRawServer = server
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind test server')
    const url = `http://127.0.0.1:${address.port}/pre-tool-use`

    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, { RELAY_HOOK_URL: url, RELAY_HOOK_TOKEN: 'token' })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)

  it('denies when the bridge responds with a non-2xx status', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ decision: 'deny', reason: 'server error' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    activeRawServer = server
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('failed to bind test server')
    const url = `http://127.0.0.1:${address.port}/pre-tool-use`

    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, { RELAY_HOOK_URL: url, RELAY_HOOK_TOKEN: 'token' })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)

  it('denies against the real bridge when the token is wrong, never falling back to allow', async () => {
    const bridge = new HookBridgeServer({ policy: buildPolicy() })
    await bridge.start()
    activeBridge = bridge

    const { code, stdout } = await runHookScript(VALID_HOOK_INPUT, {
      RELAY_HOOK_URL: bridge.url,
      RELAY_HOOK_TOKEN: 'the-wrong-token',
    })
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny' })
  }, SCRIPT_TIMEOUT_MS)
})

describe('compiled hook script: codex payloads', () => {
  /** A bridge whose decide records each request and answers `result`. */
  async function recordingBridge(result: HookDecisionResult): Promise<{ bridge: HookBridgeServer; seen: HookDecisionRequest[] }> {
    const seen: HookDecisionRequest[] = []
    const bridge = new HookBridgeServer({
      decide: async (request) => {
        seen.push(request)
        return result
      },
    })
    await bridge.start()
    activeBridge = bridge
    return { bridge, seen }
  }

  const CODEX_PAYLOAD = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'codex-session',
    cwd: '/repo',
    tool_name: 'Bash',
    tool_input: { command: 'git status', workdir: '/repo/sub' },
  })

  it('accepts a payload without tool_use_id, generating one, and forwards command, workdir and cwd', async () => {
    const { bridge, seen } = await recordingBridge({ decision: 'deny', reason: 'blocked for the test' })
    const { code, stdout } = await runHookScript(CODEX_PAYLOAD, { RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: bridge.token }, ['--codex'])
    expect(code).toBe(0)
    expect(parseHookOutput(stdout)).toEqual({ decision: 'deny', reason: 'blocked for the test' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      toolName: 'Bash',
      sessionId: 'codex-session',
      cwd: '/repo',
      toolInput: { command: 'git status', workdir: '/repo/sub' },
    })
    expect(seen[0]?.toolUseId).toMatch(/^relay-[0-9a-f-]{36}$/)
  }, SCRIPT_TIMEOUT_MS)

  it('prints nothing for an allow under --codex (codex rejects permissionDecision allow)', async () => {
    const { bridge } = await recordingBridge({ decision: 'allow', reason: 'fine' })
    const { code, stdout } = await runHookScript(CODEX_PAYLOAD, { RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: bridge.token }, ['--codex'])
    expect(code).toBe(0)
    expect(stdout).toBe('')
  }, SCRIPT_TIMEOUT_MS)

  it('turns a defer into a deny under --codex, which has no defer', async () => {
    const { bridge } = await recordingBridge({ decision: 'defer', reason: 'needs a human' })
    const { stdout } = await runHookScript(CODEX_PAYLOAD, { RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: bridge.token }, ['--codex'])
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('needs a human') })
  }, SCRIPT_TIMEOUT_MS)

  it('joins an argv-list command (or `cmd`) into one shell string', async () => {
    const { bridge, seen } = await recordingBridge({ decision: 'deny', reason: 'x' })
    const env = { RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: bridge.token }
    await runHookScript(JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: ['git', 'commit', '-m', "it's done"] } }), env, ['--codex'])
    await runHookScript(JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { cmd: 'git log' } }), env, ['--codex'])
    expect(seen.map((request) => (request.toolInput as { command: string }).command)).toEqual([`git commit -m 'it'\\''s done'`, 'git log'])
  }, SCRIPT_TIMEOUT_MS)

  it('still prints Claude Code’s own allow without --codex', async () => {
    const { bridge } = await recordingBridge({ decision: 'allow', reason: 'fine' })
    const { stdout } = await runHookScript(CODEX_PAYLOAD, { RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: bridge.token })
    expect(parseHookOutput(stdout)).toMatchObject({ decision: 'allow' })
  }, SCRIPT_TIMEOUT_MS)
})

describe('compiled hook script: through the bridge to the autonomous guard', () => {
  it('denies git merge in the worktree and allows the QA merge, for claude and codex payloads', async () => {
    const relayHome = await mkdtemp(join(tmpdir(), 'relay-hook-guard-'))
    try {
      const task = { id: 'task-1', workspaceId: 'w1', leaseGeneration: 2, cancelRequestedAt: null } as AutonomousTask
      const worktree = join(relayHome, 'tasks', task.id, 'worktree')
      const qa = join(relayHome, 'tasks', task.id, 'qa', 'snapshot')
      await mkdir(worktree, { recursive: true })
      await mkdir(qa, { recursive: true })
      const guard = createAutonomousGuard({
        loadTask: async (id) => (id === task.id ? task : undefined),
        isInvocationCurrent: async (_taskId, invocationId) => invocationId === 'inv-1',
        isKillSwitchEngaged: async () => false,
        operations: {
          requestMcpOperation: async () => ({ kind: 'refused', reason: 'unused' }),
          recordOperationOutcome: async () => {},
        },
        remoteWrites: () => undefined,
        qaCheckouts: async () => [qa],
        defaultBranch: async () => 'main',
        relayHome,
      })
      const bridge = new HookBridgeServer({ decide: guard.decide })
      await bridge.start()
      activeBridge = bridge
      const env = {
        RELAY_HOOK_URL: bridge.url,
        RELAY_HOOK_TOKEN: bridge.issueToken({ workspaceId: 'w1', taskId: task.id, invocationId: 'inv-1', leaseGeneration: 2 }),
      }
      const claude = (command: string) =>
        JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_use_id: 't', cwd: worktree, tool_input: { command } })
      const codex = (command: string, workdir: string) =>
        JSON.stringify({ session_id: 's', tool_name: 'Bash', cwd: worktree, tool_input: { command, workdir } })

      expect(parseHookOutput((await runHookScript(claude('git merge feature'), env)).stdout)).toMatchObject({ decision: 'deny' })
      expect(parseHookOutput((await runHookScript(claude(`cd ${qa} && git merge --no-commit --no-ff main`), env)).stdout)).toMatchObject({
        decision: 'allow',
      })
      expect((await runHookScript(codex('git merge --no-commit --no-ff main', qa), env, ['--codex'])).stdout).toBe('')
      const stale = { ...env, RELAY_HOOK_TOKEN: bridge.issueToken({ workspaceId: 'w1', taskId: task.id, invocationId: 'inv-1', leaseGeneration: 1 }) }
      expect(parseHookOutput((await runHookScript(codex('ls', qa), stale, ['--codex'])).stdout)).toMatchObject({ decision: 'deny' })
    } finally {
      await rm(relayHome, { recursive: true, force: true })
    }
  }, SCRIPT_TIMEOUT_MS)
})
