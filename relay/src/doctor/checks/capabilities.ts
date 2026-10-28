import { registerBuiltinCapabilities } from '../../capabilities/wiring.js'
import { listCapabilities } from '../../capabilities/registry.js'
import type { CheckResult } from '../checks.js'
import { registerCheck } from '../registry.js'
import type { Check } from '../registry.js'

/**
 * Confirms registerBuiltinCapabilities() actually wired at least one
 * capability into the registry, in THIS running process. Fix round 1
 * addendum, item 1's concern was that a proof run only through Vitest's
 * on-the-fly transform cannot show whether the COMPILED binary's real
 * module graph still reaches this wiring: this project already shipped one
 * bug of exactly that shape (a `pg` import that passed every unit test and
 * broke the compiled binary). test/doctor/cli.test.ts's existing "compiled
 * CLI" guard, which builds with `pnpm build` and spawns the real
 * `dist/src/cli.js` as a subprocess, asserts this check's detail names
 * `echo`, which is only possible if `relay doctor`, running as compiled
 * JS, actually called registerBuiltinCapabilities() and it actually
 * registered something. Needs no database, Redis, or Slack credential, so
 * it ignores CheckContext entirely; registration is a fact about the
 * process's own module graph, not an external dependency.
 */
export const checkCapabilities: Check = {
  name: 'capabilities',
  async run(): Promise<CheckResult> {
    registerBuiltinCapabilities()
    const names = listCapabilities().map((definition) => definition.name)
    if (names.length === 0) {
      return {
        name: 'capabilities',
        status: 'failed',
        detail: 'no capabilities are registered',
        remediation: 'This is an internal Relay fault: registerBuiltinCapabilities() registered nothing.',
      }
    }
    return { name: 'capabilities', status: 'ok', detail: names.join(', ') }
  },
}

registerCheck(checkCapabilities)
