import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { DEFAULT_MOCK_CAPABILITIES, MockAdapter } from '../../src/chat/mock.js'
import { ProgressReporter } from '../../src/chat/progress.js'
import { OutboundDispatcher } from '../../src/dispatch/outbound.js'
import { getTestDatabaseUrl } from '../support/database.js'
import type { ChatAction, ChatAdapter } from '../../src/chat/contract.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/**
 * Fails loudly instead of skipping when the var is absent, matching every
 * other database suite in this repo (test/chat/outbox.test.ts,
 * test/db/migrate.test.ts). A skipped test proves nothing.
 */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden to empty. ' +
              'OutboundDispatcher tests must fail, not silently skip, when it is absent.',
          )
        })
      })

function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run outbound dispatcher tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

/**
 * Outbox.drain() (src/chat/outbox.ts) can be scoped by workspace as well as
 * by adapter name, per the gate fix for High 1: OutboundDispatcher always
 * binds its own internal Outbox to the workspace passed to ITS constructor
 * (see the dedicated cross-workspace test below), but the underlying Outbox
 * primitive itself still supports an UNSCOPED instance too, when a caller
 * genuinely wants one Outbox to serve every workspace (test/chat/outbox.test.ts
 * exercises that shape directly). This file's own tests do not rely on
 * workspace scoping to isolate themselves from each other, because two
 * `OutboundDispatcher`s in different tests are also very often bound to
 * different workspaces already; adapter-name scoping is still the
 * deliberate, belt-and-suspenders isolation this suite uses regardless,
 * because several tests here call `drain()` directly (unlike most of
 * test/chat/outbox.test.ts), where cross-test pollution was reproduced
 * while writing these tests originally: see the Task 4 report. Every
 * MockAdapter defaults to the same name, 'mock', so two tests that each
 * construct their own `new MockAdapter()` would still be reading and
 * claiming rows out of the very same pending set the moment either one
 * calls drain(), especially with the past-dated fixed clocks several tests
 * below use to get deterministic ordering. Wrapping every test's adapter
 * with a name unique to that test is what test/chat/outbox.test.ts's own
 * "drain() claims only rows enqueued for its own adapter" test also relies
 * on for the same reason.
 */
function namedAdapter(inner: MockAdapter, name: string): ChatAdapter {
  return {
    name,
    capabilities: inner.capabilities,
    start: (handler) => inner.start(handler),
    stop: () => inner.stop(),
    perform: (action) => inner.perform(action),
  }
}

type OutboxKindRow = { status: string; kind: string }

