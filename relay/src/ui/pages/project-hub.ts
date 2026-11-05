/**
 * The project hub (GET /projects/:id) and the project form. The hub shows,
 * in order: the project's facts, its team as read-only rows (one row turns
 * into a form with `?edit=<member>`), the add-member form, the proposal
 * section (pages/proposals.ts), the latest team run (read-only), and the
 * project's settings with the team's member limit. Handlers in
 * projects.ts and teams.ts render it, also to show a refused save again with
 * what was typed.
 */

import { readPersona } from '../../projects/persona-files.js'
import type { ChannelList, SlackChannel } from '../../projects/slack-channels.js'
import { getMemberLimit, listMembers, listPersonas, type Persona, type Project, type TeamMember } from '../../projects/store.js'
import { latestRunForProject, listRunAssignments } from '../../teams/store.js'
import type { Assignment, TeamRun } from '../../teams/types.js'
import type { RequestContext } from '../context.js'
import { buttonClass, csrfField, html, TEAM_RUN_NOTE, page, postButton, type Flash, type Safe } from '../html.js'
import { proposalPanel } from './proposals.js'

export const PROJECTS_CRUMB = { label: 'Projects', href: '/projects' } as const

/** Which form, if any, shows the typed values from `ctx.form` (a refused save). */
export type Typed = 'add' | 'edit' | 'settings' | 'limit' | undefined

export const CLIENT_LABEL = { claude: 'Claude', codex: 'Codex' } as const

export type HubState = {
  readonly flash?: Flash
  readonly typed?: Typed
  /** The member whose row shows as a form; defaults to `?edit=`. */
  readonly editMemberId?: string
}

export function channelLabel(channels: ChannelList, id: string): string {
  const found = channels.kind === 'ok' ? channels.channels.find((channel) => channel.id === id) : undefined
  return found === undefined ? id : `#${found.name}`
}

export async function hubHtml(ctx: RequestContext, project: Project, state: HubState = {}): Promise<string> {
  const [members, personas, channels, proposal, memberLimit, run] = await Promise.all([
    listMembers(ctx.pool, ctx.workspaceId, project.id),
    listPersonas(ctx.pool, ctx.workspaceId),
    ctx.deps.listChannels(),
    proposalPanel(ctx, project),
    getMemberLimit(ctx.pool, ctx.workspaceId, project.id),
    latestRunForProject(ctx.pool, ctx.workspaceId, project.id),
  ])
  const assignments = run === undefined ? [] : await listRunAssignments(ctx.pool, run.id)
  const lead = members.find((member) => member.isLead)
  const registry = new Set(ctx.deps.repoNames())
  const facts = html`<dl class="facts">
      <dt>Slack channel</dt><dd>${channelLabel(channels, project.slackChannel)}</dd>
      <dt>Folder</dt><dd><code>${project.folder}</code></dd>
      <dt>Repos</dt><dd>${project.repos.length === 0 ? html`<span class="muted">None</span>` : project.repos.map((repo, index) => html`${index > 0 ? ', ' : ''}<code>${repo}</code>${registry.has(repo) ? '' : html` <span class="badge badge-danger">missing from the registry</span>`}`)}</dd>
      <dt>Team</dt><dd>${members.length === 1 ? '1 member' : `${members.length} members`}${lead === undefined ? '' : html`, led by ${lead.name}`}</dd>
    </dl>`
  const editId = state.editMemberId ?? ctx.query.get('edit') ?? undefined
  const body = html`<p class="note">${TEAM_RUN_NOTE}</p>
    ${facts}
    ${teamSection(ctx, project, members, personas, editId, state.typed)}
    ${proposal}
    ${run === undefined ? '' : runSection(run, assignments)}
    <section aria-labelledby="settings-heading">
      <h2 id="settings-heading">Settings</h2>
      ${projectFields(ctx, project, channels, state.typed === 'settings')}
      ${memberLimitForm(ctx, project, memberLimit, state.typed === 'limit')}
      <div class="actions-row">${postButton(`/projects/${project.id}/delete`, ctx.csrf, html`Delete project<span class="visually-hidden"> ${project.name}</span>`, 'danger')}</div>
    </section>`
  return page({ title: project.name, csrf: ctx.csrf, crumbs: [PROJECTS_CRUMB], ...(state.flash !== undefined ? { flash: state.flash } : {}) }, body)
}

