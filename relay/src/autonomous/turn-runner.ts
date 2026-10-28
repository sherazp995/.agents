/**
 * One worker turn end to end: choose an account, open a run, admit the
 * invocation against the budget, issue the hook token, spawn behind the
 * start gate, settle the charge once, and fall through to the next account
 * when one is blocked (usage limit, rate limit, login, missing CLI). The
 * fallback is announced in the thread.
 *
 * How the CLI is configured for relay's guard (settings and hook, MCP
 * gateway config, codex overrides, egress proxy) is injected as `spawnPlan`,
 * so this file holds the account and budget rules only.
 */

import { realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Pool } from 'pg'
import type { BudgetCaps } from '../budget/meter.js'
import { createRun, finishRun, startRun } from '../runs/store.js'
import { chooseAccount, COOLDOWN_MS, orderForPreference, type Account, type AccountClient, type CooldownStore } from './accounts.js'
import { admitInvocation, listUnsettledInvocations, settleInvocation, type InvocationPurpose } from './invocations.js'
import type { InvocationContext } from './mcp-protocol.js'
import type { TurnRequestContext, TurnResult } from './scheduler.js'
import { runWorkerTurn, type TurnOutcome, type TurnRequest } from './worker.js'
import { QA_REPLY_JSON_SCHEMA, type QaInvocationResult, type QaPurpose } from './completion.js'
import type { ParsedReply } from './reply.js'

/** codex's own default home, used when the chosen codex account is the default login. */
export const DEFAULT_CODEX_HOME = join(homedir(), '.codex')

/** What the CLI needs for one spawn on one account: binary, args, env, cwd. Built per account and per invocation token. */
export type SpawnPlan = Pick<TurnRequest, 'bin' | 'args' | 'cwd' | 'env' | 'allowedMcpServers'> & {
  /** Cleanup after the turn (temp files, the per-task proxy stays). */
  dispose?: () => Promise<void>
}

export type SpawnPlanParams = {
  context: TurnRequestContext
  account: Account
  hookToken: string
  resume: string | undefined
  reservedUsd: number
  /** QA invocations: their own checkout, structured output schema and CODEX_HOME. */
  qa?: { cwd: string; schemaJson: string; extraEnv: Record<string, string> }
}

export type TurnRunnerDeps = {
  pool: Pool
  readAccounts: () => Promise<Account[]>
  cooldowns: CooldownStore
  isCodexEligible: (account: Account) => Promise<boolean>
  caps: () => Promise<BudgetCaps>
  fallbackUsd: number
  codexUsdPerMtok: number
  turnTimeoutMs: number
  issueToken: (context: InvocationContext) => string
  revokeToken: (token: string) => void
  spawnPlan: (params: SpawnPlanParams) => Promise<SpawnPlan>
  /** Injected for tests; production runs the real CLI. */
  runTurn?: (request: TurnRequest) => Promise<TurnOutcome>
}

/** Resume only on the account (client and login) that owns the session; any other account starts a fresh session. */
function resumeFor(context: TurnRequestContext, account: Account): string | undefined {
  const { engineSessionId, accountKey } = context.task
  return engineSessionId !== null && accountKey === account.key ? engineSessionId : undefined
}

function preferenceOf(value: string | null): AccountClient | null {
  return value === 'claude' || value === 'codex' ? value : null
}

export async function runTurnOnPool(deps: TurnRunnerDeps, context: TurnRequestContext): Promise<TurnResult> {
  const { task } = context
  const pool = await deps.readAccounts()
  // The account holding the session goes first, so a resume stays possible.
  const ordered = orderForPreference(pool, preferenceOf(task.agentPreference))
  const owner = ordered.find((account) => account.key === task.accountKey)
  const accounts = owner ? [owner, ...ordered.filter((account) => account !== owner)] : ordered
  const notes: string[] = []
  const tried: string[] = []

  for (;;) {
    const choice = await chooseAccount(accounts, { cooldowns: deps.cooldowns, isCodexEligible: deps.isCodexEligible, exclude: tried })
    if (choice.kind === 'none') {
      const when = choice.wakeAtMs === null ? 'no account is usable' : `the next account frees up at ${new Date(choice.wakeAtMs).toISOString()}`
      return { kind: 'no_account', wakeAtMs: choice.wakeAtMs, reason: `Every agent account is cooling down or unavailable; ${when}. I will continue then.` }
    }
    const account = choice.account
    tried.push(account.key)
    if (task.accountKey !== null && task.accountKey !== account.key && tried.length === 1) {
      notes.push(`Continuing on ${account.key} (${account.client}); ${task.accountKey} is not available, so this starts a fresh session with the thread so far.`)
    }

    const result = await invokeOnce(deps, context, account, { purpose: 'worker', nestedAllowanceUsd: 0 })
    if (result.kind === 'refused') return result
    if (result.outcome.kind === 'account_blocked') {
      await deps.cooldowns.coolDown(account.key, Date.now() + COOLDOWN_MS[result.outcome.reason])
      notes.push(`${account.key} is blocked (${result.outcome.reason.replace('_', ' ')}); trying the next account.`)
      continue
    }
    return { kind: 'outcome', outcome: result.outcome, accountKey: account.key, runId: result.runId, notes }
  }
}

