/**
 * The global persona library on disk: one Markdown file per persona under
 * Relay's home `personas/`, git-ignored by a `.gitignore` of its own, so it
 * stays out of git wherever Relay's home is. Agents read these files, not
 * the database (decision 4 in the teams plan).
 *
 * A save is ordered so a failure never leaves a half-written file: the new
 * text goes to a temp file first, the caller commits the row (and its audit
 * entry), and only then is the temp file renamed into place. A failed
 * commit deletes the temp file; a failed rename keeps the old file.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { relayPath } from '../config/paths.js'

export const PERSONAS_FOLDER = 'personas'
const REMOVED_FOLDER = '.removed'
const MAX_SLUG = 40

/** Where the library lives: Relay's home, found the way Relay already finds it. */
export function defaultPersonasDir(): string {
  return relayPath(PERSONAS_FOLDER)
}

/** Makes the folder, with a `.gitignore` holding `*` so nothing in it is ever committed. */
export function ensurePersonasDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const ignore = join(dir, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
}

/** A new file name: the name's slug plus a short random id, fixed for the persona's life. */
export function newPersonaFileName(name: string, id: string = randomBytes(3).toString('hex')): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
  return `${slug === '' ? 'persona' : slug}-${id}.md`
}

/** The file's full path, refusing any name that is not a plain file name inside the folder. */
export function personaPath(dir: string, fileName: string): string {
  if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(fileName)) throw new Error(`"${fileName}" is not a persona file name`)
  const root = resolve(dir)
  const path = resolve(root, fileName)
  if (!path.startsWith(root + sep)) throw new Error(`"${fileName}" is outside the personas folder`)
  return path
}

/** The persona's text, or undefined when its file is missing. */
export function readPersona(dir: string, fileName: string): string | undefined {
  const path = personaPath(dir, fileName)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

export type FileOps = {
  readonly write: (path: string, text: string) => void
  readonly rename: (from: string, to: string) => void
  readonly remove: (path: string) => void
}

const realFileOps: FileOps = {
  write: (path, text) => writeFileSync(path, text, { flag: 'wx' }),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
}

/** Thrown when the row was saved but the file could not be put in place; the old file is kept. */
export class PersonaFileNotSaved extends Error {
  constructor(fileName: string, cause: unknown) {
    super(`The persona was saved, but its file ${fileName} was not updated: ${cause instanceof Error ? cause.message : String(cause)}. The old file is unchanged.`)
    this.name = 'PersonaFileNotSaved'
  }
}

/**
 * Writes `text` as the persona's file around `commit`: temp file, then the
 * caller's commit, then the rename. A commit that throws deletes the temp
 * file and rethrows, so nothing on disk changes.
 */
export async function savePersonaFile<T>(dir: string, fileName: string, text: string, commit: () => Promise<T>, ops: FileOps = realFileOps): Promise<T> {
  const saved = await savePersonaFiles(dir, [{ fileName, text }], commit, ops)
  if (saved.notSaved.length > 0) throw new PersonaFileNotSaved(fileName, saved.notSaved[0]?.error)
  return saved.result
}

export type PersonaFileWrite = { readonly fileName: string; readonly text: string }
export type PersonaFileFailure = { readonly fileName: string; readonly error: unknown }

/**
 * Several persona files around one commit: every temp file is written
 * first, then the caller's commit, then each rename. A failed temp write or
 * commit removes every temp file and rethrows, so nothing on disk changes.
 * After the commit a failed rename is reported, not thrown: the rows are
 * saved, and the caller names the files that were not put in place.
 */
export async function savePersonaFiles<T>(
  dir: string,
  files: readonly PersonaFileWrite[],
  commit: () => Promise<T>,
  ops: FileOps = realFileOps,
): Promise<{ result: T; notSaved: PersonaFileFailure[] }> {
  ensurePersonasDir(dir)
  const staged: { temp: string; target: string; fileName: string }[] = []
  let result: T
  try {
    for (const file of files) {
      const target = personaPath(dir, file.fileName)
      const temp = join(resolve(dir), `.${file.fileName}.${randomBytes(4).toString('hex')}.tmp`)
      ops.write(temp, file.text.endsWith('\n') ? file.text : `${file.text}\n`)
      staged.push({ temp, target, fileName: file.fileName })
    }
    result = await commit()
  } catch (error) {
    for (const file of staged) ops.remove(file.temp)
    throw error
  }
  const notSaved: PersonaFileFailure[] = []
  for (const file of staged) {
    try {
      ops.rename(file.temp, file.target)
    } catch (error) {
      ops.remove(file.temp)
      notSaved.push({ fileName: file.fileName, error })
    }
  }
  return { result, notSaved }
}

/** Moves a removed persona's file to `.removed/<name>-<time>.md`, never over an earlier one. */
export function movePersonaAside(dir: string, fileName: string, now: Date = new Date()): string | undefined {
  const path = personaPath(dir, fileName)
  if (!existsSync(path)) return undefined
  const removed = join(resolve(dir), REMOVED_FOLDER)
  mkdirSync(removed, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const base = `${fileName.replace(/\.md$/, '')}-${stamp}`
  let target = join(removed, `${base}.md`)
  for (let n = 2; existsSync(target); n += 1) target = join(removed, `${base}-${n}.md`)
  renameSync(path, target)
  return target
}
