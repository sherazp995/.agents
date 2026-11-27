/**
 * Keeps a running turn's claim renewed, through a database outage of any
 * length (README, "Failover"). A failed or hung renewal says nothing about
 * the claim, and the Claude or Codex worker underneath does not need the
 * database to keep working, so the turn carries on and renewing resumes when
 * the database answers. Only a renewal that answers "not yours" stops it: a
 * Stop, or another laptop's Stop, has fenced the claim.
 *
 * The claim's own expiry passing during an outage does not free the task for
 * the other laptop: a task whose worker is recorded on another laptop is
 * never taken over (src/failover/ownership.ts), and the renewal checks the
 * owner and generation, not the expiry, so it succeeds again on reconnect.
 */

export type ClaimRenewalOptions = {
  /** True while the claim is still ours; rejects when the database could not say. */
  readonly renew: () => Promise<boolean>
  readonly ttlMs: number
  readonly onLost: () => void
  readonly onError?: (error: unknown) => void
}

/** Starts renewing; the returned function stops it. */
export function keepClaimRenewed(options: ClaimRenewalOptions): () => void {
  const { renew, ttlMs, onLost, onError } = options
  const everyMs = Math.max(1000, Math.floor(ttlMs / 3))
  let finished = false
  let inFlight = false

  const stop = (): void => {
    finished = true
    clearInterval(interval)
  }
  /** A renewal that hangs (a dead connection) counts as failed after one interval, so the next one can try. */
  const bounded = (): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`renewing the claim took longer than ${everyMs} ms`)), everyMs)
      timer.unref()
      renew().then(resolve, reject).finally(() => clearTimeout(timer))
    })
  const interval = setInterval(() => {
    if (inFlight) return
    inFlight = true
    void bounded()
      .then(
        (held) => {
          if (finished || held) return
          stop()
          onLost()
        },
        (error: unknown) => {
          if (!finished) onError?.(error)
        },
      )
      .finally(() => {
        inFlight = false
      })
  }, everyMs)
  interval.unref()
  return stop
}
