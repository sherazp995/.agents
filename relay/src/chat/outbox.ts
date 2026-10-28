/**
 * A durable outbound queue backed by the `outbox` table (0002_chat.sql), per
 * FR-CA-3: an action is written to Postgres before anything is attempted, so
 * a crash between deciding to send and actually sending loses nothing. One
 * `Outbox` instance can enqueue and a completely different instance,
 * against the same database, can drain what the first one wrote; nothing
 * the queue depends on lives in process memory.
 */

import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'
import type { Logger } from '../obs/logger.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import type { ChatAction, ChatAdapter } from './contract.js'

export type OutboxOptions = {
  log?: Logger
  /** How many total attempts (including the first) before a row moves to the terminal failed state. Never spent by a TransportError-classified failure; see that class's own doc comment. */
  maxAttempts?: number
  /** How many pending rows one drain() call claims at most. */
  batchSize?: number
  /** Delay before retry number `attempt`, in milliseconds. Defaults to exponential backoff capped at five minutes. */
  backoffMs?: (attempt: number) => number
  /** The clock drain() and enqueue() read. Overridable so tests can prove backoff and retry timing without a real wait. */
  now?: () => Date
  /** Bound on one perform() call. Defaults to thirty seconds; see the class doc comment on drain() for why an unbounded call is unsafe. */
  performTimeoutMs?: number
  /**
   * Gate fix, High 1: scopes this Outbox instance to one workspace, adding
   * `workspace_id = $N` to every claim and mutation drain() performs.
   * Optional and unscoped by default, matching this primitive's original
   * design (see OQ-1, docs/decisions/open-questions.md, resolved by this
   * fix): a caller that genuinely wants one Outbox instance to serve every
   * workspace can still leave this unset, which is exactly what this
   * project's own test suite exercises directly (see "persists workspace_id
   * per action and carries each through to delivery" in
   * test/chat/outbox.test.ts, which enqueues for two different workspaces
   * on one unscoped instance and expects drain() to deliver both).
   * Production's one caller, OutboundDispatcher, is itself always bound to
   * a single workspace and always supplies this, which is what actually
   * closes the defect: nothing that has EVER called drain() in a running
   * Relay process was unscoped, only the primitive's own generality was.
   */
  workspaceId?: string
}

export type OutboxDrainResult = { sent: number; failed: number }

/**
 * A ChatAdapter's perform() can throw this to tell drain() "this row is not
 * ready yet, and the reason is not a delivery failure": reschedule it after
 * `retryAfterMs` without touching `attempts` and without it ever counting
 * toward `maxAttempts`, the terminal 'failed' state, or the last_error
 * column.
 *
 * This exists because `attempts` and `maxAttempts` mean one thing:
 * genuine delivery failures against the real platform. A caller whose
 * action depends on another, not-yet-delivered action (for example
 * src/dispatch/outbound.ts's edit-depends-on-its-post case) is not
 * reporting a delivery failure when that dependency is not ready; it is
 * reporting "come back later." Counting that against the same budget a
 * real outage uses means a dependency that would resolve fine within a few
 * minutes can be cut off after a handful of drain() cycles for reasons
 * that have nothing to do with the platform ever rejecting anything, which
 * is a real, disclosed defect in the outbound dispatcher's first version
 * (see its Task 4 fix-round report). `drain()` itself stays generic here:
 * it does not know or care what a caller is waiting for, only that this
 * particular rejection is not a failure.
 *
 * A caller that defers indefinitely without ever giving up would still
 * violate FR-CA-3 in spirit (a dependency that will truly never resolve
 * should not retry forever); bounding that is the caller's job, not
 * drain()'s. `OutboxDeferError` only ever changes how one attempt is
 * scheduled, never whether the row can reach a terminal state at all: a
 * caller that stops throwing this (and throws a plain Error instead) once
 * it decides waiting further is pointless still terminates normally
 * through the existing maxAttempts path below.
 */
