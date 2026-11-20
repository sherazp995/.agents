import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/autonomous/accounts.js', () => ({
  readAccountPool: vi.fn(async () => [
    { key: 'claude', client: 'claude' },
    { key: 'codex', client: 'codex', configDir: '/homes/codex' },
    { key: 'codex1', client: 'codex', configDir: '/homes/codex1' },
  ]),
}))

// The compiled hook script only exists under dist; the check refuses to probe without it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: (path: string) => (String(path).endsWith('hook-pretooluse.js') ? true : actual.existsSync(path)) }
})

const probe = vi.hoisted(() => vi.fn())
vi.mock('../../../src/autonomous/codex-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/autonomous/codex-probe.js')>()
  return { ...actual, codexVersion: vi.fn(async () => 'codex-cli 9.9.9'), probeCodexAccount: probe }
})

import '../../../src/doctor/checks/autonomous.js'
import { defaultChecks, type CheckContext } from '../../../src/doctor/registry.js'

const codexHook = defaultChecks().find((check) => check.name === 'autonomous-codex-hook')!

function context(recheck = false): CheckContext {
  return {
    config: { autonomous: { enabled: true, claude_bin: process.execPath, codex_bin: process.execPath } },
    ...(recheck ? { recheck: true } : {}),
  } as unknown as CheckContext
}

describe('autonomous-codex-hook reuses saved proofs', () => {
  let home: string
  let previousHome: string | undefined
  const saved = () => JSON.parse(readFileSync(join(home, 'codex-eligibility.json'), 'utf8')) as Record<string, { eligible: boolean; codexHome: string; hookCommand: string }>
  const probedKeys = () => probe.mock.calls.map(([params]) => (params as { account: { key: string } }).account.key).sort()

  beforeEach(() => {
    previousHome = process.env.RELAY_HOME
    home = mkdtempSync(join(tmpdir(), 'relay-codex-reuse-'))
    process.env.RELAY_HOME = home
    probe.mockReset()
    probe.mockImplementation(async (params: { version: string }) => ({ eligible: true, codexVersion: params.version, checkedAt: '2026-11-20T10:00:00.000Z', detail: 'the hook denied git merge' }))
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.RELAY_HOME
    else process.env.RELAY_HOME = previousHome
  })

  it('probes every login the first time, then reuses the saved proofs without a codex turn and keeps them in the file', async () => {
    await codexHook.run(context())
    expect(probedKeys()).toEqual(['codex', 'codex1'])

    probe.mockClear()
    const second = await codexHook.run(context())

    expect(probe).not.toHaveBeenCalled()
    expect(second).toMatchObject({ status: 'ok' })
    expect(second.detail).toContain('codex: eligible (proven 2026-11-20 10:00 UTC)')
    expect(second.detail).toContain('`relay doctor --recheck` probes again')
    expect(Object.keys(saved()).sort()).toEqual(['codex', 'codex1'])
  })

  it('probes again only the login whose saved proof failed or ran with another codex home or hook command', async () => {
    await codexHook.run(context())
    const file = saved()
    writeFileSync(
      join(home, 'codex-eligibility.json'),
      JSON.stringify({ ...file, codex: { ...file.codex, codexHome: '/homes/moved' }, codex1: { ...file.codex1, hookCommand: "'/old/node' '/old/hook.js'" } }),
    )
    probe.mockClear()
    await codexHook.run(context())
    expect(probedKeys()).toEqual(['codex', 'codex1'])

    writeFileSync(join(home, 'codex-eligibility.json'), JSON.stringify({ ...saved(), codex1: { ...saved().codex1, eligible: false } }))
    probe.mockClear()
    await codexHook.run(context())
    expect(probedKeys()).toEqual(['codex1'])
  })

  it('probes every login with --recheck even when all saved proofs still match', async () => {
    await codexHook.run(context())
    probe.mockClear()

    await codexHook.run(context(true))

    expect(probedKeys()).toEqual(['codex', 'codex1'])
  })
})
