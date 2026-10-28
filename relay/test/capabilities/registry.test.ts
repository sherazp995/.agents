import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCapabilityMap,
  CapabilityRegistrationError,
  CapabilityRegistry,
  getCapability,
  IDEMPOTENCY_CLASSES,
  listCapabilities,
  registerCapability,
  RISK_TIERS,
  unregisterCapability,
} from '../../src/capabilities/registry.js'
import type { CapabilityDefinition } from '../../src/capabilities/registry.js'
import { ECHO_CAPABILITY_NAME, echo } from '../../src/agent/capabilities/echo.js'
import { registerBuiltinCapabilities } from '../../src/capabilities/wiring.js'
import { z } from 'zod'

/**
 * A test-only, mutable view of CapabilityDefinition: every field optional
 * AND writable, so a "definition with a required field deliberately
 * missing" fixture can `delete` that field. CapabilityDefinition itself is
 * `Readonly<>` (fix round 1 addendum, item 4), and TypeScript refuses
 * `delete` on a readonly property even under `Partial<>`; this type strips
 * that at the type level only; register() below still validates the
 * resulting object against the real schema at runtime regardless of what
 * this test file's own local type claims about it.
 */
type MutablePartialDefinition = { -readonly [K in keyof CapabilityDefinition]?: CapabilityDefinition[K] }

/** A minimal, otherwise-valid definition each test starts from and overrides just the field it cares about, so a failing assertion is never obscured by an unrelated missing field. */
function buildDefinition(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    name: 'test.capability',
    description: 'a capability used only by this test file',
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    riskTier: 'read',
    idempotencyClass: 'safe',
    requiredRunnerFeatures: [],
    costHint: 'free',
    requiresMachineLock: false,
    run: async (input: unknown): Promise<unknown> => input,
    ...overrides,
  }
}

