/**
 * Saved Slack envelopes (README, "Failover"). Slack hands each envelope to
 * one of the two laptops' connections, so the laptop that got it saves it
 * here before acknowledging it: a failed save throws and Slack sends it
 * again, to either laptop. A row then moves received (a laptop holds the
 * claim), forwarded (meant for another laptop, waiting for it), accepted (a
 * laptop is handling it; never replayed) and done (payload erased).
 *
 * claim_generation rises on every claim, so a slow laptop whose claim was
 * taken back cannot also accept the row.
 */
import type { Pool, PoolClient } from 'pg'
import { hostReadySql } from './ownership.js'

type Db = Pool | PoolClient

export type InboundKind = 'event' | 'action' | 'view'
export type InboundState = 'received' | 'forwarded' | 'accepted' | 'done'

export type InboundRow = {
  readonly id: string
  readonly workspaceId: string
  readonly dedupeKey: string
  readonly kind: InboundKind
  readonly receivedBy: string
  readonly targetHost: string | null
  readonly explicit: boolean
  readonly state: InboundState
  readonly claimedBy: string | null
  readonly claimGeneration: number
  readonly payload: Record<string, unknown> | null
  readonly secret: Buffer | null
  readonly response: unknown
}

type Row = {
  id: string
  workspace_id: string
  dedupe_key: string
  kind: InboundKind
  received_by: string
  target_host: string | null
  explicit: boolean
  state: InboundState
  claimed_by: string | null
  claim_generation: string
  payload: Record<string, unknown> | null
  secret: Buffer | null
  response: unknown
}

function toRow(row: Row): InboundRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    receivedBy: row.received_by,
    targetHost: row.target_host,
    explicit: row.explicit,
    state: row.state,
    claimedBy: row.claimed_by,
    claimGeneration: Number(row.claim_generation),
    payload: row.payload,
    secret: row.secret,
    response: row.response,
  }
}

/** How long a saved row may wait to be handled before it is dropped as stale. */
const OPEN_ROW_LIMIT = "interval '24 hours'"

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * The kind and duplicate key of one envelope body: Slack's event id for
 * events, the click's own timestamp plus its user for buttons, the popup id
 * plus its hash for popup submissions. Undefined for anything else, which is
 * handled where it lands without being saved.
 */
export function inboundIdentity(body: Record<string, unknown>): { kind: InboundKind; dedupeKey: string } | undefined {
  if (body.type === 'event_callback') {
    const eventId = str(body.event_id)
    return eventId === undefined ? undefined : { kind: 'event', dedupeKey: `event:${eventId}` }
  }
  if (body.type === 'block_actions') {
    const actions = Array.isArray(body.actions) ? body.actions : []
    const actionTs = str(obj(actions[0])?.action_ts)
    const user = str(obj(body.user)?.id)
    return actionTs === undefined || user === undefined ? undefined : { kind: 'action', dedupeKey: `action:${actionTs}:${user}` }
  }
  if (body.type === 'view_submission') {
    const view = obj(body.view)
    const id = str(view?.id)
    const hash = str(view?.hash) ?? ''
    return id === undefined ? undefined : { kind: 'view', dedupeKey: `view:${id}:${hash}` }
  }
  return undefined
}

/**
 * Saves one envelope, claimed by `host`. A second delivery of the same
 * envelope returns the first one's row with `fresh` false. Throws when the
 * database cannot take it, so the caller leaves it unacknowledged.
 */
export async function saveInbound(
  db: Db,
  params: { workspaceId: string; dedupeKey: string; kind: InboundKind; host: string; payload: Record<string, unknown>; secret: Buffer | null },
): Promise<{ row: InboundRow; fresh: boolean }> {
  const inserted = await db.query<Row>(
    `INSERT INTO inbound_events (workspace_id, dedupe_key, kind, received_by, claimed_by, claim_generation, payload, secret)
     VALUES ($1, $2, $3, $4, $4, 1, $5, $6)
     ON CONFLICT (workspace_id, dedupe_key) DO NOTHING
     RETURNING *`,
    [params.workspaceId, params.dedupeKey, params.kind, params.host, JSON.stringify(params.payload), params.secret],
  )
  const fresh = inserted.rows[0]
  if (fresh) return { row: toRow(fresh), fresh: true }
  const existing = await db.query<Row>('SELECT * FROM inbound_events WHERE workspace_id = $1 AND dedupe_key = $2', [params.workspaceId, params.dedupeKey])
  const row = existing.rows[0]
  if (!row) throw new Error('saveInbound: the envelope was neither saved nor found')
  return { row: toRow(row), fresh: false }
}

