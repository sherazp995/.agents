/**
 * The remote-write executor. A worker never writes to a remote: it asks,
 * through its reply's `remote_write`, and relay stores that request as an
 * immutable operation, offers one approval for exactly it, and on approval
 * runs exactly it from a context the worker cannot touch:
 *   - a push goes from a relay-owned bare mirror (`<RELAY_HOME>/mirrors/`),
 *     into which relay fetched the stored SHA, to the canonical URL from the
 *     repo registry, with relay's own git config, hooks off and relay's
 *     write token from a one-shot askpass. The worktree's `.git/config`,
 *     hooks, `pushurl` and `insteadOf` are never read;
 *   - `gh` runs from `<RELAY_HOME>`, with `--repo` and the stored body on stdin.
 * A push or PR is offered and run only for a snapshot with a passing
 * `autonomous_verifications` row. A crash mid-dispatch is reconciled at
 * startup from what the remote shows, never replayed.
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Pool } from 'pg'
import { buildPrCreateCommand, buildPushCommand, checkCommitMessage, checkPublishPreconditions, isPlainBranchName } from '../repos/publish.js'
import { checkOffLimits, checkRepoOperation } from '../repos/resolve.js'
import type { RepoEntry } from '../repos/schema.js'
import { registerSecretValue } from '../secrets/scrubber.js'
import {
  checkOperationApproval,
  claimOperation,
  describeOperation,
  insertOperation,
  loadOperation,
  loadTaskThread,
  newOperationId,
  offerApprovalInTransaction,
  operationMarker,
  postInThread,
  refuseSecretText,
  settleOperation,
  type Operation,
  type OperationDeps,
  type OperationPayload,
} from './operations.js'
import type { RemoteWrite } from './reply.js'
import { inTransaction, type AutonomousTask } from './store.js'
import { findPassingVerification, type Verification } from './verifications.js'

/** GitHub's own limit on an issue, PR or comment body. */
const MAX_BODY_CHARS = 65_536

const DEFAULT_TOOL_TIMEOUT_MS = 120_000

export type RemoteWriteDeps = OperationDeps & {
  relayHome: string
  /** The registry entry for a task's `repo_name` (config/repos.yaml), read at request and again at execution. */
  loadRepo: (name: string) => RepoEntry | undefined
  /** policy `remote_writes.allowed_api_paths`. */
  allowedApiPaths: readonly string[]
  /** Relay's write token, read from the keystore for each write and never stored. */
  readWriteToken: () => Promise<string>
  gitBin?: string
  ghBin?: string
  /** PATH for git and gh. Nothing else of relay's environment reaches them. */
  path?: string
  toolTimeoutMs?: number
  /** Hosts relay's write token may be sent to. Defaults to github.com only. */
  tokenHosts?: readonly string[]
  /** Accept a local bare repository as a remote, and run gh for it without a token. Tests only. */
  allowLocalRemotes?: boolean
}

export type RemoteWriteRequest = {
  task: AutonomousTask
  write: RemoteWrite
  /** The worktree HEAD when the request arrived: the only commit a push or PR may ever name. */
  headSha: string
  /** The base SHA relay froze for this snapshot (origin/<base> fetched by relay). */
  baseSha: string
  /** The run of the turn that produced the request; the approval names it. */
  runId: string
}

export type RemoteWriteRequestResult =
  | { kind: 'requested'; operationId: string; approvalId: string }
  /** A push or PR with no passing verification for this snapshot: verify it, then call offerOperationApproval. No approval exists yet. */
  | { kind: 'needs_verification'; operationId: string; repo: string; baseSha: string; headSha: string }
  | { kind: 'refused'; reason: string }

/**
 * Validates and stores one remote write. A push or PR whose snapshot has a
 * passing verification, and every other kind, gets its approval and card in
 * the same transaction as the operation.
 */
