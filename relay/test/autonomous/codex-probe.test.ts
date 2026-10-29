import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isProvenEligible, probeCodexAccount, readCodexEligibility, writeCodexEligibility } from '../../src/autonomous/codex-probe.js'

const ACCOUNT = { key: 'codex1', client: 'codex', configDir: '/h/.codex1', env: {} } as never

describe('codex eligibility', () => {
  it('counts an account only when it was proven on the installed codex version', () => {
    const eligibility = { codex1: { eligible: true, codexVersion: 'codex-cli 0.164.0', checkedAt: '', detail: '' } }
    expect(isProvenEligible(eligibility, 'codex1', 'codex-cli 0.164.0')).toBe(true)
    expect(isProvenEligible(eligibility, 'codex1', 'codex-cli 0.165.0')).toBe(false)
    expect(isProvenEligible(eligibility, 'codex', 'codex-cli 0.164.0')).toBe(false)
  })

  it('round-trips the eligibility file and reads a missing one as empty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-elig-'))
    expect(await readCodexEligibility(home)).toEqual({})
    await writeCodexEligibility(home, { codex1: { eligible: false, codexVersion: 'v', checkedAt: 't', detail: 'd' } })
    expect((await readCodexEligibility(home)).codex1?.eligible).toBe(false)
  })

  it('marks an account not eligible when codex runs without calling the hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-fake-codex-'))
    const fake = join(dir, 'codex')
    // Ignores the hook entirely, as codex does with an untrusted hook, and reports usage.
    writeFileSync(fake, '#!/bin/sh\necho \'{"type":"turn.completed","usage":{"input_tokens":1}}\'\n')
    chmodSync(fake, 0o755)

    const entry = await probeCodexAccount({ account: ACCOUNT, codexBin: fake, version: 'fake 1', hookCommand: 'true', codexHome: dir })

    expect(entry).toMatchObject({ eligible: false, codexVersion: 'fake 1', detail: expect.stringContaining('did not gate') })
  })

  it('closes stdin so a codex that reads it does not hang the probe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-fake-codex-'))
    const fake = join(dir, 'codex')
    // codex exec reads stdin to its end when stdin is a pipe ("Reading additional input from stdin...").
    writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"turn.completed","usage":{"input_tokens":1}}\'\n')
    chmodSync(fake, 0o755)

    const entry = await probeCodexAccount({ account: ACCOUNT, codexBin: fake, version: 'fake 1', hookCommand: 'true', codexHome: dir, timeoutMs: 5_000 })

    expect(entry.detail).toContain('did not gate')
  })
})
