/**
 * The `/team` hook bridge route behind every `relay team` command but
 * `propose` (teams phase 2, step 5).
 *
 * Who may act comes only from the turn's own token: its workspace, task and,
 * for a member, its assignment and that assignment's lease generation. Ids
 * in the body are looked up and checked to belong to the token's task, never
 * trusted for scoping. The checks, in order: the token is this daemon's
 * workspace; the role (a token with an assignment is a member, else the
 * lead) may run the command (TEAM_COMMANDS); the turn is live (the lead's
 * task lease, or the member's assignment lease, and never a stopped task).
 *
 * The bridge answers 504 after 15 seconds while the work goes on, so every
 * command is safe to run again: start returns the open run of the same
 * title, assign is keyed, answer and ask-lead skip a repeat of the same
 * text, merge is a recorded operation, cancel and finish are no-ops once
 * done.
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { wrapUntrusted, renderForModel } from '../agent/untrusted.js'
import { loadTaskThread } from '../autonomous/operations.js'
import { loadTask, type AutonomousTask } from '../autonomous/store.js'
import { notLiveReason } from '../autonomous/team-proposal-route.js'
import type { BridgeRoute, InvocationContext } from '../engine/hook-bridge.js'
import { readPersona } from '../projects/persona-files.js'
import { getMemberLimit, getPersona, listMembers, projectForChannelWithRepos, type Project } from '../projects/store.js'
import type { RepoEntry } from '../repos/schema.js'
import { mergeAssignment } from './merge.js'
import {
  answerAssignment,
  cancelAssignment,
  closeRun,
  insertAssignment,
  insertRun,
  listRunAssignments,
  listRunMerges,
  loadAssignment,
  loadOpenRun,
  loadRun,
  TeamConflict,
  updateAssignmentAndTellLead,
} from './store.js'
import { ASSIGNMENT_KINDS, mayRun, TEAM_COMMANDS, type Assignment, type RunSnapshot, type SnapshotMember, type TeamRouteDeps, type TeamRun } from './types.js'
import { createRequestWorktree, fetchPrHead, folderRepo, headOf, parsePrNumber, real } from './worktrees.js'

type Answer = { status: number; body: { ok: boolean; message: string; [key: string]: unknown } }

const refuse = (status: number, message: string): Answer => ({ status, body: { ok: false, message } })
const done = (message: string, data: Record<string, unknown> = {}, status = 200): Answer => ({ status, body: { ok: true, message, ...data } })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const assignmentId = z.string().regex(UUID, 'is not an assignment id')
const text = (max: number) => z.string().trim().min(1).max(max)

const bodies = {
  start: z.object({ title: text(200), repo: text(100).optional(), pr: z.union([z.string().trim().min(1).max(300), z.number().int().positive()]).optional() }),
  assign: z.object({ member: text(100), kind: z.enum(ASSIGNMENT_KINDS), brief: text(20_000), key: text(200).optional() }),
  answer: z.object({ assignment: assignmentId, text: text(8_000) }),
  merge: z.object({ assignment: assignmentId }),
  cancel: z.object({ assignment: assignmentId }),
  finish: z.object({}),
  status: z.object({}),
  'ask-lead': z.object({ text: text(8_000) }),
} as const

type Command = keyof typeof bodies
type Body<C extends Command> = z.infer<(typeof bodies)[C]>

/** What a checked lead or member invocation carries into its command. */
type Lead = { readonly role: 'lead'; readonly context: InvocationContext; readonly task: AutonomousTask }
type Member = { readonly role: 'member'; readonly context: InvocationContext; readonly task: AutonomousTask; readonly assignment: Assignment; readonly leaseGeneration: number }

