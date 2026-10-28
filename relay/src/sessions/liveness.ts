/**
 * FR-ATT-5's routing rule needs one fact this file exists to answer
 * honestly: might a Claude Code session already be in active use, right
 * now, in a given folder? Established empirically, across two independent
 * investigations (see
 * .superpowers/sdd/2026-08-10-relay-p0.4-policy-and-approvals/attach-report.md),
 * not assumed:
 *
 *   - There is no lock file. Nothing arbitrates concurrent writers to a
 *     transcript; `lsof` on the transcript directory during a real, active
 *     call showed nothing held open.
 *   - The determining factor is temporal overlap in ACTIVE WRITING, not
 *     "a terminal is open": an interactive session run concurrently with a
 *     headless resume, separated by about a second of natural timing,
 *     produced a clean linear continuation, no fork, because the first
 *     turn had finished writing before the second read the transcript. A
 *     terminal that is open but idle is safe to resume; only genuine
 *     mid-turn overlap forks. This makes fork-on-detection CONSERVATIVE
 *     rather than exact: an operator who keeps a terminal open all day, but
 *     is not necessarily mid-turn, gets a branch every time this check
 *     finds that process, never a resume in place. That is a real,
 *     deliberate trade, not an oversight; see the attach-report for it
 *     stated as a known cost rather than a surprise.
 *   - A headless (`-p --resume <id>`) process's exact session id is visible
 *     in its own command line, readable via `ps`. A bare `claude -c`
 *     (continue) or an interactive resume from the in-app picker shows
 *     nothing but `claude -c` or `claude`, no session id at all: argv
 *     matching alone would miss exactly the case that matters most, which
 *     is why it is a secondary signal here, not the primary one.
 *   - Working directory, resolved via `lsof -a -p <pid> -d cwd`, is the
 *     primary, general signal: reliable for every claude process checked,
 *     interactive or headless, and it lines up with how
 *     src/sessions/store.ts's findSessionByEngineCwd already routes, by
 *     folder rather than by session id.
 *   - The transcript's own mtime updates in BURSTS, not continuously (two
 *     samples 1.5s apart showed no change, then a jump), which makes it a
 *     weak signal for proving a session is IDLE but a fine one for proving
 *     a session is ACTIVE: a transcript touched moments ago genuinely means
 *     someone is there. This file uses it exactly that way: a POSITIVE-ONLY
 *     signal that can only ever answer "yes, possibly live", stale mtime
 *     answers nothing either way and always falls through to the process
 *     scan below rather than being read as proof of "no". Do not turn this
 *     into a two-sided threshold; that was tried and the burstiness makes
 *     it unsupportable.
 *   - A running `--chrome-native-host` helper shares the `claude` binary
 *     name and must be filtered out explicitly, or it registers as a false
 *     "live" for every folder, always.
 *
 * ASYMMETRY, stated because it is why an imperfect check here is still a
 * sound design, not a shortcut: this function is only ever consulted to
 * decide resume-in-place versus `--fork-session`, and forking is ALWAYS
 * safe (see src/agent/loop.ts's own routing logic). A false positive here
 * costs one unnecessary fork, harmless. A false negative costs the exact
 * silent-fork failure the investigation demonstrated: no corruption, no
 * crash, just one branch quietly becoming unreachable. Given that
 * asymmetry, this function is deliberately biased toward returning `true`
 * (possibly live) whenever it is genuinely unsure, including when any part
 * of the scan itself fails, discovery included: see hasLiveClaudeProcess's
 * own doc comment and the sessions-root readability check in
 * isSessionPossiblyLive for exactly where each failure mode is decided,
 * deliberately, rather than left to whatever a different function
 * (listEngineSessions, built for listing, not for a safety decision)
 * happens to do when it cannot read something.
 */

import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { defaultSessionsRoot, listEngineSessions } from './discovery.js'

/**
 * How recently a transcript must have been written for this file to treat
 * it as possibly live without even checking for a running process. Chosen,
 * not guessed: every real engine call in this milestone's own investigation
 * took single-digit seconds; sixty is generously past the longest one
 * observed (the ~15s "count to five" call), so a transcript this fresh is
 * either mid-turn right now or was moments ago, while a transcript idle for
 * a full minute is very unlikely to resume writing in the few milliseconds
 * between this check and the engine actually spawning.
 */
