/**
 * FR-SEC-6: masking credential fields before a screenshot is captured.
 *
 * The requirement puts this in phase 1 for a specific reason it states
 * itself: FR-RPT-4 persists screenshots from phase 1 and NFR-8 forbids a
 * credential value in any persisted artifact, so without masking those two
 * cannot both hold. It also states what to do where masking cannot cover a
 * surface: "screenshots of credential-bearing views are not persisted at
 * all."
 *
 * MASKED IN THE DOM, NOT IN THE PIXELS. The obvious approach, capturing the
 * image and painting rectangles over it, needs an image library, needs the
 * element boxes to still be accurate at capture time, and fails open: a
 * mistake leaves a readable password in a stored PNG. Covering the fields
 * in the page BEFORE the capture inverts that. The bytes never contain the
 * value, there is no window between measuring and painting, and a failure to
 * apply the style is visible as an unmasked FIELD rather than as a leaked
 * VALUE, because the detection step also refuses.
 *
 * THE UNMASKABLE CASE IS REAL AND IS NOT PAPERED OVER. A password field
 * inside a CROSS-ORIGIN IFRAME cannot be reached from the top document at
 * all: the whole point of the origin boundary is that scripts on one side
 * cannot see the other. Hosted payment forms and embedded SSO widgets are
 * exactly this shape. Such a view is reported as unmaskable, and the caller
 * refuses to persist rather than storing an image it cannot vouch for.
 *
 * The injected script is written as a string because that is what CDP's
 * `Runtime.evaluate` takes. It is a fixed literal with no interpolation of
 * anything from the page, so there is nothing here for a hostile page to
 * inject into.
 */

/**
 * What counts as a credential field.
 *
 * Password inputs are the obvious case. The `autocomplete` tokens are the
 * standardised way a page declares a field holds a card number, a security
 * code, or a one-time code, so they are a far better signal than guessing at
 * `name` attributes, which are arbitrary.
 */
export const CREDENTIAL_SELECTORS: readonly string[] = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-csc"]',
  'input[autocomplete="cc-exp"]',
  'input[autocomplete="one-time-code"]',
  // Widely used by card-entry widgets that do not set an autocomplete token.
  'input[name*="cardnumber" i]',
  'input[name*="cvc" i]',
  'input[name*="cvv" i]',
]

export type RedactionReport = {
  /** How many credential fields were covered. */
  readonly masked: number
  /**
   * Frames whose contents could not be inspected, and therefore could not be
   * masked. Non-empty means the screenshot must NOT be persisted.
   */
  readonly unmaskableFrames: number
}

export type ScreenshotRedaction =
  | { readonly outcome: 'clean'; readonly report: RedactionReport }
  /** FR-SEC-6's second half: this view cannot be vouched for, so it is not persisted. */
  | { readonly outcome: 'unmaskable'; readonly reason: string; readonly report: RedactionReport }

/** The marker attribute, so the overlay can be removed again without touching anything else. */
export const REDACTION_ATTRIBUTE = 'data-relay-redacted'

/**
 * The script that covers credential fields.
 *
 * Sets `visibility: hidden` on the field and paints an opaque block in its
 * place via an inserted sibling, rather than only blanking the value. A
 * password input renders dots rather than the value, but a `cc-number` field
 * renders the digits in the clear, and "it was only dots anyway" is not a
 * property to rely on across every field this matches.
 *
 * Also counts iframes it cannot see into, which is what makes the
 * unmaskable case detectable rather than silently missed.
 */
export function buildRedactionScript(selectors: readonly string[] = CREDENTIAL_SELECTORS): string {
  const selectorList = JSON.stringify(selectors.join(','))
  const attribute = JSON.stringify(REDACTION_ATTRIBUTE)
  return `(() => {
  const selector = ${selectorList};
  const attribute = ${attribute};
  let masked = 0;
  for (const field of document.querySelectorAll(selector)) {
    const box = field.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const cover = document.createElement('div');
    cover.setAttribute(attribute, 'cover');
    cover.style.cssText = [
      'position:fixed',
      'left:' + box.left + 'px',
      'top:' + box.top + 'px',
      'width:' + box.width + 'px',
      'height:' + box.height + 'px',
      'background:#000',
      'z-index:2147483647',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(cover);
    masked += 1;
  }
  // An iframe this document cannot reach into may hold a credential field
  // that cannot be covered from here. Hosted payment forms and embedded SSO
  // widgets are exactly this shape.
  let unreachable = 0;
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      if (frame.contentDocument === null) unreachable += 1;
    } catch {
      unreachable += 1;
    }
  }
  return { masked: masked, unmaskableFrames: unreachable };
})()`
}

/** Removes the covers again, so the page is left as it was found. */
export function buildRedactionCleanupScript(): string {
  return `(() => {
  for (const cover of document.querySelectorAll('[${REDACTION_ATTRIBUTE}]')) cover.remove();
  return true;
})()`
}

/**
 * Turns the counts into a decision.
 *
 * An unreachable frame is only fatal when it might hold something worth
 * masking, and there is no way to know from outside it, so the safe reading
 * is that it might. That is deliberately conservative: the cost of a false
 * refusal is a missing screenshot, and the cost of a false pass is a
 * credential in a stored artifact.
 */
export function decideRedaction(report: RedactionReport): ScreenshotRedaction {
  if (report.unmaskableFrames > 0) {
    return {
      outcome: 'unmaskable',
      report,
      reason:
        `this page contains ${report.unmaskableFrames} cross-origin frame${report.unmaskableFrames === 1 ? '' : 's'} ` +
        'whose contents cannot be inspected from the page, so Relay cannot confirm no credential field is visible. ' +
        'The screenshot was NOT persisted (FR-SEC-6). Hosted payment forms and embedded sign-in widgets are the ' +
        'usual cause.',
    }
  }
  return { outcome: 'clean', report }
}
