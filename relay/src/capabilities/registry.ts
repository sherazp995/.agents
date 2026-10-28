/**
 * The capability registry, per FR-CAP-1: the single source of truth for
 * every action Relay can execute on the operator's behalf. Nothing else in
 * this milestone maintains a second list of capability names; the model's
 * tool list and the policy engine's rules are both meant to derive from
 * this registry, never from a hand-kept array that could drift out of sync
 * with what is actually registered.
 *
 * `src/orchestrator.ts`'s default capability map (what `runAgentLoop`
 * actually receives when a caller doesn't override it) is built by
 * `buildCapabilityMap()` below, not hand-listed; see this file's test for
 * the proof that a newly registered capability appears in it with no
 * second edit, exercised against the same process-wide registry
 * `src/orchestrator.ts` reads from.
 *
 * Registration is explicit, not an import side effect: `src/capabilities/
 * wiring.ts`'s `registerBuiltinCapabilities()` is what actually calls
 * `registerCapability` for `src/agent/capabilities/echo.ts` (risk tier
 * `read`, idempotency class `safe`, per §10.1 and FR-CAP-1), and
 * `src/orchestrator.ts`'s `defaultCapabilities()` is what calls that.
 * Fix round 1 addendum, item 1: a capability module that registered itself
 * on import worked in every test, because a test file imports each module
 * exactly once, and broke the moment a second entry point, a dynamic
 * import, or a module reset re-executed that module body, since the
 * registry rejects re-registering an already-registered name. Registration
 * is also idempotent (`register()` below, and see its own comment) as a
 * second line of defence, but the explicit call is the actual fix: nothing
 * registers a capability just because something, somewhere, imported it.
 */

import { z } from 'zod'
import type { Capability } from '../agent/loop.js'

/**
 * Risk tier, per §10.1 of the requirements. Governs default policy
 * handling (allow, ask, always ask) in a later task; this file only
 * carries the declared tier, it enforces nothing from it.
 */
export const RISK_TIERS = ['read', 'write', 'sensitive', 'irreversible'] as const
export type RiskTier = (typeof RISK_TIERS)[number]

/**
 * Idempotency class, per FR-CAP-1. `safe` is a capability with no
 * observable effect at all (echo, any read), stated separately from
 * `idempotent` because a read's repeatability is never in question the way
 * a mutating one's is. See FR-ORC-1a: a `mutating` capability with no
 * declared idempotency strategy is classified at least `sensitive`, a
 * policy-engine concern this registry does not enforce.
 */
export const IDEMPOTENCY_CLASSES = ['safe', 'idempotent', 'mutating', 'irreversible'] as const
export type IdempotencyClass = (typeof IDEMPOTENCY_CLASSES)[number]

/** Accepts only an actual zod schema instance, so a capability cannot register a plain object or a string in place of one and have it pass silently. */
const zodSchemaField = z.custom<z.ZodTypeAny>((value) => value instanceof z.ZodType, {
  message: 'must be a zod schema',
})

/** Accepts only a callable, so a capability cannot register a placeholder (a string, an already-resolved value) in place of the function that actually runs it. */
const capabilityFnField = z.custom<Capability>((value) => typeof value === 'function', {
  message: 'must be a callable capability implementation',
})

/**
 * FR-CAP-1's exact field list, plus `requiresMachineLock` (FR-CAP-3, added
 * in fix round 1) and `run` (fix round 1, C-1). `inputSchema` and
 * `outputSchema` are real zod schemas, not JSON Schema documents: this
 * codebase already validates every other structured boundary with zod
 * (src/config/schema.ts, src/agent/loop.ts's PlanResponseSchema), and a
 * capability's input is validated by the same library its own definition
 * is, rather than adding a second schema dialect this milestone would then
 * need to keep two validators in sync for.
 *
 * `run` carries the actual implementation alongside its own governance
 * metadata, in the same object, rather than in a second map a caller has
 * to keep paired with this one by hand: that second map is exactly the
 * hand-listed capabilities object `src/orchestrator.ts` used to build
 * before fix round 1, which is the drift FR-CAP-1 exists to prevent.
 * `toCapabilityMap()` below is what turns this field into the map
 * `runAgentLoop` actually receives.
 */
