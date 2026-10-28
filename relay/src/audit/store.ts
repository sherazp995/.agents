/**
 * FR-AUD-1: writing audit entries, and FR-AUD-3: redacting on write.
 *
 * FR-AUD-3 is one sentence with a strong consequence: "Redaction happens on
 * write, not on read. Nothing sensitive is ever persisted in the clear."
 * That rules out the shape most systems end up with, where the raw value is
 * stored and every reader is trusted to redact. Every reader includes a
 * database dump, a replica, a backup, and whoever is debugging at 2am.
 *
 * So the scrubber runs HERE, on the way in, at the single choke point every
 * entry passes through. Its limits are worth stating rather than implying:
 * it only knows values Relay itself brokered, so it cannot catch a
 * credential the operator pasted into a task description. That is a real gap
 * and it is the reason the requirement says "nothing sensitive is ever
 * persisted", not "nothing sensitive is ever written by a caller who
 * remembered".
 *
 * THE SEQUENCE IS TAKEN UNDER A LOCK. Two concurrent appends reading the
 * same head would produce two entries claiming the same position, and the
 * chain would be broken by ordinary concurrency rather than by tampering,
 * which is the fastest way to teach an operator to ignore an integrity
 * warning. The insert runs inside a transaction that locks the table against
 * other appenders.
 */

import type { Pool, PoolClient } from 'pg'

import { chainEntry, verifyChain, GENESIS_HASH } from './chain.js'
import type { AuditEntryInput, ChainedAuditEntry, ChainVerification } from './chain.js'
import { scrubSecrets } from '../secrets/scrubber.js'

/**
 * Applies the process-wide scrubber to every string in the detail, at any
 * depth. FR-AUD-3's "on write" is this function's whole reason for existing.
 */
export function redactDetail(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value)
  if (Array.isArray(value)) return value.map(redactDetail)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDetail(item)]))
  }
  return value
}

function rowToEntry(row: Record<string, unknown>): ChainedAuditEntry {
  return {
    sequence: Number(row.sequence),
    runId: (row.run_id as string | null) ?? null,
    kind: String(row.kind),
    actor: String(row.actor),
    detail: row.detail as Record<string, unknown>,
    at: new Date(row.at as string).toISOString(),
    previousHash: String(row.previous_hash),
    hash: String(row.hash),
  }
}

/**
 * Appends one entry, chained to the current head.
 *
 * Returns the written entry so a caller can record its hash, and so a test
 * can assert the chain without a second query.
 */
export async function appendAuditEntry(pool: Pool, workspaceId: string, entry: AuditEntryInput): Promise<ChainedAuditEntry> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialises appenders against each other. Without it, two concurrent
    // writers read the same head and both claim the next sequence, which
    // breaks the chain through ordinary concurrency rather than tampering.
    await client.query('LOCK TABLE audit_entries IN EXCLUSIVE MODE')

    const head = await client.query(
      'SELECT * FROM audit_entries WHERE workspace_id = $1 ORDER BY sequence DESC LIMIT 1',
      [workspaceId],
    )
    const previous = head.rows.length === 0 ? undefined : rowToEntry(head.rows[0] as Record<string, unknown>)

    // FR-AUD-3: redacted before it is written, never on the way out.
    const redacted: AuditEntryInput = { ...entry, detail: redactDetail(entry.detail) as Record<string, unknown> }
    const chained = chainEntry(redacted, previous)

    await client.query(
      `INSERT INTO audit_entries (workspace_id, sequence, run_id, kind, actor, detail, at, previous_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        workspaceId,
        chained.sequence,
        chained.runId,
        chained.kind,
        chained.actor,
        JSON.stringify(chained.detail),
        chained.at,
        chained.previousHash,
        chained.hash,
      ],
    )

    await client.query('COMMIT')
    return chained
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Reads the whole chain in order. Used by verification and by export. */
export async function readAuditChain(pool: Pool, workspaceId: string): Promise<readonly ChainedAuditEntry[]> {
  const result = await pool.query('SELECT * FROM audit_entries WHERE workspace_id = $1 ORDER BY sequence ASC', [workspaceId])
  return result.rows.map((row) => rowToEntry(row as Record<string, unknown>))
}

export async function verifyAuditChain(pool: Pool, workspaceId: string): Promise<ChainVerification> {
  return verifyChain(await readAuditChain(pool, workspaceId))
}

export async function currentHead(pool: Pool, workspaceId: string): Promise<{ sequence: number; hash: string }> {
  const result = await pool.query(
    'SELECT sequence, hash FROM audit_entries WHERE workspace_id = $1 ORDER BY sequence DESC LIMIT 1',
    [workspaceId],
  )
  if (result.rows.length === 0) return { sequence: 0, hash: GENESIS_HASH }
  const row = result.rows[0] as Record<string, unknown>
  return { sequence: Number(row.sequence), hash: String(row.hash) }
}

export async function recordSignedHead(
  pool: Pool,
  workspaceId: string,
  head: { readonly sequence: number; readonly hash: string; readonly signedAt: string; readonly signature: string },
): Promise<void> {
  await pool.query(
    'INSERT INTO audit_chain_heads (workspace_id, sequence, hash, signed_at, signature) VALUES ($1, $2, $3, $4, $5)',
    [workspaceId, head.sequence, head.hash, head.signedAt, head.signature],
  )
}

export async function latestSignedHead(
  pool: Pool,
  workspaceId: string,
): Promise<{ sequence: number; hash: string; signedAt: string; signature: string } | undefined> {
  const result = await pool.query(
    'SELECT sequence, hash, signed_at, signature FROM audit_chain_heads WHERE workspace_id = $1 ORDER BY sequence DESC LIMIT 1',
    [workspaceId],
  )
  if (result.rows.length === 0) return undefined
  const row = result.rows[0] as Record<string, unknown>
  return {
    sequence: Number(row.sequence),
    hash: String(row.hash),
    signedAt: new Date(row.signed_at as string).toISOString(),
    signature: String(row.signature),
  }
}
