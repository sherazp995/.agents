/**
 * FR-CODE-10, 11, 15 and 16: creating the git worktree a coding run happens
 * in.
 *
 * THE GUARANTEE THIS EXISTS FOR is NFR-20: zero observed modifications to
 * the operator's primary working tree or checked-out branch. A coding agent
 * that edits the checkout the operator is sitting in front of is not a tool,
 * it is an accident waiting for a moment of inattention.
 *
 * FOUR RULES, each from its own requirement, and the last two are the ones
 * that are easy to get subtly wrong:
 *
 *   - FR-CODE-10: a dedicated worktree on a named branch, `relay/<run-id>-<slug>`.
 *   - FR-CODE-11: based on the default-branch tip unless told otherwise, and
 *     the base commit is RECORDED, so a diff can be read against a known
 *     point rather than against whatever the branch has since become.
 *   - FR-CODE-16: created OUTSIDE the registered repository, under a
 *     Relay-owned root. A worktree inside the repo would show up in the
 *     operator's own `git status`, and "no Relay file is ever written into
 *     the operator's repo working tree" would be false the moment it existed.
 *   - FR-CODE-15: refused when free disk space is below a floor. A worktree
 *     of a large repository is not small, and the failure mode without this
 *     is filling the operator's disk, which breaks far more than the run.
 *
 * Every git invocation goes through an injected runner, so the rules are
 * testable without a repository, and the one integration test that does use
 * a real repository proves the runner is wired correctly.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { existsSync, mkdirSync, statfsSync } from 'node:fs'
import { join } from 'node:path'

import { resolveRelayHome } from '../config/paths.js'
import type { RepoEntry } from './schema.js'

/** FR-CODE-15's floor. Below this, creating a worktree is refused rather than attempted. */
export const MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024

export type GitRunner = (args: readonly string[], cwd: string) => string

export type WorktreeDependencies = {
  readonly git?: GitRunner
  readonly freeBytes?: (path: string) => number | undefined
  readonly makeDirectory?: (path: string) => void
  readonly pathExists?: (path: string) => boolean
  readonly worktreeRoot?: string
}

export type WorktreeCreation =
  | {
      readonly outcome: 'created'
      readonly path: string
      readonly branch: string
      /** FR-CODE-11: recorded so the run record names the exact base. */
      readonly baseCommit: string
    }
  | { readonly outcome: 'refused'; readonly reason: string }

function defaultGit(args: readonly string[], cwd: string): string {
  const options: ExecFileSyncOptions = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  return String(execFileSync('git', args as string[], options)).trim()
}

function defaultFreeBytes(path: string): number | undefined {
  try {
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    // Unable to tell. The caller treats this as "do not refuse", because a
    // disk check that cannot run should not be the thing that stops every
    // coding run on a platform where statfs behaves differently.
    return undefined
  }
}

/**
 * A branch-name-safe slug.
 *
 * Git refuses a great many things in a ref name, and the failure arrives as
 * an opaque git error at worktree creation rather than as anything about the
 * task's title. Everything outside a conservative set is collapsed to a
 * hyphen, and the result is bounded so a long task title cannot produce a
 * ref name the filesystem rejects.
 */
export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug === '' ? 'task' : slug
}

/** FR-CODE-10's branch name. One shape, derived, so two runs cannot collide and a branch is always attributable to a run. */
export function worktreeBranchName(runId: string, title: string): string {
  return `relay/${runId}-${branchSlug(title)}`
}

/** FR-CODE-16's location: Relay-owned, outside the repository, never inside it. */
export function worktreePath(repoName: string, runId: string, root?: string): string {
  return join(root ?? join(resolveRelayHome().path, 'worktrees'), repoName, runId)
}

/**
 * Creates the worktree for a run, or refuses with a reason.
 *
 * Never throws for an ordinary problem: the caller is a capability that must
 * report an outcome to the operator, not translate an exception.
 */
export function createWorktree(
  repo: RepoEntry,
  runId: string,
  title: string,
  deps: WorktreeDependencies = {},
): WorktreeCreation {
  const git = deps.git ?? defaultGit
  const exists = deps.pathExists ?? existsSync
  const makeDirectory = deps.makeDirectory ?? ((path: string) => mkdirSync(path, { recursive: true }))
  const freeBytes = deps.freeBytes ?? defaultFreeBytes

  if (!exists(repo.path)) {
    return { outcome: 'refused', reason: `repository "${repo.name}" is registered at "${repo.path}", which does not exist.` }
  }

  const destination = worktreePath(repo.name, runId, deps.worktreeRoot)

  // FR-CODE-16, checked rather than assumed: a worktree root misconfigured
  // to sit inside the repository would put Relay's files in the operator's
  // own `git status`, and the isolation guarantee would be quietly false.
  if (isInsideRepo(repo.path, destination)) {
    return {
      outcome: 'refused',
      reason:
        `the worktree would be created at "${destination}", which is inside the repository at "${repo.path}". ` +
        'FR-CODE-16 requires worktrees to live outside the repo, so Relay never writes into the operator\'s own ' +
        'working tree. Point the worktree root somewhere else.',
    }
  }

  // FR-CODE-15: refuse before creating, not after filling the disk.
  const free = freeBytes(join(destination, '..'))
  if (free !== undefined && free < MINIMUM_FREE_BYTES) {
    return {
      outcome: 'refused',
      reason:
        `only ${formatBytes(free)} of free disk space remains, below Relay's ${formatBytes(MINIMUM_FREE_BYTES)} floor, ` +
        'so the worktree was not created (FR-CODE-15). A worktree of a large repository is not small, and filling ' +
        'the disk breaks considerably more than this run.',
    }
  }

  const branch = worktreeBranchName(runId, title)

  let baseCommit: string
  try {
    // FR-CODE-11: the default-branch tip, resolved to a concrete commit so
    // the run record names a point that cannot move underneath it.
    baseCommit = git(['rev-parse', repo.default_branch], repo.path)
  } catch (error) {
    return {
      outcome: 'refused',
      reason:
        `the base branch "${repo.default_branch}" could not be resolved in "${repo.path}": ${describe(error)}. ` +
        'The registry names it as this repository\'s default branch.',
    }
  }

  try {
    makeDirectory(join(destination, '..'))
    git(['worktree', 'add', '-b', branch, destination, baseCommit], repo.path)
  } catch (error) {
    return { outcome: 'refused', reason: `the worktree could not be created: ${describe(error)}` }
  }

  return { outcome: 'created', path: destination, branch, baseCommit }
}

/** Compared by path segment, not by prefix, for the same reason everywhere else in this codebase is. */
function isInsideRepo(repoPath: string, candidate: string): boolean {
  const normalisedRepo = repoPath.replace(/\/+$/, '')
  return candidate === normalisedRepo || candidate.startsWith(`${normalisedRepo}/`)
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // execFileSync puts git's own message on stderr, which is the useful part.
    const stderr = (error as { stderr?: Buffer | string }).stderr
    const detail = stderr === undefined ? '' : String(stderr).trim()
    return detail === '' ? error.message : detail
  }
  return String(error)
}
