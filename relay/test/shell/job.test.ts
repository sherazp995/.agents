import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { createLogger } from '../../src/obs/logger.js'
import { readShellFolder } from '../../src/shell/folder-store.js'
import { ShellJobs, type ShellJobRequest, type ShellJobsDeps } from '../../src/shell/job.js'
import type { LineResult, PasswordAnswerer, RunLineOptions, ShellReplyPort } from '../../src/shell/types.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/** Fails loudly instead of skipping when the var is absent, like every other database suite here. */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error('RELAY_TEST_DATABASE_URL is not set; this suite must fail, not silently skip.')
        })
      })

const log = createLogger('error', new Writable({ write(_chunk, _encoding, callback) { callback() } }))

type Fakes = { posts: string[]; edits: string[]; ran: Array<{ command: string; cwd: string }> }

/** A fake Slack: records every post and edit; `failPost` makes the first post fail. */
function fakeReplies(fakes: Fakes, options: { failPost?: boolean } = {}): ShellReplyPort {
  return {
    post: async ({ channel, text }) => {
      if (options.failPost) throw new Error('slack is down')
      fakes.posts.push(text)
      return { channel, ts: '111.222' }
    },
    update: async ({ text }) => {
      fakes.edits.push(text)
    },
  }
}

/** A fake line runner: `exit N` fails with N, `cd X` moves to X, `wait` runs until aborted. */
function fakeRunLine(fakes: Fakes): (options: RunLineOptions) => Promise<LineResult> {
  return async (options) => {
    fakes.ran.push({ command: options.command, cwd: options.cwd })
    const output = { head: `ran ${options.command}`, tail: '', omittedBytes: 0 }
    if (options.command === 'wait') {
      return new Promise((resolve) => {
        const done = (): void => resolve({ command: options.command, outcome: { kind: 'killed', why: 'cancelled', reason: String(options.signal?.reason) }, output, folderAfter: options.cwd })
        if (options.signal?.aborted) done()
        options.signal?.addEventListener('abort', done)
      })
    }
    const exit = /^exit (\d+)$/.exec(options.command)
    if (exit) return { command: options.command, outcome: { kind: 'exited', code: Number(exit[1]) }, output, folderAfter: options.cwd }
    const cd = /^cd (.+)$/.exec(options.command)
    return { command: options.command, outcome: { kind: 'exited', code: 0 }, output, folderAfter: cd?.[1] ?? options.cwd }
  }
}