export function teamRoute(deps: TeamRouteDeps): BridgeRoute {
  return async (context, rawBody) => {
    const now = deps.now?.() ?? new Date()
    if (context.workspaceId !== deps.workspaceId || !UUID.test(context.taskId)) return refuse(403, 'Team commands only work from a live Relay turn.')
    const command = typeof rawBody === 'object' && rawBody !== null ? (rawBody as { command?: unknown }).command : undefined
    if (typeof command !== 'string' || !Object.hasOwn(bodies, command)) return refuse(400, `Unknown team command${typeof command === 'string' ? ` "${command.slice(0, 40)}"` : ''}.`)
    const role = context.assignment === undefined ? 'lead' : 'member'
    if (!mayRun(role, command)) {
      return refuse(403, role === 'member' ? `Only the team's lead can run relay team ${command}; a member may run: ${TEAM_COMMANDS.member.join(', ')}.` : `Only a team member can run relay team ${command}.`)
    }

    const task = await loadTask(deps.pool, context.taskId)
    let actor: Lead | Member
    if (role === 'lead') {
      const reason = notLiveReason(task, context, now)
      if (reason !== undefined || task === undefined) return refuse(403, `Team commands only work from a live Relay turn: ${reason ?? 'the task is gone'}.`)
      actor = { role, context, task }
    } else {
      const checked = await liveMember(deps, context, task, now)
      if (typeof checked === 'string') return refuse(403, `Team commands only work from a live Relay turn: ${checked}.`)
      actor = checked
    }

    const { command: _command, ...args } = rawBody as Record<string, unknown>
    const parsed = bodies[command as Command].safeParse(args)
    if (!parsed.success) return refuse(400, `relay team ${command}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}.`)

    try {
      return await run(deps, actor, command as Command, parsed.data)
    } catch (error) {
      if (error instanceof TeamConflict) return refuse(409, error.message)
      throw error
    }
  }
}

/** The member's assignment when its turn is live, or why it is not. */
async function liveMember(deps: TeamRouteDeps, context: InvocationContext, task: AutonomousTask | undefined, now: Date): Promise<Member | string> {
  const claim = context.assignment
  if (claim === undefined || !UUID.test(claim.id)) return 'this is not a member turn'
  if (task === undefined || task.workspaceId !== deps.workspaceId) return 'the task for this turn no longer exists'
  if (task.cancelRequestedAt !== null || task.phase === 'stopped') return 'this task was stopped'
  const assignment = await loadAssignment(deps.pool, claim.id)
  if (assignment === undefined || assignment.taskId !== context.taskId || assignment.workspaceId !== deps.workspaceId) return 'the assignment for this turn no longer exists'
  if (assignment.leaseGeneration !== claim.leaseGeneration) return 'this member turn was superseded'
  if (assignment.state !== 'running' || assignment.leaseOwner === null || assignment.leaseExpiresAt === null || assignment.leaseExpiresAt.getTime() <= now.getTime()) {
    return 'this member turn has finished'
  }
  return { role: 'member', context, task, assignment, leaseGeneration: claim.leaseGeneration }
}

async function run(deps: TeamRouteDeps, actor: Lead | Member, command: Command, body: unknown): Promise<Answer> {
  if (actor.role === 'member') return askLead(deps, actor, body as Body<'ask-lead'>)
  switch (command) {
    case 'start':
      return start(deps, actor, body as Body<'start'>)
    case 'assign':
      return assign(deps, actor, body as Body<'assign'>)
    case 'answer':
      return answer(deps, actor, body as Body<'answer'>)
    case 'merge':
      return merge(deps, actor, body as Body<'merge'>)
    case 'cancel':
      return cancel(deps, actor, body as Body<'cancel'>)
    case 'finish':
      return finish(deps, actor)
    case 'status':
      return status(deps, actor)
    default:
      return refuse(403, `Only a team member can run relay team ${command}.`)
  }
}

// --- start --------------------------------------------------------------------

