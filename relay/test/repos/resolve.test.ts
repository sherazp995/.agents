import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkOffLimits, checkRepoOperation, resolveRepo } from '../../src/repos/resolve.js'
import { repoEntrySchema, repoRegistrySchema } from '../../src/repos/schema.js'

/**
 * FR-CODE-2's rule is the reason this module exists: "Relay never guesses
 * between two repos and never operates a repository absent from the
 * registry." Guessing here does not produce a wrong answer, it produces a
 * real commit in the wrong codebase.
 */

function repo(overrides: Record<string, unknown> = {}) {
  return repoEntrySchema.parse({
    name: 'relay',
    path: '/Users/op/code/relay',
    permitted_operations: ['read', 'write'],
    ...overrides,
  })
}

function registry(...repos: ReturnType<typeof repo>[]) {
  return repoRegistrySchema.parse({ version: 1, repos })
}

describe('resolveRepo refuses rather than guessing', () => {
  it('resolves an exact name', () => {
    const result = resolveRepo('relay', registry(repo()))

    expect(result.outcome).toBe('resolved')
    if (result.outcome !== 'resolved') return
    expect(result.by).toBe('name')
  })

  it('resolves an alias', () => {
    const result = resolveRepo('rl', registry(repo({ aliases: ['rl'] })))

    expect(result.outcome).toBe('resolved')
    if (result.outcome !== 'resolved') return
    expect(result.by).toBe('alias')
  })

  it('resolves an UNAMBIGUOUS fuzzy match', () => {
    const result = resolveRepo('relay', registry(repo({ name: 'relay-server' })))

    expect(result.outcome).toBe('resolved')
    if (result.outcome !== 'resolved') return
    expect(result.by).toBe('fuzzy')
  })

  it('REFUSES an ambiguous fuzzy match instead of ranking them', () => {
    // A score invites exactly the "close enough" behaviour FR-CODE-2 forbids.
    const result = resolveRepo('relay', registry(repo({ name: 'relay-server' }), repo({ name: 'relay-client' })))

    expect(result.outcome).toBe('ambiguous')
    if (result.outcome !== 'ambiguous') return
    expect(result.candidates).toHaveLength(2)
    expect(result.reason).toContain('will not choose between them')
  })

  it('refuses a repository absent from the registry, naming what IS registered', () => {
    const result = resolveRepo('nope', registry(repo()))

    expect(result.outcome).toBe('unresolved')
    if (result.outcome !== 'unresolved') return
    expect(result.reason).toContain('never operates a repository absent from the registry')
    expect(result.reason).toContain('relay')
  })

  it('does NOT default to the only registered repository', () => {
    // This reads as convenience until a second repo is added and every
    // unqualified task silently becomes a coin flip.
    const result = resolveRepo(undefined, registry(repo()))

    expect(result.outcome).toBe('unresolved')
    if (result.outcome !== 'unresolved') return
    expect(result.reason).toContain('even when only one is registered')
  })

  it('prefers an exact name over a fuzzy match that would also hit', () => {
    const result = resolveRepo('relay', registry(repo({ name: 'relay' }), repo({ name: 'relay-server' })))

    expect(result.outcome).toBe('resolved')
    if (result.outcome !== 'resolved') return
    expect(result.repo.name).toBe('relay')
  })
})

describe('the schema refuses an entry that cannot be honoured', () => {
  it('rejects an empty permitted_operations, which cannot be told from unconfigured', () => {
    expect(() => repo({ permitted_operations: [] })).toThrow()
  })

  it('rejects publish without a remote', () => {
    // Permission to publish with nowhere to publish to is a statement the
    // operator believes and Relay cannot honour.
    expect(() => repo({ permitted_operations: ['read', 'write', 'publish'] })).toThrow(/remote/)
  })

  it('accepts publish WITH a remote', () => {
    expect(() => repo({ permitted_operations: ['publish'], remote: 'origin' })).not.toThrow()
  })

  it('rejects an absolute off-limits path, which would describe somewhere else', () => {
    expect(() => repo({ off_limits: ['/etc/passwd'] })).toThrow(/relative/)
  })

  it('rejects a ".." in an off-limits path', () => {
    expect(() => repo({ off_limits: ['../secrets'] })).toThrow(/\.\./)
  })

  it('rejects a handle claimed by two repositories, in either field', () => {
    expect(() => registry(repo({ name: 'relay' }), repo({ name: 'other', aliases: ['relay'] }))).toThrow(/exactly one repository/)
  })
})

describe('checkRepoOperation', () => {
  it('refuses an operation the registry does not list, and says what is permitted', () => {
    const decision = checkRepoOperation(repo({ permitted_operations: ['read'] }), 'write')

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toContain('Permitted: read')
  })

  it('allows a listed operation', () => {
    expect(checkRepoOperation(repo(), 'write').allowed).toBe(true)
  })
})

describe('FR-CODE-4: off-limits paths inside a permitted repository', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-repo-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("refuses a .env inside a registered repo, which is the requirement's acceptance criterion", () => {
    writeFileSync(join(root, '.env'), 'SECRET=1')
    const entry = repo({ path: root, off_limits: ['.env'] })

    const decision = checkOffLimits(entry, join(root, '.env'))

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toContain('off limits')
  })

  it('refuses everything under an off-limits DIRECTORY', () => {
    mkdirSync(join(root, 'secrets'), { recursive: true })
    writeFileSync(join(root, 'secrets', 'key.pem'), 'x')

    expect(checkOffLimits(repo({ path: root, off_limits: ['secrets'] }), join(root, 'secrets', 'key.pem')).allowed).toBe(false)
  })

  it('refuses a SYMLINK that points at an off-limits path', () => {
    // A file named notes.md pointing at .env is the obvious way around a
    // textual check, which is why this resolves first.
    writeFileSync(join(root, '.env'), 'SECRET=1')
    symlinkSync(join(root, '.env'), join(root, 'notes.md'))

    expect(checkOffLimits(repo({ path: root, off_limits: ['.env'] }), join(root, 'notes.md')).allowed).toBe(false)
  })

  it('allows an ordinary path in the same repository', () => {
    writeFileSync(join(root, 'README.md'), '# hi')

    expect(checkOffLimits(repo({ path: root, off_limits: ['.env'] }), join(root, 'README.md')).allowed).toBe(true)
  })

  it('allows everything when nothing is marked off limits', () => {
    expect(checkOffLimits(repo({ path: root }), join(root, 'anything')).allowed).toBe(true)
  })
})
