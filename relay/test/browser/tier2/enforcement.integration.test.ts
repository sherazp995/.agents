/**
 * FR-PRF-4, the half of it that cannot be proven by reading code: "on tiers
 * 2 and 3 an off-allowlist navigation is PREVENTED."
 *
 * Prevented, not disapproved of. So every test here asserts against the
 * FIXTURE SERVER'S OWN REQUEST LOG, not merely against what the driver says
 * it did. A driver that recorded a refusal while the request still reached
 * the server would pass a test that only inspected the driver, and would be
 * exactly the false assurance FR-PRF-4 warns against: an operator told
 * scoping was enforced for a client profile when it was only watched.
 *
 * The off-allowlist origin is `localhost` on the same port as the
 * on-allowlist `127.0.0.1`. Same server, genuinely different hostname, so
 * one fixture proves cross-origin behaviour and the server's log
 * distinguishes the two by path.
 *
 * EVERY BLOCKING TEST HERE HAS ITS OWN INVERSE. A test that asserts "the
 * request did not arrive" passes just as happily when the request could
 * never have arrived for some unrelated reason: a typo in the URL, a CORS
 * rule, a fixture route that does not exist. So each blocked case is
 * paired with the same navigation under a permissive guard, which must
 * show the request arriving. Without the pair, these tests cannot fail for
 * the right reason.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DrivablePage, NavigationGuard } from '../../../src/browser/tier2/page.js'
import { startFixtureSite } from '../../support/fixture-site.js'
import type { FixtureSite } from '../../support/fixture-site.js'
import { chromeIsAvailable, openDisposableTier2Browser, permissiveGuard } from '../../support/tier2-browser.js'
import type { DisposableTier2Browser } from '../../support/tier2-browser.js'
import { destinationHost } from '../../../src/browser/url.js'

const describeWithChrome = chromeIsAvailable() ? describe : describe.skip

/** Permits exactly one host, refusing everything else with a reason. The shape the browser capability builds from a profile's allowlist. */
function onlyHost(host: string): NavigationGuard {
  return (url: string) => {
    const seen = destinationHost(url)
    return seen === host
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: `${seen} is not permitted by this test's allowlist (${host} only)` } as const)
  }
}