async function start(deps: TeamRouteDeps, lead: Lead, body: Body<'start'>): Promise<Answer> {
  // One start at a time per task, so a retry racing the first call cannot make a second worktree.
  return withLock(deps.pool, `team-start:${lead.task.id}`, async () => {
    const open = await loadOpenRun(deps.pool, lead.task.id)
    if (open !== undefined) {
      if (open.title.toLowerCase() === body.title.toLowerCase()) return done(`Team request "${open.title}" is already started.`, describeRun(open))
      return refuse(409, `This thread already has an open team request, "${open.title}"; finish it first (relay team finish).`)
    }

    const thread = await loadTaskThread(deps.pool, lead.task.id)
    if (thread === undefined) return refuse(403, "Team commands only work from a live Relay turn: its thread is gone.")
    const project = await projectForChannelWithRepos(deps.pool, deps.workspaceId, thread.ref.channel)
    if (project === undefined) return refuse(409, "This channel is not a project's channel, so there is no team to run.")
    const members = await listMembers(deps.pool, deps.workspaceId, project.id)
    if (!members.some((member) => member.isLead)) return refuse(409, `The ${project.name} team has no lead, so it cannot run; set a lead in the setup page (relay ui).`)

    // Unnamed, the folder's own git repo counts even when it is not linked or registered (decision 1).
    const repo = chooseRepo(deps, project, body.repo, body.repo === undefined ? await folderRepo(project.folder) : undefined)
    if (!repo.ok) return refuse(409, repo.reason)

    const runId = randomUUID()
    let prRef: string | null = null
    let place: { baseCommit: string; worktreePath: string | null; branch: string | null }
    if (body.pr !== undefined) {
      const pr = parsePrNumber(body.pr)
      if (pr === undefined) return refuse(400, `relay team start: --pr must be a PR number or a GitHub PR link, not "${String(body.pr).slice(0, 80)}".`)
      const fetched = await fetchPrHead(repo.entry, pr)
      if (!fetched.ok) return refuse(409, fetched.reason)
      prRef = String(body.pr)
      place = { baseCommit: fetched.commit, worktreePath: null, branch: null }
    } else {
      const made = await createRequestWorktree(repo.entry, runId, body.title)
      if (!made.ok) return refuse(409, made.reason)
      place = { baseCommit: made.baseCommit, worktreePath: made.path, branch: made.branch }
    }

    const snapshot = await snapshotTeam(deps, project, runId, members)
    const inserted = await insertRun(deps.pool, {
      id: runId,
      workspaceId: deps.workspaceId,
      taskId: lead.task.id,
      projectId: project.id,
      title: body.title,
      kind: prRef === null ? 'build' : 'pr-review',
      repoName: repo.entry.name,
      repoPath: repo.entry.path,
      prRef,
      ...place,
      snapshot,
    })
    return done(`Team request "${inserted.title}" started.`, describeRun(inserted), 201)
  })
}

function describeRun(run: TeamRun): Record<string, unknown> {
  return {
    runId: run.id,
    kind: run.kind,
    repo: run.repoName,
    worktree: run.worktreePath,
    branch: run.branch,
    baseCommit: run.baseCommit,
    ...(run.prRef === null ? {} : { pr: run.prRef }),
    members: run.snapshot.members.map((member) => ({ name: member.name, role: member.role, lead: member.isLead, client: member.client })),
  }
}

type RepoChoice = { ok: true; entry: RepoEntry } | { ok: false; reason: string }

const squash = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, '')

/**
 * Which repo a request works in (decision 1): a repo the message named,
 * matched by name or alias among the project's linked repos; unnamed, the
 * linked repo that is the project's folder or holds it, else the git repo
 * the folder is in (`own`), else the only linked repo.
 */
export function chooseRepo(deps: Pick<TeamRouteDeps, 'repo'>, project: Pick<Project, 'name' | 'folder' | 'repos'>, named: string | undefined, own?: RepoEntry): RepoChoice {
  const entries = project.repos.flatMap((name) => {
    const entry = deps.repo(name)
    return entry === undefined ? [] : [entry]
  })
  const names = project.repos.length === 0 ? 'none' : project.repos.join(', ')
  if (named !== undefined) {
    const wanted = squash(named)
    const matches = entries.filter((entry) => [entry.name, ...entry.aliases].some((candidate) => squash(candidate) === wanted))
    if (matches.length === 1 && matches[0] !== undefined) return { ok: true, entry: matches[0] }
    const how = matches.length === 0 ? 'matches none' : `matches several (${matches.map((entry) => entry.name).join(', ')})`
    return { ok: false, reason: `"${named}" ${how} of ${project.name}'s linked repos (${names}). Ask which one is meant; a repo not linked yet is added on the project's page in the setup page.` }
  }
  const folder = real(project.folder) + sep
  const containing = entries.filter((entry) => folder.startsWith(real(entry.path) + sep)).sort((a, b) => real(b.path).length - real(a.path).length)
  if (containing[0] !== undefined) return { ok: true, entry: containing[0] }
  if (own !== undefined) return { ok: true, entry: own }
  if (entries.length === 1 && entries[0] !== undefined) return { ok: true, entry: entries[0] }
  return { ok: false, reason: `No repo of ${project.name} is its folder, so name one with --repo. Its repos are: ${names}.` }
}

