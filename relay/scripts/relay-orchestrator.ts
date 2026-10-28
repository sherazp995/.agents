#!/usr/bin/env node
/**
 * The real end-to-end path Task 8's brief asks for: a runnable process that
 * connects to a real Slack workspace, resolves workspace and principal
 * identity, fails closed on an unmapped sender, finds or creates a session
 * per thread, runs the agent loop, and posts progress and a final report
 * into the thread, all through the durable outbox with a real drain
 * schedule behind it.
 *
 * This is intentionally a THIN wrapper: every real decision lives in
 * src/orchestrator.ts, so this script is just what makes that module a
 * running process rather than a library nothing calls, closing PRE-1 for
 * good (see src/orchestrator.ts's scheduleOutboxDrain).
 *
 * scripts/slack-smoke.ts still exists and still proves ProgressReporter
 * posts and edits against a real workspace end to end. This script is a
 * sibling, not a replacement: it proves the FULL pipeline, workspace and
 * principal resolution, session and run persistence, the agent loop, and
 * the final report, none of which slack-smoke.ts exercises.
 *
 * Usage: pnpm orchestrator:live
 *
 * THE LIVE CRITERION IS NOT THIS SCRIPT'S TO CLAIM. Running this script
 * against a real workspace and sending it a real DM is the operator's own
 * verification step; see the task report for the exact command and what to
 * watch for. This file only has to run correctly when asked; it does not
 * run itself as part of `pnpm test`.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAutonomousBudget, loadPolicy, loadRelayConfig } from '../src/config/load.js'
import type { RelayConfig } from '../src/config/schema.js'
import { createDaemonSecretProvider } from '../src/secrets/daemon.js'
import { resolveDatabaseUrl } from '../src/config/database-url.js'
import { defaultReposPath, resolveRelayHome } from '../src/config/paths.js'
import { createLogger, type Logger } from '../src/obs/logger.js'
import { createRotatingLogDestination } from '../src/obs/rotation.js'
import { createPool, closePool } from '../src/db/pool.js'
import { applyMigrations } from '../src/db/migrate.js'
import { startOrchestrator, type StartOrchestratorOptions } from '../src/orchestrator.js'
import { createRedis } from '../src/redis/client.js'
import { APPROVAL_RECEIPT_KEY_SECRET } from '../src/secrets/keychain.js'
import type { SecretProvider } from '../src/secrets/provider.js'

const CONFIG_PATH = process.env.RELAY_CONFIG_PATH ?? 'config/relay.config.yaml'
const POLICY_PATH = process.env.RELAY_POLICY_PATH ?? 'config/policy.yaml'

/**
 * How long startup may take before the process gives up and exits.
 *
 * Generous, because a cold start applies migrations and negotiates a
 * websocket, and a supervisor restarting a healthy-but-slow process is its
 * own kind of outage. The point is not to be tight, it is to be finite.
 */
const STARTUP_DEADLINE_MS = 90_000

/**
 * Rejects if `pending` has not settled within `deadlineMs`.
 *
 * The timer is unref'd so it cannot itself hold the process open, and it is
 * cleared on both paths so a fast startup does not leave one pending.
 */
