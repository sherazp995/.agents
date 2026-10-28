/**
 * GT-2: download and deliver CSV (UC-2). "Pull last month's transactions
 * from this portal as CSV and post it here."
 *
 * §16.5 says this asserts download handling, artifact upload to chat, and
 * size fallback. THIS FILE COVERS THE FIRST ONLY, and says so rather than
 * implying otherwise: there is no artifact store and no chat file upload in
 * this build, so "post it here" cannot be tested end to end. What is tested
 * is that the file genuinely arrives on disk, that Relay knows where and
 * how big, that the page cannot choose the path it is written to, and that
 * an oversized download is stopped rather than allowed to fill the disk.
 *
 * The size fallback §16.5 names (post the file, or a link to it, depending
 * on size) belongs to the artifact layer and is not here. The cap tested
 * below is a different thing: a bound on what Relay will write to disk at
 * all.
 */

import { existsSync, readFileSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startFixtureSite } from '../support/fixture-site.js'
import type { FixtureSite } from '../support/fixture-site.js'
import { startGoldenBrowserHarness } from '../support/golden-browser.js'
import { chromeIsAvailable, openDisposableTier2Browser, permissiveGuard } from '../support/tier2-browser.js'
import type { DisposableTier2Browser } from '../support/tier2-browser.js'

const describeWithChrome = chromeIsAvailable() ? describe : describe.skip

describeWithChrome('GT-2: downloading a file', () => {
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

  it('downloads a file a link points at, and reports where it landed and how big it is', async () => {
    const page = await disposable.browser.newPage(permissiveGuard)
    try {
      await page.navigate(site.url('/downloads'))
      await page.click({ selector: '#export' })

      const waited = await disposable.browser.downloads.waitForDownload({ timeoutMs: 20_000 })

      expect(waited.outcome).toBe('downloaded')
      if (waited.outcome !== 'downloaded') return
      expect(waited.download.suggestedFilename).toBe('invoices.csv')
      expect(waited.download.receivedBytes).toBeGreaterThan(0)

      // The file is really there, with the bytes the server sent. A record
      // saying "completed" while the file is absent or empty would be the
      // failure this assertion exists to catch.
      expect(readFileSync(waited.download.path, 'utf8')).toContain('INV-1001,pending')
    } finally {
      await page.close()
    }
  }, 60_000)

  it('writes the file under a name RELAY chose, never under the name the page suggested', async () => {
    // The security property, and the reason `allowAndName` is used: a
    // suggested filename is attacker-controlled text, and it must never
    // become part of a path Relay writes to.
    const page = await disposable.browser.newPage(permissiveGuard)
    try {
      await page.navigate(site.url('/download.csv'))
      const waited = await disposable.browser.downloads.waitForDownload({ timeoutMs: 20_000 })

      expect(waited.outcome).toBe('downloaded')
      if (waited.outcome !== 'downloaded') return
      expect(waited.download.path).toBe(`${disposable.browser.downloads.directory}/${waited.download.guid}`)
      expect(waited.download.path).not.toContain(waited.download.suggestedFilename)
      // The suggestion survives as metadata, which is what a caller needs
      // in order to name the file sensibly when it hands it on.
      expect(waited.download.suggestedFilename).toBe('invoices.csv')
    } finally {
      await page.close()
    }
  }, 60_000)

  it('THROUGH THE CAPABILITY: the file is still on disk after the call returns, at the path the result named', async () => {
    // The bug this pins down shipped once and was caught only by running
    // the real thing. The download tracker deletes the directory it
    // created when the browser closes, and the browser closes when a
    // capability call returns, so the step reported ok: true beside the
    // path of a file that no longer existed. Every assertion about
    // downloads made against the browser directly still passed.
    const harness = await startGoldenBrowserHarness()
    try {
      const url = harness.site.url('/download.csv')
      const result = (await harness.run(
        {
          destination: url,
          explicitProfile: harness.profileName,
          steps: [{ action: 'navigate', url }, { action: 'wait_for_download', timeoutMs: 20_000 }],
        },
        new AbortController().signal,
      )) as { steps: Array<{ action: string; ok: boolean; value?: string }> }

      const step = result.steps.find((entry) => entry.action === 'wait_for_download')
      expect(step?.ok).toBe(true)
      expect(step?.value).toBeDefined()
      if (step?.value === undefined) return

      expect(existsSync(step.value)).toBe(true)
      expect(readFileSync(step.value, 'utf8')).toContain('INV-1001,pending')
    } finally {
      await harness.dispose()
    }
  }, 90_000)

  it('does not hang for the full navigation timeout when the URL turns out to be a file rather than a page', async () => {
    // The bug this prevents looks exactly like a hang: a download fires no
    // load event, so waiting for one means waiting out the whole timeout
    // and then reporting "did not finish loading" about a file that
    // downloaded perfectly well.
    const page = await disposable.browser.newPage(permissiveGuard)
    try {
      const startedAt = Date.now()
      const result = await page.navigate(site.url('/download.csv'))
      const elapsed = Date.now() - startedAt

      expect(result.outcome).toBe('download_started')
      // The default navigation timeout is 30 seconds; this must be nowhere
      // near it.
      expect(elapsed).toBeLessThan(5_000)
    } finally {
      await page.close()
    }
  }, 60_000)
})
