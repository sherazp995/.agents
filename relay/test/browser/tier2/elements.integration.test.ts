/**
 * FR-BR-7: "element resolution prefers accessible role and name, then
 * stable attributes, then text, then position. Failures record the full
 * accessibility snapshot for later learning."
 *
 * Against a real browser, because the top rung of that ladder is Chrome's
 * own accessibility tree and there is no way to be sure what it computes
 * for a given piece of markup other than by asking it. A unit test with a
 * hand-written tree would prove only that this code agrees with what
 * somebody assumed Chrome does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DrivablePage } from '../../../src/browser/tier2/page.js'
import { startFixtureSite } from '../../support/fixture-site.js'
import type { FixtureSite } from '../../support/fixture-site.js'
import { chromeIsAvailable, openDisposableTier2Browser, permissiveGuard } from '../../support/tier2-browser.js'
import type { DisposableTier2Browser } from '../../support/tier2-browser.js'

const describeWithChrome = chromeIsAvailable() ? describe : describe.skip

describeWithChrome('FR-BR-7: resolving an element by what it is, not by how it is built', () => {
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

  function openPage(): Promise<DrivablePage> {
    return disposable.browser.newPage(permissiveGuard)
  }

  it('lists the page\'s named interactive elements, so a caller that cannot see the page can target them', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      const elements = await page.readElements()

      expect(elements.map((element) => `${element.role}:${element.name}`)).toEqual(
        expect.arrayContaining(['textbox:Username', 'textbox:Password', 'button:Sign in']),
      )
      // Structure is excluded: a list dominated by generic containers is a
      // list nobody reads and a lot of context wasted.
      expect(elements.every((element) => element.role !== 'generic')).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('completes a whole login addressing every field by role and name, with no CSS selector anywhere', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))

      expect(await page.type({ role: 'textbox', name: 'Username' }, 'operator')).toEqual({ typed: true })
      expect(await page.type({ role: 'textbox', name: 'Password' }, 'correct-horse')).toEqual({ typed: true })
      expect(await page.click({ role: 'button', name: 'Sign in' })).toEqual({ clicked: true })

      const arrived = await page.waitFor("location.pathname === '/dashboard'", { timeoutMs: 10_000 })
      expect(arrived.outcome).toBe('satisfied')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('matches an accessible name case-insensitively, because a caller is quoting a person, not a string literal', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))
      expect(await page.click({ role: 'button', name: 'sign in' })).toEqual({ clicked: true })
    } finally {
      await page.close()
    }
  }, 30_000)

  it('REFUSES an ambiguous role and name rather than clicking the first match', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/ambiguous'))

      const result = await page.click({ role: 'button', name: 'Delete' })

      expect(result.clicked).toBe(false)
      expect(result.reason).toContain('2 elements match')
      expect(result.reason).toContain('refused rather than guessing')
      // And nothing was clicked: on a real page the two buttons delete two
      // different records, so guessing is not a small error.
      expect(await page.evaluate<string>("document.getElementById('clicked').textContent")).toBe('none')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('acts normally on the unambiguous element of the same page, so the refusal above is about ambiguity and not a broken resolver', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/ambiguous'))
      expect(await page.click({ role: 'button', name: 'Archive all' })).toEqual({ clicked: true })
      expect(await page.evaluate<string>("document.getElementById('clicked').textContent")).toBe('unique')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('does not fall through to a weaker rung when the role-and-name rung was ambiguous', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/ambiguous'))

      // A selector is supplied too, and it points at the FIRST Delete. If
      // ambiguity fell through to it, the click would succeed and the wrong
      // record would be deleted while the caller believed it had named the
      // element precisely.
      const result = await page.click({ role: 'button', name: 'Delete', selector: '#delete-1' })

      expect(result.clicked).toBe(false)
      expect(await page.evaluate<string>("document.getElementById('clicked').textContent")).toBe('none')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('falls back to the CSS selector when the role and name simply do not match anything', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/ambiguous'))

      // The ladder's point: a stored procedure whose accessible name has
      // changed still works through its lower rungs.
      const result = await page.click({ role: 'button', name: 'A name nothing has', selector: '#delete-2' })

      expect(result).toEqual({ clicked: true })
      expect(await page.evaluate<string>("document.getElementById('clicked').textContent")).toBe('second')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('falls back to visible text as the last rung', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/ambiguous'))
      expect(await page.click({ hasText: 'Archive' })).toEqual({ clicked: true })
      expect(await page.evaluate<string>("document.getElementById('clicked').textContent")).toBe('unique')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('records what the page DID offer when nothing matched, per FR-BR-7\'s snapshot requirement', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/login'))

      const result = await page.click({ role: 'button', name: 'Nonexistent Button' })

      expect(result.clicked).toBe(false)
      expect(result.reason).toContain('Nonexistent Button')
      // The snapshot: an operator reading the report can see what was
      // actually there instead of only that the click failed.
      expect(result.reason).toContain('the page offers')
      expect(result.reason).toContain('button "Sign in"')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('selects an option on an element resolved by role and name, not only by selector', async () => {
    const page = await openPage()
    try {
      await page.navigate(site.url('/form'))
      const elements = await page.readElements()
      const combobox = elements.find((element) => element.role === 'combobox')
      expect(combobox).toBeDefined()
      if (combobox === undefined) return

      expect(await page.selectOption({ role: 'combobox', name: combobox.name }, 'gold')).toEqual({ selected: true })
      expect(await page.evaluate<string>("document.getElementById('tier').value")).toBe('gold')
    } finally {
      await page.close()
    }
  }, 30_000)
})
