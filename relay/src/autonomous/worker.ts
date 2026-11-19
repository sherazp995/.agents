/**
 * Runs one worker turn: the operator's signed-in `claude` or `codex` CLI as a
 * regular chat, headless, behind the start gate (src/process/gated-spawn.ts),
 * in bypass mode with relay's guard hook. The reply is every text the chat wrote this turn.
 *
 * Claude reads its input as stream-json on an open stdin, so messages the
 * thread gets while the turn runs reach it at its next tool call, as they do
 * in the terminal; stdin closes at the first result with no background task
 * still running (a task's notification starts another result). Codex has no input
 * while a turn runs, so its messages wait for the next turn.
 *
 * With `onReply`, a Claude turn hands each result's text out as soon as it
 * arrives, so a chat that leaves background work running (a subagent, a
 * long command) is heard at once instead of when the process exits. The time
 * limit then counts from the last result, and once anything was handed out
 * the turn always ends as a reply: what is left to post, plus a short note
 * when it ended by the limit or an error.
 */

import { engineChildEnv, parseFinalResult, readsAsResumeRejection } from '../live/direct-session.js'
import { spawnGated, type GatedSpawnResult } from '../process/gated-spawn.js'
import { classifyBlocked, type Account, type BlockedReason } from './accounts.js'

/**
 * The operator's own environment, then the session's resolved envs (`env`:
 * stored envs over the channel description's, src/worker-env/resolve.ts),
 * then the chosen account's env and the guard hook's address, which nothing
 * stored can override.
 */
export function buildWorkerEnv(params: { account: Account; hookUrl: string; hookToken: string; env?: Readonly<Record<string, string>>; base?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const env = engineChildEnv(params.base ?? process.env)
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME
  return { ...env, ...params.env, ...params.account.env, RELAY_HOOK_URL: params.hookUrl, RELAY_HOOK_TOKEN: params.hookToken }
}

/** One user message on claude's stream-json stdin. */
export function claudeUserLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
}

/** The prompt goes on stdin (`claudeUserLine`), not in the arguments. */
/** `model` picks the model; `noMcp` starts with no MCP servers (none configured, and the user's ignored). */
export function buildClaudeArgs(params: { brief: string; settingsJson: string; resume?: string; model?: string; noMcp?: boolean }): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    params.brief,
    '--permission-mode',
    'bypassPermissions',
    '--settings',
    params.settingsJson,
    ...(params.model !== undefined ? ['--model', params.model] : []),
    ...(params.noMcp === true ? ['--strict-mcp-config'] : []),
    ...(params.resume !== undefined ? ['--resume', params.resume] : []),
  ]
}

/** Global options go before `resume`: codex-cli 0.164.0 rejects them after it. `overrides` carry the hook. */
export function buildCodexArgs(params: { prompt: string; overrides: readonly string[]; resume?: string; model?: string; noMcp?: boolean }): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    ...params.overrides.flatMap((override) => ['-c', override]),
    ...(params.noMcp === true ? ['-c', 'mcp_servers={}'] : []),
    ...(params.model !== undefined ? ['-m', params.model] : []),
    ...(params.resume !== undefined ? ['resume', params.resume] : []),
    params.prompt,
  ]
}

export type TurnOutcome =
  | { kind: 'reply'; text: string; sessionId: string }
  | { kind: 'account_blocked'; reason: BlockedReason; stderrTail: string }
  | { kind: 'resume_rejected' }
  /** `envUnreadable`: the session did not start because a stored env it needs cannot be read here; it names the scope, never a value. */
  | { kind: 'not_started'; envUnreadable?: string }
  /** Killed after the gate opened (Stop, kill switch): the CLI may have changed files. */
  | { kind: 'stopped' }
  | { kind: 'failed'; reason: string; stderrTail: string }

/** One finished reply, handed out while the turn's process may still run. */
export type HandedReply = { text: string; sessionId: string }

/** How the scheduler reaches a running turn: `send` is set while the turn takes input, and null otherwise. */
export type TurnInbox = { send: ((text: string) => boolean) | null }

export type TurnRequest = {
  account: Account
  bin: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** The CLI's first stdin text; stdin then stays open for `inbox` until a result with no background task running. */
  input?: string
  inbox?: TurnInbox
  /** Claude only: each result's text as it arrives; the limit then counts from the last result. Never throws into the worker. */
  onReply?: (reply: HandedReply) => void
  timeoutMs: number
  signal?: AbortSignal
  /** Fenced write of the pid before the gate opens; false refuses the start. */
  recordWorker: (pid: number, pgid: number) => Promise<boolean>
}

