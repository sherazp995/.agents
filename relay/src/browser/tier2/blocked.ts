/**
 * FR-BR-8 and FR-BR-10: noticing that a page needs a HUMAN, and saying so.
 *
 * Two requirements, one mechanism, because they fail the same way if they
 * are missing:
 *
 *   FR-BR-8: "CAPTCHAs, bot walls, 2FA challenges, and rate-limit pages are
 *   detected and reported as 'human action needed' with a screenshot and a
 *   resume handle, NEVER WORKED AROUND."
 *
 *   FR-BR-10: "expired or logged-out sessions are detected and reported as
 *   a re-authentication request rather than being silently retried." Its
 *   acceptance criterion is blunt: "An expired session produces 'please
 *   re-login to X' rather than five failed attempts."
 *
 * Without this, both conditions present to the rest of the system as an
 * ordinary read of an ordinary page. A run hits a bot wall, reads "Checking
 * your browser", hands that text to a model, and the model writes a
 * confident summary of a page it never saw. That is the single most
 * damaging failure this driver can have, because it is indistinguishable
 * from success at every layer above it.
 *
 * THIS IS A HEURISTIC AND IS DESCRIBED AS ONE, EVERYWHERE. It matches known
 * vendor markers and well-known wording. It will miss a bot wall nobody
 * here has seen, and it can fire on a page that merely talks about
 * CAPTCHAs. So:
 *
 *   - Every detection carries the EVIDENCE that produced it, so an operator
 *     reading the report can see why Relay thinks so and disagree.
 *   - Nothing here changes what the driver does. It does not retry, back
 *     off, solve, or work around anything. It reports. Acting on a
 *     heuristic would make a wrong guess expensive; reporting one only
 *     makes it visible.
 *   - `confidence` is stated, and 'possible' is not dressed up as 'likely'.
 *
 * A NOTE ON WHAT WOULD MAKE THIS WORSE. The obvious "improvement" is to
 * have the driver retry on a rate-limit page, or wait out a bot wall.
 * FR-BR-8 forbids exactly that, and the reason is not politeness: a run
 * that quietly retries past a wall is a run whose operator does not know
 * their client's account is being rate limited or challenged.
 */

/** What kind of human involvement the page appears to need. */
export const HUMAN_BLOCK_KINDS = ['captcha', 'bot_wall', 'two_factor', 'rate_limited', 'signed_out'] as const
export type HumanBlockKind = (typeof HUMAN_BLOCK_KINDS)[number]

/**
 * How sure the detection is. Two values, not five: a finer scale would
 * imply a precision these string matches do not have.
 *
 * `likely` means a marker that is close to unambiguous, a vendor's own
 * CAPTCHA widget or an HTTP 429. `possible` means wording that usually
 * indicates the condition but legitimately appears on ordinary pages too.
 */
export const HUMAN_BLOCK_CONFIDENCE = ['likely', 'possible'] as const
export type HumanBlockConfidence = (typeof HUMAN_BLOCK_CONFIDENCE)[number]

export type HumanBlock = {
  readonly kind: HumanBlockKind
  readonly confidence: HumanBlockConfidence
  /** What was actually observed. Quoted or named, never paraphrased, so an operator can judge the call themselves. */
  readonly evidence: string
  /** What the operator is being asked to do, in their own terms. */
  readonly action: string
}

/** Everything the detector looks at. All of it is already gathered by the driver for other reasons; nothing here causes an extra page interaction. */
export type PageObservation = {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly html: string
  readonly status: number | undefined
}