export async function requestRemoteWrite(pool: Pool, deps: RemoteWriteDeps, request: RemoteWriteRequest): Promise<RemoteWriteRequestResult> {
  if (request.task.cancelRequestedAt !== null) return { kind: 'refused', reason: 'the task was stopped.' }
  const operationId = newOperationId()
  const built = buildPayload(deps, request, operationId)
  if (!built.ok) return { kind: 'refused', reason: built.reason }
  const payload = built.payload

  let evidence: Verification | undefined
  if (payload.kind === 'push' || payload.kind === 'pr_create') {
    evidence = await findPassingVerification(pool, { taskId: payload.taskId, repo: payload.repo, baseSha: payload.baseSha, headSha: payload.headSha })
    if (evidence !== undefined && payload.kind === 'push') {
      const precheck = await pushPrecheck(deps, payload, evidence)
      if (!precheck.ok) return { kind: 'refused', reason: precheck.reason }
    }
  }

  return inTransaction(pool, async (client) => {
    const thread = await loadTaskThread(client, payload.taskId)
    if (!thread || thread.cancelled) return { kind: 'refused', reason: 'the task was stopped.' }
    const operation = await insertOperation(client, operationId, payload)
    if ((payload.kind === 'push' || payload.kind === 'pr_create') && evidence === undefined) {
      return { kind: 'needs_verification', operationId, repo: payload.repo, baseSha: payload.baseSha, headSha: payload.headSha }
    }
    const approvalId = await offerApprovalInTransaction(client, deps, operation, thread, request.runId)
    return { kind: 'requested', operationId, approvalId }
  })
}

/**
 * After the scheduler verified the snapshot a push or PR names: offers the
 * approval when a passing row now exists, otherwise answers
 * needs_verification again and creates nothing.
 */
export async function offerOperationApproval(
  pool: Pool,
  deps: RemoteWriteDeps,
  operationId: string,
  runId: string,
): Promise<RemoteWriteRequestResult> {
  const operation = await loadOperation(pool, operationId)
  if (!operation || operation.state !== 'requested' || operation.approvalId !== null) {
    return { kind: 'refused', reason: 'the operation is not waiting for an approval.' }
  }
  const payload = operation.payload
  if (payload.kind === 'push' || payload.kind === 'pr_create') {
    const evidence = await findPassingVerification(pool, { taskId: payload.taskId, repo: payload.repo, baseSha: payload.baseSha, headSha: payload.headSha })
    if (evidence === undefined) {
      return { kind: 'needs_verification', operationId, repo: payload.repo, baseSha: payload.baseSha, headSha: payload.headSha }
    }
    if (payload.kind === 'push') {
      const precheck = await pushPrecheck(deps, payload, evidence)
      if (!precheck.ok) return { kind: 'refused', reason: precheck.reason }
    }
  }
  return inTransaction(pool, async (client) => {
    const thread = await loadTaskThread(client, operation.taskId)
    if (!thread || thread.cancelled) return { kind: 'refused', reason: 'the task was stopped.' }
    const approvalId = await offerApprovalInTransaction(client, deps, operation, thread, runId)
    return { kind: 'requested', operationId, approvalId }
  })
}

type Built = { ok: true; payload: OperationPayload } | { ok: false; reason: string }

