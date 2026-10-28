/**
 * Routes ProgressReporter's ChatAction calls through the durable Outbox
 * (src/chat/outbox.ts) instead of straight at a ChatAdapter, closing PRE-1
 * (docs/decisions/open-questions.md): nothing in production constructed an
 * Outbox, so FR-CA-3's guarantee that an outbound message is never lost was
 * unwired. `OutboundDispatcher` implements `ChatAdapter` itself, so it is a
 * drop-in replacement for the raw adapter ProgressReporter's constructor
 * already accepts; no signature on either class needs to change.
 *
 * SEQUENCING DESIGN, stated explicitly because a naive queue would break it.
 *
 * ProgressReporter posts once, then edits that same message repeatedly. An
 * edit's ChatAction carries `ref.message`, the id the post's result
 * returned. Outbox drains rows independently of one another (FOR UPDATE
 * SKIP LOCKED over whatever is pending, `ORDER BY next_attempt_at` with no
 * further tiebreaker), so a queue that just replayed rows in claim order
 * could attempt an edit before its post ever reached the platform, and
 * would then be targeting a message that does not exist yet.
 *
 * This is solved with a DEPENDENCY REFERENCE from the edit to its post, not
 * a per-session ordering key. Concretely:
 *
 *   - `perform()` on a 'post' action mints a random dispatch id
 *     (crypto.randomUUID, independent of anything Postgres or the platform
 *     assigns), immediately writes a placeholder row for it to
 *     `outbound_dispatch_refs` (ref not known yet, but `dispatched_at` is),
 *     and hands the id back to the caller as `ChatActionResult.ref.message`
 *     before the action has been sent anywhere. ProgressReporter, unaware
 *     this id is synthetic, threads it into every later edit's
 *     `ref.message` exactly the way it already does today (see
 *     progress.ts's `#buildEditRef`). 'upload' is deliberately excluded;
 *     see "Why 'upload' does not mint a dispatch id" below.
 *   - The adapter Outbox actually calls at drain time is a decorator around
 *     the real one. For 'post' it strips the synthetic `ref.message` (the
 *     real platform has never heard of it, and a fresh post has no message
 *     yet) before delegating, then once the real call returns, fills in the
 *     real `ChatActionResult.ref` on that same placeholder row.
 *   - For 'edit' it looks the dispatch id in `ref.message` up in that table
 *     first (lookupDispatchState below). Resolved: the real ref is
 *     substituted before delegating. Unresolved, but still within
 *     `dependencyDeadlineMs` of when the dispatch id was first observed: it
 *     throws `OutboxDeferError` (src/chat/outbox.ts), which reschedules the
 *     row without spending any of its `maxAttempts` budget, exactly what
 *     fix round 1's finding 2 asked for. Past the deadline: it throws a
 *     plain error instead, which does spend a real attempt and can reach
 *     Outbox's ordinary terminal 'failed' state, so a genuinely
 *     undeliverable edit still terminates rather than deferring forever.
 *
 * "Unresolved" covers two distinct row shapes, deliberately treated the
 * same way rather than merely coerced into looking the same: a placeholder
 * row that exists but whose `ref` is still null (the post has not
 * delivered yet), and no row at all. The second should not normally
 * happen, since insertPlaceholder is awaited before any dispatch id is
 * ever handed back to a caller, but a caller can still construct an edit
 * around a fabricated ref (a test legitimately does; a bug elsewhere
 * could too), and there is no way to tell that apart, from in here, from a
 * row that is merely not visible yet. Fix round 1 already established that
 * a dependency wait must not fail closed early; treating "no row" as an
 * immediate, attempts-spending failure would reintroduce exactly that
 * shape of bug for this one case. Instead lookupDispatchState lazily
 * creates the missing placeholder, anchored to the current instant, so
 * both cases converge onto the same deferral path and the same deadline,
 * measured from a real anchor either way. Fix round 2's own tests exercise
 * the two as separate cases even though they now behave identically, per
 * its own request to keep them distinguishable rather than silently fused.
 *
 * This makes the dependency self-enforcing rather than order-dependent:
 * even if Outbox claims the edit before its post in the same batch (a real
 * possibility, not a hypothetical one: this project's tests run under
 * Vitest fake timers, where two enqueues issued in the same tick get an
 * identical `next_attempt_at`, so ties are the common case here, not the
 * rare one), the edit simply defers and succeeds on a later attempt once
 * the post has landed. The alternative on the table was a per-session
 * ordering key, which was rejected: it would require Outbox itself to
 * understand cross-row dependencies when claiming a batch, and this task
 * was told to consume Outbox as-is rather than change its claim query.
 *
 * COST, stated plainly rather than implied away. An edit whose post has not
 * landed yet costs one `OutboxDeferError` reschedule per drain() cycle it
 * is attempted in, for as long as `dependencyDeadlineMs` allows (ten
 * minutes by default); that is deliberately generous, because the whole
 * point of fix round 1 is that a busy shared adapter can legitimately take
 * a while to get back around to a delayed post. Past the deadline, the
 * edit starts spending Outbox's ordinary maxAttempts budget and can reach
 * terminal 'failed', same as any other genuine delivery failure. A retried
 * post also costs a second, idempotent write to `outbound_dispatch_refs`
 * under the same dispatch id (a plain UPDATE, not a crash): if a perform()
 * call times out per Outbox's `performTimeoutMs` but the platform actually
 * received it, Outbox's own retry can call the real adapter again for the
 * same row, which would try to record the ref a second time. That
 * duplicate write is this file's reflection of the same at-least-once
 * caveat outbox.ts's drain() doc comment already states and OQ-2 already
 * records; this file introduces no new delivery-count guarantee beyond
 * what Outbox already makes.
 *
 * Why 'upload' does not mint a dispatch id. The real SlackAdapter's
 * perform() for 'upload' (src/chat/slack/adapter.ts) returns
 * `{ ref: action.ref }` unchanged: it never learns a real message id for an
 * uploaded file, unlike 'post'. MockAdapter mints one anyway, which would
 * have masked this divergence completely: a test built against the mock
 * would look like edit-of-upload works, then hang forever against the real
 * adapter, since `outbound_dispatch_refs` would never gain a resolved ref
 * to record. Minting an id this project's own real adapter can never
 * resolve is not an honest option, so 'upload' is scoped out of
 * needsDispatchId below; it enqueues and delivers exactly like 'setStatus'
 * does, with no dispatch id and no dependency tracking. If a real
 * edit-of-upload flow is ever needed, SlackAdapter's 'upload' handling
 * would have to start returning a real message ref first (a change to a
 * file this task does not own), and only then should 'upload' rejoin
 * needsDispatchId.
 *
 * `perform()` itself only enqueues; it never drains. That is required for
 * property 1 in the task report: the write to Postgres must complete and
 * be observable to a second process before either process attempts
 * delivery, or "drained by a different instance" would be untestable. The
 * real consequence: nothing in this file, or anywhere else in the current
 * P0.3 plan, calls drain() on a schedule. An enqueued action reaches the
 * platform only when something calls `drain()`, which today means a test
 * or a future caller, not a running process. That gap is named here
 * rather than hidden behind a passing test suite; see the task report.
 */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type {
  AdapterCapabilities,
  ChatAction,
  ChatActionResult,
  ChatAdapter,
  ChatEvent,
  ChatRef,
} from '../chat/contract.js'
import { Outbox, OutboxDeferError } from '../chat/outbox.js'
import type { OutboxDrainResult, OutboxOptions } from '../chat/outbox.js'
import type { Logger } from '../obs/logger.js'

