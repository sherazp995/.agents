/**
 * Tests for src/cli/smoke.ts.
 *
 * evaluateAgentRun (the pure judgement behind the one step that matters) is
 * tested directly with fabricated AgentLoopResult and Step values: no real
 * Postgres row, no real engine call, anywhere near these cases. runSmoke's
 * own wiring is tested with every impure dependency injected (pool
 * creation, migrations, the agent-run step itself, secrets, fetch), so most
 * of this file needs no real Postgres or Redis at all. One group, marked
 * REAL INFRA, deliberately exercises the always-on steps (postgres, redis,
 * migrations, browser-tiers) against this repo's own docker-compose
 * Postgres and Redis and a real per-worker test database, the same
 * convention test/cli/principals.test.ts already uses; it never runs the
 * real agent-run step, since that needs a real claude binary and spends
 * money.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentLoopResult } from '../../src/agent/loop.js'
import { ECHO_CAPABILITY_NAME } from '../../src/agent/capabilities/echo.js'
import type { Step } from '../../src/runs/store.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { createLogger } from '../../src/obs/logger.js'
import { EnvSecretProvider } from '../../src/secrets/env.js'
import type { runTier2SelfTest } from '../../src/browser/tier2/selftest.js'
import { getTestDatabaseUrl } from '../support/database.js'
import type { Policy } from '../../src/config/schema.js'
import {
  type SmokeOptions,
  evaluateAgentRun,
  runAgentSmokeStep,
  runSmoke,
} from '../../src/cli/smoke.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relay-smoke-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// evaluateAgentRun: pure, no I/O
// ---------------------------------------------------------------------------

function baseResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    runId: 'run-1',
    state: 'succeeded',
    costUsd: 0.01,
    stepsExecuted: 1,
    notVerified: [],
    warnings: [],
    capabilityNotices: [],
    capabilitiesUsed: [],
    ...overrides,
  }
}

/**
 * The nonce as the DATABASE actually stores it.
 *
 * src/runs/store.ts's serializeAndScrub JSON.stringify's step output, so a
 * correctly echoed nonce is persisted QUOTED. Every fixture here originally
 * used the raw string, which is why twenty tests passed while a real smoke
 * run reported an exact-echo mismatch on a perfectly healthy pipeline: the
 * fixtures described a storage format that does not exist.
 */
function persistedNonce(nonce: string): string {
  return JSON.stringify(nonce)
}

function echoStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    runId: 'run-1',
    workspaceId: 'ws-1',
    seq: 1,
    capability: ECHO_CAPABILITY_NAME,
    input: 'nonce-abc',
    state: 'succeeded',
    output: 'nonce-abc',
    error: null,
    runTransitionSeq: 1,
    policyDecision: 'proceed',
    policyReason: 'allowed',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  }
}

