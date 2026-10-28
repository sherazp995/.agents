/**
 * FR-SH-2's path scoping: the check that decides whether a filesystem
 * operation is inside the roots this installation permits.
 *
 * The requirement's acceptance criterion is one line, and it is the whole
 * design: "Reading `~/.ssh/id_rsa` is refused by default." Everything here
 * exists to make that true for the paths nobody thought to enumerate, not
 * just for that one.
 *
 * FOUR WAYS A PATH ESCAPES A ROOT, and all four are handled here because
 * three of them look fine to a naive string comparison:
 *
 *   1. `..` traversal. Resolved away before comparison.
 *   2. A SYMLINK pointing out. `<root>/link -> /Users/op/.ssh` passes any
 *      textual check and reads a different directory. The real path is
 *      resolved, so the comparison is against where the path actually goes.
 *   3. A PREFIX that is not a path boundary. `/work/project-secrets` starts
 *      with `/work/project`, so `startsWith` alone admits a sibling.
 *      Compared segment-wise instead.
 *   4. A path that does not exist YET, which is normal for a write. Its
 *      nearest existing ancestor is resolved instead, so a write through a
 *      symlinked parent is still caught.
 *
 * The scope is checked against the RESOLVED path in every case, so a
 * decision here is about the file the operation will really touch.
 */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export type ScopeDecision =
  | { readonly allowed: true; readonly path: string }
  | { readonly allowed: false; readonly path: string; readonly reason: string }

/**
 * Resolves a path all the way to a real location, following symlinks.
 *
 * For a path that does not exist yet, the nearest existing ancestor is
 * resolved and the remainder appended. Without this, a write to
 * `<root>/link/new-file`, where `link` points outside, would be checked
 * against a path that cannot be resolved and would have to be either
 * refused (breaking ordinary writes) or accepted unresolved (the escape).
 */
export function resolveRealPath(candidate: string): string {
  const absolute = resolve(candidate)
  let existing = absolute
  const trailing: string[] = []

  while (!existsSync(existing)) {
    const parent = dirname(existing)
    // Reached the filesystem root without finding anything that exists.
    if (parent === existing) return absolute
    trailing.unshift(existing.slice(parent.length + 1))
    existing = parent
  }

  try {
    return trailing.length === 0 ? realpathSync(existing) : resolve(realpathSync(existing), ...trailing)
  } catch {
    return absolute
  }
}

/**
 * Whether `child` is inside `parent`, compared by path SEGMENT.
 *
 * `startsWith` would accept `/work/project-secrets` for a root of
 * `/work/project`, which is a different directory that merely shares a
 * prefix. This project has already shipped that exact bug once, in
 * profile-clone's containment check.
 */
export function isInside(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/**
 * Checks a path against the permitted roots.
 *
 * An EMPTY root list refuses everything, deliberately. "No roots configured"
 * and "no access permitted" are the same answer, and the alternative,
 * treating an unconfigured scope as unrestricted, is how a capability meant
 * to be narrow ends up with the whole filesystem.
 */
export function checkPathScope(candidate: string, roots: readonly string[]): ScopeDecision {
  const resolved = resolveRealPath(candidate)

  if (roots.length === 0) {
    return {
      allowed: false,
      path: resolved,
      reason:
        'no filesystem roots are configured, so every path is refused (FR-SH-2). Add `filesystem.roots` to ' +
        'config/policy.yaml naming the directories a task may work in. An unconfigured scope is not an open one.',
    }
  }

  const resolvedRoots = roots.map(resolveRealPath)
  if (resolvedRoots.some((root) => isInside(root, resolved))) return { allowed: true, path: resolved }

  return {
    allowed: false,
    path: resolved,
    reason:
      `"${resolved}" is outside every configured filesystem root, so it was refused before anything was read or ` +
      `written (FR-SH-2). Permitted roots: ${resolvedRoots.join(', ')}. Note that this is the path AFTER resolving ` +
      'symlinks and "..", which is the path the operation would really have touched.',
  }
}
