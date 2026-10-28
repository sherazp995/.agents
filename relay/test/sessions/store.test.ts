import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import {
  archiveSession,
  attachSessionToEngineChat,
  findOrCreateSession,
  findSessionByEngineCwd,
  setSessionEngineSessionId,
} from '../../src/sessions/store.js'
import { getTestDatabaseUrl } from '../support/database.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/**
 * Fails loudly instead of skipping when the var is absent, matching the
 * pattern test/db/migrate.test.ts and test/tenancy/workspaces.test.ts
 * already use. vitest.config.ts sets a local default, so this only fires
 * when a caller has explicitly overridden it to empty. A skipped test
 * proves nothing.
 */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'Session store tests must fail, not silently skip, when it is absent.',
          )
        })
      })

/** Mirrors the same guard in test/db/migrate.test.ts: never run against a database whose name does not mark it as disposable. */
function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run session store tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

describeDb('findOrCreateSession and archiveSession', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  /** Every test needs a real workspace and a real principal, since sessions foreign-key to both. */
  async function createWorkspaceAndPrincipal(): Promise<{ workspaceId: string; principalId: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(
      pool,
      workspaceId,
      'slack',
      `U_${randomUUID()}`,
      'Test Principal',
      ['operator'],
    )
    return { workspaceId, principalId }
  }

  async function countActiveSessions(
    workspaceId: string,
    adapter: string,
    threadRef: string,
  ): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM sessions
       WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3 AND state = 'active'`,
      [workspaceId, adapter, threadRef],
    )
    return Number(rows[0]?.count ?? '0')
  }

  it('creates a session on first sight, carrying every field the Session type promises', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
    const threadRef = `slack:C1:${randomUUID()}`

    const session = await findOrCreateSession(pool, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef,
    })

    expect(session.id).toBeTruthy()
    expect(session.workspaceId).toBe(workspaceId)
    expect(session.principalId).toBe(principalId)
    expect(session.adapter).toBe('slack')
    expect(session.threadRef).toBe(threadRef)
    expect(session.state).toBe('active')
    expect(session.createdAt).toBeTruthy()
    expect(session.lastActiveAt).toBeTruthy()
    // FR-SES-1: a brand new session has never resumed anything, an honest
    // null rather than a placeholder, per 0011_session_engine_session_id.sql.
    expect(session.engineSessionId).toBeNull()
    expect(await countActiveSessions(workspaceId, 'slack', threadRef)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // FR-SES-1: engine session id persistence, the mechanism the second real
  // operator run exposed as built but never wired (docs/decisions/open-questions.md
  // DEC-1). Proves the column persists in Postgres, not merely in memory:
  // this suite's own pool is a fresh connection per query, so a value only
  // readable back through it was genuinely committed.
  // -------------------------------------------------------------------------

  describe('setSessionEngineSessionId', () => {
    it('persists the engine session id, readable back through a fresh query', async () => {
      const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
      const threadRef = `slack:C1:${randomUUID()}`
      const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

      await setSessionEngineSessionId(pool, session.id, 'engine-session-abc')

      const { rows } = await pool.query<{ engine_session_id: string | null }>(
        'SELECT engine_session_id FROM sessions WHERE id = $1',
        [session.id],
      )
      expect(rows[0]?.engine_session_id).toBe('engine-session-abc')

      const reread = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })
      expect(reread.engineSessionId).toBe('engine-session-abc')
    })

    it('a later call overwrites the prior engine session id rather than merging', async () => {
      const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
      const threadRef = `slack:C1:${randomUUID()}`
      const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

      await setSessionEngineSessionId(pool, session.id, 'engine-session-first')
      await setSessionEngineSessionId(pool, session.id, 'engine-session-second')

      const { rows } = await pool.query<{ engine_session_id: string | null }>(
        'SELECT engine_session_id FROM sessions WHERE id = $1',
        [session.id],
      )
      expect(rows[0]?.engine_session_id).toBe('engine-session-second')
    })

    it('rejects an unknown session id rather than silently doing nothing', async () => {
      await expect(
        setSessionEngineSessionId(pool, '00000000-0000-0000-0000-000000000000', 'engine-session-x'),
      ).rejects.toThrow(/no session found/)
    })
  })

  it('the same thread ref yields the same session across separate calls', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
    const threadRef = `slack:C1:${randomUUID()}`

    const first = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })
    const second = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })
    const third = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)
    expect(await countActiveSessions(workspaceId, 'slack', threadRef)).toBe(1)
  })

  it('a different thread ref yields a different session', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()

    const first = await findOrCreateSession(pool, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
    })
    const second = await findOrCreateSession(pool, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
    })

    expect(second.id).not.toBe(first.id)
  })

  /**
   * The AP-8 tenancy property at this layer, per the Task 2 brief: sessions
   * are scoped by workspace, so the same thread ref string appearing in two
   * different workspaces must never collide into one session.
   */
  it('sessions are scoped by workspace: the same thread ref in two workspaces yields two different sessions', async () => {
    const a = await createWorkspaceAndPrincipal()
    const b = await createWorkspaceAndPrincipal()
    const sharedThreadRef = `slack:C1:${randomUUID()}`

    const sessionA = await findOrCreateSession(pool, {
      workspaceId: a.workspaceId,
      principalId: a.principalId,
      adapter: 'slack',
      threadRef: sharedThreadRef,
    })
    const sessionB = await findOrCreateSession(pool, {
      workspaceId: b.workspaceId,
      principalId: b.principalId,
      adapter: 'slack',
      threadRef: sharedThreadRef,
    })

    expect(sessionA.id).not.toBe(sessionB.id)
    expect(sessionA.workspaceId).toBe(a.workspaceId)
    expect(sessionB.workspaceId).toBe(b.workspaceId)
  })

  /**
   * The property most likely to be wrong, per the Task 2 brief: a check
   * then insert has a race, so two genuinely concurrent first sights of the
   * same thread must still produce exactly one session row, not two, and
   * every caller must agree on which one it is. Promise.all starts both
   * calls before either has a chance to complete, so this is a real race
   * against the database, not two sequential calls that merely look
   * concurrent.
   */
  it('produces exactly one session when two calls race to create the same thread concurrently', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
    const threadRef = `slack:C1:${randomUUID()}`

    const [first, second] = await Promise.all([
      findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef }),
      findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef }),
    ])

    expect(first.id).toBe(second.id)
    expect(await countActiveSessions(workspaceId, 'slack', threadRef)).toBe(1)
  })

  it('produces exactly one session under a wider concurrent race (ten callers, one thread)', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
    const threadRef = `slack:C1:${randomUUID()}`

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef }),
      ),
    )

    expect(new Set(results.map((session) => session.id)).size).toBe(1)
    expect(await countActiveSessions(workspaceId, 'slack', threadRef)).toBe(1)
  })

  it('archiveSession marks the session archived', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
    const threadRef = `slack:C1:${randomUUID()}`
    const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

    await archiveSession(pool, session.id)

    const { rows } = await pool.query<{ state: string }>('SELECT state FROM sessions WHERE id = $1', [
      session.id,
    ])
    expect(rows[0]?.state).toBe('archived')
  })

  /**
   * Decision recorded in src/sessions/store.ts's archiveSession doc
   * comment: a later findOrCreateSession call for an archived thread's ref
   * creates a fresh session rather than refusing or silently resurrecting
   * the archived row. This proves all three parts of that: a new id, the
   * archived row left untouched, and exactly one row left active.
   */
  it('a later findOrCreateSession for an archived thread creates a fresh session, not a resurrection', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
    const threadRef = `slack:C1:${randomUUID()}`
    const original = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

    await archiveSession(pool, original.id)
    const reopened = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

    expect(reopened.id).not.toBe(original.id)
    expect(reopened.state).toBe('active')

    const { rows } = await pool.query<{ state: string }>('SELECT state FROM sessions WHERE id = $1', [
      original.id,
    ])
    expect(rows[0]?.state).toBe('archived')
    expect(await countActiveSessions(workspaceId, 'slack', threadRef)).toBe(1)
  })

  it('archiving an already archived session is a harmless no-op, not an error', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
    const threadRef = `slack:C1:${randomUUID()}`
    const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

    await archiveSession(pool, session.id)
    await expect(archiveSession(pool, session.id)).resolves.toBeUndefined()

    const { rows } = await pool.query<{ state: string }>('SELECT state FROM sessions WHERE id = $1', [
      session.id,
    ])
    expect(rows[0]?.state).toBe('archived')
  })

  it('lastActiveAt advances on a repeat findOrCreateSession call for the same thread', async () => {
    const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
    const threadRef = `slack:C1:${randomUUID()}`

    const first = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

    expect(second.id).toBe(first.id)
    expect(new Date(second.lastActiveAt).getTime()).toBeGreaterThan(new Date(first.lastActiveAt).getTime())
  })

  /**
   * Fix round 1, Finding 1 (Important, reproduced by the reviewer):
   * archiveSession mutates the exact row a losing findOrCreateSession call
   * falls back to reading, so a concurrent archiveSession can archive that
   * row between the losing INSERT and the fallback UPDATE, making the
   * UPDATE match nothing. The first version of this function treated that
   * as impossible and threw. It is not impossible: the reviewer reproduced
   * three to five rejections per twenty five iterations of this exact
   * interleaving. findOrCreateSession now retries the insert-then-lookup
   * cycle instead of throwing, because the row it lost to has, by the time
   * the UPDATE misses, already been archived, so a fresh INSERT for the
   * same key no longer conflicts with anything.
   *
   * Iterated the same way the reviewer iterated it, twenty five times with
   * a fresh workspace, principal, and thread each time, so a single lucky
   * interleaving cannot hide a regression: one archiveSession call races
   * two concurrent findOrCreateSession calls on the same thread. Asserts
   * two things every iteration: nothing rejects, and exactly one active
   * session row remains for that thread afterward.
   */
  it('archiveSession racing concurrent findOrCreateSession calls never rejects and leaves exactly one active session', async () => {
    const ITERATIONS = 25

    for (let i = 0; i < ITERATIONS; i++) {
      const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
      const threadRef = `slack:C1:${randomUUID()}`
      const initial = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })

      const results = await Promise.allSettled([
        archiveSession(pool, initial.id),
        findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef }),
        findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef }),
      ])

      for (const result of results) {
        if (result.status === 'rejected') {
          throw new Error(`iteration ${i}: an operation rejected: ${String(result.reason)}`)
        }
      }
      expect(await countActiveSessions(workspaceId, 'slack', threadRef)).toBe(1)
    }
  })

  /**
   * Fix round 1, Finding 2 (Important): 0005_session_principal_workspace.sql
   * adds UNIQUE (id, workspace_id) on principals and a composite foreign
   * key from sessions (principal_id, workspace_id) to it, so a session can
   * no longer bind a principal that belongs to a different workspace than
   * the session itself. This bypasses findOrCreateSession entirely and
   * inserts directly, because the guarantee under test is the database
   * constraint, not application-level discipline: a caller that gets the
   * pairing wrong must be rejected by Postgres, not merely by convention.
   */
  it('the database rejects a session whose principal belongs to a different workspace', async () => {
    const a = await createWorkspaceAndPrincipal()
    const b = await createWorkspaceAndPrincipal()

    await expect(
      pool.query(
        `INSERT INTO sessions (workspace_id, principal_id, adapter, thread_ref)
         VALUES ($1, $2, $3, $4)`,
        [a.workspaceId, b.principalId, 'slack', `slack:C1:${randomUUID()}`],
      ),
    ).rejects.toThrow(/foreign key constraint/i)
  })

  /**
   * The mapping the operator asked for: a Slack thread must record which
   * Claude Code chat it belongs to and which folder to resume it in, so
   * later messages in that thread route to the same place without being
   * told again.
   */
  describe('attaching a thread to an existing engine chat', () => {
    async function makeSession(threadRef: string) {
      const { workspaceId, principalId } = await createWorkspaceAndPrincipal()
      const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef })
      return { workspaceId, session }
    }

    it('a fresh session records neither a chat nor a folder', async () => {
      const { session } = await makeSession(`slack:C1:${randomUUID()}`)

      // Null rather than a placeholder or Relay's own directory, because a
      // session that has never been attached genuinely has no folder of its
      // own, and a guess here would resume real work in the wrong place.
      expect(session.engineSessionId).toBeNull()
      expect(session.engineCwd).toBeNull()
    })

    it('binds the chat id and the folder together', async () => {
      const { workspaceId, session } = await makeSession(`slack:C1:${randomUUID()}`)

      await attachSessionToEngineChat(pool, session.id, 'd44ef152-6aac-4f65-ba56-6ff73c2eb20b', '/Users/hassan')

      const found = await findSessionByEngineCwd(pool, workspaceId, '/Users/hassan')
      expect(found?.id).toBe(session.id)
      expect(found?.engineSessionId).toBe('d44ef152-6aac-4f65-ba56-6ff73c2eb20b')
      expect(found?.engineCwd).toBe('/Users/hassan')
    })

    it('finds nothing for a folder no session is attached to, so the caller starts a new chat', async () => {
      const { workspaceId } = await makeSession(`slack:C1:${randomUUID()}`)

      expect(await findSessionByEngineCwd(pool, workspaceId, '/Users/hassan/nowhere')).toBeNull()
    })

    it('scopes the lookup by workspace, so one workspace never routes into another workspace chat', async () => {
      const cwd = `/Users/hassan/shared-${randomUUID()}`
      const a = await makeSession(`slack:C1:${randomUUID()}`)
      const b = await makeSession(`slack:C2:${randomUUID()}`)
      await attachSessionToEngineChat(pool, a.session.id, 'chat-a', cwd)
      await attachSessionToEngineChat(pool, b.session.id, 'chat-b', cwd)

      // AP-8. Two workspaces can legitimately work in the same directory on
      // one machine, and routing across that boundary would hand one
      // operator's thread the other's conversation.
      expect((await findSessionByEngineCwd(pool, a.workspaceId, cwd))?.engineSessionId).toBe('chat-a')
      expect((await findSessionByEngineCwd(pool, b.workspaceId, cwd))?.engineSessionId).toBe('chat-b')
    })

    it('ignores an archived session, which is not a candidate for new work', async () => {
      const cwd = `/Users/hassan/archived-${randomUUID()}`
      const { workspaceId, session } = await makeSession(`slack:C1:${randomUUID()}`)
      await attachSessionToEngineChat(pool, session.id, 'chat-old', cwd)

      await archiveSession(pool, session.id)

      expect(await findSessionByEngineCwd(pool, workspaceId, cwd)).toBeNull()
    })

    it('refuses to attach a session that does not exist rather than silently doing nothing', async () => {
      await expect(attachSessionToEngineChat(pool, randomUUID(), 'chat', '/tmp')).rejects.toThrow(/no session found/)
    })
  })
})
