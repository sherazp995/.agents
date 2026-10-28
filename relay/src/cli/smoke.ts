/**
 * `relay smoke`, FR-SET-21 and FR-SET-23. `relay init` gets an operator to
 * valid configuration; this proves it actually works, for real, before they
 * find out otherwise from Slack.
 *
 * SEVEN STEPS, each independently reported: config, Postgres, Redis,
 * migrations, three Slack checks (token, Socket Mode, identity), browser
 * tier availability, and, opt-in only, a real agent run. Every step reports
 * one of three states: passed, failed, or skipped, and every step states
 * WHAT it verified in its own words, regardless of outcome, so a passing
 * step never reads as having proven more than it did and a skipped one is
 * never silently dropped from the count.
 *
 * THE ONE STEP THAT MATTERS: agent-run. Every other step is a dependency
 * check; this is the only one that proves the governed loop itself, plan,
 * mediate, execute, persist, actually works end to end. It is judged on
 * TWO independent facts, not one: the run's own reported state, AND a
 * direct read of the `steps` table via runsStore.listSteps for a
 * persisted, succeeded echo step. AgentLoopResult.state alone is not
 * trusted, because a run can legitimately report "succeeded" having
 * called no capability at all (a conversational answer needs none); a
 * smoke test that accepted that as proof the pipeline works would be
 * exactly the failure mode this file exists to avoid: reporting success
 * when what actually happened proves nothing. See evaluateAgentRun.
 *
 * OPT-IN AND CONFINED, DELIBERATELY. The real engine spawns the `claude`
 * binary and costs real money per invocation (src/agent/loop.ts's own
 * header comment), so agent-run only runs behind --run-agent; every other
 * step is safe to run by default and always does. And it never touches
 * Slack: this file calls runAgentLoop directly, never
 * src/orchestrator.ts's handleChatEvent or any dispatcher, so there is no
 * code path from here to a posted message. The workspace, principal, and
 * session it provisions live under platform 'relay-smoke', a value no real
 * chat adapter ever produces, so a smoke run can never collide with, or be
 * mistaken for, a real operator's workspace. See this file's report for
 * why both of these are stated as deliberate choices, not omissions.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Pool } from 'pg'

import { runAgentLoop } from '../agent/loop.js'
import type { AgentLoopResult } from '../agent/loop.js'
import { echo, ECHO_CAPABILITY_NAME } from '../agent/capabilities/echo.js'
import { wrapUntrusted } from '../agent/untrusted.js'
import { registerBuiltinCapabilities } from '../capabilities/wiring.js'
import { ConfigError } from '../config/errors.js'
import { defaultConfigPath, defaultPolicyPath, defaultProfilesPath, resolveMigrationsDirectory } from '../config/paths.js'
import { loadPolicy, loadProfileRegistryIfPresent, loadRelayConfig } from '../config/load.js'
import { resolveOperatorDatabaseUrl } from '../config/database-url.js'
import type { Policy, RelayConfig } from '../config/schema.js'
import { applyMigrations } from '../db/migrate.js'
import { closePool, createPool } from '../db/pool.js'
import { checkPostgres, checkRedisReachable } from '../doctor/checks.js'
import type { CheckResult } from '../doctor/checks.js'
import { checkSlackIdentity, checkSlackSocketMode, checkSlackTokenValid } from '../doctor/checks/slack.js'
import type { CheckContext } from '../doctor/registry.js'
import { createRunContext } from '../obs/context.js'
import { createLogger } from '../obs/logger.js'
import type { Logger } from '../obs/logger.js'
import type { ProfileEntry, ProfileRegistry } from '../profiles/schema.js'
import { reportTierAvailability, validatePin } from '../profiles/tiers.js'
import { runTier2SelfTest } from '../browser/tier2/selftest.js'
import * as runsStore from '../runs/store.js'
import type { Step } from '../runs/store.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { createSecretProvider } from '../secrets/index.js'
import type { SecretProvider } from '../secrets/provider.js'
import { findOrCreateSession } from '../sessions/store.js'
import { provisionPrincipal } from '../tenancy/principals.js'
import { resolveWorkspaceId } from '../tenancy/workspaces.js'

export const DEFAULT_SMOKE_CONFIG_PATH = defaultConfigPath()
export const DEFAULT_SMOKE_POLICY_PATH = defaultPolicyPath()
export const DEFAULT_SMOKE_PROFILES_PATH = defaultProfilesPath()
export const DEFAULT_MIGRATIONS_DIR = resolveMigrationsDirectory()

/** Never a real chat adapter's platform value, so a smoke run's workspace, principal, and session can never collide with, or be mistaken for, a real one. */
const SMOKE_PLATFORM = 'relay-smoke'

