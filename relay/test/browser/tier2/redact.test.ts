import { describe, expect, it } from 'vitest'

import {
  buildRedactionScript,
  CREDENTIAL_SELECTORS,
  decideRedaction,
  REDACTION_ATTRIBUTE,
} from '../../../src/browser/tier2/redact.js'

/**
 * FR-SEC-6 has two halves and the second is the one usually skipped: a view
 * whose credential fields cannot be masked is NOT PERSISTED, rather than
 * persisted unmasked and hoped about.
 */

describe('what counts as a credential field', () => {
  it('covers password inputs and the standardised autocomplete tokens', () => {
    // The autocomplete token is how a page DECLARES a field holds a card
    // number or a one-time code, which is a far better signal than guessing
    // at `name`, which is arbitrary.
    const joined = CREDENTIAL_SELECTORS.join(' ')

    expect(joined).toContain('input[type="password"]')
    expect(joined).toContain('cc-number')
    expect(joined).toContain('one-time-code')
  })
})

describe('the injected script', () => {
  it('interpolates nothing from the page, so a hostile page has nothing to inject into', () => {
    const script = buildRedactionScript()

    // Every dynamic part is JSON-encoded from constants this module owns.
    expect(script).toContain(JSON.stringify(CREDENTIAL_SELECTORS.join(',')))
    expect(script).toContain(JSON.stringify(REDACTION_ATTRIBUTE))
  })

  it('paints an opaque cover rather than only blanking the value', () => {
    // A password input renders dots, but a cc-number field renders the
    // digits in the clear, and "it was only dots anyway" is not a property
    // to rely on across every field this matches.
    expect(buildRedactionScript()).toContain('background:#000')
  })

  it('counts frames it cannot see into', () => {
    expect(buildRedactionScript()).toContain('unreachable')
  })
})

describe('FR-SEC-6: an unmaskable view is not persisted', () => {
  it('REFUSES when a cross-origin frame might hold a credential field', () => {
    // There is no way to know from outside the frame, so the safe reading is
    // that it might: a false refusal costs a screenshot, a false pass costs
    // a credential in a stored artifact.
    const decision = decideRedaction({ masked: 0, unmaskableFrames: 1 })

    expect(decision.outcome).toBe('unmaskable')
    if (decision.outcome !== 'unmaskable') return
    expect(decision.reason).toContain('NOT persisted')
    expect(decision.reason).toContain('FR-SEC-6')
  })

  it('allows a page with no unreachable frames, reporting what it masked', () => {
    const decision = decideRedaction({ masked: 2, unmaskableFrames: 0 })

    expect(decision.outcome).toBe('clean')
    expect(decision.report.masked).toBe(2)
  })

  it('allows a page with nothing to mask at all', () => {
    expect(decideRedaction({ masked: 0, unmaskableFrames: 0 }).outcome).toBe('clean')
  })
})
