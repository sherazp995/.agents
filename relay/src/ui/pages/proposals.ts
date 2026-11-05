/**
 * Proposing and reviewing a team Relay suggests (the teams UI plan, step 7).
 *
 * "Propose team" starts a read-only run and redirects to the proposal's own
 * page. While it runs, that page refreshes itself every few seconds (it holds
 * no form, so nothing typed is lost) unless the owner stops it. A ready
 * proposal shows every row against today's team, with its reason, a tick box
 * and editable fields, and every new persona's full text. Approving goes
 * through approveProposal (src/projects/proposals.ts), which does the whole
 * change in one audited transaction and refuses a stale proposal.
 */

import { approveProposal, checkProposalRows, getProposal, latestProposal, rejectProposal, type ApproveResult, type Proposal, type ProposedRow } from '../../projects/proposals.js'
import { ensurePersonasDir, personaPath, readPersona } from '../../projects/persona-files.js'
import { getProject, listMembers, listPersonas, StoreConflict, type Persona, type Project, type TeamMember } from '../../projects/store.js'
import { auditedChange } from '../audit.js'
import { notFound, pageResult, savedRedirect, type HandlerResult, type RequestContext } from '../context.js'
import { csrfField, html, page, postButton, type Safe } from '../html.js'
import { existsSync, writeFileSync } from 'node:fs'

export const REFRESH_SECONDS = 5

const KIND_LABEL: Record<ProposedRow['kind'], string> = { add: 'Add', change: 'Change', keep: 'Keep', remove: 'Remove' }

const projectUrl = (project: Project) => `/projects/${project.id}`
const proposalUrl = (project: Project, proposal: Proposal) => `/projects/${project.id}/proposals/${proposal.id}`

/** The hub's proposal section: the newest proposal's state and the "Propose team" button. */
export async function proposalPanel(ctx: RequestContext, project: Project): Promise<Safe> {
  const latest = await latestProposal(ctx.pool, ctx.workspaceId, project.id)
  const propose = ctx.deps.proposer === undefined
    ? html`<p class="muted">Proposals are not available: this daemon has no proposal runner.</p>`
    : postButton(`/projects/${project.id}/proposals`, ctx.csrf, latest === undefined ? 'Propose team' : 'Propose again')
  let state: Safe = html`<p>Relay can read this project's repos and suggest a team. Nothing changes until you approve it.</p>`
  if (latest?.status === 'running') state = html`<p><span class="badge">Running</span> Relay is proposing a team. <a href="${proposalUrl(project, latest)}">Watch it</a></p>`
  if (latest?.status === 'ready') state = html`<p><span class="badge badge-info">Ready</span> A proposal with ${String(latest.rows.length)} rows is waiting. <a href="${proposalUrl(project, latest)}">Review it</a></p>`
  if (latest?.status === 'failed') state = html`<p><span class="badge badge-danger">Failed</span> ${latest.error ?? 'The last proposal failed.'}</p>`
  if (latest?.status === 'approved') state = html`<p><span class="badge badge-ok">Approved</span> The last proposal was applied. <a href="${proposalUrl(project, latest)}">See what changed</a></p>`
  if (latest?.status === 'rejected') state = html`<p><span class="badge">Rejected</span> The last proposal was rejected.</p>`
  const showButton = latest?.status !== 'running' && latest?.status !== 'ready'
  return html`<section aria-labelledby="proposal-heading"><h2 id="proposal-heading">Team proposal</h2>${state}${showButton ? propose : ''}</section>`
}

async function projectOf(ctx: RequestContext): Promise<Project | undefined> {
  return getProject(ctx.pool, ctx.workspaceId, ctx.params[0] ?? '')
}

async function proposalOf(ctx: RequestContext, project: Project): Promise<Proposal | undefined> {
  const proposal = await getProposal(ctx.pool, ctx.workspaceId, ctx.params[1] ?? '')
  return proposal?.projectId === project.id ? proposal : undefined
}

const missing = (ctx: RequestContext, what: string) => notFound(page({ title: `${what} not found`, csrf: ctx.csrf }, html`<p><a href="/projects">Back to projects</a></p>`))

