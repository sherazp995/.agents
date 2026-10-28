import { Writable } from 'node:stream'
import { pino, type Logger } from 'pino'
import type { RelayConfig } from '../config/schema.js'
import { scrubSecrets } from '../secrets/scrubber.js'

export type { Logger }

/**
 * Identifiers bound onto every log line so any run can be reconstructed by
 * grepping one id, per FR-OBS-1.
 */
export type LogContext = {
  runId?: string
  sessionId?: string
  stepId?: string
  principalId?: string
}

/**
 * Wraps `destination` so every chunk pino writes reaches scrubSecrets
 * (src/secrets/scrubber.js) before the real destination ever sees it, per
 * FR-SEC-1. This is the boundary chosen deliberately over pino's own
 * `formatters`/`hooks` options: `formatters.log` only sees the merged
 * object, never the message string, and covering both would need a second
 * mechanism (`hooks.logMethod`) layered on top. Scrubbing the final,
 * already-serialized JSON line covers both in one place, because pino
 * folds the message, every bound (child logger) field, and every merged
 * object field into that one line before it ever calls write(). Tested in
 * test/obs/logger.test.ts against both a logged message and a logged
 * object field.
 *
 * What this does NOT cover, and is not claimed to: a secret whose
 * characters are split across two separate write() calls (one chunk ends
 * mid secret, the next continues it). Pino's own writer emits one complete
 * JSON line per write() call, so that has not been observed in practice,
 * but that is this destination's behaviour, not a guarantee this function
 * can make about every possible NodeJS.WritableStream a caller might pass
 * in.
 */
function scrubbingDestination(destination: NodeJS.WritableStream): NodeJS.WritableStream {
  return new Writable({
    write(chunk: unknown, _encoding, callback) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      // Fired without waiting for `destination`'s own write to complete,
      // matching how pino itself writes (a bare `stream.write(s)`, no
      // callback, see pino/lib/proto.js). Chaining through destination's
      // completion callback instead defers it to a process.nextTick, which
      // makes this wrapper's own write appear to still be "in progress" to
      // Node's stream internals; a second log call issued synchronously
      // right after the first would then queue behind it and not actually
      // reach `destination` until the next tick, silently breaking every
      // test in this codebase that logs synchronously and reads a capture
      // stream immediately after (there are many). Calling `callback()`
      // synchronously here keeps this wrapper exactly as synchronous as
      // writing directly to `destination` always was.
      destination.write(scrubSecrets(text))
      callback()
    },
  })
}

/**
 * Creates the root logger. The destination is injectable so tests can capture
 * output without touching the filesystem or stdout.
 */
export function createLogger(
  level: RelayConfig['logging']['level'],
  destination: NodeJS.WritableStream = process.stdout,
): Logger {
  return pino({ level, base: null }, scrubbingDestination(destination))
}

/** Returns a child logger carrying the given identifiers on every line. */
export function withContext(logger: Logger, context: LogContext): Logger {
  const bindings: Record<string, string> = {}
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) bindings[key] = value
  }
  return logger.child(bindings)
}
