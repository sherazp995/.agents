import { randomUUID } from 'node:crypto'
import { pino } from 'pino'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runLiveEdit, runLiveReact, runLiveSay } from '../../src/cli/live.js'
import { MockAdapter } from '../../src/chat/mock.js'
import type { ChatAdapter } from '../../src/chat/contract.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { OutboundDispatcher, queueStampedPost } from '../../src/dispatch/outbound.js'
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

  /** The dispatch id say stamped on its post, which the edit must name. */
  async function dispatchIdOf(id: string): Promise<string> {
    const { rows } = await pool.query<{ message: string }>(`SELECT action->'ref'->>'message' AS message FROM outbox WHERE id = $1`, [id])
    const message = rows[0]?.message
    if (!message) throw new Error(`say stamped no dispatch id on ${id}`)
    return message
  }

  async function edits(workspaceId: string): Promise<unknown[]> {
    const { rows } = await pool.query<{ action: { kind: string } }>('SELECT action FROM outbox WHERE workspace_id = $1', [workspaceId])
    return rows.map((row) => row.action).filter((action) => action.kind === 'edit')
  }

  it('queues a Markdown edit naming the post by its dispatch id, with secrets scrubbed, without waiting for delivery', async () => {
    const { workspaceId, id } = await said()
    registerSecretValue('edit-test-secret-value')

    const out = await runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: ' **Step 2 of 3** edit-test-secret-value ' })

    expect(out).toBe(`queued an edit of ${id} in D1:1.1; the relay daemon updates it.`)
    expect(await edits(workspaceId)).toEqual([
      { kind: 'edit', ref: { channel: 'D1', thread: '1.1', message: await dispatchIdOf(id) }, text: '**Step 2 of 3** [redacted secret]', markdown: true },
    ])
  })

  /** The daemon's own dispatcher over a mock Slack adapter, bound to the workspace. */
  async function daemon(workspaceId: string): Promise<{ slack: MockAdapter; dispatcher: OutboundDispatcher }> {
    const slack = new MockAdapter()
    await slack.start(async () => {})
    const named: ChatAdapter = { name: 'slack', capabilities: slack.capabilities, start: (h) => slack.start(h), stop: () => slack.stop(), perform: (a) => slack.perform(a) }
    // A second ahead: rows carry Postgres's microsecond now(), so a row queued in this same millisecond is not yet due on a millisecond clock.
    return { slack, dispatcher: new OutboundDispatcher(pool, named, workspaceId, { backoffMs: () => 0, dependencyRetryMs: 0, now: () => new Date(Date.now() + 1000) }) }
  }

  async function outboxStates(workspaceId: string): Promise<unknown[]> {
    const { rows } = await pool.query(`SELECT action->>'kind' AS kind, status, last_error FROM outbox WHERE workspace_id = $1 ORDER BY created_at`, [workspaceId])
    return rows
  }

  it('edits the posted Slack message when the daemon drains an edit made after the post was sent', async () => {
    const { workspaceId, id } = await said()
    const { slack, dispatcher } = await daemon(workspaceId)
    await dispatcher.drain()
    const post = slack.performed.find((action) => action.kind === 'post')
    expect(post).toMatchObject({ text: 'Working on it.' })

    await runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'Step 2 of 3' })
    await dispatcher.drain()

    expect(await outboxStates(workspaceId)).toEqual([
      { kind: 'post', status: 'sent', last_error: null },
      { kind: 'edit', status: 'sent', last_error: null },
    ])
    expect(slack.performed.find((action) => action.kind === 'edit')).toMatchObject({ kind: 'edit', text: 'Step 2 of 3' })
  })

  it('holds an edit claimed before its post until the post lands, then edits the posted message', async () => {
    const { workspaceId, id } = await said()
    await runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'Step 2 of 3' })
    // The edit is due first, so the drain claims it before its post.
    await pool.query(`UPDATE outbox SET next_attempt_at = next_attempt_at - interval '1 minute' WHERE workspace_id = $1 AND action->>'kind' = 'edit'`, [workspaceId])
    const { slack, dispatcher } = await daemon(workspaceId)

    await dispatcher.drain()
    expect(await outboxStates(workspaceId)).toEqual([
      { kind: 'post', status: 'sent', last_error: null },
      { kind: 'edit', status: 'pending', last_error: null },
    ])
    await dispatcher.drain()

    expect(await outboxStates(workspaceId)).toEqual([
      { kind: 'post', status: 'sent', last_error: null },
      { kind: 'edit', status: 'sent', last_error: null },
    ])
    const { rows } = await pool.query<{ ts: string }>(`SELECT ref->>'message' AS ts FROM outbound_dispatch_refs WHERE dispatch_id = $1`, [await dispatchIdOf(id)])
    expect(slack.performed.map((action) => action.kind)).toEqual(['post', 'edit'])
    expect(slack.performed[1]).toMatchObject({ kind: 'edit', ref: { message: rows[0]?.ts }, text: 'Step 2 of 3' })
  })

  it('holds a post queued after another until that one lands, so a long report keeps its order', async () => {
    const { workspaceId } = await said()
    const ref = { channel: 'D1', thread: '1.1' }
    const queue = async (text: string, after?: string) => {
      const client = await pool.connect()
      try {
        return await queueStampedPost(client, { workspaceId, adapterName: 'slack', action: { kind: 'post', ref, text, markdown: true, ...(after !== undefined ? { after } : {}) }, at: new Date() })
      } finally {
        client.release()
      }
    }
    const first = await queue('Part 1')
    const second = await queue('Part 2', first.dispatchId)
    // Part 2 is due first, and before the status post too.
    await pool.query(`UPDATE outbox SET next_attempt_at = next_attempt_at - interval '1 minute' WHERE id = $1`, [second.outboxId])
    const { slack, dispatcher } = await daemon(workspaceId)

    await dispatcher.drain()
    await dispatcher.drain()

    expect(slack.performed.map((action) => (action.kind === 'post' ? action.text : action.kind))).toEqual(['Working on it.', 'Part 1', 'Part 2'])
    // The dependency is Relay's own, never sent to Slack.
    expect(slack.performed.every((action) => !('after' in action))).toBe(true)
  })

  /** Queues a stamped post in the status thread, as the scheduler does for each report part. */
  async function queuePart(workspaceId: string, text: string, after?: string): Promise<{ outboxId: string; dispatchId: string }> {
    const client = await pool.connect()
    try {
      return await queueStampedPost(client, { workspaceId, adapterName: 'slack', action: { kind: 'post', ref: { channel: 'D1', thread: '1.1' }, text, markdown: true, ...(after !== undefined ? { after } : {}) }, at: new Date() })
    } finally {
      client.release()
    }
  }

  async function rowState(id: string): Promise<{ status: string; attempts: number } | undefined> {
    return (await pool.query<{ status: string; attempts: number }>('SELECT status, attempts FROM outbox WHERE id = $1', [id])).rows[0]
  }

  /** A daemon whose clock is two minutes past a one-minute dependency deadline, as after a long Slack outage. */
  async function pastDeadline(workspaceId: string, db: Pool = pool): Promise<{ slack: MockAdapter; dispatcher: OutboundDispatcher }> {
    const slack = new MockAdapter()
    await slack.start(async () => {})
    const named: ChatAdapter = { name: 'slack', capabilities: slack.capabilities, start: (h) => slack.start(h), stop: () => slack.stop(), perform: (a) => slack.perform(a) }
    const twoMinutesOn = () => new Date(Date.now() + 2 * 60 * 1000)
    return { slack, dispatcher: new OutboundDispatcher(db, named, workspaceId, { backoffMs: () => 0, dependencyRetryMs: 0, dependencyDeadlineMs: 60_000, now: twoMinutesOn }) }
  }

  /** Holds a post back the way a long outage does: still pending, but out of the next drain's reach. */
  const holdBack = (id: string) => pool.query(`UPDATE outbox SET next_attempt_at = now() + interval '1 day' WHERE id = $1`, [id])
  const release = (id: string) => pool.query(`UPDATE outbox SET next_attempt_at = now() WHERE id = $1`, [id])

  it('keeps a later report part waiting past the deadline while the part before it is still queued, and fails it once that part failed', async () => {
    const { workspaceId } = await said()
    const first = await queuePart(workspaceId, 'Part 1')
    const second = await queuePart(workspaceId, 'Part 2', first.dispatchId)
    const third = await queuePart(workspaceId, 'Part 3', second.dispatchId)
    await holdBack(first.outboxId)
    const { slack, dispatcher } = await pastDeadline(workspaceId)

    await dispatcher.drain()
    expect(await rowState(second.outboxId)).toEqual({ status: 'pending', attempts: 0 })
    expect(await rowState(third.outboxId)).toEqual({ status: 'pending', attempts: 0 })

    await release(first.outboxId)
    await dispatcher.drain()
    await dispatcher.drain()
    expect(slack.performed.flatMap((action) => (action.kind === 'post' ? [action.text] : []))).toEqual(['Working on it.', 'Part 1', 'Part 2', 'Part 3'])

    // A part whose predecessor failed for good does not wait forever: it spends its attempts, and is not sent.
    const failed = await queuePart(workspaceId, 'Part 4')
    await pool.query(`UPDATE outbox SET status = 'failed' WHERE id = $1`, [failed.outboxId])
    const orphan = await queuePart(workspaceId, 'Part 5', failed.dispatchId)
    await dispatcher.drain()
    expect(await rowState(orphan.outboxId)).toEqual({ status: 'pending', attempts: 1 })
  })

  it('keeps a status edit waiting past the deadline while its post is still queued, then edits the posted message', async () => {
    const { workspaceId, id } = await said()
    await runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'Step 2 of 3' })
    await holdBack(id)
    const { slack, dispatcher } = await pastDeadline(workspaceId)

    await dispatcher.drain()
    expect(await outboxStates(workspaceId)).toEqual([
      { kind: 'post', status: 'pending', last_error: null },
      { kind: 'edit', status: 'pending', last_error: null },
    ])

    await release(id)
    await dispatcher.drain()
    await dispatcher.drain()
    expect(slack.performed.map((action) => action.kind)).toEqual(['post', 'edit'])
    expect(await outboxStates(workspaceId)).toEqual([
      { kind: 'post', status: 'sent', last_error: null },
      { kind: 'edit', status: 'sent', last_error: null },
    ])
  })

  it('fails a status edit past the deadline once its post failed for good, instead of waiting on itself', async () => {
    const { workspaceId, id } = await said()
    await runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'Step 2 of 3' })
    await runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'Step 3 of 3' })
    await pool.query(`UPDATE outbox SET status = 'failed' WHERE id = $1`, [id])
    const { slack, dispatcher } = await pastDeadline(workspaceId)

    await dispatcher.drain()

    const { rows } = await pool.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM outbox WHERE workspace_id = $1 AND action->>'kind' = 'edit'`, [workspaceId])
    expect(rows).toEqual([{ status: 'pending', attempts: 1 }, { status: 'pending', attempts: 1 }])
    expect(slack.performed).toEqual([])
  })

  it('uses the post when it was sent between the ref lookup and the queued check, instead of spending an attempt', async () => {
    const { workspaceId } = await said()
    const first = await queuePart(workspaceId, 'Part 1')
    const second = await queuePart(workspaceId, 'Part 2', first.dispatchId)
    await holdBack(first.outboxId)
    // The queued check is where the race lands: Part 1 is sent (its ref stored, its row marked sent) just before it reads.
    const racing = Object.create(pool) as Pool
    racing.query = (async (text: unknown, values?: unknown) => {
      if (typeof text === 'string' && text.includes("action->>'kind' IN ('post', 'post_approval_card')")) {
        await pool.query(`UPDATE outbound_dispatch_refs SET ref = $2, resolved_at = now() WHERE dispatch_id = $1`, [first.dispatchId, { channel: 'D1', thread: '1.1', message: '9.000001' }])
        await pool.query(`UPDATE outbox SET status = 'sent' WHERE id = $1`, [first.outboxId])
      }
      return pool.query(text as string, values as unknown[])
    }) as Pool['query']
    const { slack, dispatcher } = await pastDeadline(workspaceId, racing)

    await dispatcher.drain()

    // Sent on its first attempt, with no failure recorded.
    expect(await rowState(second.outboxId)).toEqual({ status: 'sent', attempts: 1 })
    expect(slack.performed.flatMap((action) => (action.kind === 'post' ? [action.text] : []))).toContain('Part 2')
  })

  it('logs every post the daemon queues, so a reply can be traced', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const lines: string[] = []
    const log = pino({}, { write: (line: string) => void lines.push(line) })
    const dispatcher = new OutboundDispatcher(pool, new MockAdapter(), workspaceId, { log })
    const client = await pool.connect()
    try {
      await dispatcher.perform({ kind: 'post', ref: { channel: 'D1' }, text: 'one' })
      await dispatcher.enqueue({ kind: 'post', ref: { channel: 'D1' }, text: 'two' }, workspaceId, client)
    } finally {
      client.release()
    }
    const enqueued = lines.map((line) => JSON.parse(line) as { msg: string; actionKind?: string }).filter((entry) => entry.msg === 'enqueued outbox action')
    expect(enqueued.map((entry) => entry.actionKind)).toEqual(['post', 'post'])
  })

  it('refuses another thread, another workspace and a non-post row, and queues nothing', async () => {
    const { workspaceId, id } = await said()
    const other = await said()
    const reacted = await runLiveReact({ pool, workspaceId, channel: 'D1', thread: '1.1', message: '9.000001', name: 'eyes' })
    expect(reacted).toContain('queued :eyes:')
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM outbox WHERE workspace_id = $1 AND action->>'kind' = 'react'`, [workspaceId])
    const reactId = rows[0]?.id ?? ''

    const edit = (params: { workspaceId: string; thread: string; id: string }) =>
      runLiveEdit({ pool, channel: 'D1', text: 'hijack', ...params })
    await expect(edit({ workspaceId, thread: '2.1', id })).rejects.toThrow(`${id} is not a message relay posted in D1:2.1`)
    await expect(edit({ workspaceId: other.workspaceId, thread: '1.1', id })).rejects.toThrow('is not a message relay posted')
    await expect(edit({ workspaceId, thread: '1.1', id: reactId })).rejects.toThrow('is not a message relay posted')
    await expect(edit({ workspaceId, thread: '1.1', id: 'not-a-uuid' })).rejects.toThrow('is not a message relay posted')
    await expect(edit({ workspaceId, thread: '1.1', id: randomUUID() })).rejects.toThrow('is not a message relay posted')

    expect(await edits(workspaceId)).toEqual([])
    expect(await edits(other.workspaceId)).toEqual([])
  })

  it('fails clearly when the post failed, was queued by an older relay, or the text is empty', async () => {
    const { workspaceId, id } = await said()
    await expect(runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: '  ' })).rejects.toThrow('nothing to edit to')

    await pool.query(`UPDATE outbox SET action = action #- '{ref,message}' WHERE id = $1`, [id])
    await expect(runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'later' })).rejects.toThrow('posted by an older relay')

    await pool.query(`UPDATE outbox SET status = 'failed' WHERE id = $1`, [id])
    await expect(runLiveEdit({ pool, workspaceId, channel: 'D1', thread: '1.1', id, text: 'later' })).rejects.toThrow('its delivery failed')
    expect(await edits(workspaceId)).toEqual([])
  })
})
