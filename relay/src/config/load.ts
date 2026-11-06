import { existsSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { z } from 'zod'
import { ConfigError } from './errors.js'
import { type Policy, type RelayConfig, policySchema, relayConfigSchema } from './schema.js'
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
 * The repository registry, FR-CODE-1.
 *
 * Absent and invalid are treated differently on purpose. No file means no
 * repositories are configured yet. A file that exists and does not validate
 * is a statement the operator believes and that Relay cannot honour, so it
 * throws rather than returning a partial registry.
 */
export function loadRepoRegistry(filePath: string): RepoRegistry {
  return loadValidated(filePath, repoRegistrySchema)
}

export function loadRepoRegistryIfPresent(filePath: string): RepoRegistry {
  if (!existsSync(filePath)) return { version: 1, repos: [] }
  return loadRepoRegistry(filePath)
}