const CapabilityDefinitionSchema = z.object({
  name: z.string().trim().min(1, 'capability name is required'),
  description: z.string().trim().min(1, 'capability description is required'),
  inputSchema: zodSchemaField,
  outputSchema: zodSchemaField,
  riskTier: z.enum(RISK_TIERS),
  idempotencyClass: z.enum(IDEMPOTENCY_CLASSES),
  // `.readonly()` (fix round 1 addendum, item 4): the inferred type is
  // `readonly string[]`, matching what register() below actually stores
  // (a frozen copy), so the type system and the runtime immutability agree
  // rather than the type claiming a mutability the stored value refuses.
  requiredRunnerFeatures: z.array(z.string()).readonly(),
  /**
   * A short, human-readable estimate ("free", "~$0.002/call"), not a
   * currency amount: cost varies by provider and this registry has no
   * notion of one yet. Loop.ts's own `estimatedCost` on a plan is the same
   * loosely-typed shape for the same reason.
   */
  costHint: z.string().trim().min(1, 'cost hint is required'),
  /**
   * FR-CAP-3: "Each capability declares whether it requires the machine
   * lock." Required rather than defaulted, since a missing declaration
   * defaulting to `false` would let a capability that DOES need the lock
   * run without ever having said so. Nothing consumes this field yet; the
   * lock itself arrives in P0.5.
   */
  requiresMachineLock: z.boolean(),
  /**
   * Extracts the outside destination this call will reach, from its own
   * input, so the policy engine can apply the hard-blocked list, the
   * denylist, and FR-POL-8's first-contact escalation BEFORE the capability
   * runs.
   *
   * Declared by the capability rather than inferred at the seam, because
   * only the capability knows its own input shape. A seam that guessed,
   * looking for a field named `url` say, would silently stop finding the
   * destination the day a capability named it something else, and the
   * failure would be a policy check quietly not running rather than an
   * error anyone sees.
   *
   * Optional: a capability that reaches nothing outside the machine has no
   * destination, and `echo` is the obvious case.
   */
  destinationOf: z
    .function()
    .args(z.unknown())
    .returns(z.union([z.string(), z.undefined()]))
    .optional(),
  /**
   * Concrete, valid inputs for this capability, shown to the model so it
   * can actually call it.
   *
   * THE GAP THIS CLOSES. FR-CAP-1 says the model's tool list derives from
   * this registry, but what reached the model was the capability's NAME and
   * nothing else: "the only capabilities Relay can execute are: echo,
   * browser." A model told that much can call `echo`, whose input is a
   * string anyone would guess, and cannot call `browser`, whose input is an
   * object with a destination and a list of eleven kinds of step. It would
   * guess, the input would fail validation, and the run would burn steps
   * discovering that.
   *
   * WHY EXAMPLES RATHER THAN A GENERATED JSON SCHEMA. Emitting JSON Schema
   * from these zod schemas needs a converter dependency this project does
   * not have, and a schema is not obviously better for this purpose than
   * two worked examples: the model is being shown how to call something,
   * not asked to validate it. The description field carries the semantics;
   * these carry the syntax.
   *
   * DRIFT IS IMPOSSIBLE BY CONSTRUCTION, which is the point. Every example
   * is parsed against this capability's own `inputSchema` at registration
   * time (see `register()`), so an example that stops being valid stops the
   * capability from registering at all. A hand-maintained example that
   * quietly rots into a lie about the input shape is exactly the failure
   * this field would otherwise introduce.
   */
  inputExamples: z.array(z.unknown()).readonly().optional(),
  /**
   * Turns this capability's own output into lines an OPERATOR should read,
   * regardless of what the model chose to say about it.
   *
   * THE GAP THIS CLOSES, and it is a safety one rather than a nicety. The
   * browser capability can return `humanActionNeeded`: the page was a
   * CAPTCHA, a bot wall, or a signed-out session (FR-BR-8, FR-BR-10). It
   * can also name the profile that acted, which FR-PRF-10 requires every
   * report to state. Both reached the model, and whether either reached
   * the operator depended entirely on the model choosing to mention it.
   * A safety property that holds only when a model remembers is not a
   * safety property.
   *
   * Declared by the capability rather than derived at the report, for the
   * same reason `destinationOf` is: only the capability knows its own
   * output shape, and a reporter that guessed would silently stop finding
   * anything the day that shape changed.
   *
   * Must never throw and must never include anything the capability would
   * not put in front of a person: these lines go straight into a chat
   * message. The loop wraps the call defensively anyway.
   */
  reportLines: z
    .function()
    .args(z.unknown())
    .returns(z.array(z.string()).readonly())
    .optional(),
  run: capabilityFnField,
})

// `Readonly<>` (fix round 1 addendum, item 4): register() stores a frozen
// object, so the type should say every field is readonly too, not just
// requiredRunnerFeatures (already readonly via the schema's .readonly()
// above); otherwise the type system would silently accept an assignment
// runtime freezing already refuses.
export type CapabilityDefinition = Readonly<z.infer<typeof CapabilityDefinitionSchema>>

