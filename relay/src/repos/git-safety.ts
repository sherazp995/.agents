/**
 * FR-CODE-42 and FR-CODE-43: the git operations no approval can authorise.
 *
 * These are HARD BLOCKS in FR-POL-4's sense, which is a specific and
 * unusual thing in this system: everything else dangerous has an approval
 * path, and these deliberately do not. FR-CODE-42's acceptance criterion
 * says it outright, "no approval button exists for a default-branch push",
 * because a button that exists is a button that gets pressed at the end of a
 * long thread when the operator is tired and the run has been going well.
 *
 * FR-CODE-43's list is enableable only "by config edit plus restart". That
 * is not a lesser approval, it is a different KIND of decision: made in a
 * text editor, in the cold light of day, away from the thread that wants it.
 * A refusal here therefore names the config key rather than offering a
 * choice, so the operator learns where the decision actually lives.
 *
 * WHY THIS PARSES ARGV RATHER THAN TRUSTING A CALLER. The capability layer
 * could simply not offer these operations, and it does not. But FR-CODE-22
 * is explicit that capability-layer refusals are cooperative and must be
 * backed by something else, and this is a second, cheaper layer for the case
 * where a future caller composes a git command from parts.
 */

export type GitSafetyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly reason: string
      /** The config key that would enable it, where one exists. Absent means never enableable. */
      readonly enableWith?: string
    }

/** Branch names that may never be written to, whatever the registry says. */
export function isProtectedBranch(branch: string, defaultBranch: string): boolean {
  const normalised = branch.trim().toLowerCase().replace(/^refs\/heads\//, '')
  const protectedNames = new Set([defaultBranch.toLowerCase(), 'main', 'master', 'trunk', 'production', 'release'])
  return protectedNames.has(normalised)
}

/**
 * Whether a push targets a branch it must never target.
 *
 * A push is `git push <remote> <refspec>`, and the refspec's DESTINATION is
 * what matters: `git push origin relay/x:main` writes to main while naming a
 * Relay branch, which is exactly the shape a check on the source side would
 * wave through.
 */
export function checkPushTarget(args: readonly string[], defaultBranch: string): GitSafetyDecision {
  const refspecs = args.filter((argument) => !argument.startsWith('-')).slice(1)

  for (const refspec of refspecs) {
    // In `src:dst` the destination is what is written. A bare ref is both.
    const destination = refspec.includes(':') ? (refspec.split(':')[1] ?? '') : refspec
    if (destination === '') continue
    if (isProtectedBranch(destination, defaultBranch)) {
      return {
        allowed: false,
        reason:
          `pushing to "${destination}" is hard-blocked (FR-CODE-42). There is no approval that authorises it, and ` +
          'that is deliberate: a button that exists is a button that gets pressed at the end of a long thread. ' +
          'Relay pushes its own relay/* branch and you merge.',
      }
    }
  }

  return { allowed: true }
}

/**
 * FR-CODE-43's list, each with the config key that would enable it.
 *
 * Matched on the ARGUMENTS rather than on a command string, so `--force`
 * and `-f` and `--force-with-lease` are all seen for what they are.
 */
export function checkDestructiveGit(subcommand: string, args: readonly string[]): GitSafetyDecision {
  const flags = new Set(args.filter((argument) => argument.startsWith('-')))

  if (subcommand === 'push') {
    if (flags.has('--force') || flags.has('-f') || [...flags].some((flag) => flag.startsWith('--force-with-lease'))) {
      return {
        allowed: false,
        reason: 'force-push is hard-blocked by default (FR-CODE-43): it can destroy commits that exist only on the remote.',
        enableWith: 'git_safety.allow_force_push',
      }
    }
    // `git push --delete` and `git push origin :branch` both delete a ref.
    if (flags.has('--delete') || flags.has('-d') || args.some((argument) => argument.startsWith(':'))) {
      return {
        allowed: false,
        reason: 'deleting a branch or tag on the remote is hard-blocked by default (FR-CODE-43).',
        enableWith: 'git_safety.allow_remote_delete',
      }
    }
  }

  if (subcommand === 'rebase' || subcommand === 'filter-branch' || subcommand === 'filter-repo') {
    return {
      allowed: false,
      reason: `\`git ${subcommand}\` rewrites history, which is hard-blocked by default (FR-CODE-43).`,
      enableWith: 'git_safety.allow_history_rewrite',
    }
  }

  if (subcommand === 'reset' && (flags.has('--hard') || flags.has('--keep'))) {
    return {
      allowed: false,
      reason: '`git reset --hard` discards work that has not been committed, which is hard-blocked by default (FR-CODE-43).',
      enableWith: 'git_safety.allow_hard_reset',
    }
  }

  if (subcommand === 'clean' && [...flags].some((flag) => /^-[a-z]*[fx]/i.test(flag) || flag === '--force')) {
    return {
      allowed: false,
      reason: '`git clean -fdx` deletes untracked files, including ones no version control can recover, and is hard-blocked by default (FR-CODE-43).',
      enableWith: 'git_safety.allow_clean',
    }
  }

  // FR-CODE-48: merge is never performed by Relay, in any phase. Not a
  // config key, because there is no configuration that turns it on.
  if (subcommand === 'merge') {
    return {
      allowed: false,
      reason: 'Relay never merges, in any phase (FR-CODE-48). You merge, in GitHub, having read the diff.',
    }
  }

  return { allowed: true }
}

/** Both checks, in the order a caller wants them: the branch target first, since it is the one with no escape at all. */
export function checkGitOperation(subcommand: string, args: readonly string[], defaultBranch: string): GitSafetyDecision {
  if (subcommand === 'push') {
    const target = checkPushTarget(args, defaultBranch)
    if (!target.allowed) return target
  }
  return checkDestructiveGit(subcommand, args)
}
