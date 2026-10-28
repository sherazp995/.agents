/**
 * A tier 2 browser's lifetime: launch it, connect to it, hand out pages,
 * and, above all, make sure it dies.
 *
 * EVERY PAGE IS ATTACHED, INCLUDING ONES THE BROWSER OPENED BY ITSELF, and
 * this is a correction rather than a feature. Origin enforcement lives in
 * each page's own CDP `Fetch` interception (src/browser/tier2/page.ts), and
 * a page Relay never attached to has none. `window.open`, a link with
 * `target="_blank"`, and a `Ctrl`-click all create a target Relay did not
 * ask for. Before this, such a target loaded whatever it liked, carrying
 * the profile's cookies, while the driver recorded nothing at all. FR-PRF-4
 * says tier 2 PREVENTS an off-allowlist navigation; for a popup, it did
 * not. A test now proves the hole is closed and, more importantly, proves
 * the hole can be reopened: it asserts against the fixture server's own
 * request log.
 *
 * The fix is `Target.setAutoAttach` with `waitForDebuggerOnStart`. Chrome
 * pauses each new target before it executes anything, hands Relay a
 * session, and waits. Relay installs interception and only then lets it
 * run. The pause is the load-bearing part: attaching after the fact would
 * leave a window in which the new page could already have made its first,
 * unguarded request, which is the only request an exfiltration needs.
 *
 * A POPUP INHERITS ITS OPENER'S SCOPE. It is the same task, in the same
 * profile, so it gets the same guard. Where the opener cannot be
 * identified, and exactly one page exists, that page's guard is used;
 * where neither holds, the new target is guarded by a REFUSE-EVERYTHING
 * guard rather than an absent one. An unattributable page is a page whose
 * scope Relay does not know, and the safe answer to "what may this reach"
 * when the answer is unknown is "nothing".
 *
 * THE LEAK THIS FILE EXISTS TO PREVENT. Every tier 2 browser holds an
 * exclusive lock on its profile's user-data directory (FR-PRF-6a). One
 * leaked process therefore does not merely waste memory: it makes that
 * profile permanently un-launchable until someone finds and kills the
 * orphan by hand, and the error the next run reports ("chrome exited before
 * writing DevToolsActivePort") does not obviously point at the cause. So
 * every failure path in this file kills what it started, including the
 * paths where the failure happened after the process came up.
 *
 * `openTier2Browser` returns a result object rather than throwing, matching
 * src/browser/launch.ts's own shape: a caller building a run report needs a
 * reason to put in it, not an exception to translate.
 */

import { CdpTransportError, connectToCdp } from '../cdp/connection.js'
import type { CdpConnection, CdpConnectionOptions, OpenCdpSocketFn } from '../cdp/connection.js'
import { launchTier2Chrome } from '../cdp/endpoint.js'
import type { Tier2ChromeHandle, Tier2LaunchDependencies } from '../cdp/endpoint.js'
import { Tier2Page } from './page.js'
import type { BlockedRequest, DrivablePage, NavigationGuard } from './page.js'
import { startDownloadTracker } from './downloads.js'
import type { DownloadTracker, DownloadTrackerDependencies } from './downloads.js'
import type { ProfileEntry } from '../../profiles/schema.js'

/**
 * What a caller actually drives, without the transport details.
 *
 * Extracted for the same reason `DrivablePage` was, and after the same
 * failure: the browser capability's test double was cast past the compiler
 * with `as unknown as`, so when the capability started reading
 * `browser.blockedRequests` the double silently lacked it and three tests
 * failed with "driver_failed" instead of a type error naming the missing
 * member. A double typed as this is checked.
 */
export type DrivableBrowser = {
  readonly profile: string
  /** Opens a new page with `guard` enforcing its origin scope. Every page gets its own guard, so two pages of one browser can be bound to different scopes if a caller ever needs that. */
  newPage(guard: NavigationGuard): Promise<DrivablePage>
  /** FR-BR-5's "download file". Browser-level rather than page-level, because a download outlives the page that started it; see src/browser/tier2/downloads.ts. */
  readonly downloads: DownloadTracker
  /**
   * Every request this browser's origin scope refused, across ALL its
   * pages, including ones the browser opened by itself.
   *
   * A caller reporting only its own page's blocked requests would say
   * nothing about a popup, which is exactly where the interesting refusals
   * happen: a page that opens a window to an off-allowlist origin is the
   * case this browser's auto-attach exists for, and a report that omitted
   * it would describe the enforcement as having had nothing to do.
   */
  readonly blockedRequests: readonly BlockedRequest[]
  /** Closes the CDP connection and kills the browser process. Idempotent. */
  close(): Promise<void>
}