function buildPayload(deps: RemoteWriteDeps, request: RemoteWriteRequest, operationId: string): Built {
  const { task, write } = request
  const base = { workspaceId: task.workspaceId, taskId: task.id }

  if (write.kind === 'api_write') {
    const path = write.path.replace(/^\/+/, '')
    if (!apiPathAllowed(path, deps.allowedApiPaths)) {
      return { ok: false, reason: `the API path "${path}" is not in policy remote_writes.allowed_api_paths.` }
    }
    const body = write.body === undefined ? '' : JSON.stringify(write.body)
    const refused = checkBody(body)
    if (refused !== undefined) return { ok: false, reason: refused }
    return { ok: true, payload: { ...base, kind: 'api_write', method: write.method, path, body } }
  }

  if (!/^[0-9a-f]{40}$/.test(request.headSha) || !/^[0-9a-f]{40}$/.test(request.baseSha)) {
    return { ok: false, reason: 'the snapshot SHAs are not full commit ids.' }
  }
  if (task.repoName === null) return { ok: false, reason: 'the task has no repository bound to it.' }
  const repo = deps.loadRepo(task.repoName)
  if (!repo) return { ok: false, reason: `repository "${task.repoName}" is not in the registry.` }
  const canonical = canonicalRepoUrl(repo, { allowLocalPaths: deps.allowLocalRemotes === true })
  if (!canonical.ok) return canonical
  const target = { ...base, repoName: repo.name, repo: canonical.url, ghRepo: ghRepoFor(canonical.url), headSha: request.headSha }
  const marked = (body: string) => `${body}\n\n${operationMarker(operationId)}`

  // Every field is picked by name: nothing the worker wrote can stand in for a target field.
  switch (write.kind) {
    case 'push': {
      const refused = refuseRef(write.branch) ?? publishRefusal(repo)
      if (refused !== undefined) return { ok: false, reason: refused }
      if (task.worktreePath === null) return { ok: false, reason: 'the task has no worktree to push from.' }
      return { ok: true, payload: { ...target, kind: 'push', branch: write.branch, baseSha: request.baseSha, worktree: task.worktreePath } }
    }
    case 'pr_create': {
      const refused =
        refuseRef(write.base) ?? refuseRef(write.head) ?? publishRefusal(repo) ?? checkBody(write.title) ?? checkBody(write.body)
      if (refused !== undefined) return { ok: false, reason: refused }
      if (write.base === write.head) return { ok: false, reason: 'a PR needs a head branch different from its base.' }
      return {
        ok: true,
        payload: { ...target, kind: 'pr_create', base: write.base, head: write.head, baseSha: request.baseSha, title: write.title, body: marked(write.body) },
      }
    }
    case 'pr_comment':
    case 'issue_comment':
    case 'pr_review':
    case 'issue_create': {
      const refused = checkBody(write.body) ?? (write.kind === 'issue_create' ? checkBody(write.title) : undefined)
      if (refused !== undefined) return { ok: false, reason: refused }
      const body = marked(write.body)
      if (write.kind === 'pr_comment') return { ok: true, payload: { ...target, kind: 'pr_comment', pr: write.pr, body } }
      if (write.kind === 'issue_comment') return { ok: true, payload: { ...target, kind: 'issue_comment', issue: write.issue, body } }
      if (write.kind === 'pr_review') return { ok: true, payload: { ...target, kind: 'pr_review', pr: write.pr, event: write.event, body } }
      return { ok: true, payload: { ...target, kind: 'issue_create', title: write.title, body } }
    }
  }
}

function checkBody(body: string): string | undefined {
  if (body.length > MAX_BODY_CHARS) return `the text is over ${MAX_BODY_CHARS} characters.`
  return refuseSecretText(body, 'text')
}

function publishRefusal(repo: RepoEntry): string | undefined {
  const decision = checkRepoOperation(repo, 'publish')
  return decision.allowed ? undefined : decision.reason
}

function refuseRef(name: string): string | undefined {
  return isPlainBranchName(name) ? undefined : `"${name}" is not a plain branch name.`
}

