import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MOCK_CAPABILITIES, MockAdapter } from '../../src/chat/mock.js'
import { ProgressReporter, summarizeForLimit } from '../../src/chat/progress.js'
import { createLogger } from '../../src/obs/logger.js'
import type { ChatAction } from '../../src/chat/contract.js'

const REF = { channel: 'C1' }

function postedActions(actions: readonly ChatAction[]): ChatAction[] {
  return actions.filter((action) => action.kind === 'post')
}

function editedActions(actions: readonly ChatAction[]): ChatAction[] {
  return actions.filter((action) => action.kind === 'edit')
}

function captureLines(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  return {
    stream,
    lines: () => chunks.join('').split('\n').filter((line) => line.trim().length > 0),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ProgressReporter', () => {
  it('posts once on the first update and owns exactly one message across many updates', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000 })

    await reporter.update('step 1')
    for (let i = 2; i <= 30; i += 1) {
      await reporter.update(`step ${i}`)
    }
    await reporter.finish('done')

    expect(postedActions(adapter.performed)).toHaveLength(1)
  })

  it('coalesces thirty rapid updates into one post and a bounded number of edits', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000 })

    for (let i = 1; i <= 30; i += 1) {
      await reporter.update(`step ${i}`)
    }
    // Let any single coalesced trailing edit fire.
    await vi.advanceTimersByTimeAsync(1000)

    expect(postedActions(adapter.performed)).toHaveLength(1)
    // Thirty calls inside one cooldown window must not become thirty edits;
    // at most the one coalesced trailing edit is allowed to have fired.
    expect(editedActions(adapter.performed).length).toBeLessThanOrEqual(1)
  })

  it('produces edits across multiple cooldown windows without exceeding one edit per window', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000 })

    await reporter.update('window 0 a') // immediate post
    for (let i = 0; i < 3; i += 1) {
      await reporter.update(`window ${i} mid`)
      await reporter.update(`window ${i} final`)
      await vi.advanceTimersByTimeAsync(1000)
    }

    expect(postedActions(adapter.performed)).toHaveLength(1)
    // Three cooldown windows after the initial post: at most three edits,
    // each carrying the latest text from its window, never one per update().
    expect(editedActions(adapter.performed).length).toBeLessThanOrEqual(3)
    const lastEdit = editedActions(adapter.performed).at(-1)
    expect(lastEdit).toMatchObject({ text: 'window 2 final' })
  })

  it('finish lands immediately even when called right inside the throttle window', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 5000 })

    await reporter.update('in progress') // immediate post, starts the cooldown
    await reporter.update('still in progress') // inside the cooldown: only scheduled
    await reporter.finish('complete') // must preempt the cooldown, not wait for it

    const performed = adapter.performed
    expect(postedActions(performed)).toHaveLength(1)
    const lastEdit = editedActions(performed).at(-1)
    expect(lastEdit).toMatchObject({ text: 'complete' })

    // The cooldown timer that "still in progress" scheduled must not be
    // able to overwrite finish's result later.
    await vi.advanceTimersByTimeAsync(5000)
    const finalEdit = editedActions(adapter.performed).at(-1)
    expect(finalEdit).toMatchObject({ text: 'complete' })
  })

  it('finish posts the one message itself when called before any update', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000 })

    await reporter.finish('final only')

    expect(postedActions(adapter.performed)).toHaveLength(1)
    expect(postedActions(adapter.performed)[0]).toMatchObject({ text: 'final only' })
    expect(editedActions(adapter.performed)).toHaveLength(0)
  })

  it('calling update after finish is a no-op: the message stays in its finished state', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000 })

    await reporter.update('working')
    await reporter.finish('done')
    await reporter.update('too late')
    await vi.advanceTimersByTimeAsync(5000)

    const lastAction = adapter.performed.at(-1)
    expect(lastAction).toMatchObject({ text: 'done' })
  })

  it('summarizes text over maxMessageBytes with a link placeholder instead of truncating silently', async () => {
    const adapter = new MockAdapter({ ...DEFAULT_MOCK_CAPABILITIES, maxMessageBytes: 200 })
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000 })

    const longText = 'x'.repeat(5000)
    await reporter.update(longText)

    const posted = postedActions(adapter.performed)[0]
    expect(posted).toBeDefined()
    const text = (posted as { text: string }).text
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(200)
    // Not a silent truncation: the rendered text names the real size and
    // carries a placeholder rather than being a bare prefix of longText.
    expect(text).toContain('5000 bytes')
    expect(text).toContain('link placeholder')
    expect(text.startsWith('xxxx')).toBe(false)
  })

  it('measures the byte limit, not the character count, on multi-byte text', async () => {
    const adapter = new MockAdapter({ ...DEFAULT_MOCK_CAPABILITIES, maxMessageBytes: 4000 })
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000 })

    // Each euro sign is 3 UTF-8 bytes but 1 character; 1500 of them is 1500
    // characters (under a naive character-count limit of 4000) but 4500
    // bytes, which does exceed the real byte limit.
    const text = '€'.repeat(1500)
    expect(text.length).toBeLessThan(4000)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(4000)

    await reporter.update(text)

    const posted = postedActions(adapter.performed)[0] as { text: string }
    expect(Buffer.byteLength(posted.text, 'utf8')).toBeLessThanOrEqual(4000)
    expect(posted.text).toContain('link placeholder')
  })
})