describe('evaluateAgentRun', () => {
  it('accepts the nonce in the form the database actually stores it', () => {
    // Regression. The comparison was `output === nonce` against a value the
    // store JSON.stringify's, so it could never be true and reported a
    // mismatch on every healthy run. A smoke test accusing the pipeline of a
    // fault that is its own is worse than no check, because it teaches the
    // operator to discount the one signal that is supposed to mean
    // something.
    const nonce = 'nonce-abc'
    const result = evaluateAgentRun(baseResult(), [echoStep({ output: persistedNonce(nonce) })], nonce)

    expect(result.status).toBe('passed')
    expect(result.detail).not.toMatch(/did not match/i)
  })

  it('still reports a genuine mismatch, so the check has not been defanged', () => {
    // The fix must not become "accept anything". A step that echoed
    // something else entirely is still called out.
    const result = evaluateAgentRun(baseResult(), [echoStep({ output: persistedNonce('something-else') })], 'nonce-abc')

    expect(result.detail).toMatch(/did not match/i)
  })

  it('passes when the run succeeded and a persisted step actually invoked and completed echo', () => {
    const result = evaluateAgentRun(baseResult(), [echoStep()], 'nonce-abc')
    expect(result.status).toBe('passed')
    expect(result.detail).toContain('echoing back the exact nonce sent')
  })

  it('fails when the run succeeded but executed zero capability calls (proves the pipeline, not just the summary)', () => {
    const result = evaluateAgentRun(baseResult({ stepsExecuted: 0 }), [], 'nonce-abc')
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('no persisted step actually invoked')
  })

  it('fails when the only persisted step is a different capability', () => {
    const result = evaluateAgentRun(baseResult(), [echoStep({ capability: 'browser' })], 'nonce-abc')
    expect(result.status).toBe('failed')
  })

  it('fails when the persisted echo step did not itself succeed', () => {
    const result = evaluateAgentRun(baseResult(), [echoStep({ state: 'failed', error: 'boom' })], 'nonce-abc')
    expect(result.status).toBe('failed')
  })

  it('fails when the run state is not succeeded, regardless of any persisted step', () => {
    const result = evaluateAgentRun(baseResult({ state: 'failed' }), [echoStep()], 'nonce-abc')
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('the run ended in state "failed"')
  })

  it('fails for a dead-lettered run', () => {
    const result = evaluateAgentRun(baseResult({ state: 'dead_letter' }), [], 'nonce-abc')
    expect(result.status).toBe('failed')
  })

  it('passes but notes a mismatch when the echoed output does not match the exact nonce', () => {
    const result = evaluateAgentRun(baseResult(), [echoStep({ output: 'something-else' })], 'nonce-abc')
    expect(result.status).toBe('passed')
    expect(result.detail).toContain('did not match the exact nonce sent')
  })

  it('always states what it verified, regardless of outcome', () => {
    const passed = evaluateAgentRun(baseResult(), [echoStep()], 'nonce-abc')
    const failed = evaluateAgentRun(baseResult({ state: 'failed' }), [], 'nonce-abc')
    expect(passed.verified).toContain('governed agent run')
    expect(failed.verified).toBe(passed.verified)
  })
})

// ---------------------------------------------------------------------------
// runSmoke: wiring, every impure dependency injected
// ---------------------------------------------------------------------------

const noopClosePool = async () => {}
const dummyCreatePool = () => ({}) as Pool

function baseSmokeOptions(overrides: Partial<SmokeOptions> = {}): SmokeOptions {
  return {
    configPath: join(dir, 'relay.config.yaml'),
    policyPath: join(dir, 'policy.yaml'),
    profilesPath: join(dir, 'profiles.yaml'),
    migrationsDir: 'src/db/migrations',
    runAgent: false,
    now: () => 0,
    createPoolFn: dummyCreatePool,
    closePoolFn: noopClosePool,
    applyMigrationsFn: async () => [],
    secretsFn: () => new EnvSecretProvider({}),
    // Stubbed by default so this file's tests never launch a real Chrome:
    // the self-test itself is exercised against a real browser in
    // test/browser/tier2/selftest.integration.test.ts, and what these tests
    // are about is how runSmoke REPORTS its outcome.
    runTier2SelfTestFn: async () => ({ outcome: 'passed', detail: 'stubbed self-test' }),
    ...overrides,
  }
}

async function writeConfig(configPath: string, databaseUrl: string, redisUrl: string): Promise<void> {
  await writeFile(
    configPath,
    `model_provider:\n  name: anthropic\n  zero_data_retention: true\ndatabase:\n  url: ${databaseUrl}\nredis:\n  url: ${redisUrl}\nlogging:\n  level: error\nsecrets:\n  provider: keychain\n`,
    'utf8',
  )
}

async function writePolicy(policyPath: string): Promise<void> {
  await writeFile(policyPath, 'version: 1\ndefaults:\n  unmatched: ask\nhard_blocked_origins:\n  - "*.chase.com"\n', 'utf8')
}

const UNREACHABLE_DATABASE_URL = 'postgres://relay:relay@127.0.0.1:1/relay'
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1'

describe('runSmoke: invalid configuration', () => {
  it('names every step as skipped rather than silently dropping them, and fails on config alone', async () => {
    const result = await runSmoke(baseSmokeOptions({ configPath: join(dir, 'missing.yaml') }))

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('[FAIL] config')
    for (const name of ['postgres', 'redis', 'migrations', 'slack-token-valid', 'slack-socket-mode', 'slack-identity', 'browser-tiers', 'browser-driver', 'agent-run']) {
      expect(result.report).toContain(`[SKIP] ${name}`)
    }
  })
})

