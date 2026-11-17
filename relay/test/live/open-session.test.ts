import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { findOpenSessionName, openElsewhere, otherLaptopText } from '../../src/live/open-session.js'
import { attachSessionToEngineChat, findOrCreateSession } from '../../src/sessions/store.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

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

describe('openElsewhere', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  it("refuses a live session whose chat is open on the other laptop, naming that laptop, and lets this laptop's through", async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Op', ['member'])
    const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: `slack:C1:${randomUUID()}` })
    // Recorded the way the attach paths record it, not by hand.
    await attachSessionToEngineChat(pool, session.id, randomUUID(), '/Users/hassan/code', 'hassan-mbp')

    expect(await openElsewhere(pool, session.id, 'second-mbp')).toBe(otherLaptopText('hassan-mbp'))
    expect(otherLaptopText('hassan-mbp')).toContain('hassan-mbp')
    expect(await openElsewhere(pool, session.id, 'hassan-mbp')).toBeNull()
  })
})