type InvokeResult = { kind: 'outcome'; outcome: TurnOutcome; runId: string } | { kind: 'refused'; reason: string }

type InvokeOptions = {
  purpose: InvocationPurpose
  nestedAllowanceUsd: number
  qa?: SpawnPlanParams['qa']
  parseReply?: TurnRequest['parseReply']
}

/** One admitted, charged invocation on one account. */
async function invokeOnce(deps: TurnRunnerDeps, context: TurnRequestContext, account: Account, options: InvokeOptions): Promise<InvokeResult> {
  const purpose = options.purpose
  const { task } = context
  const run = await createRun(deps.pool, { workspaceId: task.workspaceId, sessionId: task.sessionId, principalId: task.requesterPrincipalId })
  const caps = await deps.caps()
  const admission = await admitInvocation(deps.pool, {
    workspaceId: task.workspaceId,
    taskId: task.id,
    accountKey: account.key,
    purpose,
    runId: run.id,
    sessionId: task.sessionId,
    principalId: task.requesterPrincipalId,
    fallbackUsd: deps.fallbackUsd,
    nestedAllowanceUsd: options.nestedAllowanceUsd,
    caps,
  })
  if (!admission.admitted) {
    await finishRun(deps.pool, run.id, 'cancel').catch(() => undefined)
    return { kind: 'refused', reason: `the ${admission.scope.replace('_', '-')} budget has $${admission.headroomUsd.toFixed(2)} left, and a turn needs $${admission.neededUsd.toFixed(2)}` }
  }

  // The nested lens is charged as its allowance, not metered: the CLI's own budget is the rest.
  const ownBudgetUsd = admission.reservedUsd - options.nestedAllowanceUsd
  if (ownBudgetUsd <= 0) {
    await settleInvocation(deps.pool, admission.invocationId, 0, caps)
    await finishRun(deps.pool, run.id, 'cancel').catch(() => undefined)
    return { kind: 'refused', reason: `the reservation ($${admission.reservedUsd.toFixed(2)}) leaves nothing for the CLI after the $${options.nestedAllowanceUsd.toFixed(2)} lens allowance` }
  }
  const token = deps.issueToken({ workspaceId: task.workspaceId, taskId: task.id, invocationId: admission.invocationId, leaseGeneration: context.lease.generation })
  let outcome: TurnOutcome
  let plan: SpawnPlan | undefined
  try {
    await startRun(deps.pool, run.id)
    const resume = options.qa ? undefined : resumeFor(context, account)
    // A turn that cannot resume starts a fresh session, which needs the thread so far.
    const fresh = resume === undefined && !options.qa && context.freshPrompt ? { ...context, prompt: await context.freshPrompt() } : context
    plan = await deps.spawnPlan({
      context: fresh,
      account,
      hookToken: token,
      resume,
      reservedUsd: ownBudgetUsd,
      ...(options.qa ? { qa: options.qa } : {}),
    })
    outcome = await (deps.runTurn ?? runWorkerTurn)({
      account,
      bin: plan.bin,
      args: plan.args,
      cwd: plan.cwd,
      env: plan.env,
      timeoutMs: deps.turnTimeoutMs,
      signal: context.signal,
      recordWorker: context.recordWorker,
      allowedMcpServers: plan.allowedMcpServers,
      reservedUsd: ownBudgetUsd,
      codexUsdPerMtok: deps.codexUsdPerMtok,
      ...(options.parseReply ? { parseReply: options.parseReply } : {}),
    })
  } catch (error) {
    // A spawn that threw may still have spent money: charge the fallback once and close the run.
    await settleInvocation(deps.pool, admission.invocationId, deps.fallbackUsd, caps).catch(() => undefined)
    await finishRun(deps.pool, run.id, 'fail').catch(() => undefined)
    throw error
  } finally {
    deps.revokeToken(token)
    await plan?.dispose?.()
  }

  // Charged once: the reported cost, or the fallback when the turn's cost is unknown.
  const cost = costOf(outcome)
  await settleInvocation(deps.pool, admission.invocationId, cost ?? deps.fallbackUsd, caps)
  const runOutcome = outcome.kind === 'reply' ? 'succeed' : outcome.kind === 'stopped' || outcome.kind === 'not_started' ? 'cancel' : 'fail'
  await finishRun(deps.pool, run.id, runOutcome, cost !== null ? { costUsd: cost } : {}).catch(() => undefined)
  return { kind: 'outcome', outcome, runId: run.id }
}