describe('runSmoke: unreachable dependencies report failed, not passed', () => {
  it('reports postgres and redis as failed against unreachable hosts, and skips migrations and agent-run', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    await writeConfig(configPath, UNREACHABLE_DATABASE_URL, UNREACHABLE_REDIS_URL)
    await writePolicy(policyPath)

    const result = await runSmoke(baseSmokeOptions({ configPath, policyPath, runAgent: true }))

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('[FAIL] postgres')
    expect(result.report).toContain('[FAIL] redis')
    expect(result.report).toContain('[SKIP] migrations')
    expect(result.report).toContain('Postgres was not reachable, so migrations were not attempted')
    expect(result.report).toContain('[SKIP] agent-run')
    expect(result.report).toContain('Postgres was not reachable, so the agent run was not attempted')
  }, 15000)
})

describe('runSmoke: agent-run opt-in', () => {
  it('skips agent-run by default, stating why, and never calls the injected step function', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    await writeConfig(configPath, UNREACHABLE_DATABASE_URL, UNREACHABLE_REDIS_URL)
    await writePolicy(policyPath)
    let called = false

    const result = await runSmoke(
      baseSmokeOptions({
        configPath,
        policyPath,
        runAgent: false,
        runAgentSmokeStepFn: async () => {
          called = true
          return { name: 'agent-run', status: 'passed', verified: 'x', detail: 'x' }
        },
      }),
    )

    expect(called).toBe(false)
    expect(result.report).toContain('[SKIP] agent-run')
    expect(result.report).toContain('not run. Pass --run-agent')
  }, 15000)

  it('calls the injected agent-run step function when --run-agent is set and postgres is reachable', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    const databaseUrl = await getTestDatabaseUrl()
    await writeConfig(configPath, databaseUrl, 'redis://localhost:6379/8')
    await writePolicy(policyPath)
    let called = false

    const result = await runSmoke(
      baseSmokeOptions({
        configPath,
        policyPath,
        runAgent: true,
        runAgentSmokeStepFn: async () => {
          called = true
          return { name: 'agent-run', status: 'passed', verified: 'a real agent run', detail: 'stubbed for this test' }
        },
      }),
    )

    expect(called).toBe(true)
    expect(result.report).toContain('[PASS] agent-run')
  }, 15000)
})

describe('runSmoke: migrations failure', () => {
  it('reports migrations as failed, not passed, when applying them throws', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    const databaseUrl = await getTestDatabaseUrl()
    await writeConfig(configPath, databaseUrl, 'redis://localhost:6379/8')
    await writePolicy(policyPath)

    const result = await runSmoke(
      baseSmokeOptions({
        configPath,
        policyPath,
        applyMigrationsFn: async () => {
          throw new Error('Migration 0099_broken.sql failed: syntax error')
        },
      }),
    )

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('[FAIL] migrations')
    expect(result.report).toContain('syntax error')
  }, 15000)
})

describe('runAgentSmokeStep: the real impure wrapper', () => {
  it('reports failed, not throwing out of runSmoke, when the agent loop itself throws', async () => {
    const databaseUrl = await getTestDatabaseUrl()
    const pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
    const log = createLogger('error')
    const policy: Policy = { version: 1, defaults: { unmatched: 'ask' }, hard_blocked_origins: ['*.example.com'] }

    try {
      const result = await runAgentSmokeStep(pool, policy, log, async () => {
        throw new Error('the claude binary is not installed on this test machine')
      })

      expect(result.status).toBe('failed')
      expect(result.name).toBe('agent-run')
      expect(result.detail).toContain('the agent loop threw before returning a result')
      expect(result.detail).toContain('claude binary is not installed')
    } finally {
      await pool.end()
    }
  }, 15000)
})

