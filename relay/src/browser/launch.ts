/**
 * FR-PRF-7: profile launch, and the tier fallback ladder that follows it.
 *
 * Two separable questions live in this file, and the requirement states
 * them in sequence for a reason: they have different failure shapes and
 * different owners of "what actually happened."
 *
 *   1. `launchChromeForProfile`: is the bound profile's browser running at
 *      all? If not, start it, wait for readiness, and report which one
 *      happened. This is a Chrome process lifecycle question, answered by
 *      spawning a process and observing what it does.
 *   2. `resolveLaunchTier`: once a browser exists for the profile (launched
 *      just now, or already running), does the tier 1 extension connect to
 *      it in time? If not, does the ladder fall through to tier 2, or does
 *      it stop and ask? This is a policy question, answered by
 *      `../profiles/tiers.js`'s own tier availability report plus the
 *      profile's own pin.
 *
 * `establishProfileConnection` composes both for the common case, but the
 * two stay independently testable and independently callable, because a
 * caller who already knows the browser is running (FR-PRF-6's own discovery
 * step, for example) has no reason to attempt a launch first.
 *
 * FR-PRF-6a's own constraint shapes the launch step: a user-data directory
 * permits only one running browser instance. Chrome enforces this itself,
 * through its own single-instance behaviour: a second process pointed at a
 * directory another process already owns hands off to that process and
 * exits almost immediately, rather than starting a second window. That
 * exit is not a crash, and this module never reports it as one: it is read
 * as the ordinary, expected case of "the operator already has this profile
 * open," which for an everyday profile is the common case rather than the
 * exception. There is no reliable way to know beforehand whether a given
 * user-data directory is already in use (an everyday profile is very often
 * launched without any `--user-data-dir` flag at all, so scanning running
 * processes for that flag would miss it), so this module does not attempt
 * to guess first: it attempts the launch and lets Chrome's own behaviour
 * answer the question, which is the one signal that cannot be wrong.
 *
 * FR-PRF-4a's constraint shapes the ladder step: a profile pinned to tier 2
 * or 3 must never use tier 1, even where tier 1 is declared and would
 * connect successfully. Trying tier 1 first and falling back only on a
 * timeout would let a fast-connecting extension win the race for a profile
 * the operator explicitly pinned away from detection-only enforcement, so
 * the pin is checked first, before any extension probe is attempted, and it
 * short-circuits the whole tier 1 path rather than racing it.
 */

import { spawn } from 'node:child_process'

import { reportTierAvailability } from '../profiles/tiers.js'
import type { ProfileEntry } from '../profiles/schema.js'

// ---------------------------------------------------------------------------
// Chrome process launch (FR-PRF-7, first half: "if the bound profile's
// browser is not running, Relay launches Chrome ... waits for readiness, and
// reports the launch").
// ---------------------------------------------------------------------------

/**
 * How long a freshly spawned Chrome process is given to prove it stayed up
 * before this module concludes it launched successfully. Chosen, not
 * measured: Chrome's own single-instance hand-off (see this file's header
 * comment) typically exits within a few hundred milliseconds, well inside
 * this window, while a genuine cold start, including one that has to read a
 * large profile directory, can reasonably take a second or two. The window
 * is generous toward "launched" on purpose, since the cost of guessing wrong
 * in that direction is only a slightly longer wait, while guessing wrong the
 * other way would report a real launch as "already running."
 */
export const DEFAULT_LAUNCH_READINESS_GRACE_MS = 3_000

/**
 * How long `resolveLaunchTier` waits for the extension to connect before
 * falling through the ladder. A starting default meant to be tuned once
 * real connect latencies are observed, not a measured constant: kept as an
 * exported name specifically so a caller can override it per environment
 * rather than editing this file.
 */
export const DEFAULT_EXTENSION_CONNECT_TIMEOUT_MS = 15_000

/** How often `waitForExtensionConnection` re-checks the probe while waiting. */
export const DEFAULT_EXTENSION_POLL_INTERVAL_MS = 500

