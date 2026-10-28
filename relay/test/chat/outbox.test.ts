import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/obs/logger.js'
import { DEFAULT_MOCK_CAPABILITIES, MockAdapter } from '../../src/chat/mock.js'
import { Outbox, TransportError } from '../../src/chat/outbox.js'
import { registerSecretValue, resetSecretScrubberForTests } from '../../src/secrets/scrubber.js'
import { getTestDatabaseUrl } from '../support/database.js'
import type { ChatAction, ChatAdapter } from '../../src/chat/contract.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/**
 * Fails loudly instead of skipping when the var is absent, matching every
 * other database suite in this repo (test/db/migrate.test.ts,
 * test/chat/principals.test.ts). A skipped test proves nothing.
 */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'Outbox tests must fail, not silently skip, when it is absent.',
          )
        })
      })

/** Mirrors the same guard every other database suite uses. */
function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run outbox tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

function captureLines(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  return {
    stream,
    lines: () => chunks.join('').split('\n').filter((line) => line.trim().length > 0),
  }
}

type OutboxRow = {
  id: string
  workspace_id: string
  status: string
  attempts: number
  last_error: string | null
}

describeDb('Outbox', () => {
  let pool: Pool

  afterEach(() => {
    resetSecretScrubberForTests()
  })

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    // Idempotent, and this suite never assumes a starting state, matching
    // the pattern test/chat/principals.test.ts already uses.
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function createWorkspace(): Promise<string> {
    // platform and platform_team_id are NOT NULL as of 0003_orchestrator.sql
    // (src/tenancy/workspaces.ts's UNIQUE (platform, platform_team_id)
    // provisioning target), so this direct insert supplies a synthetic,
    // always distinct pair rather than going through resolveWorkspaceId:
    // this suite is testing the outbox, not workspace provisioning itself.
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO workspaces (name, platform, platform_team_id) VALUES ($1, $2, $3) RETURNING id',
      [`test-workspace-${randomUUID()}`, 'test', randomUUID()],
    )
    const id = rows[0]?.id
    if (!id) throw new Error('workspace insert returned no id')
    return id
  }

  async function fetchRow(id: string): Promise<OutboxRow> {
    const { rows } = await pool.query<OutboxRow>(
      'SELECT id, workspace_id, status, attempts, last_error FROM outbox WHERE id = $1',
      [id],
    )
    const row = rows[0]
    if (!row) throw new Error(`no outbox row for id ${id}`)
    return row
  }

  it(
    'survives a restart: an action enqueued by one Outbox instance is delivered by a second, ' +
      'against the same database',
    async () => {
      const workspaceId = await createWorkspace()
      const databaseUrl = await getTestDatabaseUrl()

      // "One process" enqueues, then goes away: its own pool and adapter
      // are never touched again after this call.
      const firstPool = createPool(databaseUrl)
      const firstAdapter = new MockAdapter()
      const firstOutbox = new Outbox(firstPool, firstAdapter, { now: () => new Date(0) })
      const action: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'restart-proof' }
      const id = await firstOutbox.enqueue(action, workspaceId)
      await closePool(firstPool)

      // A second, unrelated process: its own fresh pool, its own fresh
      // adapter, no in-memory state shared with the first at all. Only the
      // database ties them together.
      const secondPool = createPool(databaseUrl)
      const secondAdapter = new MockAdapter()
      const secondOutbox = new Outbox(secondPool, secondAdapter, { now: () => new Date(0) })
      const result = await secondOutbox.drain()
      await closePool(secondPool)

      expect(result).toEqual({ sent: 1, failed: 0 })
      expect(secondAdapter.performed).toEqual([action])

      const row = await fetchRow(id)
      expect(row.status).toBe('sent')
      const { rows: refs } = await pool.query<{ sent_ref: { channel: string; message: string } }>('SELECT sent_ref FROM outbox WHERE id = $1', [id])
      expect(refs[0]?.sent_ref).toMatchObject({ channel: 'C1', message: expect.any(String) })
    },
  )

  it(
    'never double sends under concurrent drain: two drain() calls racing for one action ' +
      'deliver it exactly once',
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      // A slow perform widens the race window two real concurrent drains
      // must still not fall into, rather than relying on both happening to
      // land in the same microtask tick.
      const originalPerform = adapter.perform.bind(adapter)
      adapter.perform = async (action) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return originalPerform(action)
      }

      const outboxA = new Outbox(pool, adapter)
      const outboxB = new Outbox(pool, adapter)
      const action: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'exactly-once' }
      await outboxA.enqueue(action, workspaceId)

      const [resultA, resultB] = await Promise.all([outboxA.drain(), outboxB.drain()])

      const totalSent = resultA.sent + resultB.sent
      expect(totalSent).toBe(1)
      expect(adapter.performed).toEqual([action])
    },
  )

  it(
    'retries a failing perform with backoff up to maxAttempts, then moves to a reported ' +
      'terminal failed state rather than dropping it silently',
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      const { stream, lines } = captureLines()
      const log = createLogger('info', stream)

      // A controllable clock, so backoff can be proven without a real
      // wait: each drain advances it past whatever next_attempt_at the
      // previous failure scheduled.
      let clock = new Date(1_000_000)
      const outbox = new Outbox(pool, adapter, {
        maxAttempts: 3,
        backoffMs: () => 1000,
        now: () => clock,
        log,
      })

      const action: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'always-fails' }
      const id = await outbox.enqueue(action, workspaceId)

      adapter.failNextPerform(new Error('boom-1'))
      const firstDrain = await outbox.drain()
      expect(firstDrain).toEqual({ sent: 0, failed: 0 })
      let row = await fetchRow(id)
      expect(row.status).toBe('pending')
      expect(row.attempts).toBe(1)

      clock = new Date(clock.getTime() + 2000)
      adapter.failNextPerform(new Error('boom-2'))
      const secondDrain = await outbox.drain()
      expect(secondDrain).toEqual({ sent: 0, failed: 0 })
      row = await fetchRow(id)
      expect(row.status).toBe('pending')
      expect(row.attempts).toBe(2)

      clock = new Date(clock.getTime() + 2000)
      adapter.failNextPerform(new Error('boom-3'))
      const thirdDrain = await outbox.drain()
      expect(thirdDrain).toEqual({ sent: 0, failed: 1 })
      row = await fetchRow(id)
      expect(row.status).toBe('failed')
      expect(row.attempts).toBe(3)
      expect(row.last_error).toContain('boom-3')

      // Reported, not silently dropped: the terminal failure is observable
      // through the log as well as through the row itself.
      expect(lines().some((line) => line.includes('failed') && line.includes(id))).toBe(true)

      // A row in the terminal failed state is never picked up again: a
      // further drain must not attempt it a fourth time.
      const fourthDrain = await outbox.drain()
      expect(fourthDrain).toEqual({ sent: 0, failed: 0 })
      expect(adapter.performed).toEqual([])
    },
  )

  // ---------------------------------------------------------------------
  // Gate fix, Blocker 4 / TST-C-4: a transport-level outage must not
  // permanently fail a message the platform was always going to accept
  // once it came back, even one that outlives DEFAULT_MAX_ATTEMPTS'
  // roughly eighteen second budget.
  // ---------------------------------------------------------------------

  it(
    "TST-C-4: a 60 second transport outage (TransportError on every attempt) does not reach " +
      "maxAttempts or the terminal 'failed' state, and the message is eventually delivered once " +
      'the adapter recovers',
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      let clock = new Date(4_000_000)
      // A real, small maxAttempts: if TransportError classification were
      // broken and these failures were counted like ordinary ones, five
      // failed drain cycles would already terminal-fail the row long
      // before 60 simulated seconds elapse, which is exactly what this
      // test would catch.
      const outbox = new Outbox(pool, adapter, { maxAttempts: 5, backoffMs: () => 5000, now: () => clock })

      const action: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'survives the outage' }
      const id = await outbox.enqueue(action, workspaceId)

      // Simulates the outage: every attempt over a simulated 60 seconds
      // fails with a TransportError, advancing the fake clock past each
      // scheduled backoff so every cycle is actually attempted.
      let simulatedElapsedMs = 0
      let cycles = 0
      while (simulatedElapsedMs < 60_000) {
        adapter.failNextPerform(new TransportError(`simulated transport outage, cycle ${cycles}`))
        const result = await outbox.drain()
        expect(result).toEqual({ sent: 0, failed: 0 })
        cycles += 1
        clock = new Date(clock.getTime() + 5000)
        simulatedElapsedMs += 5000
      }

      // Well past DEFAULT_MAX_ATTEMPTS worth of cycles, and well past this
      // outbox's own maxAttempts: 5, yet still pending, never failed.
      expect(cycles).toBeGreaterThan(5)
      const duringOutage = await fetchRow(id)
      expect(duringOutage.status).toBe('pending')
      expect(duringOutage.attempts).toBeGreaterThan(5)

      // Connectivity returns: the very next attempt succeeds, and the
      // message that survived the whole outage is finally delivered.
      const recovered = await outbox.drain()
      expect(recovered).toEqual({ sent: 1, failed: 0 })
      const afterRecovery = await fetchRow(id)
      expect(afterRecovery.status).toBe('sent')
      expect(adapter.performed).toEqual([action])
    },
  )

  it(
    'scrubs a registered secret out of both the persisted last_error and the log line, never ' +
      'storing or logging the raw credential (FR-SEC-1)',
    async () => {
      const SENTINEL = 'xoxb-PROOF-outbox-secret'
      registerSecretValue(SENTINEL)

      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      const { stream, lines } = captureLines()
      const log = createLogger('info', stream)
      const outbox = new Outbox(pool, adapter, { maxAttempts: 1, log })

      const action: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'leaky' }
      const id = await outbox.enqueue(action, workspaceId)

      // maxAttempts: 1 means this single failure is already terminal, so
      // both the 'failed' persistence branch and its log line run, the same
      // code path finding 6 targets.
      adapter.failNextPerform(new Error(`request failed, token was ${SENTINEL}`))
      const result = await outbox.drain()
      expect(result).toEqual({ sent: 0, failed: 1 })

      const row = await fetchRow(id)
      expect(row.last_error).not.toContain(SENTINEL)
      expect(row.last_error).toContain('[redacted secret]')

      const logText = lines().join('\n')
      expect(logText).not.toContain(SENTINEL)
    },
  )

  it('reads an upload queued by path when it is sent, and fails the row when the file is gone', async () => {
    const workspaceId = await createWorkspace()
    const adapter = new MockAdapter({ ...DEFAULT_MOCK_CAPABILITIES, fileUpload: true })
    const outbox = new Outbox(pool, adapter, { maxAttempts: 1, now: () => new Date(0) })
    const dir = mkdtempSync(join(tmpdir(), 'relay-outbox-'))
    writeFileSync(join(dir, 'qa.html'), '<h1>QA</h1>')
    const queue = (path: string) =>
      pool.query(`INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, $2, $3, to_timestamp(0)) RETURNING id`, [
        workspaceId,
        adapter.name,
        { kind: 'upload', ref: { channel: 'D1', thread: '1.1' }, filename: 'qa.html', path },
      ])
    await queue(join(dir, 'qa.html'))
    await queue(join(dir, 'gone.html'))

    expect(await outbox.drain()).toEqual({ sent: 1, failed: 1 })
    const sent = adapter.performed[0] as Extract<ChatAction, { kind: 'upload' }>
    expect(Buffer.from(sent.bytes).toString()).toBe('<h1>QA</h1>')
  })

  it('drains uploads in their own lane, one at a time, so a post never waits behind one', async () => {
    const workspaceId = await createWorkspace()
    const adapter = new MockAdapter({ ...DEFAULT_MOCK_CAPABILITIES, fileUpload: true })
    const outbox = new Outbox(pool, adapter, { now: () => new Date(0) })
    const dir = mkdtempSync(join(tmpdir(), 'relay-outbox-'))
    writeFileSync(join(dir, 'a.md'), 'a')
    for (const action of [
      { kind: 'upload', ref: { channel: 'D1', thread: '1.1' }, filename: 'a.md', path: join(dir, 'a.md') },
      { kind: 'upload', ref: { channel: 'D1', thread: '1.1' }, filename: 'a.md', path: join(dir, 'a.md') },
      { kind: 'post', ref: { channel: 'D1', thread: '1.1' }, text: 'hi' },
    ]) {
      await pool.query(`INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, $2, $3, to_timestamp(0))`, [workspaceId, adapter.name, action])
    }

    expect(await outbox.drain({ lane: 'messages' })).toEqual({ sent: 1, failed: 0 })
    expect(adapter.performed.map((action) => action.kind)).toEqual(['post'])
    expect(await outbox.drain({ lane: 'uploads' })).toEqual({ sent: 1, failed: 0 })
    expect(await outbox.drain({ lane: 'uploads' })).toEqual({ sent: 1, failed: 0 })
    expect(adapter.performed.map((action) => action.kind)).toEqual(['post', 'upload', 'upload'])
  })

  it('recovers on a later attempt after an earlier failure, and is marked sent', async () => {
    const workspaceId = await createWorkspace()
    const adapter = new MockAdapter()
    let clock = new Date(2_000_000)
    const outbox = new Outbox(pool, adapter, { maxAttempts: 5, backoffMs: () => 10, now: () => clock })

    const action: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'recovers' }
    const id = await outbox.enqueue(action, workspaceId)

    adapter.failNextPerform(new Error('transient'))
    await outbox.drain()
    let row = await fetchRow(id)
    expect(row.status).toBe('pending')

    clock = new Date(clock.getTime() + 100)
    const result = await outbox.drain()
    expect(result).toEqual({ sent: 1, failed: 0 })
    row = await fetchRow(id)
    expect(row.status).toBe('sent')
    expect(adapter.performed).toEqual([action])
  })

  it('persists workspace_id per action and carries each through to delivery, scoped per AP-8', async () => {
    const workspaceA = await createWorkspace()
    const workspaceB = await createWorkspace()
    const adapter = new MockAdapter()
    const outbox = new Outbox(pool, adapter)

    const actionA: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'from-a' }
    const actionB: ChatAction = { kind: 'post', ref: { channel: 'C2' }, text: 'from-b' }
    const idA = await outbox.enqueue(actionA, workspaceA)
    const idB = await outbox.enqueue(actionB, workspaceB)

    const result = await outbox.drain()
    expect(result).toEqual({ sent: 2, failed: 0 })

    const rowA = await fetchRow(idA)
    const rowB = await fetchRow(idB)
    expect(rowA.workspace_id).toBe(workspaceA)
    expect(rowA.status).toBe('sent')
    expect(rowB.workspace_id).toBe(workspaceB)
    expect(rowB.status).toBe('sent')
    expect(rowA.workspace_id).not.toBe(rowB.workspace_id)

    expect(adapter.performed).toEqual(expect.arrayContaining([actionA, actionB]))
  })

  it('round-trips an upload action\'s binary bytes through the jsonb column without corruption', async () => {
    const workspaceId = await createWorkspace()
    const adapter = new MockAdapter({ ...DEFAULT_MOCK_CAPABILITIES, fileUpload: true })
    const outbox = new Outbox(pool, adapter)

    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const action: ChatAction = {
      kind: 'upload',
      ref: { channel: 'C1' },
      filename: 'proof.bin',
      bytes,
    }
    await outbox.enqueue(action, workspaceId)
    const result = await outbox.drain()

    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(adapter.performed).toHaveLength(1)
    const performed = adapter.performed[0]
    if (performed?.kind !== 'upload') throw new Error('expected an upload action')
    expect(performed.bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(performed.bytes)).toEqual(Array.from(bytes))
  })

  it('drain() claims only rows enqueued for its own adapter, never another adapter\'s', async () => {
    const workspaceId = await createWorkspace()

    // Two adapters with different names, sharing one outbox table, which is
    // the situation contract.ts exists for: Slack today, another platform
    // later. Each perform() records what it was handed, so a row crossing
    // from one adapter to the other is caught rather than inferred.
    // MockAdapter hardcodes name = 'mock', so each is wrapped in an object
    // that overrides only the name and delegates everything else. A plain
    // wrapper keeps this type-checked against ChatAdapter, where mutating
    // the instance's readonly `name` would not be.
    const renamed = (inner: MockAdapter, name: string): ChatAdapter & { performed: ChatAction[] } => ({
      name,
      capabilities: inner.capabilities,
      start: (handler) => inner.start(handler),
      stop: () => inner.stop(),
      perform: (action) => inner.perform(action),
      performed: inner.performed,
    })

    const alpha = renamed(new MockAdapter(), 'alpha')
    const beta = renamed(new MockAdapter(), 'beta')

    const outboxAlpha = new Outbox(pool, alpha)
    const outboxBeta = new Outbox(pool, beta)

    const alphaAction: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'for alpha' }
    const betaAction: ChatAction = { kind: 'post', ref: { channel: 'C2' }, text: 'for beta' }
    const alphaId = await outboxAlpha.enqueue(alphaAction, workspaceId)
    const betaId = await outboxBeta.enqueue(betaAction, workspaceId)

    // Alpha drains first. Without the adapter filter it would claim and
    // perform beta's row too, handing beta's action to alpha's perform().
    const alphaDrain = await outboxAlpha.drain()
    expect(alphaDrain).toEqual({ sent: 1, failed: 0 })
    expect(alpha.performed).toEqual([alphaAction])

    // Beta's row must be untouched: still pending, still unattempted.
    const betaRowBeforeItsDrain = await fetchRow(betaId)
    expect(betaRowBeforeItsDrain.status).toBe('pending')
    expect(betaRowBeforeItsDrain.attempts).toBe(0)

    const betaDrain = await outboxBeta.drain()
    expect(betaDrain).toEqual({ sent: 1, failed: 0 })
    expect(beta.performed).toEqual([betaAction])

    // Neither adapter ever saw the other's action.
    expect(alpha.performed).toHaveLength(1)
    expect(beta.performed).toHaveLength(1)
    expect(await fetchRow(alphaId)).toMatchObject({ status: 'sent' })
    expect(await fetchRow(betaId)).toMatchObject({ status: 'sent' })
  })

  it(
    'drain() returns rather than hanging when perform() never settles, releases its ' +
      'connection, and lets a later drain() and pool.end() proceed normally',
    async () => {
      const workspaceId = await createWorkspace()
      const databaseUrl = await getTestDatabaseUrl()
      const hangingPool = createPool(databaseUrl)

      let performCalls = 0
      const hangingAdapter: ChatAdapter = {
        name: 'hanging',
        capabilities: DEFAULT_MOCK_CAPABILITIES,
        start: async () => {},
        stop: async () => {},
        perform: async () => {
          performCalls += 1
          // Never resolves and never rejects, the way a network call to a
          // chat platform that stops responding mid request would behave.
          return new Promise(() => {})
        },
      }

      const outbox = new Outbox(hangingPool, hangingAdapter, {
        performTimeoutMs: 50,
        maxAttempts: 5,
        backoffMs: () => 10,
      })

      const action: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'hangs forever' }
      const id = await outbox.enqueue(action, workspaceId)

      const firstDrain = await outbox.drain()
      expect(firstDrain).toEqual({ sent: 0, failed: 0 })

      const rowAfterTimeout = await fetchRow(id)
      expect(rowAfterTimeout.status).toBe('pending')
      expect(rowAfterTimeout.attempts).toBe(1)
      expect(rowAfterTimeout.last_error).toContain('timed out')

      // The connection the hung call was using must have been returned to
      // the pool, not held forever with its row lock: a second drain on
      // the same pool must proceed and must not itself hang either.
      const secondDrain = await outbox.drain()
      expect(secondDrain).toEqual({ sent: 0, failed: 0 })
      expect(performCalls).toBe(2)

      // pool.end() hanging forever, because a backend was left idle in
      // transaction, was the reviewer's proof of the original bug. It must
      // resolve now.
      await closePool(hangingPool)
    },
    10_000,
  )

  it(
    'documents the accepted residual risk: a perform() that times out but later completes ' +
      'on its own can still deliver, so a retried action can be sent twice',
    async () => {
      const workspaceId = await createWorkspace()
      const deliveries: string[] = []
      let callIndex = 0
      const flakyAdapter: ChatAdapter = {
        name: 'flaky',
        capabilities: DEFAULT_MOCK_CAPABILITIES,
        start: async () => {},
        stop: async () => {},
        perform: async (action) => {
          callIndex += 1
          const thisCall = callIndex
          if (thisCall === 1) {
            // Slower than performTimeoutMs, but it does eventually
            // complete, exactly like a request that actually reached the
            // platform even though this side gave up waiting for it.
            await new Promise((resolve) => setTimeout(resolve, 150))
          }
          deliveries.push(`call-${thisCall}`)
          return { ref: { ...action.ref, message: `m-${thisCall}` } }
        },
      }

      const outbox = new Outbox(pool, flakyAdapter, {
        performTimeoutMs: 50,
        maxAttempts: 5,
        backoffMs: () => 1,
      })

      const action: ChatAction = { kind: 'post', ref: { channel: 'C1' }, text: 'flaky' }
      await outbox.enqueue(action, workspaceId)

      const firstDrain = await outbox.drain()
      expect(firstDrain).toEqual({ sent: 0, failed: 0 })

      // Give next_attempt_at (now + 1ms backoff) time to be in the past.
      await new Promise((resolve) => setTimeout(resolve, 20))
      const secondDrain = await outbox.drain()
      expect(secondDrain).toEqual({ sent: 1, failed: 0 })

      // Let call 1's abandoned 150ms delay finish so it can prove the point.
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Both the abandoned first call and the retry actually delivered:
      // one logical enqueue produced two real deliveries. This is the
      // residual risk the drain() doc comment names explicitly: at least
      // once, not exactly once, on the timeout path.
      expect(deliveries).toEqual(expect.arrayContaining(['call-1', 'call-2']))
      expect(deliveries).toHaveLength(2)
    },
    10_000,
  )
})
