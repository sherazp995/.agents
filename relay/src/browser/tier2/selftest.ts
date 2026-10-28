/**
 * A startup self-test for the tier 2 browser driver, in the spirit FR-SH-7
 * states for sandbox confinement: "integrity is verified, not assumed ...
 * a startup self-test attempts a known-forbidden write and a known-forbidden
 * connection."
 *
 * The equivalent question here is: on THIS machine, right now, does the
 * origin guard actually stop a request from leaving the browser? Every test
 * in `test/browser/tier2/` answers that in CI. None of them answers it on
 * the operator's machine, against the Chrome the operator actually has
 * installed, at the moment they are deciding whether Relay is ready. This
 * does, in about two seconds, and costs nothing.
 *
 * WHY IT SERVES ITS OWN PAGE. A self-test that navigated to a real site
 * would depend on the network, on that site staying up, and on its markup
 * not changing, and it would send traffic to a destination the egress
 * inventory has no reason to declare. A one-page loopback server has none
 * of those problems, and it is the only way to check the negative half of
 * the claim: the server's own request log is what proves a blocked request
 * never arrived.
 *
 * THE TWO HALVES MUST BOTH HOLD, and this is the part worth guarding on a
 * change. "The blocked request never arrived" passes trivially if the whole
 * browser failed to start, if the page never loaded, or if the URL was
 * wrong. So the test also requires that the ALLOWED content was read back,
 * from the same page, in the same navigation. One assertion proves the
 * machinery ran; the other proves it enforced.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultChromeExecutablePath } from '../launch.js'
import { openTier2Browser } from './browser.js'
import type { Tier2BrowserDependencies } from './browser.js'
import { profileEntrySchema } from '../../profiles/schema.js'
import { enforceNavigation } from '../enforcement.js'
import { destinationHost } from '../url.js'
import type { NavigationGuard } from './page.js'

/** The string the self-test page carries and the driver must read back. Distinctive enough that reading it cannot be a coincidence. */
const SELF_TEST_MARKER = 'relay-tier2-self-test-ok'

/** The path the page requests from an off-allowlist host. Its absence from the server's log is the enforcement half of the proof. */
const BLOCKED_PATH = '/must-not-be-requested.png'

export type Tier2SelfTestOutcome =
  | { readonly outcome: 'passed'; readonly detail: string }
  | { readonly outcome: 'failed'; readonly reason: string }
  /** Chrome is not installed. Not a failure: an operator who never uses the browser capability does not need one, and reporting a missing optional dependency as broken is how a readiness report loses its meaning. */
  | { readonly outcome: 'skipped'; readonly reason: string }

export type Tier2SelfTestDependencies = {
  readonly executablePath?: string
  readonly tier2?: Tier2BrowserDependencies
  readonly chromeIsInstalled?: (path: string) => boolean
}

type SelfTestServer = {
  readonly port: number
  readonly requests: readonly string[]
  close(): Promise<void>
}

