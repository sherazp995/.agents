import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import type { ChatAction } from '../../src/chat/contract.js'
import { createLogger } from '../../src/obs/logger.js'
import { processGroupAlive, spawnGated } from '../../src/process/gated-spawn.js'
import { intakeMention, loadTask, type AutonomousTask, type IntakeOutbox } from '../../src/autonomous/store.js'
import { createScheduler, stopAutonomousTask, type SchedulerEffects, type TurnRequestContext, type TurnResult, type VerificationResult } from '../../src/autonomous/scheduler.js'
import type { PlanPayload, WorkerReply } from '../../src/autonomous/reply.js'
import { getTestDatabaseUrl } from '../support/database.js'

const PLAN: PlanPayload = { summary: 'fix login', task_type: 'implement', change_kind: 'fix', visible: false, scope: 'login form', acceptance_criteria: ['logs in'], test_command: 'pnpm test', repo: 'web' }

function reply(status: WorkerReply['status'], extra: Partial<WorkerReply> = {}): TurnResult {
  return {
    kind: 'outcome',
    outcome: { kind: 'reply', reply: { status, text: `${status} text`, ...extra }, sessionId: 'sess-1', costUsd: 0.1 },
    accountKey: 'claude',
    runId: randomUUID(),
    notes: [],
  }
}

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

  const outbox: IntakeOutbox = {
    async enqueue(action: ChatAction, workspaceId: string, executor?: PoolClient) {
      await (executor ?? pool).query(`INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'test', $2, now())`, [workspaceId, action])
      return ''
    },
  }

  async function newTask(text = 'fix the login bug'): Promise<{ workspaceId: string; task: AutonomousTask }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Requester', ['member'])
    const result = await intakeMention(pool, outbox, {
      workspaceId,
      principalId,
      adapter: 'slack',
      threadRef: `slack:C1:${randomUUID()}`,
      event: { id: `C1:${randomUUID()}`, principalId, text, ref: { channel: 'C1', message: '1.1' }, fileIds: [], receivedAt: new Date().toISOString() },
      mentionRef: { channel: 'C1', message: '1.1' },
      replyRef: { channel: 'C1', thread: '1.1' },
      files: [],
    })
    if (result.kind !== 'created') throw new Error('expected a new task')
    return { workspaceId, task: result.task }
  }

  type Harness = {
    effects: SchedulerEffects
    turns: TurnRequestContext[]
    posts: string[]
    finished: { outcome: string; text: string }[]
    cards: number
    cleaned: string[]
  }

  function harness(turns: ((context: TurnRequestContext) => Promise<TurnResult>)[], overrides: Partial<SchedulerEffects> = {}): Harness {
    const h: Harness = { turns: [], posts: [], finished: [], cards: 0, cleaned: [], effects: undefined as never }
    h.effects = {
      async runTurn(context) {
        h.turns.push(context)
        const next = turns.shift()
        if (!next) throw new Error('no scripted turn left')
        return next(context)
      },
      downloadFiles: async () => [],
      bindPlan: async () => ({ kind: 'bound', repoName: 'web' }),
      async postPlanForApproval() {
        h.cards += 1
      },
      settleApprovals: async () => undefined,
      requestRemoteWrite: async () => 'operation op-1 waits for approval',
      prepareWorktree: async () => undefined,
      verify: async () => ({ kind: 'passed' }),
      async finish(_task, outcome, text) {
        h.finished.push({ outcome, text })
      },
      async cleanupStopped(task) {
        h.cleaned.push(task.id)
      },
      sweep: async () => undefined,
      ...overrides,
    }
    return h
  }

  function scheduler(workspaceId: string, h: Harness, options: { engaged?: () => boolean; leaseTtlMs?: number } = {}) {
    return createScheduler({
      pool,
      workspaceId,
      owner: `test-${randomUUID()}`,
      post: async (action) => {
        if (action.kind === 'post') h.posts.push(action.text)
      },
      replyRef: async () => ({ channel: 'C1', thread: '1.1' }),
      isKillSwitchEngaged: async () => options.engaged?.() ?? false,
      effects: h.effects,
      log: createLogger('fatal'),
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
    })
  }

  it('runs a read-only interview turn on the new message, posts the question and parks', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([async () => reply('question')])

    await scheduler(workspaceId, h).tick()

    expect(h.turns[0]?.mode).toBe('read_only')
    expect(h.turns[0]?.prompt).toContain('fix the login bug')
    expect(h.posts).toEqual(['question text'])
    const after = await loadTask(pool, task.id)
    expect(after).toMatchObject({ phase: 'interview', pendingEvents: [], nextWakeupAt: null, engineSessionId: 'sess-1' })
  })

  it('posts a bound plan for approval and parks; an unbound plan posts the reason, no card, and resumes', async () => {
    const bound = await newTask()
    const h = harness([async () => reply('plan', { plan: PLAN })])
    await scheduler(bound.workspaceId, h).tick()
    expect(h.cards).toBe(1)
    expect((await loadTask(pool, bound.task.id))?.phase).toBe('awaiting_plan_approval')

    const unbound = await newTask()
    const u = harness([async () => reply('plan', { plan: PLAN })], { bindPlan: async () => ({ kind: 'unbound', reason: 'web is not registered; registered: api.' }) })
    await scheduler(unbound.workspaceId, u).tick()
    expect(u.cards).toBe(0)
    expect(u.posts).toContain('web is not registered; registered: api.')
    const after = await loadTask(pool, unbound.task.id)
    expect(after?.pendingNotes[0]).toContain('could not be bound')
    expect(after?.nextWakeupAt).not.toBeNull()
  })

  it('refuses a remote write before plan approval with a correction, and never asks for it', async () => {
    const { workspaceId, task } = await newTask()
    let requested = 0
    const h = harness([async () => reply('question', { remote_write: { kind: 'push', branch: 'x' } })], {
      requestRemoteWrite: async () => {
        requested += 1
        return ''
      },
    })
    await scheduler(workspaceId, h).tick()
    expect(requested).toBe(0)
    expect((await loadTask(pool, task.id))?.pendingNotes[0]).toContain('only after the plan is approved')
  })

  it('retries a schema-invalid reply once, then blocks', async () => {
    const { workspaceId, task } = await newTask()
    const invalid = async (): Promise<TurnResult> => ({ kind: 'outcome', outcome: { kind: 'schema_invalid', sessionId: null, error: 'plan: Required', costUsd: null }, accountKey: 'claude', runId: randomUUID(), notes: [] })
    const h = harness([invalid, invalid])
    const s = scheduler(workspaceId, h)
    await s.tick()
    await s.tick()
    expect(h.turns).toHaveLength(2)
    expect(h.turns[1]?.prompt).toContain('did not match the reply schema (plan: Required)')
    expect((await loadTask(pool, task.id))?.phase).toBe('blocked')
    expect(h.finished[0]?.text).toContain('did not match the reply schema twice')
  })

  it('runs two threads concurrently', async () => {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'R', ['member'])
    for (const ts of ['2.1', '3.1']) {
      await intakeMention(pool, outbox, {
        workspaceId,
        principalId,
        adapter: 'slack',
        threadRef: `slack:C1:${ts}:${randomUUID()}`,
        event: { id: `C1:${ts}:${randomUUID()}`, principalId, text: 'go', ref: { channel: 'C1', message: ts }, fileIds: [], receivedAt: new Date().toISOString() },
        mentionRef: { channel: 'C1', message: ts },
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
      return reply('question')
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
        return reply('question')
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

  it('Stop while awaiting plan approval stops the task, cleans up, and no later wakeup acts', async () => {
    const { workspaceId, task } = await newTask()
    const h = harness([async () => reply('plan', { plan: PLAN })])
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
    expect(h.finished[0]?.text).toContain('kill switch')
  })

  it('verification gaps resume the worker; a third failing round blocks with the gaps; a pass finishes done', async () => {
    const { workspaceId, task } = await newTask()
    await pool.query(`UPDATE autonomous_tasks SET phase = 'verifying', task_type = 'implement', pending_events = '[]' WHERE id = $1`, [task.id])
    const results: VerificationResult[] = [{ kind: 'gaps', gaps: ['tests exit 1'] }, { kind: 'gaps', gaps: ['review FAIL'] }, { kind: 'gaps', gaps: ['missing Codex lens'] }]
    const h = harness([async () => reply('done'), async () => reply('done')], { verify: async () => results.shift() ?? { kind: 'passed' } })
    const s = scheduler(workspaceId, h)

    await s.tick() // round 1 fails -> working with a note
    expect((await loadTask(pool, task.id))?.pendingNotes.at(-1)).toContain('tests exit 1')
    await s.tick() // worker says done -> verifying
    await s.tick() // round 2 fails
    await s.tick() // worker says done
    await s.tick() // round 3 fails -> blocked
    expect((await loadTask(pool, task.id))?.phase).toBe('blocked')
    expect(h.finished.at(-1)?.text).toContain('missing Codex lens')

    const ok = await newTask()
    await pool.query(`UPDATE autonomous_tasks SET phase = 'verifying', task_type = 'implement', pending_events = '[]' WHERE id = $1`, [ok.task.id])
    const p = harness([])
    await scheduler(ok.workspaceId, p).tick()
    expect((await loadTask(pool, ok.task.id))?.phase).toBe('done')
    expect(p.finished[0]?.outcome).toBe('done')
  })

  it('blocks once when verification itself throws, instead of retrying every tick', async () => {
    const { workspaceId, task } = await newTask()
    await pool.query(`UPDATE autonomous_tasks SET phase = 'verifying', task_type = 'implement', pending_events = '[]' WHERE id = $1`, [task.id])
    const h = harness([], { verify: async () => { throw new Error('git fetch failed') } })
    await scheduler(workspaceId, h).tick()
    expect(await loadTask(pool, task.id)).toMatchObject({ phase: 'blocked', nextWakeupAt: null })
    expect(h.finished[0]?.text).toContain('verification could not run: git fetch failed')
  })

  it('reopens a done task on a new message with its stored findings to recheck by id', async () => {
    const { workspaceId, task } = await newTask()
    const findings = [{ id: 'F1', severity: 'HIGH', file: 'a.ts', line: 3, summary: 'null deref', status: 'open' }]
    await pool.query(`UPDATE autonomous_tasks SET phase = 'done', task_type = 'review', findings = $2 WHERE id = $1`, [task.id, JSON.stringify(findings)])
    const h = harness([async () => reply('done', { findings: [{ ...findings[0], status: 'fixed' } as never] })])
    await scheduler(workspaceId, h).tick()

    expect(h.turns[0]?.prompt).toContain('F1 HIGH a.ts:3 null deref')
    expect(h.turns[0]?.mode).toBe('bypass')
    expect((await loadTask(pool, task.id))?.findings[0]?.status).toBe('fixed')
  })
})
