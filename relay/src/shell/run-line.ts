/**
 * Runs one shell line from Slack (README, "Shell from Slack") in the owner's
 * login shell: `<shell> -l -c <script>` in its own process group, stdin
 * closed, stdout and stderr captured together as a head and a tail.
 *
 * The command travels in an environment variable and is `eval`ed by the
 * script, so it is never spliced into the script's own text. The script also
 * puts the sudo wrapper first on PATH (after the login profile ran, because
 * macOS's /etc/zprofile path_helper reorders PATH) and writes the folder the
 * line ended in to a private file, which becomes `folderAfter` when the line
 * exited 0.
 *
 * A time limit or an abort sends SIGTERM to the whole group (so sudo passes
 * it on to its root child), then SIGKILL after a grace period.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { SHELL_KILL_GRACE_MS, type CapturedOutput, type LineOutcome, type LineResult, type RunLineOptions } from './types.js'

const DEFAULT_HEAD_BYTES = 6000
const DEFAULT_TAIL_BYTES = 4000
/** How long to keep reading after the shell exited, when a backgrounded child still holds the pipes open. */
const DRAIN_AFTER_EXIT_MS = 200
const COMMAND_ENV = 'RELAY_SHELL_COMMAND'
const TIMEOUT_REASON = 'time limit'

/** Quotes a value as one single-quoted word for sh, bash and zsh. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function lineScript(folder: string, cwdFile: string, binDir: string | undefined): string {
  return [
    ...(binDir === undefined ? [] : [`export PATH=${shellQuote(binDir)}:"$PATH"`]),
    `cd -- ${shellQuote(folder)} || { printf 'relay: cannot enter %s\\n' ${shellQuote(folder)} >&2; exit 1; }`,
    `__relay_command=$${COMMAND_ENV}`,
    `unset ${COMMAND_ENV}`,
    'eval "$__relay_command"',
    '__relay_status=$?',
    `pwd -P > ${shellQuote(cwdFile)} 2>/dev/null`,
    'exit "$__relay_status"',
  ].join('\n')
}

/** Combined output in arrival order: the first `headBytes`, the last `tailBytes`, and a count of what fell between. */
class OutputCapture {
  private readonly head: Buffer[] = []
  private headLength = 0
  private tail = Buffer.alloc(0)
  private dropped = 0

  constructor(
    private readonly headBytes: number,
    private readonly tailBytes: number,
  ) {}

  add(chunk: Buffer): void {
    const room = this.headBytes - this.headLength
    if (room > 0) {
      const taken = chunk.subarray(0, room)
      this.head.push(taken)
      this.headLength += taken.length
      chunk = chunk.subarray(taken.length)
    }
    if (chunk.length === 0) return
    const tail = Buffer.concat([this.tail, chunk])
    const excess = Math.max(0, tail.length - this.tailBytes)
    this.dropped += excess
    this.tail = tail.subarray(excess)
  }

  result(): CapturedOutput {
    const head = Buffer.concat(this.head)
    if (this.dropped === 0) return { head: Buffer.concat([head, this.tail]).toString('utf8'), tail: '', omittedBytes: 0 }
    const headEnd = completeCharactersLength(head)
    const tailStart = firstCharacterStart(this.tail)
    return {
      head: head.subarray(0, headEnd).toString('utf8'),
      tail: this.tail.subarray(tailStart).toString('utf8'),
      omittedBytes: this.dropped + (head.length - headEnd) + tailStart,
    }
  }
}

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80

/** The length of `bytes` without a multi-byte character cut off at its end. */
function completeCharactersLength(bytes: Buffer): number {
  let start = bytes.length - 1
  while (start >= 0 && bytes.length - start <= 4 && isContinuationByte(bytes[start] as number)) start -= 1
  if (start < 0) return bytes.length
  const lead = bytes[start] as number
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return bytes.length - start < width ? start : bytes.length
}