describe('ProgressReporter trailing edit failures', () => {
  it('reports a rejecting trailing edit through onTrailingSendError instead of producing an unhandled rejection', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const trailingErrors: unknown[] = []
    const reporter = new ProgressReporter(adapter, REF, {
      minIntervalMs: 1000,
      onTrailingSendError: (error) => trailingErrors.push(error),
    })

    await reporter.update('in progress') // immediate post, starts the cooldown
    adapter.failNextPerform(new Error('trailing-edit-boom'))
    await reporter.update('still in progress') // inside the cooldown: only scheduled

    // Fires the scheduled trailing send's setTimeout callback. Before the
    // fix this called `void this.#dispatch(text)`, discarding the
    // rejection; if that regressed, this call is where an unhandled
    // rejection would surface.
    await vi.advanceTimersByTimeAsync(1000)

    expect(trailingErrors).toHaveLength(1)
    expect((trailingErrors[0] as Error).message).toBe('trailing-edit-boom')
  })

  it('still logs a rejecting trailing edit even without an onTrailingSendError callback', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const { stream, lines } = captureLines()
    const log = createLogger('info', stream)
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000, log })

    await reporter.update('in progress')
    adapter.failNextPerform(new Error('trailing-edit-boom-2'))
    await reporter.update('still in progress')

    await vi.advanceTimersByTimeAsync(1000)

    expect(lines().some((line) => line.includes('trailing edit failed'))).toBe(true)
  })
})

describe('ProgressReporter without edit capability', () => {
  it('degrades to posting a fresh message each send instead of failing, when the adapter declares editMessage: false', async () => {
    const adapter = new MockAdapter({ ...DEFAULT_MOCK_CAPABILITIES, editMessage: false })
    await adapter.start(async () => {})
    const reporter = new ProgressReporter(adapter, REF, { minIntervalMs: 1000 })

    await reporter.update('window 0')
    await vi.advanceTimersByTimeAsync(1000)
    await reporter.update('window 1')
    await reporter.finish('done')

    // Never an edit: an adapter that honestly declares it cannot edit must
    // never be asked to.
    expect(editedActions(adapter.performed)).toHaveLength(0)
    // Every send became its own post instead, all landing in the same ref.
    const posts = postedActions(adapter.performed)
    expect(posts.length).toBeGreaterThanOrEqual(2)
    for (const post of posts) {
      expect(post).toMatchObject({ ref: REF })
    }
  })
})

describe('summarizeForLimit', () => {
  it('returns text unchanged when it is within the limit', () => {
    expect(summarizeForLimit('hello', 100)).toBe('hello')
  })

  it('never returns a string whose UTF-8 byte length exceeds the limit, even at pathologically small limits', () => {
    const text = 'a'.repeat(50) + '€'.repeat(50)
    for (const limit of [0, 1, 2, 3, 4, 10, 30]) {
      const result = summarizeForLimit(text, limit)
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(limit)
    }
  })
})
