/**
 * A registered, schema-bearing capability for Task 4's fix round 1:
 * `resolveApproval`'s edit_and_approve option must validate the operator's
 * edited input against a real capability inputSchema from
 * src/capabilities/registry.ts before it can ever be substituted for the
 * original arguments. Every test in this project's suite that exercises
 * edit_and_approve needs a real registered schema to validate against, so
 * this lives in test/support the way test/support/slow-capability.ts does,
 * rather than being redefined per test file.
 *
 * Registered under `APPROVAL_TEST_CAPABILITY` ("shell.exec"), matching the
 * capability name test/approvals/store.test.ts's own fixtures already
 * default to, so no existing test's `capability:` field needs to change to
 * pick this up.
 *
 * `run` is never actually invoked by anything in the approvals suite:
 * approvals only reads the registry entry for its `inputSchema`, never
 * calls `run`. It exists only because CapabilityDefinitionSchema requires
 * it.
 */

import { z } from 'zod'
import { registerCapability, unregisterCapability } from '../../src/capabilities/registry.js'

export const APPROVAL_TEST_CAPABILITY = 'shell.exec'

/** A deliberately simple shape: one required string field, so a test can build both a valid and an invalid edited-input payload without needing to reason about a real shell capability's actual argument surface. */
export const approvalTestInputSchema = z.object({ command: z.string().min(1) })

/**
 * Idempotent, matching CapabilityRegistry.register's own documented
 * behaviour for a field-for-field identical re-registration: safe to call
 * from more than one `beforeAll` in the same test file/worker without
 * throwing, since every caller passes this exact same definition object.
 */
export function registerApprovalTestCapability(): void {
  registerCapability({
    name: APPROVAL_TEST_CAPABILITY,
    description: 'Test-only capability, for approvals edit-and-approve input validation.',
    inputSchema: approvalTestInputSchema,
    outputSchema: z.object({}).strict(),
    riskTier: 'irreversible',
    idempotencyClass: 'irreversible',
    requiredRunnerFeatures: [],
    costHint: 'free',
    requiresMachineLock: false,
    run: async () => ({}),
  })
}

/** Test-cleanup only, per CapabilityRegistry.unregister's own doc comment: removes this capability from the shared process-wide registry so it does not leak into a test file that runs after this one in the same worker. */
export function unregisterApprovalTestCapability(): void {
  unregisterCapability(APPROVAL_TEST_CAPABILITY)
}
