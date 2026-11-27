import { randomUUID } from 'node:crypto'
import { App } from '@slack/bolt'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGatedSocketModeReceiver } from '../../src/chat/slack/api-client.js'
import { SHELL_PASSWORD_CALLBACK_ID } from '../../src/chat/slack/shell-password.js'
import { applyMigrations, newestMigrationName } from '../../src/db/migrate.js'
import { closePool, connectListenConnection, createPool } from '../../src/db/pool.js'
import { recordButtonMessage, recordThreadOwner } from '../../src/failover/inbound.js'
import { claimLease, publishReminderChannels, registerHost } from '../../src/failover/lease.js'
import { InboundRouter, namedLaptop, offlineText, queuedText, routeNoteOf, withoutLaptopName, type ReceivedEnvelope } from '../../src/failover/route.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { createLogger } from '../../src/obs/logger.js'
import { getTestDatabaseUrl } from '../support/database.js'

const BUILD = newestMigrationName('src/db/migrations')
const BOT = 'UBOT'
const log = createLogger('fatal')

describe('failover routing', () => {
  let pool: Pool
  let url: string
  let workspaceId: string
  let hassan: string
  let zubair: string
  const routers: InboundRouter[] = []

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    url = databaseUrl
    pool = createPool(databaseUrl, { max: 6 })
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  beforeEach(async () => {
    for (const router of routers.splice(0)) await router.stop()
    workspaceId = await resolveWorkspaceId(pool, 'slack', `T-${randomUUID()}`)
    await pool.query('UPDATE failover_lease SET holder = NULL, renewed_at = NULL, expires_at = NULL')
    await pool.query('DELETE FROM failover_hosts')
    hassan = 'hassan-mbp'
    zubair = 'zubair-mbp'
    await registerHost(pool, { name: hassan, home: '/Users/hassan', buildMigration: BUILD, preferred: true })
    await registerHost(pool, { name: zubair, home: '/Users/zubair', buildMigration: BUILD, preferred: false })
  })

  type Laptop = { router: InboundRouter; handled: Record<string, unknown>[]; posts: { channel: string; thread: string; text: string }[] }

  function laptop(host: string, options: { forwardKey?: string; answer?: (body: Record<string, unknown>) => unknown } = {}): Laptop {
    const router = new InboundRouter({ pool, host, log, pollMs: 50, popupWaitMs: 1500, connectListener: () => connectListenConnection(url), ...(options.forwardKey ? { forwardKey: options.forwardKey } : {}) })
    routers.push(router)
    const handled: Record<string, unknown>[] = []
    const posts: Laptop['posts'] = []
    router.bind({ workspaceId, botUserId: BOT, post: async (channel, thread, text) => void posts.push({ channel, thread, text }) })
    router.useProcessor(async (event) => {
      handled.push(event.body)
      const key = messageKey(event.body)
      if (key !== undefined && !(await router.claimMessage(event.body, key))) handled.pop()
      if (options.answer) await event.ack(options.answer(event.body))
    })
    return { router, handled, posts }
  }

  function messageKey(body: Record<string, unknown>): string | undefined {
    const event = body.event as { channel?: string; ts?: string } | undefined
    return event?.channel !== undefined && event.ts !== undefined ? `${event.channel}:${event.ts}` : undefined
  }

  function mention(text: string, extra: { ts?: string; thread_ts?: string; type?: string; user?: string; eventId?: string } = {}): Record<string, unknown> {
    const ts = extra.ts ?? `${Date.now()}.${Math.floor(Math.random() * 1e6)}`
    return {
      type: 'event_callback',
      event_id: extra.eventId ?? `Ev${randomUUID()}`,
      event: { type: extra.type ?? 'app_mention', user: extra.user ?? 'U1', text, ts, channel: 'C1', ...(extra.thread_ts ? { thread_ts: extra.thread_ts } : {}) },
    }
  }

  async function receive(at: Laptop, body: Record<string, unknown>): Promise<ReturnType<typeof vi.fn>> {
    const ack = vi.fn(async (_response?: unknown) => {})
    await at.router.handle({ body, ack } as ReceivedEnvelope, async () => undefined)
    return ack
  }

  const eventText = (body: Record<string, unknown> | undefined): unknown => (body?.event as { text?: string } | undefined)?.text

  describe('the receiver', () => {
    async function deliver(router: InboundRouter, body: Record<string, unknown>): Promise<{ ack: ReturnType<typeof vi.fn>; heard: string[]; savedAtAck: boolean[] }> {
      const receiver = createGatedSocketModeReceiver('xapp-test', router)
      const app = new App({ receiver, authorize: async () => ({ botToken: 'xoxb-test', botUserId: BOT }) })
      const heard: string[] = []
      app.event('app_mention', async ({ event }) => void heard.push(event.text))
      const savedAtAck: boolean[] = []
      const ack = vi.fn(async () => {
        const { rows } = await pool.query('SELECT 1 FROM inbound_events WHERE dedupe_key = $1', [`event:${String(body.event_id)}`])
        savedAtAck.push(rows.length === 1)
      })
      receiver.client.emit('slack_event', { ack, retry_num: 0, retry_reason: '', body: { team_id: 'T1', api_app_id: 'A1', event_time: 1, ...body } })
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { ack, heard, savedAtAck }
    }

    it('acknowledges an envelope only once its row is saved, and runs it here', async () => {
      const { router } = laptop(hassan)
      const { ack, heard, savedAtAck } = await deliver(router, mention(`<@${BOT}> hi`))
      expect(ack).toHaveBeenCalledTimes(1)
      expect(savedAtAck).toEqual([true])
      expect(heard).toEqual([`<@${BOT}> hi`])
    })

    it('leaves an envelope unacknowledged when the database cannot save it, so Slack sends it again', async () => {
      const broken = createPool('postgres://relay:relay@127.0.0.1:1/relay_test', { connectTimeoutMs: 200 })
      const router = new InboundRouter({ pool: broken, host: hassan, log })
      router.bind({ workspaceId, botUserId: BOT, post: async () => undefined })
      const { ack, heard } = await deliver(router, mention(`<@${BOT}> hi`))
      expect(ack).not.toHaveBeenCalled()
      expect(heard).toEqual([])
      await closePool(broken)
    })

    it('runs the same event id once when Slack delivers it twice', async () => {
      const { router } = laptop(hassan)
      const body = mention(`<@${BOT}> once`)
      const first = await deliver(router, body)
      const second = await deliver(router, body)
      expect(first.heard).toEqual([`<@${BOT}> once`])
      expect(second.heard).toEqual([])
      expect(second.ack).toHaveBeenCalledTimes(1)
    })
  })

  it('passes "@relay zubair-mbp hi" received by hassan-mbp to zubair-mbp, with "hi" as the prompt', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    const ack = await receive(h, mention(`<@${BOT}> ${zubair} hi`))
    expect(ack).toHaveBeenCalledTimes(1)
    expect(h.handled).toHaveLength(0)
    await z.router.drain()
    expect(z.handled.map(eventText)).toEqual([`<@${BOT}> hi`])
    expect(routeNoteOf(z.handled[0] ?? {})?.guestHost).toBeUndefined()
  })

  it('in a DM, sends a message whose first word is a laptop name to that laptop, without the name', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await claimLease(pool, hassan)
    const dm = (text: string) => {
      const body = mention(text, { type: 'message' })
      ;(body.event as Record<string, unknown>).channel = 'D1'
      ;(body.event as Record<string, unknown>).channel_type = 'im'
      return body
    }
    await receive(h, dm(`${zubair}\n! git status`))
    await receive(h, dm(`<@${BOT}> ${zubair} hi`))
    await z.router.drain()
    expect(z.handled.map(eventText).sort()).toEqual(['! git status', `<@${BOT}> hi`].sort())
    // A DM that does not start with a laptop name stays with the default laptop.
    await receive(h, dm(`! git status`))
    expect(h.handled.map(eventText)).toEqual(['! git status'])
  })

  it('reads a laptop name followed by a comma or colon, and drops it with the name', () => {
    expect(namedLaptop(`<@${BOT}> ${zubair}, status`, BOT, [hassan, zubair])).toBe(zubair)
    expect(withoutLaptopName(`<@${BOT}> ${zubair}: git status`, BOT, zubair)).toBe(`<@${BOT}> git status`)
    expect(withoutLaptopName(`${zubair}, stop`, BOT, zubair, true)).toBe('stop')
  })

  it('outside a DM, a laptop name counts only after the mention', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await claimLease(pool, hassan)
    await receive(h, mention(`${zubair}\n! git status`, { type: 'message' }))
    await z.router.drain()
    expect(z.handled).toHaveLength(0)
    expect(h.handled.map(eventText)).toEqual([`${zubair}\n! git status`])
  })

  it('reads a laptop name in any case', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await receive(h, mention(`<@${BOT}> Zubair-MBP hi`))
    await z.router.drain()
    expect(z.handled.map(eventText)).toEqual([`<@${BOT}> hi`])
  })

  it('posts the queued note once per outage when the thread\'s run is still going on its offline laptop, across both laptops', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await claimLease(pool, hassan)
    const principal = await pool.query<{ id: string }>(
      `INSERT INTO principals (id, workspace_id, platform, platform_user_id, display_name, roles) VALUES ($1, $2, 'slack', $3, 'P', ARRAY['owner']) RETURNING id`,
      [`prn_${randomUUID()}`, workspaceId, `U${randomUUID()}`],
    )
    const session = await pool.query<{ id: string }>(`INSERT INTO sessions (workspace_id, principal_id, adapter, thread_ref, mode) VALUES ($1, $2, 'slack', 'C1:600.1', 'autonomous') RETURNING id`, [workspaceId, principal.rows[0]!.id])
    await pool.query(`INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id, worker_pid, worker_pgid, worker_host) VALUES ($1, $2, $3, 4242, 4242, $4)`, [workspaceId, session.rows[0]!.id, principal.rows[0]!.id, zubair])
    await recordThreadOwner(pool, workspaceId, 'slack', 'C1:600.1', zubair)
    await pool.query("UPDATE failover_hosts SET last_seen_at = now() - interval '2 minutes' WHERE name = $1", [zubair])
    // A third laptop that is online stands in for the second receiver: the offline one receives nothing.
    await registerHost(pool, { name: 'third-mbp', home: '/Users/t', buildMigration: BUILD, preferred: false })
    const t = laptop('third-mbp')

    await receive(h, mention('one', { type: 'message', thread_ts: '600.1' }))
    await receive(t, mention('two', { type: 'message', thread_ts: '600.1' }))
    await receive(h, mention('three', { type: 'message', thread_ts: '600.1' }))
    expect([...h.posts, ...t.posts, ...z.posts].map((post) => post.text)).toEqual([queuedText(zubair)])
  })

  it('while paused saves and acknowledges, then on resume handles exactly what it held', async () => {
    const h = laptop(hassan)
    await claimLease(pool, hassan)
    h.router.setPaused(true)
    const ack = await receive(h, mention(`<@${BOT}> held`))
    expect(ack).toHaveBeenCalledTimes(1)
    expect(h.handled).toHaveLength(0)
    // A row of this laptop's still being handled live is not taken again by the resume.
    await pool.query(
      `INSERT INTO inbound_events (workspace_id, dedupe_key, kind, received_by, claimed_by, claim_generation, payload) VALUES ($1, 'event:live', 'event', $2, $2, 1, $3)`,
      [workspaceId, hassan, JSON.stringify(mention(`<@${BOT}> in flight`))],
    )
    h.router.setPaused(false)
    await h.router.drain()
    expect(h.handled.map(eventText)).toEqual([`<@${BOT}> held`])
  })

  it('keeps a held envelope when the database fails while resuming, and handles it on the next pass', async () => {
    const h = laptop(hassan)
    await claimLease(pool, hassan)
    h.router.setPaused(true)
    await receive(h, mention(`<@${BOT}> kept`))
    const query = pool.query.bind(pool)
    let failed = false
    const spy = vi.spyOn(pool, 'query').mockImplementation(((sql: unknown, ...rest: unknown[]) => {
      if (!failed && typeof sql === 'string' && sql.includes("state = 'received' RETURNING")) {
        failed = true
        return Promise.reject(new Error('connection lost'))
      }
      return (query as (...args: unknown[]) => unknown)(sql, ...rest)
    }) as typeof pool.query)
    h.router.setPaused(false)
    await h.router.drain()
    spy.mockRestore()
    expect(failed).toBe(true)
    expect(h.handled).toHaveLength(0)
    await h.router.drain()
    expect(h.handled.map(eventText)).toEqual([`<@${BOT}> kept`])
  })

  it('turns "@relay zubair-mbp stop" into a plain stop for zubair-mbp', () => {
    expect(withoutLaptopName(`<@${BOT}> ${zubair} stop`, BOT, zubair)).toBe('stop')
    expect(withoutLaptopName(`<@${BOT}> ${zubair} stop the build`, BOT, zubair)).toBe(`<@${BOT}> stop the build`)
    expect(withoutLaptopName(`<@${BOT}> ${zubair}`, BOT, zubair)).toBe(`<@${BOT}>`)
  })

  it('answers "is offline" for a named laptop that is not ready, once for the mention and its message copy', async () => {
    const h = laptop(hassan)
    await pool.query("UPDATE failover_hosts SET last_seen_at = now() - interval '2 minutes' WHERE name = $1", [zubair])
    const ts = '100.1'
    await receive(h, mention(`<@${BOT}> ${zubair} hi`, { ts }))
    await receive(h, mention(`<@${BOT}> ${zubair} hi`, { ts, type: 'message' }))
    expect(h.posts).toEqual([{ channel: 'C1', thread: ts, text: offlineText(zubair) }])
    expect(h.handled).toHaveLength(0)
  })

  it('sends a plain reply in a zubair-mbp thread to zubair-mbp, and to the default laptop once zubair-mbp is offline', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await recordThreadOwner(pool, workspaceId, 'slack', 'C1:200.1', zubair)
    await receive(h, mention('more please', { type: 'message', thread_ts: '200.1' }))
    await z.router.drain()
    expect(z.handled.map(eventText)).toEqual(['more please'])

    await pool.query("UPDATE failover_hosts SET last_seen_at = now() - interval '2 minutes' WHERE name = $1", [zubair])
    await claimLease(pool, hassan)
    await receive(h, mention('and this', { type: 'message', thread_ts: '200.1' }))
    expect(h.handled.map(eventText)).toEqual(['and this'])
  })

  it('makes "@relay zubair-mbp" in a hassan-mbp thread a guest turn on zubair-mbp, and leaves plain messages with hassan-mbp', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await recordThreadOwner(pool, workspaceId, 'slack', 'C1:300.1', hassan)
    await receive(z, mention(`<@${BOT}> ${zubair} what is 2+2`, { thread_ts: '300.1' }))
    await z.router.drain()
    expect(z.handled.map(eventText)).toEqual([`<@${BOT}> what is 2+2`])
    expect(routeNoteOf(z.handled[0] ?? {})?.guestHost).toBe(zubair)

    await receive(z, mention('plain follow-up', { type: 'message', thread_ts: '300.1' }))
    await h.router.drain()
    expect(h.handled.map(eventText)).toEqual(['plain follow-up'])
  })

  it('runs a mention and its plain message copy once when each lands on a different laptop', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await claimLease(pool, hassan)
    const ts = '400.1'
    await receive(h, mention(`<@${BOT}> hello`, { ts }))
    await receive(z, mention(`<@${BOT}> hello`, { ts, type: 'message' }))
    await h.router.drain()
    expect(h.handled.map(eventText)).toEqual([`<@${BOT}> hello`])
    expect(z.handled).toHaveLength(0)
  })

  it('passes a Slackbot reminder to the laptop whose config lists that channel', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await publishReminderChannels(pool, zubair, ['C1'])
    await receive(h, mention(`Reminder: <@${BOT}> check the deploy`, { type: 'message', user: 'USLACKBOT' }))
    await z.router.drain()
    expect(z.handled.map(eventText)).toEqual([`Reminder: <@${BOT}> check the deploy`])
    expect(h.handled).toHaveLength(0)
  })

  it('passes a button click to the laptop that posted the buttons', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair)
    await recordButtonMessage(pool, workspaceId, 'C1', '500.1', zubair)
    await receive(h, { type: 'block_actions', user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '500.1' }, actions: [{ action_id: 'relay_session_attach', action_ts: '500.2' }] })
    await z.router.drain()
    expect(z.handled).toHaveLength(1)
    expect(h.handled).toHaveLength(0)
  })

  it('acknowledges a popup received on the other laptop with the owner\'s answer, so a validation error still shows', async () => {
    const h = laptop(hassan)
    const z = laptop(zubair, { answer: () => ({ response_action: 'errors', errors: { edit: 'That is not valid JSON.' } }) })
    await z.router.start()
    const ack = await receive(h, { type: 'view_submission', user: { id: 'U1' }, view: { id: 'V1', hash: 'h1', callback_id: 'relay_edit', private_metadata: JSON.stringify({ approvalId: 'a', channel: 'C1', messageTs: '1.1', relay_host: zubair }), state: { values: {} } } })
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: { edit: 'That is not valid JSON.' } })
  })

  it('never saves a typed password readable, and the owner laptop still gets it', async () => {
    const key = 'shared forward key'
    const h = laptop(hassan, { forwardKey: key })
    const z = laptop(zubair, { forwardKey: key })
    const password = `pw-${randomUUID()}`
    await receive(h, {
      type: 'view_submission',
      user: { id: 'U1' },
      view: { id: 'V2', hash: 'h2', callback_id: SHELL_PASSWORD_CALLBACK_ID, private_metadata: JSON.stringify({ requestId: 'r1', relay_host: zubair }), state: { values: { shell_password: { value: { type: 'plain_text_input', value: password } } } } },
    })
    const { rows } = await pool.query<{ text: string }>("SELECT coalesce(payload::text, '') || encode(coalesce(secret, ''::bytea), 'escape') AS text FROM inbound_events WHERE workspace_id = $1", [workspaceId])
    expect(rows.some((row) => row.text.includes(password))).toBe(false)
    await z.router.drain()
    expect(JSON.stringify(z.handled[0])).toContain(password)
    const after = await pool.query("SELECT 1 FROM inbound_events WHERE workspace_id = $1 AND (payload IS NOT NULL OR secret IS NOT NULL)", [workspaceId])
    expect(after.rows).toHaveLength(0)
  })

  it('takes back a row claimed by a laptop that went offline and runs it on the default laptop', async () => {
    const h = laptop(hassan)
    await claimLease(pool, hassan)
    await pool.query(
      `INSERT INTO inbound_events (workspace_id, dedupe_key, kind, received_by, claimed_by, claim_generation, payload)
       VALUES ($1, 'event:stuck', 'event', $2, $2, 1, $3)`,
      [workspaceId, zubair, JSON.stringify(mention(`<@${BOT}> stuck`))],
    )
    await pool.query("UPDATE failover_hosts SET last_seen_at = now() - interval '2 minutes' WHERE name = $1", [zubair])
    await h.router.drain()
    expect(h.handled.map(eventText)).toEqual([`<@${BOT}> stuck`])
  })
})
