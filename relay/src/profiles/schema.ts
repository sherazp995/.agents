/**
 * FR-PRF-1: the declarative profile registry.
 *
 * A profile binds a browser identity to what it is allowed to touch. It is
 * the thing that stops a task about one client's site from acting inside
 * another client's logged-in browser, so the schema's job is to make an
 * unsafe entry unrepresentable rather than merely discouraged.
 *
 * Two rules are enforced here rather than left to a caller:
 *
 *   - An entry with no allowed origins is REJECTED. An empty allowlist reads
 *     naturally as "nothing permitted", but the same shape also reads as "not
 *     configured yet", and a registry that cannot tell those apart will
 *     eventually be asked to guess. FR-PRF-1's own acceptance criterion is
 *     that such an entry is rejected.
 *   - A `personal` profile cannot be marked usable. FR-PRF-5 excludes
 *     personal profiles from all agent use, and the only reason to list one
 *     is to say explicitly that it is excluded, so that a later resolution
 *     naming it fails loudly instead of finding nothing and falling through.
 */

import { z } from 'zod'

/** Work, client, and personal, per FR-PRF-1. The classification drives FR-PRF-4a's tier pinning and FR-PRF-5's exclusion. */
export const PROFILE_CLASSIFICATIONS = ['work', 'client', 'personal'] as const
export type ProfileClassification = (typeof PROFILE_CLASSIFICATIONS)[number]

/**
 * The browser tiers, ordered least to most controlled by Relay.
 *
 * Tier 1 is the Claude-in-Chrome extension, where the extension owns
 * navigation and Relay can only refuse to issue one, then detect where the
 * browser actually went. Tiers 2 and 3 are driver-owned, so Relay prevents
 * an off-allowlist navigation outright. FR-PRF-4 states the difference
 * plainly because describing tier 1 enforcement as absolute would be false.
 */
export const BROWSER_TIERS = [1, 2, 3] as const
export type BrowserTier = (typeof BROWSER_TIERS)[number]

/**
 * An origin pattern. Reused from the policy file's own vocabulary
 * deliberately: an operator should not have to learn two allowlist syntaxes,
 * and two implementations of "does this host match" is two chances to differ
 * on the case that matters.
 */
const originPattern = z
  .string()
  .trim()
  .min(1, 'an origin pattern cannot be empty')
  .refine((value) => !value.includes(' '), 'an origin pattern cannot contain spaces')

export const profileEntrySchema = z
  .object({
    /** Short name, the handle an operator uses in a task and a recipe. */
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    /** The project or client this profile belongs to, matched by FR-PRF-3's resolution step (b). */
    project: z.string().trim().min(1).optional(),
    /** Chrome's own two-part profile identity. Both are needed: a user-data-dir alone does not name a profile within it. */
    user_data_dir: z.string().trim().min(1),
    profile_directory: z.string().trim().min(1),
    classification: z.enum(PROFILE_CLASSIFICATIONS),
    /**
     * FR-PRF-1's acceptance criterion, enforced by the type rather than by a
     * check a caller might skip: at least one allowed origin.
     */
    allowed_origins: z.array(originPattern).min(1, 'a profile with no allowed origins is rejected, per FR-PRF-1'),
    denied_origins: z.array(originPattern).default([]),
    /** The capabilities this profile permits, narrowing whatever policy already allows. Absent means no narrowing. */
    capabilities: z.array(z.string().trim().min(1)).optional(),
    /** Whether the Claude-in-Chrome extension is present, which is what makes tier 1 a candidate at all. */
    extension: z.boolean().default(false),
    /**
     * FR-PRF-4a: pin a client profile to a tier where origin scoping is
     * ENFORCED rather than merely detected. Only 2 or 3 qualify, so the type
     * refuses a pin to tier 1 rather than accepting one and quietly failing
     * to honour it.
     */
    pinned_tier: z.union([z.literal(2), z.literal(3)]).optional(),
    /**
     * FR-PRF-5: a personal profile is listed only to declare it excluded.
     * Present so that naming one resolves to an explicit refusal instead of
     * finding nothing, which would be indistinguishable from a typo.
     */
    usable: z.boolean().default(true),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // FR-PRF-5. A personal profile marked usable is not a configuration the
    // system should accept and then ignore: it is a statement the operator
    // may believe, so it is refused at load with the reason named.
    if (entry.classification === 'personal' && entry.usable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usable'],
        message:
          'a personal profile cannot be usable, per FR-PRF-5. List it with usable: false to declare it excluded, ' +
          'so that a task naming it is refused rather than silently unmatched.',
      })
    }
    // A pin is a promise that scoping is enforced. Promising that for a
    // profile whose browser Relay does not drive would be a lie the operator
    // relies on, so the combination is refused at configuration time, which
    // is FR-PRF-4a's own "setup never accepts a pin it cannot honour".
    if (entry.pinned_tier !== undefined && entry.classification === 'personal') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pinned_tier'],
        message: 'a personal profile is excluded from agent use entirely, so a tier pin is meaningless',
      })
    }
  })

export type ProfileEntry = z.infer<typeof profileEntrySchema>

export const profileRegistrySchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(profileEntrySchema),
  })
  .strict()
  .superRefine((registry, ctx) => {
    // A duplicate name makes resolution non-deterministic in a way no later
    // check can repair: two entries answer to one handle and which one wins
    // depends on iteration order.
    const seen = new Set<string>()
    for (const [index, profile] of registry.profiles.entries()) {
      const key = profile.name.toLowerCase()
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['profiles', index, 'name'],
          message: `duplicate profile name "${profile.name}": a name must resolve to exactly one profile`,
        })
      }
      seen.add(key)
    }
  })

export type ProfileRegistry = z.infer<typeof profileRegistrySchema>
