/**
 * Runs `!` messages (README, "Shell from Slack"): one job per message, the
 * jobs of one thread one after another, each line in the thread's folder,
 * the first failure skipping the rest, and one reply edited in order.
 *
 * Nothing here is stored except the thread's folder (folder-store.ts). Jobs,
 * password requests and the per thread queue live in memory and end with the
 * process: after a crash nothing is replayed, and the reply may stay at its
 * last edit.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'
import type { CancellationRegistry } from '../runs/cancel.js'
import { readShellFolder, saveShellFolder, type ShellThread } from './folder-store.js'
import { formatShellReply, SHELL_REPLY_LIMITS } from './format.js'
import { startAskpass } from './askpass.js'
import { runLine } from './run-line.js'
import {
  lineSucceeded,
  SHELL_KILL_GRACE_MS,
  SHELL_LINE_TIMEOUT_MS,
  SHELL_PASSWORD_TIMEOUT_MS,
  type AskpassHandle,
  type LineResult,
  type PasswordAnswerer,
  type RunLineOptions,
  type ShellPasswordPort,
  type ShellReplyPort,
  type ShellReport,
} from './types.js'

/** Where a message's lines start when the thread has no saved folder, or the reason none can be used. */
export type StartFolder = { readonly kind: 'folder'; readonly path: string } | { readonly kind: 'refused'; readonly text: string }

export type ShellJobRequest = {
  readonly thread: ShellThread
  /** The owner who sent the message; only they may answer its password prompts or stop it. */
  readonly principalId: string
  readonly channel: string
  /** The thread the reply goes into. */
  readonly threadTs: string
  readonly commands: readonly string[]
  /** The thread's start folder: its chat folder, else the project or channel folder, else home. Read when the job's turn comes. */
  readonly startFolder: () => Promise<StartFolder>
  /** The thread's Claude or Codex chat folder, shown when the shell is elsewhere. */
  readonly sessionFolder?: string
}

export type ShellJobsDeps = {
  readonly pool: Pool
  readonly log: Logger
  /** Bound once the Slack adapter exists; a job with none refuses to start. */
  readonly replies: () => ShellReplyPort | undefined
  /** The reply's Slack blocks: the Markdown text, plus the password buttons while a request waits. */
  readonly renderBlocks: (text: string, passwordRequestId?: string) => Record<string, unknown>[]
  /** Maps a Slack user to a Relay principal, for the password buttons. */
  readonly principalFor: (platformUserId: string) => Promise<string | null>
  /** Failover's "this laptop answers" check, before every line; absent means always. */
  readonly mayStartWork?: () => Promise<boolean>
  /** Re-read while lines run, so `relay kill` from the CLI stops them. */
  readonly killSwitch?: { readonly refresh?: () => Promise<unknown>; readonly isEngaged: () => boolean; readonly reason: () => string | undefined }
  /** Engaging the kill switch and shutdown cancel every token here. */
  readonly cancellationRegistry?: CancellationRegistry
  readonly shell?: string
  readonly home: string
  readonly host?: string | null
  readonly env?: NodeJS.ProcessEnv
  readonly lineTimeoutMs?: number
  readonly passwordTimeoutMs?: number
  readonly killSwitchPollMs?: number
  readonly graceMs?: number
  /** Test seams. */
  readonly runLine?: (options: RunLineOptions) => Promise<LineResult>
  readonly startAskpass?: (options: { readonly answer: PasswordAnswerer }) => Promise<AskpassHandle>
}

/** Messages waiting behind a running one in the same thread; more are refused so a stuck line cannot pile work up. */
const MAX_WAITING_PER_THREAD = 3
const DEFAULT_KILL_SWITCH_POLL_MS = 3_000

type PendingPassword = {
  readonly principalId: string
  readonly resolve: (password: string | undefined) => void
}

type ThreadState = {
  /** Every job of the thread not finished yet, oldest first. */
  readonly jobs: Array<{ readonly principalId: string; readonly controller: AbortController }>
  tail: Promise<void>
}

export class ShellJobs {
  readonly #deps: ShellJobsDeps
  readonly #threads = new Map<string, ThreadState>()
  readonly #running = new Set<Promise<void>>()
  readonly #passwords = new Map<string, PendingPassword>()
  #closed: string | undefined

