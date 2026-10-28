#!/usr/bin/env node
import { runKillClear, runKillEngage } from './cli/kill.js'
import { Command } from 'commander'
import type { Pool } from 'pg'
import { runPrincipalsAdd } from './cli/principals.js'
import { runNotify } from './cli/notify.js'
import { DEFAULT_PROFILES_PATH as PROFILE_LOGIN_PROFILES_PATH, runProfileLogin } from './cli/profile-login.js'
import { formatChromeProfiles, listChromeProfiles, runProfileClone } from './cli/profile-clone.js'
import { runInstallService, runUninstallService, serviceBinaries } from './cli/service.js'
import {
  runProfileAdd,
  runProfileOrigins,
  runProfileRegistry,
  runProfileRemove,
} from './cli/profile-registry.js'
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_DATABASE_URL,
  DEFAULT_POLICY_PATH,
  DEFAULT_PROFILES_EXAMPLE_PATH,
  DEFAULT_PROFILES_PATH,
  DEFAULT_REDIS_URL,
  runInit,
} from './cli/init.js'
import {
  DEFAULT_WAIT_SECONDS,
  resolveDrainWorkspace,
  runLiveClaim,
  runLiveDrain,
  runLiveReact,
  runLiveRelease,
  runLiveSay,
  runLiveWait,
} from './cli/live.js'
import {
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_SMOKE_CONFIG_PATH,
  DEFAULT_SMOKE_POLICY_PATH,
  DEFAULT_SMOKE_PROFILES_PATH,
  runSmoke,
} from './cli/smoke.js'
import { createSecretProvider } from './secrets/index.js'
import { loadRelayConfig } from './config/load.js'
import { ConfigError } from './config/errors.js'
import { resolveOperatorDatabaseUrl } from './config/database-url.js'
import { closePool, createPool } from './db/pool.js'
import { formatResults, runDoctor } from './doctor/run.js'
import { RELAY_VERSION } from './version.js'
import { defaultConfigPath, defaultPolicyPath, resolveRelayHome } from './config/paths.js'
import { runSecretsMigrate, runSecretsSet } from './cli/secrets.js'
import { relaySecretsHelperPath } from './secrets/keychain.js'