/** Copies the roster, the limit and each persona's text into the run, so later edits change nothing for it. */
async function snapshotTeam(deps: TeamRouteDeps, project: Project, runId: string, members: Awaited<ReturnType<typeof listMembers>>): Promise<RunSnapshot> {
  const runDir = join(deps.relayHome, 'team-runs', runId)
  const personaDir = join(runDir, 'personas')
  mkdirSync(personaDir, { recursive: true, mode: 0o700 })
  chmodSync(runDir, 0o700)
  chmodSync(personaDir, 0o700)
  const copied: SnapshotMember[] = []
  for (const member of members) {
    const persona = await getPersona(deps.pool, deps.workspaceId, member.personaId)
    const fileName = persona?.fileName ?? `${member.id}.md`
    const personaPath = join(personaDir, fileName)
    let personaText: string | undefined
    try {
      personaText = persona === undefined ? undefined : readPersona(deps.personasDir, persona.fileName)
    } catch {
      personaText = undefined
    }
    writeFileSync(personaPath, personaText ?? `(The persona "${member.personaName}" had no file when this team run started.)\n`, { mode: 0o600 })
    chmodSync(personaPath, 0o600)
    copied.push({ id: member.id, name: member.name, role: member.role, isLead: member.isLead, client: member.client, model: member.model, personaName: member.personaName, personaPath })
  }
  const { rows } = await deps.pool.query<{ id: string }>('SELECT id FROM teams WHERE workspace_id = $1 AND project_id = $2', [deps.workspaceId, project.id])
  return { members: copied, memberLimit: await getMemberLimit(deps.pool, deps.workspaceId, project.id), teamId: rows[0]?.id ?? '' }
}

// --- assignments ---------------------------------------------------------------

const NO_OPEN_RUN = 'This thread has no open team request; start one with relay team start.'

async function assign(deps: TeamRouteDeps, lead: Lead, body: Body<'assign'>): Promise<Answer> {
  const open = await loadOpenRun(deps.pool, lead.task.id)
  if (open === undefined) return refuse(409, NO_OPEN_RUN)
  const others = open.snapshot.members.filter((member) => !member.isLead)
  const member = others.find((candidate) => candidate.name.toLowerCase() === body.member.toLowerCase())
  if (member === undefined) return refuse(409, `"${body.member}" is not a member of this team run. Its members are: ${others.map((m) => `${m.name} (${m.role})`).join(', ') || 'none'}.`)
  if (open.kind === 'pr-review' && body.kind === 'build') return refuse(409, 'This is a PR review run: assign review or qa, not build.')
  const idemKey = body.key ?? createHash('sha256').update(`${open.id}\n${member.name}\n${body.kind}\n${body.brief}`).digest('hex')
  const { assignment, created } = await insertAssignment(deps.pool, { workspaceId: deps.workspaceId, run: open, memberId: member.id, memberName: member.name, kind: body.kind, brief: body.brief, idemKey })
  if (created) deps.wake()
  return done(
    created ? `Assigned ${body.kind} to ${member.name}: assignment ${assignment.id}.` : `${member.name} already has this assignment (${assignment.id}, ${assignment.state}); nothing was added.`,
    { assignment: assignment.id, member: member.name, kind: assignment.kind, state: assignment.state, created },
  )
}

/** An assignment named by the lead, only when it belongs to the lead's own task. */
async function ownAssignment(deps: TeamRouteDeps, lead: Lead, id: string): Promise<Assignment | undefined> {
  const assignment = await loadAssignment(deps.pool, id)
  return assignment !== undefined && assignment.taskId === lead.task.id && assignment.workspaceId === deps.workspaceId ? assignment : undefined
}