/** A vendor CAPTCHA widget's own markup or script host. Presence of one of these is about as close to unambiguous as this file gets. */
const CAPTCHA_MARKERS: ReadonlyArray<{ readonly marker: string; readonly vendor: string }> = [
  { marker: 'www.google.com/recaptcha', vendor: 'Google reCAPTCHA' },
  { marker: 'recaptcha/api.js', vendor: 'Google reCAPTCHA' },
  { marker: 'g-recaptcha', vendor: 'Google reCAPTCHA' },
  { marker: 'hcaptcha.com/1/api.js', vendor: 'hCaptcha' },
  { marker: 'h-captcha', vendor: 'hCaptcha' },
  { marker: 'challenges.cloudflare.com/turnstile', vendor: 'Cloudflare Turnstile' },
  { marker: 'cf-turnstile', vendor: 'Cloudflare Turnstile' },
  { marker: 'data-sitekey', vendor: 'a CAPTCHA widget (data-sitekey attribute)' },
]

/** Wording bot walls use while they decide whether to let a visitor through. Lowercased for comparison. */
const BOT_WALL_PHRASES: readonly string[] = [
  'checking your browser before accessing',
  'verify you are human',
  'verifying you are human',
  'please verify you are a human',
  'enable javascript and cookies to continue',
  'why have i been blocked',
  'attention required! | cloudflare',
  'access denied',
  'unusual traffic from your computer network',
  'our systems have detected unusual traffic',
]

const TWO_FACTOR_PHRASES: readonly string[] = [
  'two-factor authentication',
  'two factor authentication',
  'verification code',
  'authentication code',
  'enter the code we sent',
  'enter the 6-digit code',
  'one-time passcode',
  'one time password',
  'approve the sign-in request',
  'check your authenticator app',
]

const RATE_LIMIT_PHRASES: readonly string[] = [
  'too many requests',
  'rate limit exceeded',
  'you have been rate limited',
  'slow down',
]

/**
 * Wording and URL shapes that mean "you are not signed in".
 *
 * Split into two lists on purpose. A URL that IS a login path is decent
 * evidence; body text that merely mentions signing in is weaker, because
 * plenty of signed-in pages carry a "sign out" link, a "sign in with a
 * different account" option, or marketing copy.
 */
const SIGNED_OUT_URL_MARKERS: readonly string[] = ['/login', '/signin', '/sign-in', '/auth/login', '/sessions/new', '/account/login']
const SIGNED_OUT_PHRASES: readonly string[] = [
  'your session has expired',
  'session expired',
  'please log in again',
  'please sign in again',
  'you have been signed out',
  'you have been logged out',
  'sign in required',
  'authentication required',
  'you must be logged in',
]

function includesAny(haystack: string, needles: readonly string[]): string | undefined {
  for (const needle of needles) {
    if (haystack.includes(needle)) return needle
  }
  return undefined
}

/**
 * Whether the page appears to need a human, and why.
 *
 * Returns at most one block, the most consequential match, rather than a
 * list. A page behind a bot wall frequently also matches the signed-out
 * wording, and reporting both would bury the one the operator can act on.
 * The order below IS the priority order, and it runs most-specific first.
 *
 * Pure: every fact it needs is a parameter, so the whole decision table is
 * exhaustively testable without a browser, matching
 * src/browser/enforcement.ts's own shape.
 */
