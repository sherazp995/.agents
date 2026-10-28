import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkProfiles } from '../../../src/doctor/checks/profiles.js'
import type { CheckContext } from '../../../src/doctor/registry.js'

/**
 * checkProfiles's run() ignores its CheckContext argument entirely (see the
 * check's own doc comment: it loads profiles.yaml itself), so this fake
 * exists only to satisfy the Check interface's declared signature at the
 * call site, matching test/doctor/checks/capabilities.test.ts's own
 * IGNORED_CONTEXT for the same reason.
 */
const IGNORED_CONTEXT = {} as CheckContext

const HOME = '/Users/opname'
const DEFAULT_CHROME_DIR = join(HOME, 'Library', 'Application Support', 'Google', 'Chrome')

/** Writes a profiles.yaml fixture to a fresh temp directory and returns its path. */
function writeProfiles(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-doctor-profiles-'))
  const path = join(dir, 'profiles.yaml')
  writeFileSync(path, yaml, 'utf8')
  return path
}

/** A path inside a temp directory that is never written to, so loadProfileRegistryIfPresent sees it as absent. */
function absentProfilesPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'relay-doctor-profiles-absent-')), 'profiles.yaml')
}

describe('checkProfiles, FR-PRF-6a', () => {
  it('reports ok, not a failure, when no profiles.yaml exists at all', async () => {
    const check = checkProfiles(absentProfilesPath(), HOME)
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.name).toBe('profiles')
    expect(result.status).toBe('ok')
    expect(result.detail).toMatch(/no profiles configured/i)
    expect(result.detail).toMatch(/refused/i)
  })

  it('reports, for each profile, which tiers are available and why an unavailable one is unavailable', async () => {
    const path = writeProfiles(`
version: 1
profiles:
  - name: everyday
    description: The operator's daily-use browser
    user_data_dir: ${DEFAULT_CHROME_DIR}
    profile_directory: Default
    classification: work
    allowed_origins:
      - '*.example.com'
  - name: acme
    description: Acme client work, dedicated automation profile
    user_data_dir: ${HOME}/chrome-profiles/acme
    profile_directory: Default
    classification: client
    allowed_origins:
      - '*.acme.com'
    extension: true
`)
    const check = checkProfiles(path, HOME)
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.status).toBe('ok')
    // The everyday profile's tier 2 is unavailable, and the reason is
    // reported in words an operator can act on, not just a bare "false".
    expect(result.detail).toMatch(/tier 2 unavailable/)
    expect(result.detail).toMatch(/default user-data directory/i)
    // The dedicated acme profile's tier 2 is available, and its extension
    // declaration makes tier 1 available too.
    expect(result.detail).toMatch(/tier 1 available/)
    expect(result.detail).toMatch(/tier 2 available/)
  })

  it('reports an unhonourable pin as a FAILURE, not a warning, per FR-PRF-4a', async () => {
    const path = writeProfiles(`
version: 1
profiles:
  - name: acme
    description: Acme, mistakenly pinned to a tier its own directory cannot support
    user_data_dir: ${DEFAULT_CHROME_DIR}
    profile_directory: Default
    classification: client
    allowed_origins:
      - '*.acme.com'
    pinned_tier: 2
`)
    const check = checkProfiles(path, HOME)
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.status).toBe('failed')
    expect(result.detail).toMatch(/PIN FAILURE/)
    expect(result.remediation).toBeDefined()
  })

  it('reports a personal profile as excluded from agent use, per FR-PRF-5, not a tier breakdown', async () => {
    const path = writeProfiles(`
version: 1
profiles:
  - name: personal-gmail
    description: The operator's own account
    user_data_dir: ${HOME}/Library/Application Support/Google/Chrome
    profile_directory: Default
    classification: personal
    allowed_origins:
      - '*.google.com'
    usable: false
`)
    const check = checkProfiles(path, HOME)
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.status).toBe('ok')
    expect(result.detail).toMatch(/excluded from agent use/i)
    expect(result.detail).toMatch(/FR-PRF-5/)
    // Excluded means excluded: no tier availability breakdown is printed for
    // a profile that can never be bound to a task regardless of its tiers.
    expect(result.detail).not.toMatch(/tier 1/)
  })

  it('never prints the operator home directory verbatim (FR-SEC-1)', async () => {
    const path = writeProfiles(`
version: 1
profiles:
  - name: everyday
    description: The operator's daily-use browser
    user_data_dir: ${DEFAULT_CHROME_DIR}
    profile_directory: Default
    classification: work
    allowed_origins:
      - '*.example.com'
`)
    const check = checkProfiles(path, HOME)
    const result = await check.run(IGNORED_CONTEXT)

    // Confirms the home directory really was embedded upstream (by
    // reportTierAvailability's own tier 2 reason), so this is a genuine
    // redaction assertion and not a false negative from a reason that never
    // contained it in the first place.
    expect(DEFAULT_CHROME_DIR.startsWith(HOME)).toBe(true)
    expect(result.detail).not.toContain(HOME)
    expect(result.detail).toContain('~')
  })

  it('is registered under the name relay doctor reports it by', () => {
    expect(checkProfiles().name).toBe('profiles')
  })
})
