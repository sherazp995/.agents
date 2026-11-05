/**
 * Projects: the home table, create, the hub, settings and delete. A project
 * ties a Slack channel the bot is in to a folder that exists (stored
 * expanded and resolved), and names repos from the registry; a repo whose
 * registry entry is gone shows as missing. The hub itself is rendered by
 * project-hub.ts.
 */

import { expandFolderPath } from '../../chat/slack/channel-folder.js'
import { latestProposalStatuses, type ProposalStatus } from '../../projects/proposals.js'
import { createProject, deleteProject, getProject, listProjectSummaries, StoreConflict, updateProject, type Project, type ProjectInput } from '../../projects/store.js'
import { auditedChange } from '../audit.js'
import { notFound, pageResult, savedRedirect, type HandlerResult, type RequestContext } from '../context.js'
import { buttonClass, html, TEAM_RUN_NOTE, page, type Safe } from '../html.js'
import { channelLabel, hubHtml, newProjectHtml, PROJECTS_CRUMB } from './project-hub.js'

const PROPOSAL_BADGE: Readonly<Record<ProposalStatus, { label: string; tone: string }>> = {
  running: { label: 'Proposing', tone: 'badge-info' },
  ready: { label: 'Ready for review', tone: 'badge-info' },
  failed: { label: 'Failed', tone: 'badge-danger' },
  approved: { label: 'Approved', tone: 'badge-ok' },
  rejected: { label: 'Rejected', tone: '' },
  superseded: { label: 'Replaced', tone: '' },
}

function proposalBadge(status: ProposalStatus | undefined): Safe {
  if (status === undefined) return html`<span class="muted">None</span>`
  const badge = PROPOSAL_BADGE[status]
  return html`<span class="badge ${badge.tone}">${badge.label}</span>`
}

