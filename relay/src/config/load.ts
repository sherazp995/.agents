import { existsSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { z } from 'zod'
import { ConfigError } from './errors.js'
import { type Policy, type RelayConfig, policySchema, relayConfigSchema } from './schema.js'
import { type ProfileRegistry, profileRegistrySchema } from '../profiles/schema.js'
import { type RepoRegistry, repoRegistrySchema } from '../repos/schema.js'

/**
 * Freezes an object graph recursively, arrays included, so a caller cannot
 * mutate a loaded config or policy at runtime. FR-POL-4 says the hard-blocked
 * origin list "cannot be overridden at runtime"; without this, that was only
 * a comment, and `hard_blocked_origins.length = 0` succeeded silently.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/**
 * Generic over the schema rather than over one type, because `z.ZodType<T>`
 * pins input and output to the same T. Any schema with a default or a
 * transform has a different input type, and TS resolves T from the input
 * position, so the caller silently receives the PRE-parse shape: fields the
 * schema guarantees are populated appear optional. Taking the schema itself
 * and reading `z.infer` off it gives the post-parse shape the caller
 * actually gets at runtime.
 */
function loadValidated<S extends z.ZodTypeAny>(filePath: string, schema: S): z.infer<S> {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    throw new ConfigError(filePath, 'file could not be read')
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (error) {
    // The yaml package's message is a code frame that quotes the offending
    // source line, e.g. a line reading `password: hunter2`. Keeping only the
    // first line (which names the problem and its line/column) means a
    // config syntax error never prints credentials to stdout or into doctor
    // output.
    const firstLine = (error as Error).message.split('\n')[0]
    throw new ConfigError(filePath, `YAML could not be parsed: ${firstLine}`)
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new ConfigError(filePath, detail)
  }
  return deepFreeze(result.data)
}

/** Loads and validates policy. Throws ConfigError rather than returning a partial value. */
export function loadPolicy(filePath: string): Policy {
  return loadValidated(filePath, policySchema)
}

/** Loads and validates runtime configuration. Throws ConfigError rather than returning a partial value. */
export function loadRelayConfig(filePath: string): RelayConfig {
  return loadValidated(filePath, relayConfigSchema)
}

/**
 * Autonomous tasks spend without anyone watching, so they never run
 * unmetered: `autonomous.enabled` with no policy `budget` section is a
 * startup error naming the missing section.
 */
export function assertAutonomousBudget(config: RelayConfig, policy: Policy, policyPath: string): void {
  if (config.autonomous?.enabled && policy.budget === undefined) {
    throw new ConfigError(
      policyPath,
      'autonomous.enabled is true in the relay config, but this policy has no `budget` section; ' +
        'add budget.run_cap_usd, budget.session_cap_usd and budget.principal_day_cap_usd',
    )
  }
}

/**
 * Loads and validates the profile registry, per FR-PRF-1.
 *
 * Throws rather than returning a partial registry, for the same reason the
 * policy loader does: a half-valid registry is worse than none, because a
 * profile that failed validation and was skipped leaves a resolution that
 * finds nothing, which is indistinguishable from a typo and invites the
 * operator to "fix" it by naming a different profile.
 */
/**
 * No profiles configured. Its emptiness is the safe state, not a degraded
 * one: with no profile to resolve, FR-PRF-2 refuses every browser call with
 * a clear reason rather than acting in an unknown browser.
 */
const EMPTY_PROFILE_REGISTRY: ProfileRegistry = { version: 1, profiles: [] }

export function loadProfileRegistry(filePath: string): ProfileRegistry {
  return loadValidated(filePath, profileRegistrySchema)
}

/**
 * Loads the registry if the file exists, or returns an empty one.
 *
 * Absent and invalid are treated very differently on purpose. No file at all
 * means browser profiles are simply not configured yet, and every browser
 * call will be refused by FR-PRF-2's own rule with a clear reason. A file
 * that exists and does not validate is a statement the operator believes and
 * that Relay cannot honour, so it throws.
 */
export function loadProfileRegistryIfPresent(filePath: string): ProfileRegistry {
  if (!existsSync(filePath)) return EMPTY_PROFILE_REGISTRY
  return loadProfileRegistry(filePath)
}

/** The repository registry, FR-CODE-1. Same absent-versus-invalid distinction as the profile registry above, and for the same reason. */
export function loadRepoRegistry(filePath: string): RepoRegistry {
  return loadValidated(filePath, repoRegistrySchema)
}

export function loadRepoRegistryIfPresent(filePath: string): RepoRegistry {
  if (!existsSync(filePath)) return { version: 1, repos: [] }
  return loadRepoRegistry(filePath)
}
