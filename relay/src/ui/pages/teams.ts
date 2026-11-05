/**
 * Team actions behind the project hub (project-hub.ts): add, edit, make
 * lead and remove (after a confirm page) a member picked from the global
 * persona library, each with the client (Claude or Codex) and optional
 * model it runs on; the team's member limit; and "Start from template",
 * which adds the starter
 * personas the library lacks and a five-member roster. Every member write
 * goes through the store, which locks the team first. A refused save shows
 * the hub again with what was typed.
 */

import { applyStarterTeam } from '../../projects/starter-team.js'
import { ACCOUNT_CLIENTS, type AccountClient } from '../../autonomous/accounts.js'
import { addMember, ensureTeam, getProject, listMembers, removeMember, setMemberLimit, StoreConflict, updateMember, type Project, type TeamMemberInput } from '../../projects/store.js'
import { auditedChange } from '../audit.js'
import { notFound, pageResult, savedRedirect, type HandlerResult, type RequestContext } from '../context.js'
import { html, page, postButton } from '../html.js'
import { hubHtml, MODEL_MAX, PROJECTS_CRUMB, type Typed } from './project-hub.js'

async function projectOf(ctx: RequestContext): Promise<Project | undefined> {
  return getProject(ctx.pool, ctx.workspaceId, ctx.params[0] ?? '')
}

const missingProject = (ctx: RequestContext) => notFound(page({ title: 'Project not found', csrf: ctx.csrf, crumbs: [PROJECTS_CRUMB] }, html`<p><a href="/projects">Back to projects</a></p>`))
const GONE = 'That member is no longer on this team.'

/** GET /projects/:id/team: the team moved onto the hub. */
export async function teamRedirect(ctx: RequestContext): Promise<HandlerResult> {
  return { kind: 'redirect', location: `/projects/${ctx.params[0] ?? ''}`, outcome: 'redirected to the hub' }
}

export async function addMemberAction(ctx: RequestContext): Promise<HandlerResult> {
  return changeMember(ctx, 'add', 'member added', async (project, input) =>
    auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'member added', detail: { projectId: project.id, ...input } }, async (client) => {
      await addMember(client, ctx.workspaceId, project.id, input)
    }),
  )
}

export async function updateMemberAction(ctx: RequestContext): Promise<HandlerResult> {
  const memberId = ctx.params[1] ?? ''
  return changeMember(ctx, 'edit', 'member saved', async (project, input) =>
    auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'member saved', detail: { projectId: project.id, memberId, ...input } }, async (client) => {
      if (!(await updateMember(client, ctx.workspaceId, project.id, memberId, input))) throw new StoreConflict(GONE)
    }),
  )
}

/** Makes one member the lead, taking the lead from whoever had it, in one save. */
export async function makeLeadAction(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missingProject(ctx)
  const memberId = ctx.params[1] ?? ''
  try {
    await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'lead changed', detail: { projectId: project.id, memberId } }, async (client) => {
      // Lock the team before reading it, so the roster cannot change under this save.
      await ensureTeam(client, ctx.workspaceId, project.id)
      const members = await listMembers(client, ctx.workspaceId, project.id)
      const target = members.find((member) => member.id === memberId)
      if (target === undefined) throw new StoreConflict(GONE)
      // Pass every field, client and model too, so moving the lead changes nothing else about either member.
      const asInput = (member: typeof target, isLead: boolean): TeamMemberInput => ({
        name: member.name,
        role: member.role,
        personaId: member.personaId,
        isLead,
        client: member.client,
        model: member.model,
      })
      for (const member of members.filter((other) => other.isLead && other.id !== memberId)) await updateMember(client, ctx.workspaceId, project.id, member.id, asInput(member, false))
      await updateMember(client, ctx.workspaceId, project.id, memberId, asInput(target, true))
    })
  } catch (error) {
    if (error instanceof StoreConflict) return refused(ctx, project, error.message, undefined)
    throw error
  }
  return savedRedirect(`/projects/${project.id}`, 'lead changed')
}

const LIMIT_REFUSED = 'The member limit is a whole number from 1 to 6.'

/** POST /projects/:id/team/limit: how many of the team's members may work at once. */
export async function memberLimitAction(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missingProject(ctx)
  const typed = (ctx.form.get('member_limit') ?? '').trim()
  const limit = /^[0-9]+$/.test(typed) ? Number(typed) : Number.NaN
  if (!Number.isInteger(limit) || limit < 1 || limit > 6) return refused(ctx, project, LIMIT_REFUSED, 'limit')
  await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'member limit saved', detail: { projectId: project.id, memberLimit: limit } }, (client) =>
    setMemberLimit(client, ctx.workspaceId, project.id, limit),
  )
  return savedRedirect(`/projects/${project.id}`, 'member limit saved')
}

