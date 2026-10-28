import { withContext } from './logger.js'
import type { Logger, LogContext } from './logger.js'

/**
 * Everything a single run of Relay needs to log traceably, per FR-OBS-1: the
 * four identifiers that were bound onto the logger, and the logger itself.
 * Bundled together so a caller cannot hold a logger without also holding the
 * ids it carries.
 */
export type RunContext = {
  readonly ids: Required<LogContext>
  readonly log: Logger
}

/**
 * For modules that log through an already-contextualized logger but are not
 * themselves where a run begins, such as the migration runner and the Redis
 * probe. They accept whatever ids the caller already bound rather than
 * binding their own, so this is a thinner contract than RunContext.
 */
export type MaybeLogger = { log?: Logger }

const REQUIRED_ID_KEYS = ['runId', 'sessionId', 'stepId', 'principalId'] as const

/**
 * Builds a RunContext, binding all four identifiers onto the returned
 * logger. This is the one place run-scoped logging actually starts, so
 * unlike `withContext`, which accepts a partial LogContext for ad hoc child
 * loggers, every id here is mandatory: closes the P0.1 finding that an
 * unbound root logger could emit a line carrying none of them. An id that is
 * present but empty or whitespace-only is rejected too, at runtime, because
 * such an id is as untraceable as a missing one and the type system alone
 * cannot catch it.
 */
export function createRunContext(logger: Logger, ids: Required<LogContext>): RunContext {
  for (const key of REQUIRED_ID_KEYS) {
    const value = ids[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`createRunContext requires a non-empty ${key}`)
    }
  }
  return { ids, log: withContext(logger, ids) }
}
