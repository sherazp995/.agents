/**
 * Scheduler effects that only touch the task, the repo registry and the
 * thread: binding a plan to a registered repository, the task worktree,
 * file downloads and the final post.
 */

import type { Pool } from 'pg'
import type { ChatAction, ChatRef } from '../chat/contract.js'
import { resolveRepo } from '../repos/resolve.js'
import type { RepoEntry, RepoRegistry } from '../repos/schema.js'
import { createWorktree, type WorktreeDependencies } from '../repos/worktree.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { describeSkipped, downloadPendingFiles, type DownloadDeps } from './files.js'
import type { PlanPayload } from './reply.js'
import type { PlanBinding } from './scheduler.js'
import { updateTask, type AutonomousTask, type Lease, type TaskFinding } from './store.js'

/** Resolves plan.repo; an ambiguous or unregistered name names the reason and the registered repositories. */
export function bindPlan(registry: RepoRegistry, plan: PlanPayload): PlanBinding {
  const resolution = resolveRepo(plan.repo, registry)
  if (resolution.outcome === 'resolved') return { kind: 'bound', repoName: resolution.repo.name }
  const registered = registry.repos.map((repo) => repo.name).join(', ') || 'none'
  return { kind: 'unbound', reason: `I could not tell which repository "${plan.repo}" means: ${resolution.reason} Registered: ${registered}.` }
}

/** The registry entry the task is bound to: the only source of its worktree, base branch and canonical URL. */
export function boundRepo(registry: RepoRegistry, task: Pick<AutonomousTask, 'repoName'>): RepoEntry | undefined {
  return registry.repos.find((repo) => repo.name === task.repoName)
}

/** Creates the task worktree from the bound registry entry once; later turns reuse it. */
export async function prepareTaskWorktree(
  pool: Pool,
  registry: RepoRegistry,
  task: AutonomousTask,
  lease: Lease,
  deps: WorktreeDependencies = {},
): Promise<void> {
  if (task.worktreePath !== null) return
  const repo = boundRepo(registry, task)
  if (!repo) throw new Error(`task ${task.id} is bound to "${task.repoName ?? ''}", which is not in the repo registry`)
  const title = typeof task.plan === 'object' && task.plan !== null ? String((task.plan as { summary?: unknown }).summary ?? 'task') : 'task'
  const created = createWorktree(repo, task.id, title, deps)
  if (created.outcome === 'refused') throw new Error(created.reason)
  await updateTask(pool, lease, { worktreePath: created.path })
}

/** Downloads pending files before a turn; returns one line per newly skipped file for the thread. */
export async function downloadTaskFiles(pool: Pool, task: AutonomousTask, lease: Lease, deps: Omit<DownloadDeps, 'inboxDir'> & { inboxDir: (taskId: string) => string }): Promise<string[]> {
  if (!task.files.some((file) => file.status === 'pending')) return []
  const settled = await downloadPendingFiles(task.files, { ...deps, inboxDir: deps.inboxDir(task.id) })
  await updateTask(pool, lease, { files: settled })
  const before = new Set(task.files.filter((file) => file.status === 'skipped').map((file) => file.slackFileId))
  return describeSkipped(settled.filter((file) => !before.has(file.slackFileId)))
}

/** `SEVERITY summary: file:line`, in-scope first; out-of-scope findings are listed as not fixed. */
export function renderFindings(findings: readonly TaskFinding[]): string {
  const line = (finding: TaskFinding): string =>
    `- ${finding.id} ${finding.severity.toUpperCase()} ${finding.summary}: ${finding.file}${finding.line !== null ? `:${finding.line}` : ''} (${finding.status})`
  const inScope = findings.filter((finding) => finding.inScope !== false)
  const outOfScope = findings.filter((finding) => finding.inScope === false)
  const parts: string[] = []
  if (inScope.length > 0) parts.push(`Findings:\n${inScope.map(line).join('\n')}`)
  if (outOfScope.length > 0) parts.push(`Out of scope, not fixed:\n${outOfScope.map(line).join('\n')}`)
  return parts.join('\n\n')
}

/** The final post (skipped when empty) and reaction: findings scrubbed, ✅ on done, ❌ on blocked. */
export async function finishTask(
  post: (action: ChatAction) => Promise<void>,
  refs: { reply: ChatRef; mention: Required<Pick<ChatRef, 'channel' | 'message'>> & ChatRef },
  task: Pick<AutonomousTask, 'findings'>,
  outcome: 'done' | 'blocked',
  text: string,
): Promise<void> {
  const body = [text, renderFindings(task.findings)].filter((part) => part.trim() !== '').join('\n\n')
  if (body.trim() !== '') await post({ kind: 'post', ref: refs.reply, text: scrubSecrets(body) })
  await post({ kind: 'react', ref: refs.mention, name: outcome === 'done' ? 'white_check_mark' : 'x' })
}
