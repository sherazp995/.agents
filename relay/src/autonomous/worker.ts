/**
 * Runs one worker turn: the operator's signed-in `claude` or `codex` CLI,
 * headless, behind the start gate (src/process/gated-spawn.ts), with the
 * worker environment that carries no remote-write credentials.
 *
 * Before plan approval the turn is read only (claude `--permission-mode
 * plan`, codex `--sandbox read-only`); after it, bypass mode outside relay's
 * sandbox (user decision 1), guarded by relay's hook and MCP gateway.
 */

import { engineChildEnv, parseFinalResult, readsAsResumeRejection } from '../live/direct-session.js'
import { spawnGated, type GatedSpawnResult } from '../process/gated-spawn.js'
import { classifyBlocked, type Account, type BlockedReason } from './accounts.js'
import { normalizeCliReply, parseWorkerReply, type ParsedReply, type WorkerReply } from './reply.js'

export type WorkerMode = 'read_only' | 'bypass'

/** Disables credential helpers, SSH agents and keys, so an ordinary `git push` from the worker fails without prompting. */
export const WORKER_GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes'

export type WorkerEnvParams = {
  account: Account
  /** Relay-written: empty credential.helper, the operator's name and email only. */
  gitConfigPath: string
  /** Read-only GitHub token from relay's keystore, or undefined when none is configured. */
  readOnlyGithubToken?: string
  hookUrl: string
  hookToken: string
  /** Values for MCP servers' env, resolved from the keystore at spawn. */
  extraEnv?: Record<string, string>
  base?: NodeJS.ProcessEnv
}

export function buildWorkerEnv(params: WorkerEnvParams): NodeJS.ProcessEnv {
  const env = engineChildEnv(params.base ?? process.env)
  for (const key of ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    delete env[key]
  }
  // extraEnv comes first so an MCP server's keystore value can never replace a safety variable.
  return {
    ...env,
    ...params.extraEnv,
    ...params.account.env,
    ...(params.readOnlyGithubToken !== undefined ? { GH_TOKEN: params.readOnlyGithubToken } : {}),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: params.gitConfigPath,
    GIT_SSH_COMMAND: WORKER_GIT_SSH_COMMAND,
    RELAY_HOOK_URL: params.hookUrl,
    RELAY_HOOK_TOKEN: params.hookToken,
  }
}

/** The file relay writes for GIT_CONFIG_GLOBAL. */
export function renderWorkerGitConfig(identity: { name: string; email: string }): string {
  return `[user]\n\tname = ${gitConfigValue(identity.name)}\n\temail = ${gitConfigValue(identity.email)}\n[credential]\n\thelper =\n`
}

/** A quoted git config value; a newline is refused so a value cannot start a new section. */
function gitConfigValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('git identity holds a line break')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export type ClaudeArgsParams = {
  prompt: string
  brief: string
  schemaJson: string
  mode: WorkerMode
  maxBudgetUsd: number
  settingsJson: string
  mcpConfigPath: string
  resume?: string
}

export function buildClaudeArgs(params: ClaudeArgsParams): string[] {
  return [
    '-p',
    params.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    params.schemaJson,
    '--append-system-prompt',
    params.brief,
    '--permission-mode',
    params.mode === 'bypass' ? 'bypassPermissions' : 'plan',
    '--max-budget-usd',
    params.maxBudgetUsd.toFixed(2),
    '--settings',
    params.settingsJson,
    '--mcp-config',
    params.mcpConfigPath,
    '--strict-mcp-config',
    ...(params.resume !== undefined ? ['--resume', params.resume] : []),
  ]
}

export type CodexArgsParams = {
  prompt: string
  schemaPath: string
  mode: WorkerMode
  /** `-c key=value` overrides: the hook and the gateway-wrapped mcp_servers. */
  overrides: readonly string[]
  resume?: string
}

/** Global options go before `resume`: codex-cli 0.164.0 rejects them after it. */
export function buildCodexArgs(params: CodexArgsParams): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--output-schema',
    params.schemaPath,
    ...(params.mode === 'bypass' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'read-only']),
    ...params.overrides.flatMap((override) => ['-c', override]),
    ...(params.resume !== undefined ? ['resume', params.resume] : []),
    params.prompt,
  ]
}

export type TurnOutcome =
  | { kind: 'reply'; reply: WorkerReply; sessionId: string; costUsd: number | null }
  | { kind: 'schema_invalid'; sessionId: string | null; error: string; costUsd: number | null }
  | { kind: 'account_blocked'; reason: BlockedReason; stderrTail: string }
  | { kind: 'resume_rejected' }
  | { kind: 'mcp_violation'; servers: string[] }
  | { kind: 'over_budget'; costUsd: number }
  | { kind: 'not_started' }
  /** Killed after the gate opened (Stop, kill switch): the CLI may have changed files. */
  | { kind: 'stopped' }
  | { kind: 'failed'; reason: string; stderrTail: string; costUsd: number | null }

export type TurnRequest = {
  account: Account
  bin: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  /** Fenced write of the pid before the gate opens; false refuses the start. */
  recordWorker: (pid: number, pgid: number) => Promise<boolean>
  /** Claude: the only MCP server names the init event may list. */
  allowedMcpServers: readonly string[]
  /** Codex: kill the tree once estimated cost reaches this. */
  reservedUsd: number
  codexUsdPerMtok: number
  /** Reads the CLI's structured output. Defaults to the worker reply; QA invocations pass their own report reader. */
  parseReply?: (value: unknown) => ParsedReply
}

const defaultParse = (value: unknown): ParsedReply => parseWorkerReply(normalizeCliReply(value))

