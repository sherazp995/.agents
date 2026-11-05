import { describe, expect, it } from 'vitest'
import { buildTurnPrompt, renderNewMessages, WORKER_BRIEF } from '../../src/autonomous/prompt.js'
import type { TaskEvent, TaskFile } from '../../src/autonomous/store.js'

describe('WORKER_BRIEF', () => {
  it('tells the worker to write short standard Markdown with no report labels', () => {
    expect(WORKER_BRIEF).toContain('the way the human-conversation skill says')
    expect(WORKER_BRIEF).toContain('Write standard Markdown; Relay posts it as a Slack markdown block: **bold**')
    expect(WORKER_BRIEF).toContain('[link text](https://example.com)')
    expect(WORKER_BRIEF).toContain('Not Slack mrkdwn')
    expect(WORKER_BRIEF).toContain('No labels or status lines such as "Answer:"')
  })

  it('tells the worker it is a headless turn, not the open window', () => {
    expect(WORKER_BRIEF).toContain('This turn is a headless run (`claude -p` or `codex exec`)')
    expect(WORKER_BRIEF).toContain('Never say you are that open window.')
  })

  it('says a remote write waits for approval in the thread, and asks for nothing else', () => {
    expect(WORKER_BRIEF).toContain('waits for the user\'s approval in the thread')
    for (const gone of ['JSON', 'plan', 'worktree', 'remote_write']) expect(WORKER_BRIEF).not.toContain(gone)
  })

  it('asks for one remote write per command, plain git push, and gh only for GitHub actions', () => {
    expect(WORKER_BRIEF).toContain('Run each remote write as its own command')
    expect(WORKER_BRIEF).toContain('Push with plain `git push`')
    expect(WORKER_BRIEF).toContain('Use `gh` only for what git cannot do on GitHub')
  })

  it('asks long work to edit one status message in place, and keeps the answer in the turn text, not in say', () => {
    expect(WORKER_BRIEF).toContain('update that one status message in place')
    expect(WORKER_BRIEF).toContain('Write the answer as your turn text, not with say')
    expect(WORKER_BRIEF).toContain('Use say only for the ack and the status message')
    expect(WORKER_BRIEF).not.toContain('Post the final report as a new message')
  })

  it('says every text of the turn is the report and Slack sees nothing else, and to ack long work in its own words but answer a quick question directly', () => {
    expect(WORKER_BRIEF).toContain('Every text you write this turn is posted in the thread as the report')
    expect(WORKER_BRIEF).toContain('Slack sees nothing else')
    expect(WORKER_BRIEF).toContain('Never point to a message the thread may not show')
    expect(WORKER_BRIEF).toContain('If a say or edit command exits non-zero, that text was not posted')
    expect(WORKER_BRIEF).toContain('never leave anything the user must read only in the status message')
    expect(WORKER_BRIEF).toContain('do not repeat the ack in your turn text')
    expect(WORKER_BRIEF).not.toContain('Your final message each turn is posted')
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