export function detectHumanBlock(observation: PageObservation): HumanBlock | undefined {
  const text = observation.text.toLowerCase()
  const html = observation.html.toLowerCase()
  const title = observation.title.toLowerCase()
  const url = observation.url.toLowerCase()
  const haystack = `${title}\n${text}`

  // 1. A vendor CAPTCHA widget. Checked against the HTML, because the
  //    widget is markup and a script tag, not usually visible text.
  for (const { marker, vendor } of CAPTCHA_MARKERS) {
    if (html.includes(marker)) {
      return {
        kind: 'captcha',
        confidence: 'likely',
        evidence: `the page contains ${vendor} markup ("${marker}")`,
        action:
          'A CAPTCHA is on this page. Relay does not solve CAPTCHAs and does not work around them. Complete it ' +
          'yourself in the profile\'s browser, then ask Relay to continue.',
      }
    }
  }

  // 2. HTTP 429 is not a heuristic at all: the server said so.
  if (observation.status === 429) {
    return {
      kind: 'rate_limited',
      confidence: 'likely',
      evidence: 'the server answered HTTP 429 Too Many Requests',
      action:
        'The site is rate limiting this account. Relay has stopped rather than retrying, because retrying past a ' +
        'rate limit is how an account gets blocked. Wait, or reduce how often this task runs.',
    }
  }

  // 3. A bot wall, which usually announces itself in the title or body.
  const botPhrase = includesAny(haystack, BOT_WALL_PHRASES)
  if (botPhrase !== undefined) {
    return {
      kind: 'bot_wall',
      confidence: 'likely',
      evidence: `the page says "${botPhrase}"`,
      action:
        'The site is showing a bot-protection page rather than the content. Open it yourself in the profile\'s ' +
        'browser to clear the challenge, then ask Relay to continue. Relay will not attempt to bypass it.',
    }
  }

  // 4. A 2FA challenge. Weaker wording than the above, so 'possible'.
  const twoFactorPhrase = includesAny(haystack, TWO_FACTOR_PHRASES)
  if (twoFactorPhrase !== undefined) {
    return {
      kind: 'two_factor',
      confidence: 'possible',
      evidence: `the page says "${twoFactorPhrase}"`,
      action:
        'This looks like a two-factor prompt. Relay has no access to your second factor and will not guess. ' +
        'Complete it in the profile\'s browser, then ask Relay to continue.',
    }
  }

  const ratePhrase = includesAny(haystack, RATE_LIMIT_PHRASES)
  if (ratePhrase !== undefined) {
    return {
      kind: 'rate_limited',
      confidence: 'possible',
      evidence: `the page says "${ratePhrase}"`,
      action:
        'This looks like a rate-limit page. Relay has stopped rather than retrying. Wait, or reduce how often this ' +
        'task runs.',
    }
  }

  // 5. Signed out. FR-BR-10's own case, and the reason it is last: a login
  //    page is what a site shows for many of the conditions above too, so
  //    reporting "please re-login" for a CAPTCHA would send the operator to
  //    do the wrong thing.
  const signedOutPhrase = includesAny(haystack, SIGNED_OUT_PHRASES)
  if (signedOutPhrase !== undefined) {
    return {
      kind: 'signed_out',
      confidence: 'likely',
      evidence: `the page says "${signedOutPhrase}"`,
      action: 'The session is not signed in. Sign in to the site in this profile\'s browser, then ask Relay to continue.',
    }
  }
  if (observation.status === 401 || observation.status === 403) {
    return {
      kind: 'signed_out',
      confidence: 'likely',
      evidence: `the server answered HTTP ${observation.status}`,
      action: 'The site refused the request as unauthenticated or unauthorised. Sign in to it in this profile\'s browser, then ask Relay to continue.',
    }
  }
  const loginUrlMarker = includesAny(url, SIGNED_OUT_URL_MARKERS)
  if (loginUrlMarker !== undefined) {
    return {
      kind: 'signed_out',
      confidence: 'possible',
      // Deliberately hedged: a task can legitimately ASK Relay to go to a
      // login page, which is exactly what GT-1's own login steps do, so
      // this must never be stated as a certainty.
      evidence: `the page ended up at a URL containing "${loginUrlMarker}"`,
      action:
        'This may be a sign-in page rather than the page that was asked for. If the task did not mean to go here, ' +
        'the session has probably expired: sign in to the site in this profile\'s browser, then ask Relay to continue.',
    }
  }

  return undefined
}

/**
 * FR-PRF-8 and FR-BR-10's acceptance criterion, which is about wording:
 * "The request says which PROFILE needs re-login, not merely which site."
 *
 * Kept as its own function rather than folded into the `action` strings
 * above, because `detectHumanBlock` is pure and knows nothing about
 * profiles, and because this sentence is the one an operator actually
 * reads.
 */
export function describeHumanBlock(block: HumanBlock, profile: string, origin: string): string {
  return (
    `Human action needed on ${origin}, in the "${profile}" profile: ${block.kind.replace(/_/g, ' ')} ` +
    `(${block.confidence}, ${block.evidence}). ${block.action}`
  )
}