/**
 * How long, at most, an edit will keep deferring (via OutboxDeferError,
 * spending no attempts) while its dependency has not resolved yet, before
 * it starts spending Outbox's own maxAttempts budget instead. Ten minutes
 * is deliberately generous: it exists to absorb a busy shared adapter
 * taking several drain() cycles to get back around to a delayed post, not
 * to bound how fast a healthy system delivers.
 */
const DEFAULT_DEPENDENCY_DEADLINE_MS = 10 * 60 * 1000

/** How long a deferred edit waits before its next attempt. Short and fixed, not exponential backoff: a defer is not a failure, so there is no reason to back off the way a real error would. */
const DEFAULT_DEPENDENCY_RETRY_MS = 2000

export type OutboundDispatcherOptions = OutboxOptions & {
  /** Overrides DEFAULT_DEPENDENCY_DEADLINE_MS. */
  dependencyDeadlineMs?: number
  /** Overrides DEFAULT_DEPENDENCY_RETRY_MS. */
  dependencyRetryMs?: number
}

type DispatchableAction = Extract<ChatAction, { kind: 'post' | 'post_approval_card' }>

/** Only a post (plain or with an approval card) mints a dispatch id; see the class doc comment's "Why 'upload' does not mint a dispatch id". */
function needsDispatchId(action: ChatAction): action is DispatchableAction {
  return action.kind === 'post' || action.kind === 'post_approval_card'
}