describe('runSmoke: browser tier availability', () => {
  it('reports a pin failure as a failed step', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    const profilesPath = join(dir, 'profiles.yaml')
    await writeConfig(configPath, UNREACHABLE_DATABASE_URL, UNREACHABLE_REDIS_URL)
    await writePolicy(policyPath)
    await writeFile(
      profilesPath,
      `version: 1
profiles:
  - name: work
    description: everyday profile at Chrome's own default directory
    user_data_dir: /Users/faketestoperator/Library/Application Support/Google/Chrome
    profile_directory: Default
    classification: client
    allowed_origins: ['*.acme.com']
    pinned_tier: 2
`,
      'utf8',
    )

    const result = await runSmoke(
      baseSmokeOptions({ configPath, policyPath, profilesPath, home: '/Users/faketestoperator', platform: 'darwin' }),
    )

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('[FAIL] browser-tiers')
    expect(result.report).toContain('PIN FAILURE')
  }, 15000)

  it('reports no profiles configured as a passing, non-blocking state', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    await writeConfig(configPath, UNREACHABLE_DATABASE_URL, UNREACHABLE_REDIS_URL)
    await writePolicy(policyPath)

    const result = await runSmoke(baseSmokeOptions({ configPath, policyPath }))

    expect(result.report).toContain('[PASS] browser-tiers')
    expect(result.report).toContain('no profiles configured yet')
  }, 15000)
})

describe('runSmoke: Slack steps', () => {
  it('reports skipped when no Slack secrets are configured, never touching the network', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    await writeConfig(configPath, UNREACHABLE_DATABASE_URL, UNREACHABLE_REDIS_URL)
    await writePolicy(policyPath)
    let fetchCalled = false

    const result = await runSmoke(
      baseSmokeOptions({
        configPath,
        policyPath,
        secretsFn: () => new EnvSecretProvider({}),
        fetchImpl: (async () => {
          fetchCalled = true
          throw new Error('fetch should never be called with no secret configured')
        }) as unknown as typeof fetch,
      }),
    )

    expect(fetchCalled).toBe(false)
    expect(result.report).toContain('[SKIP] slack-token-valid')
    expect(result.report).toContain('[SKIP] slack-socket-mode')
    expect(result.report).toContain('[SKIP] slack-identity')
  }, 15000)

  it('reports passed when secrets are configured and Slack accepts them', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    await writeConfig(configPath, UNREACHABLE_DATABASE_URL, UNREACHABLE_REDIS_URL)
    await writePolicy(policyPath)

    const fakeFetch = (async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.includes('auth.test')) {
        return new Response(JSON.stringify({ ok: true, user: 'relay', bot_id: 'B1', team: 'T1' }), {
          headers: { 'x-oauth-scopes': 'chat:write,channels:history,users:read' },
        })
      }
      if (href.includes('apps.connections.open')) {
        return new Response(JSON.stringify({ ok: true, url: 'wss://example.test' }))
      }
      throw new Error(`unexpected fetch to ${href}`)
    }) as unknown as typeof fetch

    const result = await runSmoke(
      baseSmokeOptions({
        configPath,
        policyPath,
        fetchImpl: fakeFetch,
        secretsFn: () =>
          new EnvSecretProvider({
            RELAY_SECRET_RELAY_SLACK_BOT_TOKEN: 'xoxb-fake',
            RELAY_SECRET_RELAY_SLACK_APP_TOKEN: 'xapp-fake',
          }),
      }),
    )

    expect(result.report).toContain('[PASS] slack-token-valid')
    expect(result.report).toContain('[PASS] slack-socket-mode')
    expect(result.report).toContain('[PASS] slack-identity')
  }, 15000)
})

describe('runSmoke: every step states what it verified', () => {
  it('includes a verified line for every step, passed or skipped', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    await writeConfig(configPath, UNREACHABLE_DATABASE_URL, UNREACHABLE_REDIS_URL)
    await writePolicy(policyPath)

    const result = await runSmoke(baseSmokeOptions({ configPath, policyPath }))

    const verifiedLines = result.report.split('\n').filter((line) => line.trim().startsWith('verified:'))
    // config, postgres, redis, migrations, 3 slack checks, browser-tiers, agent-run
    expect(verifiedLines.length).toBe(10)
  }, 15000)
})

// ---------------------------------------------------------------------------
// REAL INFRA: the always-on steps against this repo's own docker-compose
// Postgres and Redis. Never exercises agent-run.
// ---------------------------------------------------------------------------