export async function withStartupDeadline<T>(
  pending: Promise<T>,
  deadlineMs: number,
  log: Logger,
  /**
   * Tears down a startup that finishes AFTER the deadline has already been
   * given up on. See this function's own comment on the orphan.
   */
  disposeLate: (value: T) => Promise<void> | void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let expiredAlready = false
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expiredAlready = true
      log.error(
        { deadlineMs },
        'the orchestrator did not finish starting within its deadline. Slack Socket Mode may be reachable ' +
          'over REST while its websocket never completes, which leaves the process alive and unable to ' +
          'receive anything. Exiting so a supervisor can retry.',
      )
      reject(new Error(`startup did not complete within ${deadlineMs}ms`))
    }, deadlineMs)
    timer.unref()
  })

  /**
   * THE ORPHAN THIS EXISTS FOR, observed in production rather than
   * imagined.
   *
   * Racing a pending startup against a deadline abandons the startup; it
   * does not cancel it. When Slack's websocket eventually completed, two
   * minutes after the deadline had already fired, `startOrchestrator`
   * resolved into a process that had given up on it: the pool was closed,
   * the failure had been logged, and the exit code was set. The handle it
   * returned then installed its outbound-drain timer on that closed pool,
   * which threw every two seconds forever AND kept the event loop alive, so
   * the process never exited.
   *
   * The result was the worst available state, and precisely the one the
   * deadline was added to prevent: a daemon that is running, is listed by
   * `pgrep`, has never connected to Slack, and cannot ever serve a message.
   * It looked alive.
   *
   * So a late arrival is adopted and stopped. `void`ed deliberately: this
   * runs long after the caller has moved on, and its only job is to stop
   * the orphan doing damage.
   */
  void pending.then(
    (value) => {
      if (!expiredAlready) return
      log.warn(
        'the orchestrator finished starting after its deadline had already been given up on; stopping the ' +
          'orphaned startup so it cannot install timers on torn-down resources',
      )
      void Promise.resolve(disposeLate(value)).catch((error: unknown) => {
        log.error({ err: error }, 'the orphaned startup could not be stopped cleanly')
      })
    },
    () => {
      // A startup that failed on its own needs no disposal, and its
      // rejection is already the caller's via the race below.
    },
  )

  try {
    return await Promise.race([pending, expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** How often Slack connectivity is proved rather than assumed. Frequent enough that a deaf socket is caught in under a minute, rare enough to be free. */
const HEALTH_CHECK_INTERVAL_MS = 30_000
/** Consecutive failures before exiting. More than one, so a single blip or a brief network drop does not restart a healthy process. */
const MAX_HEALTH_FAILURES = 3

/**
 * Waits for the destination `rotating-file-stream` builds to actually open
 * before this process trusts it, rather than assuming it opened because
 * construction did not throw: `createRotatingLogDestination` opens the file
 * lazily on its first write, not at construction, so a bad path or a
 * permissions problem only ever surfaces as an 'error' event on that first
 * write, confirmed empirically against a nonexistent directory. The probe
 * write is an empty string precisely so it forces that lazy open without
 * emitting a real, premature log line ahead of the caller's first one.
 */
function probeOpens(destination: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      destination.off('open', onOpen)
      reject(error)
    }
    const onOpen = (): void => {
      destination.off('error', onError)
      resolve()
    }
    destination.once('error', onError)
    destination.once('open', onOpen)
    destination.write('')
  })
}

/**
 * Chooses the daemon's log destination, per FR-OBS-1. A configured
 * `logging.file` gets the rotating, size-capped destination
 * src/obs/rotation.ts already implements; an unconfigured one keeps today's
 * plain stdout behaviour unchanged, since `createLogger`'s own default
 * destination parameter already is `process.stdout`.
 *
 * A file that cannot be opened is a startup failure: this rejects rather
 * than falling back to stdout, matching how `loadPolicy` and
 * `loadRelayConfig` already refuse to let the process start on a bad config
 * file instead of continuing on a guessed default. An operator who asked for
 * file logging and silently got stdout instead, or silently got nothing,
 * would not find out until they went looking for a log file that was never
 * there, which is exactly the failure mode this project spent P0.1 through
 * P0.4 eliminating. A startup failure surfaces immediately in `main`'s own
 * `catch` below, on stderr, with a non-zero exit, where an operator or
 * supervisor cannot miss it.
 *
 * A failure that happens after startup (disk fills, the file is deleted out
 * from under the process) is reported the same way this file's own Slack
 * health check already handles a dead connection: written to stderr as
 * loudly as possible, then the process exits so a supervisor restarts it,
 * rather than the daemon continuing to run with logging it can no longer
 * prove is happening.
 */
