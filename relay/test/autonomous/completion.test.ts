import { describe, expect, it } from 'vitest'
import {
  checkReviewRecord,
  checkVideoVerdict,
  checkVisualQaManifest,
  verifyCompletion,
  type CompletionDeps,
  type QaPurpose,
  type VerificationRecord,
} from '../../src/autonomous/completion.js'
import type { AutonomousTask } from '../../src/autonomous/store.js'

const SNAPSHOT = { repo: 'web', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) }
const RECORD = `run_id: r1\nstate: S1\nkind: branch\nverdict: PASS\nLenses run: senior: ran, structural: ran, simplicity: ran, diff-only: ran, codex: ran\n`
const MANIFEST = {
  base: { sha: SNAPSHOT.baseSha },
  current: { sha: SNAPSHOT.headSha },
  coverage: [{ scenario: 'login', status: 'passed' }],
  review: { combined_status: 'passed', head_sha: SNAPSHOT.headSha, base_sha: SNAPSHOT.baseSha },
}

function task(overrides: Partial<AutonomousTask> = {}): AutonomousTask {
  return {
    worktreePath: '/wt',
    testCommand: 'pnpm test',
    changeKind: 'fix',
    visible: false,
    approvedScope: 'login form',
    ...overrides,
  } as AutonomousTask
}

function deps(overrides: Partial<CompletionDeps> & { reports?: Partial<Record<QaPurpose, string>> } = {}) {
  const records: VerificationRecord[] = []
  const invoked: QaPurpose[] = []
  const tests: string[] = []
  const reports = { review: RECORD, visual_qa: JSON.stringify(MANIFEST), video_qa: JSON.stringify({ verdict: 'FIXED' }), ...overrides.reports }
  const d: CompletionDeps = {
    worktreeStatus: async () => '',
    freezeSnapshot: async () => SNAPSHOT,
    async runTests(_worktree, command) {
      tests.push(command)
      return 0
    },
    prepareQaCheckout: async () => '/qa',
    reviewState: async () => 'S1',
    async runQaInvocation(_task, purpose) {
      invoked.push(purpose)
      return { kind: 'report', reportPath: purpose }
    },
    readText: async (path) => reports[path as QaPurpose],
    async recordVerification(_task, record) {
      records.push(record)
    },
    ...overrides,
  }
  return { d, records, invoked, tests }
}

describe('completion acceptance rules', () => {
  it('accepts a PASS review of this state with the Codex lens, and names each gap otherwise', () => {
    expect(checkReviewRecord(RECORD, 'S1')).toEqual({ ok: true })
    expect(checkReviewRecord(RECORD, 'S2')).toMatchObject({ ok: false, gap: expect.stringContaining('another state') })
    expect(checkReviewRecord(RECORD.replace('verdict: PASS', 'verdict: CHANGES REQUIRED'), 'S1')).toMatchObject({ ok: false })
    expect(checkReviewRecord(RECORD.replace('codex: ran', 'codex: not run (timeout)'), 'S1')).toMatchObject({ ok: false, gap: 'the review did not run its Codex lens' })
  })

  it('refuses a visual QA report with any scenario not passed, or for other SHAs', () => {
    expect(checkVisualQaManifest(MANIFEST, SNAPSHOT)).toEqual({ ok: true })
    expect(checkVisualQaManifest({ ...MANIFEST, coverage: [{ scenario: 'login', status: 'not-tested' }] }, SNAPSHOT)).toMatchObject({ ok: false })
    expect(checkVisualQaManifest({ ...MANIFEST, current: { sha: 'x' } }, SNAPSHOT)).toMatchObject({ ok: false })
    expect(checkVisualQaManifest({ ...MANIFEST, review: { ...MANIFEST.review, combined_status: 'failed' } }, SNAPSHOT)).toMatchObject({ ok: false })
  })

  it('wants FIXED for a fix and WORKING for a feature', () => {
    expect(checkVideoVerdict({ verdict: 'FIXED' }, 'fix')).toEqual({ ok: true })
    expect(checkVideoVerdict({ verdict: 'WORKING' }, 'feature')).toEqual({ ok: true })
    expect(checkVideoVerdict({ verdict: 'WORKING' }, 'fix')).toMatchObject({ ok: false })
  })
})

describe('verifyCompletion', () => {
  it('refuses a dirty worktree before anything runs', async () => {
    const { d, invoked } = deps({ worktreeStatus: async () => ' M a.ts\n' })
    expect(await verifyCompletion(task(), d)).toEqual({ kind: 'gaps', gaps: [expect.stringContaining('commit your work locally')] })
    expect(invoked).toEqual([])
  })

  it('uses the approved test command, runs review only for a non-visible change, and records a passing row', async () => {
    const { d, records, invoked, tests } = deps()
    expect(await verifyCompletion(task(), d)).toEqual({ kind: 'passed' })
    expect(tests).toEqual(['pnpm test'])
    expect(invoked).toEqual(['review'])
    expect(records).toEqual([expect.objectContaining({ ...SNAPSHOT, testsExit: 0, reviewVerdict: 'PASS', passed: true })])
  })

  it('runs visual and video QA for a visible change and lists every gap in a failing row', async () => {
    const { d, records, invoked } = deps({
      runTests: async () => 1,
      reports: { review: RECORD.replace('codex: ran', 'codex: not run'), video_qa: JSON.stringify({ verdict: 'STILL BROKEN' }) },
    })
    const result = await verifyCompletion(task({ visible: true }), d)
    expect(invoked).toEqual(['review', 'visual_qa', 'video_qa'])
    expect(result).toMatchObject({ kind: 'gaps' })
    expect(result.kind === 'gaps' ? result.gaps : []).toHaveLength(3)
    expect(records[0]?.passed).toBe(false)
  })

  it('ends blocked when an invocation cannot be admitted', async () => {
    const { d, records } = deps({ runQaInvocation: async () => ({ kind: 'blocked', reason: 'no eligible codex account for the review lens' }) })
    expect(await verifyCompletion(task(), d)).toEqual({ kind: 'blocked', reason: 'no eligible codex account for the review lens' })
    expect(records).toHaveLength(1)
  })
})
