/**
 * FR-CODE-44: "A commit or push containing a detected credential, key, or
 * token is blocked outright, not merely warned about, and raises a security
 * incident."
 *
 * BLOCKED OUTRIGHT is the whole requirement. A warning on a credential is
 * worse than nothing: it trains the person reading it to click past a class
 * of message that will one day be true, and it puts the decision on whoever
 * is least equipped to make it at the moment they are least likely to look.
 * So there is no approval path here, and deliberately no `--force`.
 *
 * WHAT THIS CAN AND CANNOT DO, stated plainly because a scanner that
 * oversells itself is dangerous. It matches known credential SHAPES: things
 * with distinctive prefixes and lengths that no ordinary source line
 * produces by accident. It will not catch a password that looks like a
 * word, a key format nobody here has seen, or a secret split across lines.
 * It is a gate against the common accident, not a proof of absence, and the
 * only honest thing to do with that limit is write it down rather than let
 * a green result be read as one.
 *
 * FALSE POSITIVES ARE THE REAL DESIGN PRESSURE. A scanner that blocks
 * ordinary work gets disabled, and a disabled scanner catches nothing. So
 * every pattern here is anchored to a vendor-specific prefix rather than to
 * generic entropy, and the well-known placeholder values that appear in
 * documentation and fixtures are recognised and allowed through.
 */

export type SecretFinding = {
  readonly kind: string
  readonly file: string
  readonly line: number
  /** The matched text, already truncated. Never the whole value: this is reported into Slack and a run record. */
  readonly evidence: string
}

/**
 * Credential shapes worth blocking on.
 *
 * Anchored to vendor prefixes on purpose. A generic "long random-looking
 * string" rule matches minified assets, lockfile hashes, base64 fixtures and
 * UUIDs, and a scanner that fires on those is one an operator turns off.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  { kind: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'Slack app-level token', pattern: /\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Stripe secret key', pattern: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/ },
  { kind: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
]

/**
 * Values that LOOK like credentials and are not.
 *
 * Documentation, fixtures and this repository's own tests are full of
 * these, and blocking on them would make the gate the thing standing
 * between an operator and ordinary work.
 */
export const KNOWN_PLACEHOLDERS: readonly RegExp[] = [
  /EXAMPLE/i,
  /\bxxx+\b/i,
  /\byour[-_]?(?:key|token|secret)\b/i,
  /\breplace[-_]?me\b/i,
  /\bplaceholder\b/i,
  /\bAKIAIOSFODNN7EXAMPLE\b/,
  /\bnot[-_]?a[-_]?real\b/i,
]

export function looksLikePlaceholder(value: string): boolean {
  return KNOWN_PLACEHOLDERS.some((pattern) => pattern.test(value))
}

/** Truncated so a finding reported into Slack or a run record never carries the whole value. */
export function summariseMatch(match: string): string {
  if (match.length <= 12) return `${match.slice(0, 4)}…`
  return `${match.slice(0, 8)}…${match.slice(-2)} (${match.length} chars)`
}

export type TextSecretMatch = { readonly kind: string; readonly evidence: string }

/**
 * Scans plain text, line by line, for credential shapes: a remote-write
 * body before it is stored. A placeholder only excuses the matched value
 * itself, never its line, because the whole body is worker-written and a
 * word like "example" next to a real token must not wave it through.
 */
export function scanText(text: string): readonly TextSecretMatch[] {
  return text.split('\n').flatMap((line) => scanLine(line, 'match'))
}

/** The one pattern loop, for bodies (placeholder judged on the match) and diffs (on the line, as documentation and fixtures need). */
function scanLine(line: string, placeholderScope: 'match' | 'line'): TextSecretMatch[] {
  const matches: TextSecretMatch[] = []
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const found = pattern.exec(line)
    if (found === null) continue
    if (looksLikePlaceholder(placeholderScope === 'match' ? found[0] : line)) continue
    matches.push({ kind, evidence: summariseMatch(found[0]) })
  }
  return matches
}

/**
 * Scans a unified diff for credential shapes.
 *
 * ADDED LINES ONLY. A credential already in the file is a pre-existing
 * problem for the operator to deal with deliberately, and blocking every
 * commit to a file that has one would make the repository unworkable
 * without fixing anything. This gate is about what THIS change introduces.
 */
export function scanDiffForSecrets(diff: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = []
  let file = '(unknown)'
  let lineNumber = 0

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim()
      continue
    }
    if (raw.startsWith('@@')) {
      const match = /\+(\d+)/.exec(raw)
      lineNumber = match === null ? 0 : Number.parseInt(match[1] as string, 10) - 1
      continue
    }
    // Only added lines. A '+++' header was already handled above.
    if (!raw.startsWith('+')) continue

    lineNumber += 1
    for (const match of scanLine(raw.slice(1), 'line')) findings.push({ ...match, file, line: lineNumber })
  }

  return findings
}

export type SecretGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly findings: readonly SecretFinding[] }

/**
 * The gate itself. There is no override parameter, and that is deliberate:
 * FR-CODE-44 says blocked outright, and an override would become the path
 * everyone takes on the day it matters.
 */
export function checkSecretGate(diff: string): SecretGateDecision {
  const findings = scanDiffForSecrets(diff)
  if (findings.length === 0) return { allowed: true }

  const detail = findings.map((finding) => `  ${finding.file}:${finding.line} — ${finding.kind} (${finding.evidence})`).join('\n')
  return {
    allowed: false,
    findings,
    reason:
      `This change adds ${findings.length} value${findings.length === 1 ? '' : 's'} matching a known credential ` +
      `shape, so it is blocked outright and cannot be approved past (FR-CODE-44):\n${detail}\n\n` +
      'If these are genuinely not credentials, they still cannot be pushed while they match: change them, or add ' +
      'them to the repository\'s off_limits paths so Relay never reads them.',
  }
}
