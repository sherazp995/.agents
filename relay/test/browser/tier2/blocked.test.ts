import { describe, expect, it } from 'vitest'

import { describeHumanBlock, detectHumanBlock } from '../../../src/browser/tier2/blocked.js'
import type { PageObservation } from '../../../src/browser/tier2/blocked.js'

/**
 * FR-BR-8 and FR-BR-10's decision table, exhaustively, with no browser.
 *
 * The important tests in this file are the NEGATIVE ones. A detector that
 * fires on everything satisfies every positive test here and is useless:
 * it would report "human action needed" on the ordinary dashboard GT-1
 * reads, and an operator who is told that twice stops believing it the
 * third time, which is precisely when it matters.
 */

function observe(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    url: 'https://app.example.com/invoices',
    title: 'Invoices',
    text: 'Pending invoices: 4',
    html: '<html><body><p>Pending invoices: 4</p></body></html>',
    status: 200,
    ...overrides,
  }
}

describe('detectHumanBlock: an ordinary page is not a block', () => {
  it('reports nothing for the page GT-1 actually reads', () => {
    expect(detectHumanBlock(observe())).toBeUndefined()
  })

  it('does not fire on a signed-in page that merely offers a sign-out link', () => {
    const result = detectHumanBlock(
      observe({
        text: 'Pending invoices: 4 Sign out Switch account',
        html: '<a href="/logout">Sign out</a><a href="/login">Sign in with a different account</a>',
      }),
    )

    expect(result).toBeUndefined()
  })

  it('does not fire on a page that merely writes ABOUT captchas in its body text', () => {
    // A support article, a changelog, a security page. The CAPTCHA check
    // deliberately looks at markup markers, not at prose.
    const result = detectHumanBlock(
      observe({ text: 'We removed the CAPTCHA from our checkout flow this quarter.' }),
    )

    expect(result).toBeUndefined()
  })
})

describe('FR-BR-8: captcha, bot wall, two factor, rate limit', () => {
  it('detects a reCAPTCHA widget from its markup and refuses to work around it', () => {
    const result = detectHumanBlock(
      observe({ html: '<div class="g-recaptcha" data-sitekey="abc"></div>' }),
    )

    expect(result?.kind).toBe('captcha')
    expect(result?.confidence).toBe('likely')
    expect(result?.evidence).toContain('reCAPTCHA')
    expect(result?.action).toContain('does not solve CAPTCHAs')
  })

  it('detects hCaptcha and Turnstile, not only Google\'s', () => {
    expect(detectHumanBlock(observe({ html: '<script src="https://hcaptcha.com/1/api.js"></script>' }))?.kind).toBe(
      'captcha',
    )
    expect(detectHumanBlock(observe({ html: '<div class="cf-turnstile"></div>' }))?.kind).toBe('captcha')
  })

  it('treats an HTTP 429 as a rate limit on the server\'s own authority, not as a guess', () => {
    const result = detectHumanBlock(observe({ status: 429 }))

    expect(result?.kind).toBe('rate_limited')
    expect(result?.confidence).toBe('likely')
    expect(result?.evidence).toContain('429')
    // FR-BR-8's "never worked around": the action must not suggest retrying.
    expect(result?.action).toContain('stopped rather than retrying')
  })

  it('detects a bot wall from the wording such pages use', () => {
    const result = detectHumanBlock(
      observe({ title: 'Just a moment...', text: 'Checking your browser before accessing the site.' }),
    )

    expect(result?.kind).toBe('bot_wall')
    expect(result?.action).toContain('will not attempt to bypass it')
  })

  it('detects a two-factor prompt, and hedges it as possible rather than certain', () => {
    const result = detectHumanBlock(observe({ text: 'Enter the verification code from your authenticator app.' }))

    expect(result?.kind).toBe('two_factor')
    expect(result?.confidence).toBe('possible')
  })
})

describe('FR-BR-10: an expired session is a re-authentication request, not a failed read', () => {
  it('detects an explicitly expired session as likely', () => {
    const result = detectHumanBlock(observe({ text: 'Your session has expired. Please log in again.' }))

    expect(result?.kind).toBe('signed_out')
    expect(result?.confidence).toBe('likely')
  })

  it('treats a 401 as signed out on the server\'s own authority', () => {
    expect(detectHumanBlock(observe({ status: 401 }))?.kind).toBe('signed_out')
    expect(detectHumanBlock(observe({ status: 403 }))?.kind).toBe('signed_out')
  })

  it('hedges a bare login URL, because a task can legitimately ask to go to one', () => {
    // GT-1's own first step navigates to /login on purpose. Reporting that
    // as a certainty would make the golden task look broken.
    const result = detectHumanBlock(observe({ url: 'https://app.example.com/login', text: 'Sign in', status: 200 }))

    expect(result?.kind).toBe('signed_out')
    expect(result?.confidence).toBe('possible')
    expect(result?.action).toContain('If the task did not mean to go here')
  })
})

describe('priority: the most actionable block wins', () => {
  it('reports the captcha, not the login page, when a login page carries a captcha', () => {
    // Sending the operator to "sign in again" when the real obstacle is a
    // CAPTCHA sends them to do the wrong thing.
    const result = detectHumanBlock(
      observe({
        url: 'https://app.example.com/login',
        text: 'Your session has expired. Please log in again.',
        html: '<div class="g-recaptcha"></div>',
      }),
    )

    expect(result?.kind).toBe('captcha')
  })

  it('reports the rate limit, not the bot wall wording, when the server answered 429', () => {
    const result = detectHumanBlock(observe({ status: 429, text: 'Access denied' }))

    expect(result?.kind).toBe('rate_limited')
  })
})

describe('describeHumanBlock, FR-PRF-8: the request names the profile, not merely the site', () => {
  it('names the profile, the origin, the kind, the confidence, and the evidence', () => {
    const block = detectHumanBlock(observe({ status: 401 }))
    expect(block).toBeDefined()
    if (block === undefined) return

    const message = describeHumanBlock(block, 'acme-client', 'app.acme.com')

    expect(message).toContain('"acme-client" profile')
    expect(message).toContain('app.acme.com')
    expect(message).toContain('signed out')
    expect(message).toContain('likely')
    expect(message).toContain('HTTP 401')
  })
})
