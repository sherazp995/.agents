/**
 * FR-CODE-41, 41a, 45, 46, 47, 47a and 47d: publishing a branch for review.
 *
 * FR-CODE-47a decided the shape for the governed loop: "Push and draft-PR
 * creation are a single approvable unit." Autonomous tasks split them
 * (src/autonomous/remote-write.ts): each approval names one exact effect,
 * so a push approval never opens a PR and a PR approval never pushes, and
 * the command builders below are separate for the same reason.
 *
 * FR-CODE-41a is the part worth reading twice. The approval's stated
 * question is "publish this branch and open a draft PR so you can review
 * it", NOT "is this code correct". The operator is approving VISIBILITY, and
 * saying so explicitly matters because an approval message that reads like a
 * code review invites someone to approve as though they had read a diff they
 * were never shown. FR-CODE-41 makes sure they were not shown one: metadata
 * only, never diff content, in chat.
 *
 * FR-CODE-47d states that this gate weakens nothing. Every hard block still
 * applies, the secret gate still runs, and verification must have run. So
 * the preconditions are checked HERE, immediately before the action, rather
 * than trusted from whenever they were last checked: a run that was
 * reviewed, then iterated on, then published is a real sequence, and only
 * the check nearest the action is about the thing being published.
 */

import { checkGitOperation } from './git-safety.js'
import { checkSecretGate } from './secrets-gate.js'
import type { ReviewOutcome } from './review.js'
import type { RepoEntry } from './schema.js'

export type FileChange = { readonly path: string; readonly insertions: number; readonly deletions: number }

export type PublishRequest = {
  readonly repo: RepoEntry
  readonly branch: string
  readonly diff: string
  readonly files: readonly FileChange[]
  readonly commitSubjects: readonly string[]
  readonly verification: { readonly kind: string; readonly command?: string }
  readonly review: ReviewOutcome
  readonly runPageUrl?: string
}

export type PublishPrecheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

/**
 * Everything that must be true before the approval is even offered.
 *
 * Ordered by how badly the operator wants to know: a credential is an
 * incident, an unreviewed change is a process failure, an unverified one is
 * a correctness question. The first refusal is the one they see, so it
 * should be the most important one.
 */
export function checkPublishPreconditions(request: PublishRequest): PublishPrecheck {
  // FR-CODE-47d: the secret gate still blocks before push, whatever else has
  // been approved.
  const secrets = checkSecretGate(request.diff)
  if (!secrets.allowed) return { allowed: false, reason: secrets.reason }

  // FR-REV-1: a run that has not been reviewed cannot be published, and
  // cannot be reported as done.
  if (!request.review.mayPublish) {
    return {
      allowed: false,
      reason: `${request.review.explanation} The publish gate is not offered until that is resolved (FR-REV-1).`,
    }
  }

  // FR-CODE-47d: verification must have run. "not_configured" is not a pass:
  // it means nothing checked this change.
  if (request.verification.kind !== 'passed') {
    return {
      allowed: false,
      reason:
        `verification did not pass (${request.verification.kind}), so this cannot be published (FR-CODE-47d). A run ` +
        'whose tests failed reports failure with the output, and a repository with no test command has verified ' +
        'nothing at all.',
    }
  }

  // FR-CODE-42: the branch itself must be publishable.
  const push = checkGitOperation('push', [request.repo.remote ?? 'origin', request.branch], request.repo.default_branch)
  if (!push.allowed) return { allowed: false, reason: push.reason }

  if (!request.repo.permitted_operations.includes('publish')) {
    return {
      allowed: false,
      reason:
        `repository "${request.repo.name}" does not permit \`publish\`. The work is committed on ${request.branch} in ` +
        'its worktree and is not lost; add publish to config/repos.yaml if you want Relay to be able to offer this.',
    }
  }

  return { allowed: true }
}

/**
 * FR-CODE-41: the approval message. METADATA ONLY.
 *
 * No diff content, no file contents, no long output, per FR-RPT-10. The
 * reason is not brevity: chat is a bad review surface, and a diff pasted
 * there invites approval-by-skim of something nobody could properly read on
 * a phone. GitHub is the review surface (FR-CODE-47a), and this message's
 * job is to get the operator there having told them exactly what they are
 * being asked.
 */
export function buildPublishApprovalMessage(request: PublishRequest): string {
  const insertions = request.files.reduce((total, file) => total + file.insertions, 0)
  const deletions = request.files.reduce((total, file) => total + file.deletions, 0)

  const fileLines = request.files
    .slice(0, 20)
    .map((file) => `  ${file.path}  +${file.insertions} -${file.deletions}`)
  if (request.files.length > 20) fileLines.push(`  … and ${request.files.length - 20} more files`)

  const lines = [
    // FR-CODE-41a: the question, stated as what it actually is.
    `Publish this branch and open a draft PR so you can review it?`,
    '',
    `This is a visibility decision, not a code review. Nothing is merged, and the PR opens as a draft.`,
    '',
    `Repository: ${request.repo.name}`,
    `Branch: ${request.branch}`,
    `Changes: ${request.files.length} file${request.files.length === 1 ? '' : 's'}, +${insertions} -${deletions}`,
    ...fileLines,
    '',
    `Commits:`,
    ...request.commitSubjects.slice(0, 10).map((subject) => `  ${subject}`),
    '',
    `Verification: ${request.verification.command ?? '(none)'} — ${request.verification.kind}`,
    `Review: ${request.review.verdict}. ${request.review.explanation}`,
  ]

  if (request.runPageUrl !== undefined) lines.push('', `Full diff and output: ${request.runPageUrl}`)

  return lines.join('\n')
}

