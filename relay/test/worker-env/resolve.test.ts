import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { createLogger } from '../../src/obs/logger.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { pickEntries, resolveWorkerEnv, type EnvPlace } from '../../src/worker-env/resolve.js'
import { generateReaderKey, type ReaderKey } from '../../src/worker-env/seal.js'
import { createSessionEnvs } from '../../src/worker-env/sessions.js'
import { publishReader, putEntry, removeEntry, type EnvEntry } from '../../src/worker-env/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

const HOME = '/Users/hassan'

function entry(name: string, host: string, folder: string, id = randomUUID()): EnvEntry {
  return { id, name, host, folder, updatedAt: new Date(0) }
}

function place(cwd: string, overrides: Partial<EnvPlace> = {}): EnvPlace {
  return { host: 'hassan', cwd, home: HOME, homes: [HOME, '/Users/zubair'], repos: [], ...overrides }
}

/** Which stored folder (or host) won for each name. */
function winners(entries: EnvEntry[], at: EnvPlace): Record<string, string> {
  return Object.fromEntries(pickEntries(entries, at).map((won) => [won.name, `${won.host}|${won.folder}`]))
}

describe('pickEntries', () => {
  it('orders default < machine < folder < folder on this machine, and ignores another machine', () => {
    const entries = [
      entry('A', '', ''),
      entry('A', 'hassan', ''),
      entry('B', 'hassan', ''),
      entry('B', '', '~/code'),
      entry('C', '', '~/code/app/web'),
      entry('C', 'hassan', '~/code'),
      entry('D', 'zubair', ''),
    ]
    expect(winners(entries, place(`${HOME}/code/app/web`))).toEqual({ A: 'hassan|', B: '|~/code', C: 'hassan|~/code' })
  })

  it('picks the deepest folder, and breaks a tie on the stored text whatever the row order', () => {
    const nested = [entry('A', '', '~/code'), entry('A', '', '~/code/app')]
    expect(winners(nested, place(`${HOME}/code/app/src`))).toEqual({ A: '|~/code/app' })
    expect(winners([...nested].reverse(), place(`${HOME}/code/app/src`))).toEqual({ A: '|~/code/app' })
    const tie = [entry('A', '', '~/code/app'), entry('A', '', `${HOME}/code/app`)]
    expect(winners(tie, place(`${HOME}/code/app`))).toEqual({ A: `|${HOME}/code/app` })
    expect(winners([...tie].reverse(), place(`${HOME}/code/app`))).toEqual({ A: `|${HOME}/code/app` })
    // Ids that would pick the other row, so only the stored-text tie break gives this winner.
    const sameLength = [entry('A', '', '/Users/zubair/code/app', '00000000-0000-4000-8000-000000000000'), entry('A', '', `${HOME}/code/app`, 'ffffffff-ffff-4fff-bfff-ffffffffffff')]
    expect(winners(sameLength, place(`${HOME}/code/app`))).toEqual({ A: '|/Users/zubair/code/app' })
    expect(winners([...sameLength].reverse(), place(`${HOME}/code/app`))).toEqual({ A: '|/Users/zubair/code/app' })
  })

  it('never matches ~/code/app in ~/code/apple', () => {
    expect(winners([entry('A', '', '~/code/app')], place(`${HOME}/code/apple`))).toEqual({})
  })

  it("matches a registered repository's <repo>-<name> worktree, but not an unrelated app-admin repo or an unregistered folder's sibling", () => {
    const entries = [entry('A', '', '~/code/app')]
    const repos = [`${HOME}/code/app`, `${HOME}/code/app-admin`]
    expect(winners(entries, place(`${HOME}/code/app-fix-login/src`, { repos }))).toEqual({ A: '|~/code/app' })
    expect(winners(entries, place(`${HOME}/code/app-admin`, { repos }))).toEqual({})
    expect(winners(entries, place(`${HOME}/code/app-fix-login`))).toEqual({})
  })

  it("matches a folder stored under the other laptop's home", () => {
    expect(winners([entry('A', '', '/Users/zubair/code/app')], place(`${HOME}/code/app`))).toEqual({ A: '|/Users/zubair/code/app' })
  })

  it('uses only default entries when failover is off', () => {
    expect(winners([entry('A', '', ''), entry('A', 'hassan', '~/code')], place(`${HOME}/code`, { host: null }))).toEqual({ A: '|' })
  })
})