/** Drops a dispatcher-minted dispatch id back out of a post ref before it reaches the real adapter, which never issued it and must not receive it. */
function withoutDispatchMessage(ref: ChatRef): ChatRef {
  const { message: _message, ...rest } = ref
  return rest
}

/**
 * Builds the real ref a resolved edit should target: the edit's own
 * channel (already real), the resolved thread when the post landed in one
 * and the edit did not already say otherwise, and the resolved message,
 * built conditionally so `exactOptionalPropertyTypes` never sees an
 * explicit `undefined` for `thread`.
 */
function buildResolvedEditRef(
  editRef: Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef,
  resolved: ChatRef,
): Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef {
  const ref: Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef = {
    channel: editRef.channel,
    // Callers only reach this function once `resolved.message` has already
    // been confirmed to be a real string; see lookupDispatchState's
    // 'resolved' variant, the only source of `resolved` here.
    message: resolved.message as string,
  }
  const thread = editRef.thread ?? resolved.thread
  if (thread !== undefined) ref.thread = thread
  return ref
}

/**
 * The two states a dependency lookup can settle on, made explicit as a
 * type rather than left as an implicit `null`/`undefined` reading on a raw
 * row, per fix round 2's finding. "No row at all" and "a placeholder row
 * whose ref is still null" both collapse into `unresolved`; see
 * lookupDispatchState's own doc comment for why. Only `resolved` carries a
 * ref a caller may act on.
 *
 * DELIBERATELY TWO STATES, NOT THREE, decided against fix round 2's own
 * suggestion of a third. The behavior is genuinely identical either way:
 * both "never enqueued" and "enqueued but not yet delivered" defer, on the
 * same deadline, for the same reason, and every caller of this type
 * (decorateAdapter's 'edit' branch) treats them identically too, so a
 * third type variant would exist purely to be immediately collapsed back
 * by its only consumer. The type's job is to make the compiler enforce
 * "only a real ref may be acted on"; it is not the right place to also
 * carry an operational distinction nothing downstream of it uses.
 *
 * That does not mean the distinction is worthless, only that a type is
 * the wrong place to keep it: an operator debugging a missing progress
 * update at 2am does still need to tell "this dispatch id was never
 * dispatched at all" apart from "it was dispatched and is just slow", so
 * lookupDispatchState logs the two cases on separate, differently worded
 * lines when a logger is supplied (`missing` for the self-heal path
 * versus a placeholder row already existing), keeping the diagnosis
 * available without threading a third type variant through code that
 * would otherwise have to immediately re-merge it.
 */
