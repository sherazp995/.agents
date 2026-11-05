/**
 * One chat turn end to end: choose an account, open a run, issue the hook
 * token, spawn behind the start gate, and fall through to the next account
 * when one is blocked (usage limit, rate limit, login, missing CLI).
 *
 * How the CLI is configured (hook settings, codex overrides, folder) is
 * injected as `spawnPlan`, so this file holds the account rules only.
 */

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { InvocationContext } from '../engine/hook-bridge.js'
import { createRun, finishRun, startRun } from '../runs/store.js'
import { chooseAccount, COOLDOWN_MS, orderForSubject, type Account, type AccountClient, type CooldownStore } from './accounts.js'
import type { TurnRequestContext, TurnResult } from './scheduler.js'
import { runWorkerTurn, type TurnOutcome, type TurnRequest } from './worker.js'

/** codex's own default home, used when the chosen codex account is the default login. */
export const DEFAULT_CODEX_HOME = join(homedir(), '.codex')

/** What the CLI needs for one spawn on one account: binary, args, env, cwd. Built per account and per invocation token. */
export type SpawnPlan = Pick<TurnRequest, 'bin' | 'args' | 'cwd' | 'env' | 'input'> & {
  /** Cleanup after the turn (temp files, the per-task proxy stays). */
  dispose?: () => Promise<void>
}

/**
 * Whose turn this is: the session, login and client binding it uses, and
 * what its CLI is started with. A task is one subject (taskSubject); a team
 * member's assignment is another, with its own session, login and lease.
 */
export type TurnSubject = {
  engineSessionId: string | null
  accountKey: string | null
  /** The Claude Code chat a task took over; a member has none. */
  chatSessionId: string | null
  /** A client asked for in the thread: its logins go first, the others after. */
  preference: AccountClient | null
  /** Only this client's logins are used; when all are out, the turn waits. */
  client: AccountClient | null
  model: string | null
  /** The folder the CLI runs in; null for the task's own. */
  cwd: string | null
  /** The appended system prompt; null for the thread agent's brief. */
  brief: string | null
  /** Starts the CLI with no MCP servers. */
  noMcp: boolean
  /** A member's assignment, carried in its hook token. */
  assignment?: { id: string; leaseGeneration: number }
}

/** Today's single agent: the task's own session and login, any client, its own folder and brief. */
export function taskSubject(task: TurnRequestContext['task']): TurnSubject {
  return {
    engineSessionId: task.engineSessionId,
    accountKey: task.accountKey,
    chatSessionId: task.chatSessionId,
    preference: preferenceOf(task.agentPreference),
    client: null,
    model: null,
    cwd: null,
    brief: null,
    noMcp: false,
  }
}

export type SpawnPlanParams = {
  context: TurnRequestContext
  subject: TurnSubject
  account: Account
  hookToken: string
  resume: string | undefined
}

export type TurnRunnerDeps = {
  pool: Pool
  readAccounts: () => Promise<Account[]>
  cooldowns: CooldownStore
  isCodexEligible: (account: Account) => Promise<boolean>
  turnTimeoutMs: number
  issueToken: (context: InvocationContext) => string
  revokeToken: (token: string) => void
  spawnPlan: (params: SpawnPlanParams) => Promise<SpawnPlan>
  /** Injected for tests; production runs the real CLI. */
  runTurn?: (request: TurnRequest) => Promise<TurnOutcome>
  /** Injected for tests; production reads the account's real projects folder. */
  projectsDir?: (account: Account) => Promise<string | null>
}

/** The default Claude login, whose projects folder holds a chat relay took over. */
const DEFAULT_CLAUDE: Account = { key: 'claude', client: 'claude', configDir: null, env: {} }

/** The real folder a Claude login keeps its chats in; logins that share it can resume each other's chats. */
async function claudeProjects(account: Account): Promise<string | null> {
  if (account.client !== 'claude') return null
  return realpath(join(account.configDir ?? join(homedir(), '.claude'), 'projects')).catch(() => null)
}

/** Resumes on the account that owns the session, or on any Claude login sharing its projects folder; anything else starts fresh. */
async function resumeFor(deps: TurnRunnerDeps, subject: TurnSubject, account: Account): Promise<string | undefined> {
  const { engineSessionId, accountKey, chatSessionId } = subject
  if (engineSessionId === null) return undefined
  if (accountKey === account.key) return engineSessionId
  const projectsDir = deps.projectsDir ?? claudeProjects
  const mine = await projectsDir(account)
  if (mine === null) return undefined
  // A taken-over chat has no owning account until its first turn here.
  const owner = accountKey === null ? (engineSessionId === chatSessionId ? DEFAULT_CLAUDE : undefined) : (await deps.readAccounts()).find((candidate) => candidate.key === accountKey)
  if (owner !== undefined && (await projectsDir(owner)) === mine) return engineSessionId
  // After a codex turn, Claude goes back to the taken-over chat. A rejected resume clears engineSessionId, so this never retries it.
  if (chatSessionId !== null && (await projectsDir(DEFAULT_CLAUDE)) === mine) return chatSessionId
  return undefined
}