describeDb('OutboundDispatcher', () => {
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

  async function createWorkspace(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO workspaces (name, platform, platform_team_id) VALUES ($1, $2, $3) RETURNING id',
      [`test-workspace-${randomUUID()}`, 'test', randomUUID()],
    )
    const id = rows[0]?.id
    if (!id) throw new Error('workspace insert returned no id')
    return id
  }

  /** Reads back every outbox row for a workspace, ordered the way they were created, for assertions that need to see status without knowing row ids. */
  async function outboxRowsFor(workspaceId: string): Promise<OutboxKindRow[]> {
    const { rows } = await pool.query<OutboxKindRow>(
      `SELECT status, action ->> 'kind' AS kind FROM outbox WHERE workspace_id = $1 ORDER BY created_at`,
      [workspaceId],
    )
    return rows
  }

  it(
    'property 1: a post enqueued by one dispatcher instance is delivered by a second, against ' +
      'the same database, proving the queue lives in Postgres rather than memory',
    async () => {
      const workspaceId = await createWorkspace()
      const databaseUrl = await getTestDatabaseUrl()
      const adapterName = `mock-${randomUUID()}`

      const firstPool = createPool(databaseUrl)
      const firstAdapter = new MockAdapter()
      const firstDispatcher = new OutboundDispatcher(
        firstPool,
        namedAdapter(firstAdapter, adapterName),
        workspaceId,
      )
      await firstDispatcher.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'restart-proof' })
      await closePool(firstPool)

      const secondPool = createPool(databaseUrl)
      // A different underlying MockAdapter instance, matching
      // test/chat/outbox.test.ts's own restart test: this action is a bare
      // post with no dependent edit, so nothing needs message-id
      // continuity across instances the way property 3 below does.
      const secondAdapter = new MockAdapter()
      const secondDispatcher = new OutboundDispatcher(
        secondPool,
        namedAdapter(secondAdapter, adapterName),
        workspaceId,
      )
      const result = await secondDispatcher.drain()
      await closePool(secondPool)

      expect(result).toEqual({ sent: 1, failed: 0 })
      expect(secondAdapter.performed).toEqual([
        { kind: 'post', ref: { channel: 'C1' }, text: 'restart-proof' },
      ])
    },
  )

  it(
    'property 2: an edit that depends on an undelivered post is not sent before it, proven by ' +
      'enqueueing both then draining once and asserting the adapter saw the post first',
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      let clock = new Date(1_000_000)
      const dispatcher = new OutboundDispatcher(
        pool,
        namedAdapter(adapter, `mock-${randomUUID()}`),
        workspaceId,
        { now: () => clock },
      )

      const postResult = await dispatcher.perform({
        kind: 'post',
        ref: { channel: 'C1' },
        text: 'first',
      })
      clock = new Date(clock.getTime() + 1000)
      const editRef = { channel: 'C1', message: postResult.ref.message as string }
      await dispatcher.perform({ kind: 'edit', ref: editRef, text: 'second' })

      const result = await dispatcher.drain()
      expect(result).toEqual({ sent: 2, failed: 0 })

      expect(adapter.performed).toHaveLength(2)
      expect(adapter.performed[0]).toMatchObject({ kind: 'post', text: 'first' })
      expect(adapter.performed[1]).toMatchObject({ kind: 'edit', text: 'second' })

      // The edit that actually reached the adapter targets the REAL mock
      // message id, never the synthetic dispatch id perform() handed back.
      const editAction = adapter.performed[1]
      if (editAction?.kind !== 'edit') throw new Error('expected an edit action')
      expect(editAction.ref.message).not.toBe(postResult.ref.message)
      expect(editAction.ref.message).toMatch(/^mock-msg-/)
    },
  )

  it(
    'property 2b: a placeholder row with a null ref (the post has not delivered yet) causes the ' +
      "dependent edit to defer, never to proceed against it",
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      let clock = new Date(9_000_000)
      const dispatcher = new OutboundDispatcher(
        pool,
        namedAdapter(adapter, `mock-${randomUUID()}`),
        workspaceId,
        { now: () => clock, batchSize: 1 },
      )

      const postResult = await dispatcher.perform({
        kind: 'post',
        ref: { channel: 'C1' },
        text: 'still in flight',
      })
      // Rewound below the post's own next_attempt_at: with batchSize 1,
      // this drain() call claims only the edit, never even reaching the
      // post's row, isolating "the edit's dependency is unresolved" from
      // "the post also happened to be attempted in the same cycle".
      clock = new Date(clock.getTime() - 5000)
      const editRef = { channel: 'C1', message: postResult.ref.message as string }
      await dispatcher.perform({ kind: 'edit', ref: editRef, text: 'too early' })

      const result = await dispatcher.drain()
      // Deferred, not sent and not failed: OutboxDeferError's outcome.
      expect(result).toEqual({ sent: 0, failed: 0 })
      expect(adapter.performed).toHaveLength(0)

      const { rows } = await pool.query<{ ref: unknown }>(
        'SELECT ref FROM outbound_dispatch_refs WHERE dispatch_id = $1',
        [postResult.ref.message],
      )
      expect(rows).toEqual([{ ref: null }])

      // attempts stayed at 0: a deferred attempt spends none of the
      // budget. `{ sent: 0, failed: 0 }` alone would not catch a
      // regression that treats the placeholder as resolved and proceeds
      // to a real, counted failure instead (MockAdapter would still
      // reject an edit targeting a ref it never issued, and that failure
      // also nets out to `{ sent: 0, failed: 0 }` on a single drain()
      // call), so this checks the row's own attempts column directly.
      // Mutation check: treating a null-ref row as resolved in
      // toDispatchState makes this fail with attempts: 1; see the fix
      // round 2 section of the task report for the real output.
      const { rows: outboxRows } = await pool.query<{ attempts: number }>(
        `SELECT attempts FROM outbox WHERE workspace_id = $1 AND action ->> 'kind' = 'edit'`,
        [workspaceId],
      )
      expect(outboxRows).toEqual([{ attempts: 0 }])
    },
  )

  it(
    'property 2c: a dispatch id with no placeholder row at all also defers, rather than failing ' +
      'immediately, and self-heals a placeholder for it, distinct from the pre-existing case above',
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      const dispatcher = new OutboundDispatcher(
        pool,
        namedAdapter(adapter, `mock-${randomUUID()}`),
        workspaceId,
        { now: () => new Date(3_000_000) },
      )

      // Fabricated: nothing ever called perform({kind:'post'}) for this id,
      // so unlike property 2b above, no row exists yet at all.
      const fabricatedDispatchId = randomUUID()
      const { rows: before } = await pool.query(
        'SELECT 1 FROM outbound_dispatch_refs WHERE dispatch_id = $1',
        [fabricatedDispatchId],
      )
      expect(before).toHaveLength(0)

      await dispatcher.perform({
        kind: 'edit',
        ref: { channel: 'C1', message: fabricatedDispatchId },
        text: 'fabricated',
      })

      const result = await dispatcher.drain()
      expect(result).toEqual({ sent: 0, failed: 0 })
      expect(adapter.performed).toHaveLength(0)

      const { rows: after } = await pool.query<{ ref: unknown; dispatched_at: Date }>(
        'SELECT ref, dispatched_at FROM outbound_dispatch_refs WHERE dispatch_id = $1',
        [fabricatedDispatchId],
      )
      expect(after).toEqual([{ ref: null, dispatched_at: expect.any(Date) }])

      const { rows: outboxRows } = await pool.query<{ attempts: number; status: string }>(
        `SELECT attempts, status FROM outbox WHERE workspace_id = $1`,
        [workspaceId],
      )
      expect(outboxRows).toEqual([expect.objectContaining({ attempts: 0, status: 'pending' })])
    },
  )

  it(
    'property 2 (many cycles): an edit whose post is repeatedly deferred across many drain ' +
      'cycles, more than maxAttempts, still delivers once the post lands, spending none of the ' +
      'attempts budget along the way',
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      let clock = new Date(20_000_000) // T0: the post's own next_attempt_at and dispatched_at anchor
      const dispatcher = new OutboundDispatcher(
        pool,
        namedAdapter(adapter, `mock-${randomUUID()}`),
        workspaceId,
        { now: () => clock, batchSize: 1, maxAttempts: 5 },
      )

      const postResult = await dispatcher.perform({
        kind: 'post',
        ref: { channel: 'C1' },
        text: 'slow to land',
      })
      const dispatchId = postResult.ref.message as string

      // Rewound well below T0: for the whole waiting phase below, the
      // edit's own next_attempt_at sorts strictly earlier than the post's,
      // so batchSize 1 claims only the edit, never the post, on every
      // cycle, the same isolation property 2b above uses.
      clock = new Date(clock.getTime() - 60_000)
      const editRef = { channel: 'C1', message: dispatchId }
      await dispatcher.perform({ kind: 'edit', ref: editRef, text: 'depends on the slow post' })

      const CYCLES = 8 // > maxAttempts (5)
      for (let i = 0; i < CYCLES; i += 1) {
        const result = await dispatcher.drain()
        expect(result).toEqual({ sent: 0, failed: 0 })
        // Comfortably more than dependencyRetryMs's default (2000ms), so
        // the edit's rescheduled next_attempt_at is always eligible again
        // by the following iteration.
        clock = new Date(clock.getTime() + 3000)
      }
      expect(adapter.performed).toHaveLength(0)

      const { rows: attemptsCheck } = await pool.query<{ attempts: number }>(
        `SELECT attempts FROM outbox WHERE workspace_id = $1 AND action ->> 'kind' = 'edit'`,
        [workspaceId],
      )
      // Eight deferred cycles, more than maxAttempts (5), none of them
      // counted: this is the fix round 1 finding 2 assertion. Mutation
      // check: reverting OutboxDeferError to a plain Error here makes this
      // fail (the row reaches terminal 'failed' well before cycle 8); see
      // the fix round 1 section of the task report for the real output.
      expect(attemptsCheck).toEqual([{ attempts: 0 }])

      // Let the post land: advance the clock past T0, then drain enough
      // times to deliver both rows regardless of which order batchSize 1
      // happens to claim them in from here.
      clock = new Date(20_000_000 + 5000)
      for (let i = 0; i < 3; i += 1) {
        await dispatcher.drain()
        clock = new Date(clock.getTime() + 3000)
      }

      expect(adapter.performed).toHaveLength(2)
      const kinds = adapter.performed.map((action) => action.kind)
      expect(kinds).toEqual(expect.arrayContaining(['post', 'edit']))
      const editAction = adapter.performed.find((action) => action.kind === 'edit')
      if (editAction?.kind !== 'edit') throw new Error('expected an edit action')
      expect(editAction.text).toBe('depends on the slow post')
    },
  )

  it(
    "'upload' does not mint a dispatch id: it dispatches like setStatus, with no " +
      'outbound_dispatch_refs row and no dependency tracking (finding 1, fix round 1)',
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter({ ...DEFAULT_MOCK_CAPABILITIES, fileUpload: true })
      const dispatcher = new OutboundDispatcher(
        pool,
        namedAdapter(adapter, `mock-${randomUUID()}`),
        workspaceId,
      )

      const action: ChatAction = {
        kind: 'upload',
        ref: { channel: 'C1' },
        filename: 'proof.bin',
        bytes: new Uint8Array([1, 2, 3]),
      }
      const result = await dispatcher.perform(action)
      // No synthetic dispatch id: unlike a 'post' action's synthetic
      // ChatActionResult.ref.message, this is exactly the caller's own ref.
      expect(result).toEqual({ ref: { channel: 'C1' } })

      expect(await dispatcher.drain()).toEqual({ sent: 0, failed: 0 })
      const drainResult = await dispatcher.drainUploads()
      expect(drainResult).toEqual({ sent: 1, failed: 0 })
      expect(adapter.performed).toEqual([action])

      const { rows } = await pool.query(
        'SELECT 1 FROM outbound_dispatch_refs WHERE workspace_id = $1',
        [workspaceId],
      )
      expect(rows).toHaveLength(0)
    },
  )

  it(
    "a dispatch id belonging to workspace A is not visible to a lookup for workspace B, and a " +
      "resolved-ref write for A cannot land on B's row (finding C, fix round 3)",
    async () => {
      const workspaceA = await createWorkspace()
      const workspaceB = await createWorkspace()
      const adapterA = new MockAdapter()
      const adapterB = new MockAdapter()
      // Distinct adapter names for A and B, same as every other test in
      // this file: Outbox.drain() itself scopes by adapter name, not by
      // workspace (see namedAdapter's own doc comment), so sharing a name
      // here would let either dispatcher's drain() claim the other's row
      // for an unrelated reason and make this test's outcome depend on
      // that instead of on outbound_dispatch_refs's own workspace scoping,
      // which is what finding C is actually about.
      const dispatcherA = new OutboundDispatcher(
        pool,
        namedAdapter(adapterA, `mock-a-${randomUUID()}`),
        workspaceA,
      )
      const dispatcherB = new OutboundDispatcher(
        pool,
        namedAdapter(adapterB, `mock-b-${randomUUID()}`),
        workspaceB,
      )

      const postResult = await dispatcherA.perform({
        kind: 'post',
        ref: { channel: 'C1' },
        text: 'workspace A only',
      })
      const dispatchId = postResult.ref.message as string

      // Workspace B references workspace A's dispatch id: exactly the
      // shape a cross-tenant bug (or a deliberate probe) would produce.
      await dispatcherB.perform({
        kind: 'edit',
        ref: { channel: 'C1', message: dispatchId },
        text: 'must never resolve for B',
      })

      const drainA = await dispatcherA.drain()
      expect(drainA).toEqual({ sent: 1, failed: 0 })
      expect(adapterA.performed).toEqual([
        { kind: 'post', ref: { channel: 'C1' }, text: 'workspace A only' },
      ])

      // B's edit must never resolve against A's now-real ref: a real,
      // attempts-counting failure (not a defer, since this dispatch id can
      // never resolve for B no matter how long it waits), not yet at
      // maxAttempts after a single drain().
      const drainB = await dispatcherB.drain()
      expect(drainB).toEqual({ sent: 0, failed: 0 })
      expect(adapterB.performed).toHaveLength(0)

      const { rows: attemptRows } = await pool.query<{ attempts: number; last_error: string | null }>(
        `SELECT attempts, last_error FROM outbox WHERE workspace_id = $1 AND action ->> 'kind' = 'edit'`,
        [workspaceB],
      )
      expect(attemptRows).toEqual([
        expect.objectContaining({
          attempts: 1,
          last_error: expect.stringContaining('does not belong to workspace'),
        }),
      ])

      // Workspace A's own resolved ref is untouched and still scoped to A.
      const { rows: refRows } = await pool.query<{ workspace_id: string; ref: { message?: string } }>(
        'SELECT workspace_id, ref FROM outbound_dispatch_refs WHERE dispatch_id = $1',
        [dispatchId],
      )
      expect(refRows).toEqual([expect.objectContaining({ workspace_id: workspaceA })])
      expect(refRows[0]?.ref?.message).toMatch(/^mock-msg-/)

      // No placeholder row was ever created under workspace B for this
      // dispatch id: the cross-tenant lookup never claims it.
      const { rows: crossRows } = await pool.query(
        'SELECT 1 FROM outbound_dispatch_refs WHERE dispatch_id = $1 AND workspace_id = $2',
        [dispatchId, workspaceB],
      )
      expect(crossRows).toHaveLength(0)
    },
  )

  it(
    'property 3: a crash between post and edit leaves a resumable state, simulated by draining ' +
      'only the post, constructing a fresh dispatcher, and draining again',
    async () => {
      const workspaceId = await createWorkspace()
      const databaseUrl = await getTestDatabaseUrl()
      const adapterName = `mock-${randomUUID()}`
      let clock = new Date(5_000_000)

      // One underlying adapter shared across both dispatcher instances: it
      // stands in for the one real Slack workspace behind them, whose
      // message ids are valid platform-wide, not scoped to whichever
      // process talks to them. Only the pool (and everything built on it)
      // is reconstructed to simulate the restart; a fresh MockAdapter
      // instance would incorrectly reject the resumed edit via its own
      // per-instance issued-message bookkeeping (test/chat/mock.ts), which
      // is a MockAdapter-only artifact, not a real constraint a live
      // platform imposes.
      const sharedAdapter = new MockAdapter()
      const firstPool = createPool(databaseUrl)
      // batchSize: 1 forces this drain() to claim only the single earliest
      // pending row, which is the post: its next_attempt_at is strictly
      // earlier than the edit's, thanks to the clock advance between the
      // two enqueue calls below. The unique adapterName is what keeps this
      // deterministic: without it, batchSize 1 would be just as likely to
      // claim an unrelated pending row left by a different test sharing
      // the default 'mock' adapter name (see namedAdapter's doc comment).
      const firstDispatcher = new OutboundDispatcher(
        firstPool,
        namedAdapter(sharedAdapter, adapterName),
        workspaceId,
        { now: () => clock, batchSize: 1 },
      )

      const postResult = await firstDispatcher.perform({
        kind: 'post',
        ref: { channel: 'C1' },
        text: 'before the crash',
      })
      clock = new Date(clock.getTime() + 1000)
      const editRef = { channel: 'C1', message: postResult.ref.message as string }
      await firstDispatcher.perform({ kind: 'edit', ref: editRef, text: 'after the crash' })

      const firstDrain = await firstDispatcher.drain()
      expect(firstDrain).toEqual({ sent: 1, failed: 0 })
      expect(sharedAdapter.performed).toEqual([
        { kind: 'post', ref: { channel: 'C1' }, text: 'before the crash' },
      ])

      const rowsAfterFirstDrain = await outboxRowsFor(workspaceId)
      expect(rowsAfterFirstDrain).toEqual(
        expect.arrayContaining([
          { status: 'sent', kind: 'post' },
          { status: 'pending', kind: 'edit' },
        ]),
      )

      // "Crash": the first pool and dispatcher are simply abandoned, never
      // touched again, the same way test/chat/outbox.test.ts's own restart
      // test discards its first instance.
      await closePool(firstPool)

      const secondPool = createPool(databaseUrl)
      const secondDispatcher = new OutboundDispatcher(
        secondPool,
        namedAdapter(sharedAdapter, adapterName),
        workspaceId,
        { now: () => clock },
      )
      const secondDrain = await secondDispatcher.drain()
      await closePool(secondPool)

      expect(secondDrain).toEqual({ sent: 1, failed: 0 })
      expect(sharedAdapter.performed).toEqual([
        { kind: 'post', ref: { channel: 'C1' }, text: 'before the crash' },
        { kind: 'edit', ref: expect.objectContaining({ channel: 'C1' }), text: 'after the crash' },
      ])
      const editAction = sharedAdapter.performed[1]
      if (editAction?.kind !== 'edit') throw new Error('expected an edit action')
      expect(editAction.ref.message).toMatch(/^mock-msg-/)

      const rowsAfterSecondDrain = await outboxRowsFor(workspaceId)
      expect(rowsAfterSecondDrain).toEqual(
        expect.arrayContaining([
          { status: 'sent', kind: 'post' },
          { status: 'sent', kind: 'edit' },
        ]),
      )
    },
  )

  describe('ProgressReporter through OutboundDispatcher', () => {
    it('property 4: still produces exactly one message across many updates, once drained', async () => {
      vi.useFakeTimers()
      try {
        const workspaceId = await createWorkspace()
        const adapter = new MockAdapter()
        await adapter.start(async () => {})
        const dispatcher = new OutboundDispatcher(
          pool,
          namedAdapter(adapter, `mock-${randomUUID()}`),
          workspaceId,
          { now: () => new Date(), backoffMs: () => 0 },
        )
        const reporter = new ProgressReporter(dispatcher, { channel: 'C1' }, { minIntervalMs: 1000 })

        await reporter.update('step 1')
        for (let i = 2; i <= 30; i += 1) {
          await reporter.update(`step ${i}`)
        }
        await reporter.finish('done')
        await vi.advanceTimersByTimeAsync(1000)

        // Two drains: the dependency depth here is exactly one level
        // (every edit depends directly on the post, never on another
        // edit), so a post-then-edit pair always resolves within two
        // drain() calls regardless of which order Outbox happened to
        // claim them in.
        await dispatcher.drain()
        await dispatcher.drain()

        const posts = adapter.performed.filter((action) => action.kind === 'post')
        expect(posts).toHaveLength(1)
        const lastAction = adapter.performed.at(-1)
        expect(lastAction).toMatchObject({ text: 'done' })
      } finally {
        vi.useRealTimers()
      }
    })

    it('property 5: finish() lands even when called inside the throttle window, once drained', async () => {
      vi.useFakeTimers()
      try {
        const workspaceId = await createWorkspace()
        const adapter = new MockAdapter()
        await adapter.start(async () => {})
        const dispatcher = new OutboundDispatcher(
          pool,
          namedAdapter(adapter, `mock-${randomUUID()}`),
          workspaceId,
          { now: () => new Date(), backoffMs: () => 0 },
        )
        const reporter = new ProgressReporter(dispatcher, { channel: 'C1' }, { minIntervalMs: 5000 })

        await reporter.update('in progress') // immediate post, starts the cooldown
        await reporter.update('still in progress') // inside the cooldown: only scheduled
        await reporter.finish('complete') // must preempt the cooldown, not wait for it

        // The cooldown timer "still in progress" scheduled must not be able
        // to overwrite finish's result later, even once it fires.
        await vi.advanceTimersByTimeAsync(5000)

        await dispatcher.drain()
        await dispatcher.drain()

        const posts = adapter.performed.filter((action) => action.kind === 'post')
        expect(posts).toHaveLength(1)
        const lastAction = adapter.performed.at(-1)
        expect(lastAction).toMatchObject({ text: 'complete' })
        expect(
          adapter.performed.some(
            (action) =>
              (action.kind === 'post' || action.kind === 'edit') && action.text === 'still in progress',
          ),
        ).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('delivers an approval card once, with its blocks, and a second drain posts nothing more', async () => {
    const workspaceId = await createWorkspace()
    const adapter = new MockAdapter()
    const dispatcher = new OutboundDispatcher(pool, namedAdapter(adapter, `mock-${randomUUID()}`), workspaceId)
    const blocks = [{ type: 'actions', elements: [] }]

    const queued = await dispatcher.perform({ kind: 'post_approval_card', ref: { channel: 'C1', thread: '1.1' }, text: 'Approval needed', blocks })
    expect(queued.ref.message).toBeDefined()

    expect(await dispatcher.drain()).toEqual({ sent: 1, failed: 0 })
    expect(await dispatcher.drain()).toEqual({ sent: 0, failed: 0 })
    expect(adapter.performed).toEqual([{ kind: 'post_approval_card', ref: { channel: 'C1', thread: '1.1' }, text: 'Approval needed', blocks }])
  })

  it('carries setStatus and other ref-only actions through unchanged, with no dispatch id involved', async () => {
    const workspaceId = await createWorkspace()
    const adapter = new MockAdapter()
    const dispatcher = new OutboundDispatcher(
      pool,
      namedAdapter(adapter, `mock-${randomUUID()}`),
      workspaceId,
    )

    const action: ChatAction = { kind: 'setStatus', ref: { channel: 'C1' }, status: 'typing' }
    const result = await dispatcher.perform(action)
    expect(result).toEqual({ ref: { channel: 'C1' } })

    const drainResult = await dispatcher.drain()
    expect(drainResult).toEqual({ sent: 1, failed: 0 })
    expect(adapter.performed).toEqual([action])
  })

  it("exposes name and capabilities pass-through from the real adapter, so ProgressReporter's capability checks still work", () => {
    const adapter = new MockAdapter({ ...DEFAULT_MOCK_CAPABILITIES, editMessage: false })
    const dispatcher = new OutboundDispatcher(pool, adapter, randomUUID())
    expect(dispatcher.name).toBe('mock')
    expect(dispatcher.capabilities.editMessage).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Gate fix, High 1: the outbox claim is bound to this dispatcher's own
  // workspace, so two workspaces' rows can never be claimed by each
  // other's dispatcher.
  // -------------------------------------------------------------------------

  it(
    "two workspaces' rows cannot be claimed by each other's dispatcher, even sharing the same " +
      'adapter name (isolating workspace scoping from the adapter-name scoping every other test ' +
      'in this file already relies on)',
    async () => {
      const workspaceA = await createWorkspace()
      const workspaceB = await createWorkspace()
      const sharedAdapterName = `mock-shared-${randomUUID()}`
      const adapterA = new MockAdapter()
      const adapterB = new MockAdapter()

      const dispatcherA = new OutboundDispatcher(pool, namedAdapter(adapterA, sharedAdapterName), workspaceA)
      const dispatcherB = new OutboundDispatcher(pool, namedAdapter(adapterB, sharedAdapterName), workspaceB)

      await dispatcherA.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'belongs to workspace A' })
      await dispatcherB.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'belongs to workspace B' })

      // Both rows are pending, same adapter name, different workspaces.
      // Draining B must deliver only B's own row, never A's, despite the
      // shared adapter name that would have let it through before this fix.
      const drainB = await dispatcherB.drain()
      expect(drainB).toEqual({ sent: 1, failed: 0 })
      expect(adapterB.performed).toEqual([
        expect.objectContaining({ text: 'belongs to workspace B' }),
      ])
      expect(adapterA.performed).toHaveLength(0)

      const drainA = await dispatcherA.drain()
      expect(drainA).toEqual({ sent: 1, failed: 0 })
      expect(adapterA.performed).toEqual([
        expect.objectContaining({ text: 'belongs to workspace A' }),
      ])

      // Each adapter only ever saw its own workspace's row, never the
      // other's, across both drains.
      expect(adapterB.performed).toHaveLength(1)
    },
  )

  // -------------------------------------------------------------------------
  // Gate fix, Blocker 3: the placeholder insert and the outbox enqueue
  // commit together, in one transaction, so a crash between them cannot
  // leave an orphaned placeholder with no matching outbox row.
  // -------------------------------------------------------------------------

  it(
    'a failure between the placeholder insert and the outbox enqueue leaves no orphan: the whole ' +
      'transaction rolls back rather than leaving a placeholder row with no outbox row behind it',
    async () => {
      const workspaceId = await createWorkspace()
      const adapter = new MockAdapter()
      const dispatcher = new OutboundDispatcher(pool, namedAdapter(adapter, `mock-${randomUUID()}`), workspaceId)

      const { rows: beforeRefs } = await pool.query('SELECT 1 FROM outbound_dispatch_refs WHERE workspace_id = $1', [
        workspaceId,
      ])
      const { rows: beforeOutbox } = await pool.query('SELECT 1 FROM outbox WHERE workspace_id = $1', [workspaceId])
      expect(beforeRefs).toHaveLength(0)
      expect(beforeOutbox).toHaveLength(0)

      // Simulates the crash window itself: the placeholder insert succeeds
      // (as a statement, inside the still-open transaction), but the
      // second insert this same transaction depends on, the outbox
      // enqueue, fails before the transaction ever commits.
      const failingPool = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === 'connect') {
            return async (...args: unknown[]) => {
              const client = await (target.connect as (...a: unknown[]) => Promise<PoolClient>)(...args)
              return new Proxy(client, {
                get(clientTarget, clientProp, clientReceiver) {
                  if (clientProp === 'query') {
                    return (...queryArgs: unknown[]) => {
                      const first = queryArgs[0]
                      const sql = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text
                      if (typeof sql === 'string' && sql.includes('INSERT INTO outbox')) {
                        return Promise.reject(new Error('simulated crash before the outbox enqueue commits'))
                      }
                      return (clientTarget.query as (...a: unknown[]) => unknown)(...queryArgs)
                    }
                  }
                  return Reflect.get(clientTarget, clientProp, clientReceiver)
                },
              })
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      }) as unknown as Pool

      const failingDispatcher = new OutboundDispatcher(
        failingPool,
        namedAdapter(adapter, `mock-${randomUUID()}`),
        workspaceId,
      )

      await expect(
        failingDispatcher.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'never durably queued' }),
      ).rejects.toThrow('simulated crash before the outbox enqueue commits')

      // No orphan: the placeholder insert that DID succeed as a statement
      // was rolled back along with everything else in its transaction, so
      // neither table shows any trace of this attempt.
      const { rows: afterRefs } = await pool.query('SELECT 1 FROM outbound_dispatch_refs WHERE workspace_id = $1', [
        workspaceId,
      ])
      const { rows: afterOutbox } = await pool.query('SELECT 1 FROM outbox WHERE workspace_id = $1', [workspaceId])
      expect(afterRefs).toHaveLength(0)
      expect(afterOutbox).toHaveLength(0)
    },
  )
})
