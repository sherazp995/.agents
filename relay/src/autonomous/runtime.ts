/**
 * Autonomous mode inside the daemon: the hook bridge and guard, the
 * scheduler and every effect it runs, composed from the pieces in this
 * folder. startOrchestrator starts it when `autonomous.enabled` and hands
 * the orchestrator its routing.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import type { ResolveApprovalResult } from '../approvals/store.js'
import type { ChatAction, ChatEvent, ChatRef } from '../chat/contract.js'
import { SLACK_BOT_TOKEN_SECRET } from '../chat/slack/adapter.js'
import type { Policy, RelayConfig } from '../config/schema.js'
import { loadRepoRegistryIfPresent } from '../config/load.js'
import type { OutboundDispatcher } from '../dispatch/outbound.js'
import { HookBridgeServer } from '../engine/hook-bridge.js'
import type { KillSwitch } from '../killswitch.js'
import type { Logger } from '../obs/logger.js'
import { closeRedis, type Redis } from '../redis/client.js'
import { codexVersion, isProvenEligible, readCodexEligibility } from './codex-probe.js'
import type { SecretProvider } from '../secrets/provider.js'
import { readAccountPool, RedisCooldownStore, type Account } from './accounts.js'
import { verifyCompletion, buildQaPrompt, type CompletionDeps, type Snapshot } from './completion.js'
import { extensionTokenKey, EXTENSION_TOKEN_VAR, type TaskSecretStore } from './extension-grant.js'
import { createAutonomousGuard, currentInvocationLookup, killSwitchCheck } from './guard.js'
import { buildCodexMcpOverrides, buildWorkerMcpSet, readMcpServers, writeClaudeMcpConfig } from './mcp-config.js'
import { startEgressProxy, type EgressProxy } from './egress-proxy.js'
import { cancelTaskWork, requestTaskRemoteWrite, settleTaskOperations } from './operation-effects.js'
import { createMcpOperations, threadChatRef } from './operations.js'
import { renderThreadHistory, slackThreadReplies } from './thread-history.js'
import { postPlanForApproval, settlePlanApproval, sweepExpiredApprovals, type PlanApprovalDeps } from './plan-approval.js'
import { WORKER_BRIEF } from './prompt.js'
import { canonicalRepoUrl, reconcileDispatching, type RemoteWriteDeps } from './remote-write.js'
import { REPLY_JSON_SCHEMA } from './reply.js'
import { routeAutonomousEvent } from './router.js'
import { createScheduler, stopAutonomousTask, type Scheduler, type TurnRequestContext } from './scheduler.js'
import { loadTask, loadTaskBySession, recordWorker, registerQaCheckout, wakeTask, type AutonomousTask, type Lease } from './store.js'
import { boundRepo, bindPlan, downloadTaskFiles, finishTask, prepareTaskWorktree } from './task-effects.js'
import { runQaOnPool, runTurnOnPool, settleCrashedInvocations, type SpawnPlan, type SpawnPlanParams, type TurnRunnerDeps } from './turn-runner.js'
import { recordVerification } from './verifications.js'
import { buildClaudeSettings, buildCodexHookOverrides } from './worker-config.js'
import { buildClaudeArgs, buildCodexArgs, buildWorkerEnv, renderWorkerGitConfig } from './worker.js'
import type { AutonomousRouting } from '../orchestrator.js'

const execFileAsync = promisify(execFile)

export type AutonomousConfig = NonNullable<RelayConfig['autonomous']>

/** Secret names the runtime reads from relay's keystore. */
export const READ_ONLY_GITHUB_TOKEN_SECRET = 'relay-github-read-token'
export const WRITE_GITHUB_TOKEN_SECRET = 'relay-github-write-token'

export type AutonomousRuntimeOptions = {
  pool: Pool
  workspaceId: string
  dispatcher: OutboundDispatcher
  log: Logger
  config: AutonomousConfig
  policy: Policy
  killSwitch: KillSwitch
  redis: Redis
  relayHome: string
  receiptKey: Uint8Array
  secrets: SecretProvider
  repoRegistryPath: string
  /** The built relay root, holding dist/scripts/hook-pretooluse.js and mcp-gateway.js. */
  distRoot: string
  /** The operator's git identity for the worker's commits. */
  gitIdentity: { name: string; email: string }
}

export type AutonomousRuntime = {
  routing: AutonomousRouting
  onApprovalResolved(result: ResolveApprovalResult): Promise<void>
  stop(): Promise<void>
}