function teamSection(ctx: RequestContext, project: Project, members: readonly TeamMember[], personas: readonly Persona[], editId: string | undefined, typed: Typed): Safe {
  const byId = new Map(personas.map((persona) => [persona.id, persona]))
  const roster = members.length === 0
    ? html`<div class="empty">
        <h3>No team yet</h3>
        <p>Let Relay propose a team from this project's repos (Team proposal, below), add members by hand, or start from the offline template.</p>
        ${postButton(`/projects/${project.id}/team/template`, ctx.csrf, 'Start from template (lead, two developers, reviewer, QA)')}
      </div>`
    : html`<div class="table-wrap"><table>
        <caption>Team of ${project.name}</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Persona</th><th scope="col">Runs on</th><th scope="col">Lead</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>${members.map((member) => (member.id === editId ? editRow(ctx, project, member, personas, typed === 'edit') : readRow(ctx, project, member, byId.get(member.personaId))))}</tbody>
      </table></div>`
  return html`<section aria-labelledby="team-heading">
      <h2 id="team-heading">Team</h2>
      ${roster}
      ${addForm(ctx, project, personas, typed === 'add')}
      <p class="muted">Members pick personas from the shared <a href="/personas">persona library</a>; a persona is edited there, for every team that uses it.</p>
    </section>`
}

