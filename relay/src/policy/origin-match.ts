/**
 * Wildcard domain matching, shared by every origin list the policy engine
 * consults: `hard_blocked_origins` (FR-POL-4), `origins.allow` /
 * `origins.deny` (FR-POL-4), and the `origin_not_allowlisted` escalation
 * condition (FR-POL-1). One implementation rather than one per caller, since
 * `src/policy/classify.ts` and `src/policy/decide.ts` both need identical
 * matching semantics and a divergence between them would let the same
 * destination classify as blocked in one function and not the other.
 *
 * `destination` is expected to already be a bare hostname ("chase.com"),
 * not a full URL. Extracting the hostname from a URL, a recipient address,
 * or whatever shape a given capability's target takes is the caller's job
 * (the mediation seam, Task 3): these pure functions do not parse URLs.
 */

/**
 * Whether `destination` matches a single origin `pattern`. A pattern
 * starting with `"*."` matches any subdomain of the given domain AND the
 * bare domain itself (so `"*.chase.com"` blocks `pay.chase.com` as well as
 * `chase.com`), matching how the requirements' §18.4 policy example uses
 * `"*.chase.com"` to mean "chase, anywhere". A pattern without a leading
 * `"*."` matches only that exact domain. Comparison is case-insensitive,
 * since domain names are.
 */
export function originMatches(destination: string, pattern: string): boolean {
  const host = destination.toLowerCase()
  const normalizedPattern = pattern.toLowerCase()
  if (normalizedPattern.startsWith('*.')) {
    const parentDomain = normalizedPattern.slice(2)
    return host === parentDomain || host.endsWith(`.${parentDomain}`)
  }
  return host === normalizedPattern
}

/** Whether `destination` matches any pattern in `patterns`. */
export function matchesAnyOrigin(destination: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => originMatches(destination, pattern))
}