/** Exact paths, or a `*` standing for exactly one path segment. */
export function apiPathAllowed(path: string, allowed: readonly string[]): boolean {
  if (!/^[A-Za-z0-9._~/-]+$/.test(path) || path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return false
  return allowed.some((pattern) => {
    const source = pattern
      .replace(/^\/+/, '')
      .split('/')
      .map((segment) => (segment === '*' ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
    return new RegExp(`^${source}$`).test(path)
  })
}

export type CanonicalUrl = { ok: true; url: string } | { ok: false; reason: string }

/**
 * The URL a write goes to, from the registry only. A remote NAME such as
 * `origin` is refused: resolving it would read the checkout's git config,
 * which the worker shares through its worktree and can rewrite.
 */
export function canonicalRepoUrl(repo: RepoEntry, options: { allowLocalPaths?: boolean } = {}): CanonicalUrl {
  const remote = repo.remote
  const needUrl = (why: string): CanonicalUrl => ({
    ok: false,
    reason:
      `repository "${repo.name}" ${why}. An autonomous remote write needs \`remote\` in config/repos.yaml to be the ` +
      'full https URL, because relay never reads a remote from a checkout the worker can write.',
  })
  if (remote === undefined) return needUrl('declares no remote')
  if (remote.split('/').some((segment) => segment === '..' || segment === '.')) return needUrl('has a remote with a "." or ".." path segment')
  const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)$/.exec(remote)
  if (scp) return { ok: true, url: `https://${scp[1]}/${scp[2]}` }
  const ssh = /^ssh:\/\/git@([A-Za-z0-9.-]+)\/([A-Za-z0-9._/-]+)$/.exec(remote)
  if (ssh) return { ok: true, url: `https://${ssh[1]}/${ssh[2]}` }
  if (/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/.test(remote)) return { ok: true, url: remote.replace(/\/+$/, '') }
  // A local bare repository: tests only, never a production registry.
  if (options.allowLocalPaths === true && isAbsolute(remote)) return { ok: true, url: remote }
  return needUrl(`names its remote as "${remote}", not a URL`)
}

/** `gh --repo` takes HOST/OWNER/REPO. A local path is passed through, which real gh refuses. */
export function ghRepoFor(url: string): string {
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  return match ? `${match[1]}/${match[2]}/${match[3]}` : url
}

export type ExecutionResult =
  | { kind: 'succeeded'; operationId: string; summary: string; result: unknown }
  | { kind: 'failed'; operationId: string; summary: string; result: unknown }
  /** It ran, but relay cannot say it did exactly what was approved (a timeout, or a PR whose head moved). */
  | { kind: 'uncertain'; operationId: string; summary: string; result: unknown }
  /** Revalidation refused before the claim; the operation is marked failed. */
  | { kind: 'refused'; operationId: string; reason: string }
  /** Not this caller's to run: not approved, already claimed, cancelled, or an `mcp_write` (the gateway runs those). */
  | { kind: 'not_claimed'; operationId: string; reason: string }

/**
 * Runs one approved operation at most once: revalidates (receipt over the
 * stored digest, task not stopped, evidence for the stored snapshot, the
 * remote or mirror state the kind needs), claims it, runs it, records and
 * posts the outcome.
 */
export async function executeApprovedOperation(pool: Pool, deps: RemoteWriteDeps, operationId: string): Promise<ExecutionResult> {
  const operation = await loadOperation(pool, operationId)
  if (!operation) return { kind: 'not_claimed', operationId, reason: 'no such operation' }
  if (operation.kind === 'mcp_write') return { kind: 'not_claimed', operationId, reason: 'the MCP gateway runs this call when the worker repeats it' }
  if (operation.state !== 'approved') return { kind: 'not_claimed', operationId, reason: `the operation is ${operation.state}` }

  const refuse = async (reason: string): Promise<ExecutionResult> => {
    await inTransaction(pool, async (client) => {
      if (!(await settleOperation(client, operationId, ['approved'], 'failed', { refused: reason }))) return
      const thread = await loadTaskThread(client, operation.taskId)
      if (thread) await postInThread(client, deps, thread, `Refused: ${describeOperation(operation.payload).title}. ${reason}`)
    })
    return { kind: 'refused', operationId, reason }
  }

  const approval = await checkOperationApproval(pool, deps, operation)
  if (!approval.ok) return refuse(approval.reason)
  const thread = await loadTaskThread(pool, operation.taskId)
  if (!thread || thread.cancelled) {
    await settleOperation(pool, operationId, ['approved'], 'cancelled', { reason: 'the task was stopped' })
    return { kind: 'not_claimed', operationId, reason: 'the task was stopped' }
  }

  const payload = operation.payload
  if (payload.kind === 'push' || payload.kind === 'pr_create') {
    const evidence = await findPassingVerification(pool, { taskId: payload.taskId, repo: payload.repo, baseSha: payload.baseSha, headSha: payload.headSha })
    if (evidence === undefined) return refuse('no passing verification matches the approved commit and base any more.')
    const repo = deps.loadRepo(payload.repoName)
    const canonical = repo ? canonicalRepoUrl(repo, { allowLocalPaths: deps.allowLocalRemotes === true }) : undefined
    if (!repo || !canonical?.ok || canonical.url !== payload.repo) return refuse('the registry no longer names the approved repository URL.')
    const unpermitted = publishRefusal(repo)
    if (unpermitted !== undefined) return refuse(unpermitted)
    if (payload.kind === 'push') {
      const precheck = await pushPrecheck(deps, payload, evidence)
      if (!precheck.ok) return refuse(precheck.reason)
    } else {
      const remoteHead = await lsRemote(deps, payload.repo, payload.head)
      if (remoteHead !== payload.headSha) {
        return refuse(
          remoteHead === undefined
            ? `the head branch ${payload.head} is not on the remote; push it first (relay never pushes for a PR).`
            : `the head branch ${payload.head} is at ${remoteHead}, not the approved ${payload.headSha}.`,
        )
      }
    }
  }

  const claimed = await claimOperation(pool, operationId)
  if (!claimed) return { kind: 'not_claimed', operationId, reason: 'another dispatcher claimed it, or it is no longer approved' }

  let outcome: Outcome
  try {
    outcome = await dispatch(deps, claimed)
  } catch (error) {
    outcome = { state: 'failed', summary: 'it could not be run', result: { error: error instanceof Error ? error.message : String(error) } }
  }
  const title = describeOperation(payload).title
  const lead = { succeeded: 'Done', failed: 'Failed', uncertain: 'Unconfirmed' }[outcome.state]
  const summary = `${lead}: ${title}. ${outcome.summary}`
  await inTransaction(pool, async (client) => {
    if (await settleOperation(client, operationId, ['dispatching'], outcome.state, outcome.result)) {
      await postInThread(client, deps, thread, summary)
    }
  })
  return { kind: outcome.state, operationId, summary, result: outcome.result }
}

type Outcome = { state: 'succeeded' | 'failed' | 'uncertain'; summary: string; result: unknown }

/** A tool that timed out may have done its write: uncertain, never failed. */
function toolFailure(ran: ToolResult): Outcome {
  if (ran.timedOut) return { state: 'uncertain', summary: 'it timed out, so relay cannot say whether it happened; check before asking again.', result: { timedOut: true } }
  return { state: 'failed', summary: tail(ran.stderr), result: { exit: ran.code, stderr: tail(ran.stderr) } }
}

type PushPayload = Extract<OperationPayload, { kind: 'push' }>

/**
 * Fetches the snapshot into relay's mirror, checks the object is the stored
 * SHA, and runs the publish preconditions (diff secret gate, review and
 * verification from the passing row, branch target, `publish` permitted).
 */
async function pushPrecheck(deps: RemoteWriteDeps, payload: PushPayload, evidence: Verification): Promise<{ ok: true } | { ok: false; reason: string }> {
  const repo = deps.loadRepo(payload.repoName)
  if (!repo) return { ok: false, reason: `repository "${payload.repoName}" is not in the registry.` }
  const mirror = await prepareMirror(deps, payload)
  if (!mirror.ok) return mirror
  // Three dots: this branch's own change since it left the base, not the base's later commits reversed.
  const range = `${payload.baseSha}...${payload.headSha}`
  const diff = await git(deps, ['-C', mirror.path, 'diff', '--no-ext-diff', '--no-textconv', range, '--'])
  const names = await git(deps, ['-C', mirror.path, 'diff', '--no-ext-diff', '--name-only', '-z', range, '--'])
  const log = await git(deps, ['-C', mirror.path, 'log', '-z', '--format=%B', `${payload.baseSha}..${payload.headSha}`, '--'])
  if (diff.code !== 0 || names.code !== 0 || log.code !== 0) {
    return { ok: false, reason: `the approved change could not be read: ${tail(diff.stderr || names.stderr || log.stderr)}` }
  }
  const files = names.stdout.split('\0').filter((name) => name !== '')
  for (const file of files) {
    const offLimits = checkOffLimits(repo, join(repo.path, file))
    if (!offLimits.allowed) return { ok: false, reason: offLimits.reason }
  }
  const messages = log.stdout.split('\0').map((message) => message.trim()).filter((message) => message !== '')
  for (const message of messages) {
    const checked = checkCommitMessage(message)
    if (!checked.ok) return { ok: false, reason: checked.reason }
  }
  const verdict = evidence.reviewVerdict ?? 'missing'
  const precheck = checkPublishPreconditions({
    repo: { ...repo, remote: payload.repo },
    branch: payload.branch,
    diff: diff.stdout,
    files: files.map((path) => ({ path, insertions: 0, deletions: 0 })),
    commitSubjects: messages.map((message) => message.split('\n')[0] ?? ''),
    verification: { kind: evidence.passed && evidence.testsExit === 0 ? 'passed' : 'failed' },
    review: {
      verdict: verdict === 'PASS' ? 'PASS' : 'BLOCKED',
      introduced: { blocker: 0, high: 0, medium: 0, low: 0 },
      preExisting: { blocker: 0, high: 0, medium: 0, low: 0 },
      mayPublish: evidence.passed && verdict === 'PASS',
      explanation: `The review of this snapshot was ${verdict}.`,
    },
  })
  return precheck.allowed ? { ok: true } : { ok: false, reason: precheck.reason }
}

async function prepareMirror(deps: RemoteWriteDeps, payload: PushPayload): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(payload.repoName) || payload.repoName.startsWith('.')) {
    return { ok: false, reason: `"${payload.repoName}" cannot name a mirror directory.` }
  }
  const path = join(deps.relayHome, 'mirrors', `${payload.repoName}.git`)
  if (!existsSync(join(path, 'HEAD'))) {
    ensureDir(join(deps.relayHome, 'mirrors'))
    const init = await git(deps, ['init', '--bare', '--quiet', path])
    if (init.code !== 0) return { ok: false, reason: `relay's mirror could not be created: ${tail(init.stderr)}` }
  }
  // upload-pack runs in the worker's repository. git 2.50 runs none of its
  // repo-config commands there (packObjectsHook is honoured only from
  // protected config); the -c values below reach upload-pack through
  // GIT_CONFIG_PARAMETERS and outrank its repo config anyway.
  const fetched = await git(deps, [
    '-c', 'core.fsmonitor=false',
    '-C', path,
    'fetch', '--no-tags', '--quiet', '--upload-pack=git-upload-pack', '--',
    payload.worktree, payload.headSha, payload.baseSha,
  ])
  if (fetched.code !== 0) return { ok: false, reason: `the approved commit could not be fetched from the worktree: ${tail(fetched.stderr)}` }
  const resolved = await git(deps, ['-C', path, 'rev-parse', '--verify', '--quiet', `${payload.headSha}^{commit}`])
  if (resolved.code !== 0 || resolved.stdout.trim() !== payload.headSha) {
    return { ok: false, reason: `the mirror does not hold the approved commit ${payload.headSha}.` }
  }
  return { ok: true, path }
}