/**
 * The narrow surface this module needs from a spawned Chrome process:
 * whether it stayed running, or told us why it could not.
 *
 * Modelled as two independent callback registrations rather than a
 * Node `ChildProcess`, so a test can construct a handle by hand and fire
 * each condition directly, without a real process, a real event loop, or a
 * real Chrome binary anywhere near the test. `onExit` mirrors Node's own
 * `'exit'` event; `onSpawnError` mirrors Node's own `'error'` event, which
 * fires instead of `'exit'` when the executable itself could not be
 * started at all. The two are kept distinct because they mean different
 * things here: an exit is read as "already running" (FR-PRF-6a), a spawn
 * error is read as an actual launch failure.
 */
export type ChromeLaunchHandle = {
  readonly pid: number | undefined
  onExit(listener: (code: number | null) => void): void
  onSpawnError(listener: (error: Error) => void): void
}

export type SpawnChromeParams = {
  readonly executablePath: string
  readonly args: readonly string[]
}

export type SpawnChromeFn = (params: SpawnChromeParams) => ChromeLaunchHandle

/**
 * Chrome's own executable path, per platform. Only the common install
 * location per platform: an operator with Chrome installed elsewhere
 * overrides this via `LaunchDependencies.executablePath`, which every
 * function in this module accepts rather than hard-coding a single path
 * with no escape hatch.
 */
export function defaultChromeExecutablePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  return 'google-chrome'
}

function buildChromeArgs(profile: ProfileEntry): readonly string[] {
  // Deliberately minimal: this launch exists to make the profile's browser
  // available to the tier 1 extension, an ordinary Chrome window, not to
  // drive it over CDP. Remote-debugging flags belong to the tier 2 driver,
  // a Relay-owned process with its own dedicated user-data directory
  // (FR-PRF-6a), and adding them here would do nothing for a profile that
  // does not have one.
  return [`--user-data-dir=${profile.user_data_dir}`, `--profile-directory=${profile.profile_directory}`]
}

