/**
 * Waiting out a database this laptop cannot reach (README, "Failover"). A
 * turn that finished while the network was down still has its reply and its
 * bookkeeping to write; those writes wait and retry here until the database
 * answers, so the work is not lost. Only errors that mean "could not reach
 * the database" are retried: any other error is a real failure and is thrown.
 */

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'])
/** Postgres says the server is going away or not accepting connections yet. */
const SERVER_GONE_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08001', '08003', '08006'])

/** True when `error` means the database could not be reached, rather than that it refused the statement. */
export function isConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && (NETWORK_CODES.has(code) || SERVER_GONE_CODES.has(code))) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /Connection terminated|connection timeout|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(message)
}

export type OfflineRetryOptions = {
  /** Stops waiting (and rethrows) once true: the daemon is stopping, or the claim this write belongs to is confirmed lost. */
  readonly giveUp: () => boolean
  readonly onWait?: (error: unknown) => void
  readonly retryMs?: number
  /** Injected by tests. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Runs `write`, and while it fails only because the database is unreachable, waits and runs it again. */
export async function untilDatabaseAnswers<T>(write: () => Promise<T>, options: OfflineRetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (;;) {
    try {
      return await write()
    } catch (error) {
      if (!isConnectionError(error) || options.giveUp()) throw error
      options.onWait?.(error)
      await sleep(options.retryMs ?? 5_000)
    }
  }
}