  constructor(deps: ShellJobsDeps) {
    this.#deps = deps
  }

  /** The Slack side of password requests (src/chat/slack/shell-password.ts). */
  readonly passwordPort: ShellPasswordPort = {
    canAnswer: async ({ requestId, platformUserId }) => (await this.#allowedPassword(requestId, platformUserId)) === 'ok',
    submit: async ({ requestId, platformUserId, password }) => {
      const check = await this.#allowedPassword(requestId, platformUserId)
      if (check !== 'ok') return check
      const pending = this.#passwords.get(requestId)
      if (pending === undefined) return 'expired'
      this.#passwords.delete(requestId)
      pending.resolve(password)
      return 'accepted'
    },
    cancel: async ({ requestId, platformUserId }) => {
      const check = await this.#allowedPassword(requestId, platformUserId)
      if (check !== 'ok') return check
      const pending = this.#passwords.get(requestId)
      if (pending === undefined) return 'expired'
      this.#passwords.delete(requestId)
      pending.resolve(undefined)
      return 'cancelled'
    },
  }

  /** Whether a job of this thread is running or waiting, so its unmentioned replies reach Relay before its folder row exists. */
  isActive(threadKey: string): boolean {
    return this.#threads.has(threadKey)
  }

  /** Whether any job is running or waiting, for failover's busy check. */
  busy(): boolean {
    return this.#running.size > 0
  }

  /**
   * Starts a message's job and returns at once (the adapter's delivery queue
   * must not wait on shell lines). Returns the refusal text instead when the
   * job cannot be taken.
   */
  start(threadKey: string, request: ShellJobRequest): string | undefined {
    if (this.#closed !== undefined) return 'Relay is stopping, so nothing ran.'
    if (this.#deps.replies() === undefined) return 'Shell from Slack is not available right now, so nothing ran.'
    const state = this.#threads.get(threadKey) ?? { jobs: [], tail: Promise.resolve() }
    if (state.jobs.length > MAX_WAITING_PER_THREAD) return 'Too many `!` messages are waiting in this thread. Wait for them or send `stop`.'
    const controller = new AbortController()
    const entry = { principalId: request.principalId, controller }
    state.jobs.push(entry)
    this.#threads.set(threadKey, state)
    const job = this.#run(request, controller.signal, state.tail).finally(() => {
      const index = state.jobs.indexOf(entry)
      if (index !== -1) state.jobs.splice(index, 1)
      if (state.jobs.length === 0 && this.#threads.get(threadKey) === state) this.#threads.delete(threadKey)
      this.#running.delete(job)
    })
    state.tail = job
    this.#running.add(job)
    return undefined
  }

  /** `stop` from the owner: kills the thread's running line and drops its waiting messages. False when the thread has no job of theirs. */
  stop(threadKey: string, principalId: string, reason = 'stopped from Slack'): boolean {
    const state = this.#threads.get(threadKey)
    const own = state?.jobs.filter((job) => job.principalId === principalId) ?? []
    for (const job of own) job.controller.abort(reason)
    return own.length > 0
  }

  /** Shutdown and handover: refuse new jobs, kill every line, and wait (bounded) for the jobs to post their last edit. */
  async closeAll(reason: string, waitMs = (this.#deps.graceMs ?? SHELL_KILL_GRACE_MS) + 5_000): Promise<void> {
    this.#closed ??= reason
    for (const state of this.#threads.values()) for (const job of state.jobs) job.controller.abort(reason)
    for (const pending of this.#passwords.values()) pending.resolve(undefined)
    this.#passwords.clear()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...this.#running]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
  }

  async #allowedPassword(requestId: string, platformUserId: string): Promise<'ok' | 'refused' | 'expired'> {
    const pending = this.#passwords.get(requestId)
    if (pending === undefined) return 'expired'
    const principalId = await this.#deps.principalFor(platformUserId).catch(() => null)
    return principalId === pending.principalId ? 'ok' : 'refused'
  }

  async #run(request: ShellJobRequest, signal: AbortSignal, before: Promise<void>): Promise<void> {
    const deps = this.#deps
    const replies = deps.replies()
    if (replies === undefined) return
    const commands = request.commands
    let report: ShellReport = { folder: '', results: [], pending: commands, skipped: [], notice: commands.length > 1 ? `Running ${commands.length} commands` : 'Running' }
    let passwordRequestId: string | undefined
    let replyRef: { channel: string; ts: string } | undefined
    const render = (): { text: string; blocks: Record<string, unknown>[] } => {
      const text = formatShellReply(report, { home: deps.home, ...SHELL_REPLY_LIMITS })
      return { text, blocks: deps.renderBlocks(text, passwordRequestId) }
    }
    // Edits are awaited one by one, so they land in the order they were made.
    let edits = Promise.resolve()
    const edit = (): Promise<void> => {
      const { text, blocks } = render()
      edits = edits.then(async () => {
        if (replyRef === undefined) return
        await replies.update({ channel: replyRef.channel, ts: replyRef.ts, text, blocks }).catch((error: unknown) => {
          deps.log.warn({ err: error, channel: replyRef?.channel }, 'shell: could not edit the reply')
        })
      })
      return edits
    }

    try {
      const { text, blocks } = render()
      replyRef = await replies.post({ channel: request.channel, thread: request.threadTs, text, blocks })
    } catch (error) {
      deps.log.error({ err: error, channel: request.channel }, 'shell: could not post the reply; nothing ran')
      await before.catch(() => undefined)
      return
    }

    await before.catch(() => undefined)
    const token = deps.cancellationRegistry?.register(`shell:${randomUUID()}`)
    const lineAbort = new AbortController()
    const abortLine = (reason: string): void => {
      if (!lineAbort.signal.aborted) lineAbort.abort(reason)
    }
    const onJobAbort = (): void => abortLine(String(signal.reason))
    const onToken = (): void => abortLine(token?.cancellationReason ?? 'stopped')
    signal.addEventListener('abort', onJobAbort)
    token?.signal.addEventListener('abort', onToken)
    if (signal.aborted) onJobAbort()
    let askpass: AskpassHandle | undefined

    try {
      const start = await this.#startFolder(request)
      if (start.kind === 'refused') {
        report = { ...report, pending: [], notice: start.text }
        return
      }
      let folder = start.folder
      report = { ...report, folder, ...(request.sessionFolder !== undefined && request.sessionFolder !== folder ? { sessionFolder: request.sessionFolder } : {}), ...(deps.host ? { host: deps.host } : {}) }
      // Written before the first line, so the thread takes its next message and its `stop` while this one runs.
      await saveShellFolder(deps.pool, request.thread, folder)

      askpass = await (deps.startAskpass ?? startAskpass)({ answer: (prompt, answerSignal) => this.#askPassword(request, prompt.prompt, answerSignal, lineAbort.signal, (id) => {
        passwordRequestId = id
        report = { ...report, notice: id === undefined ? undefined : '🔒 sudo is asking for your password. Use the button below.' }
        void edit()
      }) })

      for (const [index, command] of commands.entries()) {
        const refusal = await this.#mayRunLine(lineAbort.signal)
        if (refusal !== undefined) {
          report = { ...report, running: undefined, pending: [], skipped: commands.slice(index), notice: refusal }
          return
        }
        report = { ...report, running: command, pending: commands.slice(index + 1), notice: undefined }
        void edit()
        const result = await this.#runWatched(
          {
            command: command === 'cd' ? `cd -- ${shellQuote(await this.#resetFolder(request, folder))}` : command,
            cwd: folder,
            shell: deps.shell ?? process.env.SHELL ?? '/bin/zsh',
            env: deps.env ?? process.env,
            timeoutMs: deps.lineTimeoutMs ?? SHELL_LINE_TIMEOUT_MS,
            signal: lineAbort.signal,
            sudo: askpass.sudo,
            ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
          },
          abortLine,
        )
        const shown: LineResult = { ...result, command }
        report = { ...report, running: undefined, results: [...report.results, shown] }
        if (!lineSucceeded(shown)) {
          report = { ...report, pending: [], skipped: commands.slice(index + 1) }
          return
        }
        if (shown.folderAfter !== folder) {
          folder = shown.folderAfter
          await saveShellFolder(deps.pool, request.thread, folder)
        }
      }
      report = { ...report, pending: [] }
    } catch (error) {
      deps.log.error({ err: error, channel: request.channel }, 'shell: the job failed')
      report = { ...report, running: undefined, pending: [], notice: 'Something went wrong in Relay; the remaining lines did not run.' }
    } finally {
      signal.removeEventListener('abort', onJobAbort)
      token?.signal.removeEventListener('abort', onToken)
      if (token !== undefined) deps.cancellationRegistry?.release(token.runId)
      passwordRequestId = undefined
      await askpass?.close().catch((error: unknown) => deps.log.warn({ err: error }, 'shell: could not close the password helper'))
      await edit()
    }
  }

