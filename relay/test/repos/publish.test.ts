import { describe, expect, it } from 'vitest'

import {
  buildCommitTrailers,
  buildPublishApprovalMessage,
  buildPrCreateCommand,
  buildPullRequestBody,
  buildPushCommand,
  checkCommitMessage,
  checkPublishPreconditions,
  findSentenceDashes,
} from '../../src/repos/publish.js'
import { decideReview } from '../../src/repos/review.js'
import { repoEntrySchema } from '../../src/repos/schema.js'

/**
 * FR-CODE-41a is the requirement worth reading twice: the approval's
 * question is "publish this branch and open a draft PR so you can review
 * it", NOT "is this code correct". An approval message that reads like a
 * code review invites someone to approve as though they had read a diff
 * they were never shown.
 */

function repo(overrides: Record<string, unknown> = {}) {
  return repoEntrySchema.parse({
    name: 'fixture',
    path: '/Users/op/code/fixture',
    remote: 'origin',
    permitted_operations: ['read', 'write', 'publish'],
    ...overrides,
  })
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    repo: repo(),
    branch: 'relay/run-1-add-thing',
    diff: 'diff --git a/f.ts b/f.ts\n+++ b/f.ts\n@@ -1,0 +1,1 @@\n+const x = 1',
    files: [{ path: 'src/f.ts', insertions: 10, deletions: 2 }],
    commitSubjects: ['Add the thing'],
    verification: { kind: 'passed', command: 'pnpm test' },
    review: decideReview([]),
    ...overrides,
  } as Parameters<typeof checkPublishPreconditions>[0]
}

describe('FR-CODE-47d: the publish gate weakens nothing', () => {
  it('still blocks on a credential, whatever else was approved', () => {
    const withSecret = request({
      diff: 'diff --git a/f.ts b/f.ts\n+++ b/f.ts\n@@ -1,0 +1,1 @@\n+const k = "AKIA1234567890ABCDEF"',
    })

    const result = checkPublishPreconditions(withSecret)

    expect(result.allowed).toBe(false)
    if (result.allowed) return
    expect(result.reason).toContain('credential shape')
  })

  it('refuses when the review has not passed (FR-REV-1)', () => {
    const unreviewed = request({
      review: decideReview([
        { severity: 'blocker', origin: 'introduced', file: 'a.ts', line: 1, summary: 's', evidence: 'e', reviewer: 'codex' },
      ]),
    })

    const result = checkPublishPreconditions(unreviewed)

    expect(result.allowed).toBe(false)
    if (result.allowed) return
    expect(result.reason).toContain('FR-REV-1')
  })

  it('refuses when verification did not run, since "not configured" is not a pass', () => {
    const result = checkPublishPreconditions(request({ verification: { kind: 'not_configured' } }))

    expect(result.allowed).toBe(false)
    if (result.allowed) return
    expect(result.reason).toContain('verification did not pass')
  })

  it('refuses a push to a protected branch even here', () => {
    const result = checkPublishPreconditions(request({ branch: 'main' }))

    expect(result.allowed).toBe(false)
    if (result.allowed) return
    expect(result.reason).toContain('hard-blocked')
  })

  it('refuses when the registry does not permit publish, and says the work is not lost', () => {
    const result = checkPublishPreconditions(request({ repo: repo({ permitted_operations: ['read', 'write'] }) }))

    expect(result.allowed).toBe(false)
    if (result.allowed) return
    expect(result.reason).toContain('is not lost')
  })

  it('allows a change that passed everything', () => {
    expect(checkPublishPreconditions(request()).allowed).toBe(true)
  })
})

describe('FR-CODE-41: the approval message is metadata only', () => {
  it('contains NO diff content', () => {
    // Chat is a bad review surface, and a diff pasted there invites
    // approval-by-skim of something nobody could read properly on a phone.
    const message = buildPublishApprovalMessage(request())

    expect(message).not.toContain('const x = 1')
    expect(message).not.toContain('diff --git')
  })

  it('states the question as a VISIBILITY decision, per FR-CODE-41a', () => {
    const message = buildPublishApprovalMessage(request())

    expect(message).toContain('open a draft PR so you can review it')
    expect(message).toContain('not a code review')
  })

  it('gives per-file counts, the commits, and the verification result', () => {
    const message = buildPublishApprovalMessage(request())

    expect(message).toContain('src/f.ts  +10 -2')
    expect(message).toContain('Add the thing')
    expect(message).toContain('pnpm test')
  })

  it('truncates a very large file list rather than filling the channel', () => {
    const files = Array.from({ length: 40 }, (_unused, index) => ({ path: `src/f${index}.ts`, insertions: 1, deletions: 0 }))

    expect(buildPublishApprovalMessage(request({ files }))).toContain('and 20 more files')
  })
})

