/**
 * Tests for src/sessions/liveness.ts. No real `ps`/`lsof` calls: the
 * execFileFn injection point (mirroring src/secrets/keychain.ts's own
 * pattern) is what makes the process-scan half deterministic and free.
 * The transcript-freshness half uses real files under a scratch root,
 * matching test/sessions/discovery.test.ts's own convention.
 */

import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FRESH_TRANSCRIPT_THRESHOLD_MS, hasLiveClaudeProcess, isSessionPossiblyLive } from '../../src/sessions/liveness.js'

const roots: string[] = []

afterEach(() => {
  roots.length = 0
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'relay-liveness-'))
  roots.push(root)
  return root
}

async function writeTranscript(root: string, sessionId: string, cwd: string, mtime: Date): Promise<void> {
  const dirName = cwd.replace(/[/.]/g, '-')
  const dir = join(root, dirName)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(path, `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } })}\n`, 'utf8')
  await utimes(path, mtime, mtime)
}

function buildExecFile(
  psOutput: string,
  lsofByPid: Record<number, string>,
): (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }> {
  return async (file, args) => {
    if (file === 'ps') return { stdout: psOutput, stderr: '' }
    if (file === 'lsof') {
      // Read the pid by finding `-p` rather than by a fixed index. The real
      // invocation is `lsof -a -p <pid> -d cwd`, so a positional read broke
      // silently when `-a` was added: the helper parsed `-p` as the pid,
      // got NaN, threw, and the caller read that as "cannot determine",
      // which made a genuinely live process look idle in the test.
      const pidFlag = args.indexOf('-p')
      const pid = Number(pidFlag === -1 ? args[1] : args[pidFlag + 1])
      const cwd = lsofByPid[pid]
      if (cwd === undefined) throw new Error(`no such process: ${pid}`)
      return {
        stdout: `claude   ${pid} hassan  cwd       DIR   1,17   3488   389002 ${cwd}\n`,
        stderr: '',
      }
    }
    throw new Error(`unexpected execFile call: ${file}`)
  }
}