function defaultSpawnChrome(params: SpawnChromeParams): ChromeLaunchHandle {
  // Detached and with ignored stdio: Relay starts the process and moves on,
  // it does not stay attached to Chrome's own lifetime or read its output.
  const child = spawn(params.executablePath, params.args as string[], { stdio: 'ignore', detached: true })
  child.unref()

  const exitListeners: Array<(code: number | null) => void> = []
  const errorListeners: Array<(error: Error) => void> = []
  // Registered immediately, so no event is missed regardless of when a
  // caller attaches its own listener: Node's child_process events are
  // always delivered asynchronously, never in the same synchronous tick as
  // `spawn` itself, so this registration always wins the race.
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
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

type RaceResult =
  | { readonly kind: 'exited'; readonly code: number | null }
  | { readonly kind: 'spawn_error'; readonly error: Error }
  | { readonly kind: 'grace_elapsed' }

/**
 * Waits up to `graceMs` for `handle` to either exit or fail to spawn,
 * whichever comes first, or reports that neither happened before the grace
 * window elapsed. `sleepFn` is a seam purely for tests: production code
 * always uses the real timer, a test supplies one that resolves
 * immediately so the suite never actually waits `graceMs` in wall time.
 */
function raceLaunchOutcome(
  handle: ChromeLaunchHandle,
  graceMs: number,
  sleepFn: (ms: number) => Promise<void>,
): Promise<RaceResult> {
  return new Promise((resolve) => {
    let settled = false
    handle.onExit((code) => {
      if (settled) return
      settled = true
      resolve({ kind: 'exited', code })
    })
    handle.onSpawnError((error) => {
      if (settled) return
      settled = true
      resolve({ kind: 'spawn_error', error })
    })
    void sleepFn(graceMs).then(() => {
      if (settled) return
      settled = true
      resolve({ kind: 'grace_elapsed' })
    })
  })
}

export type LaunchDependencies = {
  readonly spawnChrome?: SpawnChromeFn
  readonly sleep?: (ms: number) => Promise<void>
  readonly executablePath?: string
  readonly readinessGraceMs?: number
}

export type ChromeLaunchOutcome =
  | { readonly outcome: 'launched'; readonly pid: number | undefined; readonly reason: string }
  /**
   * FR-PRF-6a's own constraint surfacing as a named result, not an
   * exception: a user-data directory permits only one running browser
   * instance, so a fresh launch attempt handing off to an existing process
   * and exiting is the ordinary case for a profile already in everyday
   * use, and this module says so plainly rather than letting it look like
   * a crash.
   */
  | { readonly outcome: 'already_running'; readonly reason: string }
  | { readonly outcome: 'launch_failed'; readonly reason: string }

/**
 * Launches Chrome for `profile`, waits for readiness, and reports which of
 * the three named outcomes happened. Never throws for an ordinary launch
 * failure: `launch_failed` carries the reason instead, so a caller building
 * a run report has a value to put in it rather than a caught exception to
 * translate.
 */
export async function launchChromeForProfile(
  profile: ProfileEntry,
  deps: LaunchDependencies = {},
): Promise<ChromeLaunchOutcome> {
  const spawnChrome = deps.spawnChrome ?? defaultSpawnChrome
  const sleepFn = deps.sleep ?? sleep
  const executablePath = deps.executablePath ?? defaultChromeExecutablePath()
  const graceMs = deps.readinessGraceMs ?? DEFAULT_LAUNCH_READINESS_GRACE_MS

  const handle = spawnChrome({ executablePath, args: buildChromeArgs(profile) })
  const result = await raceLaunchOutcome(handle, graceMs, sleepFn)

  if (result.kind === 'spawn_error') {
    return {
      outcome: 'launch_failed',
      reason: `chrome could not be started for profile "${profile.name}": ${result.error.message}`,
    }
  }

  if (result.kind === 'exited') {
    return {
      outcome: 'already_running',
      reason:
        `chrome exited immediately after launch for profile "${profile.name}" (exit code ${result.code ?? 'null'}). ` +
        'A user-data directory permits only one running browser instance (FR-PRF-6a), so this is read as the ' +
        "profile's browser already being open, not a launch failure: chrome's own single-instance behaviour hands " +
        'off to the existing process and exits.',
    }
  }

  return {
    outcome: 'launched',
    pid: handle.pid,
    reason: `chrome launched for profile "${profile.name}" and stayed up through the ${graceMs}ms readiness window`,
  }
}

// ---------------------------------------------------------------------------
// The tier fallback ladder (FR-PRF-7, second half: extension timeout falls
// through to tier 2 where FR-PRF-6a has established it is available; FR-PRF-4a:
// a pinned profile never falls back to tier 1).
// ---------------------------------------------------------------------------

/**
 * Whether the tier 1 extension is connected and positively verified as
 * belonging to the bound profile. FR-PRF-6 owns that verification (discover
 * the live connections, select the one belonging to this profile, confirm
 * the selection before acting); this module treats the probe as already
 * having done that work; it does not re-verify identity itself. A probe
 * that returns `true` for an unverified connection is a violation of
 * FR-PRF-6 in the probe, not in this ladder.
 */
export type ExtensionConnectionProbe = () => Promise<boolean>

export type Clock = {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const REAL_CLOCK: Clock = { now: () => Date.now(), sleep }

export type ExtensionWaitResult = { readonly connected: boolean; readonly waitedMs: number }

/**
 * Polls `probe` until it reports a connection or `timeoutMs` elapses,
 * whichever comes first. Probes at least once immediately, so a connection
 * already live when this is called is reported without waiting a full poll
 * interval.
 *
 * `clock` is a seam purely for tests: production code uses the real clock,
 * a test supplies one whose `sleep` resolves instantly and whose `now`
 * advances deterministically, so a multi-second timeout is exercised
 * without the suite actually waiting multi-second wall time.
 */
export async function waitForExtensionConnection(params: {
  readonly probe: ExtensionConnectionProbe
  readonly timeoutMs: number
  readonly pollIntervalMs?: number
  readonly clock?: Clock
}): Promise<ExtensionWaitResult> {
  const clock = params.clock ?? REAL_CLOCK
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_EXTENSION_POLL_INTERVAL_MS
  const start = clock.now()

  for (;;) {
    if (await params.probe()) {
      return { connected: true, waitedMs: clock.now() - start }
    }
    const elapsed = clock.now() - start
    if (elapsed >= params.timeoutMs) {
      return { connected: false, waitedMs: elapsed }
    }
    await clock.sleep(Math.min(pollIntervalMs, params.timeoutMs - elapsed))
  }
}

export type LaunchLadderDependencies = {
  /** Required whenever tier 1 is actually a candidate; see `waitForExtensionConnection`'s own doc comment on what the probe must already have verified. Not called at all for a pinned profile, or for a profile that does not declare the extension. */
  readonly probeExtension: ExtensionConnectionProbe
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
  readonly clock?: Clock
  readonly home?: string
  readonly platform?: NodeJS.Platform
}

export type LaunchLadderOutcome =
  | { readonly outcome: 'tier1_connected'; readonly tier: 1; readonly waitedMs: number }
  /** FR-PRF-4a: a pinned profile's tier is used directly. Tier 1 is never attempted, so there is no `waitedMs` to report. */
  | { readonly outcome: 'pinned'; readonly tier: 2 | 3; readonly reason: string }
  | { readonly outcome: 'fell_back_to_tier2'; readonly tier: 2; readonly reason: string }
  /** FR-PRF-7's own words: "there is no fallback," so the run asks the operator rather than attempting an attach that cannot succeed. */
  | { readonly outcome: 'escalate_to_operator'; readonly reason: string }

/**
 * Decides which tier a profile actually uses, applying FR-PRF-4a's pin
 * before FR-PRF-7's timeout-driven fallback, never the other way round.
 *
 * Order, and why it is fixed:
 *
 *   1. Pinned: tier 1 is never attempted, full stop, regardless of whether
 *      the extension would have connected. Checking the pin before probing
 *      is what stops a fast-connecting extension from winning tier 1 for a
 *      profile the operator pinned away from it.
 *   2. Unpinned, tier 1 declared: wait for the extension, up to the
 *      timeout.
 *   3. Unpinned, tier 1 not declared, or the wait timed out: fall through
 *      to tier 2 where FR-PRF-6a has established it is available for this
 *      profile. Where it is not, there is no fallback, and this returns
 *      `escalate_to_operator` rather than silently attempting an attach
 *      that cannot succeed.
 */
export async function resolveLaunchTier(
  profile: ProfileEntry,
  deps: LaunchLadderDependencies,
): Promise<LaunchLadderOutcome> {
  const report = reportTierAvailability(profile, deps.home, deps.platform)

  if (profile.pinned_tier !== undefined) {
    const pinnedAvailability = report.tiers.find((entry) => entry.tier === profile.pinned_tier)
    if (pinnedAvailability?.available === true) {
      return {
        outcome: 'pinned',
        tier: profile.pinned_tier,
        reason:
          `profile "${profile.name}" is pinned to tier ${profile.pinned_tier}; tier 1 is never attempted for a ` +
          'pinned profile, regardless of whether the extension would have connected (FR-PRF-4a)',
      }
    }
    // Setup's own validatePin should have refused this pin before it was
    // ever recorded (FR-PRF-4a: "setup never accepts a pin it cannot
    // honour"). Reaching this branch means the environment changed since
    // then, and the one thing this ladder must not do in response is fall
    // back to tier 1: that is precisely the silent degradation the pin
    // exists to forbid, so it escalates instead.
    return {
      outcome: 'escalate_to_operator',
      reason:
        `profile "${profile.name}" is pinned to tier ${profile.pinned_tier}, which is no longer available: ` +
        `${pinnedAvailability?.reason ?? 'unknown tier'}. A pinned profile never falls back to tier 1 (FR-PRF-4a), ` +
        'so the run asks the operator instead.',
    }
  }

  const tier1 = report.tiers.find((entry) => entry.tier === 1)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EXTENSION_CONNECT_TIMEOUT_MS

  let connected = false
  let waitedMs = 0
  let fallbackReason: string
  if (tier1?.available === true) {
    const wait = await waitForExtensionConnection({
      probe: deps.probeExtension,
      timeoutMs,
      ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    })
    connected = wait.connected
    waitedMs = wait.waitedMs
    fallbackReason = `the extension did not connect within ${timeoutMs}ms for profile "${profile.name}"`
  } else {
    // Tier 1 was never a candidate at all (the profile does not declare the
    // extension); there is nothing to wait for, and waiting the full
    // timeout anyway would only delay a decision that is already made.
    fallbackReason = `profile "${profile.name}" does not declare the Claude-in-Chrome extension, so tier 1 was never a candidate`
  }

  if (connected) {
    return { outcome: 'tier1_connected', tier: 1, waitedMs }
  }

  const tier2 = report.tiers.find((entry) => entry.tier === 2)
  if (tier2?.available === true) {
    return {
      outcome: 'fell_back_to_tier2',
      tier: 2,
      reason: `${fallbackReason}; continuing on tier 2, which FR-PRF-6a has established is available for this profile (FR-PRF-7)`,
    }
  }

  return {
    outcome: 'escalate_to_operator',
    reason:
      `${fallbackReason}, and tier 2 is not available for it (${tier2?.reason ?? 'unknown reason'}); there is no ` +
      'fallback, so the run asks the operator rather than silently attempting an attach that cannot succeed (FR-PRF-7)',
  }
}

// ---------------------------------------------------------------------------
// Composition: the end-to-end story FR-PRF-7 describes in one paragraph.
// ---------------------------------------------------------------------------

export type ProfileConnectionResult = {
  /** `undefined` for a pinned profile: the tier 1 Chrome launch this module owns is never attempted for one, per FR-PRF-4a, so there is no launch outcome to report. */
  readonly launch: ChromeLaunchOutcome | undefined
  readonly ladder: LaunchLadderOutcome
}

/**
 * The full FR-PRF-7 flow for a profile: launch Chrome where the profile is
 * not pinned away from tier 1, then resolve which tier the run actually
 * uses.
 *
 * A pinned profile skips the Chrome launch entirely: that launch exists to
 * make the profile's browser available to the tier 1 extension, and a
 * pinned profile never uses tier 1 (FR-PRF-4a), so launching for it would
 * start a browser window this ladder is guaranteed not to use.
 *
 * A launch failure (the executable itself could not be started) also skips
 * the extension wait: there is no browser for the extension to connect to,
 * so waiting out the full timeout would only delay a fallback decision that
 * is already made, and would misreport a launch failure as a connection
 * timeout.
 */
export async function establishProfileConnection(
  profile: ProfileEntry,
  deps: LaunchDependencies & LaunchLadderDependencies,
): Promise<ProfileConnectionResult> {
  if (profile.pinned_tier !== undefined) {
    return { launch: undefined, ladder: await resolveLaunchTier(profile, deps) }
  }

  const launch = await launchChromeForProfile(profile, deps)

  if (launch.outcome === 'launch_failed') {
    const report = reportTierAvailability(profile, deps.home, deps.platform)
    const tier2 = report.tiers.find((entry) => entry.tier === 2)
    const reason = `chrome failed to launch for profile "${profile.name}" (${launch.reason})`
    if (tier2?.available === true) {
      return {
        launch,
        ladder: {
          outcome: 'fell_back_to_tier2',
          tier: 2,
          reason: `${reason}; continuing on tier 2, which FR-PRF-6a has established is available for this profile (FR-PRF-7)`,
        },
      }
    }
    return {
      launch,
      ladder: {
        outcome: 'escalate_to_operator',
        reason:
          `${reason}, and tier 2 is not available for it (${tier2?.reason ?? 'unknown reason'}); there is no ` +
          'fallback, so the run asks the operator rather than silently attempting an attach that cannot succeed (FR-PRF-7)',
      },
    }
  }

  return { launch, ladder: await resolveLaunchTier(profile, deps) }
}
