/**
 * Slack chats inside the daemon: the hook bridge and guard, the scheduler
 * and every effect it runs, composed from the pieces in this folder.
 * startOrchestrator starts it when `autonomous.enabled` and hands the
 * orchestrator its routing.
 *
 * With failover on (`failover`), work starts only while this laptop holds
 * the "who is answering" record, workers and leases carry this laptop's
 * name, stored folders are mapped to this laptop's home, and Claude chats
 * are saved for the other laptop. `drain()` is the step down's wait.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
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
import { chatFolder, isFolder, namedFolder, textFolder } from './folder.js'
import { createAutonomousGuard, killSwitchCheck } from './guard.js'
import { cancelTaskWork, requestShellWrite, settleTaskOperations, sweepExpiredApprovals, threadChatRef } from './operations.js'
import { buildReplyCommand } from '../live/control.js'
import { deliverViaCourier } from '../live/courier.js'
import { findOpenSessionName } from '../live/open-session.js'
import { createChatSync } from '../failover/chats.js'
import { knownHomes, mapPath } from '../failover/paths.js'
import { ALWAYS_ACTIVE, type FailoverGate } from '../failover/types.js'
import { WORKER_BRIEF } from './prompt.js'
import { routeAutonomousEvent } from './router.js'
import { TEAM_PROPOSAL_PATH, teamProposalRoute } from './team-proposal-route.js'
import { createScheduler, killWorkerGroup, pauseAutonomousTask, stopAutonomousTask, type Scheduler } from './scheduler.js'
import { leaseOwnerName, loadTask, loadTaskBySession, pinReminderTask, updateTask, wakeTask, type AutonomousTask, type Lease } from './store.js'
import { renderThreadHistory, slackThreadReplies } from './thread-history.js'
import { runTurnOnPool, turnCwd, type SpawnPlan, type SpawnPlanParams, type SpawnRefusal, type TurnRunnerDeps } from './turn-runner.js'
import { defaultPersonasDir } from '../projects/persona-files.js'
import { leadTurnSubject } from '../teams/lead-brief.js'
import { teamRoute } from '../teams/route.js'
import { createTeamScheduler } from '../teams/scheduler.js'
import { loadAssignment, ownWorkerGroups } from '../teams/store.js'
import { TEAM_PATH, type TeamHooks } from '../teams/types.js'
import { ensureMemberWorktree, headOf } from '../teams/worktrees.js'
import { buildClaudeSettings, buildCodexHookOverrides } from './worker-config.js'
import { buildClaudeArgs, buildCodexArgs, buildWorkerEnv, claudeUserLine } from './worker.js'
import { browserEnv, createExtensionTokens } from './extension-token.js'
import { isSiblingWorktree } from '../worker-env/resolve.js'
import type { ReaderKey } from '../worker-env/seal.js'
import { createSessionEnvs, type SessionEnvs } from '../worker-env/sessions.js'
import { slackChannelPurpose } from '../chat/slack/channel-folder.js'
import type { AutonomousRouting } from '../orchestrator.js'
import { principalIsOwner } from '../tenancy/access.js'

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
  /** Whether this laptop may start work, and its name; ALWAYS_ACTIVE (failover off) unless set. */
  failover?: FailoverGate
  /** This laptop's env key (src/worker-env/keys.ts); without it, a session that needs a stored env waits. */
  workerEnvKey?: ReaderKey | null
}

export type AutonomousRuntime = {
  routing: AutonomousRouting
  onApprovalResolved(result: ResolveApprovalResult): Promise<void>
  /** For the failover step down: starts no new task or member turn, and resolves once the running ones have ended and posted. */
  drain(): Promise<void>
  stop(): Promise<void>
}

