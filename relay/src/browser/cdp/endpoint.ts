/**
 * Starting a tier 2 browser and finding its DevTools endpoint.
 *
 * HOW THIS DIFFERS FROM src/browser/launch.ts, which also launches Chrome.
 * That module's launch exists to make a profile's browser AVAILABLE TO THE
 * TIER 1 EXTENSION: an ordinary Chrome window, detached, whose lifetime
 * Relay does not own, with no debugging switches, because the extension
 * does not need them and a profile without a dedicated user-data directory
 * would ignore them anyway. This module's launch is the opposite in every
 * one of those respects: Relay owns the process, drives it over CDP, and
 * kills it when the run ends. Two different launches for two different
 * tiers, kept in two files rather than one function with a mode flag.
 *
 * NO HTTP, DELIBERATELY. The usual way to find a DevTools WebSocket is to
 * GET `http://127.0.0.1:<port>/json/version`. This module does not: Chrome
 * writes the port AND the browser WebSocket path into a `DevToolsActivePort`
 * file in the user-data directory at startup, which is everything needed to
 * build the URL. Reading a local file rather than making an HTTP request
 * keeps Relay's egress evidence honest, since the alternative would add a
 * loopback fetch to a source tree whose every outbound call is inventoried
 * (src/data/egress.ts), for no capability gained.
 *
 * THE STALE-FILE TRAP, and why the file is deleted first. `DevToolsActivePort`
 * is left behind when Chrome exits. Reading it after a spawn without
 * removing it first will happily return the port of a browser that died
 * yesterday, and the connection attempt that follows either fails
 * confusingly or, far worse, succeeds against some other browser. So the
 * file is removed before the spawn, and its REAPPEARANCE is the readiness
 * signal. That is the one signal that cannot be wrong: only a
 * freshly-started Chrome writes it.
 *
 * FR-PRF-6a IS ENFORCED HERE TOO, not merely upstream. A tier 2 launch
 * against Chrome's own default user-data directory cannot work: Chrome 136
 * and later ignore remote-debugging switches for it, so the port file never
 * appears and the only thing this module could report is a timeout. It
 * refuses up front instead, naming the reason. `src/profiles/tiers.ts` makes
 * the same determination earlier in the ladder; duplicating it here means a
 * caller that reaches this module by some other path still cannot start a
 * tier 2 browser that was never going to be drivable.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { defaultChromeExecutablePath } from '../launch.js'
import type { ChromeLaunchHandle, SpawnChromeParams } from '../launch.js'
import { isDefaultChromeUserDataDir } from '../../profiles/tiers.js'
import type { ProfileEntry } from '../../profiles/schema.js'

/** The file Chrome writes into its user-data directory once the DevTools endpoint is listening: line 1 is the port, line 2 is the browser WebSocket path. */
export const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort'

/** How long the port file is waited for before the launch is reported as failed. A cold Chrome start against a large profile directory is the slow case this has to cover. */
export const DEFAULT_DEVTOOLS_READY_TIMEOUT_MS = 20_000

/** How often the port file is re-checked while waiting. */
export const DEFAULT_DEVTOOLS_POLL_INTERVAL_MS = 50

/**
 * A tier 2 Chrome process, which unlike tier 1's differs in one essential
 * way: Relay can kill it. Tier 1's launch hands a window to the operator
 * and detaches; tier 2's browser belongs to the run, so ending the run has
 * to be able to end the browser, or every run would leak one.
 */
export type Tier2ChromeHandle = ChromeLaunchHandle & {
  kill(): void
}

export type SpawnTier2ChromeFn = (params: SpawnChromeParams) => Tier2ChromeHandle

/**
 * Chrome switches for a Relay-owned automation browser, each one present
 * for a stated reason rather than copied from a snippet.
 *
 * The `--disable-*` networking switches are egress hygiene, not
 * performance: Chrome's own update checks, field-trial fetches, and sync
 * traffic are destinations FR-DATA-2's closed inventory does not declare,
 * and a browser Relay starts should not be quietly reaching them. They are
 * switched off at launch rather than declared, because not making the
 * request at all is the honest option and it costs nothing here: an
 * automation browser needs neither variations nor sync.
 */
