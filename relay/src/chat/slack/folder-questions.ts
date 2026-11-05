/**
 * New threads in a channel whose description names a folder run in that
 * folder (src/chat/slack/channel-folder.ts). When the folder is not on this
 * machine, Relay asks in the thread and keeps the request here until the
 * person who sent it replies with a folder that exists, or says stop.
 *
 * Kept in memory only, so a restart forgets a waiting request: nothing then
 * starts anywhere, and the request has to be sent again. An answer claims
 * its request before anything starts, so one answer starts at most once and
 * a start that fails after the claim is never replayed.
 */

import { homedir } from 'node:os'
import { unwrapForAudit } from '../../agent/untrusted.js'
import type { ChatEvent } from '../contract.js'
import type { Logger } from '../../obs/logger.js'
import { isFolder, namedFolder } from '../../autonomous/folder.js'
import { expandFolderPath, firstFolderPath, type ChannelFolderLookup } from './channel-folder.js'

/** What was asked for, kept so the answer starts it in the same mode. `direct` carries no files, as `direct` takes none. */
export type WaitingRequest =
  | { readonly mode: 'autonomous'; readonly event: ChatEvent }
  | { readonly mode: 'direct'; readonly text: string }

export type NewThreadFolder =
  /** The description names no folder (or this is a DM): today's rules pick one. */
  | { readonly kind: 'today' }
  | { readonly kind: 'folder'; readonly path: string }
  /** Nothing starts; `text` is posted to the thread. `asked` means the request now waits for an answer. */
  | { readonly kind: 'asked' | 'refused'; readonly text: string }

export type FolderAnswer =
  | { readonly kind: 'not_waiting' }
  /** Someone other than the requester spoke in the thread; nothing is posted. */
  | { readonly kind: 'ignored' }
  | { readonly kind: 'ask_again'; readonly text: string }
  | { readonly kind: 'claimed'; readonly request: WaitingRequest; readonly folder: string }

export const WAITING_TTL_MS = 24 * 60 * 60 * 1000

export const ASK_AGAIN_TEXT = 'That reply names no folder that exists on this machine. Reply with the folder to use, or "stop" to drop the request.'
export const CANCELLED_TEXT = 'Dropped the request that was waiting for a folder.'
export const RESEND_TEXT = 'Send the request again to retry.'
const UNREADABLE_TEXT = 'I could not read this channel\'s description, so I did not start. Mention me again.'
const MISSING_SCOPE_TEXT =
  'I could not read this channel\'s description, so I did not start: reinstall the Slack app from ' +
  '`docs/slack-app-manifest.yaml`, which now asks for `channels:read` and `groups:read`.'

export function questionText(missing: string, source: 'description' | 'project' = 'description'): string {
  const named = source === 'project' ? `This channel's project (set up in relay ui) uses \`${missing}\`` : `This channel's description names \`${missing}\``
  return `${named}, which is not a folder on this machine. Reply here with the folder to use (for example \`~/code/project\`), or "stop" to drop the request.`
}

type Waiting = { readonly request: WaitingRequest; readonly principalId: string; readonly expiresAt: number }

export type FolderQuestionsDeps = {
  readonly lookup: (channel: string) => Promise<ChannelFolderLookup>
  /** The folder of the project that owns the channel (set up in relay ui); it wins over the channel description. */
  readonly projectFolder?: (channel: string) => Promise<string | undefined>
  readonly now?: () => number
  readonly home?: string
}

export class FolderQuestions {
  readonly #lookup: FolderQuestionsDeps['lookup']
  readonly #projectFolder: NonNullable<FolderQuestionsDeps['projectFolder']>
  readonly #now: () => number
  readonly #home: string
  readonly #waiting = new Map<string, Waiting>()

  constructor(deps: FolderQuestionsDeps) {
    this.#lookup = deps.lookup
    this.#projectFolder = deps.projectFolder ?? (async () => undefined)
    this.#now = deps.now ?? Date.now
    this.#home = deps.home ?? homedir()
  }

  /** Where a new thread's session runs. When the channel's folder is missing, `request` waits for `principalId` to name one. */
  async forNewThread(threadRef: string, channel: string, principalId: string, request: WaitingRequest): Promise<NewThreadFolder> {
    // A project's folder wins; one that no longer exists is asked about like a missing described folder.
    const project = await this.#projectFolder(channel)
    if (project !== undefined) return isFolder(project) ? { kind: 'folder', path: project } : this.#ask(threadRef, principalId, request, project, 'project')
    const found = await this.#lookup(channel)
    if (found.kind === 'none') return { kind: 'today' }
    if (found.kind === 'failed') return { kind: 'refused', text: found.missingScope ? MISSING_SCOPE_TEXT : UNREADABLE_TEXT }
    if (isFolder(found.path)) return { kind: 'folder', path: found.path }
    return this.#ask(threadRef, principalId, request, found.path, 'description')
  }