export class OutboxDeferError extends Error {
  readonly retryAfterMs: number

  constructor(message: string, retryAfterMs = 1000) {
    super(message)
    this.name = 'OutboxDeferError'
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Gate fix, Blocker 4: a ChatAdapter's perform() throws this to mark a
 * failure as a TRANSPORT-level outage, a network failure, a DNS failure, a
 * connection reset, the platform's own infrastructure returning a 5xx,
 * rather than the platform genuinely rejecting the action. See
 * src/chat/slack/adapter.ts's classifyTransportError for how the real
 * SlackAdapter tells the two apart.
 *
 * `DEFAULT_MAX_ATTEMPTS` with the default backoff schedule exhausts in
 * roughly 18 seconds. The spec's own chaos test, TST-C-4, is a 60 second
 * partition: a connectivity outage that outlives 18 seconds but resolves
 * well within a minute is common (a restart, a network blip, a brief DNS
 * hiccup), and permanently failing a message the platform was always going
 * to accept once it came back is exactly the defect this closes. A
 * TransportError-classified failure still increments `attempts` and
 * `last_error` (so an operator can see how many times it has been retried
 * and why), and still uses the SAME backoff schedule as an ordinary
 * failure, capped the same way (five minutes by default), but it is NEVER
 * compared against `maxAttempts` and NEVER reaches the terminal 'failed'
 * state on its own: it retries for as long as the outage lasts, however
 * long that is. A caller that classifies a failure as `TransportError`
 * when it should not have (a persistent misconfiguration masquerading as
 * connectivity, for instance) trades away the terminal-failure signal that
 * misconfiguration would otherwise have produced; classification is
 * therefore adapter's responsibility to get right, not this class's.
 *
 * Distinct from `OutboxDeferError`: that one means "not ready yet, no
 * failure occurred at all" (an internal dependency has not resolved) and
 * schedules a short, fixed retry with none of `attempts` touched at all.
 * This one means "a genuine attempt was made and failed for a reason that
 * says nothing about whether the SAME action would fail again", and keeps
 * `attempts` moving so the ordinary backoff schedule still applies.
 */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TransportError'
  }
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_BACKOFF_BASE_MS = 1000
const DEFAULT_BACKOFF_CAP_MS = 5 * 60 * 1000
const DEFAULT_PERFORM_TIMEOUT_MS = 30_000

function defaultBackoffMs(attempt: number): number {
  return Math.min(DEFAULT_BACKOFF_BASE_MS * 2 ** (attempt - 1), DEFAULT_BACKOFF_CAP_MS)
}

/**
 * Races `promise` against a timer. On timeout, rejects with a distinct,
 * clearly worded error rather than whatever `promise` eventually produces,
 * so a caller reading `last_error` later can tell a hang apart from a real
 * rejection.
 *
 * `promise` is never cancelled, because ordinary Promises cannot be: this
 * only stops *waiting* on it. A `.then`/`.catch` pair stays attached to it
 * regardless of which side of the race wins, for two reasons: so a
 * rejection that arrives after the timeout never becomes an unhandled
 * rejection, and so a late resolution is simply discarded rather than
 * reopening the timer. See the drain() doc comment for what this means for
 * delivery guarantees.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(timeoutMessage))
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

type OutboxRow = {
  id: string
  action: unknown
  attempts: number
}

/**
 * `ChatAction`'s `upload` variant carries `bytes: Uint8Array`. JSON has no
 * binary type, so a plain `JSON.stringify` on a Uint8Array serializes it as
 * an index keyed object ({"0":1,"1":2,...}) and never comes back as a
 * Uint8Array on the way out, silently corrupting the payload. These two
 * functions are the only place an action crosses the jsonb boundary, so
 * they are the only place this needs handling: base64 out, base64 back in.
 */
function serializeAction(action: ChatAction): unknown {
  if (action.kind !== 'upload') return action
  return { ...action, bytes: Buffer.from(action.bytes).toString('base64') }
}

/**
 * An upload queued by `--file` stores the file's path, not its bytes, so a
 * video does not sit in a database row; it is read here, when it is sent.
 */
async function loadUploadFile(action: ChatAction): Promise<ChatAction> {
  if (action.kind !== 'upload' || action.bytes !== undefined) return action
  const path = (action as { path?: unknown }).path
  if (typeof path !== 'string') throw new Error('upload has neither bytes nor a file path')
  return { ...action, bytes: new Uint8Array(await readFile(path)) }
}

/** Which pending rows one drain() call takes: everything, everything but uploads, or uploads only. */
export type OutboxLane = 'all' | 'messages' | 'uploads'

/** A large file to Slack takes far longer than a post. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000

function deserializeAction(stored: unknown): ChatAction {
  const value = stored as ChatAction
  if (value.kind !== 'upload') return value
  const encoded = (stored as { bytes: unknown }).bytes
  if (typeof encoded !== 'string') return value
  return { ...value, bytes: new Uint8Array(Buffer.from(encoded, 'base64')) }
}

export class Outbox {
  readonly #pool: Pool
  readonly #adapter: ChatAdapter
  readonly #log: Logger | undefined
  readonly #maxAttempts: number
  readonly #batchSize: number
  readonly #backoffMs: (attempt: number) => number
  readonly #now: () => Date
  readonly #performTimeoutMs: number
  /** Gate fix, High 1: undefined means unscoped (this instance's original, cross-workspace behaviour); see OutboxOptions.workspaceId's own doc comment. */
  readonly #workspaceId: string | undefined

