import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, newestMigrationName } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { acceptInbound, claimInbound, inboundIdentity, saveInbound } from '../../src/failover/inbound.js'
import { registerHost } from '../../src/failover/lease.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

const BUILD = newestMigrationName('src/db/migrations')

describe('saved Slack envelopes', () => {
  let pool: Pool
  let workspaceId: string

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl, { max: 4 })
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  beforeEach(async () => {
    workspaceId = await resolveWorkspaceId(pool, 'slack', `T-${randomUUID()}`)
    await pool.query('DELETE FROM failover_hosts')
    await registerHost(pool, { name: 'hassan-mbp', home: '/Users/h', buildMigration: BUILD, preferred: true })
    await registerHost(pool, { name: 'zubair-mbp', home: '/Users/z', buildMigration: BUILD, preferred: false })
  })

  const save = (dedupeKey: string, host: string) =>
    saveInbound(pool, { workspaceId, dedupeKey, kind: 'event', host, payload: { type: 'event_callback' }, secret: null })

  it('keys an event by its id, a click by its timestamp and user, and a popup by its id and hash', () => {
    expect(inboundIdentity({ type: 'event_callback', event_id: 'Ev1' })).toEqual({ kind: 'event', dedupeKey: 'event:Ev1' })
    expect(inboundIdentity({ type: 'block_actions', user: { id: 'U1' }, actions: [{ action_ts: '9.9' }] })).toEqual({ kind: 'action', dedupeKey: 'action:9.9:U1' })
    expect(inboundIdentity({ type: 'view_submission', view: { id: 'V1', hash: 'h1' } })).toEqual({ kind: 'view', dedupeKey: 'view:V1:h1' })
    // The same popup submitted again after an edit has a new hash, so it is a new envelope.
    expect(inboundIdentity({ type: 'view_submission', view: { id: 'V1', hash: 'h2' } })?.dedupeKey).toBe('view:V1:h2')
    expect(inboundIdentity({ type: 'slash_commands' })).toBeUndefined()
  })

  it('returns the first row, not fresh, for a second delivery of the same envelope', async () => {
    const first = await save('event:dup', 'hassan-mbp')
    const second = await save('event:dup', 'zubair-mbp')
    expect([first.fresh, second.fresh]).toEqual([true, false])
    expect(second.row.id).toBe(first.row.id)
  })

  it('a slow laptop whose claim was taken back cannot also accept the row', async () => {
    const { row: slow } = await save('event:slow', 'zubair-mbp')
    await pool.query("UPDATE failover_hosts SET last_seen_at = now() - interval '2 minutes' WHERE name = 'zubair-mbp'")
    const [retaken] = await claimInbound(pool, workspaceId, 'hassan-mbp', new Date())
    expect(retaken?.id).toBe(slow.id)
    expect(await acceptInbound(pool, slow, 'zubair-mbp')).toBe('lost')
    expect(await acceptInbound(pool, retaken!, 'hassan-mbp')).toBe('accepted')
  })

  it('never hands out an accepted row again, even once its laptop went quiet', async () => {
    const { row } = await save('event:accepted', 'zubair-mbp')
    expect(await acceptInbound(pool, row, 'zubair-mbp')).toBe('accepted')
    await pool.query("UPDATE failover_hosts SET last_seen_at = now() - interval '2 minutes' WHERE name = 'zubair-mbp'")
    expect(await claimInbound(pool, workspaceId, 'hassan-mbp', new Date())).toEqual([])
  })

  it('lets the row that owns a message key accept again, and finishes a second row for the same message as a duplicate', async () => {
    const { row: mention } = await save('event:m', 'hassan-mbp')
    const { row: copy } = await save('event:c', 'hassan-mbp')
    expect(await acceptInbound(pool, mention, 'hassan-mbp', 'C1:1.1')).toBe('accepted')
    expect(await acceptInbound(pool, mention, 'hassan-mbp', 'C1:1.1')).toBe('accepted')
    expect(await acceptInbound(pool, copy, 'hassan-mbp', 'C1:1.1')).toBe('duplicate')
    const { rows } = await pool.query<{ state: string; payload: unknown }>('SELECT state, payload FROM inbound_events WHERE id = $1', [copy.id])
    expect(rows[0]).toEqual({ state: 'done', payload: null })
  })
})
