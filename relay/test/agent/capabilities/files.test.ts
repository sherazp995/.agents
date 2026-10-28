import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MAX_FILE_READ_CHARACTERS, runFiles } from '../../../src/agent/capabilities/files/index.js'
import { checkPathScope, isInside, resolveRealPath } from '../../../src/agent/capabilities/files/scope.js'
import { moveToTrash, parseTrashStamp, pruneTrash, trashRelativePath, TRASH_RETENTION_DAYS } from '../../../src/agent/capabilities/files/trash.js'

/**
 * FR-SH-2's acceptance criterion is a single sentence, and it is the reason
 * most of this file exists: "Reading `~/.ssh/id_rsa` is refused by default."
 * The tests below are about the paths nobody thought to enumerate, because
 * that one is easy and the others are how the scope actually leaks.
 */

let root: string
let outside: string
let trash: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-files-root-'))
  outside = mkdtempSync(join(tmpdir(), 'relay-files-outside-'))
  trash = mkdtempSync(join(tmpdir(), 'relay-files-trash-'))
})

afterEach(() => {
  for (const path of [root, outside, trash]) rmSync(path, { recursive: true, force: true })
})

function run(input: Record<string, unknown>) {
  return runFiles(input, { roots: [root], trashRoot: trash })
}

describe('FR-SH-2: reading outside the roots is refused by default', () => {
  it("refuses ~/.ssh/id_rsa, which is the requirement's own acceptance criterion", async () => {
    const result = await run({ operation: 'read', path: join(homedir(), '.ssh', 'id_rsa') })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('outside every configured filesystem root')
  })

  it('refuses a `..` traversal out of a root', async () => {
    const result = await run({ operation: 'read', path: join(root, '..', 'escape.txt') })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('outside every configured')
  })

  it('refuses a path reached through a SYMLINK pointing out of the root', async () => {
    // The escape a textual check cannot see: the path is inside the root by
    // every string comparison, and reads a different directory entirely.
    writeFileSync(join(outside, 'secret.txt'), 'the secret')
    symlinkSync(outside, join(root, 'link'))

    const result = await run({ operation: 'read', path: join(root, 'link', 'secret.txt') })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('AFTER resolving symlinks')
  })

  it('refuses a SIBLING whose name merely starts with the root, not a path boundary', async () => {
    // `/work/project-secrets` starts with `/work/project`. This project has
    // already shipped that exact bug once, in profile-clone.
    expect(isInside('/work/project', '/work/project-secrets')).toBe(false)
    expect(isInside('/work/project', '/work/project/src')).toBe(true)
    expect(isInside('/work/project', '/work/project')).toBe(true)
  })

  it('REFUSES EVERYTHING when no roots are configured, since unconfigured is not open', async () => {
    const result = await runFiles({ operation: 'read', path: join(root, 'a.txt') }, { roots: [], trashRoot: trash })

    expect(result.ok).toBe(false)
    expect(result.refused).toContain('no filesystem roots are configured')
  })

  it('allows a path genuinely inside a root', async () => {
    writeFileSync(join(root, 'ok.txt'), 'inside')

    const result = await run({ operation: 'read', path: join(root, 'ok.txt') })

    expect(result.ok).toBe(true)
    expect(result.content).toBe('inside')
  })

  it('checks BOTH paths of a copy, so a copy out of scope is not an exfiltration route', async () => {
    writeFileSync(join(root, 'data.txt'), 'sensitive')

    const result = await run({ operation: 'copy', path: join(root, 'data.txt'), destination: join(outside, 'stolen.txt'), confirm: true })

    expect(result.ok).toBe(false)
    expect(existsSync(join(outside, 'stolen.txt'))).toBe(false)
  })
})

describe('resolveRealPath handles a path that does not exist yet', () => {
  it('resolves through a symlinked parent for a file about to be created', async () => {
    // A write to <root>/link/new-file must be judged by where `link` goes.
    symlinkSync(outside, join(root, 'link'))

    expect(resolveRealPath(join(root, 'link', 'new-file.txt'))).toBe(join(resolveRealPath(outside), 'new-file.txt'))
  })
})

