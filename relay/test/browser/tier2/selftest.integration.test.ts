/**
 * The tier 2 self-test, run for real: a real headless Chrome, a real local
 * server, a real enforcement check.
 *
 * This is the one test in the suite whose subject is "does this machine
 * work", rather than "does this code behave". It is deliberately close to
 * what `relay smoke` runs, because a self-test that passes in the suite and
 * fails on the operator's machine, or the reverse, would be worse than
 * having none.
 */

import { describe, expect, it } from 'vitest'

import { runTier2SelfTest } from '../../../src/browser/tier2/selftest.js'
import { chromeIsAvailable } from '../../support/tier2-browser.js'

const describeWithChrome = chromeIsAvailable() ? describe : describe.skip

describe('runTier2SelfTest without a Chrome to run', () => {
  it('skips with a reason naming the path it looked at, rather than failing', async () => {
    const result = await runTier2SelfTest({
      executablePath: '/nowhere/Google Chrome',
      chromeIsInstalled: () => false,
    })

    expect(result.outcome).toBe('skipped')
    if (result.outcome !== 'skipped') return
    expect(result.reason).toContain('/nowhere/Google Chrome')
  })
})

describeWithChrome('runTier2SelfTest against the real browser on this machine', () => {
  it('launches Chrome, reads back the page it served, and confirms an off-allowlist request was prevented', async () => {
    const result = await runTier2SelfTest()

    // Reported in full on failure: this test failing means the machine
    // cannot enforce origin scoping, and the reason is the whole message.
    expect(result.outcome === 'passed' ? 'passed' : `${result.outcome}: ${result.reason}`).toBe('passed')
    if (result.outcome !== 'passed') return
    expect(result.detail).toContain('prevented from leaving the browser')
  }, 60_000)

  it('is not so slow that an operator would skip running it', async () => {
    // A readiness check nobody waits for is a readiness check nobody runs.
    // Generous rather than tight: this is a smoke bound, not a benchmark,
    // and it should fail only if something has genuinely regressed into
    // waiting on a timeout.
    const startedAt = Date.now()
    await runTier2SelfTest()
    expect(Date.now() - startedAt).toBeLessThan(20_000)
  }, 60_000)
})
