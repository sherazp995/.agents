/**
 * The engine half of the agent loop: the `Capability` contract and the one
 * production Engine, `runClaudeEngine`, which spawns headless Claude Code.
 * See src/agent/loop.ts's header comment for DEC-1, the prompt structure and
 * what the live test does and does not prove.
 */
import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * One governed action the loop can invoke. Takes the input the engine chose
 * and an AbortSignal the loop fires when this step's timeout, the run's
 * timeout, or an external cancel arrives; a well-behaved capability should
 * check it, but the loop's own timeout race (see executeStep below) makes
 * the timeout binding even if the capability itself never looks at the
 * signal, the same accepted-abandoned-promise pattern src/chat/outbox.ts's
 * withTimeout already uses.
 */
export type Capability = (input: unknown, signal: AbortSignal) => Promise<unknown>

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type EngineInvocation = {
  readonly systemPrompt: string
  readonly prompt: string
  readonly jsonSchema: string
  readonly signal: AbortSignal
  /**
   * FR-SES-1: an engine session id to resume, per src/agent/loop.ts's header
   * comment. Absent for the very first engine call this Relay session has
   * ever made; present, and passed as `--resume`, on every call after
   * that once one is known. FR-ATT-5: this id no longer has to be one a
   * prior Relay run itself produced; it can equally be one
   * src/sessions/discovery.ts found on disk, so an operator can resume any
   * existing Claude Code chat, not only one Relay started. Nothing in this
   * file distinguishes the two: `--resume` takes any valid session id.
   */
  readonly resume?: string
  /**
   * FR-ATT-5 / FR-CFG-3: the directory the engine subprocess runs in.
   * Absent means Node's own `spawn` default (the CURRENT process's cwd,
   * i.e. Relay's own directory), which is every call before this field
   * existed and every governed run that has no attached folder. Present
   * means the engine runs in THAT directory instead, which is what gives a
   * resumed chat its own project's skills, agents, and settings, including
   * gitignored ones (FR-CFG-2): resuming the right chat id in the wrong
   * directory produces a session that looks correct and behaves
   * differently, which this field exists to prevent.
   */
  readonly cwd?: string
  /**
   * FR-ATT-5's routing rule: `--fork-session`, meaningful only together
   * with `resume` (ignored otherwise, there being nothing to fork from).
   * Set when the run's own liveness check found the target session
   * possibly in use elsewhere, so this call branches into a new session id
   * instead of writing into the same transcript another process might be
   * writing to right now, per the investigation in this milestone's own
   * attach-report.md: concurrent writers to one transcript silently fork
   * it anyway, just without a new id and without anyone being told.
   */
  readonly forkSession?: boolean
}

export type EngineResult = {
  readonly sessionId: string
  readonly numTurns: number
  readonly stopReason: string
  readonly totalCostUsd: number
  readonly usage: unknown
  readonly permissionDenials: readonly unknown[]
  readonly resultText: string
  readonly isError: boolean
  /**
   * The CLI's own `errors` array from the stream-json result event, when it
   * gave one. Empty rather than absent when the event carried none, so a
   * caller never needs a second existence check. This is what makes
   * "resume rejected" diagnosable ("No conversation found with session ID:
   * ...") rather than an opaque empty `resultText`, since a rejected resume
   * never reaches the point of producing real result text at all.
   */
  readonly errors: readonly string[]
}

export type Engine = (invocation: EngineInvocation) => Promise<EngineResult>

export class EngineAbortedError extends Error {
  constructor(reason: string) {
    super(`the claude engine invocation was aborted before it completed: ${reason}`)
    this.name = 'EngineAbortedError'
  }
}

export class EngineResponseError extends Error {
  constructor(message: string) {
    super(`the engine's response could not be understood: ${message}`)
    this.name = 'EngineResponseError'
  }
}

/**
 * FR-ATT-5: raised by validateEngineCwd for a directory that cannot be used
 * as the engine's working directory. Named per-case reasons ('missing',
 * 'not_a_directory', 'not_readable') rather than a single generic message,
 * so a caller (the run's own failureReason, in practice) can state plainly
 * what was wrong instead of leaving the operator to guess from an opaque
 * spawn failure three layers down.
 */
export class EngineCwdError extends Error {
  readonly cwd: string
  readonly reason: 'missing' | 'not_a_directory' | 'not_readable'