async function dispatch(deps: RemoteWriteDeps, operation: Operation): Promise<Outcome> {
  const payload = operation.payload
  switch (payload.kind) {
    case 'push': {
      const mirror = await prepareMirror(deps, payload)
      if (!mirror.ok) return { state: 'failed', summary: mirror.reason, result: { error: mirror.reason } }
      const push = buildPushCommand({ url: payload.repo, sha: payload.headSha, branch: payload.branch })
      const ran = await git(deps, ['-C', mirror.path, ...push.args], { tokenFor: payload.repo })
      if (ran.code !== 0) return toolFailure(ran)
      return { state: 'succeeded', summary: `${payload.branch} is at ${payload.headSha.slice(0, 12)}.`, result: { pushed: payload.headSha, branch: payload.branch } }
    }
    case 'pr_create': {
      const create = buildPrCreateCommand({ repo: payload.ghRepo, base: payload.base, head: payload.head, title: payload.title })
      const ran = await gh(deps, payload.ghRepo, create.args, payload.body)
      if (ran.code !== 0) return toolFailure(ran)
      const url = ran.stdout.trim().split('\n').pop() ?? ''
      // The branch can move between the ls-remote check and creation: the PR
      // exists but does not show what was approved, so it is not a success.
      const view = await gh(deps, payload.ghRepo, ['pr', 'view', url, '--repo', payload.ghRepo, '--json', 'headRefOid'])
      const headRefOid = view.code === 0 ? parseJson<{ headRefOid?: string }>(view.stdout)?.headRefOid : undefined
      if (headRefOid !== payload.headSha) {
        return {
          state: 'uncertain',
          summary: `Opened ${url}, but its head is ${headRefOid ?? 'unreadable'}, not the approved ${payload.headSha}: the branch changed during creation. Check it before relying on the PR.`,
          result: { url, headRefOid: headRefOid ?? null, headMismatch: true },
        }
      }
      return { state: 'succeeded', summary: `Opened ${url}.`, result: { url, headRefOid } }
    }
    case 'pr_comment':
      return ghWrite(deps, payload.ghRepo, ['pr', 'comment', String(payload.pr), '--repo', payload.ghRepo, '--body-file', '-'], payload.body)
    case 'pr_review': {
      const flag = { COMMENT: '--comment', APPROVE: '--approve', REQUEST_CHANGES: '--request-changes' }[payload.event]
      return ghWrite(deps, payload.ghRepo, ['pr', 'review', String(payload.pr), '--repo', payload.ghRepo, flag, '--body-file', '-'], payload.body)
    }
    case 'issue_create':
      return ghWrite(deps, payload.ghRepo, ['issue', 'create', '--repo', payload.ghRepo, '--title', payload.title, '--body-file', '-'], payload.body)
    case 'issue_comment':
      return ghWrite(deps, payload.ghRepo, ['issue', 'comment', String(payload.issue), '--repo', payload.ghRepo, '--body-file', '-'], payload.body)
    case 'api_write':
      return ghWrite(deps, GH_API_HOST, ['api', '--hostname', GH_API_HOST, '--method', payload.method, payload.path, '--input', '-'], payload.body)
    case 'mcp_write':
      return { state: 'failed', summary: 'the MCP gateway runs this call', result: { error: 'not dispatched here' } }
  }
}