/** Hands a row this laptop holds to `target`; false when the claim was taken back meanwhile. */
export async function forwardInbound(db: Db, row: InboundRow, host: string, target: string, explicit: boolean, payload: Record<string, unknown>): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE inbound_events SET state = 'forwarded', target_host = $4, explicit = $5, claimed_by = NULL, payload = $6, updated_at = now()
     WHERE id = $1 AND claimed_by = $2 AND claim_generation = $3 AND state = 'received'`,
    [row.id, host, row.claimGeneration, target, explicit, JSON.stringify(payload)],
  )
  return rowCount === 1
}

/**
 * Claims the rows this laptop should handle now: ones forwarded to it, its
 * own unfinished ones from before it started, and any whose claimer or
 * target is no longer ready (taken back, to be routed again).
 */
export async function claimInbound(db: Db, workspaceId: string, host: string, startedAt: Date, limit = 10): Promise<InboundRow[]> {
  const { rows } = await db.query<Row>(
    `UPDATE inbound_events AS t
     SET state = 'received', claimed_by = $1, claim_generation = t.claim_generation + 1, updated_at = now()
     WHERE t.id IN (
       SELECT i.id FROM inbound_events i
       WHERE i.workspace_id = $4 AND i.created_at > now() - ${OPEN_ROW_LIMIT}
         AND (
           (i.state = 'forwarded' AND i.target_host = $1)
           OR (i.state = 'received' AND i.claimed_by = $1 AND i.updated_at < $2)
           OR (i.state = 'received' AND i.claimed_by IS DISTINCT FROM $1 AND NOT ${hostReadySql('i.claimed_by')})
           OR (i.state = 'forwarded' AND i.target_host IS DISTINCT FROM $1 AND NOT ${hostReadySql('i.target_host')})
         )
       ORDER BY i.created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $3)
     RETURNING t.*`,
    [host, startedAt, limit, workspaceId],
  )
  return rows.map(toRow)
}

/** Claims again one row this laptop saved while paused, so resuming handles exactly those and nothing still in flight. */
export async function reclaimInbound(db: Db, id: string, host: string): Promise<InboundRow | undefined> {
  const { rows } = await db.query<Row>(
    `UPDATE inbound_events SET claim_generation = claim_generation + 1, updated_at = now()
     WHERE id = $1 AND claimed_by = $2 AND state = 'received' RETURNING *`,
    [id, host],
  )
  return rows[0] ? toRow(rows[0]) : undefined
}

/**
 * Claims a one-off key for a note (`noteKey`), tied to the saved envelope
 * that triggered it, so two laptops seeing the same moment post it once.
 */
export async function claimNoteKey(db: Db, workspaceId: string, noteKey: string, inboundId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO inbound_message_keys (workspace_id, message_key, inbound_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [workspaceId, noteKey, inboundId],
  )
  return rowCount === 1
}

/**
 * Marks a row this laptop holds as being handled. With `messageKey` (the
 * message's `channel:ts`), also claims that key in the same transaction, so
 * a mention and its plain message copy saved as two rows run once. A retry
 * of the row that owns the key may go ahead. 'duplicate' finishes the row.
 */
export async function acceptInbound(pool: Pool, row: InboundRow, host: string, messageKey?: string): Promise<'accepted' | 'duplicate' | 'lost'> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const accepted = await client.query(
      `UPDATE inbound_events SET state = 'accepted', updated_at = now()
       WHERE id = $1 AND claimed_by = $2 AND claim_generation = $3 AND state IN ('received', 'accepted')`,
      [row.id, host, row.claimGeneration],
    )
    if (accepted.rowCount !== 1) {
      await client.query('ROLLBACK')
      return 'lost'
    }
    if (messageKey !== undefined) {
      await client.query(
        `INSERT INTO inbound_message_keys (workspace_id, message_key, inbound_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [row.workspaceId, messageKey, row.id],
      )
      const owner = await client.query<{ inbound_id: string }>('SELECT inbound_id FROM inbound_message_keys WHERE workspace_id = $1 AND message_key = $2', [row.workspaceId, messageKey])
      if (owner.rows[0]?.inbound_id !== row.id) {
        await client.query(`UPDATE inbound_events SET state = 'done', payload = NULL, secret = NULL, updated_at = now() WHERE id = $1`, [row.id])
        await client.query('COMMIT')
        return 'duplicate'
      }
    }
    await client.query('COMMIT')
    return 'accepted'
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** The row is handled: its payload and secret are erased at once. */
export async function finishInbound(db: Db, id: string): Promise<void> {
  await db.query(`UPDATE inbound_events SET state = 'done', payload = NULL, secret = NULL, updated_at = now() WHERE id = $1`, [id])
}