export type Tier2Browser = DrivableBrowser & {
  readonly connection: CdpConnection
  readonly pid: number | undefined
  readonly webSocketDebuggerUrl: string
}

export type Tier2BrowserOutcome =
  | { readonly outcome: 'ready'; readonly browser: Tier2Browser }
  | { readonly outcome: 'failed'; readonly reason: string }

/** What `createBrowserCapability`'s own `openBrowser` seam returns: the drivable surface only, so a test double does not have to fake a CDP connection it never uses. */
export type DrivableBrowserOutcome =
  | { readonly outcome: 'ready'; readonly browser: DrivableBrowser }
  | { readonly outcome: 'failed'; readonly reason: string }

export type Tier2BrowserDependencies = Tier2LaunchDependencies & {
  readonly openSocket?: OpenCdpSocketFn
  readonly connectionOptions?: CdpConnectionOptions
  readonly navigationTimeoutMs?: number
  readonly downloads?: DownloadTrackerDependencies
}

/**
 * Launches a Relay-owned browser for `profile` and connects to it.
 *
 * On any failure after the process started, the process is killed before
 * returning. See this file's header comment for why that matters more here
 * than it usually does.
 */
export async function openTier2Browser(
  profile: ProfileEntry,
  deps: Tier2BrowserDependencies = {},
): Promise<Tier2BrowserOutcome> {
  const launch = await launchTier2Chrome(profile, deps)
  if (launch.outcome === 'failed') {
    launch.handle?.kill()
    return { outcome: 'failed', reason: launch.reason }
  }

  const handle: Tier2ChromeHandle = launch.handle
  let connection: CdpConnection
  try {
    connection = await connectToCdp(launch.endpoint.webSocketDebuggerUrl, {
      ...deps.connectionOptions,
      ...(deps.openSocket !== undefined ? { openSocket: deps.openSocket } : {}),
    })
  } catch (error) {
    handle.kill()
    return {
      outcome: 'failed',
      reason:
        `chrome started for profile "${profile.name}" but its DevTools endpoint could not be connected to ` +
        `(${error instanceof Error ? error.message : String(error)}). The browser was killed rather than left ` +
        'holding the profile lock.',
    }
  }

  const downloads = await startDownloadTracker(connection, deps.downloads)

  /**
   * The guard each attached page target is running under, so a popup can
   * inherit its opener's. See this file's header comment.
   */
  const guardsByTargetId = new Map<string, NavigationGuard>()
  const pagesByTargetId = new Map<string, Tier2Page>()
  /** Waiters for a target this process created, resolved by the auto-attach handler below. */
  const pendingPages = new Map<string, (page: Tier2Page) => void>()

  /** The guard for a target Relay did not create and cannot attribute. Fails closed; see this file's header comment on why an unattributable page reaches nothing. */
  const REFUSE_EVERYTHING: NavigationGuard = (url: string) => ({
    allowed: false,
    reason:
      'this page was opened by the browser itself and Relay could not attribute it to a page whose origin scope it ' +
      `knows, so ${url} was refused. An unattributable page is guarded by refusing everything rather than by ` +
      'guarding nothing.',
  })

  /**
   * How long the auto-attach handler waits for `newPage` to register the
   * guard for a target IT created.
   *
   * This exists for a race that is easy to get wrong and was: Chrome
   * delivers `Target.attachedToTarget` BEFORE the `Target.createTarget`
   * reply that tells `newPage` the target's id, so at attach time the
   * guard for a page Relay itself created is very often not registered
   * yet. Treating that as "unattributable" made every page Relay created
   * refuse everything, which the self-test caught immediately. Waiting
   * briefly closes the race without guessing.
   *
   * The wait costs nothing in the ordinary popup case, where `openerId` is
   * present and the guard is inherited without waiting at all.
   */
  const GUARD_REGISTRATION_GRACE_MS = 5_000

  async function guardForTarget(targetId: string, openerId: string | undefined): Promise<NavigationGuard> {
    const own = guardsByTargetId.get(targetId)
    if (own !== undefined) return own

    // A popup: same task, same profile, so the same scope as its opener.
    if (openerId !== undefined) {
      const inherited = guardsByTargetId.get(openerId)
      if (inherited !== undefined) return inherited
    }

    // See GUARD_REGISTRATION_GRACE_MS: this is the createTarget race, not
    // a guess about what the page should be allowed to do.
    const deadline = Date.now() + GUARD_REGISTRATION_GRACE_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const late = guardsByTargetId.get(targetId)
      if (late !== undefined) return late
    }
    return REFUSE_EVERYTHING
  }

  connection.on('Target.attachedToTarget', (params) => {
    // The handler is async and nothing awaits it, so it must swallow its
    // own failures: an unhandled rejection here would surface as a process
    // level error with no connection to the browser that caused it, and
    // the ordinary trigger is benign (the browser closed while a target
    // was still attaching).
    void (async () => {
      const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined
      const info = params['targetInfo']
      const targetInfo = typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : undefined
      const targetId = typeof targetInfo?.['targetId'] === 'string' ? (targetInfo['targetId'] as string) : undefined
      const type = typeof targetInfo?.['type'] === 'string' ? (targetInfo['type'] as string) : ''
      const openerId = typeof targetInfo?.['openerId'] === 'string' ? (targetInfo['openerId'] as string) : undefined

      // Whatever happens below, the target must be resumed. A target left
      // paused on `waitForDebuggerOnStart` never runs at all, which turns a
      // failure to attach into a silently blank page.
      const resume = async (): Promise<void> => {
        if (sessionId === undefined) return
        try {
          await connection.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
        } catch {
          // A target that has already gone cannot be resumed, and there is
          // nothing left to run.
        }
      }

      if (sessionId === undefined || targetId === undefined || type !== 'page') {
        await resume()
        return
      }

      try {
        const guard = await guardForTarget(targetId, openerId)
        guardsByTargetId.set(targetId, guard)
        const page = new Tier2Page(connection, sessionId, targetId, {
          guard,
          ...(deps.navigationTimeoutMs !== undefined ? { navigationTimeoutMs: deps.navigationTimeoutMs } : {}),
        })
        // Interception is installed BEFORE the target is resumed. That
        // ordering is the whole guarantee.
        await page.install()
        pagesByTargetId.set(targetId, page)
        pendingPages.get(targetId)?.(page)
        pendingPages.delete(targetId)
      } finally {
        await resume()
      }
    })().catch(() => {
      // See the comment above: nothing here can be recovered, and the page
      // simply never becomes drivable, which `newPage` reports as a
      // timeout naming the target.
    })
  })

  try {
    await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  } catch (error) {
    handle.kill()
    downloads.dispose()
    return {
      outcome: 'failed',
      reason:
        `chrome started for profile "${profile.name}" but would not enable target auto-attach ` +
        `(${error instanceof Error ? error.message : String(error)}). Without it a page the browser opens by ` +
        'itself would run with no origin enforcement at all, so the browser was killed rather than used with a ' +
        'known hole in its scoping (FR-PRF-4).',
    }
  }

  let closed = false
  const browser: Tier2Browser = {
    profile: profile.name,
    connection,
    pid: launch.pid,
    webSocketDebuggerUrl: launch.endpoint.webSocketDebuggerUrl,
    downloads,
    get blockedRequests() {
      return [...pagesByTargetId.values()].flatMap((page) => [...page.blockedRequests])
    },
    newPage: async (guard: NavigationGuard) => {
      const created = await connection.send('Target.createTarget', { url: 'about:blank' })
      const targetId = created['targetId']
      if (typeof targetId !== 'string') {
        throw new CdpTransportError('Target.createTarget did not return a target id, so no page could be attached')
      }
      // Recorded before the wait, because the auto-attach event for this
      // target may already be in flight.
      guardsByTargetId.set(targetId, guard)

      const existing = pagesByTargetId.get(targetId)
      if (existing !== undefined) return existing

      return new Promise<Tier2Page>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPages.delete(targetId)
          reject(new CdpTransportError(`chrome created target ${targetId} but never attached to it, so it cannot be driven`))
        }, deps.navigationTimeoutMs ?? 30_000)
        pendingPages.set(targetId, (page) => {
          clearTimeout(timer)
          resolve(page)
        })
        // The event may have arrived between createTarget returning and
        // this listener being registered.
        const raced = pagesByTargetId.get(targetId)
        if (raced !== undefined) {
          clearTimeout(timer)
          pendingPages.delete(targetId)
          resolve(raced)
        }
      })
    },
    close: async () => {
      if (closed) return
      closed = true
      // The connection first, so nothing is mid-command when the process
      // disappears, then the process itself. Killing first would leave
      // every in-flight command to be rejected by the socket close, which
      // works but reports a confusing reason.
      connection.close('the tier 2 browser is shutting down')
      handle.kill()
      // After the process is gone, so nothing is still writing into the
      // directory while it is being removed.
      downloads.dispose()
    },
  }

  return { outcome: 'ready', browser }
}