async function ghWrite(deps: RemoteWriteDeps, ghRepo: string, args: string[], body: string): Promise<Outcome> {
  const ran = await gh(deps, ghRepo, args, body)
  if (ran.code !== 0) return toolFailure(ran)
  const output = ran.stdout.trim()
  return { state: 'succeeded', summary: output === '' ? '' : tail(output), result: { output: tail(output) } }
}

export type ReconciledOperation = { operationId: string; state: 'succeeded' | 'uncertain' }

/**
 * Startup: every operation a crash left `dispatching` is settled from what
 * the remote shows, never run again. Only proof of the effect makes it
 * `succeeded`; everything else is `uncertain` and posted for the requester.
 */
export async function reconcileDispatching(pool: Pool, deps: RemoteWriteDeps, workspaceId: string): Promise<ReconciledOperation[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM autonomous_operations WHERE workspace_id = $1 AND state = 'dispatching' ORDER BY claimed_at`,
    [workspaceId],
  )
  const reconciled: ReconciledOperation[] = []
  for (const { id } of rows) {
    const operation = await loadOperation(pool, id)
    if (!operation) continue
    let proven = false
    try {
      proven = await provenOnRemote(deps, operation)
    } catch {
      proven = false
    }
    const state = proven ? 'succeeded' : 'uncertain'
    const title = describeOperation(operation.payload).title
    const text = proven
      ? `Relay restarted mid-write and confirmed it completed: ${title}.`
      : `Relay restarted while running "${title}" and cannot prove whether it happened. It will not be retried; please check before asking again.`
    await inTransaction(pool, async (client) => {
      if (!(await settleOperation(client, id, ['dispatching'], state, { reconciled: true }))) return
      const thread = await loadTaskThread(client, operation.taskId)
      if (thread) await postInThread(client, deps, thread, text)
      reconciled.push({ operationId: id, state })
    })
  }
  return reconciled
}

async function provenOnRemote(deps: RemoteWriteDeps, operation: Operation): Promise<boolean> {
  const payload = operation.payload
  const marker = operationMarker(operation.id)
  const ghRepo = 'ghRepo' in payload ? payload.ghRepo : GH_API_HOST
  const markerIn = async (args: string[]) => {
    const ran = await gh(deps, ghRepo, args)
    return ran.code === 0 && containsString(parseJson<unknown>(ran.stdout), marker)
  }
  switch (payload.kind) {
    case 'push':
      return (await lsRemote(deps, payload.repo, payload.branch)) === payload.headSha
    case 'pr_create':
      return markerIn(['pr', 'list', '--repo', payload.ghRepo, '--head', payload.head, '--state', 'all', '--json', 'url,body', '--limit', '50'])
    case 'pr_comment':
      return markerIn(['pr', 'view', String(payload.pr), '--repo', payload.ghRepo, '--json', 'comments'])
    case 'pr_review':
      return markerIn(['pr', 'view', String(payload.pr), '--repo', payload.ghRepo, '--json', 'reviews'])
    case 'issue_create':
      return markerIn(['issue', 'list', '--repo', payload.ghRepo, '--state', 'all', '--search', `relay-op:${operation.id}`, '--json', 'url,body'])
    case 'issue_comment':
      return markerIn(['issue', 'view', String(payload.issue), '--repo', payload.ghRepo, '--json', 'comments'])
    case 'api_write':
    case 'mcp_write':
      // No receipt to look for.
      return false
  }
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (Array.isArray(value)) return value.some((item) => containsString(item, needle))
  if (typeof value === 'object' && value !== null) return Object.values(value).some((item) => containsString(item, needle))
  return false
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function lsRemote(deps: RemoteWriteDeps, url: string, branch: string): Promise<string | undefined> {
  const ran = await git(deps, ['ls-remote', '--', url, `refs/heads/${branch}`], { tokenFor: url })
  if (ran.code !== 0) return undefined
  return /^([0-9a-f]{40})\trefs\/heads\//m.exec(ran.stdout)?.[1]
}

type ToolResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** gh api calls name their host explicitly; nothing else is ever written through the API. */
const GH_API_HOST = 'github.com'

/** The write token goes only to an https URL on an allowed host. */
export function tokenHostAllowed(url: string, hosts: readonly string[] = [GH_API_HOST]): boolean {
  const match = /^https:\/\/([^/:@]+)\//.exec(url)
  return match !== null && hosts.includes((match[1] ?? '').toLowerCase())
}

/** Relay's own git: no system config, relay's global config, no hooks, no credential helpers, never a prompt. */
async function git(deps: RemoteWriteDeps, args: readonly string[], options: { tokenFor?: string } = {}): Promise<ToolResult> {
  const config = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never']
  if (options.tokenFor === undefined || !tokenHostAllowed(options.tokenFor, deps.tokenHosts)) {
    return runTool(deps, deps.gitBin ?? 'git', [...config, ...args], {})
  }
  const token = await deps.readWriteToken()
  registerSecretValue(token)
  // One-shot askpass: written for this call, removed after it.
  const dir = mkdtempSync(join(ensureDir(join(deps.relayHome, 'tmp')), 'askpass-'))
  try {
    const askpass = join(dir, 'askpass')
    writeFileSync(askpass, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) printf \'%s\\n\' "$RELAY_WRITE_TOKEN" ;; esac\n', { mode: 0o700 })
    chmodSync(askpass, 0o700)
    return await runTool(deps, deps.gitBin ?? 'git', [...config, ...args], { GIT_ASKPASS: askpass, RELAY_WRITE_TOKEN: token })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * gh for one repository (`HOST/OWNER/REPO`) or the API host. The token is
 * sent only to an allowed host; any other host is refused without running,
 * except a local test remote, which runs with no token at all.
 */
async function gh(deps: RemoteWriteDeps, ghRepo: string, args: readonly string[], input?: string): Promise<ToolResult> {
  const host = ghRepo.split('/')[0]?.toLowerCase() ?? ''
  const env: Record<string, string> = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_CONFIG_DIR: ensureDir(join(deps.relayHome, 'gh')) }
  if ((deps.tokenHosts ?? [GH_API_HOST]).includes(host)) {
    const token = await deps.readWriteToken()
    registerSecretValue(token)
    env.GH_TOKEN = token
    env.GH_HOST = host
  } else if (!(deps.allowLocalRemotes === true && isAbsolute(ghRepo))) {
    return { code: null, stdout: '', stderr: `relay sends its write token only to ${(deps.tokenHosts ?? [GH_API_HOST]).join(', ')}, not "${host}".`, timedOut: false }
  }
  return runTool(deps, deps.ghBin ?? 'gh', args, env, input)
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

/**
 * Runs one tool in its own process group. On timeout the whole group is
 * killed and the call resolves at once, even if a grandchild keeps a pipe
 * open, so a hung write ends as uncertain instead of holding the claim.
 */
function runTool(deps: RemoteWriteDeps, bin: string, args: readonly string[], extraEnv: Record<string, string>, input?: string): Promise<ToolResult> {
  const globalConfig = join(ensureDir(join(deps.relayHome, 'git')), 'gitconfig')
  if (!existsSync(globalConfig)) writeFileSync(globalConfig, '[core]\n\thooksPath = /dev/null\n', { mode: 0o600 })
  const env: NodeJS.ProcessEnv = {
    PATH: deps.path ?? process.env.PATH ?? '',
    HOME: deps.relayHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
    ...extraEnv,
  }
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number | null, timedOut: boolean, extra = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr: `${stderr}${extra}`, timedOut })
    }
    const child = spawn(bin, args, { cwd: deps.relayHome, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }
      finish(null, true)
    }, deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => finish(null, false, error.message))
    child.on('close', (code) => finish(code, false))
    child.stdin.end(input ?? '')
  })
}

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 500 ? `…${trimmed.slice(-500)}` : trimmed
}
