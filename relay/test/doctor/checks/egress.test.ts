import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkEgress } from '../../../src/doctor/checks/egress.js'
import type { CheckContext } from '../../../src/doctor/registry.js'
import type { EgressDestination } from '../../../src/data/egress.js'

/** An empty declared inventory, so a narrow fixture rootDir is compared against nothing else, isolating exactly the finding under test from the "declared but not present in this narrow fixture" noise every real, wiredInThisBuild: true entry (Slack, the model provider) would otherwise produce when scanned against anything narrower than the real src tree. */
const NO_OTHER_DECLARATIONS: readonly EgressDestination[] = []

/**
 * checkEgress's run() ignores its CheckContext argument entirely (it scans
 * source and reads the capability registry, neither of which needs a
 * database, Redis, or Slack credential), matching
 * test/doctor/checks/capabilities.test.ts's own IGNORED_CONTEXT for the
 * same reason.
 */
const IGNORED_CONTEXT = {} as CheckContext

function writeFixtureSource(relativePath: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-doctor-egress-'))
  writeFileSync(join(dir, relativePath), content, 'utf8')
  return dir
}

describe('checkEgress, FR-DATA-14', () => {
  it('reports ok against this repository\'s own real source, and states what it verified and assumed', async () => {
    const check = checkEgress()
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.name).toBe('egress')
    expect(result.status).toBe('ok')
    expect(result.detail).toMatch(/^Verified:/m)
    expect(result.detail).toMatch(/^Assumed:/m)
    expect(result.detail).toContain('confirmed: Slack')
  })

  it('fails, rather than ignores, an undeclared fetch destination', async () => {
    const dir = writeFixtureSource('leak.ts', `export function go() { return fetch('https://not-declared.example/x') }`)
    const check = checkEgress(dir, homedir(), NO_OTHER_DECLARATIONS)
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.status).toBe('failed')
    expect(result.detail).toMatch(/UNDECLARED fetch target "not-declared\.example"/)
    expect(result.remediation).toBeDefined()
  })

  it('fails, rather than ignores, an undeclared spawned binary', async () => {
    const dir = writeFixtureSource('leak.ts', `import { spawn } from 'node:child_process'\nspawn('mystery-cli', [])`)
    const check = checkEgress(dir, homedir(), NO_OTHER_DECLARATIONS)
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.status).toBe('failed')
    expect(result.detail).toMatch(/UNDECLARED spawn target "mystery-cli"/)
  })

  it('degrades, does not fail, on an unresolved spawn target with no known explanation', async () => {
    const dir = writeFixtureSource('leak.ts', `export function go(bin: string) { return spawn(bin, []) }`)
    const check = checkEgress(dir, homedir(), NO_OTHER_DECLARATIONS)
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.status).toBe('degraded')
    expect(result.detail).toMatch(/unresolved spawn target "bin"/)
  })

  it('redacts the operator home directory from a scanned file path, per FR-SEC-1', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-doctor-egress-home-'))
    // An undeclared destination, so its finding's `file` field (which
    // necessarily starts with `home`, since that is where the fixture was
    // scanned from) actually appears in `detail`, making this a genuine
    // redaction proof rather than one that would pass with no redaction at
    // all, for lack of any home-containing text to redact in the first
    // place.
    writeFileSync(join(home, 'leak.ts'), `fetch('https://not-declared.example/x')`, 'utf8')
    const check = checkEgress(home, home, NO_OTHER_DECLARATIONS)
    const result = await check.run(IGNORED_CONTEXT)

    expect(result.status).toBe('failed')
    expect(result.detail).toMatch(/UNDECLARED fetch target "not-declared\.example"/)
    expect(result.detail).not.toContain(home)
    expect(result.detail).toContain('~')
  })

  it('is registered under the name relay doctor reports it by', () => {
    expect(checkEgress().name).toBe('egress')
  })
})
