/**
 * FR-CODE-2 and FR-CODE-4: binding a coding task to exactly one repository,
 * or refusing, and deciding which paths inside it stay off limits.
 *
 * FR-CODE-2 states the rule the whole module exists for: "Relay never
 * guesses between two repos and never operates a repository absent from the
 * registry." Guessing here does not produce a wrong answer, it produces a
 * real commit in the wrong codebase, so there are three outcomes and no
 * default, exactly as in profile resolution.
 *
 * The ladder is explicit name, then alias, then an UNAMBIGUOUS fuzzy match,
 * then a question. "Unambiguous" is doing the work in that sentence: a fuzzy
 * match that hits two repositories is an ambiguity to report, never a
 * ranking to pick the top of. There is no scoring, because a score invites
 * exactly the "close enough" behaviour the requirement forbids.
 *
 * Pure, with no I/O, so the whole decision table is exhaustively testable.
 */

import { isInside, resolveRealPath } from '../agent/capabilities/files/scope.js'
import { join } from 'node:path'
import type { RepoEntry, RepoOperation, RepoRegistry } from './schema.js'

export type RepoResolution =
  | { readonly outcome: 'resolved'; readonly repo: RepoEntry; readonly by: 'name' | 'alias' | 'fuzzy' }
  | { readonly outcome: 'ambiguous'; readonly candidates: readonly RepoEntry[]; readonly reason: string }
  | { readonly outcome: 'unresolved'; readonly reason: string }

const normalise = (value: string): string => value.trim().toLowerCase()

/**
 * Resolves `requested` against the registry.
 *
 * Note what is deliberately absent: there is no "if only one repository is
 * registered, use it". That reads as convenience until the day a second is
 * added and every unqualified task silently starts hitting a coin flip.
 */
export function resolveRepo(requested: string | undefined, registry: RepoRegistry): RepoResolution {
  if (requested === undefined || requested.trim() === '') {
    return {
      outcome: 'unresolved',
      reason:
        'no repository was named. A coding task must say which repository it is for; Relay does not infer one, ' +
        `even when only one is registered. Registered: ${describeRegistered(registry)}.`,
    }
  }

  const wanted = normalise(requested)

  const byName = registry.repos.filter((repo) => normalise(repo.name) === wanted)
  if (byName.length === 1) return { outcome: 'resolved', repo: byName[0] as RepoEntry, by: 'name' }

  const byAlias = registry.repos.filter((repo) => repo.aliases.some((alias) => normalise(alias) === wanted))
  if (byAlias.length === 1) return { outcome: 'resolved', repo: byAlias[0] as RepoEntry, by: 'alias' }

  // Fuzzy: substring in either direction, so "relay" finds "relay-server"
  // and "my relay repo" finds "relay". Only accepted when exactly one
  // repository matches.
  const fuzzy = registry.repos.filter((repo) =>
    [repo.name, ...repo.aliases].some((handle) => {
      const candidate = normalise(handle)
      return candidate.includes(wanted) || wanted.includes(candidate)
    }),
  )
  if (fuzzy.length === 1) return { outcome: 'resolved', repo: fuzzy[0] as RepoEntry, by: 'fuzzy' }
  if (fuzzy.length > 1) {
    return {
      outcome: 'ambiguous',
      candidates: fuzzy,
      reason:
        `"${requested}" matches ${fuzzy.length} registered repositories: ${fuzzy.map((repo) => repo.name).join(', ')}. ` +
        'Relay will not choose between them. Name one exactly.',
    }
  }

  return {
    outcome: 'unresolved',
    reason:
      `no registered repository matches "${requested}", and Relay never operates a repository absent from the ` +
      `registry (FR-CODE-2). Registered: ${describeRegistered(registry)}.`,
  }
}

function describeRegistered(registry: RepoRegistry): string {
  if (registry.repos.length === 0) return 'none. Add one to config/repos.yaml'
  return registry.repos.map((repo) => repo.name).join(', ')
}

export type OperationDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

/** FR-CODE-1: an operation the registry does not list is refused, not merely discouraged. */
export function checkRepoOperation(repo: RepoEntry, operation: RepoOperation): OperationDecision {
  if (repo.permitted_operations.includes(operation)) return { allowed: true }
  return {
    allowed: false,
    reason:
      `"${operation}" is not a permitted operation on repository "${repo.name}". Permitted: ` +
      `${repo.permitted_operations.join(', ')}. Add it to config/repos.yaml if that is intended.`,
  }
}

/**
 * FR-CODE-4: whether a path inside a permitted repository is off limits.
 *
 * Its acceptance criterion is "a `.env` inside a registered repo is
 * refused", so this is checked against the RESOLVED path for the same reason
 * FR-SH-2's scope is: a symlink named `notes.md` pointing at `.env` is the
 * obvious way around a textual check.
 */
export function checkOffLimits(repo: RepoEntry, candidate: string): OperationDecision {
  if (repo.off_limits.length === 0) return { allowed: true }

  const resolved = resolveRealPath(candidate)
  for (const entry of repo.off_limits) {
    const forbidden = resolveRealPath(join(repo.path, entry))
    if (isInside(forbidden, resolved)) {
      return {
        allowed: false,
        reason:
          `"${resolved}" is inside "${entry}", which repository "${repo.name}" marks off limits (FR-CODE-4), so it ` +
          'is refused for both reads and writes even though the repository itself is permitted.',
      }
    }
  }
  return { allowed: true }
}