/** Commander's accumulator for a repeatable option, so `--origin a --origin b` yields both rather than the last one. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

const program = new Command()
program.name('relay').description('Chat-driven computer-use agent').version(RELAY_VERSION)

program
  .command('doctor')
  .description('Diagnose the installation and report every dependency')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .option('-p, --policy <path>', 'policy path', defaultPolicyPath())
  .action(async (options: { config: string; policy: string }) => {
    const { results, exitCode } = await runDoctor({
      configPath: options.config,
      policyPath: options.policy,
    })
    process.stdout.write(`${formatResults(results)}\n`)
    process.exitCode = exitCode
  })

program
  .command('init')
  .description(
    'Wizard that takes a clean machine to a working installation: writes starter config, policy, and ' +
      'profiles, reviews the hard-blocked origin list, reports browser tier availability, and finishes with ' +
      'relay doctor. Never prompts when run without a terminal, e.g. in CI.',
  )
  .option('-c, --config <path>', 'runtime config path to write or check', DEFAULT_CONFIG_PATH)
  .option('-p, --policy <path>', 'policy path to write or check', DEFAULT_POLICY_PATH)
  .option('--profiles <path>', 'profile registry path to write or check', DEFAULT_PROFILES_PATH)
  .option('--profiles-example <path>', 'worked example copied into --profiles', DEFAULT_PROFILES_EXAMPLE_PATH)
  .option('-y, --yes', 'never prompt; use flags and built-in defaults only, for CI and scripts', false)
  .option('--force', 'overwrite an existing file instead of leaving it untouched', false)
  .option('--skip-profiles', 'do not write or offer to write a profile registry', false)
  .option(
    '--with-example-profiles',
    'with --yes and no profiles file yet, copy the worked example instead of leaving profiles unconfigured',
    false,
  )
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
      profiles: string
      profilesExample: string
      yes: boolean
      force: boolean
      skipProfiles: boolean
      withExampleProfiles: boolean
      hardBlockedOrigin: string[]
      databaseUrl: string
      redisUrl: string
    }) => {
      const result = await runInit({
        configPath: options.config,
        policyPath: options.policy,
        profilesPath: options.profiles,
        profilesExamplePath: options.profilesExample,
        yes: options.yes,
        force: options.force,
        skipProfiles: options.skipProfiles,
        withExampleProfiles: options.withExampleProfiles,
        hardBlockedOrigins: options.hardBlockedOrigin,
        databaseUrl: options.databaseUrl,
        redisUrl: options.redisUrl,
      })
      process.stdout.write(`${result.report}\n`)
      process.exitCode = result.exitCode
    },
  )

program
  .command('profile-login')
  .argument('<name>', 'the short name of a profile in the registry')
  .description(
    'Open a registered browser profile in a normal window so you can sign in to the sites it is for. Relay has ' +
      'no credentials and never will, so this one step is done by hand, once; after it, the profile\'s own cookie ' +
      'jar carries the session. Refuses a profile Relay could never drive, rather than leaving you with a working ' +
      'login and a broken profile.',
  )
  .option('--profiles <path>', 'profile registry path', PROFILE_LOGIN_PROFILES_PATH)
  .action((name: string, options: { profiles: string }) => {
    const result = runProfileLogin({ name, profilesPath: options.profiles })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('profile-list')
  .description(
    "List the Chrome profiles available to clone, with their display names and signed-in accounts. The first " +
      'column is the folder name that profile-clone takes, which is the one thing Chrome never shows you.',
  )
  .action(() => {
    process.stdout.write(`${formatChromeProfiles(listChromeProfiles())}\n`)
  })

program
  .command('profile-clone')
  .description(
    "Copy an already-signed-in Chrome profile into a dedicated automation directory Relay can drive. The " +
      'cookies come with it, so you do not sign in again. Chrome must be quit: copying a live cookie store ' +
      'yields a clone that is silently signed out.',
  )
  .requiredOption('--from <folder>', 'the Chrome profile FOLDER name, e.g. "Profile 10" (see relay profile-list)')
  .requiredOption('--to <name>', 'the Relay profile name, also the new directory name')
  .option('--root <path>', 'where cloned profiles are written (default: ~/chrome-profiles)')
  .option('--force', 'overwrite an existing destination', false)
  .option(
    '--origin <pattern>',
    'an origin the cloned profile may reach. Repeatable. Given at least one, the clone REGISTERS itself in the profile registry, so there is nothing to paste by hand',
    collect,
    [],
  )
  .option('--project <name>', 'the project or client this profile belongs to, used when resolving a profile for a task')
  .option('--classification <kind>', 'work, client or personal (default: client)')
  .option('--no-register', 'clone only, and print the registry entry instead of writing it')
  .action((options: { from: string; to: string; root?: string; force: boolean; origin: string[]; project?: string; classification?: string; register: boolean }) => {
    const result = runProfileClone({
      from: options.from,
      to: options.to,
      force: options.force,
      suppressRegistryBlock: options.register !== false && options.origin.length > 0,
      ...(options.root !== undefined ? { root: options.root } : {}),
    })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode

    // Registration is a second, separate step on purpose: a clone that
    // succeeded is worth keeping even if the registry edit is refused, and
    // the operator should be able to see which of the two failed.
    if (result.exitCode !== 0 || options.register === false || options.origin.length === 0) {
      if (result.exitCode === 0 && options.origin.length === 0) {
        process.stdout.write(
          `\nNot registered: no --origin was given, and a profile with no allowlist is refused by FR-PRF-1.\n` +
            `Register it once you know what it should reach:\n` +
            `  relay profile-add ${options.to} --dir ${result.destination ?? `~/chrome-profiles/${options.to}`} --origin example.com\n`,
        )
      }
      return
    }

    const registered = runProfileAdd({
      name: options.to,
      dir: result.destination ?? '',
      origins: options.origin,
      force: options.force,
      ...(options.project !== undefined ? { project: options.project } : {}),
      ...(options.classification !== undefined ? { classification: options.classification } : {}),
    })
    process.stdout.write(`\n${registered.report}\n`)
    if (registered.exitCode !== 0) process.exitCode = registered.exitCode
  })

program
  .command('profile-add')
  .argument('<name>', 'the short name a task will use to ask for this profile')
  .description(
    'Register a browser profile directory so Relay can drive it. Use this for a directory that already exists, ' +
      'including one relay profile-clone made earlier. Every profile must declare the origins it may reach.',
  )
  .requiredOption('--dir <path>', "the profile's user-data directory")
  .option('--origin <pattern>', 'an origin this profile may reach. Repeatable', collect, [])
  .option('--profile-directory <name>', "Chrome's profile folder inside that directory (default: Default)")
  .option('--classification <kind>', 'work, client or personal (default: client)')
  .option('--project <name>', 'the project or client this profile belongs to')
  .option('--description <text>', 'what this profile is for')
  .option('--tier <n>', 'pin to browser tier 2 or 3, where origin scoping is ENFORCED (client profiles default to 2)', (value: string) => Number.parseInt(value, 10))
  .option('--force', 'replace an existing entry of the same name', false)
  .option('--profiles <path>', 'profile registry path', DEFAULT_PROFILES_PATH)
  .action((name: string, options: { dir: string; origin: string[]; profileDirectory?: string; classification?: string; project?: string; description?: string; tier?: number; force: boolean; profiles: string }) => {
    const result = runProfileAdd({
      name,
      dir: options.dir,
      origins: options.origin,
      force: options.force,
      profilesPath: options.profiles,
      ...(options.profileDirectory !== undefined ? { profileDirectory: options.profileDirectory } : {}),
      ...(options.classification !== undefined ? { classification: options.classification } : {}),
      ...(options.project !== undefined ? { project: options.project } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.tier !== undefined ? { tier: options.tier } : {}),
    })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('profile-origins')
  .argument('<name>', 'the registered profile to re-scope')
  .description(
    'Change what a registered profile may reach. This is the edit that recurs: an allowlist starts narrow and ' +
      'widens as real tasks are refused. An edit that would leave a profile with no allowed origins is refused.',
  )
  .option('--allow <pattern>', 'add an allowed origin. Repeatable', collect, [])
  .option('--deny <pattern>', 'add a denied origin, which overrides the allowlist. Repeatable', collect, [])
  .option('--remove <pattern>', 'remove a pattern from both lists. Repeatable', collect, [])
  .option('--profiles <path>', 'profile registry path', DEFAULT_PROFILES_PATH)
  .action((name: string, options: { allow: string[]; deny: string[]; remove: string[]; profiles: string }) => {
    const result = runProfileOrigins({
      name,
      allow: options.allow,
      deny: options.deny,
      remove: options.remove,
      profilesPath: options.profiles,
    })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('profile-remove')
  .argument('<name>', 'the registered profile to unregister')
  .description(
    'Unregister a profile. The cloned directory and its cookies are left on disk: deleting credential material ' +
      'as a side effect of a config edit is the wrong default in the direction you cannot undo.',
  )
  .option('--profiles <path>', 'profile registry path', DEFAULT_PROFILES_PATH)
  .action((name: string, options: { profiles: string }) => {
    const result = runProfileRemove({ name, profilesPath: options.profiles })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('install-service')
  .description(
    'Install a launchd agent so the daemon restarts when it exits and starts at login. The daemon exits on ' +
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
      repoRoot: process.cwd(),
      ...(options.relayHome !== undefined ? { relayHome: options.relayHome } : {}),
      binaries: serviceBinaries(autonomous),
      start: options.start,
    })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('uninstall-service')
  .description('Remove the launchd agent. Relay will no longer start at login or restart itself.')
  .action(() => {
    const result = runUninstallService()
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('profile-registry')
  .description(
    'Show the profiles Relay has registered and what each may reach. profile-list shows Chrome profiles ' +
      'available to clone; this shows the ones Relay can actually drive.',
  )
  .option('--profiles <path>', 'profile registry path', DEFAULT_PROFILES_PATH)
  .action((options: { profiles: string }) => {
    const result = runProfileRegistry({ profilesPath: options.profiles })
    process.stdout.write(`${result.report}\n`)
    process.exitCode = result.exitCode
  })

program
  .command('smoke')
  .description(
    'Proves the installation actually works: Postgres, Redis, migrations, Slack, and browser tier ' +
      'availability always run; a real end-to-end agent run only runs with --run-agent, since it costs money.',
  )
  .option('-c, --config <path>', 'runtime config path', DEFAULT_SMOKE_CONFIG_PATH)
  .option('-p, --policy <path>', 'policy path', DEFAULT_SMOKE_POLICY_PATH)
  .option('--profiles <path>', 'profile registry path', DEFAULT_SMOKE_PROFILES_PATH)
  .option('--migrations-dir <path>', 'directory of SQL migrations to apply', DEFAULT_MIGRATIONS_DIR)
  .option(
    '--run-agent',
    'also run a real, governed agent run through the echo capability. Spawns the claude CLI and costs money per invocation; never runs without this flag',
    false,
  )
  .action(
    async (options: { config: string; policy: string; profiles: string; migrationsDir: string; runAgent: boolean }) => {
      const result = await runSmoke({
        configPath: options.config,
        policyPath: options.policy,
        profilesPath: options.profiles,
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
  .option('--file <path>', 'a file to attach, such as a .md report (up to 1 GB)')
  .action(async (options: LiveOptions & { file?: string }) => {
    await withLivePool(options, (pool, workspaceId) =>
      runLiveSay({ pool, workspaceId, channel: options.channel, thread: options.thread, text: options.text ?? '', ...(options.file ? { file: options.file } : {}) }),
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
  .description("Manage relay's own keychain items, readable only through the relay-secrets helper")

/** Reads all of stdin, dropping the one trailing newline `echo` or a heredoc adds. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

secretsCommand
  .command('set')
  .description('Store a value read from stdin (never from an argument), e.g. an MCP env var or a GitHub token')
  .argument('<name>', 'the keychain item name')
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
  .option('--role <role>', 'role to grant', 'operator')
  .option('--workspace-id <uuid>', 'skip the platform lookup and provision directly into this workspace uuid')
  .option('-c, --config <path>', 'runtime config path', defaultConfigPath())
  .action(
    async (options: {
      platform: string
      user: string
      displayName: string
      role: string
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
          roles: [options.role],
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
  .argument('[text]', 'a short Slack mrkdwn message; read from stdin when left out')
  .option('--to <slack user id>', 'a mapped Slack user to message instead of the operators')
  .option('--workspace-id <uuid>', 'the workspace, when more than one Slack workspace exists')
  .option('--no-attach', 'do not route replies back to the Claude Code chat running this command')
  .option('--file <path>', 'a file to post in the DM thread, such as a .md plan to review (up to 1 GB)')
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
        ...(chatId ? { attach: { engineSessionId: chatId, cwd: process.cwd(), ...(options.peer ? { peer: options.peer } : {}) } } : {}),
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

await program.parseAsync(process.argv)