/** The subset of a definition a model is shown. Deliberately excludes `run`, the schemas themselves, and every other field that would be noise in a prompt. */
export type CapabilityDocumentation = {
  readonly name: string
  readonly description: string
  readonly riskTier: RiskTier
  readonly inputExamples: readonly unknown[]
}

/**
 * Whether two validated definitions are the SAME registration, field for
 * field, not merely two definitions that happen to describe similarly
 * shaped capabilities. `run`, `inputSchema`, and `outputSchema` are
 * compared by reference deliberately: there is no sound way to compare two
 * functions or two zod schema instances for behavioural equality short of
 * calling them, and a re-registration that reused the exact same constant
 * (the normal case: the same module's top-level definition object, passed
 * through `registerBuiltinCapabilities()` a second time) will always be
 * reference-equal on these three fields. A definition that differs only in
 * having been rebuilt from scratch, with a structurally-but-not-referentially
 * identical function, is treated as a genuine conflict, not silently
 * accepted; see `register()`'s own comment for why that is the safer
 * default.
 */
function definitionsAreIdentical(a: CapabilityDefinition, b: CapabilityDefinition): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.riskTier === b.riskTier &&
    a.idempotencyClass === b.idempotencyClass &&
    a.costHint === b.costHint &&
    a.requiresMachineLock === b.requiresMachineLock &&
    a.inputSchema === b.inputSchema &&
    a.outputSchema === b.outputSchema &&
    a.run === b.run &&
    a.requiredRunnerFeatures.length === b.requiredRunnerFeatures.length &&
    a.requiredRunnerFeatures.every((feature, index) => feature === b.requiredRunnerFeatures[index])
  )
}

export class CapabilityRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapabilityRegistrationError'
  }
}

/**
 * An in-memory table of capability definitions keyed by name. A class,
 * following `src/runs/cancel.ts`'s CancellationRegistry, rather than a bare
 * module-level Map: production code shares exactly one instance
 * (`capabilityRegistry` below, which `registerCapability` and friends
 * delegate to), while a test that wants to prove registration rules in
 * isolation, without depending on or polluting whatever the rest of the
 * process has already registered, constructs its own with `new
 * CapabilityRegistry()`.
 */
