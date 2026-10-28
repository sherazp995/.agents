/**
 * Slack as a front end for a REAL Claude Code session.
 *
 * This is a different thing from the governed agent loop in
 * `src/agent/loop.ts`, and the difference is the whole point. That loop asks
 * the model to choose a capability, executes the capability itself under
 * policy, and keeps the conversation in Relay's own database. This starts an
 * ordinary `claude` session in a directory and relays messages to it.
 *
 * WHAT THAT BUYS, which is what the operator asked for:
 *
 *   - The conversation lives in Claude Code's own transcript, under
 *     `~/.claude/projects/<encoded-cwd>/`. Relay is not the system of record
 *     and cannot lose it. The operator can `cd` to the directory and run
 *     `claude --resume <id>` to pick up the same chat at a keyboard.
 *   - The full local configuration stack applies unchanged, per FR-CFG-2 and
 *     FR-CODE-21: the directory's `CLAUDE.md`, the user's global rules,
 *     skills, agents, commands, hooks, MCP servers, settings. That is why
 *     there is NO system prompt and NO `--json-schema` here. Adding either
 *     would make it Relay's conversation wearing a session's clothes.
 *
 * WHAT IT GIVES UP, stated here because it is not visible from Slack and the
 * spec is explicit about it (FR-ATT-30). A session started this way runs
 * with the operator's own permissions in their own directory. It is OUTSIDE
 * the FR-SH-6 sandbox, outside the policy engine, outside approvals, outside
 * budget metering, and outside worktree isolation. Everything Relay enforces
 * elsewhere governs the other path. A thread driving one of these is
 * unmediated, and Relay says so where the operator can see it rather than
 * leaving a governed thread and an unmediated one looking identical.
 */

import { spawnGated } from '../process/gated-spawn.js'

/**
 * The child's environment: everything the operator has, minus Relay's own
 * brokered secrets.
 *
 * Exported so the exclusion is testable rather than asserted in a comment.
 */
export function engineChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('RELAY_SECRET_')) continue
    if (value !== undefined) env[key] = value
  }
  return env
}

/** The same binary the governed loop uses. Named here rather than inline so the egress inventory's scan resolves it. */
export const CLAUDE_BINARY = 'claude'

/** How long a single turn may take before it is abandoned. Generous: a real task in a real session is not quick. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000

export type DirectTurn =
  | {
      readonly outcome: 'replied'
      /** Claude Code's own session id. Posted into Slack so the operator can resume the same chat at a keyboard. */
      readonly sessionId: string
      readonly text: string
      readonly costUsd: number
    }
  /** The session id was not accepted. Distinct from a crash: the usual cause is resuming in the wrong directory. */
  | { readonly outcome: 'resume_rejected'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly reason: string }

export type DirectSessionRequest = {
  /** Where the session runs. Decides which CLAUDE.md, skills and settings apply, and where the transcript is written. */
  readonly cwd: string
  readonly message: string
  /** Absent starts a new session; present resumes that one. */
  readonly resume?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type DirectSessionDependencies = {
  readonly runClaude?: (args: readonly string[], request: DirectSessionRequest) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>
}

/**
 * The final `result` event stream-json emits.
 *
 * Parsed from the LAST parseable line rather than the first, because the
 * stream carries assistant and tool events before it, and a caller that took
 * the first would get an init event with no result text in it.
 */
export function parseFinalResult(stdout: string): { sessionId?: string; text?: string; costUsd?: number; isError?: boolean; errors?: string[] } | undefined {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] as string) as Record<string, unknown>
      if (parsed.type !== 'result') continue
      return {
        ...(typeof parsed.session_id === 'string' ? { sessionId: parsed.session_id } : {}),
        ...(typeof parsed.result === 'string' ? { text: parsed.result } : {}),
        ...(typeof parsed.total_cost_usd === 'number' ? { costUsd: parsed.total_cost_usd } : {}),
        ...(typeof parsed.is_error === 'boolean' ? { isError: parsed.is_error } : {}),
        ...(Array.isArray(parsed.errors) ? { errors: parsed.errors.map(String) } : {}),
      }
    } catch {
      // Not JSON. The CLI prints ordinary diagnostics too.
    }
  }
  return undefined
}