describe('isSessionPossiblyLive', () => {
  describe('the transcript-freshness signal', () => {
    it('treats a session whose transcript was written moments ago as possibly live, without even checking for a process', async () => {
      const root = await makeRoot()
      await writeTranscript(root, 'sess-1', '/Users/op/project', new Date(Date.now() - 1_000))
      const execFile = buildExecFile('', {})

      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'sess-1', root }, execFile)
      expect(result).toBe(true)
    })

    it('does not trust freshness alone past the threshold: falls through to the process scan, which finds nothing', async () => {
      const root = await makeRoot()
      await writeTranscript(
        root,
        'sess-1',
        '/Users/op/project',
        new Date(Date.now() - FRESH_TRANSCRIPT_THRESHOLD_MS - 5_000),
      )
      const execFile = buildExecFile('', {})

      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'sess-1', root }, execFile)
      expect(result).toBe(false)
    })

    it('a session with no transcript at all (never on disk, or a different cwd) is not live via this signal', async () => {
      const root = await makeRoot()
      const execFile = buildExecFile('', {})
      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'never-seen', root }, execFile)
      expect(result).toBe(false)
    })
  })

  describe('the process-scan signal', () => {
    it('finds a live headless process by the exact session id in its own command line', async () => {
      const root = await makeRoot()
      await writeTranscript(root, 'sess-1', '/Users/op/project', new Date(Date.now() - FRESH_TRANSCRIPT_THRESHOLD_MS - 5_000))
      const psOutput = '  4242 claude --resume sess-1 -p do something\n  99 some-other-process\n'
      const execFile = buildExecFile(psOutput, {})

      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'sess-1', root }, execFile)
      expect(result).toBe(true)
    })

    it('matches a working directory containing spaces, rather than truncating it to its last word', async () => {
      // Not an exotic case on macOS: "My Documents", Dropbox, iCloud Drive
      // and Google Drive paths all contain spaces. Taking lsof's last
      // whitespace-delimited token would yield "Drive/project" here, which
      // matches nothing, so a genuinely live session would read as idle and
      // Relay would resume in place into a transcript someone is actively
      // writing to. That is the wrong side of this module's guarantee, and
      // it is reachable through an entirely ordinary folder name.
      const spaced = '/Users/op/Google Drive/My Project'
      const root = await makeRoot()
      await writeTranscript(root, 'sess-1', spaced, new Date(Date.now() - FRESH_TRANSCRIPT_THRESHOLD_MS - 5_000))
      const execFile = buildExecFile('  4242 claude\n', { 4242: spaced })

      expect(await isSessionPossiblyLive({ cwd: spaced, sessionId: 'sess-1', root }, execFile)).toBe(true)
    })

    it('finds a live interactive process by matching working directory via lsof, when the command line names no session id', async () => {
      const root = await makeRoot()
      await writeTranscript(root, 'sess-1', '/Users/op/project', new Date(Date.now() - FRESH_TRANSCRIPT_THRESHOLD_MS - 5_000))
      const psOutput = '  4242 claude\n'
      const execFile = buildExecFile(psOutput, { 4242: '/Users/op/project' })

      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'sess-1', root }, execFile)
      expect(result).toBe(true)
    })

    it('a claude process running in a DIFFERENT directory does not count as live for this one', async () => {
      const root = await makeRoot()
      await writeTranscript(root, 'sess-1', '/Users/op/project', new Date(Date.now() - FRESH_TRANSCRIPT_THRESHOLD_MS - 5_000))
      const psOutput = '  4242 claude\n'
      const execFile = buildExecFile(psOutput, { 4242: '/Users/op/some-other-project' })

      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'sess-1', root }, execFile)
      expect(result).toBe(false)
    })

    it('no claude processes at all: not live', async () => {
      const root = await makeRoot()
      await writeTranscript(root, 'sess-1', '/Users/op/project', new Date(Date.now() - FRESH_TRANSCRIPT_THRESHOLD_MS - 5_000))
      const psOutput = '  99 some-other-process\n  100 another-one\n'
      const execFile = buildExecFile(psOutput, {})

      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'sess-1', root }, execFile)
      expect(result).toBe(false)
    })
  })

  describe('fails toward "possibly live" on any doubt, per the accepted routing rule\'s asymmetry', () => {
    it('ps itself failing (missing binary, sandboxed, permission denied) reports possibly live, not "not live"', async () => {
      const root = await makeRoot()
      await writeTranscript(root, 'sess-1', '/Users/op/project', new Date(Date.now() - FRESH_TRANSCRIPT_THRESHOLD_MS - 5_000))
      const execFile = async (): Promise<never> => {
        throw new Error('ps: command not found')
      }

      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'sess-1', root }, execFile)
      expect(result).toBe(true)
    })

    it('lsof failing for one process (it already exited) is skipped, not fatal: the scan still checks the rest and can still return false', async () => {
      const root = await makeRoot()
      await writeTranscript(root, 'sess-1', '/Users/op/project', new Date(Date.now() - FRESH_TRANSCRIPT_THRESHOLD_MS - 5_000))
      const psOutput = '  4242 claude\n'
      // lsofByPid has no entry for 4242, so buildExecFile's lsof branch throws for it.
      const execFile = buildExecFile(psOutput, {})

      const result = await isSessionPossiblyLive({ cwd: '/Users/op/project', sessionId: 'sess-1', root }, execFile)
      expect(result).toBe(false)
    })
  })
})

describe('hasLiveClaudeProcess', () => {
  it('asks lsof not to block on kernel calls, since it runs on the inbound Slack path', async () => {
    const calls: string[][] = []
    const execFileFn = async (file: string, args: readonly string[]) => {
      calls.push([file, ...args])
      if (file === 'ps') return { stdout: '  PID COMMAND\n 3974 claude --resume x\n', stderr: '' }
      return { stdout: 'claude 3974 hassan cwd DIR 1,17 2016 1 /p\n', stderr: '' }
    }

    expect(await hasLiveClaudeProcess(execFileFn, '/p', 'other')).toBe(true)
    expect(calls.find(([file]) => file === 'lsof')?.slice(1, 3)).toEqual(['-b', '-w'])
  })

  it('does not treat an empty session id as matching every claude process', async () => {
    const execFileFn = async (file: string) =>
      file === 'ps' ? { stdout: '  PID COMMAND\n 3974 claude --resume x\n', stderr: '' } : { stdout: 'claude 3974 hassan cwd DIR 1,17 2016 1 /elsewhere\n', stderr: '' }

    expect(await hasLiveClaudeProcess(execFileFn, '/p', '')).toBe(false)
  })
})
