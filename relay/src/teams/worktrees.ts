/**
 * The git side of a team run (teams phase 2, step 6): the request worktree a
 * build run merges into, each member's own worktree, and the PR head a
 * review run checks. Every git call is async `execFile` with explicit
 * arguments, never a shell string.
 *
 * Naming:
 *   - request worktree: next to the repo, `<repo>-<slug>-<run8>`, branch
 *     `relay/<run8>-<slug>`, from the LOCAL default branch head (recorded).
 *   - member worktree: `<relayHome>/worktrees/<repo>/<assignment>`; a build
 *     member gets branch `relay/<run8>-<assignment8>-<member>` from the
 *     request branch head, review and QA a detached checkout of that head,
 *     and in a PR review run a detached checkout of the PR head.
 *
 * Every step is safe to repeat: a worktree that already exists and belongs
 * to this run (or assignment) is reused, and one that does not is refused.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { resolveRelayHome } from '../config/paths.js'
import { branchSlug } from '../repos/worktree.js'
import { repoEntrySchema, type RepoEntry } from '../repos/schema.js'
import type { Assignment, MemberWorktree, TeamRun } from './types.js'

export type GitResult = { readonly code: number; readonly stdout: string; readonly stderr: string }

/** One git call; never throws for a non-zero exit (the caller reads `code`). */
export function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1
      resolvePromise({ code, stdout: String(stdout).trim(), stderr: String(stderr).trim() || (error?.message ?? '') })
    })
  })
}

/** A git call that must succeed: its trimmed output, or an error naming git's own message. */
export async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd)
  if (result.code !== 0) throw new GitFailed(args, result.stderr)
  return result.stdout
}

export class GitFailed extends Error {
  constructor(args: readonly string[], detail: string) {
    super(`git ${args[0] ?? ''} failed: ${detail}`)
    this.name = 'GitFailed'
  }
}

/** The head of a worktree, or null when it cannot be read. */
export async function headOf(worktreePath: string): Promise<string | null> {
  if (!existsSync(worktreePath)) return null
  const result = await runGit(['rev-parse', 'HEAD'], worktreePath)
  return result.code === 0 && result.stdout !== '' ? result.stdout : null
}

export const shortId = (id: string): string => id.slice(0, 8)

/** The request worktree's path and branch for a build run. */
export function requestWorktreeNames(repo: RepoEntry, runId: string, title: string): { path: string; branch: string } {
  const slug = branchSlug(title)
  return { path: join(dirname(repo.path), `${basename(repo.path)}-${slug}-${shortId(runId)}`), branch: `relay/${shortId(runId)}-${slug}` }
}

export type RequestWorktree = { readonly ok: true; readonly path: string; readonly branch: string; readonly baseCommit: string } | { readonly ok: false; readonly reason: string }

/**
 * Makes (or, on a retry, reuses) a build run's request worktree from the
 * local default branch head. Refuses a path that exists and is not this
 * run's worktree on this run's branch, and a branch the main checkout has
 * checked out.
 */
export async function createRequestWorktree(repo: RepoEntry, runId: string, title: string): Promise<RequestWorktree> {
  if (!existsSync(repo.path)) return { ok: false, reason: `The repo ${repo.name} is registered at ${repo.path}, which does not exist.` }
  const { path, branch } = requestWorktreeNames(repo, runId, title)

  const checkedOut = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repo.path)
  if (checkedOut.code === 0 && checkedOut.stdout === branch) return { ok: false, reason: `The main checkout of ${repo.name} has ${branch} checked out; switch it to another branch first.` }

  if (existsSync(path)) {
    const owner = await worktreeAt(repo.path, path)
    if (owner === undefined || owner.branch !== `refs/heads/${branch}`) return { ok: false, reason: `${path} already exists and is not this team run's worktree; move it away or start with another title.` }
    const base = await runGit(['merge-base', repo.default_branch, branch], repo.path)
    const head = base.code === 0 ? base.stdout : await git(['rev-parse', branch], repo.path)
    return { ok: true, path, branch, baseCommit: head }
  }

  let baseCommit: string
  try {
    baseCommit = await git(['rev-parse', '--verify', `${repo.default_branch}^{commit}`], repo.path)
  } catch (error) {
    return { ok: false, reason: `The default branch ${repo.default_branch} of ${repo.name} could not be read: ${message(error)}` }
  }
  const added = await runGit(['worktree', 'add', '-b', branch, path, baseCommit], repo.path)
  if (added.code !== 0) return { ok: false, reason: `The request worktree could not be made: ${added.stderr}` }
  return { ok: true, path, branch, baseCommit }
}

