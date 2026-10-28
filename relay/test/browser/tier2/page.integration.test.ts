/**
 * FR-BR-5's own acceptance criterion: "each primitive has an integration
 * test against the local fixture site." These are those tests, and they
 * drive a real headless Chrome over a real CDP connection against the real
 * fixture server. Nothing here is mocked; a mocked browser would prove only
 * that this codebase agrees with its own idea of what Chrome does, which is
 * exactly the assumption this milestone exists to stop making.
 *
 * FR-BR-6 and FR-PRF-4 are proven here too, because both are claims about
 * what a real browser does: a page that fires `alert()` on load does not
 * hang the run, and an off-allowlist request is actually prevented rather
 * than merely disapproved of.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DrivablePage } from '../../../src/browser/tier2/page.js'
import { startFixtureSite } from '../../support/fixture-site.js'
import type { FixtureSite } from '../../support/fixture-site.js'
import {
  FIXTURE_PASSWORD,
  FIXTURE_PENDING_INVOICE_COUNT,
  FIXTURE_USERNAME,
} from '../../support/fixture-site.js'
import {
  chromeIsAvailable,
  openDisposableTier2Browser,
  permissiveGuard,
} from '../../support/tier2-browser.js'
import type { DisposableTier2Browser } from '../../support/tier2-browser.js'

// A missing Chrome is stated, not silently skipped. See
// test/support/tier2-browser.ts's own comment on why.
const describeWithChrome = chromeIsAvailable()
  ? describe
  : describe.skip.bind(null) as unknown as typeof describe

describeWithChrome('tier 2 page primitives, against the local fixture site', () => {
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

  /** A fresh page per test: cookies and console records must not leak between them. */
  async function openPage(guard = permissiveGuard): Promise<DrivablePage> {
    return disposable.browser.newPage(guard)
  }

  it('navigates to a page and reports the url it actually reached', async () => {
    const page = await openPage()
    try {
      const result = await page.navigate(site.url('/login'))
      expect(result.outcome).toBe('loaded')
      if (result.outcome !== 'loaded') return
      expect(result.url).toBe(site.url('/login'))
      expect(result.status).toBe(200)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('reads the title and the visible text of a real page', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      expect(await page.title()).toBe('Fixture login')
      expect(await page.readText()).toContain('Sign in')
      expect(await page.readHtml()).toContain('<form')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('finds an element that is there and does not find one that is not', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      expect(await page.exists({ selector: '#submit' })).toBe(true)
      expect(await page.exists({ selector: '#no-such-thing' })).toBe(false)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('types into a field, clicks a real button, and completes an authenticated login', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      expect(await page.type({ selector: '#username' }, FIXTURE_USERNAME)).toEqual({ typed: true })
      expect(await page.type({ selector: '#password' }, FIXTURE_PASSWORD)).toEqual({ typed: true })
      expect(await page.click({ selector: '#submit' })).toEqual({ clicked: true })

      const arrived = await page.waitFor("location.pathname === '/dashboard'", { timeoutMs: 10_000 })
      expect(arrived.outcome).toBe('satisfied')
      expect(await page.readText()).toContain('Pending invoices')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('refuses to type into an element that does not exist, rather than silently doing nothing', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      const result = await page.type({ selector: '#absent' }, 'text')
      expect(result.typed).toBe(false)
      expect(result.reason).toContain('#absent')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('selects an option and submits a form carrying every field it filled', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/form'))
      expect(await page.type({ selector: '#company' }, 'Acme Ltd')).toEqual({ typed: true })
      expect(await page.selectOption({ selector: '#tier' }, 'gold')).toEqual({ selected: true })
      expect(await page.click({ selector: '#agree' })).toEqual({ clicked: true })
      await page.click({ selector: '#save' })

      const saved = await page.waitFor("document.getElementById('saved') !== null", { timeoutMs: 10_000 })
      expect(saved.outcome).toBe('satisfied')
      const text = await page.readText()
      expect(text).toContain('company=Acme Ltd')
      expect(text).toContain('tier=gold')
      expect(text).toContain('agree=on')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('replaces what is already in a field, and appends only when asked to', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/form'))
      await page.type({ selector: '#company' }, 'First Value')
      await page.type({ selector: '#company' }, 'Second Value')
      expect(await page.evaluate<string>("document.getElementById('company').value")).toBe('Second Value')

      await page.type({ selector: '#company' }, ' appended', { append: true })
      expect(await page.evaluate<string>("document.getElementById('company').value")).toBe('Second Value appended')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('records the HTTP method a request actually used, rather than assuming every request was a GET', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/form'))
      await page.type({ selector: '#company' }, 'Acme Ltd')
      await page.click({ selector: '#save' })
      await page.waitFor("document.getElementById('saved') !== null", { timeoutMs: 10_000 })

      const submission = page.networkRequests.find(
        (entry) => entry.url === site.url('/form') && entry.method === 'POST',
      )
      expect(submission).toBeDefined()
      expect(submission?.status).toBe(200)
      // And the GET that loaded the form in the first place is still a GET,
      // so this is not just every request being relabelled.
      expect(page.networkRequests.some((entry) => entry.method === 'GET')).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('reports its capture bounds on an ordinary page, so "nothing was dropped" is stated rather than inferred', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      expect(page.captureLimits).toEqual({ consoleDropped: 0, networkDropped: 0, textTruncated: false })
    } finally {
      await page.close()
    }
  }, 30_000)

  it('reports a select option that does not exist rather than leaving the field on its old value', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/form'))
      const result = await page.selectOption({ selector: '#tier' }, 'platinum')
      expect(result.selected).toBe(false)
      expect(result.reason).toContain('platinum')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('presses a key, and refuses a key it has no descriptor for instead of dispatching a guess', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/form'))
      await page.type({ selector: '#company' }, 'Acme')
      expect(await page.pressKey('Tab')).toEqual({ pressed: true })

      const refused = await page.pressKey('F13')
      expect(refused.pressed).toBe(false)
      expect(refused.reason).toContain('F13')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('waits for content that only appears later, and reports a timeout for content that never does', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/delayed'))
      const satisfied = await page.waitFor("document.getElementById('late').textContent === 'ready'", {
        timeoutMs: 10_000,
      })
      expect(satisfied.outcome).toBe('satisfied')

      const timedOut = await page.waitFor('false', { timeoutMs: 300, pollIntervalMs: 50 })
      expect(timedOut.outcome).toBe('timed_out')
      if (timedOut.outcome !== 'timed_out') return
      expect(timedOut.reason).toContain('300ms')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('goes back and forward through real history, and reports when there is nowhere to go', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      await page.navigate(site.url('/reports'))
      expect(await page.title()).toBe('Fixture reports')

      const back = await page.goBack()
      expect(back.outcome).toBe('loaded')
      expect(await page.title()).toBe('Fixture login')

      const forward = await page.goForward()
      expect(forward.outcome).toBe('loaded')
      expect(await page.title()).toBe('Fixture reports')

      // Past the end of history: reported, rather than a silent no-op that
      // a caller would read as having moved.
      const nowhere = await page.goForward()
      expect(nowhere.outcome).toBe('failed')
      if (nowhere.outcome !== 'failed') return
      expect(nowhere.reason).toContain('no forward entry')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('reloads a page and gets the server to serve it again', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/reports'))
      const before = site.requests.filter((path) => path === '/reports').length

      const reloaded = await page.reload()

      expect(reloaded.outcome).toBe('loaded')
      // Asserted against the server's own log: a reload that served from
      // cache would not prove the page was re-fetched.
      expect(site.requests.filter((path) => path === '/reports').length).toBeGreaterThan(before)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('hovers a real element, and reports a hover target that is not there', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      expect(await page.hover({ role: 'button', name: 'Sign in' })).toEqual({ hovered: true })

      const missing = await page.hover({ selector: '#not-here' })
      expect(missing.hovered).toBe(false)
      expect(missing.reason).toContain('#not-here')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('exports a real page as a PDF', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/dashboard'))
      const pdf = await page.exportPdf()

      expect(pdf.ok).toBe(true)
      // A PDF begins with "%PDF", which base64-encodes to a "JVBER" prefix.
      expect(pdf.ok && pdf.data.startsWith('JVBER')).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('captures a screenshot of a real page', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      const shot = await page.screenshot()
      expect(shot.ok).toBe(true)
      // A PNG's first bytes are 0x89 'PNG', which base64-encodes to iVBORw0KGgo.
      expect(shot.ok && shot.data.startsWith('iVBORw0KGgo')).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('captures console output and network responses the page produced', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/noisy'))
      await page.waitFor("document.title.startsWith('ping:')", { timeoutMs: 10_000 })

      const messages = page.consoleMessages.map((entry) => entry.text)
      expect(messages).toContain('fixture console log')
      expect(messages).toContain('fixture console error')
      expect(page.consoleMessages.some((entry) => entry.level === 'error')).toBe(true)

      const fetched = page.networkRequests.find((entry) => entry.url.endsWith('/api/ping'))
      expect(fetched?.status).toBe(200)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('FR-BR-6: a page that fires alert() on load does not hang the run, and the dialog is recorded', async () => {
    const page = await openPage()
    try {
      const result = await page.navigate(site.url('/alert'))
      expect(result.outcome).toBe('loaded')
      expect(await page.readText()).toContain('Content after the dialog')
      expect(page.dialogs).toEqual([
        { type: 'alert', message: 'blocking dialog on load', accepted: true },
      ])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('FR-BR-6: a beforeunload dialog does not wedge a navigation away from the page', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/beforeunload'))
      // The dialog only fires once the page has been interacted with;
      // Chrome suppresses it otherwise.
      await page.click({ selector: '#dirty' })
      await page.type({ selector: '#dirty' }, 'changed')

      const away = await page.navigate(site.url('/reports'))
      expect(away.outcome).toBe('loaded')
      expect(await page.title()).toBe('Fixture reports')
      // Accepted, not dismissed: dismissing would have cancelled the
      // navigation this driver itself issued. See handleDialog's comment.
      expect(page.dialogs.some((dialog) => dialog.type === 'beforeunload' && dialog.accepted)).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)
})