const STDERR_TAIL = 800

/** Spawns one turn and reads its outcome. Never throws for an ordinary CLI failure. */
export async function runWorkerTurn(request: TurnRequest): Promise<TurnOutcome> {
  let closeInput = (): void => undefined
  let restartTimer = (): void => undefined
  const onReply = request.onReply
  const handOut = onReply
    ? (reply: HandedReply): void => {
        restartTimer()
        if (reply.text.trim() === '') return
        try {
          onReply(reply)
        } catch {
          // The caller logs its own failures; a throw must not end the turn.
        }
      }
    : undefined
  const watch = request.account.client === 'claude' ? claudeWatcher(() => closeInput(), handOut) : codexWatcher()
  let result: GatedSpawnResult
  try {
    const child = spawnGated({
      bin: request.bin,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.input !== undefined ? { input: request.input } : {}),
      beforeStart: request.recordWorker,
      onStdoutLine: (line) => watch.onLine(line),
    })
    restartTimer = () => child.restartTimer()
    const inbox = request.inbox
    if (request.input !== undefined) {
      closeInput = () => {
        if (inbox) inbox.send = null
        child.endInput()
      }
      if (inbox) inbox.send = (text) => child.write(claudeUserLine(text))
    }
    try {
      result = await child.done
    } finally {
      if (inbox) inbox.send = null
    }
  } catch (error) {
    return { kind: 'failed', reason: `could not start ${request.bin}: ${String(error)}`, stderrTail: '' }
  }

  const stderrTail = result.stderr.trim().slice(-STDERR_TAIL)
  if (!result.started) return { kind: 'not_started' }
  // Replies are already in the thread: the turn ends as a reply whatever followed, never as a blocked account or a rejected resume.
  if (watch.handedOut()) {
    if (result.killed && !result.timedOut) return { kind: 'stopped' }
    const finished = watch.finish(result, stderrTail)
    if (!result.timedOut || finished.kind !== 'reply') return finished
    const note = `Stopped this chat's leftover background tasks after ${describeLimit(request.timeoutMs)} with no reply.`
    return { ...finished, text: finished.text === '' ? note : `${finished.text}\n\n${note}` }
  }
  if (result.timedOut) return { kind: 'failed', reason: 'the turn ran past its time limit and was stopped', stderrTail }
  if (result.killed) return { kind: 'stopped' }
  const finished = watch.finish(result, stderrTail)
  // A turn that produced its answer is never read as a blocked account, whatever its stderr mentions.
  if (finished.kind === 'reply') return finished
  // An error result can carry the limit message on stdout, so the failure reason is read too.
  const reason = finished.kind === 'failed' ? `\n${finished.reason}` : ''
  const blocked = classifyBlocked({ exitCode: result.code, stderr: `${result.stderr}${reason}`, ...(result.spawnErrorCode ? { spawnErrorCode: result.spawnErrorCode } : {}) })
  if (blocked !== null) return { kind: 'account_blocked', reason: blocked, stderrTail }
  if (readsAsResumeRejection(result.stdout, result.stderr)) return { kind: 'resume_rejected' }
  return finished
}

