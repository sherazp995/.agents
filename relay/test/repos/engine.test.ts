import { describe, expect, it, vi } from 'vitest'

import { ENGINE_ALLOWED_HOSTS, engineEnvironment, readsAsCouldNotComplete, runEngine, verify } from '../../src/repos/engine.js'
import { repoEntrySchema } from '../../src/repos/schema.js'

/**
 * FR-CODE-25's taxonomy is the point of most of this file. "It crashed", "it
 * ran out of time" and "it says it could not do this" call for three
 * different responses from the operator, and collapsing them into a generic
 * failure throws away the only thing that distinguishes them.
 */

function repo(overrides: Record<string, unknown> = {}) {
  return repoEntrySchema.parse({
    name: 'fixture',
    path: '/Users/op/code/fixture',
    permitted_operations: ['read', 'write'],
    ...overrides,
  })
}

function harness(runResult: Record<string, unknown>, attempts: Array<Record<string, unknown>> = []) {
  const closed = { count: 0 }
  return {
    closed,
    deps: {
      available: () => ({ available: true }) as { available: true },
      startProxy: async () => ({
        port: 9999,
        attempts,
        close: async () => {
          closed.count += 1
        },
      }),
      run: async () => runResult,
    } as never,
  }
}

describe('FR-CODE-25: each failure mode is its own outcome', () => {
  it('reports a CRASH distinctly, with what the engine said', async () => {
    const { deps } = harness({ outcome: 'ran', exitCode: 1, stdout: '', stderr: 'engine blew up', timedOut: false, rules: {} })

    const outcome = await runEngine({ repo: repo(), worktreePath: '/w', task: 'do a thing' }, deps)

    expect(outcome.kind).toBe('crashed')
    if (outcome.kind !== 'crashed') return
    expect(outcome.stderr).toContain('engine blew up')
  })

  it('reports a TIMEOUT distinctly, and keeps the partial output', async () => {
    // FR-CODE-24: partial work stays in the worktree, so the report must say
    // what got done rather than only that time ran out.
    const { deps } = harness({ outcome: 'ran', exitCode: null, stdout: 'got halfway', stderr: '', timedOut: true, rules: {} })

    const outcome = await runEngine({ repo: repo(), worktreePath: '/w', task: 'x', timeoutSeconds: 60 }, deps)

    expect(outcome.kind).toBe('timed_out')
    if (outcome.kind !== 'timed_out') return
    expect(outcome.seconds).toBe(60)
    expect(outcome.partialOutput).toBe('got halfway')
  })

  it('reports COULD NOT COMPLETE distinctly, which is not a failure of Relay\'s', async () => {
    const { deps } = harness({
      outcome: 'ran',
      exitCode: 0,
      stdout: 'I am unable to complete this task because the API is undocumented.',
      stderr: '',
      timedOut: false,
      rules: {},
    })

    const outcome = await runEngine({ repo: repo(), worktreePath: '/w', task: 'x' }, deps)

    expect(outcome.kind).toBe('could_not_complete')
  })

  it('reports REFUSED when confinement is unavailable, rather than running unconfined', async () => {
    const outcome = await runEngine({ repo: repo(), worktreePath: '/w', task: 'x' }, {
      available: () => ({ available: false, reason: 'no sandbox here' }),
    } as never)

    expect(outcome.kind).toBe('refused')
  })

  it('reports COMPLETED for an ordinary successful run', async () => {
    const { deps } = harness({ outcome: 'ran', exitCode: 0, stdout: 'Added the thing.', stderr: '', timedOut: false, rules: {} })

    const outcome = await runEngine({ repo: repo(), worktreePath: '/w', task: 'x' }, deps)

    expect(outcome.kind).toBe('completed')
  })
})