export type SmokeStatus = 'passed' | 'failed' | 'skipped'

export type SmokeStepResult = {
  readonly name: string
  readonly status: SmokeStatus
  /** What this step actually checked, in its own words, stated whether it passed, failed, or was skipped. A passing step must never read as having verified more than this says. */
  readonly verified: string
  readonly detail: string
}

const STEP_NAMES = [
  'postgres',
  'redis',
  'migrations',
  'slack-token-valid',
  'slack-socket-mode',
  'slack-identity',
  'browser-tiers',
  'browser-driver',
  'agent-run',
] as const

/**
 * Maps a doctor CheckResult onto this file's own three-state vocabulary.
 * `ok` and `failed` map directly; `degraded` maps to `skipped`, because
 * every degraded outcome these particular checks produce means "not
 * attempted" (no token configured, in every case this file reuses), which
 * is honestly a skip, not a finding. The real reason is always kept in
 * `detail`, so nothing is hidden by the mapping, only relabelled.
 */
function fromCheckResult(name: string, verified: string, check: CheckResult): SmokeStepResult {
  const status: SmokeStatus = check.status === 'ok' ? 'passed' : check.status === 'failed' ? 'failed' : 'skipped'
  const detail = check.remediation ? `${check.detail} (fix: ${check.remediation})` : check.detail
  return { name, status, verified, detail }
}

// ---------------------------------------------------------------------------
// Browser tier availability, FR-PRF-6a. Reporting only, unlike relay init:
// this step's job is to tell the truth about what is configured, not to
// gate anything.
// ---------------------------------------------------------------------------

function describeProfile(profile: ProfileEntry, home: string, platform: NodeJS.Platform): { line: string; pinFailed: boolean } {
  if (profile.classification === 'personal') {
    return { line: `profile "${profile.name}" (personal): excluded from agent use, per FR-PRF-5.`, pinFailed: false }
  }
  const report = reportTierAvailability(profile, home, platform)
  const tierLines = report.tiers
    .map((entry) => `tier ${entry.tier} ${entry.available ? 'available' : 'unavailable'} (${entry.reason})`)
    .join('; ')
  if (profile.pinned_tier === undefined) {
    return { line: `profile "${profile.name}" (${profile.classification}): ${tierLines}.`, pinFailed: false }
  }
  const pin = validatePin(profile, home, platform)
  if (pin.ok) {
    return {
      line: `profile "${profile.name}" (${profile.classification}): ${tierLines}. Pinned to tier ${profile.pinned_tier}, honoured.`,
      pinFailed: false,
    }
  }
  return { line: `profile "${profile.name}" (${profile.classification}): ${tierLines}. PIN FAILURE: ${pin.reason}`, pinFailed: true }
}

/**
 * FR-SET-21's readiness question for the browser, answered by doing it
 * rather than by inspecting configuration: the step above reports which
 * tiers are AVAILABLE for each configured profile, which is a statement
 * about paths and flags. This one launches a real headless Chrome and
 * checks that an off-allowlist request is genuinely prevented. The two
 * answer different questions and a green report needs both.
 *
 * A machine with no Chrome is a skip, not a failure: an operator who never
 * uses the browser capability does not need one, and a readiness report
 * that fails over an unused optional dependency stops being read.
 */
