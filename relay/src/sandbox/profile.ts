/**
 * FR-SH-6: generating the `sandbox-exec` profile that confines a coding run.
 *
 * The profile is generated per run from the registry and policy rather than
 * hand-maintained, because a hand-maintained profile drifts from the grants
 * it is supposed to express and nobody notices until it is too permissive.
 *
 * THE SHAPE OF THE PROFILE, and why it is "allow default, then deny" rather
 * than "deny default, then allow". A deny-by-default SBPL profile has to
 * enumerate every mach lookup, dyld path and sysctl that a real toolchain
 * touches, and the enumeration is both enormous and version-dependent. The
 * predictable outcome is a profile that breaks legitimate builds, which R-11
 * names as a real risk, and whose failures push an operator toward disabling
 * confinement entirely. So this denies the two things FR-SH-6's acceptance
 * criterion actually names, comprehensively:
 *
 *   - all filesystem WRITES, re-allowed only inside the worktree and
 *     explicitly granted paths
 *   - all NETWORK egress, re-allowed only to the local enforcing proxy
 *
 * That is weaker than a deny-all profile against an attacker with local
 * code execution who is trying to read something. It is exactly as strong
 * for the two properties the requirement is written about: a run cannot
 * write outside its worktree, and cannot reach a host the proxy has not
 * approved. Stated here rather than implied, so nobody later mistakes this
 * for a complete jail.
 *
 * TWO IMPLEMENTATION DETAILS THAT COST REAL TIME:
 *
 *   - SBPL `subpath` matches the RESOLVED path. On macOS `/tmp` is a symlink
 *     to `/private/tmp`, so a profile granting `/tmp/work` denies every write
 *     to the directory the caller thinks it just granted. Every path here is
 *     resolved before it is written into the profile.
 *   - RULE ORDER IS SIGNIFICANT: a later rule overrides an earlier one. The
 *     denials for the operator's primary checkout are therefore emitted
 *     AFTER the worktree grants, so an overlapping or careless grant cannot
 *     re-open a path the requirement says must stay closed.
 */

import { realpathSync } from 'node:fs'

export type SandboxProfileSpec = {
  /** The run's worktree. The one place a coding run may freely write. */
  readonly worktree: string
  /** Additional paths the run may write to, from the repo registry and policy. */
  readonly writablePaths?: readonly string[]
  /**
   * Paths that must stay read-only even if a grant above would cover them:
   * the operator's primary checkout, and the targets of FR-CFG-4's linked
   * config paths. Emitted last so they win.
   */
  readonly readOnlyPaths?: readonly string[]
  /**
   * The loopback port of the FR-SH-6 enforcing proxy. All egress goes
   * through it. When absent, the profile denies networking outright, which
   * is FR-SH-8's stricter no-network shape.
   */
  readonly proxyPort?: number
  /**
   * Per-run scratch space the toolchain may write to. `runSandboxed` creates
   * one and points the child's TMPDIR at it. Deliberately NOT defaulted to
   * `os.tmpdir()`: granting the whole per-user temporary directory would
   * make every concurrent run writable by every other one.
   */
  readonly temporaryDirectory?: string
}

/**
 * SBPL string literals are double-quoted with backslash escapes. A path
 * carrying a quote would otherwise close the literal early and let the rest
 * of the path become profile SOURCE, which is an injection straight into
 * the thing doing the confining. Directory names are attacker-influenced
 * often enough (a branch name, a repository name) that this is a real edge
 * rather than a theoretical one.
 */
export function escapeSandboxString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Resolves a path for use in a `subpath` rule.
 *
 * A path that does not exist yet cannot be resolved, and `realpathSync`
 * throws. That is reported rather than silently passed through unresolved:
 * an unresolved path in a WRITE grant produces a profile that denies the
 * writes it meant to allow, and the run fails in a way that looks like a
 * sandbox bug rather than a missing directory.
 */
export function resolveForProfile(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    throw new SandboxProfileError(
      `the path "${path}" could not be resolved, so it cannot be written into a sandbox profile. ` +
        'SBPL matches resolved paths, so an unresolved one would silently not match. Create the directory first.',
    )
  }
}

export class SandboxProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxProfileError'
  }
}

