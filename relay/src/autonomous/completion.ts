/**
 * Relay's own verification of an implement task that says it is done. The
 * worker's word is not evidence: relay freezes the committed snapshot,
 * reruns the approved test command, and runs general-review (and, for a
 * visible change, branch-visual-qa and video-qa) as relay-owned invocations
 * in a QA checkout, then reads their records itself.
 *
 * Review and QA invocations always run on a claude account: general-review
 * on a Codex host would start a Claude workflow outside the pool. Its Codex
 * lens, and branch-visual-qa's review lane, run their own `codex exec`, so
 * those two invocations get CODEX_HOME set to an eligible codex account and
 * reserve the fixed lens allowance (decision 11).
 *
 * Every check, passing or not, is written as one verification row for the
 * snapshot; a push or PR request reads it (step 9).
 */

import type { AutonomousTask } from './store.js'

export type Snapshot = { repo: string; baseSha: string; headSha: string }

export type CheckResult = { ok: true } | { ok: false; gap: string }

// ---------------------------------------------------------------------------
// Acceptance rules, pure.
// ---------------------------------------------------------------------------

/** A general-review ledger record: `state:` must be the snapshot's, `verdict:` PASS, and its `Lenses run:` line must show Codex ran. */
export function checkReviewRecord(record: string, expectedState: string): CheckResult {
  const field = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(record)?.[1]?.trim()
  const state = field('state')
  if (state === undefined) return { ok: false, gap: 'the review record has no state line' }
  if (state !== expectedState) return { ok: false, gap: `the review covered another state (${state}), not this snapshot (${expectedState})` }
  const verdict = field('verdict')
  if (verdict !== 'PASS') return { ok: false, gap: `the review verdict is ${verdict ?? 'missing'}, not PASS` }
  const lenses = /Lenses run:\s*(.+)$/m.exec(record)?.[1]
  if (lenses === undefined) return { ok: false, gap: 'the review record does not list the lenses that ran' }
  if (!/codex:\s*ran\b/i.test(lenses)) return { ok: false, gap: 'the review did not run its Codex lens' }
  return { ok: true }
}

type VisualQaManifest = {
  base?: { sha?: unknown }
  current?: { sha?: unknown }
  coverage?: { scenario?: unknown; status?: unknown }[]
  review?: { combined_status?: unknown; head_sha?: unknown; base_sha?: unknown }
}

/** branch-visual-qa's manifest: a combined pass for exactly this snapshot, with no failed, blocked or untested scenario. */
export function checkVisualQaManifest(manifest: unknown, snapshot: Snapshot): CheckResult {
  if (typeof manifest !== 'object' || manifest === null) return { ok: false, gap: 'the visual QA manifest is unreadable' }
  const m = manifest as VisualQaManifest
  if (m.base?.sha !== snapshot.baseSha || m.current?.sha !== snapshot.headSha) return { ok: false, gap: 'visual QA compared other versions than this snapshot' }
  const coverage = m.coverage ?? []
  if (coverage.length === 0) return { ok: false, gap: 'visual QA recorded no scenario' }
  const notPassed = coverage.filter((entry) => entry.status !== 'passed').map((entry) => `${String(entry.scenario)} (${String(entry.status)})`)
  if (notPassed.length > 0) return { ok: false, gap: `visual QA scenarios not passed: ${notPassed.join(', ')}` }
  if (m.review?.combined_status !== 'passed') return { ok: false, gap: `visual QA combined result is ${String(m.review?.combined_status ?? 'missing')}` }
  if (m.review.head_sha !== snapshot.headSha || m.review.base_sha !== snapshot.baseSha) return { ok: false, gap: 'visual QA review covered another version' }
  return { ok: true }
}

/** video-qa's results.json: FIXED for a fix, WORKING for a feature. */
export function checkVideoVerdict(results: unknown, changeKind: 'fix' | 'feature'): CheckResult {
  const verdict = typeof results === 'object' && results !== null ? (results as { verdict?: unknown }).verdict : undefined
  const expected = changeKind === 'fix' ? 'FIXED' : 'WORKING'
  if (verdict === expected) return { ok: true }
  return { ok: false, gap: `the video verdict is ${String(verdict ?? 'missing')}, expected ${expected}` }
}

// ---------------------------------------------------------------------------
// The verification flow.
// ---------------------------------------------------------------------------

export type QaPurpose = 'review' | 'visual_qa' | 'video_qa'

export type QaInvocationResult =
  | { kind: 'report'; reportPath: string }
  | { kind: 'failed'; reason: string }
  /** Admission refused, or no eligible account: verification cannot run at all. */
  | { kind: 'blocked'; reason: string }

export type VerificationRecord = Snapshot & {
  testsExit: number | null
  reviewRecord: string | null
  reviewVerdict: string | null
  visualQaVerdict: string | null
  videoQaVerdict: string | null
  passed: boolean
}

