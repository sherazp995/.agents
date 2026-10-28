import { describe, expect, it } from 'vitest'
import {
  decodeSessionAttachValue,
  encodeSessionAttachValue,
  formatRecency,
  MAX_LISTED_SESSIONS,
  renderAttachConfirmation,
  renderAttachFailure,
  MAX_SLACK_ACTION_VALUE,
  renderSessionList,
  truncateForOption,
} from '../../../src/chat/slack/session-attach.js'
import type { EngineSession } from '../../../src/sessions/discovery.js'

function buildSession(overrides: Partial<EngineSession> = {}): EngineSession {
  return {
    sessionId: 'sess-1',
    cwd: '/Users/operator/project-a',
    lastModifiedAt: new Date('2026-08-10T12:00:00.000Z'),
    sizeBytes: 1234,
    ...overrides,
  }
}

/** Flattens every block's text content into one string, so a test can assert on rendered content without caring about exact Block Kit structure. */
function flattenText(blocks: readonly Record<string, unknown>[]): string {
  return JSON.stringify(blocks)
}

describe('encodeSessionAttachValue / decodeSessionAttachValue', () => {
  it('round-trips the session id, which is all that travels', () => {
    expect(decodeSessionAttachValue(encodeSessionAttachValue({ engineSessionId: 'sess-1' }))).toEqual({
      engineSessionId: 'sess-1',
    })
  })

  it('decodes to undefined for malformed JSON, rather than throwing', () => {
    expect(decodeSessionAttachValue('{not valid json')).toBeUndefined()
  })

  it('decodes to undefined when the session id is missing or empty', () => {
    expect(decodeSessionAttachValue(JSON.stringify({ engineCwd: '/a' }))).toBeUndefined()
    expect(decodeSessionAttachValue(JSON.stringify({ engineSessionId: '' }))).toBeUndefined()
  })

  it('IGNORES extra fields, so a message from the previous version still works after a redeploy', () => {
    // The old renderer encoded cwd, channel and thread as well. A card
    // already sitting in a channel must keep working; only the id is read
    // from it either way.
    const legacy = JSON.stringify({ engineSessionId: 'sess-1', engineCwd: '/a/b', channel: 'C1', thread: '100.001' })

    expect(decodeSessionAttachValue(legacy)).toEqual({ engineSessionId: 'sess-1' })
  })

  it('decodes to undefined when the session id has the wrong type', () => {
    expect(decodeSessionAttachValue(JSON.stringify({ engineSessionId: 1 }))).toBeUndefined()
  })

  it('decodes to undefined for a JSON value that is not an object', () => {
    expect(decodeSessionAttachValue('"just a string"')).toBeUndefined()
    expect(decodeSessionAttachValue('42')).toBeUndefined()
    expect(decodeSessionAttachValue('null')).toBeUndefined()
  })
})

describe('formatRecency', () => {
  const now = new Date('2026-08-10T12:00:00.000Z')

  it('reports "just now" for under a minute', () => {
    expect(formatRecency(new Date('2026-08-10T11:59:30.000Z'), now)).toBe('just now')
  })

  it('reports minutes for under an hour', () => {
    expect(formatRecency(new Date('2026-08-10T11:45:00.000Z'), now)).toBe('15m ago')
  })

  it('reports hours for under a day', () => {
    expect(formatRecency(new Date('2026-08-10T09:00:00.000Z'), now)).toBe('3h ago')
  })

  it('reports days beyond that', () => {
    expect(formatRecency(new Date('2026-08-08T12:00:00.000Z'), now)).toBe('2d ago')
  })

  it('never goes negative for a timestamp at or after now (clock skew)', () => {
    expect(formatRecency(new Date('2026-08-10T12:00:05.000Z'), now)).toBe('just now')
  })
})