const notFound = (id: string): Answer => refuse(404, `No assignment ${id} in this thread's team runs.`)

async function answer(deps: TeamRouteDeps, lead: Lead, body: Body<'answer'>): Promise<Answer> {
  const assignment = await ownAssignment(deps, lead, body.assignment)
  if (assignment === undefined) return notFound(body.assignment)
  // A retry after a timeout: the same answer is already the latest.
  if (assignment.answers.at(-1) === body.text) return done(`${assignment.memberName} already has this answer.`, { assignment: assignment.id, state: assignment.state })
  const answered = await answerAssignment(deps.pool, assignment.id, body.text)
  if (answered === undefined) return refuse(409, `${assignment.memberName}'s assignment ${assignment.id} is ${assignment.state}; it takes no answer.`)
  deps.wake()
  return done(`Sent to ${answered.memberName}; it reads the answer in its next turn.`, { assignment: answered.id, state: answered.state })
}

async function merge(deps: TeamRouteDeps, lead: Lead, body: Body<'merge'>): Promise<Answer> {
  const assignment = await ownAssignment(deps, lead, body.assignment)
  if (assignment === undefined) return notFound(body.assignment)
  const teamRun = await loadRun(deps.pool, assignment.runId)
  if (teamRun === undefined) return notFound(body.assignment)
  if (teamRun.status !== 'open') return refuse(409, `This team run is ${teamRun.status}; nothing more is merged.`)
  const outcome = await mergeAssignment(deps.pool, teamRun, assignment)
  switch (outcome.kind) {
    case 'merged':
      return done(
        outcome.already ? `${assignment.memberName}'s work is already on ${teamRun.branch}; head ${outcome.head}.` : `Merged ${assignment.memberName}'s work into ${teamRun.branch}; head ${outcome.head}.`,
        { merged: true, already: outcome.already, head: outcome.head, branch: teamRun.branch },
      )
    case 'conflict':
      return {
        status: 409,
        body: {
          ok: false,
          message: `${assignment.memberName}'s commit conflicts with ${teamRun.branch} in: ${outcome.files.join(', ')}. The merge was aborted and the branch is as it was; assign the fix (for example to ${assignment.memberName}) and merge its new commit.`,
          merged: false,
          conflict: outcome.files,
        },
      }
    case 'refused':
      return refuse(409, outcome.reason)
  }
}

async function cancel(deps: TeamRouteDeps, lead: Lead, body: Body<'cancel'>): Promise<Answer> {
  const assignment = await ownAssignment(deps, lead, body.assignment)
  if (assignment === undefined) return notFound(body.assignment)
  const pgids = await cancelAssignment(deps.pool, assignment.id)
  await deps.killGroups(pgids)
  const after = await loadAssignment(deps.pool, assignment.id)
  return done(after?.state === 'cancelled' ? `${assignment.memberName}'s assignment ${assignment.id} is cancelled.` : `${assignment.memberName}'s assignment ${assignment.id} was already ${after?.state ?? assignment.state}.`, {
    assignment: assignment.id,
    state: after?.state ?? assignment.state,
  })
}

async function finish(deps: TeamRouteDeps, lead: Lead): Promise<Answer> {
  const open = await loadOpenRun(deps.pool, lead.task.id)
  if (open === undefined) return done('This thread has no open team request; nothing to finish.')
  const pgids = await closeRun(deps.pool, open.id, 'finished')
  await deps.killGroups(pgids)
  return done(`Team request "${open.title}" is finished.${open.worktreePath === null ? '' : ` Its worktree stays at ${open.worktreePath} on ${open.branch}.`}`, { runId: open.id })
}

