import { afterEach, describe, expect, it } from 'vitest'
import { defaultCapabilities } from '../src/orchestrator.js'
import { ECHO_CAPABILITY_NAME, echo } from '../src/agent/capabilities/echo.js'
import { registerCapability, unregisterCapability } from '../src/capabilities/registry.js'
import { z } from 'zod'

/**
 * Fix round 1, C-1: the reviewer's objection to the first version of this
 * proof (test/capabilities/registry.test.ts) was that it only exercised a
 * private `new CapabilityRegistry()` instance, never the actual path
 * src/orchestrator.ts's default capabilities map takes. This file imports
 * `defaultCapabilities` directly from src/orchestrator.ts, the exact
 * function `startOrchestrator`'s one call site calls, and nothing else:
 * no Postgres pool, no secret provider, no Slack adapter, none of what
 * `startOrchestrator` itself needs to actually run.
 */
describe('defaultCapabilities (src/orchestrator.ts)', () => {
  // Fix round 1 addendum, item 2: this describe block registers into the
  // shared process-wide registry (that is the entire point of testing
  // against defaultCapabilities() rather than a private instance), so it
  // cleans up after itself the same way test/capabilities/registry.test.ts
  // does.
  const registeredForCleanup: string[] = []

  afterEach(() => {
    for (const name of registeredForCleanup.splice(0)) unregisterCapability(name)
  })

  it('includes echo, registered via registerBuiltinCapabilities() inside defaultCapabilities(), not by this file hand-listing it', () => {
    const capabilities = defaultCapabilities()
    expect(capabilities[ECHO_CAPABILITY_NAME]).toBe(echo)
  })

  it('calling defaultCapabilities() more than once does not throw, since the registration it performs is idempotent', () => {
    expect(() => {
      defaultCapabilities()
      defaultCapabilities()
      defaultCapabilities()
    }).not.toThrow()
  })

  it('includes a capability registered process-wide after this file loaded, with no change to defaultCapabilities or its call site', () => {
    expect(defaultCapabilities()['test.orchestrator-probe']).toBeUndefined()

    registerCapability({
      name: 'test.orchestrator-probe',
      description: 'a capability registered only by this test, to prove defaultCapabilities has no fixed, hand-kept list',
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      riskTier: 'read',
      idempotencyClass: 'safe',
      requiredRunnerFeatures: [],
      costHint: 'free',
      requiresMachineLock: false,
      run: async (input: unknown) => input,
    })
    registeredForCleanup.push('test.orchestrator-probe')

    expect(defaultCapabilities()['test.orchestrator-probe']).toBeDefined()
  })
})