  /** The saved folder when it still exists; the start folder for a new thread; a refusal for a saved folder that is gone, unless the message starts with `! cd`. */
  async #startFolder(request: ShellJobRequest): Promise<{ kind: 'folder'; folder: string } | { kind: 'refused'; text: string }> {
    const saved = await readShellFolder(this.#deps.pool, request.thread, this.#deps.home)
    if (saved !== undefined && isFolder(saved)) return { kind: 'folder', folder: saved }
    if (saved !== undefined && request.commands[0] !== 'cd') {
      return { kind: 'refused', text: `This thread's folder \`${saved}\` no longer exists, so nothing ran. Send \`! cd\` to go back to the start folder.` }
    }
    const start = await request.startFolder()
    if (start.kind === 'refused') return start
    if (!isFolder(start.path)) return { kind: 'refused', text: `The start folder \`${start.path}\` does not exist on this laptop, so nothing ran.` }
    return { kind: 'folder', folder: start.path }
  }

  /** Where `! cd` alone goes: the thread's start folder, or the current folder when that cannot be read. */
  async #resetFolder(request: ShellJobRequest, current: string): Promise<string> {
    const start = await request.startFolder()
    return start.kind === 'folder' && isFolder(start.path) ? start.path : current
  }

  /** Failover and the kill switch, checked before each line. */
  async #mayRunLine(signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return `Stopped: ${String(signal.reason)}.`
    if (this.#deps.mayStartWork && !(await this.#deps.mayStartWork())) return 'This laptop is no longer the one answering, so the remaining lines did not run.'
    const engaged = await this.#killSwitchEngaged()
    if (engaged !== undefined) return `Relay is paused: ${engaged}. The remaining lines did not run.`
    return undefined
  }

  async #killSwitchEngaged(): Promise<string | undefined> {
    const killSwitch = this.#deps.killSwitch
    if (killSwitch === undefined) return undefined
    try {
      await killSwitch.refresh?.()
    } catch {
      return 'the kill switch could not be read'
    }
    return killSwitch.isEngaged() ? (killSwitch.reason() ?? 'kill switch engaged') : undefined
  }

  /** Runs one line while re-reading the kill switch, so `relay kill` from the CLI stops it without a new Slack message. */
  async #runWatched(options: RunLineOptions, abortLine: (reason: string) => void): Promise<LineResult> {
    const poll = setInterval(() => {
      void this.#killSwitchEngaged().then((engaged) => {
        if (engaged !== undefined) abortLine(`Relay is paused: ${engaged}`)
      })
    }, this.#deps.killSwitchPollMs ?? DEFAULT_KILL_SWITCH_POLL_MS)
    try {
      return await (this.#deps.runLine ?? runLine)(options)
    } finally {
      clearInterval(poll)
    }
  }

  /** One sudo prompt: shows the buttons, waits up to the password limit, then hides them again. The password only passes through. */
  async #askPassword(
    request: ShellJobRequest,
    _prompt: string,
    helperGone: AbortSignal,
    lineStopped: AbortSignal,
    show: (requestId: string | undefined) => void,
  ): Promise<string | undefined> {
    const requestId = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      return await new Promise<string | undefined>((resolve) => {
        this.#passwords.set(requestId, { principalId: request.principalId, resolve })
        onAbort = () => resolve(undefined)
        helperGone.addEventListener('abort', onAbort)
        lineStopped.addEventListener('abort', onAbort)
        if (helperGone.aborted || lineStopped.aborted) resolve(undefined)
        timer = setTimeout(() => resolve(undefined), this.#deps.passwordTimeoutMs ?? SHELL_PASSWORD_TIMEOUT_MS)
        show(requestId)
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) {
        helperGone.removeEventListener('abort', onAbort)
        lineStopped.removeEventListener('abort', onAbort)
      }
      this.#passwords.delete(requestId)
      show(undefined)
    }
  }
}

function isFolder(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Single quotes for a POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