async function status(deps: TeamRouteDeps, lead: Lead): Promise<Answer> {
  const teamRun = (await loadOpenRun(deps.pool, lead.task.id)) ?? (await latestRun(deps.pool, lead.task.id))
  if (teamRun === undefined) return done('This thread has no team request yet.')
  const assignments = await listRunAssignments(deps.pool, teamRun.id)
  const merges = await listRunMerges(deps.pool, teamRun.id)
  const requestHead = teamRun.kind === 'build' && teamRun.worktreePath !== null ? await headOf(teamRun.worktreePath) : null
  const rows = assignments.map((assignment) => {
    const lastMerge = merges.find((record) => record.assignmentId === assignment.id)
    const stale = teamRun.kind === 'build' && assignment.kind !== 'build' && assignment.checkedCommit !== null && requestHead !== null && assignment.checkedCommit !== requestHead
    return {
      id: assignment.id,
      member: assignment.memberName,
      kind: assignment.kind,
      state: assignment.state,
      question: assignment.question,
      resultCommit: assignment.resultCommit,
      checkedCommit: assignment.checkedCommit,
      stale,
      merge: lastMerge === undefined ? null : { state: lastMerge.state, commit: lastMerge.memberCommit, conflictFiles: lastMerge.conflictFiles },
    }
  })
  const lines = [
    `Team request "${teamRun.title}" (${teamRun.kind}, ${teamRun.status}) in ${teamRun.repoName}.`,
    teamRun.worktreePath === null ? `Base: ${teamRun.baseCommit} (PR ${teamRun.prRef ?? ''}).` : `Request worktree: ${teamRun.worktreePath} on ${teamRun.branch}, head ${requestHead ?? 'unknown'}.`,
    ...(rows.length === 0 ? ['No assignments yet.'] : rows.map(statusLine)),
  ]
  return done(lines.join('\n'), { runId: teamRun.id, kind: teamRun.kind, runStatus: teamRun.status, worktree: teamRun.worktreePath, branch: teamRun.branch, requestHead, assignments: rows })
}

function statusLine(row: { id: string; member: string; kind: string; state: string; question: string | null; resultCommit: string | null; checkedCommit: string | null; stale: boolean; merge: { state: string } | null }): string {
  const parts = [`- ${row.member}, ${row.kind}, ${row.state} (assignment ${row.id})`]
  if (row.resultCommit !== null) parts.push(`result ${row.resultCommit}`)
  if (row.checkedCommit !== null) parts.push(`checked ${row.checkedCommit}${row.stale ? ' (STALE: the request branch moved since)' : ''}`)
  if (row.merge !== null) parts.push(`merge ${row.merge.state}`)
  if (row.question !== null) parts.push(`asks: ${row.question}`)
  return parts.join('; ')
}

async function latestRun(pool: Pool, taskId: string): Promise<TeamRun | undefined> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM team_runs WHERE task_id = $1 ORDER BY created_at DESC, id LIMIT 1', [taskId])
  return rows[0] === undefined ? undefined : loadRun(pool, rows[0].id)
}

// --- the member's command --------------------------------------------------------

async function askLead(deps: TeamRouteDeps, member: Member, body: Body<'ask-lead'>): Promise<Answer> {
  const { assignment } = member
  const sent = 'Sent to the lead. End your turn now; the answer comes in your next turn.'
  // A retry after a timeout: this question is already with the lead.
  if (assignment.question === body.text) return done(sent)
  const note = [
    `Team: ${assignment.memberName} (${assignment.kind} assignment ${assignment.id}) asks you, quoted as data:`,
    renderForModel(wrapUntrusted(body.text)),
    `Answer with: relay team answer --assignment ${assignment.id} --text "..."`,
  ].join('\n')
  const lease = { assignmentId: assignment.id, owner: assignment.leaseOwner ?? '', generation: member.leaseGeneration }
  const written = await updateAssignmentAndTellLead(deps.pool, lease, { question: body.text }, note)
  if (!written) return refuse(403, 'Team commands only work from a live Relay turn: this task was stopped or this member turn was superseded.')
  return done(sent)
}

// --- locking ---------------------------------------------------------------------

async function withLock<T>(pool: Pool, key: string, body: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect()
  let releaseError: Error | undefined
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
    try {
      return await body()
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch((error: unknown) => {
        releaseError = error instanceof Error ? error : new Error(String(error))
      })
    }
  } finally {
    client.release(releaseError)
  }
}
