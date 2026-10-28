import { describe, expect, it } from 'vitest'
import { buildTurnPrompt } from '../../src/autonomous/prompt.js'
import { renderThreadHistory } from '../../src/autonomous/thread-history.js'

const messages = [
  { ts: '100.1', text: 'Relay test: notify works.', bot: true },
  { ts: '100.2', text: 'Yes it works', user: 'U1', bot: false },
  { ts: '100.3', text: '<@BOT> what did I say?', user: 'U1', bot: false },
]

describe('renderThreadHistory', () => {
  it('lists the messages before the first new one, marking relay as the worker', () => {
    expect(renderThreadHistory(messages, '100.3')).toBe('- relay (you): Relay test: notify works.\n- U1: Yes it works')
  })

  it('returns null when nothing came before', () => {
    expect(renderThreadHistory(messages, '100.1')).toBeNull()
  })

  it('drops the oldest messages first when the thread is long', () => {
    const long = Array.from({ length: 80 }, (_, index) => ({ ts: `${200 + index}.0`, text: `m${index}`, user: 'U1', bot: false }))
    const rendered = renderThreadHistory(long, null) ?? ''
    expect(rendered.split('\n')).toHaveLength(50)
    expect(rendered.endsWith('m79')).toBe(true)
  })
})

describe('buildTurnPrompt with thread history', () => {
  it('puts the earlier thread before the new messages, as untrusted data', () => {
    const prompt = buildTurnPrompt({ pendingEvents: [], files: [], chatSessionId: null, chatCwd: null }, [], '- U1: Yes it works')
    expect(prompt).toContain('Earlier in this Slack thread')
    expect(prompt).toContain('relay:untrusted-data')
    expect(prompt).toContain('Yes it works')
    expect(prompt).not.toContain('Claude Code chat')
  })

  it('points a fresh session at the taken-over chat\'s transcript', () => {
    const task = { pendingEvents: [], files: [], chatSessionId: 'chat-1', chatCwd: '/Users/me/.agents' }
    expect(buildTurnPrompt(task, [], '- U1: hi')).toMatch(/Claude Code chat chat-1\. Read its transcript first for the history: .*\/-Users-me--agents\/chat-1\.jsonl/)
    expect(buildTurnPrompt(task, [])).not.toContain('chat-1')
  })
})