  constructor(pool: Pool, adapter: ChatAdapter, options: OutboxOptions = {}) {
    this.#pool = pool
    this.#adapter = adapter
    this.#log = options.log
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    this.#backoffMs = options.backoffMs ?? defaultBackoffMs
    this.#now = options.now ?? (() => new Date())
    this.#performTimeoutMs = options.performTimeoutMs ?? DEFAULT_PERFORM_TIMEOUT_MS
    this.#workspaceId = options.workspaceId
  }

  /**
   * Persists `action` as a pending row, scoped to `workspaceId` per AP-8,
   * before this call returns. Nothing is sent yet; `drain` is what actually
   * performs it. Returns the outbox row id.
   *
   * `executor`, per gate fix Blocker 3: defaults to this instance's own
   * pool, exactly the previous behaviour, but a caller that is already
   * inside its own transaction (src/dispatch/outbound.ts's perform(), which
   * must commit this INSERT together with its own placeholder INSERT or
   * neither at all) can pass its own `PoolClient` instead, so this INSERT
   * becomes part of that caller's transaction rather than committing on its
   * own the instant this call returns.
   */
  async enqueue(action: ChatAction, workspaceId: string, executor: Pool | PoolClient = this.#pool): Promise<string> {
    const { rows } = await executor.query<{ id: string }>(
      `INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [workspaceId, this.#adapter.name, serializeAction(action), this.#now()],
    )
    const id = rows[0]?.id
    if (!id) throw new Error('Outbox.enqueue: INSERT ... RETURNING id returned no row')
    this.#log?.info(
      { outboxId: id, workspaceId, actionKind: action.kind },
      'enqueued outbox action',
    )
    return id
  }

  /**
   * Sends every pending row whose next_attempt_at has arrived, at most once
   * each. Safe to call concurrently with itself: the batch is claimed with
   * `SELECT ... FOR UPDATE SKIP LOCKED` inside one transaction, so a second
   * concurrent drain() skips whatever rows the first already locked instead
   * of racing it to send the same row twice.
   *
   * A row that fails is retried with backoff until it has been attempted
   * `maxAttempts` times, at which point it moves to status 'failed' and is
   * never retried again; that terminal state, plus the error that caused
   * it, is written to the row itself, so it is reported rather than
   * silently dropped even if nobody is watching the log at that moment.
   * That budget is only for genuine delivery failures: a perform() that
   * throws `OutboxDeferError` instead reschedules the row without spending
   * any of it, see that class's own doc comment for why.
   *
   * Each perform() call is bounded by `performTimeoutMs`. Without that
   * bound, a network call to a chat platform that never responds would
   * leave this method's transaction open forever: the row stays locked,
   * the Postgres backend sits idle in transaction, and the pool connection
   * this call checked out is never returned, so even pool.end() would
   * never resolve. A batch is processed sequentially inside one
   * transaction, so one hung row would block every row behind it too, not
   * only itself.
   *
   * A timeout is treated exactly like a rejection: it counts as a failed
   * attempt and goes through the same retry and terminal failure path,
   * with a distinct "timed out" message in last_error so an operator can
   * tell the two apart. Ordinary Promises cannot be cancelled, so the
   * abandoned perform() call is not stopped, only stopped being waited on;
   * if it later completes on its own, on the platform side it may still
   * have delivered the action. Combined with the retry this method just
   * queued, that is a real, accepted risk of sending the same action
   * twice after a timeout: this method is at-least-once on that path, not
   * exactly-once. See the task report for the reasoning and a test that
   * demonstrates it directly.
   */
  async drain(options: { lane?: OutboxLane } = {}): Promise<OutboxDrainResult> {
    // Uploads can run for minutes; they drain in their own lane, one row at
    // a time, so a large file never holds text replies behind it.
    const lane = options.lane ?? 'all'
    const client = await this.#pool.connect()
    let sent = 0
    let failed = 0
    try {
      await client.query('BEGIN')
      const cursor = this.#now()
      const { rows } = await client.query<OutboxRow>(
        // Scoped to this instance's own adapter: the outbox table can hold
        // rows for more than one platform (Slack today, Telegram or
        // Discord later, per src/chat/contract.ts), and a row enqueued for
        // one adapter must never be handed to a different adapter's
        // perform(), which would receive a ref and action shaped for a
        // platform it does not speak.
        //
        // Gate fix, High 1: also scoped to this instance's own workspace,
        // when one was bound at construction ($3::uuid IS NULL is a no-op
        // filter for an unscoped instance, so nothing changes for a caller
        // that never set workspaceId). Before this fix, a workspace-bound
        // OutboundDispatcher's own drain() call could still claim and
        // deliver a DIFFERENT workspace's pending row, latent until Task 8
        // scheduled a production drain and made it reachable.
        `SELECT id, action, attempts
         FROM outbox
         WHERE status = 'pending' AND adapter = $1 AND next_attempt_at <= $2
           AND ($3::uuid IS NULL OR workspace_id = $3)
           AND ($5 = 'all' OR ((action->>'kind' = 'upload') = ($5 = 'uploads')))
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
         LIMIT $4`,
        [this.#adapter.name, cursor, this.#workspaceId ?? null, lane === 'uploads' ? 1 : this.#batchSize, lane],
      )

      for (const row of rows) {
        const outcome = await this.#attempt(client, row, cursor)
        if (outcome === 'sent') sent += 1
        if (outcome === 'failed') failed += 1
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        // The connection may already be broken, in which case ROLLBACK
        // itself throws. Discard that secondary error so the caller sees
        // the original failure, not a rollback failure that hides it.
      })
      throw error
    } finally {
      client.release()
    }
    return { sent, failed }
  }

  async #attempt(
    client: PoolClient,
    row: OutboxRow,
    cursor: Date,
  ): Promise<'sent' | 'failed' | 'retry'> {
    const stored = deserializeAction(row.action)
    // Gate fix, High 1: every mutation below also filters on workspace_id
    // (a no-op filter when this instance is unscoped, same as drain()'s own
    // SELECT above), so a resolution or failure meant for one workspace's
    // row can never be written onto a different workspace's row, in the
    // vanishingly unlikely event two workspaces' rows ever shared an id.
    const workspaceId = this.#workspaceId ?? null
    try {
      // Inside the try, so a file that is gone fails the row like any other send error.
      const action = await loadUploadFile(stored)
      const timeoutMs = action.kind === 'upload' ? Math.max(this.#performTimeoutMs, UPLOAD_TIMEOUT_MS) : this.#performTimeoutMs
      const result = await withTimeout(
        this.#adapter.perform(action),
        timeoutMs,
        `perform() timed out after ${timeoutMs}ms without settling`,
      )
      await client.query(
        `UPDATE outbox
         SET status = 'sent', attempts = attempts + 1, sent_at = $2, updated_at = $2, last_error = NULL, sent_ref = $4
         WHERE id = $1 AND ($3::uuid IS NULL OR workspace_id = $3)`,
        [row.id, cursor, workspaceId, result?.ref ?? null],
      )
      this.#log?.info({ outboxId: row.id }, 'outbox action sent')
      return 'sent'
    } catch (error) {
      if (error instanceof OutboxDeferError) {
        // Deliberately does not touch attempts, last_error, or the
        // maxAttempts check below: see OutboxDeferError's doc comment for
        // why a dependency wait must not spend the same budget a genuine
        // delivery failure does.
        const nextAttemptAt = new Date(cursor.getTime() + error.retryAfterMs)
        await client.query(
          `UPDATE outbox SET next_attempt_at = $2, updated_at = $3 WHERE id = $1 AND ($4::uuid IS NULL OR workspace_id = $4)`,
          [row.id, nextAttemptAt, cursor, workspaceId],
        )
        this.#log?.info(
          { outboxId: row.id, nextAttemptAt, reason: error.message },
          'outbox action deferred, not counted against attempts',
        )
        return 'retry'
      }

      // Gate fix, Blocker 4: a TransportError never reaches the
      // maxAttempts-counting terminal branch below, however high `attempts`
      // climbs; see that class's own doc comment for why a connectivity
      // outage must not permanently fail a message the platform was always
      // going to accept once it came back.
      const transportFailure = error instanceof TransportError

      const attempts = row.attempts + 1
      // Scrubbed before it touches either output the failure reaches: the
      // Postgres row (last_error) and the log line below. An adapter's
      // error can legitimately quote its own request, and a Slack token
      // has shown up in exactly that text before (see FR-SEC-1), so this is
      // not a hypothetical: without scrubbing here, a credential would be
      // sitting in the database in plain text.
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = scrubSecrets(rawMessage)

      if (!transportFailure && attempts >= this.#maxAttempts) {
        await client.query(
          `UPDATE outbox
           SET status = 'failed', attempts = $2, last_error = $3, updated_at = $4
           WHERE id = $1 AND ($5::uuid IS NULL OR workspace_id = $5)`,
          [row.id, attempts, message, cursor, workspaceId],
        )
        this.#log?.error(
          { outboxId: row.id, attempts, err: message },
          'outbox action reached maxAttempts and moved to failed; it will not be retried again',
        )
        return 'failed'
      }

      const nextAttemptAt = new Date(cursor.getTime() + this.#backoffMs(attempts))
      await client.query(
        `UPDATE outbox
         SET attempts = $2, last_error = $3, next_attempt_at = $4, updated_at = $5
         WHERE id = $1 AND ($6::uuid IS NULL OR workspace_id = $6)`,
        [row.id, attempts, message, nextAttemptAt, cursor, workspaceId],
      )
      this.#log?.warn(
        { outboxId: row.id, attempts, nextAttemptAt, err: message, transportFailure },
        transportFailure
          ? 'outbox action hit a transport-level failure, retrying indefinitely: does not count toward maxAttempts'
          : 'outbox action failed, retrying with backoff',
      )
      return 'retry'
    }
  }
}
