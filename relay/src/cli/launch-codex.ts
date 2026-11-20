/**
 * The Codex half of `relay codex` (src/cli/launch.ts): finding the chat a
 * launch started, linking its Slack thread to it, keeping the record the
 * daemon reads to queue replies into it (src/live/open-codex.ts), and reading
 * a usage limit or expired login from its saved chat.
 *
 * Codex saves a chat (its "rollout") only after the first message, and every
 * login's sessions folder links to one shared folder, so the launch puts a
 * marker of its own in the chat's instructions and watches that folder for a
 * chat holding the marker until the chat exits.
 */

import { readFile, stat } from 'node:fs/promises'
import { blockedReasonIn, type BlockedReason } from '../autonomous/accounts.js'
import { findChatsByMarker, findRolloutById } from '../live/codex-rollouts.js'
import { TakenOverSessionError } from '../sessions/store.js'

/** Exits that mean "this login cannot serve now; carry on on the next one". */
const SWITCH_REASONS: readonly BlockedReason[] = ['usage_limit', 'auth']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Options of `codex` and `codex resume` that take a value (`codex resume --help`, 0.166.0). */
const VALUE_FLAGS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'])

/** The line a launch adds to the chat's instructions; Codex saves it with the chat, which is how the launch finds it. */
export function codexMarkerLine(marker: string): string {
  return `Relay launch marker (for Relay to find this chat; ignore it): ${marker}`
}

/** The chat `codex resume <id>` names, or null for a new chat, `resume --last`, a bare `resume` or a `fork`. */
export function codexChatFromArgs(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg.startsWith('-')) {
      // `-m o3 resume <id>`: a flag's value is not the subcommand.
      if (VALUE_FLAGS.has(arg)) index++
      continue
    }
    const id = args[index + 1]
    return arg === 'resume' && id !== undefined && UUID.test(id) ? id : null
  }
  return null
}

/**
 * The user's arguments to resume `chatId` on another login: `resume <id>`
 * with their options kept and any subcommand, chat id or opening prompt
 * dropped, so the prompt is not sent a second time.
 */
export function codexResumeArgs(userArgs: readonly string[], chatId: string): string[] {
  const kept: string[] = []
  for (let index = 0; index < userArgs.length; index++) {
    const arg = userArgs[index] ?? ''
    if (!arg.startsWith('-') || arg === '--last' || arg === '--all') continue
    kept.push(arg)
    if (VALUE_FLAGS.has(arg) && index + 1 < userArgs.length) kept.push(userArgs[++index] ?? '')
  }
  return ['resume', chatId, ...kept]
}

type RolloutLine = { type?: string; payload?: { type?: string; error?: { message?: unknown } | null } }

/** Why a Codex chat stopped on a blocked login, from its last finished turn; null when it did not. */
export function codexRolloutBlockedReason(rollout: string): BlockedReason | null {
  const lines = rollout.trimEnd().split('\n').reverse()
  for (const line of lines) {
    let entry: RolloutLine
    try {
      entry = JSON.parse(line) as RolloutLine
    } catch {
      continue
    }
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'task_complete') continue
    // Only the last turn counts: a limit the chat got past earlier is not why it stopped.
    const message = entry.payload.error?.message
    if (typeof message !== 'string') return null
    const reason = blockedReasonIn(message)
    return reason !== null && SWITCH_REASONS.includes(reason) ? reason : null
  }
  return null
}

export type LaunchThread = { readonly channel: string; readonly thread: string }

export type CodexLaunchDeps = {
  /** The shared sessions folder every Codex login saves its chats in. */
  readonly sessionsRoot: string
  /** Links the thread to the chat as a Codex chat; throws TakenOverSessionError when Relay's loop has the thread. */
  readonly link: (thread: LaunchThread, chatId: string) => Promise<void>
  /** Posts a short note in the thread. */
  readonly noteInThread: (thread: LaunchThread, text: string) => Promise<void>
  readonly writeRecord: (record: { chatId: string; pid: number; codexHome: string }) => Promise<void>
  readonly deleteRecord: (chatId: string) => Promise<void>
  readonly pollMs?: number
}

/** A link that keeps failing (the database unreachable) is tried this many times per run, then left. */
const LINK_ATTEMPTS = 5

/**
 * Watches one run of a Codex chat: finds the chat (by `knownChat`, or by the
 * marker), links the thread once, keeps the open-chat record for this run's
 * process, and posts once in the thread when the chat hits a limit. Errors
 * become notes; the chat itself is never stopped.
 */