/** POST /projects/:id/proposals: starts a run and redirects to its page. */
export async function proposeAction(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missing(ctx, 'Project')
  if (ctx.deps.proposer === undefined) return pageResult(page({ title: 'Proposals are not available', csrf: ctx.csrf }, html`<p>This daemon has no proposal runner.</p>`), 'refused: no proposer', 503)
  try {
    const id = await ctx.deps.proposer.propose(ctx.workspaceId, { projectId: project.id, requestedBy: ctx.actor, source: 'page' })
    return { kind: 'redirect', location: `/projects/${project.id}/proposals/${id}`, outcome: 'team proposal started' }
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error
    const latest = await latestProposal(ctx.pool, ctx.workspaceId, project.id)
    const body = html`<p>${error.message}</p>${latest !== undefined ? html`<p><a href="${proposalUrl(project, latest)}">See the proposal</a></p>` : ''}`
    return pageResult(page({ title: 'Already proposing', csrf: ctx.csrf, flash: { kind: 'error', text: error.message } }, body), `refused: ${error.message}`, 409)
  }
}

/** GET /projects/:id/proposals/:id: running (refreshes), failed, ready (the review form), or decided. */
export async function proposalPage(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missing(ctx, 'Project')
  const proposal = await proposalOf(ctx, project)
  if (proposal === undefined) return missing(ctx, 'Proposal')
  if (proposal.status === 'ready') return pageResult(await reviewHtml(ctx, project, proposal, undefined, undefined))
  return pageResult(statusHtml(ctx, project, proposal))
}

function statusHtml(ctx: RequestContext, project: Project, proposal: Proposal): string {
  const back = html`<p><a href="${projectUrl(project)}">Back to ${project.name}</a></p>`
  if (proposal.status === 'running') {
    const refreshing = ctx.query.get('refresh') !== 'off'
    const seconds = Math.max(0, Math.round((ctx.deps.now().getTime() - proposal.createdAt.getTime()) / 1000))
    const body = html`<p role="status"><span class="badge">Running</span> Relay is reading ${project.name}'s repos and proposing a team. Started ${String(seconds)} seconds ago; this usually takes a minute or two.</p>
      <p>${refreshing ? html`This page checks again every ${String(REFRESH_SECONDS)} seconds. <a href="?refresh=off">Stop refreshing</a>` : html`<a href="?">Check again</a>`}</p>${back}`
    return page({ title: 'Relay is proposing a team', csrf: ctx.csrf, ...(refreshing ? { refreshSeconds: REFRESH_SECONDS } : {}) }, body)
  }
  if (proposal.status === 'failed') {
    const body = html`<p>${proposal.error ?? 'The proposal failed.'}</p>${ctx.deps.proposer !== undefined ? postButton(`/projects/${project.id}/proposals`, ctx.csrf, 'Propose again') : ''}${back}`
    return page({ title: 'The proposal failed', csrf: ctx.csrf, flash: { kind: 'error', text: 'Nothing was changed.' } }, body)
  }
  if (proposal.status === 'approved') return page({ title: 'Proposal approved', csrf: ctx.csrf }, html`${appliedHtml(ctx, project, proposal)}${back}`)
  const note = proposal.status === 'rejected' ? html`<p>Rejected${proposal.decisionNote ? html`: ${proposal.decisionNote}` : ''}.</p>` : html`<p>A newer proposal replaced this one.</p>`
  return page({ title: proposal.status === 'rejected' ? 'Proposal rejected' : 'Proposal replaced', csrf: ctx.csrf }, html`${note}${back}`)
}

function appliedHtml(ctx: RequestContext, project: Project, proposal: Proposal): Safe {
  const applied = proposal.applied
  if (applied === null) return html`<p>Applied.</p>`
  const missingFiles = applied.newPersonas.filter((persona) => readPersona(ctx.deps.personasDir, persona.fileName) === undefined)
  const rows = applied.rows.map((row) => html`<li>${KIND_LABEL[row.kind]}: ${row.name}, ${row.role}${row.isLead ? ' (lead)' : ''}</li>`)
  const recreate = missingFiles.length === 0
    ? ''
    : html`<div class="flash flash-error" role="alert"><p>These persona files are missing: ${missingFiles.map((persona) => persona.fileName).join(', ')}.</p>${postButton(`/projects/${project.id}/proposals/${proposal.id}/recreate`, ctx.csrf, 'Recreate them from the approved text')}</div>`
  return html`${recreate}<p>Approved${proposal.decidedAt ? html` on ${proposal.decidedAt.toISOString().slice(0, 16).replace('T', ' ')}` : ''}. Applied:</p><ul>${rows}</ul>`
}

type ReviewRow = ProposedRow & { readonly index: number; readonly included: boolean }

