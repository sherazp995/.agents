import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/obs/logger.js'
import { sessionRunContext } from '../../src/sessions/context.js'
import type { Session } from '../../src/sessions/store.js'

function captureLines(): { stream: Writable; lines: () => unknown[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown),
  }
}

const SESSION: Session = {
  id: 'ses_1',
  workspaceId: 'wrk_1',
  principalId: 'prn_1',
  adapter: 'slack',
  threadRef: 'slack:C1:1700000000.000100',
  state: 'active',
  createdAt: '2026-08-09T00:00:00.000Z',
  lastActiveAt: '2026-08-09T00:00:00.000Z',
  engineSessionId: null,
  engineCwd: null,
  mode: 'governed',
  courierTarget: null,
}

/** The run this session's own principal (the session opener) also drove, for the tests that are not about High 5's fix. */
const RUN_1 = { id: 'run_1', principalId: SESSION.principalId }
const RUN_2 = { id: 'run_2', principalId: SESSION.principalId }

describe('sessionRunContext', () => {
  it('binds all four identifiers, runId, sessionId, stepId, and principalId, onto every emitted line', () => {
    const { stream, lines } = captureLines()
    const logger = createLogger('info', stream)
    const { log } = sessionRunContext(logger, SESSION, RUN_1, 'step_1')

    log.info('first')
    log.info('second')

    // Line count asserted before inspecting bindings, per the P0.1 finding
    // this project keeps re-learning: a silent logger must not be able to
    // satisfy this test merely because a loop over zero emitted lines runs
    // zero iterations.
    const emitted = lines()
    expect(emitted).toHaveLength(2)
    for (const line of emitted) {
      expect(line).toMatchObject({
        runId: RUN_1.id,
        sessionId: SESSION.id,
        stepId: 'step_1',
        principalId: RUN_1.principalId,
      })
    }
  })

  it('the returned RunContext carries the same four ids in its own .ids, not only on the logger', () => {
    const { stream } = captureLines()
    const logger = createLogger('info', stream)
    const { ids } = sessionRunContext(logger, SESSION, RUN_2, 'step_2')

    expect(ids).toEqual({
      runId: RUN_2.id,
      sessionId: SESSION.id,
      stepId: 'step_2',
      principalId: RUN_2.principalId,
    })
  })

  it('two different sessions produce two RunContexts bound to two different sessionIds', () => {
    const { stream, lines } = captureLines()
    const logger = createLogger('info', stream)
    const otherSession: Session = { ...SESSION, id: 'ses_2', principalId: 'prn_2' }

    sessionRunContext(logger, SESSION, RUN_1, 'step_1').log.info('from session one')
    sessionRunContext(logger, otherSession, { id: 'run_1', principalId: 'prn_2' }, 'step_1').log.info(
      'from session two',
    )

    const emitted = lines()
    expect(emitted).toHaveLength(2)
    expect(emitted[0]).toMatchObject({ sessionId: 'ses_1', principalId: 'prn_1' })
    expect(emitted[1]).toMatchObject({ sessionId: 'ses_2', principalId: 'prn_2' })
  })

  // ---------------------------------------------------------------------
  // Gate fix, High 5: replies from a second principal must be attributed
  // to the run's own principal, never silently re-attributed to whoever
  // opened the session.
  // ---------------------------------------------------------------------

  it(
    "binds principalId from the RUN, not the session opener: a second principal replying in an " +
      'existing thread is attributed to themselves, not to whoever opened the session',
    () => {
      const { stream, lines } = captureLines()
      const logger = createLogger('info', stream)
      // SESSION was opened by 'prn_1'; this run belongs to a second,
      // different, mapped principal replying in the same thread.
      const secondPrincipalRun = { id: 'run_second_principal', principalId: 'prn_2' }

      const { log, ids } = sessionRunContext(logger, SESSION, secondPrincipalRun, 'step_1')
      log.info('reply from the second principal')

      expect(ids.principalId).toBe('prn_2')
      expect(ids.sessionId).toBe(SESSION.id)

      const emitted = lines()
      expect(emitted).toHaveLength(1)
      expect(emitted[0]).toMatchObject({ principalId: 'prn_2', sessionId: SESSION.id })
      // Never the session opener's id: the P0.3 gate finding this test
      // pins the fix for is exactly a log line that named the wrong
      // person.
      const emittedLine = emitted[0] as { principalId?: string }
      expect(emittedLine.principalId).not.toBe(SESSION.principalId)
    },
  )
})
