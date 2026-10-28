import { chmodSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createStream } from 'rotating-file-stream'

/**
 * Rotation and retention knobs for `createRotatingLogDestination`, per
 * FR-OBS-1 ("rotated and size-capped"). All three have defaults, so a
 * caller only needs to override what its deployment actually needs.
 */
export type RotationOptions = {
  /** Bytes at which the active file is rotated. Default 20 MiB. */
  maxSizeBytes?: number
  /** Rotated files retained before the oldest is deleted. Default 5. */
  maxFiles?: number
  /**
   * Permission bits enforced on the active file, every rotated file, and
   * the rotation history file. Default 0o600 (owner read/write only, no
   * group or world access), so a rotated file is never more readable than
   * the live one FR-SEC-1's secret scrubber already protects.
   */
  mode?: number
}

const DEFAULT_MAX_SIZE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_FILES = 5
const DEFAULT_MODE = 0o600

/**
 * Builds a size-capped, count-capped rotating file destination for
 * `createLogger` (src/obs/logger.ts), closing the rotation half of
 * FR-OBS-1 that P0.1 left for the daemon's operational setup.
 *
 * Backed by `rotating-file-stream` rather than a hand-rolled rotator or
 * pino's worker-thread transports (`pino-roll`): it is a plain in-process
 * `Writable`, has zero dependencies of its own, and drops straight into the
 * `destination` parameter `createLogger` already accepts, so rotation is
 * testable synchronously and `logger.ts`'s documented
 * `scrubbingDestination` wrapping boundary (every chunk reaches
 * `scrubSecrets` before any destination sees it) needs no change to keep
 * covering it: this stream is just another `NodeJS.WritableStream` beneath
 * that wrapper. Confirmed empirically (see test/obs/rotation.test.ts) that
 * a single `stream.write()` call is never split across the old and new
 * file, and that Node's own `Writable` buffering means writes issued while
 * a rotation is in flight are queued rather than dropped, not merely
 * assumed from the library's docs.
 *
 * Permission handling is defensive rather than trusting the library's
 * `mode` option, because two paths were confirmed (same test file) to
 * leave a file more open than intended despite `mode` being passed:
 *  - A live file that already existed before this stream opened it (for
 *    example, one predating this feature, or created by another process
 *    under a looser umask) is opened for append, not recreated, so `mode`
 *    never applies to it.
 *  - The rotation history file `rotating-file-stream` writes once
 *    `maxFiles` is set is always created with its own hard-coded default
 *    mode, ignoring the `mode` option entirely.
 * Both are corrected with an explicit `chmodSync` after every event that
 * could have (re)created the file, rather than assumed from the option.
 */
export function createRotatingLogDestination(
  filePath: string,
  options: RotationOptions = {},
): NodeJS.WritableStream {
  const mode = options.mode ?? DEFAULT_MODE
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES
  const dir = dirname(filePath)
  const historyFileName = `${basename(filePath)}.history`
  const historyPath = join(dir, historyFileName)

  const stream = createStream(basename(filePath), {
    path: dir,
    size: `${maxSizeBytes}B`,
    maxFiles,
    history: historyFileName,
    mode,
  })

  // Best-effort: if the file was already removed by the time this runs
  // (for instance a rotated file that lost a race with its own maxFiles
  // cleanup), there is nothing left to restrict permissions on.
  const enforceMode = (target: string): void => {
    try {
      chmodSync(target, mode)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  stream.on('open', enforceMode)
  stream.on('rotated', enforceMode)
  stream.on('history', () => enforceMode(historyPath))

  return stream
}
