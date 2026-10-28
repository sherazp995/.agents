/**
 * The one explicit place every built-in capability this build ships gets
 * registered, per fix round 1 addendum item 1: registration is a call this
 * file makes, not a side effect of some other file happening to import a
 * capability module. `src/orchestrator.ts`'s `defaultCapabilities()` is the
 * one production caller of `registerBuiltinCapabilities()` below.
 *
 * Adding a capability means adding its definition import to
 * `BUILTIN_CAPABILITY_DEFINITIONS`, nothing else: no bare side-effect
 * import to remember to add somewhere else, and nothing to keep in sync
 * between this list and what `src/orchestrator.ts` imports.
 */

import { registerCapability } from './registry.js'
import { ECHO_CAPABILITY_DEFINITION } from '../agent/capabilities/echo.js'
import { BROWSER_CAPABILITY_DEFINITION } from '../agent/capabilities/browser.js'
import { SHELL_CAPABILITY_DEFINITION } from '../agent/capabilities/shell.js'
import { FILES_CAPABILITY_DEFINITION } from '../agent/capabilities/files/index.js'
import { CODE_CAPABILITY_DEFINITION } from '../agent/capabilities/code.js'

const BUILTIN_CAPABILITY_DEFINITIONS = [ECHO_CAPABILITY_DEFINITION, BROWSER_CAPABILITY_DEFINITION, SHELL_CAPABILITY_DEFINITION, FILES_CAPABILITY_DEFINITION, CODE_CAPABILITY_DEFINITION]

/**
 * Registers every built-in capability. Safe to call more than once: each
 * definition here is the same constant object every time, so a second call
 * re-registers field-for-field identical definitions, which
 * `CapabilityRegistry.register()` treats as a no-op rather than an error
 * (see that method's own comment). A test proves this directly by calling
 * it twice and asserting no throw.
 */
export function registerBuiltinCapabilities(): void {
  for (const definition of BUILTIN_CAPABILITY_DEFINITIONS) {
    registerCapability(definition)
  }
}
