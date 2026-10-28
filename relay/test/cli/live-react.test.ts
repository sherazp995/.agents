import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runLiveReact } from '../../src/cli/live.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('relay live react', () => {
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

  it('queues one reaction on the named message, with the colons stripped', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Operator', ['operator'])
    await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'D1:1.1' })

    await runLiveReact({ pool, workspaceId, channel: 'D1', thread: '1.1', message: '1.2', name: ':thumbsup:' })

    const { rows } = await pool.query<{ action: unknown }>('SELECT action FROM outbox WHERE workspace_id = $1', [workspaceId])
    expect(rows.map((row) => row.action)).toEqual([{ kind: 'react', ref: { channel: 'D1', thread: '1.1', message: '1.2' }, name: 'thumbsup' }])
  })

  it('refuses a thread with no active session and queues nothing', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)

    await expect(runLiveReact({ pool, workspaceId, channel: 'D1', thread: '9.9', message: '9.9', name: 'eyes' })).rejects.toThrow('no active Relay session')

    const { rows } = await pool.query('SELECT 1 FROM outbox WHERE workspace_id = $1', [workspaceId])
    expect(rows).toHaveLength(0)
  })
})