export async function listProjectsPage(ctx: RequestContext): Promise<HandlerResult> {
  const projects = await listProjectSummaries(ctx.pool, ctx.workspaceId)
  if (projects.length === 0) {
    const body = html`<p class="note">${TEAM_RUN_NOTE}</p>
      <div class="empty">
        <h3>No projects yet</h3>
        <p>A project ties a Slack channel to a folder and its repos, and holds the team Relay works with there.</p>
        <a class="${buttonClass('primary')}" href="/projects/new">Create your first project</a>
      </div>`
    return pageResult(page({ title: 'Projects', csrf: ctx.csrf }, body))
  }
  const [statuses, channels] = await Promise.all([latestProposalStatuses(ctx.pool, ctx.workspaceId), ctx.deps.listChannels()])
  const registry = new Set(ctx.deps.repoNames())
  const rows = projects.map(
    (project) => html`<tr>
      <th scope="row"><a href="/projects/${project.id}">${project.name}</a></th>
      <td>${channelLabel(channels, project.slackChannel)}</td>
      <td><code>${project.folder}</code></td>
      <td>${project.repos.length === 0 ? html`<span class="muted">None</span>` : project.repos.map((repo, index) => html`${index > 0 ? ', ' : ''}${repo}${registry.has(repo) ? '' : html` <span class="badge badge-danger">missing</span>`}`)}</td>
      <td>${project.lead ?? html`<span class="muted">None</span>`}</td>
      <td>${project.teamSize}</td>
      <td>${proposalBadge(statuses.get(project.id))}</td>
    </tr>`,
  )
  const body = html`<p class="note">${TEAM_RUN_NOTE}</p>
    <div class="actions-row"><a class="${buttonClass('primary')}" href="/projects/new">New project</a></div>
    <div class="table-wrap"><table>
      <caption>Every project and its team</caption>
      <thead><tr><th scope="col">Name</th><th scope="col">Slack channel</th><th scope="col">Folder</th><th scope="col">Repos</th><th scope="col">Lead</th><th scope="col">Team size</th><th scope="col">Proposal</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
  return pageResult(page({ title: 'Projects', csrf: ctx.csrf }, body))
}

export async function newProjectPage(ctx: RequestContext): Promise<HandlerResult> {
  return pageResult(await newProjectHtml(ctx, undefined))
}

const missingProject = (ctx: RequestContext) => notFound(page({ title: 'Project not found', csrf: ctx.csrf, crumbs: [PROJECTS_CRUMB] }, html`<p><a href="/projects">Back to projects</a></p>`))

/** GET /projects/:id: the hub. */
export async function projectHubPage(ctx: RequestContext): Promise<HandlerResult> {
  const project = await getProject(ctx.pool, ctx.workspaceId, ctx.params[0] ?? '')
  if (project === undefined) return missingProject(ctx)
  return pageResult(await hubHtml(ctx, project))
}

export async function createProjectAction(ctx: RequestContext): Promise<HandlerResult> {
  const input = await validProject(ctx)
  if ('error' in input) return refused(ctx, undefined, input.error)
  try {
    const id = await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'project created', detail: { ...input.value } }, (client) =>
      createProject(client, ctx.workspaceId, input.value),
    )
    return savedRedirect(`/projects/${id}`, 'project created')
  } catch (error) {
    if (error instanceof StoreConflict) return refused(ctx, undefined, error.message)
    throw error
  }
}

export async function updateProjectAction(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params[0] ?? ''
  const existing = await getProject(ctx.pool, ctx.workspaceId, projectId)
  if (existing === undefined) return missingProject(ctx)
  const input = await validProject(ctx)
  if ('error' in input) return refused(ctx, existing, input.error)
  try {
    await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'project saved', detail: { projectId, ...input.value } }, async (client) => {
      if (!(await updateProject(client, ctx.workspaceId, projectId, input.value))) throw new StoreConflict('That project no longer exists.')
    })
    return savedRedirect(`/projects/${projectId}`, 'project saved')
  } catch (error) {
    if (error instanceof StoreConflict) return refused(ctx, existing, error.message)
    throw error
  }
}

export async function deleteProjectAction(ctx: RequestContext): Promise<HandlerResult> {
  const projectId = ctx.params[0] ?? ''
  const deleted = await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'project deleted', detail: { projectId } }, (client) =>
    deleteProject(client, ctx.workspaceId, projectId),
  )
  return deleted ? savedRedirect('/projects', 'project deleted') : missingProject(ctx)
}

async function refused(ctx: RequestContext, project: Project | undefined, message: string): Promise<HandlerResult> {
  const flash = { kind: 'error' as const, text: message }
  const body = project === undefined ? await newProjectHtml(ctx, message) : await hubHtml(ctx, project, { flash, typed: 'settings' })
  return { kind: 'page', status: 400, html: body, outcome: `refused: ${message}` }
}

/** The form's fields, checked: a name, a channel the bot is in, a folder that exists, registry repos. */
async function validProject(ctx: RequestContext): Promise<{ value: ProjectInput } | { error: string }> {
  const name = (ctx.form.get('name') ?? '').trim()
  const slackChannel = (ctx.form.get('slack_channel') ?? '').trim()
  const folderText = (ctx.form.get('folder') ?? '').trim()
  const repos = ctx.form.getAll('repos').map((repo) => repo.trim()).filter((repo) => repo !== '')
  if (name === '') return { error: 'Give the project a name.' }
  if (slackChannel === '') return { error: 'Pick the Slack channel.' }
  if (folderText === '') return { error: 'Give the folder new threads should start in.' }
  const channels = await ctx.deps.listChannels()
  if (channels.kind === 'failed') return { error: channels.message }
  if (!channels.channels.some((channel) => channel.id === slackChannel)) return { error: 'The bot is not in that Slack channel; invite it there first.' }
  const folder = expandFolderPath(folderText, ctx.deps.home)
  if (!ctx.deps.isFolder(folder)) return { error: `${folder} is not a folder on this machine.` }
  const registry = new Set(ctx.deps.repoNames())
  const unknown = repos.filter((repo) => !registry.has(repo))
  if (unknown.length > 0) return { error: `Not in the repo registry: ${unknown.join(', ')}.` }
  return { value: { name, slackChannel, folder, repos } }
}
