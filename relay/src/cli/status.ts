/**
 * `relay status`: whether the daemon process is running, what it last logged, and where its log is.
 *
 * It asks only the service manager (launchd or systemd) and reads the log's tail, never the database or Slack,
 * so it answers while those are down, which is when it is needed.
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
}

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
  if (state === 'running' && pid !== undefined) return { ...base, running: true, pid, detail: `running (pid ${pid})` }
  const why = exit !== undefined && exit !== '0' ? `, last exit code ${exit}` : ''
  const starts = runs !== undefined ? `, started ${runs} times` : ''
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
  if (active === 'active' && pid !== undefined && pid !== '0') return { ...base, running: true, pid, detail: `running (pid ${pid})` }
  const why = status !== undefined && status !== '0' ? `, last exit code ${status}` : ''
  const again = restarts !== undefined && restarts !== '0' ? `, restarted ${restarts} times` : ''
  return { ...base, running: false, detail: `not running (systemd: ${active}${sub ? `/${sub}` : ''}${why}${again})` }
}

/** The log's last line, as `HH:MM:SS UTC: message` for the daemon's JSON lines, or the raw text for anything else. */
export function lastLogLine(tail: string): string | undefined {
  const line = tail.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '').at(-1)
  if (line === undefined) return undefined
  try {
    const entry = JSON.parse(line) as { time?: number; msg?: string; err?: { message?: string } }
    const message = entry.msg ?? entry.err?.message ?? line
    const when = typeof entry.time === 'number' ? `${new Date(entry.time).toISOString().slice(11, 19)} UTC: ` : ''
    return `${when}${message}`.slice(0, 300)
  } catch {
    return line.slice(0, 300)
  }
}

/** What the last state line in the log says this laptop is doing, when the daemon runs. */
function role(tail: string): string | undefined {
  const states: Array<[string, string]> = [
    ['orchestrator is running', 'answering Slack'],
    ['failover is on: waiting', 'standing by (another laptop answers)'],
    ['shutting down', 'shutting down'],
  ]
  let found: { at: number; label: string } | undefined
  for (const [needle, label] of states) {
    const at = tail.lastIndexOf(needle)
    if (at >= 0 && (found === undefined || at > found.at)) found = { at, label }
  }
  return found?.label
}

export function runStatus(deps: StatusDeps = {}): StatusResult {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runCommand
  const readTail = deps.readTail ?? readTailOf
  let proc: Process
  if (platform === 'linux') {
    let output: string
    try {
      output = run('systemctl', ['--user', 'show', SYSTEMD_UNIT, '-p', 'ActiveState,SubState,MainPID,ExecMainStatus,NRestarts,LoadState'])
    } catch (error) {
      return { report: `Relay daemon: unknown (systemctl --user failed: ${(error as Error).message.split('\n')[0]})`, exitCode: 1 }
    }
    if (/^LoadState=not-found$/m.test(output)) return { report: `Relay daemon: not installed (no ${SYSTEMD_UNIT}). Install it with: relay install-service --start`, exitCode: 1 }
    proc = systemdProcess(output, (deps.readFile ?? readFileOrNull)(serviceUnitPath(deps.home ?? homedir())))
  } else {
    let output: string
    try {
      output = run('/bin/launchctl', ['print', `gui/${deps.uid ?? process.getuid?.() ?? 0}/${SERVICE_LABEL}`])
    } catch {
      return { report: `Relay daemon: not installed (launchd has no ${SERVICE_LABEL}). Install it with: relay install-service --start`, exitCode: 1 }
    }
    proc = launchdProcess(output)
  }

  const tail = proc.logPath === undefined ? null : readTail(proc.logPath)
  const doing = proc.running && tail !== null ? role(tail) : undefined
  const lines = [`Relay daemon: ${proc.detail}${doing ? `, ${doing}` : ''}`]
  const last = tail === null ? undefined : lastLogLine(tail)
  if (last !== undefined) lines.push(`Last log line: ${last}`)
  if (proc.logPath !== undefined) lines.push(`Log: ${proc.logPath}`)
  return { report: lines.join('\n'), exitCode: proc.running ? 0 : 1 }
}
