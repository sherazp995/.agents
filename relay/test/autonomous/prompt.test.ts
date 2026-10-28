import { describe, expect, it } from 'vitest'
import { WORKER_BRIEF } from '../../src/autonomous/prompt.js'

describe('WORKER_BRIEF', () => {
  it('tells the worker to write short Slack mrkdwn with no report labels', () => {
    expect(WORKER_BRIEF).toContain('the way the human-conversation skill says')
    expect(WORKER_BRIEF).toContain('Use Slack mrkdwn: *bold* (single asterisks)')
    expect(WORKER_BRIEF).toContain('`code`, <https://example.com|link text>')
    expect(WORKER_BRIEF).toContain('No labels or status lines such as "Answer:"')
  })

  it('lets a plain question be answered without a plan', () => {
    expect(WORKER_BRIEF).toContain('answer a question that needs no change (just answer it, with no plan)')
  })
})