type DispatchState =
  | { status: 'resolved'; ref: ChatRef }
  | { status: 'unresolved'; dispatchedAt: Date }

/**
 * `dispatched_at` is a Date, not a string: node-postgres parses timestamptz
 * columns into JavaScript Date values by default, and this project installs
 * no custom type parser to change that.
 */
type DispatchRefRow = { ref: ChatRef | null; dispatched_at: Date }

function toDispatchState(row: DispatchRefRow): DispatchState {
  if (row.ref?.message !== undefined) return { status: 'resolved', ref: row.ref }
  return { status: 'unresolved', dispatchedAt: row.dispatched_at }
}

/**
 * Writes the placeholder row for a freshly minted dispatch id, always
 * called (and always awaited) before that id is ever handed back to a
 * caller. `dispatchedAt` is stamped from the dispatcher's own injected
 * clock, deliberately not left to the column's DEFAULT now(): the deadline
 * check in decorateAdapter subtracts this value from that same injected
 * clock, and the two sides of that subtraction have to come from one clock
 * to mean anything. Postgres's own now() is server wall-clock; mixing it
 * with a caller-supplied `options.now` (this project's tests routinely use
 * a fixed, past-dated one) would turn the elapsed time into the gap
 * between two unrelated timelines, decades of false "elapsed" time in a
 * test and a real, if usually small, client/server skew in production.
 */
async function insertPlaceholder(
  executor: Pool | PoolClient,
  dispatchId: string,
  workspaceId: string,
  dispatchedAt: Date,
): Promise<void> {
  await executor.query(
    `INSERT INTO outbound_dispatch_refs (dispatch_id, workspace_id, dispatched_at)
     VALUES ($1, $2, $3)`,
    [dispatchId, workspaceId, dispatchedAt],
  )
}

async function storeResolvedRef(
  pool: Pool,
  dispatchId: string,
  workspaceId: string,
  ref: ChatRef,
): Promise<void> {
  // Scoped by workspace_id as well as dispatch_id (fix round 3, finding
  // C): dispatch ids are random UUIDs, so in practice this predicate
  // never changes which row a legitimate call updates, but it is what
  // stops a resolution meant for one tenant from ever being able to land
  // on a different tenant's row, matching AP-8 the way every other
  // workspace-scoped query in this project already does.
  //
  // A plain UPDATE, not an insert: insertPlaceholder already created this
  // row when the dispatch id was minted, before the post was even
  // enqueued, so every dispatch id reaching here already has a row. Safe
  // to run twice for the same dispatch id (idempotent overwrite) if
  // Outbox's own at-least-once retry-on-timeout path calls the real
  // adapter again for a row that actually already delivered; see the
  // class doc comment's COST section.
  await pool.query(
    `UPDATE outbound_dispatch_refs SET ref = $3, resolved_at = now()
     WHERE dispatch_id = $1 AND workspace_id = $2`,
    [dispatchId, workspaceId, ref],
  )
}

/**
 * Reads the dependency state for `dispatchId`, self-healing a missing row
 * into a fresh placeholder rather than treating "no row" as a separate,
 * immediately hard-failing case. See the class doc comment's paragraph on
 * why the two converge: in short, a dependency wait must not fail closed
 * early (fix round 1), and "no row" cannot be told apart from in here as
 * "not visible yet" versus "will truly never exist", so both are anchored
 * to now and given the same deadline-bounded deferral instead.
 *
 * Every read and write here is scoped by `workspaceId` as well as
 * `dispatchId` (fix round 3, finding C): dispatch ids are random UUIDs, so
 * a real cross-tenant collision does not happen in practice, but a lookup
 * that accepted a workspaceId and then ignored it would be a guarantee
 * this project has been careful about elsewhere (AP-8, Task 1's team-id
 * to workspace-uuid mapping, Task 2's per-workspace session uniqueness)
 * silently not held here. If the dispatch id genuinely belongs to a
 * different workspace than the caller's own, this now behaves as if no
 * row exists at all: never reads or resolves against the other tenant's
 * row, and eventually reaches the plain (attempts-counting) error path
 * below once the deadline passes, rather than the self-heal path racing
 * that other tenant's own row forever.
 *
 * `log`, when supplied, records which of the two collapsed unresolved
 * cases this call hit (finding D): "missing" when no placeholder existed
 * at all, "pending" when one did but its ref is still null. The
 * `DispatchState` type intentionally does not carry this distinction (see
 * its own doc comment for why); this is where an operator gets it back.
 */
