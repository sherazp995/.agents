import type { Policy, RelayConfig } from '../config/schema.js'
import type { Logger } from '../obs/logger.js'
import type { SecretProvider } from '../secrets/provider.js'
import type { CheckResult } from './checks.js'

/**
 * Everything a check needs to run, built once per `relay doctor` invocation
 * from the already-parsed config and policy. A check that needs Postgres,
 * Redis, Slack, or any future dependency reads what it needs from here
 * instead of loading its own copy.
 */
export type CheckContext = {
  config: RelayConfig
  policy: Policy
  secrets: SecretProvider
  log?: Logger
}

/**
 * One diagnostic. `name` identifies it in the report; `run` produces its
 * result from a shared CheckContext. This is the seam that replaces the
 * fixed four-property DoctorChecks type: growing FR-OBS-5's list of
 * dependency classes is now a matter of writing a new Check and calling
 * registerCheck, not editing a type and a function body together.
 */
export type Check = {
  name: string
  run(ctx: CheckContext): Promise<CheckResult>
}

const registeredChecks: Check[] = []

/**
 * Adds a check to the set `relay doctor` runs by default. Check-defining
 * modules call this at import time, so a platform-specific check, such as
 * a macOS Keychain probe, can register itself without this registry ever
 * importing that module, which is what keeps macOS-only checks pluggable
 * rather than compiled into the core per NFR-10.
 */
export function registerCheck(check: Check): void {
  registeredChecks.push(check)
}

/**
 * The checks currently registered, in registration order. Returns a copy
 * so a caller mutating the result cannot mutate the registry itself.
 */
export function defaultChecks(): Check[] {
  return [...registeredChecks]
}
