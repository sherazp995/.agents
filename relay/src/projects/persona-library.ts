/**
 * Persona changes as the page and the starter team make them: the file and
 * the row (with its audit entry) saved in the order persona-files.ts sets,
 * so a failure never leaves the two out of step in a way the page hides.
 */

import type { Pool } from 'pg'
import { auditedChange } from '../ui/audit.js'
import { movePersonaAside, newPersonaFileName, savePersonaFile, type FileOps } from './persona-files.js'
import { deletePersona, getPersona, insertPersona, renamePersona, StoreConflict } from './store.js'

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
    () => auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'persona created', detail: { name, fileName } }, (client) => insertPersona(client, ctx.workspaceId, { name, fileName })),
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
        if (!(await renamePersona(client, ctx.workspaceId, personaId, name))) throw new StoreConflict('That persona no longer exists.')
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