export const FRESH_TRANSCRIPT_THRESHOLD_MS = 60_000

export type LivenessCheckParams = {
  /** The working directory the session under consideration ran in, per src/sessions/discovery.ts's own `cwd` field. */
  readonly cwd: string
  /** The exact session id being considered for a plain resume. */
  readonly sessionId: string
  /** Passed straight through to listEngineSessions; defaults to `~/.claude/projects`. Overridable so tests never touch the operator's real sessions, matching test/sessions/discovery.test.ts's own convention. */
  readonly root?: string
}

export type ExecFileFn = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>

/**
 * Bounds every ps/lsof call. This runs on Slack's serial inbound path, so a
 * scan that hangs (plain `lsof` blocked for minutes on a kernel call) held
 * every later message with it.
 */
const EXEC_TIMEOUT_MS = 5_000

export function defaultExecFile(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // No shell: an argv array, so nothing in `args` (a directory path or a
    // session id, both potentially operator-influenced) can be reinterpreted
    // as shell syntax. Mirrors src/secrets/keychain.ts's own defaultExecFile.
    execFile(file, args as string[], { timeout: EXEC_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Every running process whose command starts with `claude`, per `ps -eo
 * pid,command`. Deliberately lets a `ps` failure PROPAGATE rather than
 * swallowing it into an empty list: "found nothing" and "could not look"
 * are different facts, and only hasLiveClaudeProcess's own catch, below, is
 * the one place that decides what to do with the second one (fail toward
 * "possibly live", per this file's header comment). Swallowing the error
 * here would make that catch unreachable.
 */
async function listClaudeProcesses(execFileFn: ExecFileFn): Promise<{ pid: number; command: string }[]> {
  const { stdout } = await execFileFn('ps', ['-eo', 'pid,command'])
  const processes: { pid: number; command: string }[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = /^(\d+)\s+(.*)$/.exec(trimmed)
    if (!match) continue
    const [, pidText, command] = match
    if (!command || !/(^|\/)claude(\s|$)/.test(command)) continue
    // The Chrome-native-host helper shares the `claude` binary path (it is
    // the same installed binary, invoked with this one flag) but is not a
    // session at all; counting it would register as a false "live" for
    // every folder, always, since it is running continuously in the
    // background rather than tied to any particular working directory.
    if (command.includes('--chrome-native-host')) continue
    const pid = Number(pidText)
    if (Number.isNaN(pid)) continue
    processes.push({ pid, command })
  }
  return processes
}

/**
 * lsof's own fixed column order for a single row: COMMAND PID USER FD TYPE
 * DEVICE SIZE/OFF NODE NAME, eight whitespace-delimited fields followed by
 * NAME, the path, which is the one field that can legitimately contain
 * whitespace of its own (an ordinary occurrence on macOS: any path under
 * "My Documents", Dropbox, iCloud Drive, or Google Drive). Matching exactly
 * eight non-space tokens and capturing everything after them, rather than
 * splitting the whole line on whitespace and taking the last token, is what
 * keeps a spaced path intact instead of silently truncating it to its final
 * word. A truncated path would fail to match the target cwd, which is the
 * WRONG side of this file's own fail-toward-live guarantee: a live session
 * in a spaced path would read as not live, and Relay would resume in place
 * into a session someone else is actively writing to.
 */
const LSOF_ROW_PATTERN = /^\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/

/**
 * The working directory a running process actually has open, via `lsof -a
 * -p <pid> -d cwd`'s own `cwd` row (`-d cwd` restricts lsof's own output to
 * that one file descriptor, rather than every file the process has open,
 * which is both faster and leaves less for this function to filter
 * through). `undefined` when `lsof` fails, the process already exited
 * between the `ps` scan and this call (a real, accepted race, resolved the
 * same way every other uncertainty here is: the caller treats "could not
 * determine" as "cannot rule out live"), or the `cwd` row is not present in
 * its output for any reason.
 */
async function processCwd(execFileFn: ExecFileFn, pid: number): Promise<string | undefined> {
  let stdout: string
  try {
    // -b avoids kernel calls that can block (a stuck mount kept plain lsof
    // running for minutes); -w drops the warnings -b brings.
    ;({ stdout } = await execFileFn('lsof', ['-b', '-w', '-a', '-p', String(pid), '-d', 'cwd']))
  } catch {
    return undefined
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = LSOF_ROW_PATTERN.exec(trimmed)
    if (!match) continue
    const [, fd, name] = match
    if (fd === 'cwd') return name
  }
  return undefined
}

/**
 * Whether any running `claude` process is plausibly operating on
 * `sessionId` in `cwd` right now: either its own command line names the
 * exact session id (true for a headless `-p --resume <id>` call, whose full
 * command line is visible via `ps`), or its actual working directory
 * (resolved via `lsof`, since an interactive process's command line shows
 * nothing useful) matches `cwd`.
 *
 * FAILS TOWARD "POSSIBLY LIVE", not away from it: if `ps` itself cannot be
 * run at all (missing binary, sandboxed environment, permission denied),
 * this returns `true` rather than `false`. An environment where this scan
 * cannot run at all is exactly the "the check itself failed" case the
 * accepted routing rule says must fork, per the same asymmetry stated in
 * this file's header comment.
 */
export async function hasLiveClaudeProcess(
  execFileFn: ExecFileFn,
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  let processes: { pid: number; command: string }[]
  try {
    processes = await listClaudeProcesses(execFileFn)
  } catch {
    return true
  }
  // An environment with no `ps` output for `claude` at all is ambiguous
  // between "no process access on this platform" and "genuinely nothing
  // running"; distinguishing those would need a stronger platform probe
  // this file does not attempt, so an empty scan is trusted as a real
  // negative here, and the actual fail-closed behaviour lives in the
  // try/catch above and in listClaudeProcesses' own internal catch.
  for (const proc of processes) {
    // An empty id is contained in every command line, so it never counts as a match.
    if (sessionId !== '' && proc.command.includes(sessionId)) return true
    const cwdOfProc = await processCwd(execFileFn, proc.pid)
    if (cwdOfProc !== undefined && cwdOfProc === cwd) return true
  }
  return false
}

/**
 * Whether the sessions root itself can even be listed. This exists ONLY so
 * isSessionPossiblyLive can tell "genuinely no fresh transcript for this
 * session" apart from "could not read the sessions directory at all", a
 * distinction listEngineSessions itself does not preserve: it is built for
 * LISTING, where swallowing a read failure and returning an empty result is
 * the right, forgiving behaviour (one unreadable directory should not deny
 * the operator every other session), and that is a different purpose from
 * a safety check, where the same empty result must instead be read as "the
 * freshness signal could not be evaluated" and bias toward `true`. Making
 * that its own explicit decision here, rather than inheriting
 * listEngineSessions' own choice for a different problem, is the point.
 */
async function canReadSessionsRoot(root: string): Promise<boolean> {
  try {
    await readdir(root)
    return true
  } catch {
    return false
  }
}

/**
 * The one function src/agent/loop.ts's routing rule calls. See this file's
 * header comment for the two signals and the asymmetry that justifies
 * biasing toward `true`.
 */
export async function isSessionPossiblyLive(
  params: LivenessCheckParams,
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<boolean> {
  const root = params.root ?? defaultSessionsRoot()
  // A discovery failure is itself evidence of an unhealthy environment for
  // THIS check's own purpose (per this file's header comment and
  // canReadSessionsRoot's own doc comment), so it is treated the same as a
  // `ps` failure below: biased toward `true`, decided here rather than left
  // as a side effect of listEngineSessions choosing to be forgiving for its
  // own, different purpose.
  if (!(await canReadSessionsRoot(root))) return true

  const sessions = await listEngineSessions({ cwd: params.cwd, root })
  const match = sessions.find((session) => session.sessionId === params.sessionId)
  if (match) {
    // POSITIVE-ONLY: this can only ever push the answer toward `true`. A
    // stale or absent match answers nothing on its own, per this file's own
    // header comment on why mtime's burstiness makes it unsound as a
    // two-sided signal, and always falls through to the process scan below.
    const ageMs = Date.now() - match.lastModifiedAt.getTime()
    if (ageMs < FRESH_TRANSCRIPT_THRESHOLD_MS) return true
  }
  return hasLiveClaudeProcess(execFileFn, params.cwd, params.sessionId)
}