async function stepBrowserDriver(runSelfTest: typeof runTier2SelfTest): Promise<SmokeStepResult> {
  const verified =
    'that a real headless Chrome can be launched and driven on this machine, and that an off-allowlist request ' +
    'from a driven page is actually prevented from leaving the browser (FR-PRF-4), checked against a local ' +
    "server's own request log rather than against the driver's own account of itself"
  const result = await runSelfTest()
  if (result.outcome === 'passed') return { name: 'browser-driver', status: 'passed', verified, detail: result.detail }
  if (result.outcome === 'skipped') {
    return {
      name: 'browser-driver',
      status: 'skipped',
      verified: 'nothing; the tier 2 driver was not exercised',
      detail: result.reason,
    }
  }
  return { name: 'browser-driver', status: 'failed', verified, detail: result.reason }
}

function stepTierAvailability(profilesPath: string, home: string, platform: NodeJS.Platform): SmokeStepResult {
  const verified =
    'which browser tiers (1: extension detection; 2/3: driver-owned enforcement) are genuinely available for ' +
    'each configured profile, and whether any tier pin can actually be honoured'
  let registry: ProfileRegistry
  try {
    registry = loadProfileRegistryIfPresent(profilesPath)
  } catch (error) {
    const detail = error instanceof ConfigError ? error.reason : (error as Error).message
    return { name: 'browser-tiers', status: 'failed', verified, detail: `${profilesPath} could not be read: ${detail}` }
  }
  if (registry.profiles.length === 0) {
    return {
      name: 'browser-tiers',
      status: 'passed',
      verified,
      detail: 'no profiles configured yet. Every browser call is refused with a clear reason (FR-PRF-2), which is a safe state.',
    }
  }
  const described = registry.profiles.map((profile) => describeProfile(profile, home, platform))
  const pinFailed = described.some((entry) => entry.pinFailed)
  return {
    name: 'browser-tiers',
    status: pinFailed ? 'failed' : 'passed',
    verified,
    detail: described.map((entry) => entry.line).join('\n'),
  }
}

// ---------------------------------------------------------------------------
// The agent run, opt-in. See this file's header comment for why it is
// judged on both the run's own state AND an independent read of its
// persisted steps.
// ---------------------------------------------------------------------------

const AGENT_RUN_VERIFIED =
  'a real, governed agent run: planning, policy mediation, executing the echo capability, and persisting a ' +
  'completed run and step, not merely that the engine returned some response'

/**
 * Pure: takes an already-finished AgentLoopResult and an already-read list
 * of that run's persisted steps, and decides pass or fail. No I/O of its
 * own, so this is the one place a test can drive every outcome (succeeded
 * with a real echoed step, succeeded with zero steps, failed, dead
 * lettered) without a real Postgres row or a real engine call anywhere
 * near it.
 *
 * REQUIRES BOTH: `result.state === 'succeeded'` on its own is not accepted,
 * because a run can report succeeded having executed zero capability
 * calls (the plan judged the task conversational and needed none). This
 * function additionally requires a persisted step naming the echo
 * capability in state 'succeeded', read independently from the `steps`
 * table rather than trusted from the run's own summary. See this file's
 * header comment; this is the exact guard the self-attack in this task's
 * report exercises.
 */
