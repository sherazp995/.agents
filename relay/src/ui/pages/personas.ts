/**
 * The global persona library: one Markdown file per persona, shared by
 * every project's team. Editing a persona changes it for every team using
 * it, so each persona shows which projects use it. A persona Relay wrote
 * from an approved team proposal carries a "written by Relay" mark.
 */

import { PersonaFileNotSaved, readPersona } from '../../projects/persona-files.js'
import { createPersona, editPersona, removePersona, type LibraryContext } from '../../projects/persona-library.js'
import { getPersona, listPersonas, StoreConflict, type Persona } from '../../projects/store.js'
import { notFound, pageResult, savedRedirect, type HandlerResult, type RequestContext } from '../context.js'
import { buttonClass, csrfField, html, TEAM_RUN_NOTE, page, postButton } from '../html.js'

const PERSONAS_CRUMB = { label: 'Personas', href: '/personas' } as const
const RELAY_MARK = html`<span class="badge badge-info">written by Relay</span>`

function library(ctx: RequestContext): LibraryContext {
  return { pool: ctx.pool, workspaceId: ctx.workspaceId, actor: ctx.actor, dir: ctx.deps.personasDir, route: ctx.route }
}

export async function listPersonasPage(ctx: RequestContext): Promise<HandlerResult> {
  const personas = await listPersonas(ctx.pool, ctx.workspaceId)
  const rows = personas.map((persona) => {
    const missing = readPersona(ctx.deps.personasDir, persona.fileName) === undefined
    return html`<tr>
      <th scope="row"><a href="/personas/${persona.id}">${persona.name}</a>${persona.writtenByRelay ? html` ${RELAY_MARK}` : ''}</th>
      <td><code>${persona.fileName}</code>${missing ? html` <span class="badge badge-danger">file missing</span>` : ''}</td>
      <td>${persona.projects.length === 0 ? html`<span class="muted">not on a team</span>` : persona.projects.join(', ')}</td>
    </tr>`
  })
  const body = html`<p class="note">${TEAM_RUN_NOTE}</p>
    <p>Personas are shared: one persona can be on any project's team, and editing it changes it everywhere. Files live in <code>${ctx.deps.personasDir}</code>, kept out of git.</p>
    ${personas.length === 0
      ? html`<div class="empty"><h3>No personas yet</h3><p>A persona is the instructions a team member works by. Write one here, or let a project's team proposal or template make them.</p><a class="${buttonClass('primary')}" href="/personas/new">Write the first persona</a></div>`
      : html`<div class="actions-row"><a class="${buttonClass('primary')}" href="/personas/new">New persona</a></div>
        <div class="table-wrap"><table>
          <caption>The persona library</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">File</th><th scope="col">Used by</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`}`
  return pageResult(page({ title: 'Personas', csrf: ctx.csrf }, body))
}

export async function newPersonaPage(ctx: RequestContext): Promise<HandlerResult> {
  return pageResult(personaForm(ctx, undefined, '', undefined))
}

export async function editPersonaPage(ctx: RequestContext): Promise<HandlerResult> {
  const persona = await getPersona(ctx.pool, ctx.workspaceId, ctx.params[0] ?? '')
  if (persona === undefined) return notFound(page({ title: 'Persona not found', csrf: ctx.csrf, crumbs: [PERSONAS_CRUMB] }, html`<p><a href="/personas">Back to personas</a></p>`))
  return pageResult(personaForm(ctx, persona, readPersona(ctx.deps.personasDir, persona.fileName), undefined))
}

export async function createPersonaAction(ctx: RequestContext): Promise<HandlerResult> {
  const { name, text } = fields(ctx)
  if (name === '') return refused(ctx, undefined, 'Give the persona a name.')
  try {
    const id = await createPersona(library(ctx), name, text)
    return savedRedirect(`/personas/${id}`, 'persona created')
  } catch (error) {
    // The row (and its audit entry) committed; only the file failed, and the list shows it as missing.
    if (error instanceof PersonaFileNotSaved) return { ...(await refused(ctx, undefined, error.message)), audited: true }
    throw error
  }
}

export async function updatePersonaAction(ctx: RequestContext): Promise<HandlerResult> {
  const persona = await getPersona(ctx.pool, ctx.workspaceId, ctx.params[0] ?? '')
  if (persona === undefined) return notFound(page({ title: 'Persona not found', csrf: ctx.csrf }, html``))
  const { name, text } = fields(ctx)
  if (name === '') return refused(ctx, persona, 'Give the persona a name.')
  try {
    await editPersona(library(ctx), persona.id, name, text)
  } catch (error) {
    if (error instanceof StoreConflict) return refused(ctx, persona, error.message)
    // The row (and its audit entry) committed; only the file failed.
    if (error instanceof PersonaFileNotSaved) return { ...(await refused(ctx, persona, error.message)), audited: true }
    throw error
  }
  return savedRedirect(`/personas/${persona.id}`, 'persona saved')
}

export async function deletePersonaAction(ctx: RequestContext): Promise<HandlerResult> {
  const persona = await getPersona(ctx.pool, ctx.workspaceId, ctx.params[0] ?? '')
  if (persona === undefined) return notFound(page({ title: 'Persona not found', csrf: ctx.csrf }, html``))
  let removed: Awaited<ReturnType<typeof removePersona>>
  try {
    removed = await removePersona(library(ctx), persona.id, ctx.deps.now())
  } catch (error) {
    if (error instanceof StoreConflict) return refused(ctx, persona, error.message)
    throw error
  }
  if (removed.fileNotMoved !== undefined) {
    // The removal committed with its audit entry; only the file move failed.
    const body = html`<p>${persona.name} was removed, but its file <code>${removed.fileNotMoved}</code> could not be moved aside. Move or delete it in <code>${ctx.deps.personasDir}</code> by hand.</p><p><a href="/personas">Back to personas</a></p>`
    return { kind: 'page', status: 200, html: page({ title: 'Persona removed', csrf: ctx.csrf, crumbs: [PERSONAS_CRUMB], flash: { kind: 'error', text: 'The file was not moved.' } }, body), outcome: 'persona removed; file not moved', audited: true }
  }
  return savedRedirect('/personas', 'persona removed')
}

function fields(ctx: RequestContext): { name: string; text: string } {
  return { name: (ctx.form.get('name') ?? '').trim(), text: (ctx.form.get('text') ?? '').replace(/\r\n/g, '\n') }
}

async function refused(ctx: RequestContext, persona: Persona | undefined, message: string): Promise<HandlerResult> {
  return { kind: 'page', status: 400, html: personaForm(ctx, persona, ctx.form.get('text') ?? '', message), outcome: `refused: ${message}` }
}

function personaForm(ctx: RequestContext, persona: Persona | undefined, text: string | undefined, error: string | undefined): string {
  const action = persona === undefined ? '/personas' : `/personas/${persona.id}`
  const missingFile = persona !== undefined && text === undefined
  const body = html`
    ${persona?.writtenByRelay === true ? html`<p>${RELAY_MARK} Relay wrote this persona for an approved team proposal.</p>` : ''}
    ${missingFile ? html`<p class="error">This persona's file (${persona.fileName}) is missing. Saving writes it again.</p>` : ''}
    ${persona !== undefined && persona.projects.length > 0 ? html`<p class="note">Used by the team of ${persona.projects.join(', ')}. A change here changes it there too.</p>` : ''}
    <form method="post" action="${action}">
      ${csrfField(ctx.csrf)}
      <fieldset>
        <label for="name">Name</label><input type="text" id="name" name="name" value="${ctx.form.get('name') ?? persona?.name ?? ''}">
        <label for="text">Persona and instructions (Markdown)</label><textarea id="text" name="text">${text ?? ''}</textarea>
        ${persona === undefined ? '' : html`<p class="muted">File: <code>${persona.fileName}</code></p>`}
      </fieldset>
      <button type="submit" class="${buttonClass('primary')}">${persona === undefined ? 'Create persona' : missingFile ? 'Save and recreate the file' : 'Save persona'}</button>
    </form>
    ${persona === undefined ? '' : html`<div class="actions-row">${postButton(`/personas/${persona.id}/delete`, ctx.csrf, html`Remove persona<span class="visually-hidden"> ${persona.name}</span>`, 'danger')}</div>`}`
  return page({ title: persona === undefined ? 'New persona' : persona.name, csrf: ctx.csrf, crumbs: [PERSONAS_CRUMB], ...(error !== undefined ? { flash: { kind: 'error' as const, text: error } } : {}) }, body)
}