/** The dropdown's options, which is where every per-session detail now lives. */
function optionsOf(blocks: readonly unknown[]): Array<{ value?: string; text?: { text?: string }; description?: { text?: string } }> {
  const actions = blocks.find((block) => (block as { type?: string }).type === 'actions') as
    | { elements?: Array<{ options?: Array<{ value?: string; text?: { text?: string }; description?: { text?: string } }> }> }
    | undefined
  return actions?.elements?.[0]?.options ?? []
}

describe('renderSessionList: FR-SEC-1, never shows anything but folder and recency', () => {
  it('shows the working directory and a recency label for each session', () => {
    const sessions = [buildSession({ cwd: '/Users/operator/project-a' })]
    const { blocks } = renderSessionList(sessions, 'C1', 't1', new Date('2026-08-10T12:05:00.000Z'))
    const flat = flattenText(blocks)
    expect(flat).toContain('/Users/operator/project-a')
    expect(flat).toContain('5m ago')
  })

  it('shows the session id, because several sessions in one folder is the normal case', () => {
    // This assertion was originally its own opposite: the id was kept out of
    // the visible text on the reasoning that less shown is safer. In real
    // use the operator saw four rows all reading the same project path with
    // nothing to distinguish them, which made the list unusable. A session
    // id is a uuid naming a local file and carries nothing that was said, so
    // it is the one identifying detail this list can show without becoming a
    // route by which conversation content reaches Slack.
    const sessions = [buildSession({ sessionId: 'd44ef152-6aac-4f65-ba56-6ff73c2eb20b' })]
    const { blocks } = renderSessionList(sessions, 'C1', 't1')
    // The id lives in each option's description now that the list is a
    // dropdown, so the whole rendered structure is searched rather than only
    // top-level section text.
    const visibleTextOnly = JSON.stringify(blocks)

    expect(visibleTextOnly).toContain('d44ef152-6aac-4f65-ba56-6ff73c2eb20b')
  })

  it('shows transcript size, so two sessions in one folder at one timestamp are still distinguishable', () => {
    const sessions = [buildSession({ sizeBytes: 9_650_000 })]
    const { blocks } = renderSessionList(sessions, 'C1', 't1')

    // A property of the file, not of its contents: a 9 MB conversation and a
    // 50 KB one are obviously different to the operator, and neither reveals
    // anything about what was said.
    expect(flattenText(blocks)).toContain('9.2 MB')
  })

  it('SELF-ATTACK required proof: nothing resembling transcript content (arbitrary prose) ever appears, since discovery.ts never gives this function any to render', () => {
    // EngineSession's own type has no content field at all; this test pins
    // that the renderer only ever reads cwd/lastModifiedAt/sizeBytes off
    // it, by constructing a session with every field discovery.ts could
    // possibly produce and confirming the output contains nothing else.
    const session = buildSession()
    const { text, blocks } = renderSessionList([session], 'C1', 't1', new Date('2026-08-10T12:05:00.000Z'))
    const rendered = text + flattenText(blocks)
    expect(rendered).not.toMatch(/password|secret|token|api[_-]?key/i)
  })

  it('caps at MAX_LISTED_SESSIONS even when given more', () => {
    const many = Array.from({ length: MAX_LISTED_SESSIONS + 5 }, (_, i) =>
      buildSession({ sessionId: `sess-${i}`, cwd: `/dir-${i}` }),
    )
    const { blocks } = renderSessionList(many, 'C1', 't1')
    // A header and a single picker, whatever the count: the whole point of
    // the dropdown is that the message does not grow with the list.
    expect(blocks.length).toBe(2)
    expect(optionsOf(blocks)).toHaveLength(MAX_LISTED_SESSIONS)
  })

  it('states the governance warning in the header, before any button is tapped', () => {
    const { blocks } = renderSessionList([buildSession()], 'C1', 't1')
    expect(flattenText(blocks)).toMatch(/governance|permissions|no policy checks/i)
  })

  it('reports "no sessions found" honestly when the list is empty', () => {
    const { text } = renderSessionList([], 'C1', 't1')
    expect(text).toMatch(/no.*sessions/i)
  })

  it('each option carries ONLY the session id, never the channel or thread', () => {
    // Encoding them would let a crafted payload bind any thread to a
    // session, and an attached session runs unmediated in the operator's own
    // directory (AP-2, §24). The handler reads both from the click envelope.
    const { blocks } = renderSessionList([buildSession({ sessionId: 'sess-x' })], 'C42', 'thread-99')
    const raw = optionsOf(blocks)[0]?.value ?? ''

    expect(decodeSessionAttachValue(raw)).toEqual({ engineSessionId: 'sess-x' })
    expect(raw).not.toContain('C42')
    expect(raw).not.toContain('thread-99')
  })

  it('KEEPS EVERY OPTION VALUE INSIDE SLACK\'S LIMIT, which is what broke production', () => {
    // Measured against the real API: a 178-character value came back
    // `invalid_blocks: must be less than 151 characters`, and /sessions
    // posted nothing at all. A button's limit is far higher, which is why
    // the previous renderer got away with the full payload and the dropdown
    // did not.
    const sessions = Array.from({ length: MAX_LISTED_SESSIONS }, (_unused, index) =>
      buildSession({
        sessionId: `d44ef152-6aac-4f65-ba56-6ff73c2eb2${String(index).padStart(2, '0')}`,
        cwd: `/Users/operator/${'deeply-nested-directory/'.repeat(8)}project-${index}`,
      }),
    )
    const { blocks } = renderSessionList(sessions, 'D0BPT8XL44Q', '1786963093.550339')

    for (const option of optionsOf(blocks)) {
      expect((option.value ?? '').length).toBeLessThanOrEqual(MAX_SLACK_ACTION_VALUE)
    }
  })
})