async function startSelfTestServer(): Promise<SelfTestServer> {
  const requests: string[] = []
  let port = 0

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    requests.push(path)

    if (path === BLOCKED_PATH) {
      // Reached only if enforcement failed. Answered anyway rather than
      // hanging, so the failure is a clean assertion rather than a timeout.
      response.writeHead(200, { 'content-type': 'image/gif' })
      response.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
      return
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>Relay tier 2 self test</title></head>` +
        `<body><p id="marker">${SELF_TEST_MARKER}</p>` +
        // localhost, not 127.0.0.1: a genuinely different hostname as far
        // as every origin check in this codebase is concerned, reached
        // through the same server so the log can see it.
        `<img alt="" src="http://localhost:${port}${BLOCKED_PATH}"></body></html>`,
    )
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  port = (server.address() as AddressInfo).port

  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/**
 * Runs the self-test. Never throws: every failure is a `failed` outcome
 * with a reason, because the caller is a readiness report and needs a line
 * to print, not an exception to translate.
 */
export async function runTier2SelfTest(deps: Tier2SelfTestDependencies = {}): Promise<Tier2SelfTestOutcome> {
  const executablePath = deps.executablePath ?? defaultChromeExecutablePath()
  const chromeIsInstalled = deps.chromeIsInstalled ?? existsSync
  if (!chromeIsInstalled(executablePath)) {
    return {
      outcome: 'skipped',
      reason: `no Chrome executable at ${executablePath}, so the tier 2 driver could not be exercised. Install Chrome, or set an explicit executable path, if you intend to use the browser capability.`,
    }
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'relay-selftest-'))
  let server: SelfTestServer | undefined
  try {
    server = await startSelfTestServer()

    // A throwaway profile that permits exactly the origin the page is
    // served from, and nothing else. Built here rather than taken from the
    // operator's registry: this proves the DRIVER enforces, and running it
    // against a real profile would both depend on that profile's
    // configuration and take its user-data directory lock.
    const profile = profileEntrySchema.parse({
      name: 'relay-tier2-self-test',
      description: 'Throwaway profile used only by the tier 2 driver self-test',
      user_data_dir: userDataDir,
      profile_directory: 'Default',
      classification: 'work',
      allowed_origins: ['127.0.0.1'],
      pinned_tier: 2,
    })

    const guard: NavigationGuard = (url: string) => {
      const decision = enforceNavigation({
        profile,
        tier: 2,
        destination: destinationHost(url),
        hardBlockedOrigins: [],
      })
      return decision.outcome === 'allowed'
        ? { allowed: true }
        : { allowed: false, reason: decision.outcome === 'refused' ? decision.reason : decision.reason }
    }

    const opened = await openTier2Browser(profile, { headless: true, executablePath, ...deps.tier2 })
    if (opened.outcome === 'failed') {
      return { outcome: 'failed', reason: `a tier 2 browser could not be started: ${opened.reason}` }
    }

    try {
      const page = await opened.browser.newPage(guard)
      const navigation = await page.navigate(`http://127.0.0.1:${server.port}/`)
      if (navigation.outcome !== 'loaded') {
        return {
          outcome: 'failed',
          reason: `the self-test page did not load: ${navigation.outcome === 'refused' || navigation.outcome === 'failed' ? navigation.reason : 'unknown reason'}`,
        }
      }

      // Half one: the allowed content really was read. Without this, the
      // enforcement assertion below would pass on a browser that did
      // nothing at all.
      const text = await page.readText()
      if (!text.includes(SELF_TEST_MARKER)) {
        return {
          outcome: 'failed',
          reason: 'the self-test page loaded but its content could not be read back, so the driver cannot be relied on to read a real page',
        }
      }

      // Half two: the off-allowlist request never reached the server. This
      // is the claim FR-PRF-4 makes about tier 2, checked against the
      // server's own log rather than against the driver's own account of
      // itself.
      if (server.requests.includes(BLOCKED_PATH)) {
        return {
          outcome: 'failed',
          reason:
            'an off-allowlist request REACHED its destination. Origin scoping is not being enforced on this machine, ' +
            'so a browser run could act outside its profile\'s allowlist (FR-PRF-4). Do not rely on tier 2 scoping ' +
            'until this passes.',
        }
      }
      if (!page.blockedRequests.some((request) => request.url.includes(BLOCKED_PATH))) {
        return {
          outcome: 'failed',
          reason:
            'the off-allowlist request did not reach its destination, but the driver did not record blocking it ' +
            'either, so it cannot be confirmed that enforcement is what stopped it rather than an unrelated failure',
        }
      }

      return {
        outcome: 'passed',
        detail:
          'a real headless Chrome launched, loaded a local page, and its content was read back; an off-allowlist ' +
          'sub-resource request from that same page was prevented from leaving the browser and was recorded as blocked',
      }
    } finally {
      await opened.browser.close()
    }
  } catch (error) {
    return {
      outcome: 'failed',
      reason: `the tier 2 self-test could not complete: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    await server?.close()
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // A leaked temporary directory is not a readiness failure, and
      // reporting it as one would be noise in the one report an operator
      // reads to decide whether Relay works.
    }
  }
}
