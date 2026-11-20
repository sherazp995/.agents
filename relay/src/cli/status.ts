/**
 * `relay status`: whether the daemon process is running, what this run of it logged, whether the database
 * answers, and where the log is.
 *
 * The process comes from the service manager (launchd or systemd) and the log's tail, so that part answers while
 * the database or Slack is down; the database gets its own line, one bounded connection the caller supplies.
 */

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { SERVICE_LABEL, SYSTEMD_UNIT, serviceUnitPath } from './service.js'

export type StatusDeps = {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly home?: string
  /** Runs a command and returns its stdout; throws when it exits non-zero. */
  readonly run?: (file: string, args: readonly string[]) => string
  /** The last bytes of a file, or null when it does not exist. */
  readonly readTail?: (path: string) => string | null
  readonly readFile?: (path: string) => string | null
  /** When the process with this pid started, in ms since the epoch, or null when unknown. */
  readonly processStartMs?: (pid: string) => number | null
  /** One connection to the database the daemon uses, with a time limit; omitted, no database line is printed. */
  readonly checkDatabase?: () => Promise<DatabaseCheck>
}

export type DatabaseCheck = { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly ms: number; readonly error: string }

export type StatusResult = { readonly report: string; readonly exitCode: number }

const TAIL_BYTES = 64 * 1024

function runCommand(file: string, args: readonly string[]): string {
  return execFileSync(file, args as string[], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
}

function readTailOf(path: string): string | null {
  if (!existsSync(path)) return null
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function readFileOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** `ps -o lstart=` in UTC and the C locale, so the date parses the same on every laptop. */
function psStartMs(pid: string): number | null {
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', pid], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const ms = Date.parse(`${started} UTC`)
    return Number.isNaN(ms) ? null : ms
  } catch {
    return null
  }
}

type Process = { readonly running: boolean; readonly pid?: string; readonly detail: string; readonly logPath?: string }

/** `launchctl print` lines are `<tab>key = value`; only the service's own (one tab) level counts. */
function launchdField(output: string, key: string): string | undefined {
  const match = output.match(new RegExp(`^\\t${key} = (.+)$`, 'm'))
  return match?.[1]?.trim()
}

function launchdProcess(output: string): Process {
  const state = launchdField(output, 'state') ?? 'unknown'
  const pid = launchdField(output, 'pid')
  const exit = launchdField(output, 'last exit code')
  const runs = launchdField(output, 'runs')
  const logPath = launchdField(output, 'stdout path')
  const base = { ...(logPath ? { logPath } : {}) }
  // The start count shows on both sides: a crash loop caught in one of its short runs still reads as many starts.
  const starts = runs !== undefined ? `, started ${runs} time${runs === '1' ? '' : 's'}` : ''
  if (state === 'running' && pid !== undefined) return { ...base, running: true, pid, detail: `running (pid ${pid}${starts})` }
  const why = exit !== undefined && /^-?\d+$/.test(exit) && exit !== '0' ? `, last exit code ${exit}` : ''
  return { ...base, running: false, detail: `not running (launchd state: ${state}${why}${starts})` }
}

function systemdProcess(output: string, unitFile: string | null): Process {
  const field = (key: string) => output.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim()
  const active = field('ActiveState') ?? 'unknown'
  const sub = field('SubState') ?? ''
  const pid = field('MainPID')
  const status = field('ExecMainStatus')
  const restarts = field('NRestarts')
  const logPath = unitFile?.match(/^StandardOutput=append:(.+)$/m)?.[1]?.trim()
  const base = { ...(logPath ? { logPath } : {}) }
  const again = restarts !== undefined && restarts !== '0' ? `, restarted ${restarts} times` : ''
  if (active === 'active' && pid !== undefined && pid !== '0') return { ...base, running: true, pid, detail: `running (pid ${pid}${again})` }
  const why = status !== undefined && status !== '0' ? `, last exit code ${status}` : ''
  return { ...base, running: false, detail: `not running (systemd: ${active}${sub ? `/${sub}` : ''}${why}${again})` }
}

type LogLine = { readonly text: string; readonly time?: number; readonly error: boolean }

function parseLine(line: string): LogLine {
  try {
    const entry = JSON.parse(line) as { time?: number; level?: number; msg?: string; err?: { message?: string } }
    const message = entry.msg ?? entry.err?.message ?? line
    const when = typeof entry.time === 'number' ? `${new Date(entry.time).toISOString().slice(11, 19)} UTC: ` : ''
    return { text: `${when}${message}`.slice(0, 300), ...(typeof entry.time === 'number' ? { time: entry.time } : {}), error: (entry.level ?? 30) >= 50 || entry.err !== undefined }
  } catch {
    // The daemon's own last words on a crash are a plain line: `relay-orchestrator failed: <error>`.
    return { text: line.slice(0, 300), error: / failed: /.test(line) }
  }
}

function logLines(tail: string): LogLine[] {
  return tail.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '').map(parseLine)
}