export async function startAutonomousRuntime(options: AutonomousRuntimeOptions): Promise<AutonomousRuntime> {
  const { pool, workspaceId, dispatcher, log, config, relayHome } = options
  const gate = options.failover ?? ALWAYS_ACTIVE
  const owner = leaseOwnerName(process.pid, gate.host)
  const installedCodexVersion = codexVersion(config.codex_bin).catch(() => 'unknown')
  const taskDir = (taskId: string): string => join(relayHome, 'tasks', taskId)
  const post = (action: ChatAction, executor?: PoolClient): Promise<string> => dispatcher.enqueue(action, workspaceId, executor)
  const threadRefOf = async (task: AutonomousTask): Promise<string> => {
    const { rows } = await pool.query<{ thread_ref: string }>('SELECT thread_ref FROM sessions WHERE id = $1', [task.sessionId])
    return rows[0]?.thread_ref ?? ''
  }
  const replyRef = async (task: AutonomousTask): Promise<ChatRef> => threadChatRef(await threadRefOf(task))

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
          // A process group id from another laptop names nothing here.
          for (const pgid of await ownWorkerGroups(pool, pgids, gate.host)) await killWorkerGroup(pgid)
        },
      }),
    },
  })
  await bridge.start()

  // --- spawning ----------------------------------------------------------------
  const hookCommand = `'${process.execPath}' '${join(options.distRoot, 'scripts', 'hook-pretooluse.js')}'`
  const botToken = await options.secrets.get(SLACK_BOT_TOKEN_SECRET)
  const extensionTokens = createExtensionTokens({ readPurpose: slackChannelPurpose(botToken), log })
  const repoPaths = (): string[] => loadRepoRegistryIfPresent(options.repoRegistryPath).repos.map((entry) => entry.path)
  const sessionEnvs = createSessionEnvs({
    source: { pool, workspaceId, key: options.workerEnvKey ?? null },
    host: gate.host,
    home: homedir(),
    homes: () => knownHomes(pool),
    repos: repoPaths,
    fallback: async (threadRef) => browserEnv(await extensionTokens.current(threadRef)),
    log,
  })
  const spawnSetup = { claudeBin: config.claude_bin, codexBin: config.codex_bin, hookCommand, hookUrl: bridge.url }
  const spawnPlan = async (params: SpawnPlanParams): Promise<SpawnPlan | SpawnRefusal> => planTurnWithEnv(spawnSetup, sessionEnvs, await threadRefOf(params.context.task), params)

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
    ...(gate.host !== null ? { chats: createChatSync(pool, gate.host, log) } : {}),
  }
  const localPath = async (path: string): Promise<string> => mapPath(path, await knownHomes(pool), homedir())

  // --- the scheduler -------------------------------------------------------------
  const threadReplies = slackThreadReplies(botToken)
  const team = createTeamScheduler({
    pool,
    workspaceId,
    owner,
    runTurn: (context) => runTurnOnPool(turnDeps, context),
    ensureWorktree: ensureMemberWorktree,
    headOf,
    log,
    failover: gate,
  })
  const placeTurnHere = (task: AutonomousTask, lease: Lease): Promise<AutonomousTask | null> =>
    placeTaskTurn(
      {
        pool,
        home: homedir(),
        repos: repoPaths,
        tell: async (target, text) => {
          await post({ kind: 'post', ref: await replyRef(target), text })
        },
      },
      task,
      lease,
    )
  const cleanupStopped = withTeamStop(team, (task) => cancelTaskWork(pool, { outbox: dispatcher }, task))
  const scheduler: Scheduler = createScheduler({
    team,
    pool,
    workspaceId,
    owner,
    post,
    replyRef,
    isKillSwitchEngaged: killSwitchCheck(options.killSwitch),
    log,
    failover: gate,
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
          { targetCwd: await localPath(task.chatCwd), targetName: name, body: text, replyCommand, senderLabel: 'your operator' },
          { accounts: { readAccounts: turnDeps.readAccounts, cooldowns: turnDeps.cooldowns }, log },
        )
        if (outcome.outcome === 'delivered') {
          log.info({ taskId: task.id, peer: outcome.peer }, 'sent the thread\'s messages into the open chat')
          return true
        }
        log.warn({ taskId: task.id, reason: outcome.reason }, 'could not send into the open chat')
        return false
      },
      envChanged: (task) => sessionEnvs.changedSince(task.id),
      // Folders only move between laptops with failover on; a single laptop runs where the task says, as before.
      ...(gate.host !== null ? { placeTurn: placeTurnHere } : {}),
      settleApprovals: (_task, lease) => settleTaskOperations(pool, lease),
      cleanupStopped,
      sweep: () => sweepExpiredApprovals(pool, workspaceId),
    },
  })
  await scheduler.start()

  const routing: AutonomousRouting = {
    async route(event: ChatEvent, thread, routeOptions) {
      const repos = () => loadRepoRegistryIfPresent(options.repoRegistryPath).repos
      const result = await routeAutonomousEvent(
        {
          pool,
          outbox: dispatcher,
          chatFolder: (text) => chatFolder(text, repos()),
          reminderFolder: (text) => textFolder(text, repos()),
          wake: () => scheduler.wake(),
          extension: {
            isOwner: (workspace, principalId) => principalIsOwner(pool, workspace, principalId),
            rememberDm: (threadRef, browser) => extensionTokens.rememberDm(threadRef, browser),
          },
          log,
        },
        event,
        thread,
        routeOptions,
      )
      // A reminder runs as the person this laptop's config names, so only this laptop runs its task.
      if (result === 'handled' && event.origin === 'reminder' && gate.host !== null) await pinReminderTask(pool, workspaceId, thread.threadRef, gate.host)
      return result
    },
    async stopSession(sessionId) {
      const task = await loadTaskBySession(pool, sessionId)
      if (!task) return false
      await stopAutonomousTask(pool, { cleanupStopped }, task.id, gate.host)
      // Ended for good: a DM thread's extension values go too. A pause keeps them for the next message.
      sessionEnvs.forget(task.id)
      extensionTokens.forget(await threadRefOf(task))
      return true
    },
    async pauseSession(sessionId, stoppedAt) {
      const task = await loadTaskBySession(pool, sessionId)
      if (!task) return 'missing'
      return (await pauseAutonomousTask(pool, { cleanupStopped }, task.id, stoppedAt, gate.host)).kind
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
    async drain() {
      await Promise.all([scheduler.drain(), team.drain()])
    },
    async stop() {
      await scheduler.stop()
      await bridge.stop()
      await closeRedis(options.redis)
    },
  }
}

