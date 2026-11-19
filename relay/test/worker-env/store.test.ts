import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { generateReaderKey, type ReaderKey } from '../../src/worker-env/seal.js'
import { listEntries, openEntries, publishReader, putEntry, relockForNewReaders, removeEntry, WorkerEnvError } from '../../src/worker-env/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('worker env store', () => {
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

  async function workspace(): Promise<string> {
    return resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
  }

  async function laptop(workspaceId: string, host: string): Promise<ReaderKey> {
    const key = generateReaderKey()
    await publishReader(pool, workspaceId, { fingerprint: key.fingerprint, publicKey: key.publicKey, host })
    return key
  }

  async function valueOf(workspaceId: string, key: ReaderKey, name: string, host = '', folder = ''): Promise<string | undefined> {
    const entry = (await listEntries(pool, workspaceId)).find((row) => row.name === name && row.host === host && row.folder === folder)
    if (entry === undefined) return undefined
    return (await openEntries(pool, workspaceId, key, [entry])).get(entry.id)
  }

  it('gives a default to every laptop and a host value only to that laptop', async () => {
    const ws = await workspace()
    const hassan = await laptop(ws, 'hassan')
    const zubair = await laptop(ws, 'zubair')
    await putEntry(pool, ws, { host: '', folder: '', name: 'SHARED' }, 'shared-value-1')
    await putEntry(pool, ws, { host: 'zubair', folder: '', name: 'TOKEN' }, 'zubair-token-1')
    expect(await valueOf(ws, hassan, 'SHARED')).toBe('shared-value-1')
    expect(await valueOf(ws, zubair, 'SHARED')).toBe('shared-value-1')
    expect(await valueOf(ws, zubair, 'TOKEN', 'zubair')).toBe('zubair-token-1')
    await expect(valueOf(ws, hassan, 'TOKEN', 'zubair')).rejects.toThrow('cannot read the env TOKEN (on zubair)')
  })

  it('replaces at the same scope, including the default scope, and stores no plain value', async () => {
    const ws = await workspace()
    const key = await laptop(ws, '')
    await putEntry(pool, ws, { host: '', folder: '', name: 'A' }, 'first-value-1')
    const before = await listEntries(pool, ws)
    await putEntry(pool, ws, { host: '', folder: '', name: 'A' }, 'second-value-2')
    const after = await listEntries(pool, ws)
    expect(after).toHaveLength(1)
    expect(after[0]?.updatedAt.getTime()).toBeGreaterThan(before[0]?.updatedAt.getTime() ?? Infinity)
    expect(await valueOf(ws, key, 'A')).toBe('second-value-2')
    const { rows } = await pool.query<{ sealed: string }>('SELECT sealed FROM worker_env_copies WHERE workspace_id = $1', [ws])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sealed).not.toContain('second-value-2')
  })

  it('keeps one workspace entries out of another', async () => {
    const one = await workspace()
    const two = await workspace()
    await laptop(one, '')
    await putEntry(pool, one, { host: '', folder: '~/code/app', name: 'A' }, 'value-in-one')
    expect(await listEntries(pool, two)).toEqual([])
  })

  it('refuses a value no laptop key may read, naming the laptop', async () => {
    const ws = await workspace()
    await laptop(ws, 'hassan')
    await expect(putEntry(pool, ws, { host: 'zubair', folder: '', name: 'T' }, 'zubair-token-1')).rejects.toThrow(WorkerEnvError)
    await expect(putEntry(pool, ws, { host: 'zubair', folder: '', name: 'T' }, 'zubair-token-1')).rejects.toThrow('"zubair" has not published')
    expect(await listEntries(pool, ws)).toEqual([])
  })

  it('removes an entry and says when there was none', async () => {
    const ws = await workspace()
    await laptop(ws, '')
    const scope = { host: '', folder: '', name: 'A' }
    await putEntry(pool, ws, scope, 'value-to-remove')
    expect(await removeEntry(pool, ws, scope)).toBe(true)
    expect(await removeEntry(pool, ws, scope)).toBe(false)
  })

  it('lists only entries for every laptop or the given one', async () => {
    const ws = await workspace()
    await laptop(ws, 'hassan')
    await laptop(ws, 'zubair')
    await putEntry(pool, ws, { host: '', folder: '', name: 'A' }, 'value-default')
    await putEntry(pool, ws, { host: 'zubair', folder: '', name: 'B' }, 'value-zubair')
    expect((await listEntries(pool, ws, { host: 'hassan' })).map((entry) => entry.name)).toEqual(['A'])
    expect((await listEntries(pool, ws, { host: 'zubair' })).map((entry) => entry.name)).toEqual(['A', 'B'])
  })

  it('relocks shared values for a laptop that joins later, but not another laptop host values', async () => {
    const ws = await workspace()
    const hassan = await laptop(ws, 'hassan')
    await putEntry(pool, ws, { host: '', folder: '', name: 'SHARED' }, 'shared-value-1')
    await putEntry(pool, ws, { host: 'hassan', folder: '', name: 'MINE' }, 'hassan-only-1')
    const zubair = await laptop(ws, 'zubair')
    await expect(valueOf(ws, zubair, 'SHARED')).rejects.toThrow('cannot read')
    expect(await relockForNewReaders(pool, ws, hassan)).toBe(1)
    expect(await valueOf(ws, zubair, 'SHARED')).toBe('shared-value-1')
    expect(await relockForNewReaders(pool, ws, hassan)).toBe(0)
    const { rows } = await pool.query('SELECT 1 FROM worker_env_copies WHERE fingerprint = $1', [zubair.fingerprint])
    expect(rows).toHaveLength(1)
  })

  it('drops a key copies of its old host values when its host changes', async () => {
    const ws = await workspace()
    const key = await laptop(ws, 'hassan')
    await putEntry(pool, ws, { host: 'hassan', folder: '', name: 'MINE' }, 'hassan-only-1')
    await putEntry(pool, ws, { host: '', folder: '', name: 'SHARED' }, 'shared-value-1')
    await publishReader(pool, ws, { fingerprint: key.fingerprint, publicKey: key.publicKey, host: 'renamed' })
    await expect(valueOf(ws, key, 'MINE', 'hassan')).rejects.toThrow('cannot read')
    expect(await valueOf(ws, key, 'SHARED')).toBe('shared-value-1')
  })
})
