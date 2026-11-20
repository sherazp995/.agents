import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Account } from '../../src/autonomous/accounts.js'
import { relayPrepare } from '../../src/cli/launch.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { addMember, createProject, insertPersona } from '../../src/projects/store.js'
import type { SecretProvider } from '../../src/secrets/provider.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { WORKER_ENV_KEY_SECRET } from '../../src/worker-env/keys.js'
import { generateReaderKey } from '../../src/worker-env/seal.js'
import { publishReader, putEntry } from '../../src/worker-env/store.js'
import { dropSiblingDatabase, freshSiblingDatabase } from '../support/database.js'

const HOST = 'test-laptop'
const CLAUDE: Account = { key: 'claude1', client: 'claude', configDir: '/tmp/claude1', env: {} }

/** The setup step refuses a database with several Slack workspaces, so this file has its own with exactly one. */
describe('relay claude setup: envs, project and the linked thread', () => {
  let url: string
  let pool: Pool
  let workspaceId: string
  let owner: string

  beforeAll(async () => {
    url = await freshSiblingDatabase('launch')
    pool = createPool(url)
    await applyMigrations(pool, 'src/db/migrations')
    workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    owner = `U${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`
    await provisionPrincipal(pool, workspaceId, 'slack', owner, 'Owner', ['owner'])
  })

  afterAll(async () => {
    await closePool(pool)
    await dropSiblingDatabase(url)
  })

  async function inTx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /** A keystore that counts every read, holding this laptop's env key when given one. */
  function keystore(privateKey?: string): { secrets: SecretProvider; reads: () => number } {
    let reads = 0
    const secrets: SecretProvider = {
      kind: 'keychain',
      has: async (name) => {
        reads += 1
        return privateKey !== undefined && name === WORKER_ENV_KEY_SECRET
      },
      get: async () => {
        reads += 1
        return privateKey ?? ''
      },
    }
    return { secrets, reads: () => reads }
  }

  function prepare(cwd: string, secrets: SecretProvider, host = HOST) {
    return relayPrepare({
      client: 'claude',
      cwd,
      host,
      dmTo: owner,
      openPool: async () => createPool(url),
      closePool,
      secrets,
      repos: () => [],
    })
  }

  /** Marks the launcher's post sent, as the daemon would, so the thread opens. */
  async function whileDaemonSends<T>(ts: string, work: () => Promise<T>): Promise<T> {
    const drain = setInterval(() => {
      void pool.query(
        `UPDATE outbox SET status = 'sent', sent_ref = jsonb_build_object('channel', action->'ref'->>'channel', 'message', $2::text)
          WHERE workspace_id = $1 AND sent_ref IS NULL AND status = 'pending'`,
        [workspaceId, ts],
      )
    }, 50)
    try {
      return await work()
    } finally {
      clearInterval(drain)
    }
  }

  it("loads this folder's stored env, names the project and its team, and opens the thread in its channel linked to the chat", async () => {
    const folder = mkdtempSync(join(tmpdir(), 'relay-launch-project-'))
    const projectId = await inTx((client) => createProject(client, workspaceId, { name: 'Shop', slackChannel: 'CSHOP', folder, repos: [] }))
    const personaId = await inTx((client) => insertPersona(client, workspaceId, { name: 'Builder', fileName: `builder-${randomUUID()}.md`, body: 'Builds.' }))
    await inTx((client) => addMember(client, workspaceId, projectId, { name: 'Theo', role: 'builder', personaId, isLead: true }))
    const key = generateReaderKey()
    await publishReader(pool, workspaceId, { fingerprint: key.fingerprint, publicKey: key.publicKey, host: HOST })
    await putEntry(pool, workspaceId, { host: HOST, folder: '', name: 'SHOP_TOKEN' }, 'shop-token-value-1')
    const store = keystore(key.privateKey)
    const chatId = randomUUID()
    const ts = `${Date.now()}.1`

    const prepared = await whileDaemonSends(ts, () => prepare(join(folder, 'src'), store.secrets)({ account: CLAUDE, attachTo: chatId, openThread: true }))

    expect(prepared.env).toEqual({ SHOP_TOKEN: 'shop-token-value-1' })
    expect(prepared.project?.project.name).toBe('Shop')
    expect(prepared.project?.members.map((member) => member.name)).toEqual(['Theo'])
    expect(prepared.thread).toEqual({ channel: 'CSHOP', thread: ts })
    expect(store.reads()).toBeGreaterThan(0)
    const { rows } = await pool.query<{ ref: unknown }>(`SELECT action->'ref' AS ref FROM outbox WHERE workspace_id = $1 AND sent_ref->>'message' = $2`, [workspaceId, ts])
    expect(rows).toEqual([{ ref: { channel: 'CSHOP' } }])
    const linked = await pool.query(`SELECT engine_session_id, engine_cwd, engine_host FROM sessions WHERE workspace_id = $1 AND thread_ref = $2`, [workspaceId, `CSHOP:${ts}`])
    expect(linked.rows).toEqual([{ engine_session_id: chatId, engine_cwd: join(folder, 'src'), engine_host: HOST }])
  })

  it('never reads the keystore when no env is stored for the folder, and a non-chat call opens no thread', async () => {
    const store = keystore()
    // Another laptop's name, so the env stored for test-laptop does not apply here.
    const prepared = await prepare(mkdtempSync(join(tmpdir(), 'relay-launch-plain-')), store.secrets, 'other-laptop')({ account: CLAUDE, attachTo: null, openThread: false })
    expect(prepared).toMatchObject({ env: {}, thread: null, project: null })
    expect(store.reads()).toBe(0)
  })
})
