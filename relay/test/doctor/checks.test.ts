import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkConfig, checkNodeVersion, checkPostgres, checkRedisReachable } from '../../src/doctor/checks.js'

describe('checkNodeVersion', () => {
  it('passes on Node 22', () => {
    expect(checkNodeVersion('v22.18.0').status).toBe('ok')
  })

  it('fails on Node 20 and says what to do', () => {
    const result = checkNodeVersion('v20.11.0')
    expect(result.status).toBe('failed')
    expect(result.remediation).toMatch(/22/)
  })
})

describe('checkConfig', () => {
  function writeTemp(name: string, contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'relay-doctor-'))
    const path = join(dir, name)
    writeFileSync(path, contents, 'utf8')
    return path
  }

  it('reports failed with the reason when policy is invalid, rather than throwing', () => {
    const policy = writeTemp('policy.yaml', 'version: 1\ndefaults:\n  unmatched: ask\nhard_blocked_origins: []\n')
    const result = checkConfig('config/relay.config.yaml', policy)
    expect(result.status).toBe('failed')
    expect(result.detail).toMatch(/hard_blocked_origins/)
  })

  it('passes on the committed configuration', () => {
    expect(checkConfig('config/relay.config.yaml', 'config/policy.yaml').status).toBe('ok')
  })
})

describe('connectivity checks', () => {
  it('reports failed for an unreachable Postgres rather than hanging', async () => {
    const result = await checkPostgres('postgres://relay:relay@127.0.0.1:1/relay')
    expect(result.status).toBe('failed')
  }, 15000)

  it('reports failed for an unreachable Redis rather than hanging', async () => {
    const result = await checkRedisReachable('redis://127.0.0.1:1')
    expect(result.status).toBe('failed')
  }, 15000)
})