async function reviewHtml(
  ctx: RequestContext,
  project: Project,
  proposal: Proposal,
  edited: readonly ReviewRow[] | undefined,
  flash: { kind: 'error' | 'ok'; text: string } | undefined,
): Promise<string> {
  const [members, personas] = await Promise.all([listMembers(ctx.pool, ctx.workspaceId, project.id), listPersonas(ctx.pool, ctx.workspaceId)])
  const rows: ReviewRow[] = edited !== undefined ? [...edited] : proposal.rows.map((row, index) => ({ ...row, index, included: row.kind !== 'keep' }))
  const body = html`<p>Relay read ${project.name}'s repos and proposes the changes below. Untick a row to leave that member as it is; edit any field first. Nothing changes until you approve.</p>
    <form method="post" action="${proposalUrl(project, proposal)}/approve">
      ${csrfField(ctx.csrf)}
      <table>
        <caption>Proposed team for ${project.name}</caption>
        <thead><tr><th scope="col">Apply</th><th scope="col">Change</th><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Lead</th><th scope="col">Persona</th></tr></thead>
        <tbody>${rows.map((row) => reviewRowHtml(row, members, personas))}</tbody>
      </table>
      <button type="submit" class="button-primary">Approve and apply</button>
    </form>
    <form method="post" action="${proposalUrl(project, proposal)}/reject">
      ${csrfField(ctx.csrf)}
      <label for="reject-note">Why reject it? (optional)</label>
      <input type="text" id="reject-note" name="note" maxlength="500">
      <button type="submit" class="button-danger">Reject</button>
    </form>
    ${ctx.deps.proposer !== undefined ? postButton(`/projects/${project.id}/proposals`, ctx.csrf, 'Propose again') : ''}
    <p><a href="${projectUrl(project)}">Back to ${project.name}</a></p>`
  return page({ title: 'Review the proposed team', csrf: ctx.csrf, ...(flash !== undefined ? { flash } : {}) }, body)
}

function reviewRowHtml(row: ReviewRow, members: readonly TeamMember[], personas: readonly Persona[]): Safe {
  const i = String(row.index)
  const current = row.memberId === undefined ? undefined : members.find((member) => member.id === row.memberId)
  const tick =
    row.kind === 'keep'
      ? html`<span class="muted">No change</span>`
      : html`<input type="checkbox" id="include-${i}" name="include" value="${i}"${row.included ? html` checked` : ''}><label for="include-${i}" class="visually-hidden">Apply: ${KIND_LABEL[row.kind]} ${row.name}</label>`
  const was = current !== undefined && row.kind === 'change' ? html`<br><span class="muted">Today: ${current.name}, ${current.role}${current.isLead ? ' (lead)' : ''}, ${current.personaName}</span>` : ''
  const persona =
    row.persona.kind === 'existing'
      ? html`${personas.find((candidate) => candidate.id === (row.persona as { personaId: string }).personaId)?.name ?? 'a persona that no longer exists'}`
      : html`<span class="badge badge-info">New, written by Relay</span>
          <label for="persona-name-${i}" class="visually-hidden">New persona name for ${row.name}</label>
          <input type="text" id="persona-name-${i}" name="persona_name_${i}" value="${row.persona.name}">
          <details open><summary>Full persona text</summary>
            <label for="persona-text-${i}" class="visually-hidden">Persona text for ${row.name}</label>
            <textarea id="persona-text-${i}" name="persona_text_${i}" rows="10">${row.persona.text}</textarea>
          </details>`
  return html`<tr>
    <td>${tick}</td>
    <td><span class="badge">${KIND_LABEL[row.kind]}</span>${row.reason ? html`<br><span class="muted">${row.reason}</span>` : ''}${was}</td>
    <td><label for="name-${i}" class="visually-hidden">Name</label><input type="text" id="name-${i}" name="name_${i}" value="${row.name}"${row.kind === 'remove' ? html` readonly` : ''}></td>
    <td><label for="role-${i}" class="visually-hidden">Role for ${row.name}</label><input type="text" id="role-${i}" name="role_${i}" value="${row.role}"${row.kind === 'remove' ? html` readonly` : ''}></td>
    <td>${row.kind === 'remove' ? '' : html`<input type="radio" id="lead-${i}" name="lead" value="${i}"${row.isLead ? html` checked` : ''}><label for="lead-${i}" class="visually-hidden">Make ${row.name} the lead</label>`}</td>
    <td>${persona}</td>
  </tr>`
}

/**
 * The review form back as rows: each proposed row with the owner's edits.
 * The lead is the one radio chosen; a "keep" row whose lead, name or role
 * the owner changed becomes a change, so the edit is applied.
 */