describe('resolving and opening stored envs', () => {
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

  it("gives the same thread Hassan's token on Hassan's laptop and Zubair's on Zubair's, and the default on both", async () => {
    const ws = await workspace()
    const hassan = await laptop(ws, 'hassan')
    const zubair = await laptop(ws, 'zubair')
    await putEntry(pool, ws, { host: '', folder: '', name: 'SHARED' }, 'shared-value-1')
    await putEntry(pool, ws, { host: 'hassan', folder: '', name: 'TOKEN' }, 'hassan-token-1')
    await putEntry(pool, ws, { host: 'zubair', folder: '', name: 'TOKEN' }, 'zubair-token-1')
    const cwd = `${HOME}/code/app`
    expect((await resolveWorkerEnv({ pool, workspaceId: ws, key: hassan }, place(cwd), {})).env).toEqual({ SHARED: 'shared-value-1', TOKEN: 'hassan-token-1' })
    expect((await resolveWorkerEnv({ pool, workspaceId: ws, key: zubair }, place(cwd, { host: 'zubair' }), {})).env).toEqual({ SHARED: 'shared-value-1', TOKEN: 'zubair-token-1' })
  })

  it('never opens an entry for another folder, so one this laptop cannot read does not block', async () => {
    const ws = await workspace()
    const key = await laptop(ws, 'hassan')
    await putEntry(pool, ws, { host: '', folder: '~/code/other', name: 'BROKEN' }, 'other-value-1')
    await pool.query("UPDATE worker_env_copies SET sealed = 'v1.x.x.x.x' WHERE workspace_id = $1", [ws])
    await putEntry(pool, ws, { host: '', folder: '', name: 'OK' }, 'ok-value-1')
    expect((await resolveWorkerEnv({ pool, workspaceId: ws, key }, place(`${HOME}/code/app`), {})).env).toEqual({ OK: 'ok-value-1' })
    await expect(resolveWorkerEnv({ pool, workspaceId: ws, key }, place(`${HOME}/code/other`), {})).rejects.toThrow('cannot read the env BROKEN (in ~/code/other)')
  })

  it('lets a stored entry win over the description, which still fills the names nothing stores', async () => {
    const ws = await workspace()
    const key = await laptop(ws, 'hassan')
    await putEntry(pool, ws, { host: 'hassan', folder: '', name: 'PLAYWRIGHT_MCP_EXTENSION_TOKEN' }, 'stored-token-1')
    const fallback = { PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'description-token-1', PLAYWRIGHT_MCP_PROFILE_DIR_NAME: 'Profile 16' }
    expect((await resolveWorkerEnv({ pool, workspaceId: ws, key }, place(HOME), fallback)).env).toEqual({
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'stored-token-1',
      PLAYWRIGHT_MCP_PROFILE_DIR_NAME: 'Profile 16',
    })
  })

  it("checks for a change at the folder and laptop the session started with, opening nothing, and reports a replace or remove", async () => {
    const ws = await workspace()
    const key = await laptop(ws, 'hassan')
    await putEntry(pool, ws, { host: '', folder: '~/code/app', name: 'TOKEN' }, 'first-token-1')
    let description: Record<string, string> = {}
    const deps = { host: 'hassan', home: HOME, homes: async () => [HOME, '/Users/zubair'], repos: () => [], fallback: async () => description, log: createLogger('fatal') }
    const envs = createSessionEnvs({ ...deps, source: { pool, workspaceId: ws, key } })
    expect(await envs.forSession({ taskId: 't1', threadRef: 'C1:1.1', cwd: `${HOME}/code/app`, track: true })).toEqual({ kind: 'ready', env: { TOKEN: 'first-token-1' } })
    // Without a key, a check that tried to open the value would fail.
    const checkOnly = createSessionEnvs({ ...deps, source: { pool, workspaceId: ws, key: null } })
    expect(await checkOnly.changedSince('t1')).toBe(false)
    expect(await envs.changedSince('t1')).toBe(false)

    // A description value for a name a stored entry sets is not used, so changing it changes nothing.
    description = { TOKEN: 'description-token-1' }
    expect(await envs.changedSince('t1')).toBe(false)
    description = { PLAYWRIGHT_MCP_PROFILE_DIR_NAME: 'Profile 3' }
    expect(await envs.changedSince('t1')).toBe(true)
    description = {}
    await putEntry(pool, ws, { host: '', folder: '~/code/app', name: 'TOKEN' }, 'second-token-2')
    expect(await envs.changedSince('t1')).toBe(true)
    await envs.forSession({ taskId: 't1', threadRef: 'C1:1.1', cwd: `${HOME}/code/app`, track: true })
    expect(await envs.changedSince('t1')).toBe(false)
    await removeEntry(pool, ws, { host: '', folder: '~/code/app', name: 'TOKEN' })
    expect(await envs.changedSince('t1')).toBe(true)
  })

  it('reports an unreadable matching value, a missing key and a database failure as a reason, not an error', async () => {
    const ws = await workspace()
    await laptop(ws, 'hassan')
    await putEntry(pool, ws, { host: '', folder: '', name: 'TOKEN' }, 'first-token-1')
    const envs = createSessionEnvs({ source: { pool, workspaceId: ws, key: generateReaderKey() }, host: 'hassan', home: HOME, homes: async () => [HOME], repos: () => [], fallback: async () => ({}), log: createLogger('fatal') })
    expect(await envs.forSession({ taskId: 't1', threadRef: 'C1:1.1', cwd: HOME, track: true })).toEqual({ kind: 'unreadable', reason: expect.stringContaining('cannot read the env TOKEN (default)') })

    const broken = createSessionEnvs({ source: { pool, workspaceId: ws, key: null }, host: 'hassan', home: HOME, homes: async () => [HOME], repos: () => [], fallback: async () => ({}), log: createLogger('fatal') })
    expect(await broken.forSession({ taskId: 't2', threadRef: 'C1:1.1', cwd: HOME, track: true })).toMatchObject({ kind: 'unreadable' })
    const failing = createSessionEnvs({ source: { pool, workspaceId: ws, key: null }, host: 'hassan', home: HOME, homes: async () => { throw new Error('db down') }, repos: () => [], fallback: async () => ({}), log: createLogger('fatal') })
    expect(await failing.forSession({ taskId: 't3', threadRef: 'C1:1.1', cwd: HOME, track: true })).toEqual({ kind: 'unreadable', reason: 'The stored envs could not be read from the database.' })
  })
})