/** GET .../members/:id/remove: asks before removing (no script, so no confirm dialog). */
export async function confirmRemoveMemberPage(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missingProject(ctx)
  const member = (await listMembers(ctx.pool, ctx.workspaceId, project.id)).find((candidate) => candidate.id === ctx.params[1])
  const crumbs = [PROJECTS_CRUMB, { label: project.name, href: `/projects/${project.id}` }]
  if (member === undefined) return notFound(page({ title: 'Member not found', csrf: ctx.csrf, crumbs }, html`<p>${GONE} <a href="/projects/${project.id}">Back to ${project.name}</a></p>`))
  const body = html`<p>${member.name} (${member.role}${member.isLead ? ', lead' : ''}) leaves the team of ${project.name}. The persona ${member.personaName} stays in the library.</p>
    <div class="actions-row">${postButton(`/projects/${project.id}/team/members/${member.id}/delete`, ctx.csrf, `Remove ${member.name}`, 'danger-fill')}<a href="/projects/${project.id}">Cancel</a></div>`
  return pageResult(page({ title: `Remove ${member.name}?`, csrf: ctx.csrf, crumbs }, body))
}

export async function removeMemberAction(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missingProject(ctx)
  const memberId = ctx.params[1] ?? ''
  await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'member removed', detail: { projectId: project.id, memberId } }, (client) =>
    removeMember(client, ctx.workspaceId, project.id, memberId),
  )
  return savedRedirect(`/projects/${project.id}`, 'member removed')
}

export async function starterTeamAction(ctx: RequestContext): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missingProject(ctx)
  const result = await applyStarterTeam({ pool: ctx.pool, workspaceId: ctx.workspaceId, actor: ctx.actor, dir: ctx.deps.personasDir, route: ctx.route }, project.id)
  const made = `Made personas: ${result.personasMade.join(', ') || 'none'}. Added members: ${result.membersMade.join(', ') || 'none'}.`
  const outcome = result.error === undefined ? 'template applied' : `template stopped: ${result.error}`
  const flash = result.error === undefined ? { kind: 'ok' as const, text: made } : { kind: 'error' as const, text: `Stopped: ${result.error} ${made}` }
  // Each persona and member the template made was audited in its own save; this entry records the request itself.
  return { kind: 'page', status: result.error === undefined ? 200 : 400, html: await hubHtml(ctx, project, { flash }), outcome }
}

async function changeMember(ctx: RequestContext, typed: Typed, outcome: string, save: (project: Project, input: TeamMemberInput) => Promise<void>): Promise<HandlerResult> {
  const project = await projectOf(ctx)
  if (project === undefined) return missingProject(ctx)
  const runsOn = clientAndModel(ctx.form)
  if (typeof runsOn === 'string') return refused(ctx, project, runsOn, typed)
  const input: TeamMemberInput = {
    name: (ctx.form.get('name') ?? '').trim(),
    role: (ctx.form.get('role') ?? '').trim(),
    personaId: (ctx.form.get('persona_id') ?? '').trim(),
    isLead: ctx.form.get('is_lead') === 'on',
    ...runsOn,
  }
  const problem = input.name === '' ? 'Give the member a name.' : input.role === '' ? 'Give the member a role.' : input.personaId === '' ? 'Pick a persona.' : undefined
  if (problem !== undefined) return refused(ctx, project, problem, typed)
  try {
    await save(project, input)
  } catch (error) {
    if (error instanceof StoreConflict) return refused(ctx, project, error.message, error.message === GONE ? undefined : typed)
    throw error
  }
  return savedRedirect(`/projects/${project.id}`, outcome)
}

const CONTROL_CHARACTER = /\p{Cc}/u

/**
 * The client and model from a member form, or why they are refused. A field
 * the form did not send is left out, so a new member gets Claude with no
 * model and an edit keeps the member's own; an empty model means none.
 */
function clientAndModel(form: URLSearchParams): { client?: AccountClient; model?: string | null } | string {
  const typedClient = form.get('client')
  const client = ACCOUNT_CLIENTS.find((known) => known === typedClient)
  const model = form.get('model')
  if (typedClient !== null && client === undefined) return 'Pick Claude or Codex as the client.'
  if (model !== null && CONTROL_CHARACTER.test(model)) return 'The model name cannot hold control characters.'
  const trimmed = model?.trim()
  if (trimmed !== undefined && trimmed.length > MODEL_MAX) return `The model name is at most ${MODEL_MAX} characters.`
  return {
    ...(client === undefined ? {} : { client }),
    ...(trimmed === undefined ? {} : { model: trimmed === '' ? null : trimmed }),
  }
}

async function refused(ctx: RequestContext, project: Project, message: string, typed: Typed): Promise<HandlerResult> {
  const body = await hubHtml(ctx, project, { flash: { kind: 'error', text: message }, typed, ...(typed === 'edit' ? { editMemberId: ctx.params[1] ?? '' } : {}) })
  return { kind: 'page', status: 400, html: body, outcome: `refused: ${message}` }
}
