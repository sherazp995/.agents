import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import type { Logger } from '../../src/obs/logger.js'
import type { SecretProvider } from '../../src/secrets/provider.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { loadReaderKey, syncReaderKey, WORKER_ENV_KEY_SECRET } from '../../src/worker-env/keys.js'
import { generateReaderKey } from '../../src/worker-env/seal.js'
import { listEntries, listReaders, openEntries, publishReader, putEntry } from '../../src/worker-env/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

function quietLog(): Logger & { lines: string[] } {
  const lines: string[] = []
  const record = (first: unknown, second?: unknown) => void lines.push(JSON.stringify([first, second]))
  return { lines, warn: record, info: record, error: record, debug: () => {} } as unknown as Logger & { lines: string[] }
}

/** A keystore in memory, storing the way `relay secrets set` does: never over an existing item. */
function keystore(kind: SecretProvider['kind'] = 'keychain') {
  const items = new Map<string, string>()
  const secrets: SecretProvider = {
    kind,
    has: async (name) => items.has(name),
    get: async (name) => items.get(name) ?? '',
  }
  const storeSecret = async (name: string, value: string) => {
    if (items.has(name)) return { exitCode: 1, report: `${name} already exists.` }
    items.set(name, value)
    return { exitCode: 0, report: `Stored ${name}` }
  }
  return { items, secrets, storeSecret }
}

describe("this laptop's env key", () => {
  it('is made and stored once, then read back unchanged on the next start, and never logged', async () => {
    const store = keystore()
    const log = quietLog()
    const first = await loadReaderKey({ ...store, log })
    const again = await loadReaderKey({ ...store, log, generate: () => { throw new Error('must not make a second key') } })

    expect(first).not.toBeNull()
    expect(again).toEqual(first)
    expect(store.items.get(WORKER_ENV_KEY_SECRET)).toBe(first?.privateKey)
    expect(log.lines.join('\n')).not.toContain(first?.privateKey)
  })

  it('is none, with a warning, when the provider cannot store one or the keystore refuses it', async () => {
    const env = keystore('env')
    const log = quietLog()
    expect(await loadReaderKey({ ...env, log })).toBeNull()
    expect(env.items.size).toBe(0)
    const refusing = keystore()
    expect(await loadReaderKey({ ...refusing, storeSecret: async () => ({ exitCode: 1, report: 'helper missing' }), log })).toBeNull()
    expect(log.lines).toHaveLength(2)
  })
})

describe('publishing the key and sealing for a laptop that joins later', () => {
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

  it("publishes this laptop's key and gives a new laptop the default and folder values, not another machine's", async () => {
    const ws = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const hassan = generateReaderKey()
    await syncReaderKey(pool, hassan, 'hassan', quietLog())
    expect((await listReaders(pool, ws)).map((reader) => reader.host)).toEqual(['hassan'])
    await putEntry(pool, ws, { host: '', folder: '', name: 'SHARED' }, 'shared-value-1')
    await putEntry(pool, ws, { host: '', folder: '~/code/app', name: 'DB' }, 'folder-value-1')
    await putEntry(pool, ws, { host: 'hassan', folder: '', name: 'TOKEN' }, 'hassan-token-1')

    const zubair = generateReaderKey()
    await publishReader(pool, ws, { fingerprint: zubair.fingerprint, publicKey: zubair.publicKey, host: 'zubair' })
    await syncReaderKey(pool, hassan, 'hassan', quietLog())

    const entries = await listEntries(pool, ws)
    const shared = entries.filter((row) => row.host === '')
    expect([...(await openEntries(pool, ws, zubair, shared)).values()].sort()).toEqual(['folder-value-1', 'shared-value-1'])
    await expect(openEntries(pool, ws, zubair, entries.filter((row) => row.host === 'hassan'))).rejects.toThrow('cannot read the env TOKEN (on hassan)')
  })
})
