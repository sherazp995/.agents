import { describe, expect, it } from 'vitest'
import { defaultChecks, registerCheck } from '../../src/doctor/registry.js'
import type { CheckContext } from '../../src/doctor/registry.js'

/** A CheckContext-shaped value good enough for a check that only reads config. Not loaded through the real schema, since these tests need no file on disk. */
function buildFakeContext(): CheckContext {
  return {
    config: {
      model_provider: { name: 'anthropic', zero_data_retention: true },
      database: { url: 'postgres://user:pass@localhost:5432/relay' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      secrets: { provider: 'keychain' },
    },
    policy: { version: 1, defaults: { unmatched: 'ask' }, hard_blocked_origins: ['*.example.com'] },
    secrets: {
      kind: 'env',
      get: async (name: string) => `stub-${name}`,
      has: async () => true,
    },
  }
}

describe('registerCheck / defaultChecks', () => {
  it('adds a check that defaultChecks then includes, alongside whatever the doctor modules already registered', () => {
    const before = defaultChecks().length
    registerCheck({
      name: 'test-registry-check-a',
      run: async () => ({ name: 'test-registry-check-a', status: 'ok', detail: 'stub' }),
    })
    const after = defaultChecks()
    expect(after.length).toBe(before + 1)
    expect(after.some((check) => check.name === 'test-registry-check-a')).toBe(true)
  })

  it('returns a copy, so mutating the returned array never changes what later calls see', () => {
    const first = defaultChecks()
    first.push({ name: 'should-not-persist', run: async () => ({ name: 'should-not-persist', status: 'ok', detail: '' }) })
    const second = defaultChecks()
    expect(second.some((check) => check.name === 'should-not-persist')).toBe(false)
  })

  it('runs a registered check against the CheckContext it is given', async () => {
    const seenProviderNames: string[] = []
    registerCheck({
      name: 'test-registry-check-b',
      run: async (ctx: CheckContext) => {
        seenProviderNames.push(ctx.config.model_provider.name)
        return { name: 'test-registry-check-b', status: 'ok', detail: 'ran with context' }
      },
    })

    const check = defaultChecks().find((candidate) => candidate.name === 'test-registry-check-b')
    expect(check).toBeDefined()

    const result = await check?.run(buildFakeContext())
    expect(result?.status).toBe('ok')
    expect(seenProviderNames).toEqual(['anthropic'])
  })
})
