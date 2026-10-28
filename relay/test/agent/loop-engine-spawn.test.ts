/**
 * Gate fix, High 3: proves runClaudeEngine (src/agent/loop.ts) sends the
 * prompt over stdin, never as an argv element, and spawns the claude binary
 * with only the allowlisted environment, never a bare inherited
 * `process.env`.
 *
 * This is a SEPARATE file from test/agent/loop.test.ts deliberately: it
 * mocks 'node:child_process' at module scope, and vi.mock is file scoped in
 * Vitest, so mocking it here cannot interfere with loop.test.ts's own LIVE
 * test, which needs the real module to spawn the real claude binary. No
 * fake or real engine call in this file ever reaches a real subprocess or
 * costs anything: the mocked spawn below returns a fake, in-memory child.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeStdin = {
  written: Buffer[]
  write: (chunk: string | Buffer) => boolean
  end: () => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
}

type SpawnCall = {
  file: string
  args: string[]
  options: Record<string, unknown>
  stdin: FakeStdin
}

const spawnCalls: SpawnCall[] = []

function makeFakeStdin(): FakeStdin {
  const written: Buffer[] = []
  return {
    written,
    write: (chunk) => {
      written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end: () => {},
    on: () => {},
  }
}

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        stdin: FakeStdin
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      const stdin = makeFakeStdin()
      child.stdin = stdin
      spawnCalls.push({ file, args, options, stdin })

      // Resolves runClaudeEngine's promise on the next microtask, well
      // after this function (and the synchronous stdin.write/end calls
      // that follow it in runClaudeEngine) has returned, matching a real
      // child process's own asynchrony.
      queueMicrotask(() => {
        const resultLine =
          JSON.stringify({
            type: 'result',
            session_id: 'fake-session',
            num_turns: 1,
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: {},
            permission_denials: [],
            result: '{"done":true}',
          }) + '\n'
        child.stdout.emit('data', Buffer.from(resultLine))
        child.emit('close', 0)
      })

      return child
    }),
  }
})

// Imported AFTER vi.mock: Vitest hoists the vi.mock call above every import
// in this file regardless of source order, but writing it this way keeps
// the dependency honest to read.
const { runClaudeEngine, DECISION_JSON_SCHEMA } = await import('../../src/agent/loop.js')

describe('runClaudeEngine: argv and environment (gate fix, High 3)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    spawnCalls.length = 0
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it('sends the prompt over stdin, never as an argv element the process table would expose', async () => {
    const secretLikePrompt = 'the prompt carries a pretend token sk-should-never-appear-in-argv'
    const controller = new AbortController()

    await runClaudeEngine({
      systemPrompt: 'a fixed, Relay-authored system prompt',
      prompt: secretLikePrompt,
      jsonSchema: DECISION_JSON_SCHEMA,
      signal: controller.signal,
    })

    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]
    if (!call) throw new Error('expected exactly one spawn call')

    // Never in argv, whole or in part.
    expect(call.args).not.toContain(secretLikePrompt)
    expect(call.args.join(' ')).not.toContain('sk-should-never-appear-in-argv')

    // stdio is writable on stdin (not 'ignore', the pre-fix default), and
    // the prompt was actually written to it, byte for byte.
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    const written = Buffer.concat(call.stdin.written).toString('utf8')
    expect(written).toBe(secretLikePrompt)
  })

  it('spawns with only the allowlisted environment variables, never a bare process.env', async () => {
    process.env.RELAY_TEST_SHOULD_NOT_LEAK = 'a value that must never reach the child'
    process.env.HOME = process.env.HOME ?? '/home/tester'
    const knownHome = process.env.HOME

    const controller = new AbortController()
    await runClaudeEngine({
      systemPrompt: 'sys',
      prompt: 'prompt',
      jsonSchema: DECISION_JSON_SCHEMA,
      signal: controller.signal,
    })

    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]
    if (!call) throw new Error('expected exactly one spawn call')

    const env = call.options.env as Record<string, string> | undefined
    expect(env).toBeDefined()
    expect(env?.RELAY_TEST_SHOULD_NOT_LEAK).toBeUndefined()
    expect(env?.HOME).toBe(knownHome)

    // Only allowlisted keys ever appear, whatever subset of them the real
    // process.env happens to carry in this environment.
    const ALLOWLIST = new Set(['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL'])
    for (const key of Object.keys(env ?? {})) {
      expect(ALLOWLIST.has(key)).toBe(true)
    }
  })
})
