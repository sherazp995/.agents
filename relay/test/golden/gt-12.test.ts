/**
 * GT-12: expired session recovery. "Re-auth request rather than silent
 * retry."
 *
 * Extended here to cover FR-BR-8's other three cases in the same shape,
 * because they fail identically if the detection is missing and it would
 * be strange to prove one and not the others: a CAPTCHA, a bot wall, and a
 * rate-limit page all present to the rest of the system as an ordinary read
 * of an ordinary page.
 *
 * THE CENTRAL ASSERTION OF THIS FILE is the combination, not either half:
 * `allStepsSucceeded` is TRUE while `humanActionNeeded` is present. Every
 * step did exactly what it was told. The driver navigated, the page loaded,
 * the text was read. And the thing that was read was a bot wall. A report
 * built from step outcomes alone would call that a success and hand the
 * model a page it should not summarise, which is the most damaging failure
 * this driver can have because it is indistinguishable from working.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startGoldenBrowserHarness } from '../support/golden-browser.js'
import type { GoldenBrowserHarness } from '../support/golden-browser.js'
import { chromeIsAvailable } from '../support/tier2-browser.js'

const describeWithChrome = chromeIsAvailable() ? describe : describe.skip

type CompletedResult = {
  outcome: string
  allStepsSucceeded: boolean
  steps: Array<{ action: string; ok: boolean; value?: string }>
  humanActionNeeded?: {
    kind: string
    confidence: string
    evidence: string
    action: string
    message: string
  }
}

describeWithChrome('GT-12: a page that needs a human is reported as needing one', () => {
  let harness: GoldenBrowserHarness

  beforeAll(async () => {
    harness = await startGoldenBrowserHarness()
  }, 60_000)

  afterAll(async () => {
    await harness?.dispose()
  })

  async function readPath(path: string): Promise<CompletedResult> {
    const url = harness.site.url(path)
    return (await harness.run(
      {
        destination: url,
        explicitProfile: harness.profileName,
        steps: [{ action: 'navigate', url }, { action: 'read_text' }],
      },
      new AbortController().signal,
    )) as CompletedResult
  }

  it('reports an unauthenticated dashboard as a re-authentication request naming the profile, not as a successful read', async () => {
    const result = await readPath('/dashboard')

    expect(result.outcome).toBe('completed')
    // Every step did what it was told. That is exactly why the flag below
    // has to exist.
    expect(result.allStepsSucceeded).toBe(true)

    expect(result.humanActionNeeded).toBeDefined()
    expect(result.humanActionNeeded?.kind).toBe('signed_out')
    expect(result.humanActionNeeded?.confidence).toBe('likely')
    // FR-PRF-8: names the profile, not merely the site.
    expect(result.humanActionNeeded?.message).toContain(`"${harness.profileName}" profile`)
    expect(result.humanActionNeeded?.action).toContain('Sign in')
    // FR-BR-10's acceptance criterion is about what does NOT happen: one
    // read, one clear request, not five attempts.
    expect(result.steps.filter((step) => step.action === 'navigate')).toHaveLength(1)
  }, 60_000)

  it('reports a CAPTCHA and states plainly that Relay will not work around it', async () => {
    const result = await readPath('/captcha')

    expect(result.humanActionNeeded?.kind).toBe('captcha')
    expect(result.humanActionNeeded?.confidence).toBe('likely')
    expect(result.humanActionNeeded?.action).toContain('does not solve CAPTCHAs')
  }, 60_000)

  it('reports a bot wall rather than summarising "Checking your browser" as if it were the content', async () => {
    const result = await readPath('/bot-wall')

    expect(result.humanActionNeeded?.kind).toBe('bot_wall')
    // The read still succeeded and still returned the wall's own text. The
    // flag is what stops that text being mistaken for the page.
    expect(result.steps.find((step) => step.action === 'read_text')?.value).toContain('Checking your browser')
  }, 60_000)

  it('reports a rate limit and does not retry past it', async () => {
    const before = harness.site.requests.filter((path) => path === '/rate-limited').length

    const result = await readPath('/rate-limited')

    expect(result.humanActionNeeded?.kind).toBe('rate_limited')
    expect(result.humanActionNeeded?.action).toContain('stopped rather than retrying')
    // FR-BR-8's "never worked around", checked against the server's own
    // log: exactly one request, not a retry loop.
    expect(harness.site.requests.filter((path) => path === '/rate-limited').length).toBe(before + 1)
  }, 60_000)

  it('CONTROL: an ordinary authenticated page raises nothing, so the flag means something when it appears', async () => {
    const url = harness.site.url('/dashboard')
    const result = (await harness.run(
      {
        destination: url,
        explicitProfile: harness.profileName,
        steps: [
          { action: 'navigate', url: harness.site.url('/login') },
          { action: 'type', selector: '#username', text: 'operator' },
          { action: 'type', selector: '#password', text: 'correct-horse' },
          { action: 'click', selector: '#submit' },
          { action: 'wait_for', expression: "location.pathname === '/dashboard'", timeoutMs: 15000 },
          { action: 'read_text' },
        ],
      },
      new AbortController().signal,
    )) as CompletedResult

    expect(result.allStepsSucceeded).toBe(true)
    expect(result.steps.at(-1)?.value).toContain('Pending invoices')
    // A detector that fired here would be worse than no detector: an
    // operator told "human action needed" on every successful run stops
    // reading the flag.
    expect(result.humanActionNeeded).toBeUndefined()
  }, 60_000)
})
