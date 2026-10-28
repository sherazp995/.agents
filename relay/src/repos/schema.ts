/**
 * FR-CODE-1: the declarative repository registry.
 *
 * The same shape as the profile registry, and for the same reason: this file
 * decides which of the operator's repositories Relay may touch, and an entry
 * that is wrong is not a wrong answer but a real change in the wrong
 * codebase. So the schema makes an unsafe entry unrepresentable rather than
 * merely discouraged.
 *
 * THREE RULES ARE ENFORCED HERE rather than left to a caller:
 *
 *   - `permitted_operations` cannot be empty. An empty list reads naturally
 *     as "nothing permitted" and equally naturally as "not configured yet",
 *     and a registry that cannot tell those apart will be asked to guess.
 *     Same reasoning as FR-PRF-1's allowlist.
 *   - A repo permitting `publish` must declare a `remote`. Publishing is the
 *     one operation that leaves the machine, and a permission to do it with
 *     nowhere to do it to is a statement the operator believes and Relay
 *     cannot honour.
 *   - `off_limits` paths are RELATIVE, and an absolute one is refused. FR-CODE-4's
 *     whole point is marking paths inside an otherwise-permitted repo; an
 *     absolute path there would silently describe somewhere else.
 */

import { z } from 'zod'

/**
 * What a run may do to a repository.
 *
 * `read` and `write` are local. `publish` is the gated door over push and
 * pull-request creation (FR-CODE-47a), and it is a separate permission
 * precisely because it is the one that becomes visible outside the machine.
 */
export const REPO_OPERATIONS = ['read', 'write', 'publish'] as const
export type RepoOperation = (typeof REPO_OPERATIONS)[number]

/** A path inside the repository. Relative on purpose; see the header. */
const relativePath = z
  .string()
  .trim()
  .min(1, 'an off-limits path cannot be empty')
  .refine((value) => !value.startsWith('/'), 'an off-limits path is relative to the repository, so it cannot start with "/"')
  .refine((value) => !value.split('/').includes('..'), 'an off-limits path cannot contain ".."')

export const repoEntrySchema = z
  .object({
    /** Short name, the handle an operator uses in a task. */
    name: z.string().trim().min(1),
    /** Alternative names this repo answers to, matched after the exact name. */
    aliases: z.array(z.string().trim().min(1)).default([]),
    description: z.string().trim().min(1).optional(),
    /** Absolute path to the operator's own checkout. Worktrees are created OUTSIDE it (FR-CODE-16). */
    path: z.string().trim().min(1),
    default_branch: z.string().trim().min(1).default('main'),
    /** The git remote, needed only when `publish` is permitted. */
    remote: z.string().trim().min(1).optional(),
    permitted_operations: z
      .array(z.enum(REPO_OPERATIONS))
      .min(1, 'a repository with no permitted operations is rejected: an empty list cannot be told apart from an unconfigured one'),
    /**
     * FR-CODE-4: paths refused for both reads and writes even though the
     * repository as a whole is permitted. Secrets, credentials, vendored
     * dependencies, generated artifacts.
     */
    off_limits: z.array(relativePath).default([]),
    /** FR-CODE-30's verification command. A run that reports success without running this is refused. */
    test_command: z.string().trim().min(1).optional(),
    /** FR-CODE-31's narrow-test guidance, in the operator's own words, for a purely additive diff. */
    narrow_test_guidance: z.string().trim().min(1).optional(),
    build_command: z.string().trim().min(1).optional(),
    package_manager: z.string().trim().min(1).optional(),
    /**
     * FR-CFG-4a's in-place mode, off by default. It deliberately gives up
     * FR-CODE-10's worktree isolation, so it is opt-in per repository and
     * never inferred.
     */
    in_place: z.boolean().default(false),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.permitted_operations.includes('publish') && entry.remote === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remote'],
        message:
          'a repository that permits `publish` must declare a `remote`. Permission to publish with nowhere to ' +
          'publish to is a statement the operator believes and Relay cannot honour.',
      })
    }
  })

export type RepoEntry = z.infer<typeof repoEntrySchema>

export const repoRegistrySchema = z
  .object({
    version: z.literal(1),
    repos: z.array(repoEntrySchema),
  })
  .strict()
  .superRefine((registry, ctx) => {
    // A name or alias answering to two repos makes resolution
    // non-deterministic in a way no later check can repair: which one wins
    // depends on iteration order.
    const seen = new Map<string, string>()
    for (const [index, repo] of registry.repos.entries()) {
      for (const handle of [repo.name, ...repo.aliases]) {
        const key = handle.trim().toLowerCase()
        const owner = seen.get(key)
        if (owner !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['repos', index, 'name'],
            message: `"${handle}" already refers to repository "${owner}": a handle must resolve to exactly one repository`,
          })
        }
        seen.set(key, repo.name)
      }
    }
  })

export type RepoRegistry = z.infer<typeof repoRegistrySchema>
