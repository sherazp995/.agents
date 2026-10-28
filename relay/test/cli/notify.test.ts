import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NOTIFY_MAX_CHARS, runNotify } from '../../src/cli/notify.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { registerSecretValue } from '../../src/secrets/scrubber.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { findActiveSession } from '../../src/sessions/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('relay notify', () => {
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

  async function setup(): Promise<{ workspaceId: string; operator: string; member: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const operator = `U_${randomUUID()}`
    const member = `U_${randomUUID()}`
    await provisionPrincipal(pool, workspaceId, 'slack', operator, 'Operator', ['operator'])
    await provisionPrincipal(pool, workspaceId, 'slack', member, 'Member', ['member'])
    return { workspaceId, operator, member }
  }

  async function queued(workspaceId: string): Promise<unknown[]> {
    const { rows } = await pool.query<{ action: unknown }>('SELECT action FROM outbox WHERE workspace_id = $1', [workspaceId])
    return rows.map((row) => row.action)
  }

  it('queues a scrubbed DM to the operators by default', async () => {
    const { workspaceId, operator } = await setup()
    const secret = `sk-notify-${randomUUID()}`
    registerSecretValue(secret)

    expect(await runNotify(pool, { workspaceId, text: ` Done, token ${secret} ` })).toEqual([{ userId: operator, attached: false, fileQueued: false }])
    const [action] = await queued(workspaceId)
    expect(action).toMatchObject({ kind: 'post', ref: { channel: operator } })
    expect(JSON.stringify(action)).not.toContain(secret)
  })

  it('sends to a mapped --to user and refuses an unmapped one', async () => {
    const { workspaceId, member } = await setup()

    expect(await runNotify(pool, { workspaceId, to: member, text: 'hi' })).toEqual([{ userId: member, attached: false, fileQueued: false }])
    await expect(runNotify(pool, { workspaceId, to: 'U_STRANGER', text: 'hi' })).rejects.toThrow('not a mapped principal')
  })

  it('attaches the sent DM thread to the calling chat, and gives up when the daemon does not send it', async () => {
    const { workspaceId, operator } = await setup()
    const attach = { engineSessionId: randomUUID(), cwd: '/Users/someone/project' }
    const ts = `${Date.now()}.1`
    // Stands in for the daemon's drain: marks each queued row sent, as the Slack DM channel.
    const drain = setInterval(() => {
      void pool.query(`UPDATE outbox SET status = 'sent', sent_ref = jsonb_build_object('channel', 'D1', 'message', $2::text) WHERE workspace_id = $1 AND sent_ref IS NULL`, [workspaceId, ts])
    }, 100)
    try {
      expect(await runNotify(pool, { workspaceId, text: 'done', attach })).toEqual([{ userId: operator, attached: true, fileQueued: false }])
    } finally {
      clearInterval(drain)
    }
    const session = await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: `D1:${ts}` })
    expect(session).toMatchObject({ engineSessionId: attach.engineSessionId, engineCwd: attach.cwd, courierTarget: null })

    expect(await runNotify(pool, { workspaceId, text: 'unsent', attach, sendWaitMs: 0 })).toEqual([{ userId: operator, attached: false, fileQueued: false }])
  })

  it('with --peer, claims the thread for that exact chat so replies skip the process scan', async () => {
    const { workspaceId } = await setup()
    const ts = `${Date.now()}.2`
    const drain = setInterval(() => {
      void pool.query(`UPDATE outbox SET status = 'sent', sent_ref = jsonb_build_object('channel', 'D2', 'message', $2::text) WHERE workspace_id = $1 AND sent_ref IS NULL`, [workspaceId, ts])
    }, 100)
    try {
      await runNotify(pool, { workspaceId, text: 'done', attach: { engineSessionId: randomUUID(), cwd: '/p', peer: 'agents-39 [a1a227]' } })
    } finally {
      clearInterval(drain)
    }
    const { rows } = await pool.query<{ courier_target: string; claimed: boolean }>(
      `SELECT courier_target, live_control_claimed_at IS NOT NULL AS claimed FROM sessions WHERE workspace_id = $1 AND thread_ref = $2`,
      [workspaceId, `D2:${ts}`],
    )
    expect(rows).toEqual([{ courier_target: 'agents-39 [a1a227]', claimed: true }])
  })

  it('posts a file in the DM thread once the DM is sent, and refuses a missing file before queueing anything', async () => {
    const { workspaceId } = await setup()
    const ts = `${Date.now()}.3`
    const dir = mkdtempSync(join(tmpdir(), 'relay-notify-'))
    const plan = join(dir, 'plan.md')
    writeFileSync(plan, '# Plan\n')
    const drain = setInterval(() => {
      void pool.query(`UPDATE outbox SET status = 'sent', sent_ref = jsonb_build_object('channel', 'D3', 'message', $2::text) WHERE workspace_id = $1 AND sent_ref IS NULL AND action->>'kind' = 'post'`, [workspaceId, ts])
    }, 100)
    try {
      expect(await runNotify(pool, { workspaceId, text: 'Plan to review', file: plan })).toEqual([expect.objectContaining({ fileQueued: true })])
    } finally {
      clearInterval(drain)
    }
    const upload = (await queued(workspaceId)).find((action) => (action as { kind: string }).kind === 'upload')
    expect(upload).toMatchObject({ kind: 'upload', ref: { channel: 'D3', thread: ts }, filename: 'plan.md', path: plan })

    const before = (await queued(workspaceId)).length
    await expect(runNotify(pool, { workspaceId, text: 'x', file: join(dir, 'missing.md') })).rejects.toThrow('is not a file')
    expect(await queued(workspaceId)).toHaveLength(before)
  })

  it('refuses an empty or long message and queues nothing', async () => {
    const { workspaceId } = await setup()

    await expect(runNotify(pool, { workspaceId, text: '  ' })).rejects.toThrow('empty')
    await expect(runNotify(pool, { workspaceId, text: 'x'.repeat(NOTIFY_MAX_CHARS + 1) })).rejects.toThrow('Keep it short')
    expect(await queued(workspaceId)).toEqual([])
  })
})
