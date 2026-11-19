import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MISSING_TABLES, runEnvAdd, runEnvList, runEnvRemove, VALUE_MASK, type EnvAddDeps } from '../../src/cli/env.js'
import { chooseWorkspace } from '../../src/cli/workspace.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { generateReaderKey, type ReaderKey } from '../../src/worker-env/seal.js'
import { listEntries, openEntries, publishReader } from '../../src/worker-env/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

const HOME = '/home/tester'

describe('relay env', () => {
  let pool: Pool
  const hosts: string[] = []

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await pool.query('DELETE FROM failover_hosts WHERE name = ANY($1)', [hosts])
    await closePool(pool)
  })

  async function workspace(): Promise<string> {
    return resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
  }

  /** A laptop registered for failover that has published its key. */
  async function laptop(workspaceId: string): Promise<{ host: string; key: ReaderKey }> {
    const host = `laptop-${randomUUID().slice(0, 8)}`
    hosts.push(host)
    await pool.query("INSERT INTO failover_hosts (name, home, build_migration) VALUES ($1, $2, '0031')", [host, `/Users/${host}`])
    const key = generateReaderKey()
    await publishReader(pool, workspaceId, { fingerprint: key.fingerprint, publicKey: key.publicKey, host })
    return { host, key }
  }

  function addDeps(value: string, overrides: Partial<EnvAddDeps> = {}): EnvAddDeps & { readValue: ReturnType<typeof vi.fn> } {
    return { pool, home: HOME, cwd: '/', failoverOn: true, ...overrides, readValue: vi.fn(async () => value) }
  }

  it('stores the value it reads (never an argument) at the machine and folder scope, and list masks it', async () => {
    const ws = await workspace()
    const { host, key } = await laptop(ws)
    const deps = addDeps('zubair-token-123')

    const added = await runEnvAdd('TOKEN', { host, folder: `${HOME}/code/app/`, workspaceId: ws }, deps)

    expect(added).toMatchObject({ exitCode: 0, err: [] })
    expect(added.out.join('\n')).toContain(`TOKEN (on ${host} in ~/code/app)`)
    expect(deps.readValue).toHaveBeenCalledOnce()
    const [entry] = await listEntries(pool, ws)
    expect(entry).toMatchObject({ name: 'TOKEN', host, folder: '~/code/app' })
    expect((await openEntries(pool, ws, key, [entry!])).get(entry!.id)).toBe('zubair-token-123')

    const listed = await runEnvList({ workspaceId: ws }, { pool })
    const text = listed.out.join('\n')
    expect(text).toMatch(new RegExp(`TOKEN\\s+${host}\\s+~/code/app\\s+\\S+Z\\s+\\*{8}`))
    expect(text).toContain(VALUE_MASK)
    expect(text).not.toContain('zubair-token-123')
  })

  it('refuses NAME=value without asking for a value, storing it or echoing it', async () => {
    const ws = await workspace()
    await laptop(ws)
    const deps = addDeps('unused-value-1')

    const result = await runEnvAdd('TOKEN=abc-secret-1', { workspaceId: ws }, deps)

    expect(result.exitCode).toBe(1)
    expect(result.err.join('\n')).toContain('relay env add TOKEN`')
    expect(JSON.stringify(result)).not.toContain('abc-secret-1')
    expect(deps.readValue).not.toHaveBeenCalled()
    expect(await listEntries(pool, ws)).toEqual([])
  })

  it('refuses an unknown --host, listing the known laptops, before asking for the value', async () => {
    const ws = await workspace()
    const { host } = await laptop(ws)
    const deps = addDeps('value-12345')

    const result = await runEnvAdd('TOKEN', { host: 'nobody-here', workspaceId: ws }, deps)

    expect(result.exitCode).toBe(1)
    expect(result.err.join('\n')).toMatch(new RegExp(`No laptop is called "nobody-here"\\. Known laptops: .*${host}`))
    expect(deps.readValue).not.toHaveBeenCalled()
    expect(await listEntries(pool, ws)).toEqual([])
  })

  it('warns, but stores, a machine entry while failover is off and a value too short to scrub', async () => {
    const ws = await workspace()
    const { host } = await laptop(ws)

    const result = await runEnvAdd('PIN', { host, workspaceId: ws }, addDeps('1234', { failoverOn: false }))

    expect(result.exitCode).toBe(0)
    expect(result.err).toEqual([expect.stringContaining('failover is off'), expect.stringContaining('cannot scrub it')])
    expect(await listEntries(pool, ws)).toEqual([expect.objectContaining({ name: 'PIN', host })])
  })

  it('refuses an empty value and stores nothing', async () => {
    const ws = await workspace()
    await laptop(ws)

    const result = await runEnvAdd('TOKEN', { workspaceId: ws }, addDeps(''))

    expect(result).toMatchObject({ exitCode: 1, err: ['No value given for TOKEN (default); nothing was stored.'] })
    expect(await listEntries(pool, ws)).toEqual([])
  })

  it('removes only an entry that exists, and says so when there is none', async () => {
    const ws = await workspace()
    await laptop(ws)
    await runEnvAdd('TOKEN', { folder: '~/code/app', workspaceId: ws }, addDeps('value-12345'))
    expect(await listEntries(pool, ws)).toHaveLength(1)

    const removed = await runEnvRemove('TOKEN', { folder: `${HOME}/code/app`, workspaceId: ws }, { pool, home: HOME })
    expect(removed.exitCode).toBe(0)
    expect(await listEntries(pool, ws)).toEqual([])

    const again = await runEnvRemove('TOKEN', { folder: `${HOME}/code/app`, workspaceId: ws }, { pool, home: HOME })
    expect(again).toMatchObject({ exitCode: 1, err: ['No env TOKEN (in ~/code/app) is stored; nothing was removed.'] })
  })

  it('refuses to pick a workspace when several exist and none is named', async () => {
    await workspace()
    await workspace()

    const result = await runEnvList({}, { pool })

    expect(result.exitCode).toBe(1)
    expect(result.err.join('\n')).toMatch(/There are \d+ workspaces; pass --workspace-id/)
  })

  it('names the missing tables, and never prints a raw database error', async () => {
    const ws = randomUUID()
    const failing = (error: object): Pool =>
      ({
        query: async (sql: string) => {
          if (sql.includes('FROM workspaces')) return { rows: [{ id: ws, name: 'slack:T1' }] }
          throw Object.assign(new Error('boom'), error)
        },
      }) as unknown as Pool

    const missing = await runEnvList({ workspaceId: ws }, { pool: failing({ code: '42P01' }) })
    expect(missing).toMatchObject({ exitCode: 1, err: [MISSING_TABLES] })

    const other = await runEnvRemove('TOKEN', { workspaceId: ws }, { pool: failing({ code: '23514', detail: 'Failing row contains (leaked-value-1)' }) })
    expect(other).toMatchObject({ exitCode: 1, err: ['Could not remove TOKEN (default): the database refused it (code 23514).'] })
  })
})

describe('chooseWorkspace', () => {
  it('takes the only workspace and refuses none or an id that matched nothing', () => {
    expect(chooseWorkspace([{ id: 'w1', name: 'slack:T1' }], undefined)).toEqual({ kind: 'ok', workspaceId: 'w1' })
    expect(chooseWorkspace([], undefined)).toMatchObject({ kind: 'refused', message: expect.stringContaining('No workspace exists yet') })
    expect(chooseWorkspace([], 'w9')).toEqual({ kind: 'refused', message: 'No workspace has the id w9.' })
  })
})