/** The log's last line, as `HH:MM:SS UTC: message` for the daemon's JSON lines, or the raw text for anything else. */
export function lastLogLine(tail: string): string | undefined {
  return logLines(tail).at(-1)?.text
}

/**
 * The lines this run of the daemon wrote: from the first line stamped at or after its start. Unstamped lines (a
 * crash's plain last words) belong to whichever run wrote the stamped line before them, so they are kept only once
 * a line of this run has been seen. A second of slack covers ps reporting whole seconds.
 */
function linesSince(lines: LogLine[], startMs: number): LogLine[] {
  const first = lines.findIndex((line) => line.time !== undefined && line.time >= startMs - 1_000)
  return first < 0 ? [] : lines.slice(first)
}

/** What the last state line says this daemon is doing. A failover wait does not say why it waits, so neither does this. */
function role(lines: LogLine[]): string | undefined {
  const states: Array<[string, string]> = [
    ['orchestrator is running', 'answering Slack'],
    ['failover is on: waiting', 'waiting to take the failover record (another laptop answers, or the database is slow or unreachable)'],
    ['shutting down', 'shutting down'],
  ]
  for (const line of [...lines].reverse()) {
    const found = states.find(([needle]) => line.text.includes(needle))
    if (found !== undefined) return found[1]
  }
  return undefined
}

/** Only launchd's own "no such service" answer means not installed; anything else (a timeout) is a failed check. */
function launchdMissing(error: unknown): boolean {
  const stderr = String((error as { stderr?: unknown }).stderr ?? '')
  return (error as { status?: unknown }).status === 113 || /Could not find service/.test(stderr)
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export async function runStatus(deps: StatusDeps = {}): Promise<StatusResult> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runCommand
  const readTail = deps.readTail ?? readTailOf
  let proc: Process
  const lines: string[] = []
  if (platform === 'linux') {
    let output: string | undefined
    try {
      output = run('systemctl', ['--user', 'show', SYSTEMD_UNIT, '-p', 'ActiveState,SubState,MainPID,ExecMainStatus,NRestarts,LoadState'])
    } catch (error) {
      lines.push(`Relay daemon: unknown (systemctl --user failed: ${(error as Error).message.split('\n')[0]})`)
    }
    if (output !== undefined && /^LoadState=not-found$/m.test(output)) {
      lines.push(`Relay daemon: not installed (no ${SYSTEMD_UNIT}). Install it with: relay install-service --start`)
      output = undefined
    }
    proc = output === undefined ? { running: false, detail: '' } : systemdProcess(output, (deps.readFile ?? readFileOrNull)(serviceUnitPath(deps.home ?? homedir())))
  } else {
    let output: string | undefined
    try {
      output = run('/bin/launchctl', ['print', `gui/${deps.uid ?? process.getuid?.() ?? 0}/${SERVICE_LABEL}`])
    } catch (error) {
      lines.push(
        launchdMissing(error)
          ? `Relay daemon: not installed (launchd has no ${SERVICE_LABEL}). Install it with: relay install-service --start`
          : `Relay daemon: unknown (launchctl print failed: ${(error as Error).message.split('\n')[0]})`,
      )
    }
    proc = output === undefined ? { running: false, detail: '' } : launchdProcess(output)
  }

  if (proc.detail !== '') {
    const tail = proc.logPath === undefined ? null : readTail(proc.logPath)
    const all = tail === null ? [] : logLines(tail)
    const startMs = proc.running && proc.pid !== undefined ? (deps.processStartMs ?? psStartMs)(proc.pid) : null
    // A running daemon is described only by its own lines; one that has not logged yet gets no role from an older run.
    const own = proc.running ? (startMs === null ? [] : linesSince(all, startMs)) : all
    const doing = proc.running ? role(own) : undefined
    lines.push(`Relay daemon: ${proc.detail}${doing ? `, ${doing}` : ''}`)
    const last = own.at(-1) ?? (proc.running ? undefined : all.at(-1))
    if (last !== undefined) lines.push(`Last log line: ${last.text}`)
    const lastError = [...own].reverse().find((line) => line.error)
    if (lastError !== undefined && lastError !== last) lines.push(`Last error${proc.running ? ' since it started' : ''}: ${lastError.text}`)
  }
  // Started after the synchronous launchctl and ps calls, so its time is the database's alone.
  if (deps.checkDatabase !== undefined) {
    const result = await deps.checkDatabase()
    lines.push(result.ok ? `Database: reachable (connected in ${seconds(result.ms)})` : `Database: not reachable after ${seconds(result.ms)} (${result.error.split('\n')[0]})`)
  }
  if (proc.logPath !== undefined) lines.push(`Log: ${proc.logPath}`)
  return { report: lines.join('\n'), exitCode: proc.running ? 0 : 1 }
}