describe('the could-not-complete match is deliberately narrow', () => {
  it('matches an engine declining the task', () => {
    expect(readsAsCouldNotComplete('I am unable to complete this task.')).toBe(true)
    expect(readsAsCouldNotComplete("I cannot complete this without credentials")).toBe(true)
  })

  it('does NOT reclassify a successful run that merely mentions the words', () => {
    // A loose match is worse than the generic failure it replaces: the
    // operator would be told the work was declined while the diff sits in
    // the worktree.
    expect(readsAsCouldNotComplete('Added a guard so the parser cannot complete an unterminated string.')).toBe(false)
    expect(readsAsCouldNotComplete('Done. Previously it was unable to complete large files; now it streams.')).toBe(false)
  })
})

describe('the proxy is always closed, whatever the outcome', () => {
  it('closes it after a crash as well as a success', async () => {
    const { deps, closed } = harness({ outcome: 'ran', exitCode: 1, stdout: '', stderr: 'x', timedOut: false, rules: {} })

    await runEngine({ repo: repo(), worktreePath: '/w', task: 'x' }, deps)

    expect(closed.count).toBe(1)
  })
})

describe('the engine can reach Anthropic and nothing else', () => {
  it('declares Anthropic, and NOT the git remote', () => {
    // A push goes through the reviewed publish gate, not through the engine
    // deciding to.
    expect(ENGINE_ALLOWED_HOSTS).toContain('api.anthropic.com')
    expect(ENGINE_ALLOWED_HOSTS.join(' ')).not.toContain('github.com')
  })

  it('reports blocked destinations, so third-party telemetry is visible rather than silent', async () => {
    // Measured against the real CLI: it attempts a Datadog log intake that
    // FR-DATA-3 forbids and the egress inventory does not declare. The proxy
    // terminates it; this is how the operator finds out.
    const { deps } = harness({ outcome: 'ran', exitCode: 0, stdout: 'done', stderr: '', timedOut: false, rules: {} }, [
      { host: 'http-intake.logs.us5.datadoghq.com', port: 443, method: 'connect', allowed: false },
      { host: 'api.anthropic.com', port: 443, method: 'connect', allowed: true },
    ])

    const outcome = await runEngine({ repo: repo(), worktreePath: '/w', task: 'x' }, deps)

    expect(outcome.kind).toBe('completed')
    if (outcome.kind !== 'completed') return
    expect(outcome.blockedDestinations).toEqual(['http-intake.logs.us5.datadoghq.com'])
  })

  it('points the engine at the proxy, which is the whole reason it can be confined', () => {
    const env = engineEnvironment(4321, {})

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:4321')
    // Without excluding loopback, some clients route their own local calls
    // through the proxy and deadlock against it.
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })
})

describe('FR-CODE-30: no run reports success without verification', () => {
  it('reports NOT CONFIGURED rather than treating a missing test command as a pass', async () => {
    const outcome = await verify(repo(), '/w', { run: (async () => ({ outcome: 'ran' })) as never })

    expect(outcome.kind).toBe('not_configured')
    if (outcome.kind !== 'not_configured') return
    expect(outcome.reason).toContain('nothing verified this change')
  })

  it('reports failure WITH the output, never a success', async () => {
    const outcome = await verify(repo({ test_command: 'pnpm test' }), '/w', {
      run: (async () => ({ outcome: 'ran', exitCode: 1, stdout: '3 failing', stderr: '', timedOut: false, rules: {} })) as never,
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.command).toBe('pnpm test')
    expect(outcome.output).toContain('3 failing')
  })

  it('reports the actual command that ran, so the claim is checkable', async () => {
    const outcome = await verify(repo({ test_command: 'pnpm test' }), '/w', {
      run: (async () => ({ outcome: 'ran', exitCode: 0, stdout: 'all good', stderr: '', timedOut: false, rules: {} })) as never,
    })

    expect(outcome.kind).toBe('passed')
    if (outcome.kind !== 'passed') return
    expect(outcome.command).toBe('pnpm test')
  })
})