/** Builds the SBPL text. Pure apart from resolving paths, so it is testable without running anything. */
export function buildSandboxProfile(spec: SandboxProfileSpec): string {
  const worktree = resolveForProfile(spec.worktree)
  const writable = (spec.writablePaths ?? []).map(resolveForProfile)
  const readOnly = (spec.readOnlyPaths ?? []).map(resolveForProfile)

  const lines: string[] = [
    '(version 1)',
    '',
    ';; Generated per run by Relay (FR-SH-6). Do not edit: it is rebuilt every run.',
    ';; See src/sandbox/profile.ts for why this is allow-default-then-deny.',
    '',
    '(allow default)',
    '',
    ';; --- Filesystem -------------------------------------------------',
    ';; Every write is denied, then re-allowed only where a grant exists.',
    '(deny file-write*)',
    '',
    `(allow file-write* (subpath "${escapeSandboxString(worktree)}"))`,
  ]

  for (const path of writable) {
    lines.push(`(allow file-write* (subpath "${escapeSandboxString(path)}"))`)
  }

  // A toolchain that cannot write a temporary file cannot compile, so a
  // scratch directory is granted. It is a PER-RUN directory, not the whole
  // of TMPDIR.
  //
  // Granting all of TMPDIR was the first version, and it was too broad in a
  // way a test caught only by accident: every run's scratch, and anything
  // else on the machine using the per-user temporary directory, would be
  // mutually writable. FR-SH-6 says worktree plus EXPLICITLY GRANTED paths,
  // and "the whole temporary directory" is not that.
  if (spec.temporaryDirectory !== undefined) {
    lines.push(
      '',
      ';; Per-run scratch. Not the whole of TMPDIR: that would make every',
      ';; concurrent run writable by every other one.',
      `(allow file-write* (subpath "${escapeSandboxString(resolveForProfile(spec.temporaryDirectory))}"))`,
    )
  }

  // WRITING TO /dev/null IS A FILE WRITE, and the blanket deny above catches
  // it. Found by running the real thing: every probe in the self-test failed
  // with "/dev/null: Operation not permitted", because `2>/dev/null` appears
  // in practically every command a toolchain runs. Without this the sandbox
  // does not merely confine a run, it stops it working at all.
  //
  // Enumerated rather than granted as (subpath "/dev"), because /dev holds
  // the raw disk devices: a write to /dev/disk0 reaches every byte on the
  // machine, worktree confinement included. The character devices below
  // cannot persist anything outside the worktree.
  lines.push(
    '',
    ';; Standard character devices. NOT all of /dev: that would include the',
    ';; raw disks, which is an escape from everything above.',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))',
    '(allow file-write-data (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write* (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
    '(allow file-write* (subpath "/dev/fd"))',
    ';; Pseudo-terminals, for tools that allocate one to detect interactivity.',
    '(allow file-write* (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    '(allow file-write* (literal "/dev/dtracehelper"))',
  )

  if (readOnly.length > 0) {
    lines.push(
      '',
      ';; Emitted LAST so they override any grant above: the operator\'s own',
      ';; checkout and FR-CFG-4\'s linked config targets stay read-only even',
      ';; if a grant would otherwise cover them.',
    )
    for (const path of readOnly) {
      lines.push(`(deny file-write* (subpath "${escapeSandboxString(path)}"))`)
    }
  }

  lines.push(
    '',
    ';; --- Network ----------------------------------------------------',
    ';; sandbox-exec cannot filter by host, so direct egress is denied',
    ';; outright and the only reachable endpoint is Relay\'s own proxy,',
    ';; which enforces the destination list (FR-SH-6, FR-DATA-2).',
    '(deny network*)',
  )

  if (spec.proxyPort !== undefined) {
    if (!Number.isInteger(spec.proxyPort) || spec.proxyPort < 1 || spec.proxyPort > 65535) {
      throw new SandboxProfileError(`"${spec.proxyPort}" is not a usable TCP port for the egress proxy.`)
    }
    lines.push(
      // "localhost", NOT "127.0.0.1". Verified against the real sandbox on
      // macOS: the literal-IP spelling is REFUSED by the kernel filter, so a
      // profile written that way blocks the proxy along with everything
      // else. That fails closed, which is why it would have been easy to
      // miss: the run simply has no network and the proxy never sees it.
      `(allow network* (remote ip "localhost:${spec.proxyPort}"))`,
      ';; Loopback only. A run that opens a direct socket to anywhere else',
      ';; fails at the kernel, not at the proxy, which is what makes',
      ';; bypassing the proxy impossible rather than merely discouraged.',
    )
  } else {
    lines.push(';; No proxy port supplied, so this run has NO network at all (FR-SH-8).')
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * The effective rules, for the run record. FR-SH-6 requires these be
 * recorded, so an operator reading a denial afterwards can see what the run
 * was actually allowed to do rather than inferring it.
 */
export type EffectiveSandboxRules = {
  readonly worktree: string
  readonly writablePaths: readonly string[]
  readonly readOnlyPaths: readonly string[]
  readonly networkPolicy: string
}

export function describeSandboxRules(spec: SandboxProfileSpec): EffectiveSandboxRules {
  return {
    worktree: resolveForProfile(spec.worktree),
    writablePaths: (spec.writablePaths ?? []).map(resolveForProfile),
    readOnlyPaths: (spec.readOnlyPaths ?? []).map(resolveForProfile),
    networkPolicy:
      spec.proxyPort === undefined
        ? 'all network egress denied at the kernel (no proxy configured)'
        : `all direct egress denied at the kernel; only loopback port ${spec.proxyPort}, Relay's enforcing proxy, is reachable`,
  }
}