describe('FR-CODE-46: no dash as sentence punctuation', () => {
  it('catches a dash used as punctuation, in each spelling', () => {
    expect(findSentenceDashes('Fixed the bug - it was the guard')).toHaveLength(1)
    expect(findSentenceDashes('Fixed the bug — it was the guard')).toHaveLength(1)
  })

  it('LEAVES intra-word hyphens alone, which are fine', () => {
    expect(findSentenceDashes('Restyled the chat-style left-aligned composer')).toEqual([])
  })

  it('refuses a message that breaks the rule, and names the line', () => {
    const result = checkCommitMessage('Add a thing\n\nIt works — I checked it')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('rule 45')
    expect(result.reason).toContain('I checked it')
  })

  it('accepts an ordinary message', () => {
    expect(checkCommitMessage('Add a health check endpoint\n\nReturns 200 and the build SHA.').ok).toBe(true)
  })
})

describe('FR-CODE-45: history shows the tool and the human', () => {
  it('records the requester as a trailer, not as the author', () => {
    // Attributing the commit to them would misrepresent git log and git
    // blame for everyone who reads the repository later.
    const trailers = buildCommitTrailers('hassan')

    expect(trailers).toContain('Requested-by: hassan')
    expect(trailers.join('\n')).toContain('Relay')
  })
})

describe('FR-CODE-47: the draft PR', () => {
  it('states what was NOT verified, not only what was', () => {
    // A PR that lists its passing tests and stays quiet about the ones that
    // do not exist reads as a stronger claim than it is.
    const body = buildPullRequestBody(
      request({
        review: decideReview([
          { severity: 'low', origin: 'introduced', file: 'a.ts', line: 1, summary: 's', evidence: 'e', reviewer: 'codex' },
          { severity: 'high', origin: 'pre-existing', file: 'b.ts', line: 2, summary: 's', evidence: 'e', reviewer: 'codex' },
        ]),
      }),
    )

    expect(body).toContain('What was NOT verified')
    expect(body).toContain('parked, not fixed')
    expect(body).toContain('pre-existing')
  })

  it('says plainly that Relay does not merge', () => {
    expect(buildPullRequestBody(request())).toContain('you merge')
  })
})

describe('push and PR are separate commands, each its own approval', () => {
  it('pushes one exact commit to an explicit URL and branch, and opens nothing', () => {
    const command = buildPushCommand({ url: 'https://github.com/acme/api.git', sha: 'a'.repeat(40), branch: 'relay/fix' })

    expect(command.command).toBe('git')
    expect(command.args).toEqual(['push', '--no-verify', '--', 'https://github.com/acme/api.git', `${'a'.repeat(40)}:refs/heads/relay/fix`])
  })

  it('refuses to build a push of anything but a full SHA to a plain branch', () => {
    const url = 'https://github.com/acme/api.git'
    expect(() => buildPushCommand({ url, sha: 'HEAD', branch: 'relay/fix' })).toThrow()
    for (const branch of ['-f', ':main', 'a..b', 'refs/heads/x', 'x.lock']) {
      expect(() => buildPushCommand({ url, sha: 'a'.repeat(40), branch })).toThrow()
    }
    expect(() => buildPushCommand({ url: '--upload-pack=x', sha: 'a'.repeat(40), branch: 'relay/fix' })).toThrow()
  })

  it('opens the PR as a draft against the named base, without pushing, with the body on stdin', () => {
    const command = buildPrCreateCommand({ repo: 'github.com/acme/api', base: 'main', head: 'relay/fix', title: 'Fix it' })

    expect(command.command).toBe('gh')
    expect(command.args).toEqual(expect.arrayContaining(['--draft', '--base', 'main', '--head', 'relay/fix', '--repo', 'github.com/acme/api']))
    expect(command.args.slice(-2)).toEqual(['--body-file', '-'])
    expect(command.args).not.toContain('push')
  })
})
