/**
 * Keeps a running turn's claim renewed through a database blip. A failed
 * renewal says nothing about the claim, so the turn carries on until the claim
 * is confirmed lost or its lifetime has passed by this laptop's clock. The
 * deadline is its own timer because a hung renewal never settles.
 */

export type ClaimRenewalOptions = {
  /** True while the claim is still ours; rejects when the database could not say. */
  readonly renew: () => Promise<boolean>
  readonly ttlMs: number
  /** Read before the claim was taken, so the local deadline ends before the database's. */
  readonly claimedAt: number
  readonly onLost: () => void
  readonly onError?: (error: unknown) => void
}

/** Starts renewing; the returned function stops it. */
export function keepClaimRenewed(options: ClaimRenewalOptions): () => void {
  const { renew, ttlMs, claimedAt, onLost, onError } = options
  let confirmedAt = claimedAt
  let finished = false
  let deadline: NodeJS.Timeout | undefined

  const stop = (): void => {
    finished = true
    clearInterval(interval)
    clearTimeout(deadline)
  }
  const lose = (): void => {
    if (finished) return
    stop()
    onLost()
  }
  const armDeadline = (): void => {
    clearTimeout(deadline)
    deadline = setTimeout(lose, Math.max(0, confirmedAt + ttlMs - Date.now()))
    deadline.unref()
  }
  const interval = setInterval(() => {
    const startedAt = Date.now()
    void renew().then(
      (held) => {
        if (finished) return
        if (!held) {
          lose()
          return
        }
        confirmedAt = Math.max(confirmedAt, startedAt)
        armDeadline()
      },
      (error: unknown) => {
        if (!finished) onError?.(error)
      },
    )
  }, Math.max(1000, Math.floor(ttlMs / 3)))
  interval.unref()
  armDeadline()
  return stop
}