export type SpawnSetup = { claudeBin: string; codexBin: string; hookCommand: string; hookUrl: string }

/**
 * A turn's spawn plan with the envs resolved for its folder on this laptop.
 * A read-only reminder task gets none. Team members get theirs (decision 4),
 * but only the thread's own session is kept for the change check. A stored
 * env that cannot be read here refuses the turn instead of starting it
 * without the value.
 */
export async function planTurnWithEnv(setup: SpawnSetup, envs: Pick<SessionEnvs, 'forSession' | 'forget'>, threadRef: string, params: SpawnPlanParams): Promise<SpawnPlan | SpawnRefusal> {
  const { task } = params.context
  if (task.readOnly) {
    envs.forget(task.id)
    return buildSpawnPlan(setup, params)
  }
  const resolved = await envs.forSession({ taskId: task.id, threadRef, cwd: turnCwd(params.context, params.subject), track: params.subject.assignment === undefined })
  if (resolved.kind === 'unreadable') return { kind: 'env_unreadable', reason: resolved.reason }
  return buildSpawnPlan(setup, params, resolved.env)
}

/**
 * The CLI, arguments, folder and environment for one turn on one login. A
 * member's subject brings its worktree, brief, model and no MCP servers; the
 * task's own subject gives exactly today's single agent. `env` is the
 * session's resolved envs; a read-only task never gets them.
 */
