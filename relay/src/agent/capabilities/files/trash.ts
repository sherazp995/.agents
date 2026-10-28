/**
 * FR-SH-4: "Deletions are moved to a Relay trash directory with a retention
 * period rather than unlinked, wherever the filesystem allows it."
 *
 * The acceptance criterion is that a "deleted" file is recoverable for seven
 * days, so this is not a nicety. A model deciding to delete something is the
 * one action in this system with no undo, and an agent that is wrong about a
 * delete is wrong in a way its operator cannot fix.
 *
 * "WHEREVER THE FILESYSTEM ALLOWS IT" is the interesting clause. A rename
 * across filesystems fails with EXDEV, and the file being deleted may sit on
 * a different volume from the trash. So the move falls back to copy-then-
 * remove, and if even that fails the DELETE IS ABANDONED rather than
 * completed: an unrecoverable delete is exactly what this exists to prevent,
 * so failing to make it recoverable means not doing it.
 *
 * Each deletion goes into its own timestamped directory, preserving the
 * original path underneath. Two files with the same basename deleted a
 * second apart must not collide, and an operator restoring one needs to know
 * where it came from.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, parse, sep } from 'node:path'

/** FR-SH-4's stated retention. A file is recoverable for this long after a delete. */
export const TRASH_RETENTION_DAYS = 7

export type TrashResult =
  | { readonly ok: true; readonly trashedTo: string; readonly recoverableUntil: string }
  | { readonly ok: false; readonly reason: string }

export type TrashDependencies = {
  readonly now?: () => Date
  readonly move?: (from: string, to: string) => void
  readonly copy?: (from: string, to: string) => void
  readonly remove?: (path: string) => void
  readonly makeDirectory?: (path: string) => void
}

/**
 * A filesystem-safe stamp that sorts chronologically.
 *
 * Colons are legal on macOS's APFS but are the classic portability trap, and
 * a trash directory is exactly the thing an operator eventually copies to
 * another machine to recover from.
 */
export function trashStamp(when: Date): string {
  return when.toISOString().replace(/[:.]/g, '-')
}

/**
 * Turns an absolute source path into a path underneath the trash entry,
 * keeping the original layout so a restore is obvious.
 *
 * The drive letter or leading separator is dropped rather than preserved:
 * joining an absolute path onto another absolute path silently discards the
 * first, which would put every trashed file at the top level and collide.
 */
export function trashRelativePath(source: string): string {
  const parsed = parse(source)
  const withoutRoot = source.slice(parsed.root.length)
  return withoutRoot.split(sep).filter((segment) => segment !== '').join(sep)
}

/** Moves `source` into the trash, or explains why the delete must not proceed. */
export function moveToTrash(source: string, trashRoot: string, deps: TrashDependencies = {}): TrashResult {
  const now = deps.now ?? (() => new Date())
  const makeDirectory = deps.makeDirectory ?? ((path: string) => mkdirSync(path, { recursive: true }))
  const move = deps.move ?? renameSync
  const copy = deps.copy ?? ((from: string, to: string) => cpSync(from, to, { recursive: true }))
  const remove = deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }))

  const when = now()
  const destination = join(trashRoot, trashStamp(when), trashRelativePath(source))

  try {
    makeDirectory(join(destination, '..'))
  } catch (error) {
    return { ok: false, reason: `the trash directory could not be created, so the delete was abandoned rather than made unrecoverable: ${describe(error)}` }
  }

  try {
    move(source, destination)
  } catch (error) {
    // EXDEV: the source is on a different filesystem from the trash, where
    // rename cannot work. Copy then remove instead.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      return { ok: false, reason: `the file could not be moved to the trash, so the delete was abandoned: ${describe(error)}` }
    }
    try {
      copy(source, destination)
      remove(source)
    } catch (fallbackError) {
      return {
        ok: false,
        reason:
          'the file is on a different filesystem from the trash and could not be copied there, so the delete was ' +
          `ABANDONED rather than made unrecoverable (FR-SH-4): ${describe(fallbackError)}`,
      }
    }
  }

  const until = new Date(when.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  return { ok: true, trashedTo: destination, recoverableUntil: until.toISOString() }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Removes trash entries past the retention period.
 *
 * Only directories whose name parses as a stamp this module wrote are
 * considered. A trash root an operator has put something else in is not
 * something to tidy up on their behalf.
 */
export function pruneTrash(trashRoot: string, deps: TrashDependencies = {}): readonly string[] {
  const now = (deps.now ?? (() => new Date()))()
  const remove = deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
  if (!existsSync(trashRoot)) return []

  const cutoff = now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const pruned: string[] = []

  for (const entry of readdirSync(trashRoot)) {
    const parsed = parseTrashStamp(entry)
    if (parsed === undefined) continue
    if (parsed.getTime() >= cutoff) continue
    const path = join(trashRoot, entry)
    try {
      if (!statSync(path).isDirectory()) continue
      remove(path)
      pruned.push(path)
    } catch {
      // A trash entry that cannot be read is left alone rather than being
      // the thing that fails a run.
    }
  }
  return pruned
}

/** The inverse of `trashStamp`, returning undefined for anything this module did not write. */
export function parseTrashStamp(name: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second, millisecond] = match
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}
