/**
 * Runs one worker turn: the operator's signed-in `claude` or `codex` CLI as a
 * regular chat, headless, behind the start gate (src/process/gated-spawn.ts),
 * in bypass mode with relay's guard hook. The reply is every text the chat wrote this turn.
 *
 * Claude reads its input as stream-json on an open stdin, so messages the
 * thread gets while the turn runs reach it at its next tool call, as they do
 * in the terminal; stdin closes when the result arrives. Codex has no input
 * while a turn runs, so its messages wait for the next turn.
 */

import { engineChildEnv, parseFinalResult, readsAsResumeRejection } from '../live/direct-session.js'
import { spawnGated, type GatedSpawnResult } from '../process/gated-spawn.js'
import { classifyBlocked, type Account, type BlockedReason } from './accounts.js'

/** The operator's own environment, on the chosen account, plus the guard hook's address. */
export function buildWorkerEnv(params: { account: Account; hookUrl: string; hookToken: string; base?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const env = engineChildEnv(params.base ?? process.env)
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME
  return { ...env, ...params.account.env, RELAY_HOOK_URL: params.hookUrl, RELAY_HOOK_TOKEN: params.hookToken }
}

/** One user message on claude's stream-json stdin. */
export function claudeUserLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
}

/** The prompt goes on stdin (`claudeUserLine`), not in the arguments. */
export function buildClaudeArgs(params: { brief: string; settingsJson: string; resume?: string }): string[] {
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
    ...(params.resume !== undefined ? ['--resume', params.resume] : []),
  ]
}

/** Global options go before `resume`: codex-cli 0.164.0 rejects them after it. `overrides` carry the hook. */
export function buildCodexArgs(params: { prompt: string; overrides: readonly string[]; resume?: string }): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    ...params.overrides.flatMap((override) => ['-c', override]),
    ...(params.resume !== undefined ? ['resume', params.resume] : []),
    params.prompt,
  ]
}

export type TurnOutcome =
  | { kind: 'reply'; text: string; sessionId: string }
  | { kind: 'account_blocked'; reason: BlockedReason; stderrTail: string }
  | { kind: 'resume_rejected' }
  | { kind: 'not_started' }
  /** Killed after the gate opened (Stop, kill switch): the CLI may have changed files. */
  | { kind: 'stopped' }
  | { kind: 'failed'; reason: string; stderrTail: string }

/** How the scheduler reaches a running turn: `send` is set while the turn takes input, and null otherwise. */
export type TurnInbox = { send: ((text: string) => boolean) | null }

export type TurnRequest = {
  account: Account
  bin: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** The CLI's first stdin text; stdin then stays open for `inbox` until the result. */
  input?: string
  inbox?: TurnInbox
  timeoutMs: number
  signal?: AbortSignal
  /** Fenced write of the pid before the gate opens; false refuses the start. */
  recordWorker: (pid: number, pgid: number) => Promise<boolean>
}

const STDERR_TAIL = 800

/** Spawns one turn and reads its outcome. Never throws for an ordinary CLI failure. */
export async function runWorkerTurn(request: TurnRequest): Promise<TurnOutcome> {
  let closeInput = (): void => undefined
  const watch = request.account.client === 'claude' ? claudeWatcher(() => closeInput()) : codexWatcher()
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

type Watcher = {
  onLine(line: string): void
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
 * first result closes stdin, and a message already in the pipe can start one
 * more result, whose text is collected the same way. A turn with no assistant
 * text falls back to joining the results' text.
 */
function claudeWatcher(onResult: () => void): Watcher {
  const texts: string[] = []
  const resultTexts: string[] = []
  return {
    onLine(line) {
      const event = parseLine(line)
      if (event?.type === 'assistant' && (event.parent_tool_use_id === null || event.parent_tool_use_id === undefined)) {
        texts.push(...assistantTexts(event.message))
        return
      }
      if (event?.type !== 'result') return
      if (typeof event.result === 'string' && event.is_error !== true && event.result.trim() !== '') resultTexts.push(event.result)
      onResult()
    },
    finish(result, stderrTail) {
      const final = parseFinalResult(result.stdout)
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
