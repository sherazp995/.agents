import { describe, expect, it } from 'vitest'
import type { ChatAction } from '../../src/chat/contract.js'
import type { RepoRegistry } from '../../src/repos/schema.js'
import { registerSecretValue } from '../../src/secrets/scrubber.js'
import { bindPlan, finishTask, renderFindings } from '../../src/autonomous/task-effects.js'
import type { PlanPayload } from '../../src/autonomous/reply.js'

const PLAN: PlanPayload = { summary: 's', task_type: 'implement', change_kind: 'fix', visible: false, scope: 'x', acceptance_criteria: ['a'], test_command: 't', repo: 'web' }

function registry(...names: string[]): RepoRegistry {
  return {
    version: 1,
    repos: names.map((name) => ({ name, aliases: [], path: `/repos/${name}`, default_branch: 'main', permitted_operations: [], off_limits: [] })),
  } as unknown as RepoRegistry
}

describe('task effects', () => {
  it('binds a registered repo and names the registered ones otherwise', () => {
    expect(bindPlan(registry('web', 'api'), PLAN)).toEqual({ kind: 'bound', repoName: 'web' })
    const unbound = bindPlan(registry('api'), PLAN)
    expect(unbound).toMatchObject({ kind: 'unbound', reason: expect.stringContaining('Registered: api.') })
    expect(bindPlan(registry('web-a', 'web-b'), PLAN).kind).toBe('unbound')
  })

  it('lists in-scope findings first and out-of-scope ones as not fixed', () => {
    const text = renderFindings([
      { id: 'F1', severity: 'high', file: 'a.ts', line: 3, summary: 'null deref', status: 'fixed' },
      { id: 'F2', severity: 'low', file: 'b.ts', line: null, summary: 'naming', status: 'open', inScope: false },
    ])
    expect(text).toBe('Findings:\n- F1 HIGH null deref: a.ts:3 (fixed)\n\nOut of scope, not fixed:\n- F2 LOW naming: b.ts (open)')
  })

  it('scrubs the final post and reacts by outcome', async () => {
    const secret = `sk-test-${Date.now()}-secretvalue`
    registerSecretValue(secret)
    const actions: ChatAction[] = []
    await finishTask(async (action) => {
      actions.push(action)
    }, { reply: { channel: 'C1', thread: '1.1' }, mention: { channel: 'C1', message: '1.1' } }, { findings: [] }, 'blocked', `Blocked: token ${secret}`)

    expect(JSON.stringify(actions)).not.toContain(secret)
    expect(actions[1]).toMatchObject({ kind: 'react', name: 'x' })
  })

  it('posts nothing but the reaction when there is no text and no finding', async () => {
    const actions: ChatAction[] = []
    await finishTask(async (action) => {
      actions.push(action)
    }, { reply: { channel: 'C1', thread: '1.1' }, mention: { channel: 'C1', message: '1.1' } }, { findings: [] }, 'done', '')

    expect(actions).toEqual([{ kind: 'react', ref: { channel: 'C1', message: '1.1' }, name: 'white_check_mark' }])
  })
})
