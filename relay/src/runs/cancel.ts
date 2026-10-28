/**
 * FR-ORC-4's Stop instruction, and GT-14, this milestone's headline exit
 * criterion: a Stop halts a run at the next step boundary, and aborts a
 * long-running tool call within five seconds.
 *
 * THE HONEST GUARANTEE, per DEC-1 (docs/decisions/open-questions.md,
 * consequence 1). Because the engine is a subprocess rather than an
 * in-process SDK call, aborting it is TERMINATION, not cooperation. Killing
 * a subprocess is fast enough to meet the five second bound, but a killed
 * engine, or a killed capability, can leave a half-finished side effect with
 * no chance to record it. This module and its tests therefore never claim
 * "stopped cleanly," only "stopped within five seconds," and the run this
 * produces is recorded `cancelled` with whatever progress had already been
 * persisted, never discarded. See CancellationToken.cancel's own comment for
 * what a cancelled run can leave behind.
 *
 * WHAT WAS ALREADY THERE, stated because it matters for what this file adds.
 * src/agent/loop.ts (Task 6) already wires a `cancel?: AbortSignal` through
 * every engine call and every capability invocation's combined AbortSignal,
 * and src/agent/loop.ts's runCapability already races a capability's own
 * promise against that signal, rejecting the instant it aborts even if the
 * capability itself never looks at the signal. That race is the actual
 * cooperative-abort mechanism the five second bound depends on: this module
 * supplies the token that signal comes from, and the registry that lets a
 * Stop arriving by run id find the right in-flight run's token, but it does
 * not change how the loop reacts to the signal once it fires. See this
 * file's task report for the self-attack that proves the race in
 * runCapability, not anything in this file, is what makes the bound real.
 */

/** The bound FR-ORC-4 and GT-14 require: a Stop must take effect within this many milliseconds. */
export const CANCELLATION_BOUND_MS = 5_000

/**
 * One run's cancellation token: an AbortController wearing the run id it
 * belongs to, plus an idempotency guard so a second (or Nth) cancel() is a
 * safe no-op rather than a second reason silently overwriting the first.
 * FR-ORC-4 does not say a Stop can only be sent once, so sending it twice,
 * whether by operator retry or a race between two Stop sources, must never
 * throw or re-abort an already-aborted run.
 */
export class CancellationToken {
  readonly runId: string
  private readonly controller = new AbortController()
  private reason: string | undefined

  constructor(runId: string) {
    this.runId = runId
  }

  /** Wired into AgentLoopParams.cancel, per src/agent/loop.ts. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted
  }

  /** undefined until cancel() has actually run once. */
  get cancellationReason(): string | undefined {
    return this.reason
  }

  /**
   * Fires the abort signal src/agent/loop.ts is racing every engine call
   * and every capability invocation against. Idempotent: once cancelled,
   * later calls are a safe no-op and do not overwrite the recorded reason,
   * so the reason reported is always the FIRST cause of cancellation, not
   * whichever caller happened to call last.
   *
   * WHAT THIS CANNOT PROMISE, stated plainly per DEC-1: firing this signal
   * makes src/agent/loop.ts stop waiting on the current engine call or
   * capability within the five second bound, but it does not undo whatever
   * partial work that call or capability had already done. A capability
   * that had written to an external system, or an engine subprocess that
   * had already produced a partial side effect before being killed, is not
   * rolled back by this call. That is exactly why the run this produces is
   * recorded `cancelled` with partial progress preserved, per
   * src/runs/store.ts's completeStep and finishRun, rather than as though
   * nothing happened.
   */
  cancel(reason = 'stopped by operator'): void {
    if (this.controller.signal.aborted) return
    this.reason = reason
    this.controller.abort(new Error(reason))
  }
}

/**
 * Tracks one CancellationToken per in-flight run, so a Stop arriving by run
 * id (a Slack command, eventually Task 8's orchestrator) can find the right
 * token without the caller holding a direct reference to the in-flight
 * runAgentLoop call itself.
 *
 * A run id with no registered token, because it never started in this
 * process, already finished and was released, or belongs to a different
 * process entirely, cancels as a safe no-op: there is nothing running here
 * to stop, so the correct outcome is that nothing happens, never a thrown
 * error. This is deliberately a best-effort, single-process primitive, not
 * a durable cancellation record; a Stop for a run this process is not
 * currently driving is out of this task's scope, matching how
 * src/agent/loop.ts itself has no cross-process awareness either.
 */
export class CancellationRegistry {
  private readonly tokens = new Map<string, CancellationToken>()

  /** Call once, immediately before starting runAgentLoop for this run. */
  register(runId: string): CancellationToken {
    const token = new CancellationToken(runId)
    this.tokens.set(runId, token)
    return token
  }

  /**
   * Call once the run this token belongs to has reached a terminal state,
   * so a stale token can never be found and re-cancelled once the run it
   * describes is no longer running. Safe to call for a runId that was never
   * registered or was already released.
   */
  release(runId: string): void {
    this.tokens.delete(runId)
  }

  /**
   * Safe no-op if `runId` has no registered token, matching this class's
   * header comment: an already-finished or never-started run has nothing
   * to cancel. Safe no-op if called twice for the same run, since
   * CancellationToken.cancel is itself idempotent.
   */
  cancel(runId: string, reason?: string): void {
    this.tokens.get(runId)?.cancel(reason)
  }

  has(runId: string): boolean {
    return this.tokens.has(runId)
  }

  /**
   * Cancels every currently registered run's token, per gate fix Medium 1:
   * shutdown calls this so a process stopping does not silently abandon
   * every run it was still driving. Safe with zero registered tokens (a
   * no-op) and safe to call more than once, since CancellationToken.cancel
   * is itself idempotent.
   */
  cancelAll(reason?: string): void {
    for (const token of this.tokens.values()) token.cancel(reason)
  }
}
