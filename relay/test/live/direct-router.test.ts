import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { continueDirectSession, startDirectSession } from '../../src/live/direct-router.js'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'relay-direct-router-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function replied(sessionId = 'abc-123', text = 'hello') {
  return {
    runClaude: async () => ({
      stdout: JSON.stringify({ type: 'result', session_id: sessionId, result: text, total_cost_usd: 0.01 }),
      stderr: '',
      code: 0,
      timedOut: false,
    }),
  }
}

describe('starting a direct session', () => {
  it('uses the default directory when the command names none', async () => {
    const outcome = await startDirectSession({ text: '', defaultDirectory: workspace }, replied())

    expect(outcome.outcome).toBe('started')
    if (outcome.outcome !== 'started') return
    expect(outcome.cwd).toBe(workspace)
    expect(outcome.text).toContain('abc-123')
  })

  it('uses a directory the operator named', async () => {
    const outcome = await startDirectSession({ text: `${workspace} look at the tests`, defaultDirectory: '/elsewhere' }, replied())

    expect(outcome.outcome).toBe('started')
    if (outcome.outcome !== 'started') return
    expect(outcome.cwd).toBe(workspace)
  })

  it('REFUSES a directory that does not exist, before spawning anything', async () => {
    // A session started in the wrong place looks identical to one started in
    // the right place until you ask it to read a file, and by then it has a
    // transcript of its own somewhere nobody meant to use.
    let spawned = false
    const outcome = await startDirectSession(
      { text: '/no/such/dir', defaultDirectory: workspace },
      {
        runClaude: async () => {
          spawned = true
          return { stdout: '', stderr: '', code: 0, timedOut: false }
        },
      },
    )

    expect(outcome.outcome).toBe('refused')
    expect(spawned).toBe(false)
  })

  it('refuses a path that is a file rather than a directory', async () => {
    const file = join(workspace, 'a-file.txt')
    writeFileSync(file, 'x')

    expect((await startDirectSession({ text: file, defaultDirectory: workspace }, replied())).outcome).toBe('refused')
  })

  it('returns the reply only when the operator actually asked something', async () => {
    // An invented first turn would put words in their mouth in a transcript
    // they can read later.
    const withMessage = await startDirectSession({ text: `${workspace} check the logs`, defaultDirectory: workspace }, replied('abc-123', 'Checked.'))
    const bare = await startDirectSession({ text: '', defaultDirectory: workspace }, replied('abc-123', 'Hello.'))

    expect(withMessage.outcome === 'started' && withMessage.reply).toBe('Checked.')
    expect(bare.outcome === 'started' && bare.reply).toBeUndefined()
  })

  it('reports a failure to start with the reason', async () => {
    const outcome = await startDirectSession(
      { text: '', defaultDirectory: workspace },
      { runClaude: async () => ({ stdout: '', stderr: 'boom', code: 1, timedOut: false }) },
    )

    expect(outcome.outcome).toBe('refused')
    expect(outcome.text).toContain('boom')
  })
})

describe('continuing a direct session', () => {
  it('returns the reply', async () => {
    const result = await continueDirectSession(workspace, 'abc-123', 'and now?', replied('abc-123', 'Done.'))

    expect(result.text).toBe('Done.')
  })

  it('passes the resume rejection through as the answer, since it says what to fix', async () => {
    const result = await continueDirectSession(workspace, 'abc-123', 'hi', {
      runClaude: async () => ({ stdout: '', stderr: 'No conversation found with session ID: abc-123', code: 1, timedOut: false }),
    })

    expect(result.text).toContain('wrong directory')
  })
})

describe('a path that cannot be stat-ed is refused, not thrown on', () => {
  it('refuses a dangling symlink rather than taking the command down', async () => {
    // statSync throws on a dangling symlink and on a path whose parent is
    // unreadable, and an unhandled throw would kill the command rather than
    // answer it.
    const { symlinkSync } = await import('node:fs')
    const dangling = join(workspace, 'dangling')
    symlinkSync(join(workspace, 'nothing-here'), dangling)

    const outcome = await startDirectSession({ text: dangling, defaultDirectory: workspace }, replied())

    expect(outcome.outcome).toBe('refused')
    expect(outcome.text).toContain('not a directory Relay can use')
  })
})