  constructor(cwd: string, reason: EngineCwdError['reason']) {
    const detail =
      reason === 'missing'
        ? 'the directory does not exist'
        : reason === 'not_a_directory'
          ? 'the path exists but is not a directory'
          : 'the directory exists but is not readable or traversable by this process'
    super(`cannot use "${cwd}" as the engine's working directory: ${detail}`)
    this.name = 'EngineCwdError'
    this.cwd = cwd
    this.reason = reason
  }
}

/**
 * Validates a directory before the engine ever spawns into it, per FR-ATT-5
 * item 3: a `cwd` that no longer exists, or is not a directory, must fail
 * with a clear message rather than an opaque spawn error, and a directory
 * that exists but is not readable is treated the same way, not silently
 * allowed through to fail unpredictably inside the spawned process instead.
 *
 * Checked with `access(..., R_OK | X_OK)`, not merely `stat`: a directory
 * needs the EXECUTE bit to be traversable (POSIX's own meaning of "search
 * permission" on a directory) as well as the read bit to be listable, and a
 * directory can fail either independently of the other.
 */
export async function validateEngineCwd(cwd: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new EngineCwdError(cwd, 'missing')
    }
    throw new EngineCwdError(cwd, 'not_readable')
  }
  if (!stats.isDirectory()) {
    throw new EngineCwdError(cwd, 'not_a_directory')
  }
  try {
    await access(cwd, fsConstants.R_OK | fsConstants.X_OK)
  } catch {
    throw new EngineCwdError(cwd, 'not_readable')
  }
}

const CLAUDE_BINARY = 'claude'

/** The shape of the final line stream-json emits, matching the same object --output-format json returns for a single-shot call. See DEC-1 and src/agent/loop.ts's header comment for how this was verified. */
const StreamJsonResultEventSchema = z.object({
  type: z.literal('result'),
  is_error: z.boolean().optional(),
  session_id: z.string(),
  num_turns: z.number(),
  stop_reason: z.string().optional(),
  total_cost_usd: z.number(),
  usage: z.unknown(),
  permission_denials: z.array(z.unknown()).optional(),
  result: z.string().optional(),
  /** Present on an error result, for example a rejected `--resume` id; see src/agent/loop.ts's header comment. */
  errors: z.array(z.string()).optional(),
})

function parseResultEvent(line: string): z.infer<typeof StreamJsonResultEventSchema> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  const result = StreamJsonResultEventSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

/**
 * The real engine. Spawns `claude -p` with `--output-format stream-json
 * --verbose` (stream-json requires --verbose, confirmed by running the CLI
 * without it: it fails fast with "requires --verbose" before spending
 * anything), reads newline-delimited JSON events off stdout, and resolves
 * with the last `type: "result"` event, which carries the same fields
 * `--output-format json` returns for a single-shot call: `session_id`,
 * `num_turns`, `stop_reason`, `total_cost_usd`, `usage`, and
 * `permission_denials`, confirmed present on a real invocation while
 * writing this code.
 *
 * `--tools ''` disables every built-in tool, per src/agent/loop.ts's header
 * comment. Never uses a shell (child_process.spawn with an argv array, not
 * a command string), so the prompt string, however constructed, cannot be
 * reinterpreted as shell syntax; this is a defence against a different
 * class of injection than AP-2's prompt boundary, and both apply here at
 * once.
 */
/**
 * Gate fix, High 3: the environment `runClaudeEngine` spawns the `claude`
 * binary with. Everything the child inherits from `process.env` by default
 * becomes readable to it, and this project's own KeychainSecretProvider was
 * careful never to let a value cross a subprocess boundary through argv or
 * environment inheritance for exactly this reason; that same care had not
 * been carried to this newer subprocess boundary until this fix.
 *
 * The minimum kept, and why each one is here:
 *   - HOME: where the operator's already-authenticated session lives (per
 *     DEC-1, this is `claude -p` running against the operator's own logged
 *     in session, not an API key), and where the CLI's own config,
 *     credentials, and CLAUDE.md discovery all resolve from.
 *   - PATH: the CLI is itself a Node program that may need to resolve its
 *     own subprocess dependencies; without it, spawning the binary itself
 *     can fail outright depending on how it was installed.
 *   - USER / LOGNAME: read by some auth and telemetry paths that key off
 *     the OS account; POSIX tools disagree on which of the two they set, so
 *     both are kept.
 *   - SHELL: some CLI tooling reads this to pick a default shell for its
 *     OWN internal use; `--tools ''` (src/agent/loop.ts's header comment) already
 *     disables every built-in tool this call could use to run a command of
 *     its own, so this is not a path for Relay's task text to reach a
 *     shell.
 *   - TMPDIR: where the CLI writes its own scratch and session files.
 *   - LANG / LC_ALL: locale-dependent text formatting in the CLI's own
 *     output.
 * Deliberately excluded: everything else, including any unrelated
 * credential, API key, or token an operator's shell session happens to
 * carry. A secret pasted into Slack is scrubbed before it ever reaches a
 * prompt (src/agent/untrusted.ts's renderForModel), but an AMBIENT
 * credential sitting in the operator's shell environment was never scrubbed
 * by anything, because nothing before this fix stopped it from being
 * inherited wholesale.
 */