describe('FR-SH-3: a mutating operation previews before it acts', () => {
  it('returns what WOULD change and changes nothing', async () => {
    const target = join(root, 'new.txt')

    const result = await run({ operation: 'write', path: target, content: 'hello' })

    expect(result.ok).toBe(true)
    expect(result.preview?.affected).toContain(resolveRealPath(target))
    expect(existsSync(target)).toBe(false)
  })

  it('marks a delete irreversible, so it previews whatever the count', async () => {
    writeFileSync(join(root, 'gone.txt'), 'x')

    const result = await run({ operation: 'delete', path: join(root, 'gone.txt') })

    expect(result.preview?.irreversible).toBe(true)
    expect(existsSync(join(root, 'gone.txt'))).toBe(true)
  })

  it('carries the change out on confirmation', async () => {
    const target = join(root, 'new.txt')

    await run({ operation: 'write', path: target, content: 'hello', confirm: true })

    expect(readFileSync(target, 'utf8')).toBe('hello')
  })

  it('does NOT preview a read, which changes nothing', async () => {
    writeFileSync(join(root, 'r.txt'), 'x')

    const result = await run({ operation: 'read', path: join(root, 'r.txt') })

    expect(result.preview).toBeUndefined()
    expect(result.content).toBe('x')
  })
})

describe('FR-SH-4: a delete is recoverable', () => {
  it('moves the file to the trash rather than unlinking it, and says until when', async () => {
    const target = join(root, 'doomed.txt')
    writeFileSync(target, 'still here')

    const result = await run({ operation: 'delete', path: target, confirm: true })

    expect(result.ok).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(result.trashed_to as string, 'utf8')).toBe('still here')
    expect(result.recoverable_until).toBeDefined()
  })

  it('ABANDONS the delete when it cannot be made recoverable', async () => {
    // An unrecoverable delete is exactly what this exists to prevent, so
    // failing to make it recoverable means not doing it at all.
    const removed: string[] = []
    const result = moveToTrash('/some/file', trash, {
      move: () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
      },
      copy: () => {
        throw new Error('destination full')
      },
      remove: (path) => removed.push(path),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('ABANDONED')
    expect(removed).toEqual([])
  })

  it('falls back to copy-then-remove across filesystems, where rename cannot work', async () => {
    const copied: Array<[string, string]> = []
    const removed: string[] = []
    const result = moveToTrash('/some/file', trash, {
      move: () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
      },
      copy: (from, to) => copied.push([from, to]),
      remove: (path) => removed.push(path),
    })

    expect(result.ok).toBe(true)
    expect(copied).toHaveLength(1)
    expect(removed).toEqual(['/some/file'])
  })

  it('keeps the original path under the trash entry, so a restore is obvious', () => {
    expect(trashRelativePath('/Users/op/work/notes.md')).toBe(join('Users', 'op', 'work', 'notes.md'))
  })

  it('gives each delete its own stamp, so two files of the same name do not collide', () => {
    const stamp = parseTrashStamp('2026-08-13T12-00-00-000Z')

    expect(stamp?.toISOString()).toBe('2026-08-13T12:00:00.000Z')
    expect(parseTrashStamp('not-a-stamp')).toBeUndefined()
  })
})

describe('pruneTrash honours the retention period', () => {
  it('removes an entry past 7 days and keeps a recent one', () => {
    const old = join(trash, '2020-01-01T00-00-00-000Z')
    const recent = join(trash, '2026-08-13T00-00-00-000Z')
    mkdirSync(old, { recursive: true })
    mkdirSync(recent, { recursive: true })

    const pruned = pruneTrash(trash, { now: () => new Date('2026-08-14T00:00:00.000Z') })

    expect(pruned).toContain(old)
    expect(pruned).not.toContain(recent)
  })

  it('leaves anything it did not write alone', () => {
    mkdirSync(join(trash, 'operator-put-this-here'), { recursive: true })

    expect(pruneTrash(trash, { now: () => new Date('2030-01-01T00:00:00.000Z') })).toEqual([])
  })

  it('retains for the number of days the requirement states', () => {
    expect(TRASH_RETENTION_DAYS).toBe(7)
  })
})

describe('reading is bounded', () => {
  it('truncates a very large file rather than returning all of it', async () => {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(MAX_FILE_READ_CHARACTERS + 500))

    const result = await run({ operation: 'read', path: join(root, 'big.txt') })

    expect(result.truncated).toBe(true)
    expect(result.content?.length).toBeLessThan(MAX_FILE_READ_CHARACTERS + 200)
  })
})

describe('scope decisions carry the resolved path, so a refusal is legible', () => {
  it('names the path the operation would really have touched', () => {
    const decision = checkPathScope(join(root, '..', 'elsewhere'), [root])

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toContain('AFTER resolving')
  })
})