const noAskpass = async () => ({ sudo: { binDir: '/nonexistent', env: {} }, close: async () => {} })

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describeDb('ShellJobs', () => {
  let pool: Pool
  let home: string

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
    await applyMigrations(pool, 'src/db/migrations')
    home = realpathSync(mkdtempSync(join(tmpdir(), 'shell-job-')))
  })

  afterAll(async () => {
    await closePool(pool)
  })

  function jobs(fakes: Fakes, overrides: Partial<ShellJobsDeps> = {}): ShellJobs {
    return new ShellJobs({
      pool,
      log,
      replies: () => fakeReplies(fakes),
      renderBlocks: (text, requestId) => [{ type: 'markdown', text }, ...(requestId ? [{ type: 'actions', requestId }] : [])],
      principalFor: async (user) => (user === 'U_OWNER' ? 'owner' : 'member'),
      home,
      runLine: fakeRunLine(fakes),
      startAskpass: noAskpass,
      killSwitchPollMs: 20,
      ...overrides,
    })
  }

  async function request(commands: string[]): Promise<{ key: string; request: ShellJobRequest }> {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    const key = `C1:${randomUUID()}`
    return {
      key,
      request: { thread: { workspaceId, adapter: 'slack', threadRef: key }, principalId: 'owner', channel: 'C1', threadTs: '1.0', commands, startFolder: async () => ({ kind: 'folder', path: home }) },
    }
  }

  async function settle(shell: ShellJobs): Promise<void> {
    await until(() => !shell.busy())
  }

  it('a failing line skips the rest, and the skipped line never runs', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    const shell = jobs(fakes)
    const { key, request: req } = await request(['git status', 'exit 1', 'git commit -m x'])
    expect(shell.start(key, req)).toBeUndefined()
    await settle(shell)
    expect(fakes.ran.map((line) => line.command)).toEqual(['git status', 'exit 1'])
    expect(fakes.posts).toHaveLength(1)
    const last = fakes.edits.at(-1) ?? ''
    expect(last).toContain('❌ exit 1')
    expect(last).toMatch(/git commit -m x[^]*_skipped_/)
  })

  it('two messages in one thread run in order, the second where the first ended', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    const shell = jobs(fakes)
    const { key, request: req } = await request(['cd /tmp', 'pwd'])
    shell.start(key, req)
    shell.start(key, { ...req, commands: ['ls'] })
    await settle(shell)
    expect(fakes.ran).toEqual([
      { command: 'cd /tmp', cwd: home },
      { command: 'pwd', cwd: '/tmp' },
      { command: 'ls', cwd: '/tmp' },
    ])
    expect(await readShellFolder(pool, req.thread, home)).toBe('/tmp')
  })

  it('the thread is known while its first line runs, and stop from the owner kills it', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    const shell = jobs(fakes)
    const { key, request: req } = await request(['wait', 'never'])
    shell.start(key, req)
    await until(() => fakes.ran.length === 1)
    expect(shell.isActive(key)).toBe(true)
    expect(shell.stop(key, 'member')).toBe(false)
    expect(shell.stop(key, 'owner')).toBe(true)
    await settle(shell)
    expect(fakes.ran.map((line) => line.command)).toEqual(['wait'])
    expect(fakes.edits.at(-1)).toContain('⛔ stopped: stopped from Slack')
    expect(shell.isActive(key)).toBe(false)
  })

  it('a kill switch engaged in the store, with no new Slack message, kills a running line', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    let engaged = false
    const shell = jobs(fakes, { killSwitch: { refresh: async () => undefined, isEngaged: () => engaged, reason: () => (engaged ? 'incident' : undefined) } })
    const { key, request: req } = await request(['wait', 'never'])
    shell.start(key, req)
    await until(() => fakes.ran.length === 1)
    engaged = true
    await settle(shell)
    expect(fakes.ran.map((line) => line.command)).toEqual(['wait'])
    expect(fakes.edits.at(-1)).toContain('Relay is paused: incident')
  })

  it('a reply that cannot be posted runs nothing', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    const shell = jobs(fakes, { replies: () => fakeReplies(fakes, { failPost: true }) })
    const { key, request: req } = await request(['pwd'])
    shell.start(key, req)
    await settle(shell)
    expect(fakes.ran).toEqual([])
  })

  it('a saved folder that is gone refuses the message, and `! cd` goes back to the start folder', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    const shell = jobs(fakes)
    const { key, request: req } = await request(['cd /nonexistent-relay-folder'])
    shell.start(key, req)
    await settle(shell)
    shell.start(key, { ...req, commands: ['pwd'] })
    await settle(shell)
    expect(fakes.ran.map((line) => line.command)).toEqual(['cd /nonexistent-relay-folder'])
    expect(fakes.edits.at(-1)).toContain('no longer exists')
    shell.start(key, { ...req, commands: ['cd'] })
    await settle(shell)
    expect(fakes.ran.at(-1)).toEqual({ command: `cd -- '${home}'`, cwd: home })
  })

  it('only the owner who ran it can answer a sudo prompt, and only once', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    let answer: PasswordAnswerer | undefined
    let got: string | undefined
    const shell = jobs(fakes, {
      startAskpass: async (options) => {
        answer = options.answer
        return { sudo: { binDir: '/nonexistent', env: {} }, close: async () => {} }
      },
      runLine: async (options) => {
        got = await answer?.({ prompt: 'Password:' }, new AbortController().signal)
        return { command: options.command, outcome: { kind: 'exited', code: 0 }, output: { head: '', tail: '', omittedBytes: 0 }, folderAfter: options.cwd }
      },
      renderBlocks: (text, requestId) => {
        if (requestId) requestIds.push(requestId)
        return [{ type: 'markdown', text }]
      },
    })
    const requestIds: string[] = []
    const { key, request: req } = await request(['sudo true'])
    shell.start(key, req)
    await until(() => requestIds.length > 0)
    const requestId = requestIds[0] as string
    expect(await shell.passwordPort.canAnswer({ requestId, platformUserId: 'U_MEMBER' })).toBe(false)
    expect(await shell.passwordPort.submit({ requestId, platformUserId: 'U_MEMBER', password: 'abc' })).toBe('refused')
    expect(await shell.passwordPort.canAnswer({ requestId, platformUserId: 'U_OWNER' })).toBe(true)
    expect(await shell.passwordPort.submit({ requestId, platformUserId: 'U_OWNER', password: 'abc' })).toBe('accepted')
    expect(await shell.passwordPort.submit({ requestId, platformUserId: 'U_OWNER', password: 'abc' })).toBe('expired')
    await settle(shell)
    expect(got).toBe('abc')
    expect(fakes.edits.join('\n')).not.toContain('abc')
  })

  it('an unanswered sudo prompt fails after the password limit', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    let answer: PasswordAnswerer | undefined
    let got: string | undefined = 'unset'
    const shell = jobs(fakes, {
      passwordTimeoutMs: 50,
      startAskpass: async (options) => {
        answer = options.answer
        return { sudo: { binDir: '/nonexistent', env: {} }, close: async () => {} }
      },
      runLine: async (options) => {
        got = await answer?.({ prompt: 'Password:' }, new AbortController().signal)
        return { command: options.command, outcome: { kind: 'exited', code: 1 }, output: { head: '', tail: '', omittedBytes: 0 }, folderAfter: options.cwd }
      },
    })
    const { key, request: req } = await request(['sudo true'])
    const started = Date.now()
    shell.start(key, req)
    await settle(shell)
    expect(got).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
  })

  it('closeAll kills running lines and refuses new messages', async () => {
    const fakes: Fakes = { posts: [], edits: [], ran: [] }
    const shell = jobs(fakes)
    const { key, request: req } = await request(['wait'])
    shell.start(key, req)
    await until(() => fakes.ran.length === 1)
    await shell.closeAll('handover')
    expect(shell.busy()).toBe(false)
    expect(fakes.edits.at(-1)).toContain('⛔ stopped: handover')
    expect(shell.start(key, req)).toBe('Relay is stopping, so nothing ran.')
  })
})