export async function createDaemonLogger(config: RelayConfig): Promise<Logger> {
  const file = config.logging.file
  if (file === undefined) return createLogger(config.logging.level)

  // Built conditionally, not as a literal with possibly-undefined values,
  // because tsconfig's `exactOptionalPropertyTypes` treats `{ foo: undefined
  // }` as distinct from omitting `foo` entirely, and RotationOptions' own
  // fields are typed as absent-or-number, never explicitly undefined.
  const rotationOptions: Parameters<typeof createRotatingLogDestination>[1] = {}
  if (config.logging.max_size_bytes !== undefined) rotationOptions.maxSizeBytes = config.logging.max_size_bytes
  if (config.logging.max_files !== undefined) rotationOptions.maxFiles = config.logging.max_files

  const destination = createRotatingLogDestination(file, rotationOptions)

  try {
    await probeOpens(destination)
  } catch (error) {
    throw new Error(`could not open configured log file ${file}: ${(error as Error).message}`)
  }

  destination.on('error', (error: Error) => {
    process.stderr.write(`log destination ${file} failed after startup: ${error.message}\n`)
    process.exit(1)
  })

  return createLogger(config.logging.level, destination)
}

/** What autonomous mode needs beyond the config, read only when it is enabled. */
async function autonomousRuntimeOptions(config: RelayConfig, secrets: SecretProvider): Promise<StartOrchestratorOptions['autonomousRuntime']> {
  if (config.autonomous?.enabled !== true) return undefined
  const gitConfig = (key: string): string => {
    try {
      return execFileSync('git', ['config', '--global', key], { encoding: 'utf8' }).trim()
    } catch {
      throw new Error(`autonomous mode needs git's global ${key} for the workers' commits; set it with \`git config --global ${key} ...\``)
    }
  }
  const receiptKeyHex = await secrets.get(APPROVAL_RECEIPT_KEY_SECRET)
  if (!/^(?:[0-9a-f]{2}){32,}$/i.test(receiptKeyHex)) throw new Error(`${APPROVAL_RECEIPT_KEY_SECRET} must be at least 32 bytes of hex; run \`relay secrets migrate\``)
  const gitIdentity = { name: gitConfig('user.name'), email: gitConfig('user.email') }
  return {
    // Owned by the runtime, which closes it on stop.
    redis: createRedis(config.redis.url),
    relayHome: resolveRelayHome().path,
    receiptKey: Buffer.from(receiptKeyHex, 'hex'),
    repoRegistryPath: process.env.RELAY_REPOS_PATH ?? defaultReposPath(),
    // This file runs as dist/scripts/relay-orchestrator.js; the hook and gateway entries sit beside it.
    distRoot: join(dirname(fileURLToPath(import.meta.url)), '..'),
    gitIdentity,
  }
}

