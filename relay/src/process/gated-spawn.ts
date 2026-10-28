/**
 * Starts a CLI in its own process group behind a start gate.
 *
 * The child is `/bin/sh -c 'read -r go && exec "$0" "$@"' <bin> <args>`.
 * The shell waits for one line on stdin before it execs the real CLI, so a
 * caller can record the pid durably first and only then open the gate. If
 * the caller dies before writing `go`, the shell reads end of file and exits
 * without ever starting the CLI: no worker runs unrecorded. After `go`,
 * stdin is closed, so the CLI sees an empty, closed stdin, unless the caller
 * passes `input`: then stdin stays open for the CLI, starting with that
 * text, and the caller writes more with `write()` and closes it with
 * `endInput()`.
 *
 * `detached: true` makes the child a process-group leader (pgid = pid), so
 * `kill()` signals the whole group and descendants the CLI started die too.
 */

import { spawn } from 'node:child_process'

const GATE_SCRIPT = 'read -r go && exec "$0" "$@"'

/** sh's "command not found" exit, which is how a missing binary shows up behind the gate. */
const SHELL_NOT_FOUND = 127

const REKILL_INTERVAL_MS = 50

export type GatedSpawnOptions = {
  bin: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  /**
   * Called with the pid and pgid before the gate opens. Return false to
   * refuse the start (the group is killed and the CLI never runs). Omitted
   * means open at once.
   */
  beforeStart?: (pid: number, pgid: number) => Promise<boolean>
  /** Each complete stdout line as it arrives, for callers that meter usage mid-run. */
  onStdoutLine?: (line: string) => void
  /** Text the CLI reads first on stdin; stdin then stays open until `endInput()`. */
  input?: string
}

export type GatedSpawnResult = {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** True when kill() ran: a refused gate, a timeout, an abort or a caller's kill. */
  killed: boolean
  /** True once the gate opened and the CLI was allowed to start. */
  started: boolean
  /** 'ENOENT' when the binary was not found. */
  spawnErrorCode?: string
}

export type GatedProcess = {
  pid: number
  pgid: number
  /** Kills the whole process group. Safe to call more than once. */
  kill(): void
  /** Writes to the CLI's open stdin; false before the gate opens, after `endInput()` or a broken pipe, or without `input`. True means handed to the pipe, not read. */
  write(text: string): boolean
  /** Closes the CLI's stdin. Safe to call more than once. */
  endInput(): void
  done: Promise<GatedSpawnResult>
}

/**
 * Groups still running. They lead their own process group, so the daemon's
 * own exit would not take them down; the exit hook does.
 */
const liveGroups = new Set<number>()
process.on('exit', () => {
  for (const pgid of liveGroups) killProcessGroup(pgid)
})

export function killProcessGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/** True while any process in the group is alive. */
export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function spawnGated(options: GatedSpawnOptions): GatedProcess {
  const child = spawn('/bin/sh', ['-c', GATE_SCRIPT, options.bin, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pid = child.pid
  if (pid === undefined) {
    // The spawn failure arrives as an 'error' event; without a listener it would crash the daemon.
    child.on('error', () => undefined)
    throw new Error(`could not start ${options.bin}`)
  }
  const pgid = pid
  liveGroups.add(pgid)

  let killed = false
  let started = false
  let inputOpen = false
  let rekill: NodeJS.Timeout | undefined
  // A process forked while the group is being signalled can miss that
  // signal, so kill() keeps re-signalling until the group is empty.
  const kill = (): void => {
    killed = true
    killProcessGroup(pgid)
    if (rekill !== undefined) return
    rekill = setInterval(() => {
      if (processGroupAlive(pgid)) killProcessGroup(pgid)
      else {
        clearInterval(rekill)
        liveGroups.delete(pgid)
      }
    }, REKILL_INTERVAL_MS)
    rekill.unref()
  }

  const done = new Promise<GatedSpawnResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let pendingLine = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs)
    const onAbort = (): void => kill()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // A line callback that throws must not take the daemon down; the turn is killed instead.
    const emitLine = (line: string): void => {
      try {
        options.onStdoutLine?.(line)
      } catch {
        kill()
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      stdout += text
      if (!options.onStdoutLine) return
      pendingLine += text
      const lines = pendingLine.split('\n')
      pendingLine = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') emitLine(line)
    })
    child.stderr.on('data', (text: string) => {
      stderr += text
    })
    // A refused or killed gate closes stdin under the shell; that is expected.
    // A broken stdin also ends `write()`, so later input is not reported as sent.
    child.stdin.on('error', () => {
      inputOpen = false
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      kill()
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      inputOpen = false
      if (!processGroupAlive(pgid)) {
        if (rekill !== undefined) clearInterval(rekill)
        liveGroups.delete(pgid)
      }
      options.signal?.removeEventListener('abort', onAbort)
      if (options.onStdoutLine && pendingLine.trim() !== '') emitLine(pendingLine)
      // The shell's own message names the binary, so a CLI that itself exits 127 is not mistaken for a missing one.
      const notFound = code === SHELL_NOT_FOUND && stderr.includes(options.bin) && /not found|No such file/i.test(stderr)
      resolve({ stdout, stderr, code, timedOut, killed, started, ...(notFound ? { spawnErrorCode: 'ENOENT' } : {}) })
    })
  })

  const open = async (): Promise<void> => {
    // A failed durable write counts as a refusal: no worker runs unrecorded.
    const proceed = options.beforeStart ? await options.beforeStart(pid, pgid).catch(() => false) : true
    if (!proceed || killed || options.signal?.aborted) {
      kill()
      child.stdin.end()
      return
    }
    started = true
    if (options.input === undefined) {
      child.stdin.end('go\n')
      return
    }
    // `read` takes one line from a pipe byte by byte, so the CLI gets everything after it.
    inputOpen = true
    child.stdin.write(`go\n${options.input}`)
  }
  void open()

  const write = (text: string): boolean => {
    if (!inputOpen || killed) return false
    child.stdin.write(text)
    return true
  }
  const endInput = (): void => {
    inputOpen = false
    child.stdin.end()
  }

  return { pid, pgid, kill, write, endInput, done }
}