export function evaluateAgentRun(result: AgentLoopResult, persistedSteps: readonly Step[], nonce: string): SmokeStepResult {
  if (result.state !== 'succeeded') {
    return {
      name: 'agent-run',
      status: 'failed',
      verified: AGENT_RUN_VERIFIED,
      detail: scrubSecrets(
        `the run ended in state "${result.state}", not succeeded. ${[...result.warnings, ...result.notVerified].join(' ')}`.trim(),
      ),
    }
  }

  const echoStep = persistedSteps.find((step) => step.capability === ECHO_CAPABILITY_NAME && step.state === 'succeeded')
  if (!echoStep) {
    return {
      name: 'agent-run',
      status: 'failed',
      verified: AGENT_RUN_VERIFIED,
      detail:
        'the run reported succeeded, but no persisted step actually invoked and completed the echo capability. ' +
        'A run can report success without ever proving the pipeline executed a capability, so that alone is never accepted as proof.',
    }
  }

  // Compared against the PERSISTED form, not the raw nonce. Step output goes
  // through serializeAndScrub (src/runs/store.ts), which JSON.stringify's the
  // value, so a correctly echoed nonce is stored quoted. The original
  // comparison could therefore never be true, and reported a mismatch on
  // every healthy run: a smoke test accusing the pipeline of a fault that
  // was its own, which is worse than not checking at all because it teaches
  // the operator to discount the check.
  //
  // Both forms are accepted so this keeps working if the storage
  // representation changes, rather than trading one brittle exact match for
  // another.
  const exactEcho = echoStep.output === nonce || echoStep.output === JSON.stringify(nonce)
  return {
    name: 'agent-run',
    status: 'passed',
    verified: AGENT_RUN_VERIFIED,
    detail:
      `run ${result.runId} succeeded with ${result.stepsExecuted} step(s); persisted step ${echoStep.seq} invoked ` +
      `echo and succeeded, ${exactEcho ? 'echoing back the exact nonce sent' : 'though its recorded output did not match the exact nonce sent'}. ` +
      `cost: $${result.costUsd.toFixed(4)}.`,
  }
}

function buildSmokeTask(nonce: string): string {
  return (
    'This is an automated relay smoke test, not a real user request. Call the echo capability exactly once, ' +
    `with input the literal string "${nonce}", then report done. Do not call any other capability.`
  )
}

async function provisionSmokeIdentity(pool: Pool): Promise<{ workspaceId: string; principalId: string; sessionId: string }> {
  const workspaceId = await resolveWorkspaceId(pool, SMOKE_PLATFORM, 'relay-smoke-local')
  const principalId = await provisionPrincipal(pool, workspaceId, SMOKE_PLATFORM, 'relay-smoke-operator', 'relay smoke', ['operator'])
  // A fresh thread_ref every call, via the nonce below, so every smoke run
  // gets its own session rather than resuming a previous smoke run's engine
  // session: each invocation should be judged on its own, not on whatever
  // conversational state a prior smoke run happened to leave behind.
  const session = await findOrCreateSession(pool, {
    workspaceId,
    principalId,
    adapter: SMOKE_PLATFORM,
    threadRef: `smoke-${randomUUID()}`,
  })
  return { workspaceId, principalId, sessionId: session.id }
}

/**
 * The impure half: provisions a throwaway identity, registers the built-in
 * capabilities (idempotent; see src/capabilities/wiring.ts's own comment),
 * runs the real loop with ONLY echo in its capability map (never browser,
 * so this never needs a profile or a driver), reads back the persisted
 * steps, and hands both to evaluateAgentRun. `runAgentLoopFn` defaults to
 * the real runAgentLoop; production never overrides it. Tests override it
 * to exercise runSmoke's own wiring (is this step even attempted, given
 * --run-agent) without spawning a real claude process or spending money;
 * evaluateAgentRun's own tests cover the pass/fail judgement itself
 * directly, with no engine or Postgres involved at all.
 */
