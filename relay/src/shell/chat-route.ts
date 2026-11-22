/**
 * Where a `!` message leaves handleChatEvent (src/orchestrator.ts): the
 * owner's shell lines start a job (job.ts) instead of agent work, and a plain
 * unmentioned reply in a thread that only has shell history is dropped, as
 * the adapter dropped it before shell threads became known to it.
 */

import { homedir } from 'node:os'
import { knownHomes, mapPath } from '../failover/paths.js'
import type { Pool } from 'pg'
import type { ChatAdapter, ChatEvent, ChatRef } from '../chat/contract.js'
import type { FolderQuestions } from '../chat/slack/folder-questions.js'
import { unwrapForAudit } from '../agent/untrusted.js'
import type { Logger } from '../obs/logger.js'
import type { Session } from '../sessions/store.js'
import { principalIsOwner } from '../tenancy/access.js'
import { hasShellFolder } from './folder-store.js'
import type { ShellJobs, StartFolder } from './job.js'
import { parseShellMessage } from './parse.js'

export const SHELL_OWNER_ONLY_TEXT = 'Only the owner of this Relay can run `!` commands, so nothing ran.'
export const SHELL_NEEDS_KILL_SWITCH_TEXT = 'Shell from Slack needs the kill switch, which is not available right now, so nothing ran.'

export type ShellRouteDeps = {
  readonly pool: Pool
  readonly dispatcher: ChatAdapter
  readonly log: Logger
  readonly shell: ShellJobs
  /** Shell lines run only while a kill switch can stop them. */
  readonly killSwitchAvailable: boolean
  readonly folderQuestions?: FolderQuestions
  readonly home?: string
}

export type ShellRouteContext = {
  readonly principalId: string
  readonly threadRef: string
  readonly replyRef: ChatRef
  /** The thread's active session, if any: its chat folder is the shell's start folder, and never moves. */
  readonly existing: Pick<Session, 'id' | 'mode' | 'engineCwd'> | null
}

/** `handled` when the event was a shell message (run or refused) or a plain reply to drop; `continue` for every other event. */
export async function routeShellEvent(deps: ShellRouteDeps, event: ChatEvent, context: ShellRouteContext): Promise<'handled' | 'continue'> {
  const parsed = parseShellMessage(unwrapForAudit(event.text), { mentionsBot: event.mentionsBot })
  if (parsed.kind === 'not_shell') {
    return (await isPlainReplyInShellThread(deps, event, context)) ? 'handled' : 'continue'
  }
  const post = (text: string): Promise<unknown> => deps.dispatcher.perform({ kind: 'post', ref: context.replyRef, text })

  if (!(await principalIsOwner(deps.pool, event.workspaceId, context.principalId))) {
    deps.log.warn({ workspaceId: event.workspaceId, principalId: context.principalId }, 'shell: refused a member')
    await post(SHELL_OWNER_ONLY_TEXT)
    return 'handled'
  }
  if (!deps.killSwitchAvailable) {
    await post(SHELL_NEEDS_KILL_SWITCH_TEXT)
    return 'handled'
  }
  if (parsed.kind === 'refused') {
    await post(parsed.reason)
    return 'handled'
  }

  const threadTs = context.replyRef.thread
  if (threadTs === undefined) throw new Error('routeShellEvent: the reply ref has no thread')
  const sessionFolder = context.existing === null ? undefined : await chatFolder(deps, event.workspaceId, context.existing)
  const refusal = deps.shell.start(context.threadRef, {
    thread: { workspaceId: event.workspaceId, adapter: event.adapter, threadRef: context.threadRef },
    principalId: context.principalId,
    channel: context.replyRef.channel,
    threadTs,
    commands: parsed.commands,
    startFolder: () => startFolder(deps, context.replyRef.channel, sessionFolder),
    ...(sessionFolder !== undefined ? { sessionFolder } : {}),
  })
  if (refusal !== undefined) await post(refusal)
  return 'handled'
}

/**
 * Where the thread's Claude or Codex chat works: a linked or direct chat keeps it on the session
 * (engine_cwd); an autonomous task keeps it on its newest task (chat_cwd), mapped to this laptop's home.
 */
async function chatFolder(deps: ShellRouteDeps, workspaceId: string, session: Pick<Session, 'id' | 'mode' | 'engineCwd'>): Promise<string | undefined> {
  if (session.engineCwd !== null) return session.engineCwd
  if (session.mode !== 'autonomous') return undefined
  const { rows } = await deps.pool.query<{ chat_cwd: string | null }>(
    'SELECT chat_cwd FROM autonomous_tasks WHERE session_id = $1 AND workspace_id = $2 AND chat_cwd IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
    [session.id, workspaceId],
  )
  const folder = rows[0]?.chat_cwd ?? undefined
  return folder === undefined ? undefined : mapPath(folder, await knownHomes(deps.pool), deps.home ?? homedir())
}

/** The thread's chat folder, else the channel's project or described folder, else home. */
async function startFolder(deps: ShellRouteDeps, channel: string, sessionFolder: string | undefined): Promise<StartFolder> {
  if (sessionFolder !== undefined) return { kind: 'folder', path: sessionFolder }
  const found = (await deps.folderQuestions?.folderForShell(channel)) ?? { kind: 'none' as const }
  if (found.kind === 'refused') return found
  return { kind: 'folder', path: found.kind === 'folder' ? found.path : (deps.home ?? homedir()) }
}

/** A channel thread reply that does not mention Relay, in a thread with shell history and no session: the adapter let it through only because of the shell. */
async function isPlainReplyInShellThread(deps: ShellRouteDeps, event: ChatEvent, context: ShellRouteContext): Promise<boolean> {
  if (context.existing !== null || event.mentionsBot || event.kind !== 'thread_reply' || event.ref.channel.startsWith('D')) return false
  if (deps.shell.isActive(context.threadRef)) return true
  return hasShellFolder(deps.pool, { workspaceId: event.workspaceId, adapter: event.adapter, threadRef: context.threadRef })
}
