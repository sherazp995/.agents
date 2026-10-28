import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findOpenSessionName } from '../../src/live/open-session.js'

/**
 * A thread is pushed to the chat that is open on its session. The folder is
 * never the address: several chats in one folder must not stop delivery.
 */
describe('findOpenSessionName', () => {
  let root: string
  const alive = new Set<number>()
  const isAlive = (pid: number) => alive.has(pid)
  const register = (pid: number, record: Record<string, unknown>) =>
    writeFile(join(root, `${pid}.json`), JSON.stringify({ pid, cwd: '/Users/op/cohabit-web', kind: 'interactive', ...record }))

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'relay-sessions-'))
    alive.clear()
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('finds the open chat by session id among several chats in the same folder', async () => {
    await register(1, { sessionId: 's-1', name: 'cohabit-web-c1' })
    await register(2, { sessionId: 's-2', name: 'cohabit-web-29' })
    await register(3, { sessionId: 's-3', name: 'cohabit-web-c4' })
    for (const pid of [1, 2, 3]) alive.add(pid)
    expect(await findOpenSessionName('s-2', { root, isAlive })).toBe('cohabit-web-29')
  })

  it('ignores a registry file whose process has exited, so a closed chat gets nothing', async () => {
    await register(4, { sessionId: 's-4', name: 'agents-39' })
    expect(await findOpenSessionName('s-4', { root, isAlive })).toBeNull()
  })

  it('ignores headless runs and unreadable files, and never opens the .key files', async () => {
    await register(5, { sessionId: 's-5', name: 'agents-x', kind: 'headless' })
    alive.add(5)
    await writeFile(join(root, '6.json'), 'not json')
    await writeFile(join(root, '6.abc.key'), JSON.stringify({ sessionId: 's-6', name: 'secret', pid: 6, kind: 'interactive' }))
    alive.add(6)
    expect(await findOpenSessionName('s-5', { root, isAlive })).toBeNull()
    expect(await findOpenSessionName('s-6', { root, isAlive })).toBeNull()
  })

  it('returns null when the registry folder does not exist', async () => {
    expect(await findOpenSessionName('s-1', { root: join(root, 'missing'), isAlive })).toBeNull()
  })
})
