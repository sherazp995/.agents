import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { listEngineSessions } from '../../src/sessions/discovery.js'

const roots: string[] = []

afterEach(() => {
  roots.length = 0
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'relay-sessions-'))
  roots.push(root)
  return root
}

/** Writes a transcript in the shape Claude Code actually produces, verified against real files on this machine. */
async function writeTranscript(
  root: string,
  dirName: string,
  sessionId: string,
  records: readonly unknown[],
  mtime?: Date,
): Promise<string> {
  const dir = join(root, dirName)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  if (mtime !== undefined) await utimes(path, mtime, mtime)
  return path
}

function userRecord(text: string): unknown {
  return { type: 'user', cwd: '/Users/someone/project', message: { role: 'user', content: text } }
}

describe('listEngineSessions', () => {
  it('reads the working directory from the transcript rather than the directory name', async () => {
    const root = await makeRoot()
    // The real encoding is lossy: `/Users/hassan/.projects/relay` becomes
    // `-Users-hassan--projects-relay`, so a separator and a dot collapse to
    // the same character. Decoding the name cannot recover the original, and
    // this test pins that the name is not what is trusted.
    await writeTranscript(root, '-Users-hassan--projects-relay', 'aaaa-1111', [
      { type: 'user', cwd: '/Users/hassan/.projects/relay', message: { role: 'user', content: 'first message' } },
    ])

    const sessions = await listEngineSessions({ root })

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.cwd).toBe('/Users/hassan/.projects/relay')
  })

  it('orders sessions most recently written first', async () => {
    const root = await makeRoot()
    await writeTranscript(root, 'proj', 'older', [userRecord('older')], new Date('2026-08-01T00:00:00Z'))
    await writeTranscript(root, 'proj', 'newer', [userRecord('newer')], new Date('2026-08-09T00:00:00Z'))

    const sessions = await listEngineSessions({ root })

    expect(sessions.map((session) => session.sessionId)).toEqual(['newer', 'older'])
  })

  it('takes the session id from the file name, which is what --resume consumes', async () => {
    const root = await makeRoot()
    await writeTranscript(root, 'proj', 'd44ef152-6aac-4f65-ba56-6ff73c2eb20b', [userRecord('hello')])

    const sessions = await listEngineSessions({ root })

    expect(sessions[0]?.sessionId).toBe('d44ef152-6aac-4f65-ba56-6ff73c2eb20b')
  })

  it('filters to a single working directory when asked', async () => {
    const root = await makeRoot()
    await writeTranscript(root, 'a', 'in-relay', [
      { type: 'user', cwd: '/Users/hassan/.projects/relay', message: { role: 'user', content: 'a' } },
    ])
    await writeTranscript(root, 'b', 'elsewhere', [
      { type: 'user', cwd: '/Users/hassan/Documents/other', message: { role: 'user', content: 'b' } },
    ])

    const sessions = await listEngineSessions({ root, cwd: '/Users/hassan/.projects/relay' })

    expect(sessions.map((session) => session.sessionId)).toEqual(['in-relay'])
  })

  it('lists only terminal chats when asked, leaving out claude -p runs and subagents', async () => {
    const root = await makeRoot()
    await writeTranscript(root, 'proj', 'terminal-chat', [{ type: 'user', cwd: '/p', entrypoint: 'cli', message: { role: 'user', content: 'a' } }])
    await writeTranscript(root, 'proj', 'relay-worker', [{ type: 'user', cwd: '/p', entrypoint: 'sdk-cli', message: { role: 'user', content: 'b' } }])
    await writeTranscript(join(root, 'proj', 'terminal-chat'), 'subagents', 'agent-1', [{ type: 'user', cwd: '/p', entrypoint: 'cli', message: { role: 'user', content: 'c' } }])

    expect((await listEngineSessions({ root, interactiveOnly: true })).map((session) => session.sessionId)).toEqual(['terminal-chat'])
    expect(await listEngineSessions({ root })).toHaveLength(2)
  })

  it('omits a transcript with no cwd, because it cannot be resumed correctly', async () => {
    const root = await makeRoot()
    // Resuming without the right working directory produces a session that
    // looks right and behaves wrongly: it loses the project's own skills,
    // agents, and settings. Omitting it is the honest outcome.
    await writeTranscript(root, 'proj', 'no-cwd', [
      { type: 'queue-operation', operation: 'enqueue', sessionId: 'no-cwd' },
    ])

    expect(await listEngineSessions({ root })).toEqual([])
  })

  it('skips an unparseable line rather than losing the whole session', async () => {
    const root = await makeRoot()
    const dir = join(root, 'proj')
    await mkdir(dir, { recursive: true })
    // A transcript is an append log written by a live process, so a torn or
    // partial line is expected rather than exceptional.
    await writeFile(
      join(dir, 'torn.jsonl'),
      `{"type":"queue-operation"\n${JSON.stringify(userRecord('survived'))}\n`,
      'utf8',
    )

    const sessions = await listEngineSessions({ root })

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionId).toBe('torn')
  })

  it('returns an empty list when the sessions root does not exist', async () => {
    expect(await listEngineSessions({ root: join(tmpdir(), 'relay-no-such-root-12345') })).toEqual([])
  })

  it('returns no transcript content at all, not even a scrubbed excerpt', async () => {
    const root = await makeRoot()
    await writeTranscript(root, 'proj', 'secretive', [
      // A credential Relay never brokered, which is exactly what the
      // scrubber cannot redact: it is a registry of values Relay itself
      // issued, by design. That is why discovery returns no content rather
      // than relying on redaction being correct.
      userRecord(`deploy using sk-ant-${'a'.repeat(64)}`),
      { type: 'assistant', cwd: '/Users/someone/project', message: { role: 'assistant', content: 'CONFIDENTIAL BODY' } },
    ])

    const sessions = await listEngineSessions({ root })
    const serialised = JSON.stringify(sessions)

    expect(sessions).toHaveLength(1)
    expect(serialised).not.toContain('CONFIDENTIAL BODY')
    expect(serialised).not.toContain('sk-ant-')
    expect(serialised).not.toContain('deploy using')
  })

  it('exposes only identity, location, and recency for each session', async () => {
    const root = await makeRoot()
    await writeTranscript(root, 'proj', 'plain', [userRecord('anything at all')])

    const sessions = await listEngineSessions({ root })

    // Pins the result shape itself, so a future field carrying transcript
    // text is a failing test rather than a silent leak to a chat surface.
    expect(Object.keys(sessions[0] ?? {}).sort()).toEqual(['cwd', 'lastModifiedAt', 'sessionId', 'sizeBytes'])
  })
})
