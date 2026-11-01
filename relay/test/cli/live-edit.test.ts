import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runLiveEdit, runLiveReact, runLiveSay } from '../../src/cli/live.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { registerSecretValue } from '../../src/secrets/scrubber.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('relay live edit', () => {
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

  /** A workspace with sessions in D1:1.1 and D1:2.1, and a status post said in D1:1.1. */
  async function said(): Promise<{ workspaceId: string; id: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Owner', ['owner'])
    await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'D1:1.1' })
    await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'D1:2.1' })
    const out = await runLiveSay({ pool, workspaceId, channel: 'D1', thread: '1.1', text: 'Working on it.' })
    const id = /^queued (\S+) for/.exec(out)?.[1]
    if (!id) throw new Error(`say printed no status id: ${out}`)
    return { workspaceId, id }
  }

  async function deliver(id: string): Promise<void> {
    await pool.query(`UPDATE outbox SET status = 'sent', sent_ref = $2 WHERE id = $1`, [id, { channel: 'D1', thread: '1.1', message: '9.000001' }])
  }

  async function edits(workspaceId: string): Promise<unknown[]> {
    const { rows } = await pool.query<{ action: { kind: string } }>('SELECT action FROM outbox WHERE workspace_id = $1', [workspaceId])
    return rows.map((row) => row.action).filter((action) => action.kind === 'edit')
  }

  it("queues a Markdown edit of the delivered message, with secrets scrubbed", async () => {
    const { workspaceId, id } = await said()
    await deliver(id)
    registerSecretValue('edit-test-secret-value')

    const out = await runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: ' **Step 2 of 3** edit-test-secret-value ' })

    expect(out).toBe(`queued an edit of ${id} in D1:1.1; the relay daemon updates it.`)
    expect(await edits(workspaceId)).toEqual([
      { kind: 'edit', ref: { channel: 'D1', thread: '1.1', message: '9.000001' }, text: '**Step 2 of 3** [redacted secret]', markdown: true },
    ])
  })

  it('refuses another thread, another workspace and a non-post row, and queues nothing', async () => {
    const { workspaceId, id } = await said()
    await deliver(id)
    const other = await said()
    await deliver(other.id)
    const reacted = await runLiveReact({ pool, workspaceId, channel: 'D1', thread: '1.1', message: '9.000001', name: 'eyes' })
    expect(reacted).toContain('queued :eyes:')
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM outbox WHERE workspace_id = $1 AND action->>'kind' = 'react'`, [workspaceId])
    const reactId = rows[0]?.id ?? ''

    const edit = (params: { workspaceId: string; thread: string; id: string }) =>
      runLiveEdit({ pool, channel: 'D1', text: 'hijack', sendWaitMs: 0, ...params })
    await expect(edit({ workspaceId, thread: '2.1', id })).rejects.toThrow(`${id} is not a message relay posted in D1:2.1`)
    await expect(edit({ workspaceId: other.workspaceId, thread: '1.1', id })).rejects.toThrow('is not a message relay posted')
    await expect(edit({ workspaceId, thread: '1.1', id: reactId })).rejects.toThrow('is not a message relay posted')
    await expect(edit({ workspaceId, thread: '1.1', id: 'not-a-uuid' })).rejects.toThrow('is not a message relay posted')
    await expect(edit({ workspaceId, thread: '1.1', id: randomUUID() })).rejects.toThrow('is not a message relay posted')

    expect(await edits(workspaceId)).toEqual([])
    expect(await edits(other.workspaceId)).toEqual([])
  })

  it('fails clearly when the post is never delivered, or its delivery failed', async () => {
    const { workspaceId, id } = await said()
    const started = Date.now()

    await expect(runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'later', sendWaitMs: 600 })).rejects.toThrow(
      `${id} has not been posted yet, so it cannot be edited`,
    )
    // It polled for the whole bounded wait, not just once.
    expect(Date.now() - started).toBeGreaterThanOrEqual(600)

    await pool.query(`UPDATE outbox SET status = 'failed' WHERE id = $1`, [id])
    await expect(runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'later', sendWaitMs: 0 })).rejects.toThrow('its delivery failed')
    await expect(runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: '  ' })).rejects.toThrow('nothing to edit to')
    expect(await edits(workspaceId)).toEqual([])
  })
})
