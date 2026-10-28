/**
 * The one capability this milestone ships, per the Task 6 brief: "The point
 * is the loop, its persistence, its limits, and its governance, not the
 * capability." echo returns whatever it was given, unchanged, so every test
 * of the loop around it is testing the loop, never a capability's own
 * business logic.
 */

import { z } from 'zod'
import type { Capability } from '../loop.js'
import type { CapabilityDefinition } from '../../capabilities/registry.js'

export const echo: Capability = async (input: unknown): Promise<unknown> => input

/** The name src/agent/loop.ts's capability map registers echo under, and the name the engine is told to use when it wants this capability. */
export const ECHO_CAPABILITY_NAME = 'echo'

/**
 * FR-CAP-1's definition for echo. Risk tier `read` and idempotency class
 * `safe`, per docs/specs/2026-08-08-relay-requirements.md §10.1: echo makes
 * no observable external change, it only returns what it was given.
 * `run: echo` is what src/orchestrator.ts's registry-derived default
 * capability map actually invokes; requiresMachineLock is `false` per
 * FR-CAP-3, since echo never touches anything on the operator's screen.
 *
 * Fix round 1 addendum, item 1: this module does NOT call
 * `registerCapability` itself. A capability module that registers as an
 * import side effect only becomes reachable if something happens to import
 * it, an import-order dependency that works in every test (each test file
 * imports each module exactly once) and is exactly the kind of thing that
 * breaks a built binary with a different entry point or a dynamic import.
 * `src/capabilities/wiring.ts`'s `registerBuiltinCapabilities()` is the one
 * place this definition is actually registered, called explicitly by
 * `src/orchestrator.ts`.
 */
export const ECHO_CAPABILITY_DEFINITION: CapabilityDefinition = {
  name: ECHO_CAPABILITY_NAME,
  description: 'Returns whatever input it was given, unchanged. Exists to exercise the loop around a capability, not to do real work.',
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  riskTier: 'read',
  idempotencyClass: 'safe',
  requiredRunnerFeatures: [],
  costHint: 'free',
  requiresMachineLock: false,
  inputExamples: ['any value at all, returned unchanged'],
  run: echo,
}
