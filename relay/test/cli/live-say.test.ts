import { randomUUID } from 'node:crypto'
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runLiveSay } from '../../src/cli/live.js'
import { UPLOAD_MAX_BYTES } from '../../src/cli/upload.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('relay live say', () => {
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

  it('queues the answer in the thread for the daemon, without the bot token', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Operator', ['operator'])
    await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'D1:1.1' })

    await runLiveSay({ pool, workspaceId, channel: 'D1', thread: '1.1', text: ' Done. ' })

    const { rows } = await pool.query<{ action: unknown }>('SELECT action FROM outbox WHERE workspace_id = $1', [workspaceId])
    expect(rows.map((row) => row.action)).toEqual([{ kind: 'post', ref: { channel: 'D1', thread: '1.1' }, text: 'Done.' }])
  })

  it('attaches a file after the text, and refuses one over the size limit', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Operator', ['operator'])
    await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: 'D1:2.1' })
    const dir = mkdtempSync(join(tmpdir(), 'relay-say-'))
    writeFileSync(join(dir, 'plan.md'), '# Plan\n')
    writeFileSync(join(dir, 'big.md'), '')
    // Sparse, so the over-limit file costs no real disk.
    truncateSync(join(dir, 'big.md'), 0)
    truncateSync(join(dir, 'big.md'), UPLOAD_MAX_BYTES + 1)

    await runLiveSay({ pool, workspaceId, channel: 'D1', thread: '2.1', text: 'Plan attached.', file: join(dir, 'plan.md') })
    await expect(runLiveSay({ pool, workspaceId, channel: 'D1', thread: '2.1', text: '', file: join(dir, 'big.md') })).rejects.toThrow("Slack's limit is")

    const { rows } = await pool.query<{ action: { kind: string; filename?: string; path?: string } }>('SELECT action FROM outbox WHERE workspace_id = $1 ORDER BY created_at', [workspaceId])
    // The row holds the path, not the bytes: the daemon reads the file when it uploads.
    expect(rows.map((row) => [row.action.kind, row.action.filename, row.action.path])).toEqual([['post', undefined, undefined], ['upload', 'plan.md', join(dir, 'plan.md')]])
  })
})
