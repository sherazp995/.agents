import { describe, expect, it } from 'vitest'

import { checkGitOperation, checkPushTarget, isProtectedBranch } from '../../src/repos/git-safety.js'
import { checkSecretGate, looksLikePlaceholder, scanDiffForSecrets, summariseMatch } from '../../src/repos/secrets-gate.js'

/**
 * These are the gates with NO approval path, which makes them different from
 * everything else dangerous in this system. FR-CODE-42's acceptance
 * criterion says it outright: "no approval button exists for a
 * default-branch push", because a button that exists is a button that gets
 * pressed at the end of a long thread when the run has been going well.
 */

function diff(...lines: string[]): string {
  return ['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts', '@@ -1,0 +1,9 @@', ...lines].join('\n')
}

describe('FR-CODE-44: a credential blocks outright', () => {
  it('blocks an AWS key added by this change', () => {
    const decision = checkSecretGate(diff('+const key = "AKIA1234567890ABCDEF"'))

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toContain('cannot be approved past')
    expect(decision.findings[0]?.kind).toContain('AWS')
  })

  it('blocks a private key block, a Slack token and a JWT', () => {
    expect(checkSecretGate(diff('+-----BEGIN RSA PRIVATE KEY-----')).allowed).toBe(false)
    expect(checkSecretGate(diff('+token: xoxb-123456789012-abcdefghijkl')).allowed).toBe(false)
    expect(
      checkSecretGate(diff('+const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"')).allowed,
    ).toBe(false)
  })

  it('reports WHERE, so the operator can go and look', () => {
    const findings = scanDiffForSecrets(diff('+ok', '+const k = "AKIA1234567890ABCDEF"'))

    expect(findings[0]?.file).toBe('f.ts')
    expect(findings[0]?.line).toBe(2)
  })

  it('NEVER reports the whole value, since this is posted into Slack and a run record', () => {
    const summary = summariseMatch('AKIA1234567890ABCDEF')

    expect(summary).not.toContain('1234567890ABCDEF')
    expect(summary).toContain('…')
  })

  it('scans only ADDED lines, so a pre-existing value does not block every future commit', () => {
    // Blocking every commit to a file that already has one would make the
    // repository unworkable without fixing anything.
    expect(scanDiffForSecrets(diff('-const old = "AKIA1234567890ABCDEF"', '+const fresh = 1'))).toEqual([])
  })

  it('does NOT fire on documentation placeholders, or the gate gets turned off', () => {
    // A scanner that blocks ordinary work gets disabled, and a disabled
    // scanner catches nothing.
    expect(checkSecretGate(diff('+AWS_KEY=AKIAIOSFODNN7EXAMPLE')).allowed).toBe(true)
    expect(checkSecretGate(diff('+token: "your-token-here"')).allowed).toBe(true)
    expect(looksLikePlaceholder('sk-ant-REPLACE_ME')).toBe(true)
  })

  it('does not fire on ordinary code, lockfile hashes or UUIDs', () => {
    expect(checkSecretGate(diff('+const id = "550e8400-e29b-41d4-a716-446655440000"')).allowed).toBe(true)
    expect(checkSecretGate(diff('+  resolved "https://registry.npmjs.org/x/-/x-1.0.0.tgz#a1b2c3d4e5f60718293a4b5c6d7e8f90"')).allowed).toBe(true)
    expect(checkSecretGate(diff('+export function addTwoNumbers(a: number, b: number) { return a + b }')).allowed).toBe(true)
  })
})

describe('FR-CODE-42: writes to a protected branch have no approval path', () => {
  it('blocks a push to the default branch', () => {
    const decision = checkPushTarget(['origin', 'main'], 'main')

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toContain('no approval that authorises it')
    // No enableWith: this one is never enableable.
    expect(decision.enableWith).toBeUndefined()
  })

  it('reads the DESTINATION of a refspec, not the source', () => {
    // `git push origin relay/x:main` writes to main while naming a Relay
    // branch, which is exactly what a check on the source side waves through.
    expect(checkPushTarget(['origin', 'relay/run-1-thing:main'], 'main').allowed).toBe(false)
  })

  it('allows a push to a relay branch, or the whole feature is pointless', () => {
    expect(checkPushTarget(['origin', 'relay/run-1-thing'], 'main').allowed).toBe(true)
  })

  it('protects the usual names even when the registry names a different default', () => {
    expect(isProtectedBranch('master', 'develop')).toBe(true)
    expect(isProtectedBranch('production', 'develop')).toBe(true)
    expect(isProtectedBranch('develop', 'develop')).toBe(true)
    expect(isProtectedBranch('relay/x', 'develop')).toBe(false)
  })
})

describe('FR-CODE-43: destructive operations name the config key instead of offering a choice', () => {
  it('blocks force-push in all its spellings', () => {
    for (const flag of ['--force', '-f', '--force-with-lease']) {
      const decision = checkGitOperation('push', ['origin', 'relay/x', flag], 'main')
      expect(decision.allowed).toBe(false)
      if (decision.allowed) continue
      expect(decision.enableWith).toBe('git_safety.allow_force_push')
    }
  })

  it('blocks a remote branch deletion, including the colon spelling', () => {
    expect(checkGitOperation('push', ['origin', '--delete', 'relay/x'], 'main').allowed).toBe(false)
    expect(checkGitOperation('push', ['origin', ':relay/x'], 'main').allowed).toBe(false)
  })

  it('blocks history rewriting and hard reset and clean', () => {
    expect(checkGitOperation('rebase', ['-i', 'HEAD~3'], 'main').allowed).toBe(false)
    expect(checkGitOperation('reset', ['--hard', 'HEAD~1'], 'main').allowed).toBe(false)
    expect(checkGitOperation('clean', ['-fdx'], 'main').allowed).toBe(false)
  })

  it('NEVER allows merge, and offers no config key for it', () => {
    // FR-CODE-48: the operator merges, having read the diff.
    const decision = checkGitOperation('merge', ['relay/x'], 'main')

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.enableWith).toBeUndefined()
    expect(decision.reason).toContain('You merge')
  })

  it('allows the ordinary operations a run actually needs', () => {
    expect(checkGitOperation('commit', ['-m', 'a change'], 'main').allowed).toBe(true)
    expect(checkGitOperation('add', ['-A'], 'main').allowed).toBe(true)
    expect(checkGitOperation('status', ['--porcelain'], 'main').allowed).toBe(true)
    expect(checkGitOperation('push', ['origin', 'relay/run-1'], 'main').allowed).toBe(true)
  })
})