/**
 * Records a popup's answer from the laptop that handled it, unless the
 * laptop that received the popup already closed it; false then.
 */
export async function answerInbound(db: Db, id: string, response: unknown): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE inbound_events SET response = $2, updated_at = now() WHERE id = $1 AND response IS NULL`, [id, JSON.stringify(response ?? null)])
  return rowCount === 1
}

/** The receiving laptop gave up waiting for a popup's answer: it closes the popup with an empty answer. Returns the answer when one landed first. */
export async function closeInboundWait(db: Db, id: string): Promise<{ answered: boolean; response: unknown }> {
  const closed = await db.query(`UPDATE inbound_events SET response = '{"closed":true}'::jsonb, updated_at = now() WHERE id = $1 AND response IS NULL`, [id])
  if (closed.rowCount === 1) return { answered: false, response: undefined }
  const { rows } = await db.query<{ response: unknown }>('SELECT response FROM inbound_events WHERE id = $1', [id])
  return { answered: true, response: rows[0]?.response }
}

export async function readInboundResponse(db: Db, id: string): Promise<unknown> {
  const { rows } = await db.query<{ response: unknown }>('SELECT response FROM inbound_events WHERE id = $1', [id])
  return rows[0]?.response ?? null
}

/** Deletes handled rows after 7 days, and drops rows nobody handled within a day. */
export async function pruneInbound(db: Db): Promise<void> {
  await db.query(`DELETE FROM inbound_events WHERE state = 'done' AND updated_at < now() - interval '7 days'`)
  await db.query(`UPDATE inbound_events SET state = 'done', payload = NULL, secret = NULL, updated_at = now() WHERE state IN ('received', 'forwarded') AND created_at < now() - ${OPEN_ROW_LIMIT}`)
}

/** The laptop that owns a Slack thread, when one is recorded. */
export async function threadOwner(db: Db, workspaceId: string, threadRef: string): Promise<string | undefined> {
  const { rows } = await db.query<{ host: string }>(`SELECT host FROM thread_hosts WHERE workspace_id = $1 AND adapter = 'slack' AND thread_ref = $2`, [workspaceId, threadRef])
  return rows[0]?.host
}

/** Records `host` as the thread's owner unless one is recorded already; returns the owner. */
export async function recordThreadOwner(db: Db, workspaceId: string, adapter: string, threadRef: string, host: string): Promise<string> {
  await db.query(`INSERT INTO thread_hosts (workspace_id, adapter, thread_ref, host) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [workspaceId, adapter, threadRef, host])
  const { rows } = await db.query<{ host: string }>('SELECT host FROM thread_hosts WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3', [workspaceId, adapter, threadRef])
  return rows[0]?.host ?? host
}

/** Remembers which laptop posted a message with buttons, so a click on it goes there. */
export async function recordButtonMessage(db: Db, workspaceId: string, channel: string, messageTs: string, host: string): Promise<void> {
  await db.query(`INSERT INTO button_messages (workspace_id, channel, message_ts, host) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [workspaceId, channel, messageTs, host])
}

export async function buttonMessageHost(db: Db, workspaceId: string, channel: string, messageTs: string): Promise<string | undefined> {
  const { rows } = await db.query<{ host: string }>('SELECT host FROM button_messages WHERE workspace_id = $1 AND channel = $2 AND message_ts = $3', [workspaceId, channel, messageTs])
  return rows[0]?.host
}