function readRow(ctx: RequestContext, project: Project, member: TeamMember, persona: Persona | undefined): Safe {
  const text = persona === undefined ? undefined : readPersona(ctx.deps.personasDir, persona.fileName)
  const memberUrl = `/projects/${project.id}/team/members/${member.id}`
  return html`<tr id="member-${member.id}">
      <th scope="row">${member.name}</th>
      <td>${member.role}</td>
      <td><details>
        <summary>${member.personaName}${persona?.writtenByRelay === true ? html` <span class="badge badge-info">written by Relay</span>` : ''}</summary>
        ${text === undefined ? html`<p class="error">This persona's file is missing.</p>` : html`<pre class="persona">${text}</pre>`}
        <a href="/personas/${member.personaId}">Edit ${member.personaName} in the library</a>
      </details></td>
      <td>${CLIENT_LABEL[member.client]}${member.model === null ? html`<span class="muted">, default model</span>` : html`, <code>${member.model}</code>`}</td>
      <td>${member.isLead ? html`<span class="badge badge-ok">Lead</span>` : postButton(`${memberUrl}/lead`, ctx.csrf, html`Make lead<span class="visually-hidden"> ${member.name}</span>`, 'link')}</td>
      <td class="actions"><a href="/projects/${project.id}?edit=${member.id}#member-${member.id}">Edit<span class="visually-hidden"> ${member.name}</span></a><a href="${memberUrl}/remove">Remove<span class="visually-hidden"> ${member.name}</span></a></td>
    </tr>`
}

/** One row as a form: inputs sit in the row's cells and join the form with the `form` attribute. */
function editRow(ctx: RequestContext, project: Project, member: TeamMember, personas: readonly Persona[], typed: boolean): Safe {
  const value = (field: string, fallback: string) => (typed ? (ctx.form.get(field) ?? '') : fallback)
  const isLead = typed ? ctx.form.get('is_lead') === 'on' : member.isLead
  const formId = `edit-${member.id}`
  return html`<tr id="member-${member.id}">
      <th scope="row"><label class="visually-hidden" for="edit-name">Name for ${member.name}</label><input type="text" id="edit-name" name="name" form="${formId}" value="${value('name', member.name)}"></th>
      <td><label class="visually-hidden" for="edit-role">Role for ${member.name}</label><input type="text" id="edit-role" name="role" form="${formId}" value="${value('role', member.role)}"></td>
      <td><label class="visually-hidden" for="edit-persona">Persona for ${member.name}</label>${personaSelect(personas, value('persona_id', member.personaId), 'edit-persona', formId)}</td>
      <td><label class="visually-hidden" for="edit-client">Client for ${member.name}</label>${clientSelect(value('client', member.client), 'edit-client', formId)}
        <label class="visually-hidden" for="edit-model">Model for ${member.name} (optional)</label><input type="text" id="edit-model" name="model" form="${formId}" maxlength="${MODEL_MAX}" value="${value('model', member.model ?? '')}" placeholder="default model"></td>
      <td><input type="checkbox" id="edit-lead" name="is_lead" form="${formId}"${isLead ? html` checked` : ''}><label class="visually-hidden" for="edit-lead">${member.name} is the lead</label></td>
      <td class="actions"><form id="${formId}" class="inline" method="post" action="/projects/${project.id}/team/members/${member.id}">${csrfField(ctx.csrf)}<button type="submit" class="${buttonClass('primary')}">Save<span class="visually-hidden"> ${member.name}</span></button></form><a href="/projects/${project.id}#member-${member.id}">Cancel</a></td>
    </tr>`
}

function addForm(ctx: RequestContext, project: Project, personas: readonly Persona[], typed: boolean): Safe {
  const value = (field: string) => (typed ? (ctx.form.get(field) ?? '') : '')
  return html`<form method="post" action="/projects/${project.id}/team/members">
      ${csrfField(ctx.csrf)}
      <fieldset>
        <legend>Add a member</legend>
        <div class="row-form">
          <div><label for="new-name">Name</label><input type="text" id="new-name" name="name" value="${value('name')}"></div>
          <div><label for="new-role">Role</label><input type="text" id="new-role" name="role" value="${value('role')}" placeholder="developer"></div>
          <div><label for="new-persona">Persona</label>${personaSelect(personas, value('persona_id'), 'new-persona')}</div>
          <div><label for="new-client">Client</label>${clientSelect(value('client') || 'claude', 'new-client')}</div>
          <div><label for="new-model">Model (optional)</label><input type="text" id="new-model" name="model" maxlength="${MODEL_MAX}" value="${value('model')}" placeholder="default model"></div>
          <div class="check"><input type="checkbox" id="new-lead" name="is_lead"${typed && ctx.form.get('is_lead') === 'on' ? html` checked` : ''}> <label for="new-lead">Lead</label></div>
        </div>
        ${personas.length === 0 ? html`<p class="muted">The library has no personas yet: <a href="/personas/new">write one</a> first.</p>` : ''}
      </fieldset>
      <button type="submit">Add member</button>
    </form>`
}

/** The longest model name a member may be given. */
export const MODEL_MAX = 100

function clientSelect(chosen: string, id: string, form?: string): Safe {
  return html`<select id="${id}" name="client"${form === undefined ? '' : html` form="${form}"`}>${Object.entries(CLIENT_LABEL).map(
    ([client, label]) => html`<option value="${client}"${client === chosen ? html` selected` : ''}>${label}</option>`,
  )}</select>`
}

function memberLimitForm(ctx: RequestContext, project: Project, limit: number, typed: boolean): Safe {
  const value = typed ? (ctx.form.get('member_limit') ?? '') : String(limit)
  return html`<form method="post" action="/projects/${project.id}/team/limit">
      ${csrfField(ctx.csrf)}
      <fieldset>
        <legend>Team members working at once</legend>
        <label for="member_limit">Member limit (1 to 6)</label><input type="number" id="member_limit" name="member_limit" min="1" max="6" step="1" value="${value}">
      </fieldset>
      <button type="submit">Save member limit</button>
    </form>`
}

const short = (commit: string): string => commit.slice(0, 7)

/** The project's latest team run, read-only. */
function runSection(run: TeamRun, assignments: readonly Assignment[]): Safe {
  return html`<section aria-labelledby="run-heading">
      <h2 id="run-heading">Latest team run</h2>
      <dl class="facts">
        <dt>Request</dt><dd>${run.title}</dd>
        <dt>Kind</dt><dd>${run.kind}</dd>
        <dt>Repo</dt><dd><code>${run.repoName}</code></dd>
        <dt>Branch</dt><dd>${run.branch === null ? html`<span class="muted">None</span>` : html`<code>${run.branch}</code>`}</dd>
        <dt>Status</dt><dd>${run.status}</dd>
      </dl>
      ${assignments.length === 0
        ? html`<p class="muted">No assignments yet.</p>`
        : html`<div class="table-wrap"><table>
        <caption>Assignments of ${run.title}</caption>
        <thead><tr><th scope="col">Member</th><th scope="col">Kind</th><th scope="col">State</th><th scope="col">Result commit</th></tr></thead>
        <tbody>${assignments.map((assignment) => html`<tr><th scope="row">${assignment.memberName}</th><td>${assignment.kind}</td><td>${assignment.state}</td><td>${assignment.resultCommit === null ? html`<span class="muted">None</span>` : html`<code>${short(assignment.resultCommit)}</code>`}</td></tr>`)}</tbody>
      </table></div>`}
    </section>`
}

function personaSelect(personas: readonly Persona[], chosen: string, id: string, form?: string): Safe {
  return html`<select id="${id}" name="persona_id"${form === undefined ? '' : html` form="${form}"`}><option value="">Pick a persona</option>${personas.map(
    (persona) => html`<option value="${persona.id}"${persona.id === chosen ? html` selected` : ''}>${persona.name}</option>`,
  )}</select>`
}

/** The project form: create (no project) or settings on the hub; `typed` shows a refused save's values. */
export function projectFields(ctx: RequestContext, project: Project | undefined, channels: ChannelList, typed: boolean): Safe {
  const value = (field: string, fallback: string) => (typed ? (ctx.form.get(field) ?? '') : fallback)
  const chosenRepos = new Set(typed ? ctx.form.getAll('repos') : (project?.repos ?? []))
  const chosenChannel = value('slack_channel', project?.slackChannel ?? '')
  const channelField: Safe =
    channels.kind === 'failed'
      ? html`<p class="error">${channels.message}</p>`
      : html`<select id="slack_channel" name="slack_channel"><option value="">Pick a channel</option>${channels.channels.map(
          (channel: SlackChannel) => html`<option value="${channel.id}"${chosenChannel === channel.id ? html` selected` : ''}>#${channel.name}</option>`,
        )}</select>`
  const registry = ctx.deps.repoNames()
  const missing = [...chosenRepos].filter((repo) => !registry.includes(repo))
  const action = project === undefined ? '/projects' : `/projects/${project.id}`
  return html`<form method="post" action="${action}">
      ${csrfField(ctx.csrf)}
      <fieldset>
        <label for="name">Name</label><input type="text" id="name" name="name" value="${value('name', project?.name ?? '')}">
        <label for="slack_channel">Slack channel</label>${channelField}
        <label for="folder">Folder new threads start in</label><input type="text" id="folder" name="folder" value="${value('folder', project?.folder ?? '')}" placeholder="~/code/project">
        <fieldset>
          <legend>Repos</legend>
          ${registry.length === 0 ? html`<p class="muted">No repos are registered; add one with <code>relay repos add</code>.</p>` : ''}
          ${registry.map((repo) => html`<div class="check"><input type="checkbox" id="repo-${repo}" name="repos" value="${repo}"${chosenRepos.has(repo) ? html` checked` : ''}> <label for="repo-${repo}">${repo}</label></div>`)}
          ${missing.map((repo) => html`<div class="muted">${repo} (missing from the registry; ignored)</div>`)}
        </fieldset>
      </fieldset>
      <button type="submit" class="${buttonClass('primary')}">${project === undefined ? 'Create project' : 'Save settings'}</button>
    </form>`
}

/** The new-project page; with an error, the typed values stay. */
export async function newProjectHtml(ctx: RequestContext, error: string | undefined): Promise<string> {
  const channels = await ctx.deps.listChannels()
  return page(
    { title: 'New project', csrf: ctx.csrf, crumbs: [PROJECTS_CRUMB], ...(error !== undefined ? { flash: { kind: 'error' as const, text: error } } : {}) },
    projectFields(ctx, undefined, channels, error !== undefined),
  )
}