describe('runSmoke: against real infrastructure', () => {
  it('passes postgres, redis, and migrations for real, and never runs agent-run without --run-agent', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    const databaseUrl = await getTestDatabaseUrl()
    await writeConfig(configPath, databaseUrl, 'redis://localhost:6379/8')
    await writePolicy(policyPath)

    const result = await runSmoke({
      configPath,
      policyPath,
      profilesPath: join(dir, 'profiles.yaml'),
      migrationsDir: 'src/db/migrations',
      runAgent: false,
      secretsFn: () => new EnvSecretProvider({}),
    })

    expect(result.report).toContain('[PASS] postgres')
    expect(result.report).toContain('[PASS] redis')
    expect(result.report).toContain('[PASS] migrations')
    expect(result.report).toContain('[SKIP] agent-run')
  }, 30000)
})

describe('runSmoke: a keystore database reference (user decision 7)', () => {
  it('connects through the keystore item database.url names', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    const databaseUrl = await getTestDatabaseUrl()
    await writeConfig(configPath, 'keystore:relay-database-url', 'redis://localhost:6379/8')
    await writePolicy(policyPath)

    const result = await runSmoke(
      baseSmokeOptions({
        configPath,
        policyPath,
        createPoolFn: createPool,
        closePoolFn: closePool,
        secretsFn: () => new EnvSecretProvider({ RELAY_SECRET_RELAY_DATABASE_URL: databaseUrl }),
      }),
    )

    expect(result.report).toContain('[PASS] postgres')
  }, 30000)

  it('fails the config step naming a missing keystore item', async () => {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    await writeConfig(configPath, 'keystore:relay-test-missing-database-url', 'redis://localhost:6379/8')
    await writePolicy(policyPath)

    const result = await runSmoke(baseSmokeOptions({ configPath, policyPath }))

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('relay-test-missing-database-url')
    expect(result.report).toContain('[SKIP] postgres')
  })
})

describe('runSmoke: the tier 2 driver self-test', () => {
  async function runWithSelfTest(
    outcome: Awaited<ReturnType<typeof runTier2SelfTest>>,
  ): Promise<{ report: string; exitCode: number }> {
    const configPath = join(dir, 'relay.config.yaml')
    const policyPath = join(dir, 'policy.yaml')
    await writeConfig(configPath, UNREACHABLE_DATABASE_URL, UNREACHABLE_REDIS_URL)
    await writePolicy(policyPath)
    return runSmoke(baseSmokeOptions({ configPath, policyPath, runTier2SelfTestFn: async () => outcome }))
  }

  it('reports a passing self-test with what it actually verified, not a bare "ok"', async () => {
    const result = await runWithSelfTest({ outcome: 'passed', detail: 'chrome launched and enforcement held' })

    expect(result.report).toContain('[PASS] browser-driver')
    expect(result.report).toContain('chrome launched and enforcement held')
    // The claim must be scoped: a reader has to be able to tell this
    // checked enforcement against a server log, not merely that Chrome ran.
    expect(result.report).toContain("server's own request log")
  }, 15000)

  it('FAILS the smoke run when an off-allowlist request was not actually prevented', async () => {
    // The whole reason this step exists. A machine where scoping silently
    // does not work must not produce a green readiness report.
    const result = await runWithSelfTest({
      outcome: 'failed',
      reason: 'an off-allowlist request REACHED its destination',
    })

    expect(result.report).toContain('[FAIL] browser-driver')
    expect(result.report).toContain('REACHED its destination')
    expect(result.exitCode).toBe(1)
  }, 15000)

  it('skips, without failing, on a machine with no Chrome installed', async () => {
    const skipped = await runWithSelfTest({ outcome: 'skipped', reason: 'no Chrome executable at /nowhere' })
    const passed = await runWithSelfTest({ outcome: 'passed', detail: 'all good' })

    expect(skipped.report).toContain('[SKIP] browser-driver')
    expect(skipped.report).toContain('no Chrome executable')
    expect(skipped.report).not.toContain('[FAIL] browser-driver')
    // An operator who never uses the browser capability does not need
    // Chrome, and a readiness report that fails over an unused optional
    // dependency stops being read. Asserted by comparison rather than
    // against a literal 0, because these runs deliberately point at
    // unreachable dependencies, so the exit code is 1 for reasons that
    // have nothing to do with the browser: what matters is that skipping
    // changes nothing about it.
    expect(skipped.exitCode).toBe(passed.exitCode)
  }, 20000)
})