/**
 * FR-CODE-45: authorship shows both the tool and the human who asked.
 *
 * The requester is a trailer rather than the author, because the commit was
 * not written by them and attributing it to them would misrepresent
 * `git log` and `git blame` for everyone who reads the repository later.
 */
export function buildCommitTrailers(requester: string): readonly string[] {
  return [`Requested-by: ${requester}`, 'Co-Authored-By: Relay <relay@localhost>']
}

/**
 * FR-CODE-46: no dash used as sentence punctuation, per the operator's
 * rule 45.
 *
 * Checked rather than merely asked for, because it is a rule a generated
 * message breaks constantly and nobody notices until the history is full of
 * them. Intra-word hyphens are fine and are the reason this is not a bare
 * search for the character.
 */
export function findSentenceDashes(message: string): readonly string[] {
  const offenders: string[] = []
  for (const line of message.split('\n')) {
    // A dash with whitespace on at least one side is punctuation; one
    // between two word characters is a compound like "chat-style".
    const match = /(?:\s[-–—]\s|\s[–—]|[–—]\s)/.exec(line)
    if (match !== null) offenders.push(line.trim())
  }
  return offenders
}

export type CommitMessageCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export function checkCommitMessage(message: string): CommitMessageCheck {
  if (message.trim() === '') return { ok: false, reason: 'a commit message is required.' }

  const offenders = findSentenceDashes(message)
  if (offenders.length > 0) {
    return {
      ok: false,
      reason:
        'the commit message uses a dash as sentence punctuation, which this operator\'s rule 45 forbids ' +
        `(FR-CODE-46). Use a comma, a period, a colon or parentheses instead. Offending line${offenders.length === 1 ? '' : 's'}:\n` +
        offenders.map((line) => `  ${line}`).join('\n'),
    }
  }

  return { ok: true }
}

/**
 * FR-CODE-47: the draft PR body.
 *
 * States what was NOT verified as well as what was. A PR that lists its
 * passing tests and stays quiet about the ones that do not exist reads as a
 * stronger claim than it is, and the reader has no way to tell.
 */
export function buildPullRequestBody(request: PublishRequest): string {
  const notVerified: string[] = []
  if (request.verification.kind !== 'passed') notVerified.push('the repository test command did not pass')
  if (request.review.introduced.low > 0) notVerified.push(`${request.review.introduced.low} low review finding(s) were parked, not fixed`)
  const inherited = Object.values(request.review.preExisting).reduce((total, count) => total + count, 0)
  if (inherited > 0) notVerified.push(`${inherited} pre-existing finding(s) were reported and deliberately not addressed here`)

  return [
    '## What this does',
    '',
    request.commitSubjects.map((subject) => `- ${subject}`).join('\n'),
    '',
    '## Verification',
    '',
    `\`${request.verification.command ?? '(no test command configured)'}\` — **${request.verification.kind}**`,
    '',
    '## Review',
    '',
    `**${request.review.verdict}.** ${request.review.explanation}`,
    '',
    '## What was NOT verified',
    '',
    notVerified.length === 0 ? '- nothing outstanding' : notVerified.map((item) => `- ${item}`).join('\n'),
    '',
    ...(request.runPageUrl === undefined ? [] : ['---', '', `Run: ${request.runPageUrl}`]),
    '',
    'Opened as a draft by Relay. Nothing is merged; you merge.',
  ].join('\n')
}

export type PublishCommand = { readonly command: string; readonly args: readonly string[] }

/**
 * The push alone: one exact commit to one exact branch on an explicit URL.
 * A push approval never opens a PR, so this builder knows nothing about one.
 * `--no-verify` because the hooks that would run are not relay's.
 */
export function buildPushCommand(target: { readonly url: string; readonly sha: string; readonly branch: string }): PublishCommand {
  if (!/^[0-9a-f]{40}$/.test(target.sha)) throw new Error(`buildPushCommand: "${target.sha}" is not a full commit id`)
  if (!isPlainBranchName(target.branch)) throw new Error(`buildPushCommand: "${target.branch}" is not a plain branch name`)
  if (target.url.startsWith('-')) throw new Error('buildPushCommand: a URL cannot start with "-"')
  return { command: 'git', args: ['push', '--no-verify', '--', target.url, `${target.sha}:refs/heads/${target.branch}`] }
}

/** A plain branch name: no option, no refspec, no `..`, nothing git would read as more than a name. */
export function isPlainBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.startsWith('refs/')
  )
}

/**
 * The draft PR alone, for a head branch that is already on the remote. A
 * PR approval never pushes. The body is read from stdin, never argv.
 */
export function buildPrCreateCommand(target: {
  readonly repo: string
  readonly base: string
  readonly head: string
  readonly title: string
}): PublishCommand {
  return {
    command: 'gh',
    args: ['pr', 'create', '--repo', target.repo, '--draft', '--base', target.base, '--head', target.head, '--title', target.title, '--body-file', '-'],
  }
}