/** "3 hours", "30 minutes": the time limit in words. */
function describeLimit(ms: number): string {
  if (ms < 60_000) return Math.round(ms / 1000) === 1 ? '1 second' : `${Math.round(ms / 1000)} seconds`
  const hours = ms / 3_600_000
  if (Number.isInteger(hours)) return hours === 1 ? '1 hour' : `${hours} hours`
  const minutes = Math.round(ms / 60_000)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

type Watcher = {
  onLine(line: string): void
  /** True once any reply was handed out mid-turn. */
  handedOut(): boolean
  finish(result: GatedSpawnResult, stderrTail: string): TurnOutcome
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Claude: the reply is every text block the chat itself wrote this turn, in
 * order, so an answer written before a tool call is not lost behind a later
 * short message. Assistant events with a parent_tool_use_id belong to a
 * subagent and are left out. The result event carries the session id; the
 * first result with no background task still running closes stdin (until
 * then the chat keeps working on each task's notification, and messages
 * still reach it), and a message already in the pipe can start one more
 * result, whose text is collected the same way. A turn with no assistant
 * text falls back to joining the results' text.
 *
 * With `onReply`, each successful result hands out the texts written since
 * the last one (or that result's own text when there were none), and
 * `finish` returns only what was not handed out yet.
 */
function claudeWatcher(onResult: () => void, onReply?: (reply: HandedReply) => void): Watcher {
  const texts: string[] = []
  const resultTexts: string[] = []
  // Background tasks the chat still runs, from the CLI's latest `background_tasks_changed` event.
  // A result while any run is not the end: each one that finishes starts another result.
  let backgroundTasks = 0
  // texts[0..handed) are already out; the session of the last result handed out.
  let handed = 0
  let handedSession: string | undefined
  return {
    handedOut: () => handedSession !== undefined,
    onLine(line) {
      const event = parseLine(line)
      if (event?.type === 'assistant' && (event.parent_tool_use_id === null || event.parent_tool_use_id === undefined)) {
        texts.push(...assistantTexts(event.message))
        return
      }
      if (event?.type === 'system' && event.subtype === 'background_tasks_changed') {
        backgroundTasks = Array.isArray(event.tasks) ? event.tasks.length : 0
        return
      }
      if (event?.type !== 'result') return
      if (typeof event.result === 'string' && event.is_error !== true && event.result.trim() !== '') resultTexts.push(event.result)
      if (onReply && event.is_error !== true && typeof event.session_id === 'string') {
        const fresh = texts.slice(handed)
        handed = texts.length
        const text = fresh.length > 0 ? fresh.join('\n\n') : typeof event.result === 'string' ? event.result.trim() : ''
        // Only a result with text counts as handed out; an empty one only restarts the time limit.
        if (text !== '') handedSession = event.session_id
        onReply({ text, sessionId: event.session_id })
      }
      if (backgroundTasks === 0) onResult()
    },
    finish(result, stderrTail) {
      const final = parseFinalResult(result.stdout)
      if (handedSession !== undefined) {
        const rest = texts.slice(handed).join('\n\n')
        const error =
          final?.isError === true
            ? `The chat then stopped with an error: ${final.text || (final.errors ?? []).join('; ') || 'claude reported an error'}`
            : final?.sessionId === undefined || (result.code !== 0 && !result.timedOut)
              ? `The chat's process then ended unexpectedly (exit ${result.code ?? 'by signal'}); any background work it ran is gone.`
              : ''
        return { kind: 'reply', text: [rest, error].filter((part) => part !== '').join('\n\n'), sessionId: final?.sessionId ?? handedSession }
      }
      if (final?.sessionId === undefined || final.text === undefined) {
        return { kind: 'failed', reason: `claude exited ${result.code ?? 'abnormally'} with no result`, stderrTail }
      }
      if (final.isError === true) return { kind: 'failed', reason: final.text || (final.errors ?? []).join('; ') || 'claude reported an error', stderrTail }
      const reply = texts.length > 0 ? texts : resultTexts.length > 1 ? resultTexts : [final.text]
      return { kind: 'reply', text: reply.join('\n\n'), sessionId: final.sessionId }
    },
  }
}

/** The non-empty text blocks of one assistant event's message, skipping tool calls and thinking. */
function assistantTexts(message: unknown): string[] {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null) return []
    const { type, text } = block as { type?: unknown; text?: unknown }
    return type === 'text' && typeof text === 'string' && text.trim() !== '' ? [text] : []
  })
}

/** Codex: the thread id and every agent message, in order, of a turn that completed. */
function codexWatcher(): Watcher {
  let sessionId: string | null = null
  const messages: string[] = []
  let completed = false
  let error: string | undefined
  return {
    handedOut: () => false,
    onLine(line) {
      const event = parseLine(line)
      if (!event) return
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id
      if (event.type === 'turn.completed') completed = true
      if (event.type === 'turn.failed' || event.type === 'error') {
        const detail = (event.error as { message?: unknown } | undefined)?.message ?? event.message
        error = typeof detail === 'string' ? detail : 'codex reported an error'
      }
      const item = event.item as { type?: unknown; text?: unknown } | undefined
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim() !== '') messages.push(item.text)
    },
    finish(result, stderrTail) {
      if (error !== undefined || !completed || result.code !== 0) {
        return { kind: 'failed', reason: error ?? `codex exited ${result.code ?? 'abnormally'} before finishing its turn`, stderrTail }
      }
      if (sessionId === null || messages.length === 0) return { kind: 'failed', reason: 'codex finished with no answer', stderrTail }
      return { kind: 'reply', text: messages.join('\n\n'), sessionId }
    },
  }
}