export class CapabilityRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>()

  /**
   * Validates `definition` against `CapabilityDefinitionSchema` before
   * storing it. This is the actual guard behind FR-CAP-1's "cannot be
   * registered without a tier and an idempotency class": TypeScript alone
   * cannot stop a caller that builds the object dynamically or casts past
   * the type, so the check has to happen here, at runtime, on every call.
   * `safeParse` never throws on its own, including for `null` and
   * `undefined`; both fail validation the same way any other malformed
   * input does and surface as `CapabilityRegistrationError`, never a raw
   * `TypeError` (see this file's test for both cases proven explicitly).
   *
   * Re-registering the SAME name with a field-for-field identical
   * definition is a no-op, not an error, per fix round 1 addendum item 1:
   * `registerBuiltinCapabilities()` (src/capabilities/wiring.ts) may be
   * called more than once in one process, and that must never crash a
   * benign, idempotent re-wiring. A second registration under the same
   * name that differs in ANY field is still refused: silently accepting a
   * different definition under a name already in use is exactly the drift
   * FR-CAP-1 exists to rule out, identical-definition idempotency is a
   * narrow, deliberate exception to that rule, not a relaxation of it.
   */
  register(definition: CapabilityDefinition): void {
    const result = CapabilityDefinitionSchema.safeParse(definition)
    if (!result.success) {
      const name = typeof (definition as { name?: unknown })?.name === 'string' ? (definition as { name: string }).name : '<unnamed>'
      throw new CapabilityRegistrationError(
        `capability "${name}" could not be registered: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
      )
    }
    // Stores the PARSED result, not the raw argument: `.trim()` in the
    // schema above means a name or description with stray surrounding
    // whitespace is normalized here rather than stored verbatim under a key
    // nothing that later calls get(name) with the clean name would match.
    const validated = result.data

    // See `inputExamples`' own doc comment: an example that does not
    // satisfy the capability's own input schema is a lie about how to call
    // it, shown to a model that will believe it. Refused here, at
    // registration, rather than discovered when a run fails.
    for (const [index, example] of (validated.inputExamples ?? []).entries()) {
      const exampleResult = validated.inputSchema.safeParse(example)
      if (!exampleResult.success) {
        throw new CapabilityRegistrationError(
          `capability "${validated.name}" could not be registered: inputExamples[${index}] does not satisfy its own ` +
            `inputSchema: ${exampleResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        )
      }
    }

    const existing = this.definitions.get(validated.name)
    if (existing) {
      if (definitionsAreIdentical(existing, validated)) return
      throw new CapabilityRegistrationError(`capability "${validated.name}" is already registered`)
    }
    // Fix round 1 addendum, item 4: frozen, and with its own frozen copy of
    // requiredRunnerFeatures (zod's array validation does not clone), so
    // neither this method's caller nor a later get()/list() caller can
    // mutate a stored governance decision in place. `run`, `inputSchema`,
    // and `outputSchema` are not deep-frozen: they are a function and zod
    // schema instances respectively, not data a caller is expected to poke
    // properties onto, and freezing zod's own internals is unsupported and
    // risks breaking its lazy caching.
    const frozen: CapabilityDefinition = Object.freeze({
      ...validated,
      requiredRunnerFeatures: Object.freeze([...validated.requiredRunnerFeatures]),
    })
    this.definitions.set(frozen.name, frozen)
  }

  /**
   * Removes a registered capability, returning whether one was actually
   * removed. Nothing in production calls this yet (FR-CAP-2's enable and
   * disable is Task 2's policy file, not this registry); it exists so a
   * test that registers a throwaway capability into the SHARED process-wide
   * registry can clean up after itself instead of leaking into every test
   * that runs after it, per fix round 1 addendum item 2.
   */
  unregister(name: string): boolean {
    return this.definitions.delete(name)
  }

  /** Returns `undefined` for a name that was never registered. There is no default capability to fall back to; a caller that treats an undefined result as anything other than a refusal is the bug, not this method. */
  get(name: string): CapabilityDefinition | undefined {
    return this.definitions.get(name)
  }

  list(): readonly CapabilityDefinition[] {
    return Array.from(this.definitions.values())
  }

  /** The names of every registered capability, in registration order. The one derivation every "model's tool list" or "policy engine rule list" consumer is meant to call, per this file's header comment, instead of keeping its own list. */
  names(): readonly string[] {
    return this.list().map((definition) => definition.name)
  }

  /**
   * What a model needs in order to CALL a capability, as opposed to merely
   * know it exists: FR-CAP-1's "the model's tool list derives from this
   * registry", taken literally.
   *
   * Returns an entry for every requested name that is registered, in the
   * order requested, and simply omits one that is not. An unregistered name
   * is not this method's problem to report: the loop cannot execute it
   * either, and `runAgentLoop`'s own capability map is what decides that.
   */
  documentFor(names: readonly string[]): readonly CapabilityDocumentation[] {
    const docs: CapabilityDocumentation[] = []
    for (const name of names) {
      const definition = this.definitions.get(name)
      if (definition === undefined) continue
      docs.push({
        name: definition.name,
        description: definition.description,
        riskTier: definition.riskTier,
        inputExamples: definition.inputExamples ?? [],
      })
    }
    return docs
  }

  /**
   * The executable capability map `runAgentLoop` actually takes, per
   * FR-CAP-1's acceptance criterion that the model's tool list derives from
   * the registry. `src/orchestrator.ts`'s default `capabilities` map is
   * exactly this call's result; a capability that exists in this registry
   * but is not in the returned map is a bug in this method, never a reason
   * for a caller to fall back to a hand-listed object of its own.
   */
  toCapabilityMap(): Readonly<Record<string, Capability>> {
    const map: Record<string, Capability> = {}
    for (const definition of this.definitions.values()) {
      map[definition.name] = definition.run
    }
    return map
  }
}

/** The process-wide registry every capability module registers into and every consumer reads from. */
export const capabilityRegistry = new CapabilityRegistry()

export function registerCapability(definition: CapabilityDefinition): void {
  capabilityRegistry.register(definition)
}

export function getCapability(name: string): CapabilityDefinition | undefined {
  return capabilityRegistry.get(name)
}

/** See CapabilityRegistry.unregister's own doc comment: a test-cleanup primitive, not a production one. */
export function unregisterCapability(name: string): boolean {
  return capabilityRegistry.unregister(name)
}

export function listCapabilities(): readonly CapabilityDefinition[] {
  return capabilityRegistry.list()
}

/** The function `src/orchestrator.ts`'s default capability map calls directly; see CapabilityRegistry.toCapabilityMap's own doc comment. */
export function buildCapabilityMap(): Readonly<Record<string, Capability>> {
  return capabilityRegistry.toCapabilityMap()
}

/** See CapabilityRegistry.documentFor. The process-wide entry point `src/agent/loop.ts` uses to describe the capabilities it was handed. */
export function documentCapabilities(names: readonly string[]): readonly CapabilityDocumentation[] {
  return capabilityRegistry.documentFor(names)
}