export function rowsFromForm(proposal: Proposal, form: URLSearchParams): ReviewRow[] {
  const included = new Set(form.getAll('include'))
  const lead = form.get('lead')
  return proposal.rows.map((row, index) => {
    const i = String(index)
    const isLead = row.kind === 'remove' ? false : lead === i
    const persona = row.persona.kind === 'new' ? { kind: 'new' as const, name: form.get(`persona_name_${i}`) ?? row.persona.name, text: (form.get(`persona_text_${i}`) ?? row.persona.text).replace(/\r\n/g, '\n') } : row.persona
    const edited = { ...row, name: row.kind === 'remove' ? row.name : (form.get(`name_${i}`) ?? row.name), role: row.kind === 'remove' ? row.role : (form.get(`role_${i}`) ?? row.role), isLead, persona }
    if (row.kind === 'keep') {
      const changed = isLead !== row.isLead || edited.name !== row.name || edited.role !== row.role
      return { ...edited, kind: changed ? ('change' as const) : ('keep' as const), index, included: changed }
    }
    return { ...edited, index, included: included.has(i) }
  })
}

/** POST /projects/:id/proposals/:id/approve */
export async function approveProposalAction(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missing(ctx, 'Project')
  const proposal = await proposalOf(ctx, project)
  if (proposal === undefined) return missing(ctx, 'Proposal')
  const reviewed = rowsFromForm(proposal, ctx.form)
  const ticked = reviewed.filter((row) => row.included).map(({ index: _index, included: _included, ...row }) => row)
  let result: ApproveResult
  try {
    if (ticked.length === 0) throw new StoreConflict('Tick at least one row to apply, or reject the proposal.')
    result = await approveProposal({ pool: ctx.pool, workspaceId: ctx.workspaceId, proposalId: proposal.id, actor: ctx.actor, rows: checkProposalRows(ticked), personasDir: ctx.deps.personasDir, route: ctx.route })
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error
    const fresh = (await getProposal(ctx.pool, ctx.workspaceId, proposal.id)) ?? proposal
    const html = fresh.status === 'ready' ? await reviewHtml(ctx, project, fresh, reviewed, { kind: 'error', text: error.message }) : statusHtml(ctx, project, fresh)
    return { kind: 'page', status: 409, html, outcome: `refused: ${error.message}` }
  }
  if (result.filesNotSaved.length > 0) {
    const approved = (await getProposal(ctx.pool, ctx.workspaceId, proposal.id)) ?? proposal
    const text = `The team was saved, but these persona files were not written: ${result.filesNotSaved.map((file) => file.fileName).join(', ')}.`
    return { kind: 'page', status: 200, html: page({ title: 'Proposal approved', csrf: ctx.csrf, flash: { kind: 'error', text } }, appliedHtml(ctx, project, approved)), outcome: 'team proposal approved; files not written', audited: true }
  }
  return savedRedirect(projectUrl(project), 'team proposal approved')
}

/** POST /projects/:id/proposals/:id/reject */
export async function rejectProposalAction(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missing(ctx, 'Project')
  const proposal = await proposalOf(ctx, project)
  if (proposal === undefined) return missing(ctx, 'Proposal')
  const note = (ctx.form.get('note') ?? '').trim()
  try {
    await rejectProposal(ctx.pool, { workspaceId: ctx.workspaceId, proposalId: proposal.id, actor: ctx.actor, route: ctx.route, ...(note !== '' ? { note } : {}) })
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error
    return { kind: 'page', status: 409, html: statusHtml(ctx, project, (await getProposal(ctx.pool, ctx.workspaceId, proposal.id)) ?? proposal), outcome: `refused: ${error.message}` }
  }
  return savedRedirect(projectUrl(project), 'team proposal rejected')
}

/** POST /projects/:id/proposals/:id/recreate: writes missing persona files from the approved snapshot. */
export async function recreateFilesAction(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missing(ctx, 'Project')
  const proposal = await proposalOf(ctx, project)
  if (proposal?.status !== 'approved' || proposal.applied === null) return missing(ctx, 'Approved proposal')
  const missingFiles = proposal.applied.newPersonas.filter((persona) => readPersona(ctx.deps.personasDir, persona.fileName) === undefined)
  await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'persona files recreated', detail: { proposalId: proposal.id, files: missingFiles.map((persona) => persona.fileName) } }, async () => {
    ensurePersonasDir(ctx.deps.personasDir)
    for (const persona of missingFiles) {
      const path = personaPath(ctx.deps.personasDir, persona.fileName)
      // `wx`: never overwrite a file that appeared since the check.
      if (!existsSync(path)) writeFileSync(path, persona.text.endsWith('\n') ? persona.text : `${persona.text}\n`, { flag: 'wx' })
    }
  })
  return savedRedirect(proposalUrl(project, proposal), 'persona files recreated')
}
