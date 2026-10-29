/**
 * Slack chats inside the daemon: the hook bridge and guard, the scheduler
 * and every effect it runs, composed from the pieces in this folder.
 * startOrchestrator starts it when `autonomous.enabled` and hands the
 * orchestrator its routing.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import type { ResolveApprovalResult } from '../approvals/store.js'
import type { ChatAction, ChatEvent, ChatRef } from '../chat/contract.js'
import { SLACK_BOT_TOKEN_SECRET } from '../chat/slack/adapter.js'
import type { RelayConfig } from '../config/schema.js'
import { loadRepoRegistryIfPresent } from '../config/load.js'
import type { OutboundDispatcher } from '../dispatch/outbound.js'
import { HookBridgeServer } from '../engine/hook-bridge.js'
import type { KillSwitch } from '../killswitch.js'
import type { Logger } from '../obs/logger.js'
import { closeRedis, type Redis } from '../redis/client.js'
import type { SecretProvider } from '../secrets/provider.js'
import { classifyBlocked, COOLDOWN_MS, readAccountPool, RedisCooldownStore, type Account } from './accounts.js'
import { codexVersion, isProvenEligible, readCodexEligibility } from './codex-probe.js'
import { downloadTaskFiles } from './files.js'
import { chatFolder } from './folder.js'
import { createAutonomousGuard, killSwitchCheck } from './guard.js'
import { cancelTaskWork, requestShellWrite, settleTaskOperations, sweepExpiredApprovals, threadChatRef } from './operations.js'
import { buildReplyCommand } from '../live/control.js'
import { deliverViaCourier } from '../live/courier.js'
import { findOpenSessionName } from '../live/open-session.js'
import { WORKER_BRIEF } from './prompt.js'
import { routeAutonomousEvent } from './router.js'
import { createScheduler, stopAutonomousTask, type Scheduler } from './scheduler.js'
import { loadTask, loadTaskBySession, wakeTask, type AutonomousTask } from './store.js'
import { renderThreadHistory, slackThreadReplies } from './thread-history.js'
import { runTurnOnPool, type SpawnPlan, type SpawnPlanParams, type TurnRunnerDeps } from './turn-runner.js'
import { buildClaudeSettings, buildCodexHookOverrides } from './worker-config.js'
import { buildClaudeArgs, buildCodexArgs, buildWorkerEnv, claudeUserLine } from './worker.js'
import type { AutonomousRouting } from '../orchestrator.js'

export type AutonomousConfig = NonNullable<RelayConfig['autonomous']>

export type AutonomousRuntimeOptions = {
  pool: Pool
  workspaceId: string
  dispatcher: OutboundDispatcher
  log: Logger
  config: AutonomousConfig
  killSwitch: KillSwitch
  redis: Redis
  relayHome: string
  receiptKey: Uint8Array
  secrets: SecretProvider
  repoRegistryPath: string
  /** The built relay root, holding dist/scripts/hook-pretooluse.js. */
  distRoot: string
}

export type AutonomousRuntime = {
  routing: AutonomousRouting
  onApprovalResolved(result: ResolveApprovalResult): Promise<void>
  stop(): Promise<void>
}

