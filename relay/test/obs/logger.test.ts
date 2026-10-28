import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger, withContext } from '../../src/obs/logger.js'
import { registerSecretValue, resetSecretScrubberForTests } from '../../src/secrets/scrubber.js'

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

describe('logger', () => {
  afterEach(() => {
    resetSecretScrubberForTests()
  })

  it('scrubs a registered secret out of a logged message, per FR-SEC-1', () => {
    const SENTINEL = 'xoxb-PROOF-logger-message-secret'
    registerSecretValue(SENTINEL)
    const { stream, lines } = captureLines()

    createLogger('info', stream).info(`token leaked in this message: ${SENTINEL}`)

    const emitted = lines()
    expect(emitted).toHaveLength(1)
    expect(JSON.stringify(emitted[0])).not.toContain(SENTINEL)
  })

  it('scrubs a registered secret out of a bound/merged object field, per FR-SEC-1', () => {
    const SENTINEL = 'xoxb-PROOF-logger-field-secret'
    registerSecretValue(SENTINEL)
    const { stream, lines } = captureLines()

    createLogger('info', stream).error({ err: SENTINEL, token: SENTINEL }, 'something failed')

    const emitted = lines()
    expect(emitted).toHaveLength(1)
    expect(JSON.stringify(emitted[0])).not.toContain(SENTINEL)
  })

  it('scrubs a registered secret out of a bound child-logger field', () => {
    const SENTINEL = 'xoxb-PROOF-logger-child-secret'
    registerSecretValue(SENTINEL)
    const { stream, lines } = captureLines()

    const child = createLogger('info', stream).child({ token: SENTINEL })
    child.info('doing work')

    const emitted = lines()
    expect(emitted).toHaveLength(1)
    expect(JSON.stringify(emitted[0])).not.toContain(SENTINEL)
  })

  it('emits JSON', () => {
    const { stream, lines } = captureLines()
    createLogger('info', stream).info('hello')
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatchObject({ msg: 'hello' })
  })

  it('binds run, session, step, and principal ids onto every line, per FR-OBS-1', () => {
    const { stream, lines } = captureLines()
    const logger = withContext(createLogger('info', stream), {
      runId: 'run_1',
      sessionId: 'ses_1',
      stepId: 'step_1',
      principalId: 'prn_1',
    })
    logger.info('first')
    logger.info('second')
    // Asserted before inspecting individual lines' bindings, so a silent
    // logger that emits nothing cannot satisfy this test merely because a
    // `for` loop over an empty array runs zero iterations.
    const emitted = lines()
    expect(emitted).toHaveLength(2)
    for (const line of emitted) {
      expect(line).toMatchObject({
        runId: 'run_1',
        sessionId: 'ses_1',
        stepId: 'step_1',
        principalId: 'prn_1',
      })
    }
  })

  it('honours the configured level', () => {
    const { stream, lines } = captureLines()
    createLogger('warn', stream).info('suppressed')
    expect(lines()).toHaveLength(0)
  })
})