const ENGINE_ENV_ALLOWLIST: readonly string[] = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
]

function buildEngineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENGINE_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * Gate fix, High 3: the prompt travels over stdin, never as an argv
 * element. `args` on a spawned process is world-readable through the
 * process table (`ps -ef` and equivalents) to any user on the same
 * machine, so a credential pasted into Slack and carried into the task
 * text would otherwise become locally world-readable for as long as the
 * child process runs. `claude -p` with no positional prompt argument reads
 * the prompt from stdin when `--input-format` is left at its default
 * ("text"), which this call never overrides, so omitting the positional
 * argument and writing to `child.stdin` instead is a straight substitution
 * with no other flag change needed.
 */
export const runClaudeEngine: Engine = (invocation) =>
  new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--system-prompt',
      invocation.systemPrompt,
      '--json-schema',
      invocation.jsonSchema,
      // FR-SES-1: `-r, --resume [value]`, verified against the installed
      // binary's own `claude --help`, resumes a prior conversation by its
      // session id. Only added when the caller actually has one; a bare
      // `--resume` with no value opens an interactive picker, which this
      // headless call must never trigger.
      ...(invocation.resume ? ['--resume', invocation.resume] : []),
      // FR-ATT-5: `--fork-session`, per `claude --help`: "When resuming,
      // create a new session ID instead of reusing the original." Only
      // meaningful, and only ever added, alongside `--resume`; a `resume`-less
      // call has nothing to fork from regardless of this flag.
      ...(invocation.resume && invocation.forkSession ? ['--fork-session'] : []),
    ]

    const child = spawn(CLAUDE_BINARY, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: invocation.signal,
      env: buildEngineEnv(),
      // FR-ATT-5: `undefined` here is Node's own documented default (the
      // current process's cwd), so a call that never sets this field spawns
      // exactly where every call did before this field existed.
      cwd: invocation.cwd,
    })

    // A child that exits (or is aborted) before this write completes would
    // otherwise raise an unhandled 'error' event on the stdin stream itself
    // (EPIPE, most plausibly); the 'error' handler on `child` below already
    // covers the abort/spawn-failure case for the promise's own resolution,
    // so this listener exists only to stop stdin's own EPIPE from crashing
    // the process, not to change what this call resolves or rejects with.
    child.stdin.on('error', () => {})
    child.stdin.write(invocation.prompt)
    child.stdin.end()

    let buffer = ''
    let lastResult: z.infer<typeof StreamJsonResultEventSchema> | undefined
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        const event = parseResultEvent(trimmed)
        if (event) lastResult = event
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error: Error) => {
      if (invocation.signal.aborted) {
        reject(new EngineAbortedError(error.message))
        return
      }
      reject(new Error(`failed to spawn the claude engine: ${error.message}`))
    })

    child.on('close', (code: number | null) => {
      if (invocation.signal.aborted) {
        reject(new EngineAbortedError(`process closed with exit code ${String(code)}`))
        return
      }
      if (!lastResult) {
        const detail = stderr.trim()
        reject(
          new Error(
            `claude -p exited with code ${String(code)} without emitting a stream-json result event` +
              (detail.length > 0 ? `: ${detail}` : ''),
          ),
        )
        return
      }
      resolve({
        sessionId: lastResult.session_id,
        numTurns: lastResult.num_turns,
        stopReason: lastResult.stop_reason ?? 'unknown',
        totalCostUsd: lastResult.total_cost_usd,
        usage: lastResult.usage,
        permissionDenials: lastResult.permission_denials ?? [],
        resultText: lastResult.result ?? '',
        isError: lastResult.is_error ?? false,
        errors: lastResult.errors ?? [],
      })
    })
  })


export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

