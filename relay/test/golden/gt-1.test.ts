/**
 * GT-1: authenticated read and count (UC-1).
 *
 * "Log into the client's admin dashboard and tell me how many pending
 * invoices there are." §16.5 says this asserts three things, and this file
 * is organised around them:
 *
 *   - LOGIN VIA BROKER. The password comes from a `SecretProvider`, not
 *     from a literal in the step list, and the fixture genuinely refuses
 *     the dashboard without the session that login establishes. A control
 *     case here proves that: the same read, without the login steps, gets
 *     "Sign in required". Without that control, this whole file would pass
 *     just as happily against a fixture that never checked anything.
 *   - EXTRACTION ACCURACY. The count is extracted twice, by two
 *     independent routes (the page's own summary line, and counting the
 *     rows that are actually pending), and both must agree with the
 *     fixture's declared number. The fixture renders six rows of which
 *     four are pending, so a naive "count the rows" extraction gets six
 *     and fails.
 *   - REPORT SHAPE. The result names the profile that acted (FR-PRF-10),
 *     the tier it acted on, what the profile's scope kept out (FR-PRF-4),
 *     and carries a screenshot. And it does NOT carry the brokered
 *     password anywhere.
 *
 * IT RUNS THE REGISTERED CAPABILITY, NOT THE DRIVER. The whole point of a
 * golden task is that the production path works, so this drives
 * `createBrowserCapability` through a `CapabilityRegistry`, exactly as
 * `src/agent/loop.ts` dispatches it. The only production defaults replaced
 * are the two config file paths, which point at a temporary profile
 * registry and policy written for this test.
 *
 * FR-PRF-10's second half, the final report naming the profile, is no
 * longer unwired: the capability declares its own report lines and
 * `src/orchestrator.ts` renders them, so the report states the profile
 * whether or not the model mentions it. That half is proven in
 * test/orchestrator.test.ts rather than here, because it is a property of
 * the report builder and not of the browser.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EnvSecretProvider } from '../../src/secrets/index.js'
import { resetSecretScrubberForTests, scrubSecrets } from '../../src/secrets/scrubber.js'
import { FIXTURE_PASSWORD, FIXTURE_PENDING_INVOICE_COUNT, FIXTURE_USERNAME } from '../support/fixture-site.js'
import { startGoldenBrowserHarness } from '../support/golden-browser.js'
import type { GoldenBrowserHarness } from '../support/golden-browser.js'
import { chromeIsAvailable } from '../support/tier2-browser.js'

const describeWithChrome = chromeIsAvailable() ? describe : describe.skip

type CompletedResult = {
  outcome: string
  profile: string
  tier: number
  finalUrl?: string
  allStepsSucceeded: boolean
  steps: Array<{ action: string; ok: boolean; target?: string; detail?: string; value?: string }>
  blockedRequests: unknown[]
  dialogs: unknown[]
}

describeWithChrome('GT-1: authenticated read and count', () => {
  let harness: GoldenBrowserHarness
  /** The brokered credential, fetched once through the SecretProvider seam exactly as a real run would. */
  let brokeredPassword: string

  beforeAll(async () => {
    harness = await startGoldenBrowserHarness()

    // "Login via broker": the value is fetched through a SecretProvider,
    // which also registers it with the process-wide scrubber, so the
    // scrubber assertion at the end is testing the real mechanism.
    resetSecretScrubberForTests()
    brokeredPassword = await new EnvSecretProvider({ RELAY_SECRET_FIXTURE_PASSWORD: FIXTURE_PASSWORD }).get(
      'fixture_password',
    )
  }, 60_000)

  afterAll(async () => {
    await harness?.dispose()
    resetSecretScrubberForTests()
  })

  /** The registered capability, dispatched the way the agent loop dispatches it. */
  function dispatch() {
    return harness.run
  }

  function loginSteps(): unknown[] {
    return [
      { action: 'navigate', url: harness.site.url('/login') },
      { action: 'type', selector: '#username', text: FIXTURE_USERNAME },
      { action: 'type', selector: '#password', text: brokeredPassword },
      { action: 'click', selector: '#submit' },
      { action: 'wait_for', expression: "location.pathname === '/dashboard'", timeoutMs: 15000 },
    ]
  }

  it('CONTROL: without the login steps the dashboard is refused, so the fixture genuinely requires a session', async () => {
    const run = dispatch()

    const result = (await run(
      {
        destination: harness.site.url('/dashboard'),
        explicitProfile: harness.profileName,
        steps: [{ action: 'navigate', url: harness.site.url('/dashboard') }, { action: 'read_text' }],
      },
      new AbortController().signal,
    )) as CompletedResult

    expect(result.outcome).toBe('completed')
    const text = result.steps.find((step) => step.action === 'read_text')?.value ?? ''
    expect(text).toContain('Sign in required')
    expect(text).not.toContain('Pending invoices')
  }, 90_000)

  it('logs in with a brokered credential, reads the dashboard, and counts the pending invoices accurately', async () => {
    const run = dispatch()

    const result = (await run(
      {
        destination: harness.site.url('/dashboard'),
        explicitProfile: harness.profileName,
        steps: [
          ...loginSteps(),
          { action: 'read_text' },
          { action: 'read_html' },
          { action: 'screenshot' },
        ],
      },
      new AbortController().signal,
    )) as CompletedResult

    // --- the run itself -----------------------------------------------
    expect(result.outcome).toBe('completed')
    expect(result.allStepsSucceeded).toBe(true)
    expect(result.steps.every((step) => step.ok)).toBe(true)
    expect(result.finalUrl).toBe(harness.site.url('/dashboard'))

    // --- extraction accuracy, by two independent routes ----------------
    const text = result.steps.find((step) => step.action === 'read_text')?.value ?? ''
    const html = result.steps.find((step) => step.action === 'read_html')?.value ?? ''

    const fromSummary = Number.parseInt(/Pending invoices:\s*(\d+)/.exec(text)?.[1] ?? 'NaN', 10)
    const fromRows = (html.match(/data-status="pending"/g) ?? []).length
    const totalRows = (html.match(/class="invoice"/g) ?? []).length

    expect(fromSummary).toBe(FIXTURE_PENDING_INVOICE_COUNT)
    expect(fromRows).toBe(FIXTURE_PENDING_INVOICE_COUNT)
    // The trap this fixture sets: a "count the rows" extraction gets six.
    // Asserting the two differ is what makes the two agreeing meaningful.
    expect(totalRows).toBeGreaterThan(FIXTURE_PENDING_INVOICE_COUNT)

    // --- report shape ---------------------------------------------------
    // FR-PRF-10: the result names the profile that acted.
    expect(result.profile).toBe(harness.profileName)
    // FR-PRF-4a: it acted on an enforcing tier, not on tier 1.
    expect(result.tier).toBe(2)
    // FR-PRF-4: what the scope kept out is reported, even when empty.
    expect(Array.isArray(result.blockedRequests)).toBe(true)
    expect(result.blockedRequests).toEqual([])
    expect(result.dialogs).toEqual([])
    // UC-1's "report with screenshot".
    const screenshot = result.steps.find((step) => step.action === 'screenshot')?.value ?? ''
    expect(screenshot.startsWith('iVBORw0KGgo')).toBe(true)

    // --- the credential never comes back --------------------------------
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain(brokeredPassword)
    // And if it somehow did, the scrubber the broker registered it with
    // would still redact it at the output boundary.
    expect(scrubSecrets(`the password is ${brokeredPassword}`)).not.toContain(brokeredPassword)
  }, 90_000)

  it('does the same task addressing every element by accessible role and name, with no CSS selector at all', async () => {
    // FR-BR-7's preferred rung, end to end through the registered
    // capability. This is the shape a model should actually produce, since
    // it has not seen the page and can learn these names from a
    // read_elements step; the selector-based run above is the fallback.
    const run = dispatch()

    const result = (await run(
      {
        destination: harness.site.url('/dashboard'),
        explicitProfile: harness.profileName,
        steps: [
          { action: 'navigate', url: harness.site.url('/login') },
          { action: 'read_elements' },
          { action: 'type', role: 'textbox', name: 'Username', text: FIXTURE_USERNAME },
          { action: 'type', role: 'textbox', name: 'Password', text: brokeredPassword },
          { action: 'click', role: 'button', name: 'Sign in' },
          { action: 'wait_for', expression: "location.pathname === '/dashboard'", timeoutMs: 15000 },
          { action: 'read_text' },
        ],
      },
      new AbortController().signal,
    )) as CompletedResult

    expect(result.outcome).toBe('completed')
    expect(result.allStepsSucceeded).toBe(true)

    // The read_elements step is what makes this shape usable by a caller
    // that cannot see the page, so it must actually name the controls.
    const elements = result.steps.find((step) => step.action === 'read_elements')?.value ?? ''
    expect(elements).toContain('"name":"Sign in"')

    const text = result.steps.at(-1)?.value ?? ''
    expect(Number.parseInt(/Pending invoices:\s*(\d+)/.exec(text)?.[1] ?? 'NaN', 10)).toBe(
      FIXTURE_PENDING_INVOICE_COUNT,
    )
  }, 90_000)

  it('refuses the whole task when the destination is outside the profile\'s scope, before any browser starts', async () => {
    const run = dispatch()

    const result = (await run(
      {
        destination: `http://localhost:${harness.site.port}/dashboard`,
        explicitProfile: harness.profileName,
        steps: [{ action: 'navigate', url: `http://localhost:${harness.site.port}/dashboard` }],
      },
      new AbortController().signal,
    )) as { outcome: string; enforcement: string; tier: number }

    expect(result.outcome).toBe('navigation_refused')
    expect(result.enforcement).toBe('prevented')
    expect(result.tier).toBe(2)
  }, 60_000)
})
