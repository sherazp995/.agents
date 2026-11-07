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
import type { ApprovalPolicy, RelayConfig } from '../config/schema.js'
import { loadRepoRegistryIfPresent } from '../config/load.js'
import type { OutboundDispatcher } from '../dispatch/outbound.js'
import { HookBridgeServer } from '../engine/hook-bridge.js'
import type { KillSwitch } from '../killswitch.js'
import type { Logger } from '../obs/logger.js'
import type { TeamProposer } from '../projects/proposals.js'
import { closeRedis, type Redis } from '../redis/client.js'
import type { SecretProvider } from '../secrets/provider.js'
import { readAccountPool, RedisCooldownStore, type Account } from './accounts.js'
import { codexVersion, isProvenEligible, readCodexEligibility } from './codex-probe.js'
import { downloadTaskFiles } from './files.js'
import { chatFolder, textFolder } from './folder.js'
import { createAutonomousGuard, killSwitchCheck } from './guard.js'
import { cancelTaskWork, requestShellWrite, settleTaskOperations, sweepExpiredApprovals, threadChatRef } from './operations.js'
import { buildReplyCommand } from '../live/control.js'
import { deliverViaCourier } from '../live/courier.js'
import { findOpenSessionName } from '../live/open-session.js'
import { WORKER_BRIEF } from './prompt.js'
import { routeAutonomousEvent } from './router.js'
import { TEAM_PROPOSAL_PATH, teamProposalRoute } from './team-proposal-route.js'
import { createScheduler, killWorkerGroup, pauseAutonomousTask, stopAutonomousTask, type Scheduler } from './scheduler.js'
import { loadTask, loadTaskBySession, wakeTask, type AutonomousTask } from './store.js'
import { renderThreadHistory, slackThreadReplies } from './thread-history.js'
import { runTurnOnPool, type SpawnPlan, type SpawnPlanParams, type TurnRunnerDeps } from './turn-runner.js'
import { defaultPersonasDir } from '../projects/persona-files.js'
import { leadTurnSubject } from '../teams/lead-brief.js'
import { teamRoute } from '../teams/route.js'
import { createTeamScheduler } from '../teams/scheduler.js'
import { loadAssignment } from '../teams/store.js'
import { TEAM_PATH, type TeamHooks } from '../teams/types.js'
import { ensureMemberWorktree, headOf } from '../teams/worktrees.js'
import { buildClaudeSettings, buildCodexHookOverrides } from './worker-config.js'
import { buildClaudeArgs, buildCodexArgs, buildWorkerEnv, claudeUserLine } from './worker.js'
import { createExtensionTokens } from './extension-token.js'
import { slackChannelPurpose } from '../chat/slack/channel-folder.js'
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
  /** policy.yaml's `approvals` section, for who may approve a remote write. */
  approvalPolicy?: ApprovalPolicy
  /** Starts team proposals for `relay team propose`; without it that command is refused. */
  teamProposer?: TeamProposer
  /** The global persona library; Relay home's `personas/` unless set. */
  personasDir?: string
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
  const post = (action: ChatAction, executor?: PoolClient): Promise<string> => dispatcher.enqueue(action, workspaceId, executor)
  const replyRef = async (task: AutonomousTask): Promise<ChatRef> => {
    const { rows } = await pool.query<{ thread_ref: string }>('SELECT thread_ref FROM sessions WHERE id = $1', [task.sessionId])
    return threadChatRef(rows[0]?.thread_ref ?? '')
  }

  // --- the guard ---------------------------------------------------------------
  const operationDeps = {
    outbox: dispatcher,
    receiptKey: options.receiptKey,
    approvalTimeoutMs: config.approval_timeout_ms,
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
  }
  const guard = createAutonomousGuard({
    loadTask: (taskId) => loadTask(pool, taskId),
    loadAssignment: (assignmentId) => loadAssignment(pool, assignmentId),
    isKillSwitchEngaged: killSwitchCheck(options.killSwitch),
    requestShellWrite: (context, write) => requestShellWrite(pool, operationDeps, context, write),
  })
  const bridge = new HookBridgeServer({
    decide: guard.decide,
    logger: log,
    routes: {
      [TEAM_PROPOSAL_PATH]: teamProposalRoute({ pool, workspaceId, ...(options.teamProposer ? { teamProposer: options.teamProposer } : {}) }),
      [TEAM_PATH]: teamRoute({
        pool,
        workspaceId,
        relayHome,
        personasDir: options.personasDir ?? defaultPersonasDir(),
        repo: (name) => loadRepoRegistryIfPresent(options.repoRegistryPath).repos.find((entry) => entry.name === name),
        wake: () => team.wake(),
        killGroups: async (pgids) => {
          for (const pgid of pgids) await killWorkerGroup(pgid)
        },
      }),
    },
  })
  await bridge.start()

  // --- spawning ----------------------------------------------------------------
  const hookCommand = `'${process.execPath}' '${join(options.distRoot, 'scripts', 'hook-pretooluse.js')}'`
  const botToken = await options.secrets.get(SLACK_BOT_TOKEN_SECRET)
  const extensionTokens = createExtensionTokens({ readPurpose: slackChannelPurpose(botToken), log })
  const spawnPlan = async (params: SpawnPlanParams): Promise<SpawnPlan> => {
    const extensionToken = params.subject.noMcp ? undefined : await extensionTokens.forWorker(params.context.task.id, (await replyRef(params.context.task)).channel)
    return buildSpawnPlan({ claudeBin: config.claude_bin, codexBin: config.codex_bin, hookCommand, hookUrl: bridge.url }, params, extensionToken)
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
  const threadReplies = slackThreadReplies(botToken)
  const team = createTeamScheduler({
    pool,
    workspaceId,
    owner: `relay-${process.pid}`,
    runTurn: (context) => runTurnOnPool(turnDeps, context),
    ensureWorktree: ensureMemberWorktree,
    headOf,
    log,
  })
  const cleanupStopped = withTeamStop(team, (task) => cancelTaskWork(pool, { outbox: dispatcher }, task))
  const scheduler: Scheduler = createScheduler({
    team,
    pool,
    workspaceId,
    owner: `relay-${process.pid}`,
    post,
    replyRef,
    isKillSwitchEngaged: killSwitchCheck(options.killSwitch),
    log,
    effects: {
      // In a project channel whose team has a lead, the thread's agent leads it; otherwise the subject is today's.
      runTurn: async (context) => runTurnOnPool(turnDeps, { ...context, subject: await leadTurnSubject(pool, context.task) }),
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
        // The courier takes the first Claude login that is not cooling down; only a blocked login moves on (src/live/courier.ts).
        const outcome = await deliverViaCourier(
          { targetCwd: task.chatCwd, targetName: name, body: text, replyCommand, senderLabel: 'your operator' },
          { accounts: { readAccounts: turnDeps.readAccounts, cooldowns: turnDeps.cooldowns }, log },
        )
        if (outcome.outcome === 'delivered') {
          log.info({ taskId: task.id, peer: outcome.peer }, 'sent the thread\'s messages into the open chat')
          return true
        }
        log.warn({ taskId: task.id, reason: outcome.reason }, 'could not send into the open chat')
        return false
      },
      extensionTokenChanged: async (task) => extensionTokens.changedSince(task.id, (await replyRef(task)).channel),
      settleApprovals: (_task, lease) => settleTaskOperations(pool, lease),
      cleanupStopped,
      sweep: () => sweepExpiredApprovals(pool, workspaceId),
    },
  })
  await scheduler.start()

  const routing: AutonomousRouting = {
    async route(event: ChatEvent, thread, routeOptions) {
      const repos = () => loadRepoRegistryIfPresent(options.repoRegistryPath).repos
      return routeAutonomousEvent(
        { pool, outbox: dispatcher, chatFolder: (text) => chatFolder(text, repos()), reminderFolder: (text) => textFolder(text, repos()), wake: () => scheduler.wake(), log },
        event,
        thread,
        routeOptions,
      )
    },
    async stopSession(sessionId) {
      const task = await loadTaskBySession(pool, sessionId)
      if (!task) return false
      await stopAutonomousTask(pool, { cleanupStopped }, task.id)
      return true
    },
    async pauseSession(sessionId, stoppedAt) {
      const task = await loadTaskBySession(pool, sessionId)
      if (!task) return 'missing'
      return (await pauseAutonomousTask(pool, { cleanupStopped }, task.id, stoppedAt)).kind
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

/**
 * The CLI, arguments, folder and environment for one turn on one login. A
 * member's subject brings its worktree, brief, model and no MCP servers; the
 * task's own subject gives exactly today's single agent.
 */
export function buildSpawnPlan(setup: { claudeBin: string; codexBin: string; hookCommand: string; hookUrl: string }, params: SpawnPlanParams, extensionToken?: string): SpawnPlan {
  const { context, account, subject } = params
  // A worker with no MCP servers never gets the channel's extension token: it could still read it from its environment.
  const token = subject.noMcp ? undefined : extensionToken
  const env = buildWorkerEnv({ account, hookUrl: setup.hookUrl, hookToken: params.hookToken, ...(token !== undefined ? { extensionToken: token } : {}) })
  // A member works in its worktree; a task's chat folder is set at intake, the home folder only for one created before that.
  const cwd = subject.cwd ?? context.task.chatCwd ?? (process.env.HOME ?? '/')
  const brief = subject.brief ?? WORKER_BRIEF
  const flags = { ...(params.resume !== undefined ? { resume: params.resume } : {}), ...(subject.model !== null ? { model: subject.model } : {}), ...(subject.noMcp ? { noMcp: true } : {}) }
  const readOnly = context.task.readOnly
  // runTurnOnPool binds a read-only task to Claude; this refuses a plan that would lift it anyway.
  if (readOnly && (account.client !== 'claude' || !subject.noMcp)) throw new Error('a read-only task only runs on Claude with no MCP servers')
  if (account.client === 'claude') {
    return {
      bin: setup.claudeBin,
      args: buildClaudeArgs({ brief, settingsJson: buildClaudeSettings({ hookCommand: setup.hookCommand, allTools: readOnly }), ...flags }),
      input: claudeUserLine(context.prompt),
      cwd,
      env,
    }
  }
  return {
    bin: setup.codexBin,
    // codex has no appended system prompt: the brief leads the prompt.
    args: buildCodexArgs({ prompt: `${brief}\n\n${context.prompt}`, overrides: buildCodexHookOverrides({ hookCommand: setup.hookCommand }), ...flags }),
    cwd,
    env,
  }
}

/** Stop's cleanup with the task's team members stopped first, so Stop and the kill switch reach every member. */
export function withTeamStop(team: Pick<TeamHooks, 'stopTask'>, cleanup: (task: AutonomousTask) => Promise<void>): (task: AutonomousTask) => Promise<void> {
  return async (task) => {
    await team.stopTask(task.id)
    await cleanup(task)
  }
}
