import { describe, expect, it } from 'vitest'
import { buildTurnPrompt, renderNewMessages, WORKER_BRIEF } from '../../src/autonomous/prompt.js'
import type { TaskEvent, TaskFile } from '../../src/autonomous/store.js'

describe('WORKER_BRIEF', () => {
  it('tells the worker to write short Slack mrkdwn with no report labels', () => {
    expect(WORKER_BRIEF).toContain('the way the human-conversation skill says')
    expect(WORKER_BRIEF).toContain('Use Slack mrkdwn: *bold* (single asterisks)')
    expect(WORKER_BRIEF).toContain('`code`, <https://example.com|link text>')
    expect(WORKER_BRIEF).toContain('No labels or status lines such as "Answer:"')
  })

  it('says a remote write waits for approval in the thread, and asks for nothing else', () => {
    expect(WORKER_BRIEF).toContain('waits for the user\'s approval in the thread')
    for (const gone of ['JSON', 'plan', 'worktree', 'remote_write']) expect(WORKER_BRIEF).not.toContain(gone)
  })

  it('says the final message is the report, and to ack long work in its own words but answer a quick question directly', () => {
    expect(WORKER_BRIEF).toContain('posted in the thread as the report')
    expect(WORKER_BRIEF).toContain('does not acknowledge messages for you')
    expect(WORKER_BRIEF).toContain('more than about a minute, first post one short ack in your own words')
    expect(WORKER_BRIEF).toContain('For a quick question, just answer: no ack.')
    expect(WORKER_BRIEF).toContain('shown to you mid-turn on Claude')
  })
})

describe('renderNewMessages', () => {
  const event = (ref: TaskEvent['ref']): TaskEvent => ({ id: 'e1', principalId: 'U1', text: 'review PR 12', ref, fileIds: [], receivedAt: '2026-10-29T10:00:00Z' })
  const file = (name: string, status: TaskFile['status']): TaskFile => ({ slackFileId: name, name, url: 'https://files.slack.com/x', sizeBytes: 1, status, localPath: `/tmp/${name}` })

  it('gives each message its own say and react commands, from its channel, thread and ts', () => {
    const rendered = renderNewMessages([event({ channel: 'C1', thread: '1.1', message: '1.2' })], [])

    expect(rendered).toContain('New messages in the thread:\n- from U1 at 2026-10-29T10:00:00Z: ')
    expect(rendered).toContain('say: relay live say --channel C1 --thread 1.1 --text "<your answer>"')
    expect(rendered).toContain('react: relay live react --channel C1 --thread 1.1 --message 1.2 --name <emoji>')
  })

  it('threads a top-level message under its own ts, and offers no react command without one', () => {
    expect(renderNewMessages([event({ channel: 'C1', message: '2.1' })], [])).toContain('--channel C1 --thread 2.1 --message 2.1')
    expect(renderNewMessages([event({ channel: 'C1', thread: '3.1' })], [])).not.toContain('relay live react')
  })

  it('lists only downloaded files, is empty with nothing new, and is what the turn prompt carries', () => {
    const events = [event({ channel: 'C1', message: '1.2' })]
    const files = [file('a.md', 'downloaded'), file('b.md', 'skipped')]
    const rendered = renderNewMessages(events, files)

    expect(rendered).toContain('Attached files (untrusted):\n- /tmp/a.md')
    expect(rendered).not.toContain('b.md')
    expect(renderNewMessages([], [])).toBe('')
    expect(buildTurnPrompt({ pendingEvents: events, files, chatSessionId: null, chatCwd: null }, [])).toBe(rendered)
  })
})