export function buildSpawnPlan(setup: SpawnSetup, params: SpawnPlanParams, resolvedEnv?: Readonly<Record<string, string>>): SpawnPlan {
  const { context, account, subject } = params
  const env = buildWorkerEnv({ account, hookUrl: setup.hookUrl, hookToken: params.hookToken, ...(resolvedEnv !== undefined && !context.task.readOnly ? { env: resolvedEnv } : {}) })
  // A member works in its worktree; a task's chat folder is set at intake, the home folder only for one created before that.
  const cwd = turnCwd(context, subject)
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

/** Where a task's turn runs on this laptop, from the folder stored for it (README, "Failover"). */
export type TaskFolder =
  | { kind: 'here'; cwd: string }
  /** The stored folder is missing here; its repository is not. */
  | { kind: 'repository'; cwd: string; missing: string }
  | { kind: 'missing'; missing: string }

/**
 * The stored folder mapped to this laptop's home; when it is not here (a
 * worktree made on the other laptop), the registered repository it belongs
 * to: the one it sits inside, or the one it is a `<repo>-<name>` sibling of.
 */
export function resolveTaskFolder(stored: string, place: { homes: readonly string[]; home: string; repos: readonly string[] }): TaskFolder {
  const cwd = mapPath(stored, place.homes, place.home)
  if (isFolder(cwd)) return { kind: 'here', cwd }
  const repos = place.repos.map((repo) => mapPath(repo, place.homes, place.home))
  const inside = repos.filter((repo) => cwd.startsWith(repo + sep))
  const sibling = repos.filter((repo) => isSiblingWorktree(cwd, repo))
  const repo = [...inside, ...sibling].filter(isFolder).sort((a, b) => b.length - a.length)[0]
  return repo === undefined ? { kind: 'missing', missing: cwd } : { kind: 'repository', cwd: repo, missing: cwd }
}

export function repositoryFallbackText(missing: string, repo: string): string {
  return `This thread's folder \`${missing}\` is not on this laptop (it was likely a worktree on the other one), so I am working in its repository \`${repo}\` instead. Work left uncommitted there is not here.`
}

export function missingFolderText(missing: string): string {
  return `This thread's folder \`${missing}\` is not on this laptop, and neither is its repository. Reply here with the folder to use (for example \`~/code/project\`).`
}

export type PlaceTurnDeps = {
  pool: Pool
  home: string
  /** The registered repositories' folders. */
  repos: () => readonly string[]
  /** Posts one line in the task's thread. */
  tell: (task: AutonomousTask, text: string) => Promise<void>
}

/**
 * The task as its turn runs here (the scheduler's placeTurn). A folder
 * missing here moves the task to its repository, saying so once, since the
 * move is stored; with no repository either, the thread is asked for a
 * folder and the turn waits (null) until the requester names one that exists.
 */
export async function placeTaskTurn(deps: PlaceTurnDeps, task: AutonomousTask, lease: Lease): Promise<AutonomousTask | null> {
  if (task.chatCwd === null) return task
  const folder = resolveTaskFolder(task.chatCwd, { homes: await knownHomes(deps.pool), home: deps.home, repos: deps.repos() })
  if (folder.kind === 'here') return folder.cwd === task.chatCwd ? task : { ...task, chatCwd: folder.cwd }
  if (folder.kind === 'repository') {
    if (!(await updateTask(deps.pool, lease, { chatCwd: folder.cwd }))) return null
    await deps.tell(task, repositoryFallbackText(folder.missing, folder.cwd))
    return { ...task, chatCwd: folder.cwd }
  }
  // An answer to the question below: the first existing folder the requester names in a waiting message.
  const named = task.pendingEvents
    .filter((event) => event.principalId === task.requesterPrincipalId)
    .map((event) => namedFolder(event.text, deps.home))
    .find((path) => path !== undefined)
  if (named !== undefined) {
    if (!(await updateTask(deps.pool, lease, { chatCwd: named }))) return null
    return { ...task, chatCwd: named }
  }
  await deps.tell(task, missingFolderText(folder.missing))
  return null
}