/**
 * Whether the CLI refused the session id.
 *
 * Told apart from a crash because the fix is completely different: a
 * rejected resume almost always means the wrong directory, since a session
 * id is only meaningful alongside the working directory whose transcript
 * holds it.
 */
export function readsAsResumeRejection(stdout: string, stderr: string): boolean {
  return /No conversation found with session ID/i.test(`${stdout}\n${stderr}`)
}

async function defaultRunClaude(
  args: readonly string[],
  request: DirectSessionRequest,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  // The shared gated spawn (src/process/gated-spawn.ts) with no gate to
  // hold: a direct turn has no task row to record first. It runs the CLI in
  // its own process group, so Stop and the time limit kill everything the
  // session started, not only the claude process itself.
  const child = spawnGated({
    bin: CLAUDE_BINARY,
    args,
    cwd: request.cwd,
    env: engineChildEnv(),
    timeoutMs: request.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {}),
  })
  const result = await child.done
  if (result.spawnErrorCode === 'ENOENT') {
    throw Object.assign(new Error(`spawn ${CLAUDE_BINARY} ENOENT`), { code: 'ENOENT' })
  }
  return { stdout: result.stdout, stderr: result.stderr, code: result.code, timedOut: result.timedOut }
}

/**
 * Builds the argument list.
 *
 * Note what is NOT here: no `--system-prompt`, no `--json-schema`, no
 * `--allowedTools`. The session is meant to be indistinguishable from one
 * the operator started themselves, and every one of those flags would make
 * it something else. `--verbose` is required alongside `stream-json`; the
 * CLI fails fast without it.
 */
export function buildDirectArgs(request: DirectSessionRequest): readonly string[] {
  return [
    '-p',
    request.message,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(request.resume === undefined ? [] : ['--resume', request.resume]),
  ]
}

/** Runs one turn: starts a session when `resume` is absent, continues it when present. */
export async function runDirectTurn(request: DirectSessionRequest, deps: DirectSessionDependencies = {}): Promise<DirectTurn> {
  const run = deps.runClaude ?? defaultRunClaude

  let result: { stdout: string; stderr: string; code: number | null; timedOut: boolean }
  try {
    result = await run(buildDirectArgs(request), request)
  } catch (error) {
    return { outcome: 'failed', reason: `the claude CLI could not be started: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (result.timedOut) {
    return {
      outcome: 'failed',
      reason: `this turn ran past its time limit and was stopped. The session still exists; send another message to carry on.`,
    }
  }

  if (request.resume !== undefined && readsAsResumeRejection(result.stdout, result.stderr)) {
    return {
      outcome: 'resume_rejected',
      reason:
        `Claude Code does not recognise session ${request.resume} in ${request.cwd}. A session id only means anything ` +
        'alongside the directory whose transcript holds it, so the usual cause is the wrong directory rather than a ' +
        'lost session.',
    }
  }

  const parsed = parseFinalResult(result.stdout)
  if (parsed?.sessionId === undefined) {
    return {
      outcome: 'failed',
      reason:
        `the session produced no result. claude exited ${result.code ?? 'abnormally'}` +
        `${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim().slice(0, 500)}`}`,
    }
  }

  return {
    outcome: 'replied',
    sessionId: parsed.sessionId,
    text: parsed.text ?? '',
    costUsd: parsed.costUsd ?? 0,
  }
}

/**
 * What Slack is told when a session is created.
 *
 * The id and the directory are both here on purpose: either alone is
 * useless. The resume command is spelled out so the operator can take the
 * conversation to a keyboard without looking anything up, which is the
 * property that makes Claude Code rather than Relay the system of record.
 *
 * The unmediated warning is on the CREATION message rather than in
 * documentation, because that is the one moment the operator is certain to
 * read, and FR-ATT-30 requires a governed thread and an unmediated one not
 * to look identical.
 */
export function renderSessionStarted(sessionId: string, cwd: string): string {
  return [
    `Started a Claude Code session in \`${cwd}\`.`,
    `Session: \`${sessionId}\``,
    '',
    'Every message in this thread goes to that session, so it keeps its context.',
    'To carry on at a keyboard instead:',
    `  cd ${cwd} && claude --resume ${sessionId}`,
    '',
    'Note: this session runs with your own permissions in that directory. It is outside Relay\'s sandbox, policy ' +
      'engine, approvals and budget caps, which govern Relay\'s own runs rather than this one.',
  ].join('\n')
}