async function lookupDispatchState(
  pool: Pool,
  dispatchId: string,
  workspaceId: string,
  now: () => Date,
  log: Logger | undefined,
): Promise<DispatchState> {
  const { rows } = await pool.query<DispatchRefRow>(
    'SELECT ref, dispatched_at FROM outbound_dispatch_refs WHERE dispatch_id = $1 AND workspace_id = $2',
    [dispatchId, workspaceId],
  )
  const existing = rows[0]
  if (existing) {
    const state = toDispatchState(existing)
    if (state.status === 'unresolved') {
      log?.info(
        { dispatchId, workspaceId, dependencyState: 'pending' },
        'outbound dispatch dependency exists but has not resolved yet',
      )
    }
    return state
  }

  const inserted = await pool.query<DispatchRefRow>(
    `INSERT INTO outbound_dispatch_refs (dispatch_id, workspace_id, dispatched_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (dispatch_id) DO NOTHING
     RETURNING ref, dispatched_at`,
    [dispatchId, workspaceId, now()],
  )
  if (inserted.rows[0]) {
    log?.warn(
      { dispatchId, workspaceId, dependencyState: 'missing' },
      'outbound dispatch dependency was never minted for this workspace; self-healing a placeholder',
    )
    return toDispatchState(inserted.rows[0])
  }

  // No row was returned from the INSERT, which happens in exactly two
  // cases now that both are scoped by workspace_id: a genuine race against
  // a concurrent insert for the very same id in this same workspace
  // (vanishingly unlikely: dispatch ids are random UUIDs), or the id
  // belongs to a different workspace entirely, so ON CONFLICT DO NOTHING
  // fired against a row this query can never read back. Re-reading, scoped
  // the same way, tells the two apart: a hit is the race, handled below
  // exactly like the normal self-heal path. A miss means the dispatch id
  // exists but not for this workspace, which cannot be handled by
  // deferring: unlike "not dispatched yet", this dispatch id will NEVER
  // resolve for this workspace, no matter how long the caller waits, and
  // there is nowhere durable to anchor a deadline for it either, since the
  // conflict means this workspace can never own a placeholder row for it.
  // A real, attempts-counting error, not OutboxDeferError, is the honest
  // outcome, and it is thrown here rather than returned as an unresolved
  // state precisely so it is never mistaken for one that might still
  // resolve.
  const { rows: retried } = await pool.query<DispatchRefRow>(
    'SELECT ref, dispatched_at FROM outbound_dispatch_refs WHERE dispatch_id = $1 AND workspace_id = $2',
    [dispatchId, workspaceId],
  )
  const retriedRow = retried[0]
  if (!retriedRow) {
    log?.error(
      { dispatchId, workspaceId },
      'outbound dispatch id exists for a different workspace; refusing to read or defer across ' +
        'the tenant boundary',
    )
    throw new Error(
      `outbound dispatch ${dispatchId} does not belong to workspace ${workspaceId}; the edit ` +
        'that references it can never be delivered',
    )
  }
  log?.warn(
    { dispatchId, workspaceId, dependencyState: 'missing' },
    'outbound dispatch dependency was never minted for this workspace; self-healing a placeholder',
  )
  return toDispatchState(retriedRow)
}

