import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/autonomous/accounts.js', () => ({
  readAccountPool: vi.fn(async () => [
    { key: 'claude-default', client: 'claude' },
    { key: 'codex-default', client: 'codex' },
  ]),
}))

import '../../../src/doctor/checks/autonomous.js'
import { defaultChecks, type CheckContext } from '../../../src/doctor/registry.js'

function check(name: string) {
  const found = defaultChecks().find((candidate) => candidate.name === name)
  if (!found) throw new Error(`check ${name} is not registered`)
  return found
}

function context(codexBin: string): CheckContext {
  return {
    config: { autonomous: { enabled: true, claude_bin: process.execPath, codex_bin: codexBin } },
  } as unknown as CheckContext
}

describe('autonomous doctor checks when codex is not installed', () => {
  const missingCodex = '/nonexistent/bin/codex'
  let previousRepos: string | undefined

  beforeEach(() => {
    previousRepos = process.env.RELAY_REPOS_PATH
    const dir = mkdtempSync(join(tmpdir(), 'relay-doctor-autonomous-'))
    const reposPath = join(dir, 'repos.yaml')
    writeFileSync(reposPath, `version: 1\nrepos:\n  - name: agents\n    path: ${dir}\n    default_branch: main\n    permitted_operations: [read]\n`)
    process.env.RELAY_REPOS_PATH = reposPath
  })

  afterEach(() => {
    if (previousRepos === undefined) delete process.env.RELAY_REPOS_PATH
    else process.env.RELAY_REPOS_PATH = previousRepos
  })

  it('passes setup and notes that chats use claude only', async () => {
    const result = await check('autonomous-setup').run(context(missingCodex))

    expect(result.status).toBe('ok')
    expect(result.detail).toContain(`codex is not installed at ${missingCodex}, so chats use claude only`)
  })

  it('still fails setup when claude is missing', async () => {
    const ctx = context(missingCodex)
    ;(ctx.config.autonomous as { claude_bin: string }).claude_bin = '/nonexistent/bin/claude'

    const result = await check('autonomous-setup').run(ctx)

    expect(result.status).toBe('failed')
    expect(result.detail).toContain('claude_bin /nonexistent/bin/claude is not an executable file')
  })

  it('reports the codex hook as ok without probing codex', async () => {
    const result = await check('autonomous-codex-hook').run(context(missingCodex))

    expect(result).toMatchObject({ status: 'ok', detail: `codex is not installed at ${missingCodex}; it is optional, so codex is not used` })
  })
})