export function tier2ChromeArgs(params: {
  readonly userDataDir: string
  readonly profileDirectory: string
  readonly headless: boolean
}): readonly string[] {
  return [
    // Port 0 means "pick a free one and write it to DevToolsActivePort".
    // A fixed port would collide the moment two profiles run at once,
    // which FR-PRF-9 explicitly permits.
    '--remote-debugging-port=0',
    `--user-data-dir=${params.userDataDir}`,
    `--profile-directory=${params.profileDirectory}`,
    ...(params.headless ? ['--headless=new'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--disable-breakpad',
    // Chrome's own "restore pages?" bubble after an unclean exit steals the
    // first navigation of the next run. A Relay-owned browser has no
    // session worth restoring.
    '--hide-crash-restore-bubble',
    'about:blank',
  ]
}

function defaultSpawnTier2Chrome(params: SpawnChromeParams): Tier2ChromeHandle {
  // NOT detached, unlike tier 1's launch: this process belongs to the run,
  // so it stays in Relay's process group and dies with it rather than
  // outliving Relay as an invisible browser holding a profile lock.
  const child = spawn(params.executablePath, params.args as string[], { stdio: 'ignore', detached: false })

  const exitListeners: Array<(code: number | null) => void> = []
  const errorListeners: Array<(error: Error) => void> = []
  child.on('exit', (code) => {
    for (const listener of exitListeners) listener(code)
  })
  child.on('error', (error) => {
    for (const listener of errorListeners) listener(error)
  })

  return {
    pid: child.pid,
    onExit: (listener) => {
      exitListeners.push(listener)
    },
    onSpawnError: (listener) => {
      errorListeners.push(listener)
    },
    kill: () => {
      // SIGKILL, not SIGTERM: a headless Chrome asked politely can take
      // seconds to shut down, and a run that has already reported its
      // result should not be held open by a browser's own teardown. The
      // profile directory survives a kill; Chrome repairs its own state on
      // the next start, which `--hide-crash-restore-bubble` above keeps
      // silent.
      child.kill('SIGKILL')
    },
  }
}

export type DevToolsEndpoint = {
  readonly webSocketDebuggerUrl: string
  readonly port: number
}

/**
 * Parses a `DevToolsActivePort` file's contents.
 *
 * Chrome's format is two lines: the port, then the browser WebSocket path
 * beginning with `/devtools/browser/`. Anything else is treated as
 * unreadable rather than guessed at, since a half-written file is exactly
 * what a poll loop will occasionally catch, and retrying is correct where
 * inventing a URL is not.
 */
export function parseDevToolsActivePort(contents: string): DevToolsEndpoint | undefined {
  const [portLine, pathLine] = contents.split('\n')
  if (portLine === undefined || pathLine === undefined) return undefined
  const port = Number.parseInt(portLine.trim(), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
  const path = pathLine.trim()
  if (!path.startsWith('/devtools/browser/')) return undefined
  // 127.0.0.1 rather than localhost: Chrome validates the Host header on
  // the DevTools endpoint and a `localhost` that resolves to ::1 first has
  // been an intermittent connection failure on machines with IPv6 enabled.
  return { webSocketDebuggerUrl: `ws://127.0.0.1:${port}${path}`, port }
}

export type Tier2LaunchDependencies = {
  readonly spawnChrome?: SpawnTier2ChromeFn
  readonly executablePath?: string
  readonly headless?: boolean
  readonly readyTimeoutMs?: number
  readonly pollIntervalMs?: number
  /** Test seams. Production reads and removes the real file with node:fs. */
  readonly readPortFile?: (path: string) => string | undefined
  readonly removePortFile?: (path: string) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly home?: string
  readonly platform?: NodeJS.Platform
}

export type Tier2LaunchOutcome =
  | {
      readonly outcome: 'ready'
      readonly endpoint: DevToolsEndpoint
      readonly handle: Tier2ChromeHandle
      readonly pid: number | undefined
    }
  | { readonly outcome: 'failed'; readonly reason: string; readonly handle: Tier2ChromeHandle | undefined }

function defaultReadPortFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function defaultRemovePortFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // A file that cannot be removed is reported by the wait below timing
    // out against a stale port that never changes, which is a clearer
    // failure than an exception thrown from a cleanup step.
  }
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Launches a Relay-owned Chrome for `profile` and waits until its DevTools
 * endpoint is listening.
 *
 * Never throws for an ordinary failure: `failed` carries the reason, and
 * carries the handle too where a process was actually started, so the
 * caller can kill a browser that came up but never wrote its port file
 * rather than leaking it.
 */
export async function launchTier2Chrome(
  profile: ProfileEntry,
  deps: Tier2LaunchDependencies = {},
): Promise<Tier2LaunchOutcome> {
  if (isDefaultChromeUserDataDir(profile.user_data_dir, deps.home, deps.platform)) {
    return {
      outcome: 'failed',
      handle: undefined,
      reason:
        `tier 2 cannot be started for profile "${profile.name}": "${profile.user_data_dir}" is Chrome's own default ` +
        'user-data directory, and Chrome 136 and later ignore remote-debugging switches for it (FR-PRF-6a). No ' +
        'browser was started, because none could have been driven.',
    }
  }

  const spawnChrome = deps.spawnChrome ?? defaultSpawnTier2Chrome
  const readPortFile = deps.readPortFile ?? defaultReadPortFile
  const removePortFile = deps.removePortFile ?? defaultRemovePortFile
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const timeoutMs = deps.readyTimeoutMs ?? DEFAULT_DEVTOOLS_READY_TIMEOUT_MS
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_DEVTOOLS_POLL_INTERVAL_MS
  const portFilePath = join(profile.user_data_dir, DEVTOOLS_ACTIVE_PORT_FILE)

  // See this file's header comment: removal first is what makes the file's
  // reappearance a trustworthy readiness signal instead of a stale read.
  removePortFile(portFilePath)

  let spawnError: Error | undefined
  let exitCode: number | null | undefined
  let exited = false

  const handle = spawnChrome({
    executablePath: deps.executablePath ?? defaultChromeExecutablePath(deps.platform),
    args: tier2ChromeArgs({
      userDataDir: profile.user_data_dir,
      profileDirectory: profile.profile_directory,
      headless: deps.headless ?? true,
    }),
  })
  handle.onSpawnError((error) => {
    spawnError = error
  })
  handle.onExit((code) => {
    exited = true
    exitCode = code
  })

  const start = now()
  for (;;) {
    if (spawnError !== undefined) {
      return {
        outcome: 'failed',
        handle,
        reason: `chrome could not be started for tier 2 on profile "${profile.name}": ${spawnError.message}`,
      }
    }

    const contents = readPortFile(portFilePath)
    if (contents !== undefined) {
      const endpoint = parseDevToolsActivePort(contents)
      if (endpoint !== undefined) {
        return { outcome: 'ready', endpoint, handle, pid: handle.pid }
      }
      // A partially written file: fall through and poll again rather than
      // failing, since the next read is very likely to be complete.
    }

    if (exited) {
      // Chrome exiting before the port file appears is the FR-PRF-6a
      // single-instance hand-off (another browser already owns this
      // user-data directory) or an outright startup failure. Either way
      // there is no endpoint, and saying so beats waiting out the timeout.
      return {
        outcome: 'failed',
        handle,
        reason:
          `chrome exited (code ${exitCode ?? 'null'}) before writing ${DEVTOOLS_ACTIVE_PORT_FILE} for profile ` +
          `"${profile.name}". A user-data directory permits only one running browser instance (FR-PRF-6a), so the ` +
          'most likely cause is that another browser already has this directory open.',
      }
    }

    if (now() - start >= timeoutMs) {
      return {
        outcome: 'failed',
        handle,
        reason:
          `chrome did not write ${DEVTOOLS_ACTIVE_PORT_FILE} within ${timeoutMs}ms for profile "${profile.name}", ` +
          'so its DevTools endpoint could not be found and tier 2 cannot attach.',
      }
    }

    await sleep(pollIntervalMs)
  }
}

/** Whether a user-data directory currently claims a live DevTools endpoint. Used by diagnostics; a caller that wants to attach should launch, since a present file is not proof the browser behind it is alive. */
export function readExistingDevToolsEndpoint(userDataDir: string): DevToolsEndpoint | undefined {
  const path = join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE)
  if (!existsSync(path)) return undefined
  const contents = defaultReadPortFile(path)
  return contents === undefined ? undefined : parseDevToolsActivePort(contents)
}