const STDERR_TAIL = 800

/** Spawns one turn and reads its outcome. Never throws for an ordinary CLI failure. */
export async function runWorkerTurn(request: TurnRequest): Promise<TurnOutcome> {
  const watch = request.account.client === 'claude' ? claudeWatcher(request) : codexWatcher(request)
  let result: GatedSpawnResult
  try {
    const child = spawnGated({
      bin: request.bin,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
      beforeStart: request.recordWorker,
      onStdoutLine: (line) => {
        if (watch.onLine(line) === 'kill') child.kill()
      },
    })
    result = await child.done
  } catch (error) {
    return { kind: 'failed', reason: `could not start ${request.bin}: ${String(error)}`, stderrTail: '', costUsd: null }
  }

  const stderrTail = result.stderr.trim().slice(-STDERR_TAIL)
  if (watch.violation.length > 0) return { kind: 'mcp_violation', servers: watch.violation }
  if (watch.overBudgetUsd !== null) return { kind: 'over_budget', costUsd: watch.overBudgetUsd }
  if (!result.started) return { kind: 'not_started' }
  if (result.timedOut) return { kind: 'failed', reason: 'the turn ran past its time limit and was stopped', stderrTail, costUsd: watch.costUsd() }
  if (result.killed) return { kind: 'stopped' }
  const finished = watch.finish(result, stderrTail)
  // A turn that produced its answer is never read as a blocked account, whatever its stderr mentions.
  if (finished.kind === 'reply' || finished.kind === 'mcp_violation') return finished
  const blocked = classifyBlocked({ exitCode: result.code, stderr: result.stderr, ...(result.spawnErrorCode ? { spawnErrorCode: result.spawnErrorCode } : {}) })
  if (blocked !== null) return { kind: 'account_blocked', reason: blocked, stderrTail }
  if (readsAsResumeRejection(result.stdout, result.stderr)) return { kind: 'resume_rejected' }
  return finished
}

type Watcher = {
  onLine(line: string): 'kill' | 'continue'
  violation: string[]
  overBudgetUsd: number | null
  costUsd(): number | null
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

/** Claude: checks the init event's MCP server list, and reads the result event's structured output. */
function claudeWatcher(request: TurnRequest): Watcher {
  let sawInit = false
  const watcher: Watcher = {
    violation: [],
    overBudgetUsd: null,
    onLine(line) {
      const event = parseLine(line)
      if (event?.type !== 'system' || event.subtype !== 'init' || !Array.isArray(event.mcp_servers)) return 'continue'
      sawInit = true
      const names = event.mcp_servers.map((server) => String((server as { name?: unknown }).name ?? ''))
      const unexpected = names.filter((name) => !request.allowedMcpServers.includes(name))
      if (unexpected.length === 0) return 'continue'
      watcher.violation = unexpected
      return 'kill'
    },
    costUsd: () => null,
    finish(result, stderrTail) {
      const final = parseFinalResult(result.stdout)
      const costUsd = final?.costUsd ?? null
      // No init event means the MCP set was never checked: fail closed.
      if (final?.sessionId !== undefined && !sawInit) return { kind: 'mcp_violation', servers: ['<no init event>'] }
      if (final?.sessionId === undefined) {
        return { kind: 'failed', reason: `claude exited ${result.code ?? 'abnormally'} with no result`, stderrTail, costUsd }
      }
      const structured = structuredOutput(result.stdout) ?? safeJson(final.text ?? '')
      const parsed = (request.parseReply ?? defaultParse)(structured)
      if (!parsed.ok) return { kind: 'schema_invalid', sessionId: final.sessionId, error: parsed.error, costUsd }
      return { kind: 'reply', reply: parsed.reply, sessionId: final.sessionId, costUsd }
    },
  }
  return watcher
}

function structuredOutput(stdout: string): unknown {
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = parseLine(lines[index] ?? '')
    if (event?.type === 'result' && event.structured_output !== undefined) return event.structured_output
  }
  return undefined
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Codex: meters token usage as it arrives and kills at the reservation; reads the thread id and the last agent message. */
function codexWatcher(request: TurnRequest): Watcher {
  let tokens = 0
  let sessionId: string | null = null
  let lastMessage: string | undefined
  const cost = (): number => (tokens / 1_000_000) * request.codexUsdPerMtok
  const watcher: Watcher = {
    violation: [],
    overBudgetUsd: null,
    onLine(line) {
      const event = parseLine(line)
      if (!event) return 'continue'
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id
      const item = event.item as { type?: unknown; text?: unknown } | undefined
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text
      const usage = event.usage as Record<string, unknown> | undefined
      if (usage) {
        tokens += ['input_tokens', 'output_tokens'].reduce((sum, key) => sum + (typeof usage[key] === 'number' ? (usage[key] as number) : 0), 0)
        if (cost() >= request.reservedUsd) {
          watcher.overBudgetUsd = cost()
          return 'kill'
        }
      }
      return 'continue'
    },
    costUsd: () => (tokens > 0 ? cost() : null),
    finish(result, stderrTail) {
      const costUsd = tokens > 0 ? cost() : null
      if (sessionId === null || lastMessage === undefined) {
        return { kind: 'failed', reason: `codex exited ${result.code ?? 'abnormally'} with no answer`, stderrTail, costUsd }
      }
      const parsed = (request.parseReply ?? defaultParse)(safeJson(lastMessage))
      if (!parsed.ok) return { kind: 'schema_invalid', sessionId, error: parsed.error, costUsd }
      return { kind: 'reply', reply: parsed.reply, sessionId, costUsd }
    },
  }
  return watcher
}

