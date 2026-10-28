import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import {
  appendAuditEntry,
  currentHead,
  latestSignedHead,
  readAuditChain,
  recordSignedHead,
  redactDetail,
  verifyAuditChain,
} from '../../src/audit/store.js'
import { registerSecretValue } from '../../src/secrets/scrubber.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { randomUUID } from 'node:crypto'
import { getTestDatabaseUrl } from '../support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/** Fails loudly instead of skipping when the var is absent, matching every other database suite here. A skipped test proves nothing. */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error('RELAY_TEST_DATABASE_URL is not set; this suite must fail, not silently skip.')
        })
      })

describe('FR-AUD-3: redaction happens on WRITE', () => {
  it('scrubs a brokered secret out of the detail before it is stored', () => {
    // Storing the raw value and trusting every reader to redact means
    // trusting a database dump, a replica, a backup, and whoever is
    // debugging at 2am.
    registerSecretValue('xoxb-a-real-looking-token')

    const redacted = redactDetail({ note: 'used xoxb-a-real-looking-token to post' })

    expect(JSON.stringify(redacted)).not.toContain('xoxb-a-real-looking-token')
  })

  it('reaches strings at any depth, including inside arrays', () => {
    registerSecretValue('nested-secret-value')

    const redacted = redactDetail({ steps: [{ args: ['nested-secret-value'] }] })

    expect(JSON.stringify(redacted)).not.toContain('nested-secret-value')
  })

  it('leaves non-strings alone', () => {
    expect(redactDetail({ count: 3, ok: true, nothing: null })).toEqual({ count: 3, ok: true, nothing: null })
  })
})

describeDb('the audit store, against a real database', () => {
  let pool: Pool
  let workspaceId: string

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
    await applyMigrations(pool, 'src/db/migrations')
    workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
  }, 60_000)

  afterAll(async () => {
    await closePool(pool)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM audit_chain_heads WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM audit_entries WHERE workspace_id = $1', [workspaceId])
  })

  function entry(detail: Record<string, unknown>) {
    return { runId: 'run-1', kind: 'capability_invoked', actor: 'relay', detail, at: new Date().toISOString() }
  }

  it('chains each entry onto the last, and verifies end to end', async () => {
    await appendAuditEntry(pool, workspaceId, entry({ step: 1 }))
    await appendAuditEntry(pool, workspaceId, entry({ step: 2 }))
    await appendAuditEntry(pool, workspaceId, entry({ step: 3 }))

    const result = await verifyAuditChain(pool, workspaceId)

    expect(result.intact).toBe(true)
    if (!result.intact) return
    expect(result.entries).toBe(3)
  })

  it('DETECTS an entry altered directly in the database, which is the whole point', async () => {
    await appendAuditEntry(pool, workspaceId, entry({ step: 1 }))
    const second = await appendAuditEntry(pool, workspaceId, entry({ step: 2 }))
    await appendAuditEntry(pool, workspaceId, entry({ step: 3 }))

    // An operator, or an attacker, editing a row by hand.
    await pool.query('UPDATE audit_entries SET detail = $1 WHERE sequence = $2', [JSON.stringify({ step: 'tampered' }), second.sequence])

    const result = await verifyAuditChain(pool, workspaceId)

    expect(result.intact).toBe(false)
    if (result.intact) return
    expect(result.firstBadSequence).toBe(2)
    expect(result.reason).toContain('altered')
  })

  it('detects a DELETED row as a sequence gap', async () => {
    await appendAuditEntry(pool, workspaceId, entry({ step: 1 }))
    const second = await appendAuditEntry(pool, workspaceId, entry({ step: 2 }))
    await appendAuditEntry(pool, workspaceId, entry({ step: 3 }))

    await pool.query('DELETE FROM audit_entries WHERE sequence = $1', [second.sequence])

    const result = await verifyAuditChain(pool, workspaceId)

    expect(result.intact).toBe(false)
    if (result.intact) return
    expect(result.reason).toContain('deleted')
  })

  it('survives CONCURRENT appends without breaking its own chain', async () => {
    // Two writers reading the same head would both claim the next sequence,
    // and the chain would be broken by ordinary concurrency rather than by
    // tampering, which is the fastest way to teach an operator to ignore an
    // integrity warning.
    await Promise.all(Array.from({ length: 12 }, (_unused, index) => appendAuditEntry(pool, workspaceId, entry({ step: index }))))

    const result = await verifyAuditChain(pool, workspaceId)

    expect(result.intact).toBe(true)
    if (!result.intact) return
    expect(result.entries).toBe(12)
  })

  it('redacts on the way IN, so the stored row carries no secret', async () => {
    registerSecretValue('stored-secret-should-not-persist')

    await appendAuditEntry(pool, workspaceId, entry({ note: 'value was stored-secret-should-not-persist' }))

    // Read straight from the database, bypassing anything that might redact
    // on the way out.
    const raw = await pool.query('SELECT detail::text AS detail FROM audit_entries LIMIT 1')

    expect(String((raw.rows[0] as { detail: string }).detail)).not.toContain('stored-secret-should-not-persist')
  })

  it('reports the genesis head for an empty log rather than nothing', async () => {
    const head = await currentHead(pool, workspaceId)

    expect(head.sequence).toBe(0)
  })

  it('stores and reads back a signed chain head', async () => {
    await appendAuditEntry(pool, workspaceId, entry({ step: 1 }))
    const head = await currentHead(pool, workspaceId)

    await recordSignedHead(pool, workspaceId, { ...head, signedAt: new Date().toISOString(), signature: 'deadbeef' })
    const latest = await latestSignedHead(pool, workspaceId)

    expect(latest?.sequence).toBe(head.sequence)
    expect(latest?.signature).toBe('deadbeef')
  })

  it('reads the chain back in sequence order', async () => {
    await appendAuditEntry(pool, workspaceId, entry({ step: 1 }))
    await appendAuditEntry(pool, workspaceId, entry({ step: 2 }))

    const chain = await readAuditChain(pool, workspaceId)

    expect(chain.map((item) => item.sequence)).toEqual([1, 2])
  })
})