export async function runAgentSmokeStep(
  pool: Pool,
  policy: Policy,
  log: Logger,
  runAgentLoopFn: typeof runAgentLoop,
): Promise<SmokeStepResult> {
  registerBuiltinCapabilities()
  const nonce = randomUUID()
  const { workspaceId, principalId, sessionId } = await provisionSmokeIdentity(pool)
  const run = await runsStore.createRun(pool, { workspaceId, sessionId, principalId })
  // stepId has no real step yet at this point; the run's own id stands in
  // as a stable correlation value for this run's log lines, the same
  // placeholder role src/orchestrator.ts's own pre-loop logging needs
  // before the first step exists. Purely a log-correlation id, never
  // persisted as a step.
  const runContext = createRunContext(log, { runId: run.id, sessionId, principalId, stepId: run.id })

  let result: AgentLoopResult
  try {
    result = await runAgentLoopFn({
      ctx: { pool, run, runContext, policy },
      task: wrapUntrusted(buildSmokeTask(nonce)),
      capabilities: { [ECHO_CAPABILITY_NAME]: echo },
      limits: { runTimeoutMs: 180_000, stepTimeoutMs: 90_000 },
    })
  } catch (error) {
    return {
      name: 'agent-run',
      status: 'failed',
      verified: AGENT_RUN_VERIFIED,
      detail: scrubSecrets(`the agent loop threw before returning a result: ${(error as Error).message}`),
    }
  }

  const persistedSteps = await runsStore.listSteps(pool, run.id)
  return evaluateAgentRun(result, persistedSteps, nonce)
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

const STATUS_SYMBOL: Record<SmokeStatus, string> = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' }

function formatSmokeReport(results: readonly SmokeStepResult[], elapsedMs: number): string {
  const passed = results.filter((r) => r.status === 'passed').length
  const failed = results.filter((r) => r.status === 'failed').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const lines = results.map((r) => `[${STATUS_SYMBOL[r.status]}] ${r.name}\n  verified: ${r.verified}\n  ${r.detail}`)
  return scrubSecrets(
    [
      `relay smoke: ${results.length} step(s), ${passed} passed, ${failed} failed, ${skipped} skipped, ${formatElapsed(elapsedMs)}`,
      ...lines,
    ].join('\n\n'),
  )
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type SmokeOptions = {
  configPath: string
  policyPath: string
  profilesPath: string
  migrationsDir: string
  /** FR-SET-21: the one step that costs real money. Never runs unless this is explicitly true. */
  runAgent: boolean
  home?: string
  platform?: NodeJS.Platform
  now?: () => number
  fetchImpl?: typeof fetch
  createPoolFn?: (url: string) => Pool
  closePoolFn?: (pool: Pool) => Promise<void>
  applyMigrationsFn?: (pool: Pool, dir: string, options?: { log?: Logger }) => Promise<string[]>
  runAgentLoopFn?: typeof runAgentLoop
  runAgentSmokeStepFn?: (pool: Pool, policy: Policy, log: Logger, runAgentLoopFn: typeof runAgentLoop) => Promise<SmokeStepResult>
  /** Seam for the tier 2 driver self-test, so a test of this file's own reporting does not have to launch a real Chrome. Production always uses the real one. */
  runTier2SelfTestFn?: typeof runTier2SelfTest
  secretsFn?: (config: RelayConfig) => SecretProvider
}

export type SmokeResult = { report: string; exitCode: number }

/**
 * Runs every step once and returns the report and exit code, exactly the
 * same shape runInit uses, so the CLI action and a test both call this the
 * same way. Exit code is 1 only when some step that actually ran reported
 * `failed`; a `skipped` step never fails the run on its own, matching
 * FR-SET-21's own framing that a smoke test names what did not run rather
 * than treating "not installed yet" as a failure.
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const createPoolFn = options.createPoolFn ?? createPool
  const closePoolFn = options.closePoolFn ?? closePool
  const applyMigrationsFn = options.applyMigrationsFn ?? applyMigrations
  const runAgentLoopFn = options.runAgentLoopFn ?? runAgentLoop
  const runAgentSmokeStepFn = options.runAgentSmokeStepFn ?? runAgentSmokeStep
  const runTier2SelfTestFn = options.runTier2SelfTestFn ?? runTier2SelfTest
  const secretsFn = options.secretsFn ?? createSecretProvider
  const fetchImpl = options.fetchImpl ?? fetch

  let config: RelayConfig
  let policy: Policy
  let databaseUrl: string
  try {
    config = loadRelayConfig(options.configPath)
    policy = loadPolicy(options.policyPath)
    databaseUrl = await resolveOperatorDatabaseUrl(config, secretsFn(config))
  } catch (error) {
    const detail = error instanceof ConfigError ? `${error.filePath}: ${error.reason}` : (error as Error).message
    // Per this file's header comment: every step is still named, as
    // skipped, rather than silently absent from the report, the same
    // discipline runDoctor's own config-invalid branch already follows.
    const skipped: SmokeStepResult[] = STEP_NAMES.map((name) => ({
      name,
      status: 'skipped',
      verified: 'nothing; configuration could not be loaded',
      detail: 'not attempted because configuration is invalid',
    }))
    const results: SmokeStepResult[] = [
      { name: 'config', status: 'failed', verified: 'that config and policy load and validate', detail },
      ...skipped,
    ]
    return { report: formatSmokeReport(results, now() - startedAt), exitCode: 1 }
  }

  const log = createLogger(config.logging.level)
  const results: SmokeStepResult[] = [
    { name: 'config', status: 'passed', verified: 'that config and policy load and validate', detail: `${options.configPath}, ${options.policyPath}` },
  ]

  const pool = createPoolFn(databaseUrl)
  try {
    const postgresResult = fromCheckResult(
      'postgres',
      'that the configured Postgres is reachable via SELECT 1',
      await checkPostgres(databaseUrl),
    )
    results.push(postgresResult)

    results.push(
      fromCheckResult('redis', 'that the configured Redis is reachable via PING', await checkRedisReachable(config.redis.url)),
    )

    if (postgresResult.status !== 'passed') {
      results.push({
        name: 'migrations',
        status: 'skipped',
        verified: 'that every pending migration applies cleanly',
        detail: 'Postgres was not reachable, so migrations were not attempted',
      })
    } else {
      try {
        const applied = await applyMigrationsFn(pool, options.migrationsDir, { log })
        results.push({
          name: 'migrations',
          status: 'passed',
          verified: 'that every pending migration applies cleanly',
          detail: applied.length > 0 ? `applied ${applied.length} migration(s): ${applied.join(', ')}` : 'schema already current; nothing pending',
        })
      } catch (error) {
        results.push({
          name: 'migrations',
          status: 'failed',
          verified: 'that every pending migration applies cleanly',
          detail: (error as Error).message,
        })
      }
    }

    const secrets = secretsFn(config)
    const ctx: CheckContext = { config, policy, secrets, log }
    results.push(
      fromCheckResult(
        'slack-token-valid',
        "that the configured Slack bot token is accepted by Slack's own auth.test",
        await checkSlackTokenValid(fetchImpl).run(ctx),
      ),
    )
    results.push(
      fromCheckResult(
        'slack-socket-mode',
        'that a Socket Mode connection can actually be opened with the configured app-level token',
        await checkSlackSocketMode(fetchImpl).run(ctx),
      ),
    )
    results.push(
      fromCheckResult(
        'slack-identity',
        "that the bot's own identity can be confirmed via auth.test",
        await checkSlackIdentity(fetchImpl).run(ctx),
      ),
    )

    results.push(stepTierAvailability(options.profilesPath, home, platform))
    results.push(await stepBrowserDriver(runTier2SelfTestFn))

    if (!options.runAgent) {
      results.push({
        name: 'agent-run',
        status: 'skipped',
        verified: 'nothing; the real agent run was not requested',
        detail:
          'not run. Pass --run-agent to exercise the real pipeline end to end. The engine spawns the claude ' +
          'CLI and costs real money per invocation, so this never runs unless explicitly asked for.',
      })
    } else if (postgresResult.status !== 'passed') {
      results.push({
        name: 'agent-run',
        status: 'skipped',
        verified: 'nothing; the real agent run needs a reachable Postgres to persist its run and steps',
        detail: 'Postgres was not reachable, so the agent run was not attempted',
      })
    } else {
      results.push(await runAgentSmokeStepFn(pool, policy, log, runAgentLoopFn))
    }
  } finally {
    await closePoolFn(pool)
  }

  const exitCode = results.some((r) => r.status === 'failed') ? 1 : 0
  return { report: formatSmokeReport(results, now() - startedAt), exitCode }
}
