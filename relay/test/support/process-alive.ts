/**
 * Shared by test/support/global-setup.ts (which cannot import "vitest"
 * itself, see database-naming.ts's file comment for why) and its regression
 * test, so the staleness check gets direct, not indirect, test coverage.
 *
 * process.kill(pid, 0) sends no signal; it only asks the kernel whether pid
 * exists and is reachable. Two distinct failures collapse into "it threw"
 * if not told apart:
 *
 *   - ESRCH: no such process. That is the only condition that proves the
 *     process is actually dead.
 *   - EPERM: the process exists but is owned by another user, so this user
 *     is not permitted to signal it. That is proof of life, not death.
 *
 * Any other error is not proof of death either. Staleness detection feeds
 * `DROP DATABASE ... WITH (FORCE)`, so the failure mode has to be biased
 * toward leaving a live database alone: a lingering database costs disk, a
 * wrongly dropped one corrupts a concurrent run mid-suite. So every
 * outcome other than a confirmed ESRCH is treated as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isEsrch(error)
  }
}

function isEsrch(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  )
}
