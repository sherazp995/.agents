#!/usr/bin/env node
import { runKillClear, runKillEngage } from './cli/kill.js'
import { Command } from 'commander'
import type { Pool } from 'pg'
import { runPrincipalsAdd } from './cli/principals.js'
import { readIfPresent, relayCodexLink, relayPrepare, runInTerminal, runLaunch, type RelayPrepareDeps } from './cli/launch.js'
import { deleteCodexChatRecord, writeCodexChatRecord } from './live/open-codex.js'
import { readAccountPool, RedisCooldownStore } from './autonomous/accounts.js'
import { codexVersion, isProvenEligible, readCodexEligibility } from './autonomous/codex-probe.js'
import { closeRedis, createRedis, waitForReady } from './redis/client.js'
import { runNotify } from './cli/notify.js'
import { runUi } from './cli/ui.js'
import { registerTeamCommands } from './cli/team.js'
import { DEFAULT_UI_PORT } from './config/schema.js'
import { spawn } from 'node:child_process'
import { runInstallService, runUninstallService, serviceBinaries, serviceInstalled } from './cli/service.js'
import { runStatus } from './cli/status.js'
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_DATABASE_URL,
  DEFAULT_POLICY_PATH,
  DEFAULT_REDIS_URL,
  runInit,
} from './cli/init.js'
import {
  DEFAULT_WAIT_SECONDS,
  resolveDrainWorkspace,
  runLiveClaim,
  runLiveDrain,
  runLiveEdit,
  runLiveReact,
  runLiveRelease,
  runLiveSay,
  runLiveWait,
} from './cli/live.js'
import {
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_SMOKE_CONFIG_PATH,
  DEFAULT_SMOKE_POLICY_PATH,
  runSmoke,
} from './cli/smoke.js'
import { createSecretProvider } from './secrets/index.js'
import { loadRelayConfig, loadRepoRegistryIfPresent } from './config/load.js'
import { ConfigError } from './config/errors.js'
import { resolveOperatorDatabaseUrl } from './config/database-url.js'
import { closePool, createPool } from './db/pool.js'
import { formatResults, runDoctor } from './doctor/run.js'
import { RELAY_VERSION } from './version.js'
import { defaultConfigPath, defaultPolicyPath, defaultReposPath, resolveRelayHome } from './config/paths.js'
import { runSecretsMigrate, runSecretsSet } from './cli/secrets.js'
import { relaySecretsHelperPath } from './secrets/keychain.js'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReposAdd } from './cli/repos.js'
import { runDbCreate, runDbMove } from './cli/db.js'
import { buildSetupSteps, promptHidden, promptLine, runSetup } from './cli/setup.js'
import { readStdin } from './cli/stdin.js'
import { runEnvAdd, runEnvList, runEnvRemove, type EnvCommandResult, type EnvScopeOptions } from './cli/env.js'
import { runChannelFolder } from './cli/channel.js'

/** The relay checkout or package this CLI runs from: dist/src/cli.js sits two folders below it. */
const RELAY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const program = new Command()
program.name('relay').description('Chat-driven computer-use agent').version(RELAY_VERSION)

program
  .command('doctor')
  .description('Diagnose the installation and report every dependency')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .option('-p, --policy <path>', 'policy path', defaultPolicyPath())
  .option('-v, --verbose', 'also print each check\'s long detail (the egress audit)')
  .option('--recheck', 'prove every codex login again instead of reusing saved proofs')
  .action(async (options: { config: string; policy: string; verbose?: boolean; recheck?: boolean }) => {
    const { results, exitCode, elapsedMs } = await runDoctor({
      configPath: options.config,
      policyPath: options.policy,
      ...(options.recheck ? { recheck: true } : {}),
    })
    process.stdout.write(`${formatResults(results, { verbose: options.verbose === true, elapsedMs })}\n`)
    process.exitCode = exitCode
  })