async function main(): Promise<void> {
  const config = loadRelayConfig(CONFIG_PATH)
  // AP-1 / FR-POL-2, Task 3: loaded, and validated, before anything else
  // this process does. loadPolicy throws ConfigError for a missing or
  // invalid policy file (src/config/load.ts's loadValidated), which
  // propagates straight out of main() below and exits the process before a
  // pool is opened, a migration is applied, or the orchestrator starts:
  // this is what makes "an invalid policy prevents startup" true of the
  // real binary, not only of a unit test.
  const policy = loadPolicy(POLICY_PATH)
  assertAutonomousBudget(config, policy, POLICY_PATH)
  const log = await createDaemonLogger(config)
  const secrets = createDaemonSecretProvider(config, resolveRelayHome().path)
  const pool = createPool(await resolveDatabaseUrl(config, secrets))

  try {
    log.info('applying any pending migrations before starting the orchestrator')
    await applyMigrations(pool, 'src/db/migrations', { log })

    const autonomousRuntime = await autonomousRuntimeOptions(config, secrets)
    log.info('starting the orchestrator against the configured Slack workspace')
    // Bounded, because startOrchestrator can hang rather than fail. Observed:
    // Slack's REST API answered normally while the Socket Mode websocket
    // never completed its handshake, so the process sat alive and silent,
    // logging only Bolt's own pong warnings, and never became ready.
    //
    // The connectivity check below cannot catch this: it is only armed AFTER
    // startup returns, so a startup that never returns is exactly the case it
    // does not cover. Exiting non-zero hands the problem to a supervisor,
    // which is the same posture as the health check itself, and a loud exit
    // beats an alive process that will never answer a message.
    const handle = await withStartupDeadline(
      startOrchestrator(pool, secrets, log, {
        policy,
        ...(config.autonomous ? { autonomous: config.autonomous } : {}),
        ...(autonomousRuntime ? { autonomousRuntime } : {}),
      }),
      STARTUP_DEADLINE_MS,
      log,
      (late) => late.stop(),
    )
    log.info(
      'orchestrator is running: Socket Mode is connected, the outbox drain is scheduled. ' +
        'Mention Relay, DM it, or reply in an existing Relay thread. Press Ctrl+C to stop.',
    )

    // Socket Mode can die while the process stays alive and healthy looking:
    // observed in production, where Slack kept accepting messages, Relay
    // logged no error, and every inbound event was silently dropped. Nothing
    // in the process notices, because a websocket that has stopped
    // delivering looks exactly like a quiet workspace.
    //
    // So liveness is proved rather than assumed, by calling Slack on a
    // schedule. On repeated failure the process EXITS non-zero rather than
    // trying to reconnect in place: a supervisor restarting a fresh process
    // is a mechanism that is known to work, whereas in-process recovery is
    // one more thing that can itself fail silently. Exiting loudly beats
    // running deaf.
    let consecutiveHealthFailures = 0
    const healthTimer = setInterval(() => {
      void (async () => {
        try {
          await handle.checkConnectivity()
          if (consecutiveHealthFailures > 0) {
            log.info({ after: consecutiveHealthFailures }, 'Slack connectivity recovered')
          }
          consecutiveHealthFailures = 0
        } catch (error) {
          consecutiveHealthFailures += 1
          log.error(
            { err: error, consecutiveHealthFailures },
            'Slack connectivity check failed; inbound messages may be silently dropped',
          )
          if (consecutiveHealthFailures >= MAX_HEALTH_FAILURES) {
            log.error(
              { consecutiveHealthFailures },
              'exiting so a supervisor can restart with a fresh Socket Mode connection',
            )
            process.exit(1)
          }
        }
      })()
    }, HEALTH_CHECK_INTERVAL_MS)
    healthTimer.unref()

    let shuttingDown = false
    const shutdown = (signal: string): void => {
      clearInterval(healthTimer)
      if (shuttingDown) return
      shuttingDown = true
      log.info({ signal }, 'shutting down')
      handle
        .stop()
        .catch((error: unknown) => {
          log.error({ err: error }, 'error while stopping the orchestrator')
        })
        .finally(() => {
          closePool(pool)
            .catch(() => {
              // The pool may already be in a bad state on the way out; a
              // failed close here must not mask the shutdown itself.
            })
            .finally(() => {
              process.exit(0)
            })
        })
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  } catch (error) {
    await closePool(pool)
    throw error
  }
}

// Guarded so importing this module (as the test for createDaemonLogger
// above does) never starts the real daemon: process.argv[1] is only the
// path to this file when it is run directly, e.g. `node
// dist/scripts/relay-orchestrator.js`, not when a test file imports it.
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isEntryPoint) {
  main().catch((error: unknown) => {
    // Never a secret: nothing on this path interpolates a token into an
    // error message, matching scripts/slack-smoke.ts's own guarantee.
    process.stderr.write(`relay-orchestrator failed: ${error instanceof Error ? error.message : String(error)}\n`)
    // `process.exit`, not `process.exitCode`. Setting the code alone asks
    // Node to exit once the event loop drains, and the whole reason this
    // path is reached is that something has gone wrong during startup, which
    // is exactly when a stray timer is most likely to be holding the loop
    // open. That is not hypothetical: an orphaned outbound-drain timer kept
    // a failed daemon alive indefinitely, erroring every two seconds. A
    // daemon that has failed to start must die so a supervisor can replace
    // it, not linger looking healthy.
    process.exit(1)
  })
}