describeWithChrome('FR-PRF-4: tier 2 prevents an off-allowlist request, it does not merely notice one', () => {
  let site: FixtureSite
  let disposable: DisposableTier2Browser

  beforeAll(async () => {
    site = await startFixtureSite()
    disposable = await openDisposableTier2Browser()
  }, 60_000)

  afterAll(async () => {
    await disposable?.dispose()
    await site?.close()
  })

  function scopedPage(): Promise<DrivablePage> {
    return disposable.browser.newPage(onlyHost('127.0.0.1'))
  }

  function requestsFor(path: string): number {
    return site.requests.filter((seen) => seen === path).length
  }

  it('refuses a top-level navigation to an off-allowlist host before it is issued, and the server never sees it', async () => {
    const before = requestsFor('/dashboard')
    const page = await scopedPage()
    try {
      const result = await page.navigate(`http://localhost:${site.port}/dashboard`)

      expect(result.outcome).toBe('refused')
      if (result.outcome !== 'refused') return
      expect(result.reason).toContain('localhost')
      expect(requestsFor('/dashboard')).toBe(before)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('permits a navigation to the allowlisted host, so the refusal above is scoping and not a broken driver', async () => {
    const page = await scopedPage()
    try {
      const result = await page.navigate(site.url('/reports'))
      expect(result.outcome).toBe('loaded')
      expect(requestsFor('/reports')).toBeGreaterThan(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('blocks an off-allowlist SUB-RESOURCE the page requested on its own, which no navigate()-time check could have seen', async () => {
    const before = requestsFor('/pixel.png')
    const page = await scopedPage()
    try {
      const result = await page.navigate(site.url('/cross-origin'))
      expect(result.outcome).toBe('loaded')
      // The image load is a request the driver never issued and never saw
      // as a navigation. If enforcement lived only in navigate(), this
      // would arrive at the server.
      expect(requestsFor('/pixel.png')).toBe(before)
      expect(page.blockedRequests.map((entry) => entry.host)).toContain('localhost')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('INVERSE of the sub-resource test: under a permissive guard the very same image DOES reach the server', async () => {
    const before = requestsFor('/pixel.png')
    const page = await disposable.browser.newPage(permissiveGuard)
    try {
      await page.navigate(site.url('/cross-origin'))
      await page.waitFor("document.getElementById('pixel').complete === true", { timeoutMs: 10_000 })

      expect(requestsFor('/pixel.png')).toBeGreaterThan(before)
      expect(page.blockedRequests).toEqual([])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('blocks a navigation the PAGE initiated by clicking its own off-allowlist link', async () => {
    const before = requestsFor('/dashboard')
    const page = await scopedPage()
    try {
      await page.navigate(site.url('/cross-origin'))
      await page.click({ selector: '#offsite' })
      // Give the browser room to actually attempt the navigation, so this
      // is not asserting on a request that simply had not been made yet.
      await page.waitFor('false', { timeoutMs: 750, pollIntervalMs: 100 })

      expect(requestsFor('/dashboard')).toBe(before)
      expect(page.blockedRequests.some((entry) => entry.host === 'localhost')).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('records what was blocked, with its reason, so a run report can name it rather than claim enforcement in the abstract', async () => {
    const page = await scopedPage()
    try {
      await page.navigate(site.url('/cross-origin'))
      const blocked = page.blockedRequests.find((entry) => entry.host === 'localhost')

      expect(blocked).toBeDefined()
      expect(blocked?.reason).toContain('not permitted')
      expect(blocked?.url).toContain('/pixel.png')
      expect(blocked?.resourceType).toBe('Image')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('fails a request closed when the guard itself throws, rather than letting it through or hanging the page', async () => {
    const before = requestsFor('/pixel.png')
    const throwingGuard: NavigationGuard = (url: string) => {
      if (destinationHost(url) === 'localhost') throw new Error('guard exploded')
      return { allowed: true }
    }
    const page = await disposable.browser.newPage(throwingGuard)
    try {
      // The page still loads: only the off-allowlist sub-resource is
      // affected, and a hung request would have stopped the load event.
      const result = await page.navigate(site.url('/cross-origin'))
      expect(result.outcome).toBe('loaded')
      expect(requestsFor('/pixel.png')).toBe(before)
      expect(page.blockedRequests[0]?.reason).toContain('guard exploded')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('does not break inline data: and blob: sub-resources, which have no host an allowlist could ever match', async () => {
    const page = await scopedPage()
    try {
      const result = await page.navigate(site.url('/inline-resources'))
      expect(result.outcome).toBe('loaded')

      // Both images must actually decode. `naturalWidth` is 0 for an image
      // that failed to load, so this distinguishes "loaded" from "the
      // element exists".
      const loaded = await page.waitFor(
        "document.getElementById('inline-pixel').naturalWidth === 1 && document.getElementById('blob-pixel').naturalWidth === 1",
        { timeoutMs: 5_000 },
      )
      expect(loaded.outcome).toBe('satisfied')
      expect(page.blockedRequests).toEqual([])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('guards a page the BROWSER opened, not only the one Relay created', async () => {
    // The hole this closes was real and shipped: a target created by
    // window.open had no request interception at all, so it loaded whatever
    // it liked while carrying the profile's cookies, and the driver
    // recorded nothing. Asserted against the fixture server's own log,
    // because that is the only thing that distinguishes "prevented" from
    // "not noticed".
    const before = requestsFor('/popup-target.png')
    const page = await scopedPage()
    try {
      await page.navigate(site.url('/popup'))
      await page.click({ selector: '#open-offsite' })
      await page.waitFor('false', { timeoutMs: 1_500, pollIntervalMs: 100 })

      expect(requestsFor('/popup-target.png')).toBe(before)
      // And the refusal is REPORTED, at the browser level, because the
      // popup is a different page from the one the caller drove.
      expect(disposable.browser.blockedRequests.some((entry) => entry.url.includes('/popup-target.png'))).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('INVERSE of the popup test: an ON-allowlist popup still opens and reaches its page', async () => {
    // Without this pair, the test above would pass just as happily against
    // a driver that broke window.open entirely, which would look like
    // security and be a bug.
    const before = requestsFor('/reports')
    const page = await scopedPage()
    try {
      await page.navigate(site.url('/popup'))
      await page.click({ selector: '#open-onsite' })
      await page.waitFor('false', { timeoutMs: 1_500, pollIntervalMs: 100 })

      expect(requestsFor('/reports')).toBeGreaterThan(before)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('refuses a non-http scheme outright, since no origin allowlist can bound one', async () => {
    const page = await scopedPage()
    try {
      for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'chrome://settings']) {
        const result = await page.navigate(url)
        expect(result.outcome).toBe('refused')
        if (result.outcome !== 'refused') continue
        expect(result.reason).toContain('http')
      }
    } finally {
      await page.close()
    }
  }, 30_000)
})
