/**
 * Persona changes as the page and the starter team make them: the file and
 * the row (with its audit entry) saved in the order persona-files.ts sets,
 * so a failure never leaves the two out of step in a way the page hides.
 * The row keeps the text too (`body`), so the other failover laptop, with
 * its own personas folder, reads the same persona.
 */

import type { Pool } from 'pg'
import { auditedChange } from '../ui/audit.js'
import { movePersonaAside, newPersonaFileName, personaFileText, readPersona, savePersonaFile, writePersonaFile, type FileOps } from './persona-files.js'
import { backfillPersonaBody, deletePersona, getPersona, insertPersona, StoreConflict, updatePersona, type Persona } from './store.js'

export type LibraryContext = {
  readonly pool: Pool
  readonly workspaceId: string
  /** Who did it, for the audit entry. */
  readonly actor: string
  /** The personas folder. */
  readonly dir: string
  readonly route: string
  readonly fileOps?: FileOps
}

export async function createPersona(ctx: LibraryContext, name: string, text: string): Promise<string> {
  const fileName = newPersonaFileName(name)
  return savePersonaFile(
    ctx.dir,
    fileName,
    text,
    () => auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'persona created', detail: { name, fileName } }, (client) =>
      insertPersona(client, ctx.workspaceId, { name, fileName, body: personaFileText(text) }),
    ),
    ctx.fileOps,
  )
}

/** Renames the persona and rewrites its file; the file name never changes. */
export async function editPersona(ctx: LibraryContext, personaId: string, name: string, text: string): Promise<void> {
  const persona = await getPersona(ctx.pool, ctx.workspaceId, personaId)
  if (persona === undefined) throw new StoreConflict('That persona no longer exists.')
  await savePersonaFile(
    ctx.dir,
    persona.fileName,
    text,
    async () => {
      await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'persona saved', detail: { personaId, name, fileName: persona.fileName } }, async (client) => {
        if (!(await updatePersona(client, ctx.workspaceId, personaId, { name, body: personaFileText(text) }))) throw new StoreConflict('That persona no longer exists.')
      })
    },
    ctx.fileOps,
  )
}

/**
 * Removes a persona no team uses and moves its file aside; refuses one still
 * on a team. The row is gone once this returns; `fileNotMoved` names a file
 * that could not be moved aside, for the page to report.
 */
export async function removePersona(ctx: LibraryContext, personaId: string, now: Date = new Date()): Promise<{ readonly fileNotMoved?: string }> {
  const persona = await getPersona(ctx.pool, ctx.workspaceId, personaId)
  if (persona === undefined) throw new StoreConflict('That persona no longer exists.')
  await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'persona removed', detail: { personaId, name: persona.name, fileName: persona.fileName } }, async (client) => {
    if (!(await deletePersona(client, ctx.workspaceId, personaId))) throw new StoreConflict('That persona no longer exists.')
  })
  try {
    movePersonaAside(ctx.dir, persona.fileName, now)
    return {}
  } catch {
    return { fileNotMoved: persona.fileName }
  }
}

/**
 * The persona's text, with the database as the copy both laptops share: a
 * stored body wins and is written to this laptop's file when that is missing
 * or different, so agents reading the file see it; a persona saved before
 * bodies existed is backfilled from this laptop's file. Undefined when there
 * is neither. A file that cannot be written is left for the next read.
 */
export async function personaText(pool: Pool, workspaceId: string, dir: string, persona: Pick<Persona, 'id' | 'fileName' | 'body'>): Promise<string | undefined> {
  const onDisk = readPersona(dir, persona.fileName)
  if (persona.body === null) {
    if (onDisk !== undefined) await backfillPersonaBody(pool, workspaceId, persona.id, onDisk)
    return onDisk
  }
  if (onDisk !== persona.body) {
    try {
      writePersonaFile(dir, persona.fileName, persona.body)
    } catch {
      // The text is still right from the database; only the agents' copy is stale.
    }
  }
  return persona.body
}
