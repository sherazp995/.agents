/**
 * Getting a hostname out of something a task called a "destination".
 *
 * THE BUG THIS FIXES, stated plainly because it was silent. Every origin
 * check in this codebase, the policy engine's denylist, the hard-blocked
 * list, a profile's allowlist, runs on a bare hostname produced by
 * `normalizeDestination` (src/policy/engine.ts). That function is correct
 * for what it was built for, a hostname, but it is not a URL parser: its
 * "strip anything after a colon, that is a port" step turns
 * `https://admin.acme.com/invoices` into the hostname `https`. Nothing
 * caught it, because the browser capability could not navigate yet, so no
 * caller had ever passed a real URL through it. The failure is in the safe
 * direction, `https` matches no allowlist and the call is refused, but it
 * refuses with a reason naming a destination that does not exist, and it
 * makes every URL unusable.
 *
 * So a destination is resolved in two steps from here on: pull the host out
 * of a URL where the input IS one, then hand that host to
 * `normalizeDestination` for the canonicalization every origin check
 * already agrees on. This module owns only the first step; it deliberately
 * does not lowercase, punycode, or strip anything, because doing any of
 * that here would create a second, competing normalizer.
 */

/**
 * The hostname of `value` if it parses as an absolute URL, otherwise
 * `undefined`.
 *
 * `undefined` means "this was not a URL", which is a legitimate input: a
 * task can perfectly well name a bare host, and every existing caller does.
 * It does not mean "unsafe"; the caller decides what to do with a
 * non-URL, and `resolveDestinationHost` below implements the one decision
 * this codebase makes.
 */
export function hostOfUrl(value: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return undefined
  }
  // A URL with no host at all (`about:blank`, `data:...`, `javascript:...`)
  // is not a destination any origin list can be checked against. Returning
  // undefined rather than an empty string keeps the two cases, "not a URL"
  // and "a URL with no host", from being told apart by a caller that has no
  // reason to care: both mean there is no host here.
  return parsed.hostname.length > 0 ? parsed.hostname : undefined
}

/**
 * The bare host every origin check in this codebase expects, from either a
 * URL or a bare hostname.
 *
 * Does NOT call `normalizeDestination` itself, deliberately: that would put
 * a policy-layer import into the browser layer and give this module an
 * opinion on canonicalization it should not have. Callers pipe the result
 * through `normalizeDestination` exactly as they already do today, so there
 * remains exactly one canonicalizer in the system.
 */
export function destinationHost(value: string): string {
  return hostOfUrl(value) ?? value.trim()
}

/**
 * Whether `value` is an absolute URL Relay is willing to navigate to.
 *
 * Only `http:` and `https:` qualify. Everything else, `file:` (the local
 * disk), `javascript:` (script execution dressed as navigation),
 * `chrome:` and `devtools:` (the browser's own privileged surfaces), is
 * refused rather than passed to a driver, because none of them is a
 * destination an origin allowlist can meaningfully bound: they have no host
 * to check, so an allowlist would neither permit nor deny them and they
 * would sail through every origin gate in the system.
 */
export function isNavigableUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
}