/** A PR number from a number or a GitHub PR URL, or undefined. */
export function parsePrNumber(value: string | number): number | undefined {
  const text = String(value).trim()
  const match = /^#?(\d+)$/.exec(text) ?? /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/.exec(text)
  const number = match?.[1] === undefined ? Number.NaN : Number(match[1])
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/** Fetches the PR's head from `origin` into the repo's objects; returns its commit. */
export async function fetchPrHead(repo: RepoEntry, pr: number): Promise<{ ok: true; commit: string } | { ok: false; reason: string }> {
  const fetched = await runGit(['fetch', '--no-tags', 'origin', `pull/${pr}/head`], repo.path)
  if (fetched.code !== 0) return { ok: false, reason: `Could not fetch PR ${pr} from origin in ${repo.name}: ${fetched.stderr}` }
  const commit = await runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], repo.path)
  if (commit.code !== 0) return { ok: false, reason: `Fetched PR ${pr} but could not read its head: ${commit.stderr}` }
  return { ok: true, commit: commit.stdout }
}

/** Where member worktrees live: Relay's home `worktrees/`. */
export function defaultMemberWorktreeRoot(): string {
  return join(resolveRelayHome().path, 'worktrees')
}

/**
 * The assignment's own worktree, made on its first run and reused after.
 * `root` is for tests; the scheduler passes only (run, assignment).
 */
export async function ensureMemberWorktree(run: TeamRun, assignment: Assignment, root: string = defaultMemberWorktreeRoot()): Promise<MemberWorktree> {
  if (assignment.runId !== run.id) throw new Error(`assignment ${assignment.id} is not part of team run ${run.id}`)
  const path = join(root, run.repoName, assignment.id)
  const branch = run.kind === 'build' && assignment.kind === 'build' ? `relay/${shortId(run.id)}-${shortId(assignment.id)}-${branchSlug(assignment.memberName)}` : null

  if (existsSync(path)) {
    const owner = await worktreeAt(run.repoPath, path)
    if (owner === undefined) throw new Error(`${path} exists and is not a worktree of ${run.repoName}`)
    if (branch !== null && owner.branch !== `refs/heads/${branch}`) throw new Error(`${path} is a worktree of ${run.repoName} on another branch than ${branch}`)
    const startCommit = assignment.startCommit ?? (await git(['rev-parse', 'HEAD'], path))
    return { path, branch, startCommit }
  }

  const startCommit = await memberStartCommit(run)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (branch !== null) {
    // A branch left by an earlier attempt whose worktree is gone: reuse it rather than fail on -b.
    const exists = (await runGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], run.repoPath)).code === 0
    await git(exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, startCommit], run.repoPath)
    return { path, branch, startCommit: exists ? await git(['rev-parse', 'HEAD'], path) : startCommit }
  }
  await git(['worktree', 'add', '--detach', path, startCommit], run.repoPath)
  return { path, branch: null, startCommit }
}

/** Build run: the request branch's current head; PR review run: the recorded PR head. */
async function memberStartCommit(run: TeamRun): Promise<string> {
  if (run.kind === 'pr-review') return run.baseCommit
  if (run.branch === null) throw new Error(`team run ${run.id} has no request branch`)
  return git(['rev-parse', '--verify', `refs/heads/${run.branch}^{commit}`], run.repoPath)
}

type WorktreeEntry = { readonly path: string; readonly branch: string | null }

/** The repo's worktree at `path`, by `git worktree list --porcelain`, comparing real paths. */
async function worktreeAt(repoPath: string, path: string): Promise<WorktreeEntry | undefined> {
  const listed = await runGit(['worktree', 'list', '--porcelain'], repoPath)
  if (listed.code !== 0) return undefined
  const wanted = real(path)
  for (const block of listed.stdout.split(/\n\n+/)) {
    const lines = block.split('\n')
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    if (worktree === undefined || real(worktree) !== wanted) continue
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) ?? null
    return { path: worktree, branch }
  }
  return undefined
}

/** The real path (symlinks resolved, no trailing separator), or the path itself when it cannot be resolved. */
export function real(path: string): string {
  try {
    return realpathSync(path).replace(new RegExp(`\\${sep}+$`), '')
  } catch {
    return path.replace(new RegExp(`\\${sep}+$`), '')
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The git repo a project folder is in, as a repo entry, for a project whose
 * folder is not among its linked repos: named after its top folder, with the
 * default branch origin's HEAD names (else main). Undefined outside git.
 */
export async function folderRepo(folder: string): Promise<RepoEntry | undefined> {
  const top = await runGit(['rev-parse', '--show-toplevel'], folder).catch(() => undefined)
  if (top === undefined || top.code !== 0 || top.stdout === '') return undefined
  const origin = await runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], top.stdout)
  const defaultBranch = origin.code === 0 && origin.stdout.startsWith('origin/') ? origin.stdout.slice('origin/'.length) : 'main'
  return repoEntrySchema.parse({ name: basename(top.stdout), path: top.stdout, default_branch: defaultBranch, permitted_operations: ['read', 'write'] })
}
