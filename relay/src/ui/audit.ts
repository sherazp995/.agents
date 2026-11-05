/**
 * Every page request leaves an audit entry (FR-AUD-1). A change and the
 * entry that records it commit in one transaction, so there is never a
 * change with no record or a record of a change that did not happen.
 * Details never hold a token, cookie or CSRF value: callers pass only the
 * route, the outcome and what was changed.
 */

import type { Pool, PoolClient } from 'pg'
import { appendAuditEntry, appendAuditEntryInTransaction } from '../audit/store.js'

export type UiAuditEntry = {
  readonly route: string
  readonly outcome: string
  readonly detail?: Record<string, unknown>
}

export const UI_AUDIT_KIND = 'ui.request'

function entry(actor: string, audit: UiAuditEntry, at: Date): { runId: null; kind: string; actor: string; detail: Record<string, unknown>; at: string } {
  return { runId: null, kind: UI_AUDIT_KIND, actor, detail: { route: audit.route, outcome: audit.outcome, ...(audit.detail ?? {}) }, at: at.toISOString() }
}

/** Records a request that changed nothing (a page read, a refused change). */
export async function auditRead(pool: Pool, workspaceId: string, actor: string, audit: UiAuditEntry, now: Date = new Date()): Promise<void> {
  await appendAuditEntry(pool, workspaceId, entry(actor, audit, now))
}

/** Runs `work` and records `audit` in one transaction; a failure of either rolls both back. */
export async function auditedChange<T>(
  pool: Pool,
  workspaceId: string,
  actor: string,
  audit: UiAuditEntry,
  work: (client: PoolClient) => Promise<T>,
  now: Date = new Date(),
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await appendAuditEntryInTransaction(client, workspaceId, entry(actor, audit, now))
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
