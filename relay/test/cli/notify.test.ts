import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { laptopOwner, NOTIFY_MAX_CHARS, openLinkedThread, runNotify } from '../../src/cli/notify.js'
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

  it('sends to owners and legacy operators by default, never to members', async () => {
    const { workspaceId, operator } = await setup()
    const owner = `U_${randomUUID()}`
    await provisionPrincipal(pool, workspaceId, 'slack', owner, 'Owner', ['owner'])

    const sent = await runNotify(pool, { workspaceId, text: 'Done' })
    expect(sent.map((recipient) => recipient.userId).sort()).toEqual([operator, owner].sort())
  })

  it('queues a scrubbed DM to the operators by default', async () => {
    const { workspaceId, operator } = await setup()
    const secret = `sk-notify-${randomUUID()}`
    registerSecretValue(secret)

    expect(await runNotify(pool, { workspaceId, text: ` Done, token ${secret} ` })).toEqual([{ userId: operator, attached: false, fileQueued: false }])
    const [action] = await queued(workspaceId)
    expect(action).toMatchObject({ kind: 'post', ref: { channel: operator }, markdown: true })
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

  it('opens a launcher thread in a channel, attached to the chat; unsent in time, it is cancelled and gives no thread', async () => {
    const { workspaceId, operator } = await setup()
    const engineSessionId = randomUUID()
    const ts = `${Date.now()}.5`
    const drain = setInterval(() => {
      void pool.query(`UPDATE outbox SET status = 'sent', sent_ref = jsonb_build_object('channel', 'C9', 'message', $2::text) WHERE workspace_id = $1 AND sent_ref IS NULL AND status = 'pending'`, [workspaceId, ts])
    }, 100)
    try {
      const thread = await openLinkedThread(pool, { workspaceId, owner: operator, channel: 'C9', text: 'Started', attach: { engineSessionId, cwd: '/p' }, sendWaitMs: 5_000 })
      expect(thread).toEqual({ channel: 'C9', thread: ts })
    } finally {
      clearInterval(drain)
    }
    expect(await queued(workspaceId)).toEqual([{ kind: 'post', ref: { channel: 'C9' }, text: 'Started', markdown: true }])
    expect(await findActiveSession(pool, { workspaceId, adapter: 'slack', threadRef: `C9:${ts}` })).toMatchObject({ engineSessionId, engineCwd: '/p' })

    expect(await openLinkedThread(pool, { workspaceId, owner: operator, text: 'late', sendWaitMs: 0 })).toBeNull()
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM outbox WHERE workspace_id = $1 AND action->>'text' = 'late'`, [workspaceId])
    expect(rows).toEqual([{ status: 'failed' }])
  })

  it('names the laptop owner from launcher.dm_to, else the only owner, and refuses with several', async () => {
    const { workspaceId, operator } = await setup()
    expect(await laptopOwner(pool, workspaceId, undefined)).toBe(operator)
    expect(await laptopOwner(pool, workspaceId, operator)).toBe(operator)
    await expect(laptopOwner(pool, workspaceId, 'U_UNKNOWN')).rejects.toThrow('not a mapped principal')
    await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID().slice(0, 8)}`, 'Second owner', ['owner'])
    await expect(laptopOwner(pool, workspaceId, undefined)).rejects.toThrow('set launcher.dm_to')
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
    expect(upload).toMatchObject({ kind: 'upload', ref: { channel: 'D3', thread: ts }, filename: 'plan.md', file_id: expect.any(String) })

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
