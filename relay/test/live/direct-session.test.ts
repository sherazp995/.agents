import { describe, expect, it } from 'vitest'

import {
  buildDirectArgs,
  engineChildEnv,
  parseFinalResult,
  readsAsResumeRejection,
  renderSessionStarted,
  runDirectTurn,
} from '../../src/live/direct-session.js'

/**
 * The point of this module is that the session is INDISTINGUISHABLE from one
 * the operator started themselves, so most of these tests are about what is
 * deliberately absent from the invocation.
 */

function reply(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'result',
    session_id: 'abc-123',
    result: 'Done. I added the endpoint.',
    total_cost_usd: 0.04,
    ...overrides,
  })
}

describe('the invocation is a plain session, not Relay wearing its clothes', () => {
  it('passes NO system prompt, json schema or tool allowlist', () => {
    // Any one of those would change what the session is, and the whole
    // reason for this path is that the directory's CLAUDE.md, skills,
    // agents and settings apply unchanged.
    const args = buildDirectArgs({ cwd: '/work', message: 'hello' })

    expect(args.join(' ')).not.toContain('--system-prompt')
    expect(args.join(' ')).not.toContain('--json-schema')
    expect(args.join(' ')).not.toContain('--allowedTools')
  })

  it('uses stream-json with --verbose, which the CLI requires', () => {
    expect(buildDirectArgs({ cwd: '/work', message: 'hi' })).toEqual(
      expect.arrayContaining(['--output-format', 'stream-json', '--verbose']),
    )
  })

  it('omits --resume when starting a new session, and includes it when continuing', () => {
    expect(buildDirectArgs({ cwd: '/w', message: 'hi' }).join(' ')).not.toContain('--resume')
    expect(buildDirectArgs({ cwd: '/w', message: 'hi', resume: 'abc-123' }).join(' ')).toContain('--resume abc-123')
  })
})

describe('parsing the result', () => {
  it('reads the LAST result event, not the first line', () => {
    // The stream carries init, assistant and tool events first, and a
    // caller taking the first would get an init event with no result in it.
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }),
      JSON.stringify({ type: 'assistant', message: {} }),
      reply(),
    ].join('\n')

    const parsed = parseFinalResult(stdout)

    expect(parsed?.sessionId).toBe('abc-123')
    expect(parsed?.text).toBe('Done. I added the endpoint.')
  })

  it('survives non-JSON diagnostics interleaved in the stream', () => {
    expect(parseFinalResult(`some warning text\n${reply()}`)?.sessionId).toBe('abc-123')
  })

  it('returns undefined when there is no result event at all', () => {
    expect(parseFinalResult('nothing useful here')).toBeUndefined()
  })
})

describe('a rejected resume is told apart from a crash', () => {
  it('recognises the CLI\'s own wording', () => {
    expect(readsAsResumeRejection('', 'No conversation found with session ID: abc-123')).toBe(true)
    expect(readsAsResumeRejection('', 'some other failure')).toBe(false)
  })

  it('blames the DIRECTORY, which is almost always the actual cause', async () => {
    // A session id only means anything alongside the working directory whose
    // transcript holds it.
    const turn = await runDirectTurn(
      { cwd: '/wrong/place', message: 'hi', resume: 'abc-123' },
      { runClaude: async () => ({ stdout: '', stderr: 'No conversation found with session ID: abc-123', code: 1, timedOut: false }) },
    )

    expect(turn.outcome).toBe('resume_rejected')
    if (turn.outcome !== 'resume_rejected') return
    expect(turn.reason).toContain('wrong directory')
  })
})

describe('running a turn', () => {
  it('returns the session id and the reply', async () => {
    const turn = await runDirectTurn(
      { cwd: '/work', message: 'add an endpoint' },
      { runClaude: async () => ({ stdout: reply(), stderr: '', code: 0, timedOut: false }) },
    )

    expect(turn.outcome).toBe('replied')
    if (turn.outcome !== 'replied') return
    expect(turn.sessionId).toBe('abc-123')
    expect(turn.text).toContain('added the endpoint')
  })

  it('reports a timeout as recoverable, since the session still exists', async () => {
    const turn = await runDirectTurn(
      { cwd: '/work', message: 'hi' },
      { runClaude: async () => ({ stdout: '', stderr: '', code: null, timedOut: true }) },
    )

    expect(turn.outcome).toBe('failed')
    if (turn.outcome !== 'failed') return
    expect(turn.reason).toContain('send another message to carry on')
  })

  it('reports a crash with what the CLI said', async () => {
    const turn = await runDirectTurn(
      { cwd: '/work', message: 'hi' },
      { runClaude: async () => ({ stdout: '', stderr: 'boom', code: 2, timedOut: false }) },
    )

    expect(turn.outcome).toBe('failed')
    if (turn.outcome !== 'failed') return
    expect(turn.reason).toContain('boom')
  })
})

describe('what Slack is told when a session starts', () => {
  it('gives the id AND the directory, since either alone is useless', () => {
    const message = renderSessionStarted('abc-123', '/Users/op/code/thing')

    expect(message).toContain('abc-123')
    expect(message).toContain('/Users/op/code/thing')
  })

  it('spells out the resume command, so the chat can move to a keyboard', () => {
    // This is the property that makes Claude Code rather than Relay the
    // system of record.
    expect(renderSessionStarted('abc-123', '/w')).toContain('cd /w && claude --resume abc-123')
  })

  it('says the session is UNMEDIATED, at the moment the operator will read it', () => {
    // FR-ATT-30: a governed thread and an unmediated one must not look
    // identical in Slack.
    const message = renderSessionStarted('abc-123', '/w')

    expect(message).toContain('outside Relay\'s sandbox')
    expect(message).toContain('approvals')
  })
})

describe('the child environment', () => {
  it('keeps the operator\'s own variables, so MCP servers and tools still work', () => {
    // An allowlist like the governed path's would silently give this session
    // fewer tools than the same command at a keyboard, which is worse than
    // no session at all.
    const env = engineChildEnv({ PATH: '/usr/bin', HOME: '/Users/op', MY_MCP_TOKEN: 'keep-me' })

    expect(env.PATH).toBe('/usr/bin')
    expect(env.MY_MCP_TOKEN).toBe('keep-me')
  })

  it('STRIPS Relay\'s own brokered secrets, which the session has no need for', () => {
    // Nothing about relaying a message to a session requires handing it
    // Relay's Slack token.
    const env = engineChildEnv({ RELAY_SECRET_RELAY_SLACK_BOT_TOKEN: 'xoxb-nope', PATH: '/usr/bin' })

    expect(env.RELAY_SECRET_RELAY_SLACK_BOT_TOKEN).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })
})