program
  .command('init')
  .description(
    'Wizard that takes a clean machine to a working installation: writes starter config and policy, ' +
      'reviews the hard-blocked origin list, and finishes with relay doctor. Never prompts when run without a terminal, e.g. in CI.',
  )
  .option('-c, --config <path>', 'runtime config path to write or check', DEFAULT_CONFIG_PATH)
  .option('-p, --policy <path>', 'policy path to write or check', DEFAULT_POLICY_PATH)
  .option('-y, --yes', 'never prompt; use flags and built-in defaults only, for CI and scripts', false)
  .option('--force', 'overwrite an existing file instead of leaving it untouched', false)
  .option(
    '--hard-blocked-origin <origin>',
    'an origin to add to the hard-blocked list, on top of the built-in defaults (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option('--database-url <url>', 'Postgres URL written into the starter config', DEFAULT_DATABASE_URL)
  .option('--redis-url <url>', 'Redis URL written into the starter config', DEFAULT_REDIS_URL)
  .action(
    async (options: {
      config: string
      policy: string
      yes: boolean
      force: boolean
      hardBlockedOrigin: string[]
      databaseUrl: string
      redisUrl: string
    }) => {
      const result = await runInit({
        configPath: options.config,
        policyPath: options.policy,
        yes: options.yes,
        force: options.force,
        hardBlockedOrigins: options.hardBlockedOrigin,
        databaseUrl: options.databaseUrl,
        redisUrl: options.redisUrl,
      })
      process.stdout.write(`${result.report}\n`)
      process.exitCode = result.exitCode
    },
  )

program
  .command('install-service')
  .description(
    'Install a supervisor (a launchd agent on macOS, a systemd user unit on Linux) so the daemon restarts when ' +
      'it exits and starts at login. The daemon exits on ' +
      'purpose after repeated Slack connectivity failures; without this, nothing brings it back.',
  )
  .option('--relay-home <path>', 'RELAY_HOME for the service, when the installation is not this directory')
  .option('-c, --config <path>', 'runtime config path, read for the claude and codex binary paths', defaultConfigPath())
  .option('--start', 'write and load the agent; run after `relay secrets migrate`', false)
  .action((options: { relayHome?: string; config: string; start: boolean }) => {
    let autonomous: ReturnType<typeof loadRelayConfig>['autonomous']
    try {
      autonomous = loadRelayConfig(options.config).autonomous
    } catch (error) {
      const detail = error instanceof ConfigError ? `${error.filePath}: ${error.reason}` : (error as Error).message
      process.stdout.write(`Not installed: the relay config could not be loaded (${detail}).\n`)
      process.exitCode = 1
      return
    }
    const result = runInstallService({
      repoRoot: RELAY_ROOT,
      ...(options.relayHome !== undefined ? { relayHome: options.relayHome } : {}),
      binaries: serviceBinaries(autonomous),
      start: options.start,
    })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('uninstall-service')
  .description('Remove the supervisor (launchd agent or systemd unit). Relay will no longer start at login or restart itself.')
  .action(() => {
    const result = runUninstallService()
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('smoke')
  .description(
    'Proves the installation actually works: Postgres, Redis, migrations and Slack ' +
      'always run; a real end-to-end agent run only runs with --run-agent, since it costs money.',
  )
  .option('-c, --config <path>', 'runtime config path', DEFAULT_SMOKE_CONFIG_PATH)
  .option('-p, --policy <path>', 'policy path', DEFAULT_SMOKE_POLICY_PATH)
  .option('--migrations-dir <path>', 'directory of SQL migrations to apply', DEFAULT_MIGRATIONS_DIR)
  .option(
    '--run-agent',
    'also run a real, governed agent run through the echo capability. Spawns the claude CLI and costs money per invocation; never runs without this flag',
    false,
  )
  .action(
    async (options: { config: string; policy: string; migrationsDir: string; runAgent: boolean }) => {
      const result = await runSmoke({
        configPath: options.config,
        policyPath: options.policy,
        migrationsDir: options.migrationsDir,
        runAgent: options.runAgent,
      })
      process.stdout.write(`${result.report}\n`)
      process.exitCode = result.exitCode
    },
  )

// ---------------------------------------------------------------------------
// FR-ATT-40: live control of an already-running Claude Code session.
//
// `wait` blocking and then EXITING on arrival is the whole design: a blocked
// command that finishes is an event the surrounding session notices, which
// is what lets a Slack message reach a session already in progress without
// Relay injecting anything into a live process.
// ---------------------------------------------------------------------------

const liveCommand = program
  .command('live')
  .description('Drive a Slack thread from a Claude Code session that is already running')

function liveOptions(cmd: Command): Command {
  return cmd
    .requiredOption('--channel <id>', 'Slack channel or DM id, e.g. D0BPT8XL44Q')
    .requiredOption('--thread <ts>', "the thread's own ts, as Relay composed it")
    .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
}

type LiveOptions = { channel: string; thread: string; config: string; timeout?: string; text?: string }

/**
 * Rejects a non-numeric timeout rather than letting `Number()` yield NaN.
 * NaN reaches `setTimeout` as 0, so `--timeout abc` would return instantly
 * and read exactly like "nothing arrived", which is the worst possible
 * failure for a command whose entire job is to wait.
 */
export function parseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_SECONDS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--timeout must be a positive number of seconds, got "${raw}"`)
  }
  return parsed
}

async function withLivePool(options: LiveOptions, fn: (pool: Pool, workspaceId: string) => Promise<string>): Promise<void> {
  await withWorkspacePool(options.config, fn)
}

async function withWorkspacePool(configPath: string, fn: (pool: Pool, workspaceId: string) => Promise<string>): Promise<void> {
  const config = loadRelayConfig(configPath)
  const pool = createPool(await resolveOperatorDatabaseUrl(config, createSecretProvider(config)))
  try {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM workspaces ORDER BY created_at LIMIT 1')
    const workspaceId = rows[0]?.id
    if (!workspaceId) throw new Error('no workspace exists yet. Start the orchestrator and send one message first.')
    process.stdout.write(`${await fn(pool, workspaceId)}\n`)
  } finally {
    await closePool(pool)
  }
}

liveOptions(liveCommand.command('claim'))
  .description('Take control of a thread: Relay parks its messages instead of running its own loop')
  .action(async (options: LiveOptions) => {
    await withLivePool(options, (pool, workspaceId) =>
      runLiveClaim({ pool, workspaceId, channel: options.channel, thread: options.thread }),
    )
  })

liveOptions(liveCommand.command('wait'))
  .description('Block until a Slack message arrives for this thread, print it, and exit')
  .option('--timeout <seconds>', 'how long to wait before giving up', String(DEFAULT_WAIT_SECONDS))
  .action(async (options: LiveOptions) => {
    await withLivePool(options, (pool, workspaceId) =>
      runLiveWait({
        pool,
        workspaceId,
        channel: options.channel,
        thread: options.thread,
        timeoutSeconds: parseTimeoutSeconds(options.timeout),
      }),
    )
  })

liveOptions(liveCommand.command('say'))
  .description('Post an answer back into the thread, with an optional file')
  .option('--text <text>', 'the message to post')
  .option('--file <path>', 'a file to attach, such as a .md report (up to 100 MB)')
  .action(async (options: LiveOptions & { file?: string }) => {
    await withLivePool(options, (pool, workspaceId) =>
      runLiveSay({ pool, workspaceId, channel: options.channel, thread: options.thread, text: options.text ?? '', ...(options.file ? { file: options.file } : {}) }),
    )
  })

liveOptions(liveCommand.command('edit'))
  .description('Rewrite, in place, a message relay live say posted in this thread')
  .requiredOption('--id <status id>', 'the status id relay live say printed')
  .requiredOption('--text <text>', 'the new message')
  .action(async (options: LiveOptions & { id: string; text: string }) => {
    await withLivePool(options, (pool, workspaceId) =>
      runLiveEdit({ pool, workspaceId, channel: options.channel, thread: options.thread, id: options.id, text: options.text }),
    )
  })

liveOptions(liveCommand.command('react'))
  .description('Add an emoji reaction to one message in the thread')
  .requiredOption('--message <ts>', 'the ts of the message to react to')
  .requiredOption('--name <emoji>', 'the emoji name, for example eyes')
  .action(async (options: LiveOptions & { message: string; name: string }) => {
    await withLivePool(options, (pool, workspaceId) =>
      runLiveReact({ pool, workspaceId, channel: options.channel, thread: options.thread, message: options.message, name: options.name }),
    )
  })

liveCommand
  .command('drain')
  .description('Print any waiting Slack messages and exit at once. Intended for a Stop hook, so no waiter process is needed')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .option('--workspace-id <uuid>', 'which workspace to drain, required when more than one exists')
  .action(async (options: { config: string; workspaceId?: string }) => {
    const config = loadRelayConfig(options.config)
    const pool = createPool(await resolveOperatorDatabaseUrl(config, createSecretProvider(config)))
    try {
      const resolution = await resolveDrainWorkspace(pool, options.workspaceId)

      // Silence when nothing is parked: this runs at the end of every turn,
      // and a hook that talks constantly gets disabled.
      if (resolution.outcome === 'nothing_waiting') return

      // STDOUT, NOT STDERR, and exit 0. This is the half of the outage that
      // made the other half invisible. The operator's Stop hook ends in
      // `|| true`, so a non-zero exit says nothing, and stderr from a hook
      // is not what gets injected into the session. Writing the refusal to
      // stdout means the session itself reads "a drain could not proceed,
      // and here is why", which is the whole point: a message that cannot
      // be delivered must announce itself, because silence is
      // indistinguishable from having nothing to say.
      if (resolution.outcome === 'ambiguous') {
        process.stdout.write(`relay live drain could not deliver your Slack messages: ${resolution.reason}\n`)
        return
      }

      const out = await runLiveDrain(pool, resolution.workspaceId)
      if (out !== '') process.stdout.write(`${out}\n`)
    } finally {
      await closePool(pool)
    }
  })

liveOptions(liveCommand.command('release'))
  .description("Hand the thread back to Relay's own loop")
  .action(async (options: LiveOptions) => {
    await withLivePool(options, (pool, workspaceId) =>
      runLiveRelease({ pool, workspaceId, channel: options.channel, thread: options.thread }),
    )
  })

const killCommand = program
  .command('kill')
  .description('Engage or clear the kill switch; a running daemon applies it within one tick')

killCommand
  .command('engage')
  .description('Stop all work and refuse new work until cleared')
  .argument('<reason>', 'why, shown to anyone whose work is refused')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(async (reason: string, options: { config: string }) => {
    await withWorkspacePool(options.config, (pool, workspaceId) => runKillEngage(pool, workspaceId, reason))
  })

killCommand
  .command('clear')
  .description('Clear an engaged kill switch')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(async (options: { config: string }) => {
    await withWorkspacePool(options.config, (pool, workspaceId) => runKillClear(pool, workspaceId))
  })

const secretsCommand = program
  .command('secrets')
  .description("Manage relay's own keystore items: the macOS Keychain behind the relay-secrets helper, or the Linux Secret Service")

secretsCommand
  .command('set')
  .description('Store a value read from stdin (never from an argument), e.g. an MCP env var or a GitHub token')
  .argument('<name>', 'the keystore item name')
  .option('--replace', 'overwrite an existing item', false)
  .action(async (name: string, options: { replace: boolean }) => {
    if (process.stdin.isTTY) process.stderr.write(`Paste the value for ${name}, then press Enter and Ctrl-D:\n`)
    const result = await runSecretsSet(
      { name, value: await readStdin(), replace: options.replace },
      { helperPath: relaySecretsHelperPath(resolveRelayHome().path) },
    )
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

secretsCommand
  .command('migrate')
  .description(
    'Move the database URL into the keystore behind a relay_app role, create the approval receipt key, and ' +
      'recreate relay\'s keychain items so only relay-secrets can read them. Safe to run again.',
  )
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(async (options: { config: string }) => {
    const result = await runSecretsMigrate(
      { configPath: options.config },
      { helperPath: relaySecretsHelperPath(resolveRelayHome().path) },
    )
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

const principalsCommand = program
  .command('principals')
  .description('Manage Relay principals: the platform users mapped to allow work, per FR-CA-4')

principalsCommand
  .command('add')
  .description(
    'Provision a principal so an unmapped platform user can start work. The one, deliberate, ' +
      'operator-invoked way to turn "unmapped" into "mapped": Relay itself never auto-provisions one.',
  )
  .requiredOption('--platform <platform>', 'chat platform name, e.g. slack')
  .requiredOption(
    '--user <id>',
    "the platform's own user id, e.g. a Slack user id. An unmapped sender's own log line names it.",
  )
  .requiredOption('--display-name <name>', 'a human readable name, used only in logs and reports')
  .option('--role <role>', 'owner (approves risky actions, starts direct sessions) or member (default)')
  .option('--workspace-id <uuid>', 'skip the platform lookup and provision directly into this workspace uuid')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(
    async (options: {
      platform: string
      user: string
      displayName: string
      role?: string
      workspaceId?: string
      config: string
    }) => {
      const config = loadRelayConfig(options.config)
      const pool = createPool(await resolveOperatorDatabaseUrl(config, createSecretProvider(config)))
      try {
        const result = await runPrincipalsAdd(pool, {
          platform: options.platform,
          platformUserId: options.user,
          displayName: options.displayName,
          ...(options.role !== undefined ? { role: options.role } : {}),
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        })
        process.stdout.write(
          `Provisioned principal ${result.principalId} for platform user "${options.user}" ` +
            `in workspace ${result.workspaceId}.\n`,
        )
      } catch (error) {
        process.stderr.write(
          `relay principals add failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        process.exitCode = 1
      } finally {
        await closePool(pool)
      }
    },
  )

program
  .command('notify')
  .description('Message the user in Slack by DM (the operators by default); the running daemon sends it')
  .argument('[text]', 'a short message in standard Markdown; read from stdin when left out')
  .option('--to <slack user id>', 'a mapped Slack user to message instead of the operators')
  .option('--workspace-id <uuid>', 'the workspace, when more than one Slack workspace exists')
  .option('--no-attach', 'do not route replies back to the Claude Code chat running this command')
  .option('--file <path>', 'a file to post in the DM thread, such as a .md plan to review (up to 100 MB)')
  .option('--peer <name [ref]>', 'this chat exactly as ListAgents names it, e.g. "agents-39 [a1a227]", so replies reach it even when other chats share the folder')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(async (text: string | undefined, options: { to?: string; workspaceId?: string; attach: boolean; peer?: string; file?: string; config: string }) => {
    const config = loadRelayConfig(options.config)
    const pool = createPool(await resolveOperatorDatabaseUrl(config, createSecretProvider(config)))
    try {
      const body = text ?? (await readStdin())
      // Run from a Claude Code chat, replies come back to that chat.
      const chatId = options.attach ? process.env.CLAUDE_CODE_SESSION_ID : undefined
      const sent = await runNotify(pool, {
        text: body,
        ...(options.to ? { to: options.to } : {}),
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(chatId ? { attach: { engineSessionId: chatId, cwd: process.cwd(), ...(options.peer ? { peer: options.peer } : {}), ...(config.failover ? { host: config.failover.host } : {}) } } : {}),
        ...(options.file ? { file: options.file } : {}),
      })
      for (const { userId, attached, fileQueued } of sent) {
        const fileNote = options.file ? (fileQueued ? ' The file follows in the thread.' : ' The file was not sent: the DM did not go out in time.') : ''
        process.stdout.write(`${chatId ? `${attached ? 'Sent' : 'Queued, not yet sent'} to ${userId}; ${attached ? 'replies come back to this chat' : 'a reply will start an autonomous task'}.` : `Queued for ${userId}.`}${fileNote}\n`)
      }
    } catch (error) {
      process.stderr.write(`relay notify failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    } finally {
      await closePool(pool)
    }
  })

program
  .command('ui')
  .description('Print (and open) a one-time login link to the local setup page for projects, personas and teams')
  .option('--as <slack user id>', 'the owner to log in as, when the workspace has more than one')
  .option('--workspace-id <uuid>', 'the workspace, when more than one Slack workspace exists')
  .option('--no-open', 'print the link without opening the browser')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(async (options: { as?: string; workspaceId?: string; open: boolean; config: string }) => {
    const config = loadRelayConfig(options.config)
    if (config.ui?.enabled === false) {
      process.stderr.write('relay ui failed: the setup page is off (ui.enabled is false in the config).\n')
      process.exitCode = 1
      return
    }
    const pool = createPool(await resolveOperatorDatabaseUrl(config, createSecretProvider(config)))
    try {
      const link = await runUi(pool, {
        port: config.ui?.port ?? DEFAULT_UI_PORT,
        ...(options.as !== undefined ? { as: options.as } : {}),
        ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
      })
      process.stdout.write(`Log in as ${link.slackUserId} (works once, for 10 minutes):\n${link.url}\n`)
      if (options.open && process.platform === 'darwin') spawn('open', [link.url], { detached: true, stdio: 'ignore' }).unref()
    } catch (error) {
      process.stderr.write(`relay ui failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    } finally {
      await closePool(pool)
    }
  })

registerTeamCommands(program)

const reposCommand = program.command('repos').description('Manage the repositories Relay may work in (config/repos.yaml)')

reposCommand
  .command('add')
  .description('Register a git repository with read and write access; publish is never granted here')
  .argument('<path>', 'a folder inside the repository')
  .option('--name <name>', 'the name chats use for it; defaults to the folder name')
  .action(async (path: string, options: { name?: string }) => {
    const result = await runReposAdd({ path, reposPath: defaultReposPath(), ...(options.name !== undefined ? { name: options.name } : {}) })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

const envCommand = program
  .command('env')
  .description("Envs for the sessions Relay starts, kept in the shared database: defaults, per laptop (--host), per folder (--folder), or both")

type EnvOptions = EnvScopeOptions & { config: string }

function envScopeOptions(cmd: Command): Command {
  return cmd
    .option('--host <name>', "only for this laptop: its failover host name")
    .option('--folder <path>', 'only for sessions in this folder, its subfolders and worktrees of a registered repo there')
    .option('--workspace-id <uuid>', 'the workspace, when more than one exists')
    .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
}

/** Connects for one `relay env` command and prints its result. */
async function withEnvPool(configPath: string, run: (pool: Pool, config: ReturnType<typeof loadRelayConfig>) => Promise<EnvCommandResult>): Promise<void> {
  const config = loadRelayConfig(configPath)
  const pool = createPool(await resolveOperatorDatabaseUrl(config, createSecretProvider(config)))
  try {
    const result = await run(pool, config)
    for (const line of result.err) process.stderr.write(`${line}\n`)
    for (const line of result.out) process.stdout.write(`${line}\n`)
    process.exitCode = result.exitCode
  } finally {
    await closePool(pool)
  }
}

function scopeFlags(options: EnvOptions): EnvScopeOptions {
  return {
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.folder !== undefined ? { folder: options.folder } : {}),
    ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
  }
}

envScopeOptions(envCommand.command('add'))
  .description('Store an env, replacing one at the same scope. The value is asked for with hidden typing, or read from stdin; never give it as an argument')
  .argument('<name>', 'the env name, e.g. PLAYWRIGHT_MCP_EXTENSION_TOKEN')
  .action(async (name: string, options: EnvOptions) => {
    await withEnvPool(options.config, (pool, config) =>
      runEnvAdd(name, scopeFlags(options), {
        pool,
        failoverOn: config.failover !== undefined,
        readValue: () => (process.stdin.isTTY ? promptHidden(`Value for ${name} (hidden): `) : readStdin()),
      }),
    )
  })

envScopeOptions(envCommand.command('list'))
  .description('List stored envs with their scope; values are never shown')
  .action(async (options: EnvOptions) => {
    await withEnvPool(options.config, (pool) => runEnvList(scopeFlags(options), { pool }))
  })

envScopeOptions(envCommand.command('remove'))
  .description('Remove the env stored at exactly this scope; sessions fall back to the next layer down')
  .argument('<name>', 'the env name')
  .action(async (name: string, options: EnvOptions) => {
    await withEnvPool(options.config, (pool) => runEnvRemove(name, scopeFlags(options), { pool }))
  })

const channelCommand = program.command('channel').description('Slack channel settings kept in the shared database')

channelCommand
  .command('folder')
  .description("Show, set or clear the folder new threads in a channel start in. It is the channel's project folder, so it wins over the channel description")
  .argument('<channel-id>', 'the Slack channel id, e.g. C0123ABC')
  .argument('[folder]', 'the folder to set; leave out to show the stored one')
  .option('--clear', 'remove the stored folder', false)
  .option('--workspace-id <uuid>', 'the workspace, when more than one exists')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(async (channel: string, folder: string | undefined, options: { clear: boolean; workspaceId?: string; config: string }) => {
    const config = loadRelayConfig(options.config)
    const pool = createPool(await resolveOperatorDatabaseUrl(config, createSecretProvider(config)))
    try {
      const result = await runChannelFolder(
        { channel, clear: options.clear, ...(folder !== undefined ? { folder } : {}), ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}) },
        { pool, isFolder: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true },
      )
      ;(result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`)
      process.exitCode = result.exitCode
    } catch (error) {
      process.stderr.write(`relay channel folder failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    } finally {
      await closePool(pool)
    }
  })

program
  .command('status')
  .description('Whether the Relay daemon is running (from launchd or systemd), its last log line and its log path; exits 1 when it is not running')
  .action(() => {
    const result = runStatus()
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

const dbCommand = program.command('db').description("Relay's Postgres database")

dbCommand
  .command('create')
  .description(
    'Create the role and database named by database.url when it does not connect yet. On Linux this runs ' +
      '`sudo -u postgres psql`, so sudo asks for your password; on macOS it runs psql as you.',
  )
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(async (options: { config: string }) => {
    const result = await runDbCreate({ configPath: options.config })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

dbCommand
  .command('move')
  .description(
    'Copy this Relay database into an empty Postgres once (the shared one for failover), check every table, then point ' +
      'database.url at it through the keystore. Stop the daemon first. Pass the URL on stdin to keep its password out of ' +
      'your shell history and the process list.',
  )
  .argument('[url]', 'the target postgres:// URL; read from stdin when left out')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(async (url: string | undefined, options: { config: string }) => {
    if (url === undefined && process.stdin.isTTY) process.stderr.write('Paste the target database URL, then press Enter and Ctrl-D:\n')
    const result = await runDbMove({ configPath: options.config, targetUrl: url ?? (await readStdin()) })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('setup')
  .description(
    'Set Relay up on macOS or Linux: config, database, secrets, Slack tokens, a repository and the supervisor, ' +
      'then relay doctor. Safe to run again; finished steps are skipped.',
  )
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .option('-p, --policy <path>', 'policy path', defaultPolicyPath())
  .option('--repo <path>', 'the repository to register when none is, instead of asking')
  .action(async (options: { config: string; policy: string; repo?: string }) => {
    const helperPath = relaySecretsHelperPath(resolveRelayHome().path)
    const reposPath = defaultReposPath()
    const steps = buildSetupSteps({
      platform: process.platform,
      configPath: options.config,
      configExists: () => existsSync(options.config),
      init: () =>
        runInit({
          configPath: options.config,
          policyPath: options.policy,
          yes: false,
          force: false,
          hardBlockedOrigins: [],
          databaseUrl: DEFAULT_DATABASE_URL,
          redisUrl: DEFAULT_REDIS_URL,
        }),
      dbCreate: () => runDbCreate({ configPath: options.config }),
      installService: async (start) =>
        runInstallService({ repoRoot: RELAY_ROOT, binaries: serviceBinaries(loadRelayConfig(options.config).autonomous), start }),
      serviceInstalled: () => serviceInstalled(),
      secretsMigrate: () => runSecretsMigrate({ configPath: options.config }, { helperPath }),
      hasSecret: (name) => createSecretProvider(loadRelayConfig(options.config)).has(name),
      setSecret: (name, value) => runSecretsSet({ name, value, replace: false }, { helperPath }),
      registeredRepos: () => loadRepoRegistryIfPresent(reposPath).repos.map((repo) => repo.name),
      reposAdd: (path) => runReposAdd({ path, reposPath }),
      doctor: async () => {
        const { results, exitCode, elapsedMs } = await runDoctor({ configPath: options.config, policyPath: options.policy })
        // Reported, not a setup failure: some checks (the Linux sandbox) cannot pass on every machine.
        return { report: `${formatResults(results, { elapsedMs })}\nrelay doctor exit code: ${exitCode}`, exitCode: 0 }
      },
      interactive: process.stdin.isTTY === true,
      askHidden: promptHidden,
      askLine: promptLine,
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
      cwd: process.cwd(),
    })
    const result = await runSetup(steps, (text) => process.stdout.write(text))
    process.stdout.write(`\n${result.report}\n`)
    process.exitCode = result.exitCode
  })

/**
 * `relay claude [args]` and `relay codex [args]` (src/cli/launch.ts). Taken
 * before commander parses, so every argument, --help included, reaches the
 * real command untouched.
 */
async function launchChat(client: 'claude' | 'codex', userArgs: readonly string[]): Promise<number> {
  const config = loadRelayConfig(defaultConfigPath())
  const secrets = createSecretProvider(config)
  const host = config.failover?.host ?? null
  const cwd = process.cwd()
  const bin = client === 'claude' ? (config.autonomous?.claude_bin ?? 'claude') : (config.autonomous?.codex_bin ?? 'codex')
  const codexVersionNow = client === 'codex' ? codexVersion(bin).catch(() => 'unknown') : Promise.resolve('unknown')
  const relayHome = resolveRelayHome().path
  const prepareDeps: RelayPrepareDeps = {
    client,
    cwd,
    host,
    dmTo: config.launcher?.dm_to,
    openPool: async () => createPool(await resolveOperatorDatabaseUrl(config, secrets)),
    closePool,
    secrets,
    repos: () => loadRepoRegistryIfPresent(defaultReposPath()).repos.map((repo) => repo.path),
  }
  return runLaunch({
    client,
    bin,
    userArgs,
    cwd,
    host,
    accounts: () => readAccountPool(),
    withCooldowns: async (use) => {
      const redis = createRedis(config.redis.url)
      try {
        if (!(await waitForReady(redis))) throw new Error(`Redis at ${new URL(config.redis.url).host} did not answer, so login cooldowns cannot be read`)
        return await use(new RedisCooldownStore(redis))
      } finally {
        await closeRedis(redis)
      }
    },
    isCodexEligible: async (account) => isProvenEligible(await readCodexEligibility(relayHome), account.key, await codexVersionNow),
    prepare: relayPrepare(prepareDeps),
    // Every Codex login's sessions folder links to the default login's, so one folder holds every chat.
    ...(client === 'codex'
      ? {
          codex: {
            sessionsRoot: join(homedir(), '.codex', 'sessions'),
            ...relayCodexLink(prepareDeps),
            writeRecord: (record) => writeCodexChatRecord(record),
            deleteRecord: (chatId) => deleteCodexChatRecord(chatId),
          },
        }
      : {}),
    run: runInTerminal,
    readTranscript: readIfPresent,
    say: (text) => process.stderr.write(`relay: ${text}\n`),
    baseEnv: process.env,
  })
}

const launched = process.argv[2]
if (launched === 'claude' || launched === 'codex') {
  try {
    process.exitCode = await launchChat(launched, process.argv.slice(3))
  } catch (error) {
    process.stderr.write(`relay ${launched} did not start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} else {
  await program.parseAsync(process.argv)
}