export type CompletionDeps = {
  /** `git status --porcelain` in the worktree. */
  worktreeStatus(worktree: string): Promise<string>
  /** Fetches origin/<base> as relay and returns the base and HEAD SHAs. */
  freezeSnapshot(task: AutonomousTask): Promise<Snapshot>
  /** Runs the approved test command in the worktree; returns its exit status. */
  runTests(worktree: string, command: string): Promise<number | null>
  /** Creates (or reuses) the QA checkout at HEAD under the task folder and registers it on the task. */
  prepareQaCheckout(task: AutonomousTask, snapshot: Snapshot): Promise<string>
  /** general-review's STATE for the snapshot, computed with its own freeze_scope.py. */
  reviewState(qaCheckout: string, snapshot: Snapshot): Promise<string>
  /** Runs one relay-owned QA invocation on a claude account (with CODEX_HOME and the lens allowance for review and visual QA). */
  runQaInvocation(task: AutonomousTask, purpose: QaPurpose, qaCheckout: string, snapshot: Snapshot): Promise<QaInvocationResult>
  readText(path: string): Promise<string>
  recordVerification(task: AutonomousTask, record: VerificationRecord): Promise<void>
}

export type CompletionResult = { kind: 'passed' } | { kind: 'gaps'; gaps: string[] } | { kind: 'blocked'; reason: string }

export function buildQaPrompt(purpose: QaPurpose, task: Pick<AutonomousTask, 'approvedScope'>, snapshot: Snapshot, base: string): string {
  const intent = `Approved scope (the intent): ${task.approvedScope ?? ''}`
  switch (purpose) {
    case 'review':
      return `general review of current branch against ${base}. ${intent}. Base ${snapshot.baseSha}, head ${snapshot.headSha}. When finished, set report_path to the absolute path of the published ledger record.`
    case 'visual_qa':
      return `Run branch-visual-qa for the current branch against ${base}. ${intent}. When finished, set report_path to the absolute path of the run's manifest.json.`
    case 'video_qa':
      return `Run video-qa proving the change against ${base}. ${intent}. When finished, set report_path to the absolute path of results.json.`
  }
}

/** The structured output a QA invocation returns. */
export const QA_REPLY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['report_path', 'summary'],
  properties: { report_path: { type: 'string' }, summary: { type: 'string' } },
} as const

/** Reads only the approved plan fields copied onto the task, never a later reply. */
export async function verifyCompletion(task: AutonomousTask, deps: CompletionDeps): Promise<CompletionResult> {
  const worktree = task.worktreePath
  if (worktree === null) return { kind: 'blocked', reason: 'the task has no worktree to verify' }
  if (task.testCommand === null || task.changeKind === null) return { kind: 'blocked', reason: 'the task has no approved test command or change kind' }
  const approved = { testCommand: task.testCommand, changeKind: task.changeKind, visible: task.visible === true }
  if ((await deps.worktreeStatus(worktree)).trim() !== '') {
    return { kind: 'gaps', gaps: ['the worktree has uncommitted changes: commit your work locally, then say done again'] }
  }

  const snapshot = await deps.freezeSnapshot(task)
  const gaps: string[] = []
  const record: VerificationRecord = { ...snapshot, testsExit: null, reviewRecord: null, reviewVerdict: null, visualQaVerdict: null, videoQaVerdict: null, passed: false }

  record.testsExit = await deps.runTests(worktree, approved.testCommand)
  if (record.testsExit !== 0) gaps.push(`the approved test command \`${approved.testCommand}\` exited ${record.testsExit ?? 'abnormally'}`)

  const qaCheckout = await deps.prepareQaCheckout(task, snapshot)
  const purposes: QaPurpose[] = approved.visible ? ['review', 'visual_qa', 'video_qa'] : ['review']
  for (const purpose of purposes) {
    const result = await deps.runQaInvocation(task, purpose, qaCheckout, snapshot)
    if (result.kind === 'blocked') {
      await deps.recordVerification(task, record)
      return { kind: 'blocked', reason: result.reason }
    }
    if (result.kind === 'failed') {
      gaps.push(`${purpose} did not finish: ${result.reason}`)
      continue
    }
    const check = await checkReport(purpose, result.reportPath, snapshot, qaCheckout, approved.changeKind, deps, record)
    if (!check.ok) gaps.push(check.gap)
  }

  record.passed = gaps.length === 0
  await deps.recordVerification(task, record)
  return record.passed ? { kind: 'passed' } : { kind: 'gaps', gaps }
}

async function checkReport(
  purpose: QaPurpose,
  path: string,
  snapshot: Snapshot,
  qaCheckout: string,
  changeKind: 'fix' | 'feature',
  deps: CompletionDeps,
  record: VerificationRecord,
): Promise<CheckResult> {
  let text: string
  try {
    text = await deps.readText(path)
  } catch {
    return { ok: false, gap: `${purpose} named a report that could not be read: ${path}` }
  }
  switch (purpose) {
    case 'review': {
      record.reviewRecord = path
      record.reviewVerdict = /^verdict:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null
      return checkReviewRecord(text, await deps.reviewState(qaCheckout, snapshot))
    }
    case 'visual_qa': {
      const manifest = safeJson(text)
      const check = checkVisualQaManifest(manifest, snapshot)
      record.visualQaVerdict = check.ok ? 'passed' : 'failed'
      return check
    }
    case 'video_qa': {
      const results = safeJson(text)
      record.videoQaVerdict = typeof results === 'object' && results !== null ? String((results as { verdict?: unknown }).verdict ?? '') : null
      return checkVideoVerdict(results, changeKind)
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