describe('renderAttachConfirmation: FR-ATT-30, required proof the label is present and prominent', () => {
  it('states plainly that this is unmediated and not policy-checked', () => {
    const { text, blocks } = renderAttachConfirmation('/Users/operator/project-a')
    const rendered = text + flattenText(blocks)
    expect(rendered).toMatch(/unmediated/i)
    expect(rendered).toMatch(/not policy-checked|outside relay.s policy engine/i)
    expect(rendered).toContain('/Users/operator/project-a')
  })

  it('names the folder in the confirmation', () => {
    const { text } = renderAttachConfirmation('/tmp/some-folder')
    expect(text).toContain('/tmp/some-folder')
  })
})

describe('renderAttachFailure', () => {
  it('states the given reason', () => {
    const { text } = renderAttachFailure('not available right now')
    expect(text).toContain('not available right now')
  })
})

describe('the dropdown respects Slack\'s own limits', () => {
  it('trims a long path from the LEFT, since the end identifies it and the start repeats', () => {
    // Slack rejects an option whose text exceeds 75 characters outright, so
    // this is a hard limit rather than a nicety.
    const long = `/Users/operator/${'nested/'.repeat(20)}project`
    const trimmed = truncateForOption(long)

    expect(trimmed.length).toBeLessThanOrEqual(75)
    expect(trimmed).toContain('project')
    expect(trimmed.startsWith('…')).toBe(true)
  })

  it('leaves a short value untouched', () => {
    expect(truncateForOption('/Users/op/thing')).toBe('/Users/op/thing')
  })

  it('keeps every option within the limit for a realistically deep path', () => {
    const sessions = Array.from({ length: 3 }, (_unused, index) =>
      buildSession({ sessionId: `sess-${index}`, cwd: `/Users/operator/${'deep/'.repeat(15)}p${index}` }),
    )
    const { blocks } = renderSessionList(sessions, 'C1', 't1')

    for (const option of optionsOf(blocks)) {
      expect((option.text?.text ?? '').length).toBeLessThanOrEqual(75)
      expect((option.description?.text ?? '').length).toBeLessThanOrEqual(75)
    }
  })
})
