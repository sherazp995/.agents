import { describe, expect, it } from 'vitest'

import { addProfile, editOrigins, listRegisteredProfiles, removeProfile } from '../../src/profiles/registry-file.js'

/**
 * This module edits the file that decides which logged-in browser Relay may
 * drive and where it may go. Two of the tests below are the reason it exists
 * at all rather than being a `JSON.parse`/`stringify` round trip:
 *
 *   - comments must survive, because profiles.yaml is mostly explanation
 *   - an edit that would produce an unloadable registry must be REFUSED,
 *     with the caller still holding the original text
 */

const EXISTING = `# Relay browser profile registry, FR-PRF-1.
#
# THIS COMMENT IS LOAD-BEARING: it explains why a clone is needed at all.

version: 1

profiles:
  # The proving profile. Reaches nothing of the operator's.
  - name: scratch
    description: Public-site profile for proving the pipeline.
    user_data_dir: /Users/op/chrome-profiles/scratch
    profile_directory: Default
    classification: work
    allowed_origins:
      - example.com
    pinned_tier: 2
`

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'cohabit',
    description: 'Cohabit client profile.',
    user_data_dir: '/Users/op/chrome-profiles/cohabit',
    classification: 'client' as const,
    allowed_origins: ['cohabit.com.au'],
    pinned_tier: 2 as const,
    ...overrides,
  }
}

describe('editing the registry preserves what a person wrote in it', () => {
  it('keeps the file\'s comments across an edit, since profiles.yaml is mostly explanation', () => {
    // A parse-then-re-serialise implementation deletes every one of these
    // on the first command, and the operator never finds out.
    const result = addProfile(EXISTING, validInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('THIS COMMENT IS LOAD-BEARING')
    expect(result.text).toContain('# The proving profile.')
    expect(result.text).toContain('name: cohabit')
  })

  it('leaves the existing entries alone when it appends', () => {
    const result = addProfile(EXISTING, validInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const names = listRegisteredProfiles(result.text).map((entry) => entry.name)
    expect(names).toEqual(['scratch', 'cohabit'])
  })
})

describe('no edit may produce a registry Relay cannot load', () => {
  it('REFUSES to remove the last allowed origin, because FR-PRF-1 rejects an empty allowlist', () => {
    // The dangerous reading of an empty list is "not configured yet", and a
    // registry that cannot tell that from "nothing permitted" will be asked
    // to guess. Better to refuse the edit than write the ambiguity.
    const result = editOrigins(EXISTING, 'scratch', { remove: ['example.com'] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('nothing was written')
    expect(result.reason).toContain('FR-PRF-1')
  })

  it('refuses an origin pattern the schema rejects, naming the actual problem', () => {
    const result = addProfile(EXISTING, validInput({ allowed_origins: ['not a host'] }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('cannot contain spaces')
  })

  it('refuses a personal profile marked usable, per FR-PRF-5', () => {
    const result = addProfile(EXISTING, validInput({ classification: 'personal', pinned_tier: undefined }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('personal')
  })

  it('refuses to edit a file that is not valid YAML rather than overwriting it', () => {
    const result = addProfile('profiles: [ unterminated', validInput())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not valid YAML')
  })
})

describe('adding a profile', () => {
  it('refuses a duplicate name, and points at the command that changes scope instead', () => {
    // Appending would make the whole file unloadable by the schema's own
    // duplicate rule, which the operator would discover much later.
    const result = addProfile(EXISTING, validInput({ name: 'scratch', classification: 'work' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('already registered')
    expect(result.reason).toContain('profile-origins')
  })

  it('replaces on --force rather than appending', () => {
    const result = addProfile(EXISTING, validInput({ name: 'scratch', classification: 'work' }), { replace: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const entries = listRegisteredProfiles(result.text)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.origins).toEqual(['cohabit.com.au'])
  })

  it('creates a registry from nothing when there is no file yet', () => {
    const result = addProfile(undefined, validInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('version: 1')
    expect(listRegisteredProfiles(result.text).map((entry) => entry.name)).toEqual(['cohabit'])
  })

  it('defaults profile_directory to Default, since Chrome identity is two-part', () => {
    const result = addProfile(undefined, validInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain('profile_directory: Default')
  })

  it('does not write the schema defaults nobody asked for', () => {
    // A generated entry should read like one a person would write.
    const result = addProfile(undefined, validInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).not.toContain('usable:')
    expect(result.text).not.toContain('denied_origins:')
  })
})

describe('changing what a profile may reach', () => {
  it('adds an origin, which is the edit that actually recurs as tasks hit the wall', () => {
    const result = editOrigins(EXISTING, 'scratch', { allow: ['*.example.com'] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(listRegisteredProfiles(result.text)[0]?.origins).toEqual(['example.com', '*.example.com'])
  })

  it('is idempotent, refusing a no-op rather than rewriting the file', () => {
    const result = editOrigins(EXISTING, 'scratch', { allow: ['example.com'] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('already matches')
  })

  it('removes a pattern from both lists, so there is no wrong-list mistake to make', () => {
    const withDeny = editOrigins(EXISTING, 'scratch', { allow: ['*.example.com'], deny: ['ads.example.com'] })
    expect(withDeny.ok).toBe(true)
    if (!withDeny.ok) return

    const removed = editOrigins(withDeny.text, 'scratch', { remove: ['ads.example.com'] })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.text).not.toContain('ads.example.com')
  })

  it('names a profile that is not registered rather than silently doing nothing', () => {
    const result = editOrigins(EXISTING, 'nope', { allow: ['example.org'] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('no profile named "nope"')
  })
})

describe('removing a profile', () => {
  it('unregisters it but says plainly that the cookies are still on disk', () => {
    // Deleting real credential material as a side effect of a config edit
    // would be the wrong default in the irreversible direction.
    const result = removeProfile(EXISTING, 'scratch')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toContain('left on disk')
    expect(listRegisteredProfiles(result.text)).toEqual([])
  })

  it('refuses a name that is not there', () => {
    const result = removeProfile(EXISTING, 'nope')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('no profile named "nope"')
  })

  it('matches the name case-insensitively, like the schema\'s own duplicate rule', () => {
    expect(removeProfile(EXISTING, 'SCRATCH').ok).toBe(true)
  })
})
