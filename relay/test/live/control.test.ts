import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import {
  claimAllWorkspaceMessages,
  claimLiveControl,
  claimNextMessage,
  enqueueLiveControlMessage,
  isLiveControlled,
  releaseLiveControl,
  takeBackMessage,
  waitForClaim,
  waitForMessage,
  WaiterAlreadyRunningError,
} from '../../src/live/control.js'
import { resolveDrainWorkspace } from '../../src/cli/live.js'
import { getTestDatabaseUrl } from '../support/database.js'

const describeDb = process.env.RELAY_TEST_DATABASE_URL ? describe : describe.skip

describeDb('live control', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function buildSession(): Promise<{ workspaceId: string; sessionId: string; principalId: string }> {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'test', `U_${randomUUID()}`, 'Op', ['operator'])
    const session = await findOrCreateSession(pool, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
    })
    return { workspaceId, sessionId: session.id, principalId }
  }

  it('a session is not live controlled until it is claimed, and is released again', async () => {
    const { workspaceId, sessionId } = await buildSession()

    expect(await isLiveControlled(pool, sessionId, workspaceId)).toBe(false)
    await claimLiveControl(pool, workspaceId, sessionId)
    expect(await isLiveControlled(pool, sessionId, workspaceId)).toBe(true)
    await releaseLiveControl(pool, workspaceId, sessionId)
    expect(await isLiveControlled(pool, sessionId, workspaceId)).toBe(false)
  })

  it('an attached thread whose chat is running parks, with no separate claim step', async () => {
    const { workspaceId, sessionId } = await buildSession()
    // Attached to a folder that certainly has a live claude process: this
    // very session's own. Nothing is claimed, and that is the point.
    await pool.query(`UPDATE sessions SET engine_session_id = $2, engine_cwd = $3 WHERE id = $1`, [
      sessionId,
      'some-chat-id',
      '/Users/op/project',
    ])

    // Requiring an explicit claim on top of attaching made the operator
    // maintain a distinction Relay invented, and it broke constantly because
    // Slack opens a new thread for every top-level message. Attaching is the
    // decision; liveness is the condition.
    const liveProcess = async (file: string) =>
      file === 'ps'
        ? { stdout: '  4242 claude\n', stderr: '' }
        : { stdout: 'claude 4242 op cwd DIR 1,17 3488 389002 /Users/op/project\n', stderr: '' }

    expect(await isLiveControlled(pool, sessionId, workspaceId, liveProcess)).toBe(true)
  })

  it('an attached thread whose folder has no running chat runs Relay own loop', async () => {
    const { workspaceId, sessionId } = await buildSession()
    await pool.query(`UPDATE sessions SET engine_session_id = $2, engine_cwd = $3 WHERE id = $1`, [
      sessionId,
      'some-chat-id',
      '/tmp/relay-definitely-no-claude-here',
    ])

    // The operator's own rule: a chat already open and running gets the
    // work, otherwise Relay starts one. Resuming it itself is exactly what
    // the attachment is for when nothing is running there.
    const nothingRunning = async () => ({ stdout: '', stderr: '' })

    expect(await isLiveControlled(pool, sessionId, workspaceId, nothingRunning)).toBe(false)
  })

  it('scopes the claim check by workspace, so one workspace never reads another as controlled', async () => {
    const a = await buildSession()
    const b = await buildSession()
    await claimLiveControl(pool, a.workspaceId, a.sessionId)

    // AP-8. Asking about a's session while scoped to b's workspace must
    // answer "not controlled" rather than leaking a's state across the
    // tenancy boundary.
    expect(await isLiveControlled(pool, a.sessionId, b.workspaceId)).toBe(false)
  })

  it('hands the operator text to exactly one consumer and keeps none of it', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    await enqueueLiveControlMessage(pool, {
      workspaceId,
      sessionId,
      principalId,
      body: 'my aws key is AKIAIOSFODNN7EXAMPLE',
      replyRef: '{"channel":"C1"}',
    })

    const claimed = await claimNextMessage(pool, sessionId, workspaceId)
    expect(claimed?.body).toBe('my aws key is AKIAIOSFODNN7EXAMPLE')

    // FR-SEC-1: the row survives so the audit trail still records that a
    // message arrived and when, but the text itself is gone. This is the
    // one place Relay stores inbound chat text, and it stores it only long
    // enough to hand it over once.
    const { rows } = await pool.query<{ body: string; claimed_at: Date | null }>(
      'SELECT body, claimed_at FROM live_control_messages WHERE session_id = $1',
      [sessionId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toBe('')
    expect(rows[0]?.claimed_at).not.toBeNull()
  })

  it('gives one message to exactly one of two racing consumers', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    await enqueueLiveControlMessage(pool, {
      workspaceId,
      sessionId,
      principalId,
      body: 'only once',
      replyRef: '{}',
    })

    // Resolved by Postgres via SKIP LOCKED rather than by consumer
    // discipline: two sessions both waiting must not both act on one
    // instruction.
    const [first, second] = await Promise.all([
      claimNextMessage(pool, sessionId, workspaceId),
      claimNextMessage(pool, sessionId, workspaceId),
    ])

    const bodies = [first?.body, second?.body].filter((body) => body !== undefined)
    expect(bodies).toEqual(['only once'])
  })

  it('reports a message uncollected when no consumer claims it, so the caller can take it back', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    const messageId = await enqueueLiveControlMessage(pool, {
      workspaceId,
      sessionId,
      principalId,
      body: 'nobody is listening',
      replyRef: '{}',
    })

    // A live process in the folder proves a session is OPEN, not that
    // anything is blocked on this queue. When those diverge the operator
    // gets silence, unable to tell "being worked on" from "swallowed", so
    // the park has to be provisional rather than final.
    expect(await waitForClaim(pool, messageId, 400)).toBe(false)
  })

  it('reports a message collected as soon as a consumer claims it', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    const messageId = await enqueueLiveControlMessage(pool, {
      workspaceId,
      sessionId,
      principalId,
      body: 'someone is listening',
      replyRef: '{}',
    })
    setTimeout(() => void claimNextMessage(pool, sessionId, workspaceId), 100)

    expect(await waitForClaim(pool, messageId, 10_000)).toBe(true)
  })

  it('refuses a second waiter for the same session instead of idling a whole process', async () => {
    const { sessionId } = await buildSession()

    // Each waiter is a Node process measured at 102 MB RSS, and claiming is
    // exclusive, so a second one for the same session can never consume
    // anything. It should exit at once rather than sit there.
    const first = waitForMessage(pool, sessionId, 3_000)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const startedSecond = Date.now()

    // Reported distinctly rather than as a null, because a null means "no
    // message arrived" and the operator's response to each differs: one
    // means wait longer, the other means arming again is pointless.
    await expect(waitForMessage(pool, sessionId, 3_000)).rejects.toThrow(WaiterAlreadyRunningError)
    expect(Date.now() - startedSecond).toBeLessThan(1_000)
    await first
  })

  it('frees the slot once the first waiter finishes, so the next one can take over', async () => {
    const { sessionId } = await buildSession()

    await waitForMessage(pool, sessionId, 200)
    // The lock is held by the connection, so it must not survive back into
    // the pool and lock out every later waiter.
    const startedSecond = Date.now()
    await waitForMessage(pool, sessionId, 400)

    expect(Date.now() - startedSecond).toBeGreaterThan(300)
  })

  it('takes a message back only if no live session claimed it first', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    const messageId = await enqueueLiveControlMessage(pool, {
      workspaceId, sessionId, principalId, body: 'contested', replyRef: '{}',
    })

    // Relay wins when nobody collected it, and must then be the only one who
    // answers. Leaving the row unclaimed would let a waiter arm a moment
    // later and answer the same message a second time in the same thread,
    // which reads as Relay arguing with itself.
    expect(await takeBackMessage(pool, messageId)).toBe(true)
    expect(await claimNextMessage(pool, sessionId, workspaceId)).toBeNull()
  })

  it('refuses to take back a message a live session already claimed', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    const messageId = await enqueueLiveControlMessage(pool, {
      workspaceId, sessionId, principalId, body: 'already taken', replyRef: '{}',
    })
    await claimNextMessage(pool, sessionId, workspaceId)

    // Losing this race is the GOOD outcome: the live session has the work,
    // so Relay must stay quiet rather than answer alongside it.
    expect(await takeBackMessage(pool, messageId)).toBe(false)
  })

  it('drains every waiting message in the workspace at once', async () => {
    const a = await buildSession()
    await claimLiveControl(pool, a.workspaceId, a.sessionId)
    const b = await pool.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, principal_id, adapter, thread_ref, live_control_claimed_at)
       VALUES ($1, $2, 'slack', $3, now()) RETURNING id`,
      [a.workspaceId, a.principalId, `slack:C2:${randomUUID()}`],
    )
    const secondSession = b.rows[0]?.id as string
    for (const [sessionId, body] of [
      [a.sessionId, 'first thread'],
      [secondSession, 'second thread'],
    ] as const) {
      await enqueueLiveControlMessage(pool, {
        workspaceId: a.workspaceId,
        sessionId,
        principalId: a.principalId,
        body,
        replyRef: '{}',
      })
    }

    // Workspace-wide, because the caller is a Stop hook that cannot know
    // which threads exist: the operator opens a new Slack thread at any
    // moment, and a per-thread drain would silently miss it.
    const drained = await claimAllWorkspaceMessages(pool, a.workspaceId)

    expect(drained.map((m) => m.body).sort()).toEqual(['first thread', 'second thread'])
    expect(await claimAllWorkspaceMessages(pool, a.workspaceId)).toEqual([])
  })

  it('leaves messages for a session that is no longer live controlled', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    await claimLiveControl(pool, workspaceId, sessionId)
    await enqueueLiveControlMessage(pool, { workspaceId, sessionId, principalId, body: 'parked', replyRef: '{}' })

    await releaseLiveControl(pool, workspaceId, sessionId)

    // Relay's own loop owns that thread again, so draining it here would
    // take work from the party that should now be doing it.
    expect(await claimAllWorkspaceMessages(pool, workspaceId)).toEqual([])
  })

  it('a taken-back message keeps its body until the taker has it', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    const messageId = await enqueueLiveControlMessage(pool, {
      workspaceId,
      sessionId,
      principalId,
      body: 'taken back',
      replyRef: '{}',
    })

    // takeBackMessage erases the body as it claims, so the caller must
    // already hold the text before calling it. If the process dies between
    // those two moments the message is gone: erased from the database and
    // never answered. The row is the record that it happened; the text is
    // not recoverable, and that is stated here rather than implied.
    expect(await takeBackMessage(pool, messageId)).toBe(true)
    const { rows } = await pool.query<{ body: string }>('SELECT body FROM live_control_messages WHERE id = $1', [
      messageId,
    ])
    expect(rows[0]?.body).toBe('')
    // And it cannot be taken twice, so a restart cannot answer it again.
    expect(await takeBackMessage(pool, messageId)).toBe(false)
  })

  it('returns nothing, rather than failing, when the workspace is quiet', async () => {
    const { workspaceId } = await buildSession()

    // The silence contract: a Stop hook runs every turn, and one that
    // complains constantly gets disabled.
    expect(await claimAllWorkspaceMessages(pool, workspaceId)).toEqual([])
  })

  it('returns null rather than blocking when nothing is waiting', async () => {
    const { workspaceId, sessionId } = await buildSession()

    expect(await claimNextMessage(pool, sessionId, workspaceId)).toBeNull()
  })

  it('wakes a waiter on arrival rather than making it wait out its timeout', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()

    const started = Date.now()
    // A generous timeout, so a pass proves the NOTIFY woke it rather than
    // the clock running out. Enqueued after the wait begins, which is the
    // real ordering: a consumer blocks first, work arrives second.
    const waiting = waitForMessage(pool, sessionId, 30_000)
    setTimeout(() => {
      void enqueueLiveControlMessage(pool, {
        workspaceId,
        sessionId,
        principalId,
        body: 'woken',
        replyRef: '{}',
      })
    }, 150)

    const message = await waiting
    expect(message?.body).toBe('woken')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('drains a message that arrived before the waiter existed', async () => {
    const { workspaceId, sessionId, principalId } = await buildSession()
    await enqueueLiveControlMessage(pool, {
      workspaceId,
      sessionId,
      principalId,
      body: 'already here',
      replyRef: '{}',
    })

    // No NOTIFY will fire for this one, since it was inserted before the
    // LISTEN. The drain-first step is what stops a consumer sleeping
    // through work that is already waiting.
    const message = await waitForMessage(pool, sessionId, 30_000)
    expect(message?.body).toBe('already here')
  })

  it('returns null on timeout rather than hanging forever', async () => {
    const { sessionId } = await buildSession()

    expect(await waitForMessage(pool, sessionId, 300)).toBeNull()
  })
})

describeDb('resolveDrainWorkspace: the outage of 2026-08-11', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = createPool(await getTestDatabaseUrl())
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function buildAttachedSession(platform: string): Promise<{ workspaceId: string; sessionId: string; principalId: string }> {
    const workspaceId = await resolveWorkspaceId(pool, platform, `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, platform, `U_${randomUUID()}`, 'Op', ['operator'])
    const session = await findOrCreateSession(pool, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
    })
    await pool.query(`UPDATE sessions SET engine_session_id = $2, engine_cwd = $3 WHERE id = $1`, [
      session.id,
      'chat-id',
      '/Users/op/project',
    ])
    return { workspaceId, sessionId: session.id, principalId }
  }

  it('IS NOT confused by a workspace that could never hold a live-control message', async () => {
    // This is the whole outage. `relay smoke` provisions a workspace under
    // its own non-chat platform, deliberately, so it can never be mistaken
    // for a real one. It succeeded at that and still broke live control
    // completely for over a day, because the old rule counted WORKSPACES:
    // two existed, so every drain refused, and the operator's Stop hook
    // ended in `|| true` so the refusal was never seen. Messages were
    // parked, Slack said "queued for the attached session", and the session
    // received nothing.
    const chat = await buildAttachedSession('slack')
    await enqueueLiveControlMessage(pool, {
      workspaceId: chat.workspaceId,
      sessionId: chat.sessionId,
      principalId: chat.principalId,
      body: 'the operator is talking to their session',
      replyRef: JSON.stringify({ channel: 'C1', thread: 'T1' }),
    })

    // A smoke workspace exists, with a session and no parked message.
    await buildAttachedSession('relay-smoke')

    const resolution = await resolveDrainWorkspace(pool)

    expect(resolution.outcome).toBe('resolved')
    if (resolution.outcome !== 'resolved') return
    expect(resolution.workspaceId).toBe(chat.workspaceId)
  })

  it('STILL refuses when two workspaces genuinely both have messages waiting', async () => {
    // The case the original rule was written for, and it must survive: a
    // drain that guessed here would hand one operator's messages to another
    // operator's session.
    const first = await buildAttachedSession('slack')
    const second = await buildAttachedSession('slack')
    for (const target of [first, second]) {
      await enqueueLiveControlMessage(pool, {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        principalId: target.principalId,
        body: 'waiting',
        replyRef: JSON.stringify({ channel: 'C1', thread: 'T1' }),
      })
    }

    const resolution = await resolveDrainWorkspace(pool)

    expect(resolution.outcome).toBe('ambiguous')
    if (resolution.outcome !== 'ambiguous') return
    expect(resolution.candidates.length).toBeGreaterThanOrEqual(2)
    // The reason must be actionable: an operator reading it in their session
    // needs the ids to pass to --workspace-id.
    expect(resolution.reason).toContain('--workspace-id')
    expect(resolution.reason).toContain(first.workspaceId)
  })

  it('stays silent when nothing at all is parked, because this runs at the end of every turn', async () => {
    // A hook that talks constantly gets disabled, and then nothing is
    // delivered at all.
    //
    // Claimed explicitly rather than assuming a clean table: the tests above
    // deliberately leave messages parked, and this file shares one database,
    // so asserting on "nothing waiting" without saying so would pass or fail
    // depending on test order.
    await pool.query(`UPDATE live_control_messages SET claimed_at = now() WHERE claimed_at IS NULL`)
    await buildAttachedSession('slack')

    const resolution = await resolveDrainWorkspace(pool)

    expect(resolution.outcome).toBe('nothing_waiting')
  })

  it('honours an explicitly named workspace without consulting anything', async () => {
    const resolution = await resolveDrainWorkspace(pool, 'a-specific-id')

    expect(resolution).toEqual({ outcome: 'resolved', workspaceId: 'a-specific-id' })
  })
})