function preferenceOf(value: string | null): AccountClient | null {
  return value === 'claude' || value === 'codex' ? value : null
}

export async function runTurnOnPool(deps: TurnRunnerDeps, context: TurnRequestContext): Promise<TurnResult> {
  const subject = context.subject ?? taskSubject(context.task)
  const pool = await deps.readAccounts()
  // The account holding the session goes first, so a resume stays possible.
  const ordered = orderForSubject(pool, subject)
  const owner = ordered.find((account) => account.key === subject.accountKey)
  const accounts = owner ? [owner, ...ordered.filter((account) => account !== owner)] : ordered
  const notes: string[] = []
  const tried: string[] = []

  for (;;) {
    const choice = await chooseAccount(accounts, { cooldowns: deps.cooldowns, isCodexEligible: deps.isCodexEligible, exclude: tried })
    if (choice.kind === 'none') {
      const when = choice.wakeAtMs === null ? 'no account is usable' : `the next account frees up at ${new Date(choice.wakeAtMs).toISOString()}`
      const which = subject.client === null ? 'agent account' : `${subject.client} login`
      return { kind: 'no_account', wakeAtMs: choice.wakeAtMs, reason: `Every ${which} is cooling down or unavailable; ${when}. I will continue then.` }
    }
    const account = choice.account
    tried.push(account.key)
    if (subject.accountKey !== null && subject.accountKey !== account.key && tried.length === 1) {
      notes.push(`Continuing on ${account.key} (${account.client}); ${subject.accountKey} is not available.`)
    }

    const result = await invokeOnce(deps, withSentSoFar(context), subject, account)
    if (result.outcome.kind === 'account_blocked') {
      await deps.cooldowns.coolDown(account.key, Date.now() + COOLDOWN_MS[result.outcome.reason])
      notes.push(`${account.key} is blocked (${result.outcome.reason.replace('_', ' ')}); trying the next account.`)
      continue
    }
    return { kind: 'outcome', outcome: result.outcome, accountKey: account.key, runId: result.runId, notes }
  }
}

/** A fallback account repeats what an earlier attempt was sent mid-turn, so those messages are not lost with it. */
function withSentSoFar(context: TurnRequestContext): TurnRequestContext {
  const sent = context.sentSoFar?.() ?? ''
  if (sent === '') return context
  const freshPrompt = context.freshPrompt
  return { ...context, prompt: `${context.prompt}\n\n${sent}`, ...(freshPrompt ? { freshPrompt: async () => `${await freshPrompt()}\n\n${sent}` } : {}) }
}

type InvokeResult = { outcome: TurnOutcome; runId: string }

/** One turn on one account, recorded as a run. */
async function invokeOnce(deps: TurnRunnerDeps, context: TurnRequestContext, subject: TurnSubject, account: Account): Promise<InvokeResult> {
  const { task } = context
  const run = await createRun(deps.pool, { workspaceId: task.workspaceId, sessionId: task.sessionId, principalId: task.requesterPrincipalId })
  const token = deps.issueToken({
    workspaceId: task.workspaceId,
    taskId: task.id,
    runId: run.id,
    leaseGeneration: context.lease.generation,
    ...(subject.assignment ? { assignment: { ...subject.assignment } } : {}),
  })
  let outcome: TurnOutcome
  let plan: SpawnPlan | undefined
  try {
    await startRun(deps.pool, run.id)
    const resume = await resumeFor(deps, subject, account)
    // A turn that cannot resume its own session needs the thread so far: a fresh session, or the taken-over chat after another session's turns.
    const fresh = resume !== subject.engineSessionId && context.freshPrompt ? { ...context, prompt: await context.freshPrompt() } : context
    plan = await deps.spawnPlan({ context: fresh, subject, account, hookToken: token, resume })
    outcome = await (deps.runTurn ?? runWorkerTurn)({
      account,
      bin: plan.bin,
      args: plan.args,
      cwd: plan.cwd,
      env: plan.env,
      ...(plan.input !== undefined ? { input: plan.input } : {}),
      ...(context.inbox ? { inbox: context.inbox } : {}),
      timeoutMs: deps.turnTimeoutMs,
      signal: context.signal,
      recordWorker: context.recordWorker,
    })
  } catch (error) {
    await finishRun(deps.pool, run.id, 'fail').catch(() => undefined)
    throw error
  } finally {
    deps.revokeToken(token)
    await plan?.dispose?.()
  }
  const runOutcome = outcome.kind === 'reply' ? 'succeed' : outcome.kind === 'stopped' || outcome.kind === 'not_started' ? 'cancel' : 'fail'
  await finishRun(deps.pool, run.id, runOutcome).catch(() => undefined)
  return { outcome, runId: run.id }
}
