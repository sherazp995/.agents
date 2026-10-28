import { describe, expect, it } from 'vitest'
import { checkCapabilities } from '../../../src/doctor/checks/capabilities.js'
import type { CheckContext } from '../../../src/doctor/registry.js'

/**
 * checkCapabilities.run ignores its CheckContext argument entirely (see the
 * check's own doc comment: registration needs no database, Redis, or Slack
 * credential), so this fake exists only to satisfy the Check interface's
 * declared signature at the call site, not because the check reads it.
 */
const IGNORED_CONTEXT = {} as CheckContext

describe('checkCapabilities', () => {
  it('reports ok and names every registered capability, including echo', async () => {
    const result = await checkCapabilities.run(IGNORED_CONTEXT)
    expect(result.name).toBe('capabilities')
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('echo')
  })

  it('is registered under the name relay doctor reports it by', () => {
    expect(checkCapabilities.name).toBe('capabilities')
  })
})