/**
 * Per-task extension tokens, held in daemon memory only: never written to
 * disk or the database. A daemon restart drops them, and the next spawn
 * runs without the extension until the requester sends a token again.
 */
export function memoryTaskSecrets(): TaskSecretStore {
  const values = new Map<string, string>()
  return {
    get: async (name) => values.get(name),
    set: async (name, value) => {
      values.set(name, value)
    },
    delete: async (name) => {
      values.delete(name)
    },
  }
}

export async function startAutonomousRuntime(options: AutonomousRuntimeOptions): Promise<AutonomousRuntime> {
  const { pool, workspaceId, dispatcher, log, config, relayHome } = options
  const installedCodexVersion = codexVersion(config.codex_bin).catch(() => 'unknown')
  const taskSecrets = memoryTaskSecrets()
  const registry = () => loadRepoRegistryIfPresent(options.repoRegistryPath)
  const taskDir = (taskId: string): string => join(relayHome, 'tasks', taskId)
  const caps = async () => {
    const budget = options.policy.budget
    if (!budget) throw new Error('autonomous mode needs a budget section in the policy')
    return { runCapUsd: budget.run_cap_usd, sessionCapUsd: budget.session_cap_usd, principalDayCapUsd: budget.principal_day_cap_usd }
  }
  const post = async (action: ChatAction): Promise<void> => {
    await dispatcher.perform(action)
  }
  const isOperator = async (principalId: string): Promise<boolean> => {
    const { rows } = await pool.query<{ roles: string[] }>('SELECT roles FROM principals WHERE id = $1', [principalId])
    return rows[0]?.roles.includes('operator') ?? false
  }
  const threadOf = async (task: AutonomousTask): Promise<{ reply: ChatRef; mention: Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef }> => {
    const { rows } = await pool.query<{ thread_ref: string; first_event: string | null }>(
      `SELECT s.thread_ref, t.seen_event_ids[1] AS first_event
       FROM sessions s JOIN autonomous_tasks t ON t.session_id = s.id WHERE s.id = $1`,
      [task.sessionId],
    )
    const { channel, thread } = threadChatRef(rows[0]?.thread_ref ?? '')
    // ✅/❌ go on the message that started the task (its event id is `<channel>:<ts>`), not on the thread root,
    // which can be someone else's message or relay's own notify DM.
    const firstTs = rows[0]?.first_event?.split(':').at(-1)
    return { reply: { channel, thread }, mention: { channel, message: firstTs || thread } }
  }

  // --- operations and the guard ----------------------------------------------
  const operationDeps = { outbox: dispatcher, receiptKey: options.receiptKey, approvalTimeoutMs: config.approval_timeout_ms }
  const mcpOperations = createMcpOperations(pool, operationDeps)
  const guard = createAutonomousGuard({
    loadTask: (taskId) => loadTask(pool, taskId),
    isInvocationCurrent: currentInvocationLookup(pool),
    isKillSwitchEngaged: killSwitchCheck(options.killSwitch),
    operations: mcpOperations,
    remoteWrites: () => options.policy.remote_writes,
    qaCheckouts: async (taskId) => (await loadTask(pool, taskId))?.qaCheckouts ?? [],
    defaultBranch: async (task) => boundRepo(registry(), task)?.default_branch ?? 'main',
    relayHome,
  })
  const bridge = new HookBridgeServer({
    decide: guard.decide,
    decideMcpCall: guard.decideMcpCall,
    recordMcpResult: async (result, context) => {
      if (!context) throw new Error('an MCP result without an invocation token')
      await mcpOperations.recordOperationOutcome(context, result.operationId, { ok: result.ok, result: result.result })
    },
  })
  await bridge.start()

  const remoteDeps: RemoteWriteDeps = {
    ...operationDeps,
    relayHome,
    loadRepo: (name) => registry().repos.find((repo) => repo.name === name),
    allowedApiPaths: options.policy.remote_writes?.allowed_api_paths ?? [],
    readWriteToken: () => options.secrets.get(WRITE_GITHUB_TOKEN_SECRET),
  }

  // --- spawning ------------------------------------------------------------
  const proxies = new Map<string, EgressProxy>()
  const proxyFor = async (taskId: string): Promise<EgressProxy> => {
    const existing = proxies.get(taskId)
    if (existing) return existing
    const proxy = await startEgressProxy({ taskDir: taskDir(taskId), log })
    proxies.set(taskId, proxy)
    return proxy
  }
  const closeTaskResources = async (taskId: string): Promise<void> => {
    await proxies.get(taskId)?.close()
    proxies.delete(taskId)
    await taskSecrets.delete(extensionTokenKey(taskId))
  }
  const node = process.execPath
  const hookCommand = `'${node}' '${join(options.distRoot, 'scripts', 'hook-pretooluse.js')}'`
  const gateway = { command: node, args: [join(options.distRoot, 'scripts', 'mcp-gateway.js')] }

  const spawnPlan = async (params: SpawnPlanParams): Promise<SpawnPlan> => {
    const { context, account } = params
    const task = context.task
    const dir = taskDir(task.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const proxy = await proxyFor(task.id)
    const extensionToken = await taskSecrets.get(extensionTokenKey(task.id))
    const set = buildWorkerMcpSet({
      servers: readMcpServers(),
      gateway,
      extensionGranted: extensionToken !== undefined,
      proxyUrl: proxy.url,
      caCertPath: proxy.caCertPath,
      playwrightConfigPath: join(dir, 'playwright-mcp.json'),
    })
    if (set.playwrightConfig !== undefined) writeFileSync(join(dir, 'playwright-mcp.json'), set.playwrightConfig, { mode: 0o600 })
    const gitConfigPath = join(dir, 'gitconfig')
    writeFileSync(gitConfigPath, renderWorkerGitConfig(options.gitIdentity), { mode: 0o600 })
    const readOnlyToken = await options.secrets.get(READ_ONLY_GITHUB_TOKEN_SECRET).catch(() => undefined)
    const env = buildWorkerEnv({
      account,
      gitConfigPath,
      ...(readOnlyToken !== undefined ? { readOnlyGithubToken: readOnlyToken } : {}),
      hookUrl: bridge.url,
      hookToken: params.hookToken,
      extraEnv: { ...(extensionToken !== undefined ? { [EXTENSION_TOKEN_VAR]: extensionToken } : {}), ...params.qa?.extraEnv },
    })
    const cwd = params.qa?.cwd ?? task.worktreePath ?? dir
    const schemaJson = params.qa?.schemaJson ?? JSON.stringify(REPLY_JSON_SCHEMA)
    const mode = params.qa ? 'bypass' : context.mode

    if (account.client === 'claude') {
      const mcpConfigPath = join(dir, `mcp-${params.hookToken.slice(0, 8)}.json`)
      writeClaudeMcpConfig(mcpConfigPath, set, env)
      return {
        bin: config.claude_bin,
        args: buildClaudeArgs({
          prompt: context.prompt,
          brief: WORKER_BRIEF,
          schemaJson,
          mode,
          maxBudgetUsd: params.reservedUsd,
          settingsJson: buildClaudeSettings({ hookCommand }),
          mcpConfigPath,
          ...(params.resume !== undefined ? { resume: params.resume } : {}),
        }),
        cwd,
        env,
        allowedMcpServers: set.allowedMcpServerNames,
        dispose: () => rm(mcpConfigPath, { force: true }),
      }
    }
    const schemaPath = join(dir, `schema-${params.hookToken.slice(0, 8)}.json`)
    writeFileSync(schemaPath, schemaJson, { mode: 0o600 })
    const codexHome = account.configDir ?? join(process.env.HOME ?? '', '.codex')
    const configToml = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => undefined)
    return {
      bin: config.codex_bin,
      args: buildCodexArgs({
        // codex has no appended system prompt: the brief leads the prompt.
        prompt: `${WORKER_BRIEF}\n\n${context.prompt}`,
        schemaPath,
        mode,
        overrides: [...buildCodexHookOverrides({ hookCommand }), ...buildCodexMcpOverrides(set, configToml)],
        ...(params.resume !== undefined ? { resume: params.resume } : {}),
      }),
      cwd,
      env,
      allowedMcpServers: set.allowedMcpServerNames,
      dispose: () => rm(schemaPath, { force: true }),
    }
  }

  const cooldowns = new RedisCooldownStore(options.redis)
  const turnDeps: TurnRunnerDeps & { lensAllowanceUsd: number } = {
    pool,
    readAccounts: () => readAccountPool(undefined, log),
    cooldowns,
    // Proven by `relay doctor` on this account and this codex version; anything else is not used.
    isCodexEligible: async (account: Account) => isProvenEligible(await readCodexEligibility(relayHome), account.key, await installedCodexVersion),
    caps,
    fallbackUsd: config.per_turn_fallback_usd,
    codexUsdPerMtok: config.codex_usd_per_mtok,
    turnTimeoutMs: config.turn_wall_clock_ms,
    issueToken: (context) => bridge.issueToken(context),
    revokeToken: (token) => bridge.revokeToken(token),
    spawnPlan,
    lensAllowanceUsd: config.review_codex_allowance_usd,
  }

  // --- verification --------------------------------------------------------
  const testEnv = (): NodeJS.ProcessEnv => {
    const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']
    return Object.fromEntries(keep.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])))
  }
  const git = async (cwd: string, args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim()
  const snapshotOf = async (task: AutonomousTask): Promise<Snapshot> => {
    const repo = boundRepo(registry(), task)
    if (!repo || task.worktreePath === null) throw new Error('the task has no bound repository worktree')
    const canonical = canonicalRepoUrl(repo)
    if (!canonical.ok) throw new Error(canonical.reason)
    await git(task.worktreePath, ['fetch', '--no-tags', 'origin', repo.default_branch])
    return {
      repo: canonical.url,
      baseSha: await git(task.worktreePath, ['rev-parse', `origin/${repo.default_branch}`]),
      headSha: await git(task.worktreePath, ['rev-parse', 'HEAD']),
    }
  }
  const completionDeps = (lease: Lease, context: TurnRequestContext): CompletionDeps => ({
    worktreeStatus: (worktree) => git(worktree, ['status', '--porcelain']),
    freezeSnapshot: snapshotOf,
    async runTests(worktree, command) {
      try {
        // The approved test command runs without relay's own environment (its secrets and database URL).
        await execFileAsync('/bin/sh', ['-c', command], { cwd: worktree, env: testEnv(), timeout: config.turn_wall_clock_ms, maxBuffer: 64 * 1024 * 1024, signal: context.signal })
        return 0
      } catch (error) {
        const code = (error as { code?: unknown }).code
        return typeof code === 'number' ? code : null
      }
    },
    async prepareQaCheckout(task, snapshot) {
      const path = join(taskDir(task.id), 'qa', snapshot.headSha.slice(0, 12))
      await git(task.worktreePath ?? '', ['worktree', 'add', '--detach', path, snapshot.headSha]).catch(async (error: unknown) => {
        // Already created for this snapshot by an earlier round.
        if (!String(error).includes('already exists')) throw error
      })
      await registerQaCheckout(pool, lease, path)
      return path
    },
    async reviewState(qaCheckout, snapshot) {
      const tmp = join(taskDir(context.task.id), 'review-state')
      const key = `relay-${snapshot.headSha.slice(0, 12)}`
      await execFileAsync('python3', ['-I', join(process.env.HOME ?? '', '.agents/skills/general-review/scripts/freeze_scope.py'), '--kind', 'branch', '--key', key, '--tmp', tmp, '--base', snapshot.baseSha, '--head', snapshot.headSha], { cwd: qaCheckout })
      return (await readFile(join(tmp, key, 'state.txt'), 'utf8')).trim()
    },
    async runQaInvocation(task, purpose, qaCheckout, snapshot) {
      const base = boundRepo(registry(), task)?.default_branch ?? 'main'
      return runQaOnPool(turnDeps, { ...context, prompt: buildQaPrompt(purpose, task, snapshot, base) }, { purpose, cwd: qaCheckout })
    },
    readText: (path) => readFile(path, 'utf8'),
    async recordVerification(task, record) {
      await recordVerification(pool, { ...record, taskId: task.id, workspaceId: task.workspaceId } as Parameters<typeof recordVerification>[1])
    },
  })
  const verifyTask = async (task: AutonomousTask, lease: Lease, signal: AbortSignal) => {
    // QA workers are recorded like turn workers, so takeover and Stop can kill them.
    const context: TurnRequestContext = { task, lease, mode: 'bypass', prompt: '', signal, recordWorker: (pid, pgid) => recordWorker(pool, lease, pid, pgid) }
    return verifyCompletion(task, completionDeps(lease, context))
  }

  // --- plans ----------------------------------------------------------------
  const planDeps: PlanApprovalDeps = {
    pool,
    outbox: dispatcher,
    approvalTimeoutMs: config.approval_timeout_ms,
    replyRef: async (task) => (await threadOf(task)).reply,
    requesterDisplayName: async (task) => {
      const { rows } = await pool.query<{ display_name: string }>('SELECT display_name FROM principals WHERE id = $1', [task.requesterPrincipalId])
      return rows[0]?.display_name ?? 'the requester'
    },
    isOperator,
  }

  const botToken = await options.secrets.get(SLACK_BOT_TOKEN_SECRET)
  const threadReplies = slackThreadReplies(botToken)
  const scheduler: Scheduler = createScheduler({
    pool,
    workspaceId,
    owner: `relay-${process.pid}`,
    post,
    replyRef: async (task) => (await threadOf(task)).reply,
    isKillSwitchEngaged: killSwitchCheck(options.killSwitch),
    log,
    effects: {
      runTurn: (context) => runTurnOnPool(turnDeps, context),
      downloadFiles: (task, lease) => downloadTaskFiles(pool, task, lease, { fetch: globalThis.fetch as never, botToken, inboxDir: (taskId) => join(taskDir(taskId), 'inbox') }),
      bindPlan: async (_task, plan) => bindPlan(registry(), plan),
      async threadHistory(task, beforeTs) {
        try {
          const { reply } = await threadOf(task)
          return renderThreadHistory(await threadReplies(reply.channel, reply.thread ?? ''), beforeTs)
        } catch (error) {
          // A thread that cannot be read leaves the worker with the new messages only.
          log.warn({ err: error, taskId: task.id }, 'could not read the Slack thread for a fresh session')
          return null
        }
      },
      postPlanForApproval: (task, lease, plan, repoName, runId) => postPlanForApproval(planDeps, task, lease, plan, repoName, runId),
      async settleApprovals(task, lease) {
        const plan = await settlePlanApproval(planDeps, task, lease)
        const operations = await settleTaskOperations(pool, remoteDeps, task)
        if (!plan && operations.length === 0) return undefined
        return { notes: [...(plan?.notes ?? []), ...operations], ...(plan?.phase !== undefined ? { phase: plan.phase } : {}) }
      },
      requestRemoteWrite: (task, lease, write, runId, signal) =>
        requestTaskRemoteWrite(pool, { ...remoteDeps, snapshot: snapshotOf, verify: (t) => verifyTask(t, lease, signal) }, task, write, runId),
      prepareWorktree: (task, lease) => prepareTaskWorktree(pool, registry(), task, lease),
      verify: verifyTask,
      async finish(task, outcome, text) {
        await finishTask(post, await threadOf(task), task, outcome, text)
        await closeTaskResources(task.id)
      },
      async cleanupStopped(task) {
        await cancelTaskWork(pool, { outbox: dispatcher }, task)
        await closeTaskResources(task.id)
      },
      sweep: () =>
        sweepExpiredApprovals(planDeps, workspaceId, async (sessionId, text) => {
          const task = await loadTaskBySession(pool, sessionId)
          if (task) await post({ kind: 'post', ref: (await threadOf(task)).reply, text })
        }),
    },
  })

  // Startup recovery: kill recorded workers (scheduler.start), charge
  // crashed invocations once, reconcile operations left mid-dispatch.
  await settleCrashedInvocations(pool, workspaceId, await caps())
  for (const reconciled of await reconcileDispatching(pool, remoteDeps, workspaceId)) {
    log.warn({ operationId: reconciled.operationId, state: reconciled.state }, 'reconciled an operation left dispatching')
  }
  await scheduler.start()

  const routing: AutonomousRouting = {
    async route(event: ChatEvent, thread, options) {
      return routeAutonomousEvent({ pool, outbox: dispatcher, secrets: taskSecrets, isOperator, wake: () => scheduler.wake(), log }, event, thread, options)
    },
    async stopSession(sessionId) {
      const task = await loadTaskBySession(pool, sessionId)
      if (!task) return false
      await stopAutonomousTask(pool, { cleanupStopped: async (stopped) => {
        await cancelTaskWork(pool, { outbox: dispatcher }, stopped)
        await closeTaskResources(stopped.id)
      } }, task.id)
      return true
    },
  }

  return {
    routing,
    async onApprovalResolved(result) {
      const sessionId = result.approval?.sessionId
      if (sessionId === undefined) return
      const task = await loadTaskBySession(pool, sessionId)
      if (!task) return
      await wakeTask(pool, task.id)
      scheduler.wake()
    },
    async stop() {
      await scheduler.stop()
      for (const taskId of [...proxies.keys()]) await proxies.get(taskId)?.close()
      await bridge.stop()
      await closeRedis(options.redis)
    },
  }
}