/** Where the first whole character starts, skipping the end of one cut off at the front. */
function firstCharacterStart(bytes: Buffer): number {
  let start = 0
  while (start < bytes.length && start < 3 && isContinuationByte(bytes[start] as number)) start += 1
  return start
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : 'cancelled'
}

async function folderAfter(cwdFile: string, startFolder: string, outcome: LineOutcome): Promise<string> {
  if (outcome.kind !== 'exited' || outcome.code !== 0) return startFolder
  try {
    const folder = (await readFile(cwdFile, 'utf8')).trim()
    if (folder !== '' && (await stat(folder)).isDirectory()) return folder
  } catch {
    // No file (the command ended the shell itself) or the folder is gone.
  }
  return startFolder
}

export async function runLine(options: RunLineOptions): Promise<LineResult> {
  const capture = new OutputCapture(options.headBytes ?? DEFAULT_HEAD_BYTES, options.tailBytes ?? DEFAULT_TAIL_BYTES)
  if (options.signal?.aborted === true) {
    return {
      command: options.command,
      outcome: { kind: 'killed', why: 'cancelled', reason: abortReason(options.signal) },
      output: capture.result(),
      folderAfter: options.cwd,
    }
  }

  const privateDir = await mkdtemp(join(tmpdir(), 'relay-line-'))
  const cwdFile = join(privateDir, 'cwd')
  try {
    const outcome = await runScript(options, lineScript(options.cwd, cwdFile, options.sudo?.binDir), capture)
    return { command: options.command, outcome, output: capture.result(), folderAfter: await folderAfter(cwdFile, options.cwd, outcome) }
  } finally {
    await rm(privateDir, { recursive: true, force: true })
  }
}

function runScript(options: RunLineOptions, script: string, capture: OutputCapture): Promise<LineOutcome> {
  return new Promise((resolve) => {
    const child = spawn(options.shell, ['-l', '-c', script], {
      cwd: options.cwd,
      env: { ...options.env, ...options.sudo?.env, [COMMAND_ENV]: options.command },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const streams: readonly Readable[] = [child.stdout, child.stderr]
    for (const stream of streams) stream.on('data', (chunk: Buffer) => capture.add(chunk))

    let stopped: { readonly why: 'timeout' | 'cancelled'; readonly reason: string } | undefined
    let exited = false
    let killTimer: NodeJS.Timeout | undefined
    let drainTimer: NodeJS.Timeout | undefined
    let settled = false

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        // The group is already gone.
      }
    }
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    const stop = (why: 'timeout' | 'cancelled', reason: string): void => {
      if (stopped !== undefined || exited) return
      stopped = { why, reason }
      signalGroup('SIGTERM')
      // Left referenced on purpose: a sudo child can outlive the shell, and SIGKILL must still reach the group.
      killTimer = setTimeout(() => {
        if (groupAlive()) signalGroup('SIGKILL')
      }, options.graceMs ?? SHELL_KILL_GRACE_MS)
    }
    const onAbort = (): void => stop('cancelled', abortReason(options.signal as AbortSignal))
    const timeLimit = setTimeout(() => stop('timeout', TIMEOUT_REASON), options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const settle = (outcome: LineOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timeLimit)
      clearTimeout(drainTimer)
      if (!groupAlive()) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      for (const stream of streams) stream.destroy()
      resolve(outcome)
    }
    const outcomeOf = (code: number | null, signal: NodeJS.Signals | null): LineOutcome => {
      if (stopped !== undefined) return { kind: 'killed', ...stopped }
      if (code !== null) return { kind: 'exited', code }
      return { kind: 'signal', signal: signal ?? 'unknown' }
    }

    child.on('error', (error) => settle({ kind: 'spawn_failed', message: error.message }))
    child.on('exit', (code, signal) => {
      exited = true
      const outcome = outcomeOf(code, signal)
      // A backgrounded child (`sleep 100 &`) can hold the pipes open after the shell exited.
      drainTimer = setTimeout(() => settle(outcome), DRAIN_AFTER_EXIT_MS)
      child.on('close', () => settle(outcome))
    })
  })
}
