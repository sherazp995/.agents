import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { hasShellFolder, readShellFolder, saveShellFolder } from '../../src/shell/folder-store.js'
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

describeDb('shell folder store', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function thread() {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    return { workspaceId, adapter: 'slack', threadRef: `C1:${randomUUID()}` }
  }

  it('a thread with no `!` history has no folder and is not a shell thread', async () => {
    const t = await thread()
    expect(await readShellFolder(pool, t, '/Users/me')).toBeUndefined()
    expect(await hasShellFolder(pool, t)).toBe(false)
  })

  it('the last saved folder wins and makes the thread a shell thread', async () => {
    const t = await thread()
    await saveShellFolder(pool, t, '/Users/me/a')
    await saveShellFolder(pool, t, '/Users/me/b')
    expect(await readShellFolder(pool, t, '/Users/me')).toBe('/Users/me/b')
    expect(await hasShellFolder(pool, t)).toBe(true)
  })

  it('a folder saved under the other laptop home reads back under this one', async () => {
    const t = await thread()
    const host = `h${randomUUID().slice(0, 8)}`
    const otherHome = `/Users/${host}`
    await pool.query("INSERT INTO failover_hosts (name, home, build_migration) VALUES ($1, $2, '0033')", [host, otherHome])
    await saveShellFolder(pool, t, `${otherHome}/Documents/insitu`)
    expect(await readShellFolder(pool, t, '/Users/me')).toBe('/Users/me/Documents/insitu')
  })
})