export class OutboundDispatcher implements ChatAdapter {
  readonly #pool: Pool
  readonly #realAdapter: ChatAdapter
  readonly #workspaceId: string
  readonly #outbox: Outbox
  readonly #now: () => Date

  readonly name: string
  readonly capabilities: AdapterCapabilities

  constructor(
    pool: Pool,
    adapter: ChatAdapter,
    workspaceId: string,
    options: OutboundDispatcherOptions = {},
  ) {
    this.#pool = pool
    this.#realAdapter = adapter
    this.#workspaceId = workspaceId
    this.name = adapter.name
    this.capabilities = adapter.capabilities
    const dependencyDeadlineMs = options.dependencyDeadlineMs ?? DEFAULT_DEPENDENCY_DEADLINE_MS
    const dependencyRetryMs = options.dependencyRetryMs ?? DEFAULT_DEPENDENCY_RETRY_MS
    // The same clock Outbox itself reads, resolved once here so the
    // dispatcher and its Outbox can never end up reading different clocks.
    this.#now = options.now ?? (() => new Date())
    this.#outbox = new Outbox(
      pool,
      decorateAdapter({
        pool,
        real: adapter,
        workspaceId,
        dependencyDeadlineMs,
        dependencyRetryMs,
        now: this.#now,
        log: options.log,
      }),
      // Gate fix, High 1: this dispatcher is always bound to exactly one
      // workspace for its whole lifetime (the `workspaceId` constructor
      // parameter above), so its own internal Outbox is bound the same
      // way, closing the claim-ignores-workspace defect at production's one
      // real caller. `...options` first, so a caller cannot accidentally
      // override this by passing its own `workspaceId` in options; this
      // dispatcher's own constructor parameter is always the source of
      // truth for which workspace it drains.
      { ...options, workspaceId },
    )
  }

  async start(handler: (event: ChatEvent) => Promise<void>): Promise<void> {
    await this.#realAdapter.start(handler)
  }

  async stop(): Promise<void> {
    await this.#realAdapter.stop()
  }

  /**
   * Durably enqueues `action` and returns immediately; it does not deliver
   * it. See the class doc comment for why perform() never drains and for
   * the production gap that leaves.
   *
   * Gate fix, Blocker 3: the placeholder insert and the outbox enqueue for
   * a 'post' action now commit together, in ONE transaction, never two.
   * Before this fix they were two separate, independently-committed
   * statements: insertPlaceholder committed on its own, and only then did
   * `this.#outbox.enqueue` commit separately. A crash in that window left a
   * placeholder row with `dispatched_at` set but no `ref` and, critically,
   * no matching `outbox` row at all: the action text itself was gone,
   * permanently, with only an orphaned placeholder to show a post had ever
   * been attempted. Wrapping both inserts in one client transaction, and
   * returning the synthetic ref to the caller only AFTER that transaction
   * has committed, makes that window impossible: either both rows exist,
   * durably, or neither does.
   */
  async perform(action: ChatAction): Promise<ChatActionResult> {
    if (needsDispatchId(action)) {
      const dispatchId = randomUUID()
      const dispatchedAt = this.#now()
      const stampedRef: ChatRef = { ...action.ref, message: dispatchId }
      const stamped = { ...action, ref: stampedRef } as ChatAction

      const client = await this.#pool.connect()
      try {
        await client.query('BEGIN')
        // Always awaited, and always committed, before this dispatch id is
        // ever handed back to a caller: see lookupDispatchState's doc
        // comment for what this guarantees, and what it does not, about a
        // later edit's lookup.
        await insertPlaceholder(client, dispatchId, this.#workspaceId, dispatchedAt)
        await this.#outbox.enqueue(stamped, this.#workspaceId, client)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          // The connection may already be broken; discard the secondary
          // error so the caller sees the original failure, matching the
          // pattern every other transactional write in this project uses.
        })
        throw error
      } finally {
        client.release()
      }

      // Only returned after the transaction above has committed: the
      // synthetic ref this hands back must never describe a placeholder
      // that might not durably exist.
      return { ref: stampedRef }
    }

    await this.#outbox.enqueue(action, this.#workspaceId)
    return { ref: action.ref }
  }

  /**
   * Queues `action` on the caller's transaction, so it commits (or rolls
   * back) with the caller's own writes: the autonomous intake and approval
   * cards use this. A post-type action gets its dispatch placeholder in the
   * same transaction, as perform() does. Implements IntakeOutbox.
   */
  async enqueue(action: ChatAction, workspaceId: string, executor?: PoolClient): Promise<string> {
    if (workspaceId !== this.#workspaceId) throw new Error('OutboundDispatcher.enqueue: an action for another workspace')
    if (executor === undefined) return (await this.perform(action)).ref.message ?? ''
    if (!needsDispatchId(action)) return this.#outbox.enqueue(action, workspaceId, executor)
    const dispatchId = randomUUID()
    await insertPlaceholder(executor, dispatchId, workspaceId, this.#now())
    await this.#outbox.enqueue({ ...action, ref: { ...action.ref, message: dispatchId } } as ChatAction, workspaceId, executor)
    return dispatchId
  }

  /**
   * Attempts delivery of every eligible pending row for this dispatcher's
   * adapter, exactly as Outbox.drain() documents. Safe to call from a
   * dispatcher instance other than the one that enqueued the row, and is
   * in fact how property 1 and property 3 in the task report are proven.
   */
  async drain(): Promise<OutboxDrainResult> {
    return this.#outbox.drain({ lane: 'messages' })
  }

  /** Delivers pending uploads one at a time, in their own lane (see Outbox.drain). */
  async drainUploads(): Promise<OutboxDrainResult> {
    return this.#outbox.drain({ lane: 'uploads' })
  }
}

type DecorateAdapterOptions = {
  pool: Pool
  real: ChatAdapter
  workspaceId: string
  dependencyDeadlineMs: number
  dependencyRetryMs: number
  now: () => Date
  log: Logger | undefined
}

/**
 * Builds the adapter Outbox itself holds and calls perform() on during
 * drain(). Kept as a plain object literal implementing ChatAdapter, rather
 * than a class, because nothing outside this module ever needs to name its
 * type: it exists only to sit between Outbox and the real adapter.
 */
function decorateAdapter(options: DecorateAdapterOptions): ChatAdapter {
  const { pool, real, workspaceId, dependencyDeadlineMs, dependencyRetryMs, now, log } = options
  return {
    name: real.name,
    capabilities: real.capabilities,
    start: (handler) => real.start(handler),
    stop: () => real.stop(),
    async perform(action: ChatAction): Promise<ChatActionResult> {
      if (action.kind === 'edit') {
        const dispatchId = action.ref.message
        const state = await lookupDispatchState(pool, dispatchId, workspaceId, now, log)

        if (state.status === 'resolved') {
          const ref = buildResolvedEditRef(action.ref, state.ref)
          return real.perform({ ...action, ref })
        }

        const elapsedMs = now().getTime() - state.dispatchedAt.getTime()
        if (elapsedMs < dependencyDeadlineMs) {
          throw new OutboxDeferError(
            `outbound dispatch ${dispatchId} has not been delivered yet, deferring`,
            dependencyRetryMs,
          )
        }
        throw new Error(
          `outbound dispatch ${dispatchId} has not resolved within ${dependencyDeadlineMs}ms; ` +
            'giving up rather than deferring indefinitely',
        )
      }

      if (needsDispatchId(action)) {
        const dispatchId = action.ref.message
        const strippedAction = { ...action, ref: withoutDispatchMessage(action.ref) } as ChatAction
        const result = await real.perform(strippedAction)
        if (dispatchId) await storeResolvedRef(pool, dispatchId, workspaceId, result.ref)
        return result
      }

      return real.perform(action)
    },
  }
}
