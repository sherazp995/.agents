import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { createLogger } from '../../src/obs/logger.js'
import { processGroupAlive, spawnGated } from '../../src/process/gated-spawn.js'
import { acquireLease, addNote, intakeMention, loadTask, type AutonomousTask } from '../../src/autonomous/store.js'
import { downloadTaskFiles, type FileFetch } from '../../src/autonomous/files.js'
import { createScheduler, stopAutonomousTask, type SchedulerEffects, type TurnRequestContext, type TurnResult } from '../../src/autonomous/scheduler.js'
import type { TurnOutcome } from '../../src/autonomous/worker.js'
import { getTestDatabaseUrl } from '../support/database.js'

function outcome(value: TurnOutcome): TurnResult {
  return { kind: 'outcome', outcome: value, accountKey: 'claude', runId: randomUUID(), notes: [] }
}

const reply = (text = 'reply text'): TurnResult => outcome({ kind: 'reply', text, sessionId: 'sess-1' })

describe('autonomous scheduler', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })


  async function newTask(text = 'fix the login bug'): Promise<{ workspaceId: string; task: AutonomousTask; say: (text: string) => Promise<void> }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Requester', ['member'])
    const threadRef = `slack:C1:${randomUUID()}`
    const intake = (message: string, ts: string) =>
      intakeMention(pool, {
        workspaceId,
        principalId,
        adapter: 'slack',
        threadRef,
        event: { id: `C1:${randomUUID()}`, principalId, text: message, ref: { channel: 'C1', message: ts }, fileIds: [], receivedAt: new Date().toISOString() },
        replyRef: { channel: 'C1', thread: '1.1' },
        files: [],
      })
    const result = await intake(text, '1.1')
    if (result.kind !== 'created') throw new Error('expected a new task')
    // A later message in the same thread.
    const say = async (message: string): Promise<void> => {
      await intake(message, `1.${Date.now()}`)
    }
    return { workspaceId, task: result.task, say }
  }

  type Harness = {
    effects: SchedulerEffects
    turns: TurnRequestContext[]
    posts: string[]
    /** Whether each post was sent as agent Markdown. */
    markdown: boolean[]
    cleaned: string[]
  }

  function harness(turns: ((context: TurnRequestContext) => Promise<TurnResult>)[], overrides: Partial<SchedulerEffects> = {}): Harness {
    const h: Harness = { turns: [], posts: [], markdown: [], cleaned: [], effects: undefined as never }
    h.effects = {
      async runTurn(context) {
        h.turns.push(context)
        const next = turns.shift()
        if (!next) throw new Error('no scripted turn left')
        return next(context)
      },
      downloadFiles: async () => [],
      settleApprovals: async () => undefined,
      async cleanupStopped(task) {
        h.cleaned.push(task.id)
      },
      sweep: async () => undefined,
      ...overrides,
    }
    return h
  }

  function scheduler(workspaceId: string, h: Harness, options: { engaged?: () => boolean; leaseTtlMs?: number; tickMs?: number } = {}) {
    return createScheduler({
      pool,
      workspaceId,
      owner: `test-${randomUUID()}`,
      post: async (action) => {
        if (action.kind === 'post') h.posts.push(action.text)
        if (action.kind === 'post') h.markdown.push(action.markdown === true)
      },
      replyRef: async () => ({ channel: 'C1', thread: '1.1' }),
      isKillSwitchEngaged: async () => options.engaged?.() ?? false,
      effects: h.effects,
      log: createLogger('fatal'),
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
    })
  }

  it('runs a turn on the new message, posts the reply as is and parks', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([async () => reply('Fixed it, *tests pass*.')])

    await scheduler(workspaceId, h).tick()

    expect(h.turns[0]?.prompt).toContain('fix the login bug')
    expect(h.posts).toEqual(['Fixed it, *tests pass*.'])
    expect(h.markdown).toEqual([true])
    expect(await loadTask(pool, task.id)).toMatchObject({ pendingEvents: [], nextWakeupAt: null, engineSessionId: 'sess-1', accountKey: 'claude' })
  })

  it('sends the new message into an open terminal chat and starts no headless turn', async () => {
    const { workspaceId, task } = await newTask('check the deploy')
    const h = harness([async () => reply('should not run')])
    const delivered: string[] = []
    h.effects.deliverToOpenChat = async (_task, text) => delivered.push(text) > 0

    await scheduler(workspaceId, h).tick()

    expect(h.turns).toHaveLength(0)
    expect(delivered[0]).toContain('check the deploy')
    expect(await loadTask(pool, task.id)).toMatchObject({ pendingEvents: [], nextWakeupAt: null })
  })

  it('runs the headless turn when no open chat took the message', async () => {
    const { workspaceId, task } = await newTask('check the deploy')
    const h = harness([async () => reply('Deploy is green.')])
    h.effects.deliverToOpenChat = async () => false

    await scheduler(workspaceId, h).tick()

    expect(h.posts).toEqual(['Deploy is green.'])
    expect(await loadTask(pool, task.id)).toMatchObject({ pendingEvents: [] })
  })

  it('sends a message that arrives mid-turn into the running turn, once, and reads it with that turn', async () => {
    const { workspaceId, task, say } = await newTask('build the report')
    const sent: string[] = []
    const h = harness([
      async (context) => {
        if (context.inbox) context.inbox.send = (text) => sent.push(text) > 0
        await say('also add a chart')
        const deadline = Date.now() + 3000
        while (sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
        await new Promise((resolve) => setTimeout(resolve, 100))
        return reply('Report with a chart.')
      },
    ])
    const s = scheduler(workspaceId, h, { tickMs: 20 })

    await s.tick()
    await s.tick()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('also add a chart')
    expect(h.turns).toHaveLength(1)
    expect(h.posts).toEqual(['Report with a chart.'])
    expect(await loadTask(pool, task.id)).toMatchObject({ pendingEvents: [], nextWakeupAt: null })
  })

  it("keeps a message sent into a turn that then failed pending, while the turn's own message is dropped", async () => {
    const { workspaceId, task, say } = await newTask('build the report')
    const sent: string[] = []
    const h = harness([
      async (context) => {
        if (context.inbox) context.inbox.send = (text) => sent.push(text) > 0
        await say('also add a chart')
        const deadline = Date.now() + 3000
        while (sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
        return outcome({ kind: 'failed', reason: 'crashed', stderrTail: '' })
      },
    ])

    await scheduler(workspaceId, h, { tickMs: 20 }).tick()

    expect(sent).toHaveLength(1)
    const after = await loadTask(pool, task.id)
    expect(after?.pendingEvents.map((event) => event.text)).toEqual(['also add a chart'])
  })

  it('keeps a file a message added while the download ran', async () => {
    const { task } = await newTask('see the attached notes')
    const pendingFile = (id: string) => ({ slackFileId: id, name: `${id}.txt`, url: `https://files.slack.com/files-pri/T1-${id}/${id}.txt`, sizeBytes: 5, status: 'pending' as const })
    await pool.query('UPDATE autonomous_tasks SET files = $2 WHERE id = $1', [task.id, JSON.stringify([pendingFile('F1')])])
    const lease = await acquireLease(pool, task.id, 'test', 60_000)
    if (!lease) throw new Error('no lease')
    const fetch: FileFetch = async () => {
      await pool.query('UPDATE autonomous_tasks SET files = files || $2::jsonb WHERE id = $1', [task.id, JSON.stringify([pendingFile('F2')])])
      return { ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode('hello') })() }
    }

    await downloadTaskFiles(pool, (await loadTask(pool, task.id)) as AutonomousTask, lease, { fetch, botToken: 'xoxb-test', inboxDir: mkdtempSync(join(tmpdir(), 'relay-inbox-')) })

    const files = (await loadTask(pool, task.id))?.files ?? []
    expect(files.map((file) => [file.slackFileId, file.status])).toEqual([['F1', 'downloaded'], ['F2', 'pending']])
  })

  it('leaves a mid-turn message for the next turn when the worker takes no input', async () => {
    const { workspaceId, task, say } = await newTask('build the report')
    const h = harness([
      async () => {
        await say('also add a chart')
        await new Promise((resolve) => setTimeout(resolve, 100))
        return reply('first')
      },
      async () => reply('second'),
    ])
    const s = scheduler(workspaceId, h, { tickMs: 20 })

    await s.tick()
    await s.tick()

    expect(h.turns).toHaveLength(2)
    expect(h.turns[1]?.prompt).toContain('also add a chart')
    expect(await loadTask(pool, task.id)).toMatchObject({ pendingEvents: [] })
  })

  it('runs again with an approval note even with no new message, and parks with nothing to do', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([async () => reply(), async () => reply('pushed')], {
      settleApprovals: async (_task, lease) => {
        if (h.turns.length === 1) await addNote(pool, lease, 'Approved. Run it again now: git push')
      },
    })
    const s = scheduler(workspaceId, h)
    await s.tick()
    await pool.query('UPDATE autonomous_tasks SET next_wakeup_at = now() WHERE id = $1', [task.id])
    await s.tick()
    expect(h.turns[1]?.prompt).toContain('Approved. Run it again now: git push')
    await pool.query('UPDATE autonomous_tasks SET next_wakeup_at = now() WHERE id = $1', [task.id])
    await s.tick()
    expect(h.turns).toHaveLength(2)
    expect(h.posts).toEqual(['reply text', 'pushed'])
  })

  it('keeps a wakeup set during the turn, so an approval given meanwhile is not parked', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        await pool.query('UPDATE autonomous_tasks SET next_wakeup_at = now() WHERE id = $1', [task.id])
        return reply()
      },
    ])
    await scheduler(workspaceId, h).tick()
    expect((await loadTask(pool, task.id))?.nextWakeupAt).not.toBeNull()
  })

  it('posts a failed turn once, drops its messages and parks', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([async () => outcome({ kind: 'failed', reason: 'claude exited 1 with no result', stderrTail: '' })])
    await scheduler(workspaceId, h).tick()
    expect(h.posts).toEqual(['That turn failed: claude exited 1 with no result'])
    expect(await loadTask(pool, task.id)).toMatchObject({ pendingEvents: [], nextWakeupAt: null })
  })

  it('starts fresh on the same messages after a rejected resume', async () => {
    const { workspaceId, task } = await newTask()
    await pool.query("UPDATE autonomous_tasks SET engine_session_id = 'gone' WHERE id = $1", [task.id])
    const h = harness([async () => outcome({ kind: 'resume_rejected' })])
    await scheduler(workspaceId, h).tick()
    expect(await loadTask(pool, task.id)).toMatchObject({ engineSessionId: null, pendingEvents: [expect.anything()] })
    expect(h.posts).toEqual([])
  })

  it('runs two threads concurrently', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'R', ['member'])
    for (const ts of ['2.1', '3.1']) {
      await intakeMention(pool, {
        workspaceId,
        principalId,
        adapter: 'slack',
        threadRef: `slack:C1:${ts}:${randomUUID()}`,
        event: { id: `C1:${ts}:${randomUUID()}`, principalId, text: 'go', ref: { channel: 'C1', message: ts }, fileIds: [], receivedAt: new Date().toISOString() },
        replyRef: { channel: 'C1', thread: ts },
        files: [],
      })
    }
    let inFlight = 0
    let peak = 0
    const slow = async (): Promise<TurnResult> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 100))
      inFlight -= 1
      return reply()
    }
    await scheduler(workspaceId, harness([slow, slow])).tick()
    expect(peak).toBe(2)
  })

  it('discards the reply of a holder whose lease was taken over during the turn', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([
      async (context) => {
        // Another holder takes the lease: the generation moves on.
        await pool.query('UPDATE autonomous_tasks SET lease_generation = lease_generation + 1, lease_owner = $2 WHERE id = $1', [context.task.id, 'other'])
        await new Promise((resolve) => setTimeout(resolve, 1300))
        return reply()
      },
    ])
    await scheduler(workspaceId, h, { leaseTtlMs: 3000 }).tick()
    expect(h.posts).toEqual([])
    expect((await loadTask(pool, task.id))?.pendingEvents).toHaveLength(1)
  })

  it('kills a live recorded worker at startup before any new turn', async () => {
    const { workspaceId, task } = await newTask()
    const dir = mkdtempSync(join(tmpdir(), 'relay-sched-'))
    const bin = join(dir, 'claude')
    writeFileSync(bin, '#!/bin/sh\nsleep 30\n')
    chmodSync(bin, 0o755)
    const child = spawnGated({ bin, args: [], cwd: dir, env: process.env, timeoutMs: 60_000 })
    await pool.query('UPDATE autonomous_tasks SET worker_pid = $2, worker_pgid = $2, next_wakeup_at = NULL WHERE id = $1', [task.id, child.pgid])

    const s = scheduler(workspaceId, harness([]))
    await s.start()
    await s.stop()

    expect(processGroupAlive(child.pgid)).toBe(false)
    expect((await loadTask(pool, task.id))?.workerPgid).toBeNull()
    await child.done
  })

  it('Stop stops the task, cleans up, and no later wakeup acts', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([async () => reply()])
    const s = scheduler(workspaceId, h)
    await s.tick()

    const stopped = await stopAutonomousTask(pool, h.effects, task.id)
    expect(stopped?.phase).toBe('stopped')
    expect(h.cleaned).toEqual([task.id])

    await pool.query('UPDATE autonomous_tasks SET next_wakeup_at = now() WHERE id = $1', [task.id])
    await s.tick()
    expect(h.turns).toHaveLength(1)

  })

  it('stops every open task when the kill switch is engaged', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([])
    await scheduler(workspaceId, h, { engaged: () => true }).tick()
    expect((await loadTask(pool, task.id))?.phase).toBe('stopped')
    expect(h.turns).toHaveLength(0)
    expect(h.posts[0]).toContain('kill switch')
  })
})