  #ask(threadRef: string, principalId: string, request: WaitingRequest, missing: string, source: 'description' | 'project'): NewThreadFolder {
    this.#prune()
    this.#waiting.set(threadRef, { request, principalId, expiresAt: this.#now() + WAITING_TTL_MS })
    return { kind: 'asked', text: questionText(missing, source) }
  }

  isWaiting(threadRef: string): boolean {
    return this.#current(threadRef) !== undefined
  }

  /** A message in a waiting thread. A folder from the requester claims the request: it is gone before the caller starts it. */
  answer(threadRef: string, principalId: string, text: string): FolderAnswer {
    const waiting = this.#current(threadRef)
    if (waiting === undefined) return { kind: 'not_waiting' }
    if (waiting.principalId !== principalId) return { kind: 'ignored' }
    // The same path grammar as the description (quotes, `~/`), then any other folder the reply names.
    const first = firstFolderPath(text)
    const folder = first !== undefined && isFolder(expandFolderPath(first, this.#home)) ? expandFolderPath(first, this.#home) : namedFolder(text, this.#home)
    if (folder === undefined) return { kind: 'ask_again', text: ASK_AGAIN_TEXT }
    this.#waiting.delete(threadRef)
    return { kind: 'claimed', request: waiting.request, folder }
  }

  /** "stop" from the requester in a waiting thread; false when nothing of theirs was waiting. */
  cancel(threadRef: string, principalId: string): boolean {
    if (this.#current(threadRef)?.principalId !== principalId) return false
    return this.#waiting.delete(threadRef)
  }

  #current(threadRef: string): Waiting | undefined {
    const waiting = this.#waiting.get(threadRef)
    if (waiting !== undefined && waiting.expiresAt <= this.#now()) {
      this.#waiting.delete(threadRef)
      return undefined
    }
    return waiting
  }

  #prune(): void {
    const now = this.#now()
    for (const [threadRef, waiting] of this.#waiting) if (waiting.expiresAt <= now) this.#waiting.delete(threadRef)
  }
}

export type FolderGateDeps = {
  readonly questions: FolderQuestions
  /** Posts to the event's thread. */
  readonly post: (text: string) => Promise<unknown>
  /** Absent when autonomous mode is off: governed threads keep today's folder rules. */
  readonly routeAutonomous?: (event: ChatEvent, chatCwd: string) => Promise<'handled' | 'not_autonomous'>
  /** Starts an answered `direct` request as a direct session in this thread. */
  readonly startDirect: (text: string, folder: string) => Promise<void>
  readonly log: Logger
}

/** `continue`: route the event as usual, in `chatCwd` when the channel decided one. */
export type FolderGateResult = { readonly kind: 'handled' } | { readonly kind: 'continue'; readonly chatCwd?: string }

/**
 * For a message in a thread with no session: the answer to a waiting folder
 * question, or a new autonomous thread whose folder the channel decides.
 * A claimed request that fails to start is not replayed; the thread is told
 * to send it again.
 */
export async function folderGate(deps: FolderGateDeps, event: ChatEvent, threadRef: string, principalId: string): Promise<FolderGateResult> {
  const answer = deps.questions.answer(threadRef, principalId, unwrapForAudit(event.text))
  if (answer.kind === 'ignored') return { kind: 'handled' }
  if (answer.kind === 'ask_again') {
    await deps.post(answer.text)
    return { kind: 'handled' }
  }
  if (answer.kind === 'claimed') {
    await startClaimed(deps, answer.request, answer.folder, event)
    return { kind: 'handled' }
  }

  if (deps.routeAutonomous === undefined) return { kind: 'continue' }
  const folder = await deps.questions.forNewThread(threadRef, event.ref.channel, principalId, { mode: 'autonomous', event })
  if (folder.kind === 'today') return { kind: 'continue' }
  if (folder.kind === 'folder') return { kind: 'continue', chatCwd: folder.path }
  await deps.post(folder.text)
  return { kind: 'handled' }
}

async function startClaimed(deps: FolderGateDeps, request: WaitingRequest, folder: string, answer: ChatEvent): Promise<void> {
  try {
    if (request.mode === 'direct') {
      await deps.startDirect(request.text, folder)
      return
    }
    if (deps.routeAutonomous === undefined) {
      await deps.post(`Autonomous mode is off on this Relay. ${RESEND_TEXT}`)
      return
    }
    if ((await deps.routeAutonomous(request.event, folder)) === 'not_autonomous') {
      await deps.post(`Could not start the request in \`${folder}\`: this thread already belongs to another kind of session. ${RESEND_TEXT}`)
      return
    }
  } catch (error) {
    deps.log.error({ err: error, mode: request.mode }, 'an answered folder question failed to start its request')
    await deps.post(`Something failed while starting the request in \`${folder}\`. Check whether it ran before sending it again.`)
    return
  }
  // The task now exists, so a failure from here on must not ask for a resend (that would start it twice).
  // The answer joins it, in case it said more than the folder.
  try {
    await deps.routeAutonomous(answer, folder)
  } catch (error) {
    deps.log.warn({ err: error }, 'the answer to a folder question did not reach its new task')
  }
}