export class CodexChatWatch {
  chatId: string | null
  private linked = false
  private linkAttempts = 0
  private limitNoted = false
  /** How much of the saved chat existed when this run started: anything before it belongs to an earlier run. */
  private baseline: number | null = null
  private rolloutPath: string | null = null
  private seenSize = -1
  private stopped = false
  private recordFor: number | null = null
  private loop: Promise<void> | null = null

  constructor(
    private readonly deps: CodexLaunchDeps,
    private readonly params: { marker: string; sinceMs: number; thread: LaunchThread | null; knownChat: string | null; say: (text: string) => void },
  ) {
    this.chatId = params.knownChat
  }

  /** Starts watching the run whose process is `pid`, on the login whose folder is `codexHome`. */
  start(pid: number, codexHome: string, account: string): void {
    this.stopped = false
    this.recordFor = null
    this.limitNoted = false
    this.baseline = null
    this.seenSize = -1
    this.linkAttempts = 0
    this.loop = this.watch(pid, codexHome, account)
  }

  /** Stops watching after one last look, and removes the record. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.loop
    this.loop = null
    if (this.chatId !== null && this.recordFor !== null) await this.deps.deleteRecord(this.chatId).catch(() => undefined)
  }

  /** Why this run of the chat stopped on a blocked login, from turns it finished itself; null when it did not. */
  async blockedThisRun(): Promise<BlockedReason | null> {
    const rollout = await this.readRollout()
    return rollout === null || this.baseline === null ? null : codexRolloutBlockedReason(rollout.slice(this.baseline))
  }

  private async readRollout(): Promise<string | null> {
    if (this.chatId === null) return null
    this.rolloutPath ??= await findRolloutById(this.deps.sessionsRoot, this.chatId, 0)
    return this.rolloutPath === null ? null : readFile(this.rolloutPath, 'utf8').catch(() => null)
  }

  private async watch(pid: number, codexHome: string, account: string): Promise<void> {
    const pollMs = this.deps.pollMs ?? 1_000
    let ambiguous = false
    for (;;) {
      const last = this.stopped
      try {
        // Taken at once, before the chat writes anything: a chat named up front keeps what it already has, and a
        // chat found later by its marker began in this run.
        if (this.baseline === null) this.baseline = this.chatId === null ? 0 : ((await this.readRollout())?.length ?? 0)
        if (this.chatId === null && !ambiguous) {
          const matches = await findChatsByMarker(this.deps.sessionsRoot, this.params.marker, this.params.sinceMs)
          if (matches.length > 1) {
            ambiguous = true
            this.params.say(`Found ${matches.length} Codex chats from this launch, so its Slack thread is not linked; replies there stay with Relay's own loop.`)
          } else if (matches[0] !== undefined) {
            this.chatId = matches[0].chatId
            this.rolloutPath = matches[0].path
          }
        }
        if (this.chatId !== null && !last) await this.linkAndRecord(pid, codexHome)
        if (this.chatId !== null && this.params.thread !== null && !this.limitNoted) await this.noteLimit(account)
      } catch (error) {
        this.params.say(`Watching the Codex chat failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (last) return
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  private async linkAndRecord(pid: number, codexHome: string): Promise<void> {
    const chatId = this.chatId
    if (chatId === null) return
    if (this.params.thread !== null && !this.linked && this.linkAttempts < LINK_ATTEMPTS) {
      this.linkAttempts++
      try {
        await this.deps.link(this.params.thread, chatId)
        this.linked = true
        this.params.say('Slack thread linked: replies there now reach this chat.')
      } catch (error) {
        if (error instanceof TakenOverSessionError) {
          this.linked = true
          this.params.say(`The Slack thread is not linked: ${error.message}.`)
        } else if (this.linkAttempts >= LINK_ATTEMPTS) {
          this.params.say(`The Slack thread could not be linked, so replies there stay with Relay's own loop: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    if (this.recordFor !== pid) {
      await this.deps.writeRecord({ chatId, pid, codexHome })
      this.recordFor = pid
    }
  }

  private async noteLimit(account: string): Promise<void> {
    const thread = this.params.thread
    if (this.chatId === null || thread === null) return
    this.rolloutPath ??= await findRolloutById(this.deps.sessionsRoot, this.chatId, 0)
    if (this.rolloutPath === null) return
    // Read again only when the chat wrote more.
    const size = (await stat(this.rolloutPath).catch(() => null))?.size ?? -1
    if (size === this.seenSize) return
    this.seenSize = size
    const reason = await this.blockedThisRun()
    if (reason === null) return
    this.limitNoted = true
    await this.deps.noteInThread(thread, `${account} hit its ${reason === 'auth' ? 'login expiry' : 'usage limit'}. Quit the terminal chat (/exit) and Relay resumes it on the next free Codex login.`)
  }
}
