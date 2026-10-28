/**
 * The session boundary where a bound RunContext belongs, per PRE-5
 * (docs/decisions/open-questions.md): real Slack call sites used an
 * unbound root logger and src/obs/context.ts's createRunContext had no
 * production caller, so FR-OBS-1's requirement that run, session, step,
 * and principal ids ride on every line was still a library-only
 * assertion. A session is exactly the object that already carries three
 * of those four ids (its own id as sessionId, and principalId), so this
 * is a thin adapter from a Session onto createRunContext, not a
 * reimplementation of it.
 */

import { createRunContext } from '../obs/context.js'
import type { RunContext } from '../obs/context.js'
import type { Logger } from '../obs/logger.js'
import type { Run } from '../runs/store.js'
import type { Session } from './store.js'

/**
 * Builds the bound RunContext for one step of one run within `session`.
 * `stepId` is supplied by the caller because a run accumulates many steps
 * over its own lifetime, so it cannot be derived from either the session or
 * the run alone.
 *
 * Gate fix, High 5: `principalId` is read from `run`, never from
 * `session.principalId`. A session's `principalId` is fixed at creation to
 * whichever principal opened it (0004_sessions.sql's own comment: "it is
 * not reassigned on later finds"), but FR-OBS-1 requires every log line to
 * name the principal who actually drove THIS run, and a second, different,
 * mapped principal replying in the same thread starts a run carrying their
 * own principal id (src/orchestrator.ts's createRun call already uses
 * `event.principalId`, the current event's sender), not the session
 * opener's. Before this fix, every line this run's own logger emitted
 * still named whoever opened the session, so an operator reading the log
 * would see the wrong person credited or blamed for a run someone else
 * actually triggered. `run` only needs `id` and `principalId`, so the
 * parameter is typed as a `Pick` rather than the full `Run` shape, keeping
 * this module's coupling to src/runs/store.ts minimal.
 */
export function sessionRunContext(
  logger: Logger,
  session: Session,
  run: Pick<Run, 'id' | 'principalId'>,
  stepId: string,
): RunContext {
  return createRunContext(logger, {
    runId: run.id,
    sessionId: session.id,
    stepId,
    principalId: run.principalId,
  })
}
