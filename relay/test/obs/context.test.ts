import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/obs/logger.js'
import type { LogContext } from '../../src/obs/logger.js'
import { createRunContext } from '../../src/obs/context.js'

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

const VALID_IDS = {
  runId: 'run_1',
  sessionId: 'ses_1',
  stepId: 'step_1',
  principalId: 'prn_1',
}

describe('createRunContext', () => {
  it('rejects a partial ids object at the type level, and the same call throws at runtime', () => {
    const { stream } = captureLines()
    const logger = createLogger('info', stream)
    expect(() => {
      // @ts-expect-error stepId and principalId are required by RunContext's ids.
      createRunContext(logger, { runId: 'run_1', sessionId: 'ses_1' })
    }).toThrow(/stepId/)
  })

  it('throws at runtime when an id is entirely missing, not merely typed empty', () => {
    const { stream } = captureLines()
    const logger = createLogger('info', stream)
    const incomplete = {
      runId: 'run_1',
      sessionId: 'ses_1',
      stepId: 'step_1',
    } as unknown as Required<LogContext>
    expect(() => createRunContext(logger, incomplete)).toThrow(/principalId/)
  })

  it('throws at runtime when an id is an empty string', () => {
    const { stream } = captureLines()
    const logger = createLogger('info', stream)
    expect(() => createRunContext(logger, { ...VALID_IDS, sessionId: '' })).toThrow(/sessionId/)
  })

  it('throws at runtime when an id is whitespace-only', () => {
    const { stream } = captureLines()
    const logger = createLogger('info', stream)
    expect(() => createRunContext(logger, { ...VALID_IDS, principalId: '   ' })).toThrow(
      /principalId/,
    )
  })

  it('binds all four ids onto every emitted line', () => {
    const { stream, lines } = captureLines()
    const logger = createLogger('info', stream)
    const { log } = createRunContext(logger, VALID_IDS)

    log.info('first')
    log.info('second')

    // Line count asserted before inspecting bindings, per the P0.1 finding
    // 14 correction: a silent logger must not be able to satisfy this test
    // merely because a loop over zero emitted lines runs zero iterations.
    const emitted = lines()
    expect(emitted).toHaveLength(2)
    for (const line of emitted) {
      expect(line).toMatchObject(VALID_IDS)
    }
  })
})