describe('CapabilityRegistry', () => {
  it('registers a valid capability and returns it from get', () => {
    const registry = new CapabilityRegistry()
    const definition = buildDefinition({ name: 'test.valid' })
    registry.register(definition)
    expect(registry.get('test.valid')).toEqual(definition)
  })

  // Fix round 1 addendum, item 5: the assertion just above,
  // `toEqual(definition)`, compares the stored value against the exact
  // object that was registered. That cannot distinguish "stored the
  // validated definition" (correct, per the f84666f self-review fix) from
  // "stored the raw argument" (the bug that fix corrected), because a
  // clean fixture with no surrounding whitespace is identical either way.
  // This test uses a name and description the schema's `.trim()` actually
  // changes, and asserts what get() returns reflects the TRIMMED result,
  // never the raw padded input.
  it('stores the validated definition, not the raw argument: a name and description with surrounding whitespace come back trimmed', () => {
    const registry = new CapabilityRegistry()
    const padded = buildDefinition({ name: '  test.padded  ', description: '  padded on both sides  ' })
    registry.register(padded)

    const stored = registry.get('test.padded')
    expect(stored?.name).toBe('test.padded')
    expect(stored?.description).toBe('padded on both sides')
    // The precise claim this test exists to prove: the stored value must
    // NOT equal the raw input, since the raw input still carries the
    // padding.
    expect(stored).not.toEqual(padded)
  })

  it('refuses an unregistered capability rather than defaulting to a placeholder', () => {
    const registry = new CapabilityRegistry()
    expect(registry.get('test.never-registered')).toBeUndefined()
  })

  it('refuses a second registration under a name already in use with a different definition', () => {
    const registry = new CapabilityRegistry()
    registry.register(buildDefinition({ name: 'test.duplicate' }))
    expect(() => registry.register(buildDefinition({ name: 'test.duplicate', costHint: '$1/call' }))).toThrow(
      CapabilityRegistrationError,
    )
  })

  // Fix round 1 addendum, item 1: re-registering the exact same definition
  // (the normal shape of calling registerBuiltinCapabilities() more than
  // once, or a test file importing a capability module twice) must be a
  // no-op, not a crash.
  it('treats re-registering the SAME definition object under its own name as a no-op, not an error', () => {
    const registry = new CapabilityRegistry()
    const definition = buildDefinition({ name: 'test.idempotent' })
    registry.register(definition)
    expect(() => registry.register(definition)).not.toThrow()
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('test.idempotent')).toEqual(definition)
  })

  // Fix round 1 addendum, item 3: `register(null)` and `register(undefined)`
  // must surface as CapabilityRegistrationError, the same as any other
  // malformed input, never a raw TypeError a caller cannot distinguish from
  // a genuine bug in the registry itself.
  it('refuses register(null) with CapabilityRegistrationError, not a TypeError', () => {
    const registry = new CapabilityRegistry()
    expect(() => registry.register(null as unknown as CapabilityDefinition)).toThrow(CapabilityRegistrationError)
  })

  it('refuses register(undefined) with CapabilityRegistrationError, not a TypeError', () => {
    const registry = new CapabilityRegistry()
    expect(() => registry.register(undefined as unknown as CapabilityDefinition)).toThrow(
      CapabilityRegistrationError,
    )
  })

  // Self-attack, per the brief: register a capability with a missing tier
  // and confirm it is refused. Constructing the bad definition via `as
  // unknown as CapabilityDefinition` mimics the one way this actually
  // happens in production, a caller that built the object dynamically (or
  // from untrusted config) and cast past the type checker, since TypeScript
  // alone would already refuse a literal missing the field.
  it('SELF-ATTACK: refuses registration when riskTier is missing, and the capability never becomes registered', () => {
    const registry = new CapabilityRegistry()
    const withoutTier = { ...buildDefinition({ name: 'test.no-tier' }) } as MutablePartialDefinition
    delete withoutTier.riskTier
    expect(() => registry.register(withoutTier as unknown as CapabilityDefinition)).toThrow(
      CapabilityRegistrationError,
    )
    expect(registry.get('test.no-tier')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  it('refuses registration when idempotencyClass is missing, and the capability never becomes registered', () => {
    const registry = new CapabilityRegistry()
    const withoutClass = { ...buildDefinition({ name: 'test.no-class' }) } as MutablePartialDefinition
    delete withoutClass.idempotencyClass
    expect(() => registry.register(withoutClass as unknown as CapabilityDefinition)).toThrow(
      CapabilityRegistrationError,
    )
    expect(registry.get('test.no-class')).toBeUndefined()
  })

  it('refuses a riskTier value outside the declared enum', () => {
    const registry = new CapabilityRegistry()
    const bad = { ...buildDefinition({ name: 'test.bad-tier' }), riskTier: 'catastrophic' } as unknown as CapabilityDefinition
    expect(() => registry.register(bad)).toThrow(CapabilityRegistrationError)
  })

  it('refuses an idempotencyClass value outside the declared enum', () => {
    const registry = new CapabilityRegistry()
    const bad = {
      ...buildDefinition({ name: 'test.bad-class' }),
      idempotencyClass: 'usually-fine',
    } as unknown as CapabilityDefinition
    expect(() => registry.register(bad)).toThrow(CapabilityRegistrationError)
  })

  it('refuses an inputSchema or outputSchema that is not an actual zod schema', () => {
    const registry = new CapabilityRegistry()
    const bad = {
      ...buildDefinition({ name: 'test.bad-schema' }),
      inputSchema: { type: 'object' },
    } as unknown as CapabilityDefinition
    expect(() => registry.register(bad)).toThrow(CapabilityRegistrationError)
  })

  // FR-CAP-3: "Each capability declares whether it requires the machine
  // lock." Required like riskTier and idempotencyClass, not defaulted:
  // silently defaulting a missing declaration to `false` would let a
  // capability that DOES need the lock run without ever having said so.
  it('refuses registration when requiresMachineLock is missing, and the capability never becomes registered', () => {
    const registry = new CapabilityRegistry()
    const withoutLock = { ...buildDefinition({ name: 'test.no-lock' }) } as MutablePartialDefinition
    delete withoutLock.requiresMachineLock
    expect(() => registry.register(withoutLock as unknown as CapabilityDefinition)).toThrow(
      CapabilityRegistrationError,
    )
    expect(registry.get('test.no-lock')).toBeUndefined()
  })

  it('refuses a requiresMachineLock value that is not a boolean', () => {
    const registry = new CapabilityRegistry()
    const bad = { ...buildDefinition({ name: 'test.bad-lock' }), requiresMachineLock: 'yes' } as unknown as CapabilityDefinition
    expect(() => registry.register(bad)).toThrow(CapabilityRegistrationError)
  })

  it('refuses registration when run is missing, and the capability never becomes registered', () => {
    const registry = new CapabilityRegistry()
    const withoutRun = { ...buildDefinition({ name: 'test.no-run' }) } as MutablePartialDefinition
    delete withoutRun.run
    expect(() => registry.register(withoutRun as unknown as CapabilityDefinition)).toThrow(
      CapabilityRegistrationError,
    )
    expect(registry.get('test.no-run')).toBeUndefined()
  })

  it('refuses a run value that is not callable', () => {
    const registry = new CapabilityRegistry()
    const bad = { ...buildDefinition({ name: 'test.bad-run' }), run: 'not a function' } as unknown as CapabilityDefinition
    expect(() => registry.register(bad)).toThrow(CapabilityRegistrationError)
  })

  // Fix round 1 addendum, item 4: list() (and, by the same storage, get())
  // must not hand back a mutable reference to what the registry itself
  // holds. Mutating what list() returned must never change what a later
  // get() sees, which would otherwise let a caller silently rewrite a
  // capability's own risk tier after the fact.
  it('freezes a stored definition, so mutating what list() or get() returned does not change what the registry holds', () => {
    const registry = new CapabilityRegistry()
    registry.register(buildDefinition({ name: 'test.frozen', riskTier: 'read' }))

    const fromList = registry.list()[0]
    expect(fromList).toBeDefined()
    expect(() => {
      // @ts-expect-error deliberately mutating a readonly field to prove it is refused at runtime too
      fromList!.riskTier = 'irreversible'
    }).toThrow(TypeError)
    expect(registry.get('test.frozen')?.riskTier).toBe('read')

    const fromGet = registry.get('test.frozen')
    expect(() => {
      // @ts-expect-error same, via get() instead of list()
      fromGet!.requiredRunnerFeatures.push('shell')
    }).toThrow(TypeError)
    expect(registry.get('test.frozen')?.requiredRunnerFeatures).toEqual([])
  })

  // FR-CAP-1's own acceptance criterion, proven against the actual
  // executable map this time, not just the name list: registering a
  // capability changes toCapabilityMap()'s output with no second edit, and
  // the map carries the real `run` function, not a placeholder.
  it('toCapabilityMap() derives an executable capability map from what is registered', async () => {
    const registry = new CapabilityRegistry()
    expect(registry.toCapabilityMap()).toEqual({})

    registry.register(buildDefinition({ name: 'test.runnable', run: async () => 'ran' }))
    const map = registry.toCapabilityMap()
    expect(Object.keys(map)).toEqual(['test.runnable'])
    await expect(map['test.runnable']?.(null, new AbortController().signal)).resolves.toBe('ran')
  })

  // FR-CAP-1's acceptance criterion: "the model's tool list and the policy
  // engine's rules both derive from it", proven here by never touching the
  // derivation itself between the two registrations. If `names()` were
  // instead a second, hand-maintained list, this test would still pass on
  // its first assertion and only catch the drift on its second, which is
  // exactly the bug this test exists to make impossible to reintroduce.
  it('derives its capability name list from what is registered, so a newly added capability appears with no second edit', () => {
    const registry = new CapabilityRegistry()
    const deriveToolList = (): readonly string[] => registry.names()

    registry.register(buildDefinition({ name: 'test.alpha' }))
    expect(deriveToolList()).toEqual(['test.alpha'])

    registry.register(buildDefinition({ name: 'test.beta' }))
    expect(deriveToolList()).toEqual(['test.alpha', 'test.beta'])
  })

  it('list() and names() reflect every registered capability, not just the most recent one', () => {
    const registry = new CapabilityRegistry()
    registry.register(buildDefinition({ name: 'test.one' }))
    registry.register(buildDefinition({ name: 'test.two' }))
    registry.register(buildDefinition({ name: 'test.three' }))
    expect(registry.names()).toEqual(['test.one', 'test.two', 'test.three'])
    expect(registry.list().map((d) => d.name)).toEqual(['test.one', 'test.two', 'test.three'])
  })

  it('unregister() removes a capability and reports whether one was actually removed', () => {
    const registry = new CapabilityRegistry()
    registry.register(buildDefinition({ name: 'test.removable' }))
    expect(registry.unregister('test.removable')).toBe(true)
    expect(registry.get('test.removable')).toBeUndefined()
    expect(registry.unregister('test.removable')).toBe(false)
  })
})

describe('the process-wide registry (registerCapability / getCapability / listCapabilities)', () => {
  // Fix round 1 addendum, item 2: every test in this block that registers
  // into the SHARED singleton (not a private `new CapabilityRegistry()`,
  // the point of this describe block) cleans up after itself, so nothing
  // here leaks into a test that runs later, in this file or otherwise.
  const registeredForCleanup: string[] = []

  function registerTestCapability(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
    const definition = buildDefinition(overrides)
    registerCapability(definition)
    // Tracks the TRIMMED name (what the schema's `.trim()` actually stores
    // it under, per register()), not `definition.name` verbatim: a padded
    // name such as '  test.padded  ' is stored under 'test.padded', and
    // unregisterCapability('  test.padded  ') would silently remove
    // nothing, leaking the trimmed entry into every later test exactly the
    // way this cleanup exists to prevent.
    registeredForCleanup.push(definition.name.trim())
    return definition
  }

  afterEach(() => {
    for (const name of registeredForCleanup.splice(0)) unregisterCapability(name)
  })

  it('exposes the same risk tier and idempotency class enums the definition schema validates against', () => {
    expect(RISK_TIERS).toContain('read')
    expect(RISK_TIERS).toContain('irreversible')
    expect(IDEMPOTENCY_CLASSES).toContain('safe')
    expect(IDEMPOTENCY_CLASSES).toContain('mutating')
  })

  it('refuses an unregistered capability rather than defaulting to a placeholder', () => {
    expect(getCapability('test.definitely-not-registered-anywhere')).toBeUndefined()
  })

  it('registers a capability process-wide and lists it', () => {
    const definition = registerTestCapability({ name: 'test.process-wide' })
    expect(getCapability('test.process-wide')).toEqual(definition)
    expect(listCapabilities().map((d) => d.name)).toContain('test.process-wide')
  })

  // Fix round 1 addendum, item 5, the free-function path (registerCapability
  // / getCapability) this file's original review flagged by line number.
  // Same shape and same reasoning as the CapabilityRegistry-level version
  // above: a clean fixture cannot distinguish stored-validated from
  // stored-raw, so this uses a padded name and description instead.
  it('getCapability() reflects the validated (trimmed) definition, not the raw registered argument', () => {
    const padded = registerTestCapability({
      name: '  test.process-wide-padded  ',
      description: '  padded on both sides  ',
    })
    const stored = getCapability('test.process-wide-padded')
    expect(stored?.name).toBe('test.process-wide-padded')
    expect(stored?.description).toBe('padded on both sides')
    expect(stored).not.toEqual(padded)
  })

  // Fix round 1 addendum, item 1: registration is now explicit
  // (registerBuiltinCapabilities(), src/capabilities/wiring.ts), not an
  // import side effect, so this test calls it directly rather than relying
  // on the `echo` import above having already run it.
  it('echo registers as risk tier read and idempotency class safe, per §10.1 and FR-CAP-1', () => {
    registerBuiltinCapabilities()
    const definition = getCapability(ECHO_CAPABILITY_NAME)
    expect(definition).toBeDefined()
    expect(definition?.riskTier).toBe('read')
    expect(definition?.idempotencyClass).toBe('safe')
    expect(definition?.name).toBe('echo')
    expect(definition?.requiresMachineLock).toBe(false)
  })

  // Fix round 1 addendum, item 1's own proof requirement: "a test that
  // imports the module twice must not throw." registerBuiltinCapabilities()
  // is what a second import (or a second entry point, or a dynamic
  // reimport within the same module realm) would end up calling again;
  // calling it repeatedly here must never throw.
  it('registerBuiltinCapabilities() is safe to call more than once', () => {
    expect(() => {
      registerBuiltinCapabilities()
      registerBuiltinCapabilities()
      registerBuiltinCapabilities()
    }).not.toThrow()
    expect(getCapability(ECHO_CAPABILITY_NAME)).toBeDefined()
  })

  // Fix round 1, C-1: proves the derivation against the SHARED singleton
  // (`buildCapabilityMap`, the exact function `src/orchestrator.ts`'s
  // default expression calls), not an isolated `new CapabilityRegistry()`.
  // That isolation gap was the reviewer's objection to the first version of
  // this test file: a passing test against a private instance says nothing
  // about whether production actually reads from the registry.
  it('buildCapabilityMap() includes echo once registerBuiltinCapabilities() has run', () => {
    registerBuiltinCapabilities()
    const map = buildCapabilityMap()
    expect(map[ECHO_CAPABILITY_NAME]).toBe(echo)
  })

  it('buildCapabilityMap() includes a capability registered process-wide after this test file loaded, with no change to buildCapabilityMap itself', () => {
    expect(buildCapabilityMap()['test.late-registration']).toBeUndefined()
    registerTestCapability({ name: 'test.late-registration' })
    expect(buildCapabilityMap()['test.late-registration']).toBeDefined()
  })
})