function costOf(outcome: TurnOutcome): number | null {
  switch (outcome.kind) {
    case 'reply':
    case 'schema_invalid':
    case 'failed':
      return outcome.costUsd
    case 'over_budget':
      return outcome.costUsd
    case 'not_started':
      return 0
    default:
      return null
  }
}

/** A QA invocation's structured output: the path of the report relay reads itself. */
function parseQaReport(value: unknown): ParsedReply {
  const reportPath = typeof value === 'object' && value !== null ? (value as { report_path?: unknown }).report_path : undefined
  if (typeof reportPath !== 'string' || reportPath.trim() === '') return { ok: false, error: 'report_path: Required' }
  return { ok: true, reply: { status: 'done', text: reportPath } }
}

/**
 * Review and QA invocations: always a claude account, because general-review
 * on a Codex host starts a Claude workflow outside the pool. The review and
 * visual QA runs start a nested `codex exec`, so they get CODEX_HOME for the
 * first eligible, free codex account and reserve the lens allowance.
 */
export async function runQaOnPool(
  deps: TurnRunnerDeps & { lensAllowanceUsd: number },
  context: TurnRequestContext,
  params: { purpose: QaPurpose; cwd: string },
): Promise<QaInvocationResult> {
  const pool = await deps.readAccounts()
  const nested = params.purpose !== 'video_qa'
  const extraEnv: Record<string, string> = {}
  if (nested) {
    const codex = await chooseAccount(
      pool.filter((account) => account.client === 'codex'),
      { cooldowns: deps.cooldowns, isCodexEligible: deps.isCodexEligible },
    )
    if (codex.kind === 'none') return { kind: 'blocked', reason: `no eligible codex account is free for the ${params.purpose.replace('_', ' ')} Codex lens` }
    extraEnv.CODEX_HOME = codex.account.configDir ?? DEFAULT_CODEX_HOME
  }
  const claude = pool.filter((account) => account.client === 'claude')
  const tried: string[] = []
  for (;;) {
    const choice = await chooseAccount(claude, { cooldowns: deps.cooldowns, isCodexEligible: deps.isCodexEligible, exclude: tried })
    if (choice.kind === 'none') return { kind: 'blocked', reason: `no claude account is free for the ${params.purpose.replace('_', ' ')} invocation` }
    tried.push(choice.account.key)
    const result = await invokeOnce(deps, context, choice.account, {
      purpose: params.purpose,
      nestedAllowanceUsd: nested ? deps.lensAllowanceUsd : 0,
      qa: { cwd: params.cwd, schemaJson: JSON.stringify(QA_REPLY_JSON_SCHEMA), extraEnv },
      parseReply: parseQaReport,
    })
    if (result.kind === 'refused') return { kind: 'blocked', reason: result.reason }
    const outcome = result.outcome
    if (outcome.kind === 'account_blocked') {
      await deps.cooldowns.coolDown(choice.account.key, Date.now() + COOLDOWN_MS[outcome.reason])
      continue
    }
    if (outcome.kind === 'reply') {
      const reportPath = await confinedReportPath(params.cwd, outcome.reply.text)
      if (reportPath === null) return { kind: 'failed', reason: `the QA report path ${outcome.reply.text} is outside the QA checkout, ~/.agents and the temp folder` }
      return { kind: 'report', reportPath }
    }
    return { kind: 'failed', reason: outcome.kind === 'failed' ? outcome.reason : outcome.kind.replace('_', ' ') }
  }
}

/**
 * Relay reads a QA report only from where the QA skills write one: the QA
 * checkout, ~/.agents (review ledgers, report folders) or the temp folder.
 * Symlinks are resolved first, so a link cannot point relay at another file.
 */
async function confinedReportPath(cwd: string, named: string): Promise<string | null> {
  let real: string
  try {
    real = await realpath(resolve(cwd, named))
  } catch {
    return resolve(cwd, named)
  }
  const roots = await Promise.all([cwd, join(homedir(), '.agents'), tmpdir()].map((root) => realpath(root).catch(() => resolve(root))))
  return roots.some((root) => real.startsWith(`${root}${sep}`)) ? real : null
}

/** Startup: every invocation a crash left uncharged is charged its fallback (plus its allowance) once. */
export async function settleCrashedInvocations(pool: Pool, workspaceId: string, caps: BudgetCaps): Promise<number> {
  const unsettled = await listUnsettledInvocations(pool, workspaceId)
  for (const invocation of unsettled) await settleInvocation(pool, invocation.id, invocation.fallbackUsd, caps)
  return unsettled.length
}