export async function startAutonomousRuntime(options: AutonomousRuntimeOptions): Promise<AutonomousRuntime> {
  const { pool, workspaceId, dispatcher, log, config, relayHome } = options
  const installedCodexVersion = codexVersion(config.codex_bin).catch(() => 'unknown')
  const taskDir = (taskId: string): string => join(relayHome, 'tasks', taskId)
  const post = async (action: ChatAction, executor?: PoolClient): Promise<void> => {
    await dispatcher.enqueue(action, workspaceId, executor)
  }
  const replyRef = async (task: AutonomousTask): Promise<ChatRef> => {
    const { rows } = await pool.query<{ thread_ref: string }>('SELECT thread_ref FROM sessions WHERE id = $1', [task.sessionId])
    return threadChatRef(rows[0]?.thread_ref ?? '')
  }

  // --- the guard ---------------------------------------------------------------
  const operationDeps = { outbox: dispatcher, receiptKey: options.receiptKey, approvalTimeoutMs: config.approval_timeout_ms }
  const guard = createAutonomousGuard({
    loadTask: (taskId) => loadTask(pool, taskId),
    isKillSwitchEngaged: killSwitchCheck(options.killSwitch),
    requestShellWrite: (context, write) => requestShellWrite(pool, operationDeps, context, write),
  })
  const bridge = new HookBridgeServer({ decide: guard.decide })
  await bridge.start()

  // --- spawning ----------------------------------------------------------------
  const hookCommand = `'${process.execPath}' '${join(options.distRoot, 'scripts', 'hook-pretooluse.js')}'`
  const spawnPlan = async (params: SpawnPlanParams): Promise<SpawnPlan> => {
    const { context, account } = params
    const env = buildWorkerEnv({ account, hookUrl: bridge.url, hookToken: params.hookToken })
    // Set at intake for every task; the home folder only for one created before that.
    const cwd = context.task.chatCwd ?? (process.env.HOME ?? '/')
    const resume = params.resume !== undefined ? { resume: params.resume } : {}
    if (account.client === 'claude') {
      return {
        bin: config.claude_bin,
        args: buildClaudeArgs({ brief: WORKER_BRIEF, settingsJson: buildClaudeSettings({ hookCommand }), ...resume }),
        input: claudeUserLine(context.prompt),
        cwd,
        env,
      }
    }
    return {
      bin: config.codex_bin,
      // codex has no appended system prompt: the brief leads the prompt.
      args: buildCodexArgs({ prompt: `${WORKER_BRIEF}\n\n${context.prompt}`, overrides: buildCodexHookOverrides({ hookCommand }), ...resume }),
      cwd,
      env,
    }
  }

  const turnDeps: TurnRunnerDeps = {
    pool,
    readAccounts: () => readAccountPool(undefined, log),
    cooldowns: new RedisCooldownStore(options.redis),
    // Proven by `relay doctor` on this account and this codex version; anything else is not used.
    isCodexEligible: async (account: Account) => isProvenEligible(await readCodexEligibility(relayHome), account.key, await installedCodexVersion),
    turnTimeoutMs: config.turn_wall_clock_ms,
    issueToken: (context) => bridge.issueToken(context),
    revokeToken: (token) => bridge.revokeToken(token),
    spawnPlan,
  }

  // --- the scheduler -------------------------------------------------------------
  const botToken = await options.secrets.get(SLACK_BOT_TOKEN_SECRET)
  const threadReplies = slackThreadReplies(botToken)
  const cleanupStopped = (task: AutonomousTask): Promise<void> => cancelTaskWork(pool, { outbox: dispatcher }, task)
  const scheduler: Scheduler = createScheduler({
    pool,
    workspaceId,
    owner: `relay-${process.pid}`,
    post,
    replyRef,
    isKillSwitchEngaged: killSwitchCheck(options.killSwitch),
    log,
    effects: {
      runTurn: (context) => runTurnOnPool(turnDeps, context),
      downloadFiles: (task, lease) => {
        const inboxDir = join(taskDir(task.id), 'inbox')
        mkdirSync(inboxDir, { recursive: true, mode: 0o700 })
        return downloadTaskFiles(pool, task, lease, { fetch: globalThis.fetch as never, botToken, inboxDir })
      },
      async threadHistory(task, beforeTs) {
        try {
          const reply = await replyRef(task)
          return renderThreadHistory(await threadReplies(reply.channel, reply.thread ?? ''), beforeTs)
        } catch (error) {
          // A thread that cannot be read leaves the worker with the new messages only.
          log.warn({ err: error, taskId: task.id }, 'could not read the Slack thread for a fresh session')
          return null
        }
      },
      async deliverToOpenChat(task, text) {
        const sessionId = task.engineSessionId ?? task.chatSessionId
        if (sessionId === null || task.chatCwd === null) return false
        const name = await findOpenSessionName(sessionId)
        if (name === null) return false
        const replyCommand = buildReplyCommand(await replyRef(task))
        // The courier is itself a short `claude -p`, so it takes the first Claude login that is not cooling down.
        // Only a blocked login moves on to the next one: any other failure may have sent the message already, and retrying would send it twice.
        for (const account of (await turnDeps.readAccounts()).filter((entry) => entry.client === 'claude')) {
          if (((await turnDeps.cooldowns.cooldownUntil(account.key)) ?? 0) > Date.now()) continue
          const outcome = await deliverViaCourier({ targetCwd: task.chatCwd, targetName: name, body: text, replyCommand, senderLabel: 'your operator' }, { env: account.env, log })
          if (outcome.outcome === 'delivered') {
            log.info({ taskId: task.id, peer: outcome.peer, accountKey: account.key }, 'sent the thread\'s messages into the open chat')
            return true
          }
          log.warn({ taskId: task.id, accountKey: account.key, reason: outcome.reason }, 'could not send into the open chat with this account')
          const blocked = classifyBlocked({ exitCode: 1, stderr: outcome.reason })
          if (blocked === null) return false
          await turnDeps.cooldowns.coolDown(account.key, Date.now() + COOLDOWN_MS[blocked])
        }
        return false
      },
      settleApprovals: (_task, lease) => settleTaskOperations(pool, lease),
      cleanupStopped,
      sweep: () => sweepExpiredApprovals(pool, workspaceId),
    },
  })
  await scheduler.start()

  const routing: AutonomousRouting = {
    async route(event: ChatEvent, thread, routeOptions) {
      const repos = () => loadRepoRegistryIfPresent(options.repoRegistryPath).repos
      return routeAutonomousEvent({ pool, outbox: dispatcher, chatFolder: (text) => chatFolder(text, repos()), wake: () => scheduler.wake(), log }, event, thread, routeOptions)
    },
    async stopSession(sessionId) {
      const task = await loadTaskBySession(pool, sessionId)
      if (!task) return false
      await stopAutonomousTask(pool, { cleanupStopped }, task.id)
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
      await bridge.stop()
      await closeRedis(options.redis)
    },
  }
}
