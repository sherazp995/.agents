/**
 * FR-SH-6: running a command inside the generated sandbox profile: the
 * SBPL profile under `sandbox-exec` on macOS, or pasta, bubblewrap and the
 * socket filter on Linux (./bwrap.ts).
 *
 * The macOS profile is written to a file and passed with `-f` rather than inline
 * with `-p`. An inline profile becomes a process ARGUMENT, and arguments are
 * readable by every user on the machine through the process table; the
 * profile names the operator's worktree and granted paths, which is a map of
 * what is worth attacking. The file is written with owner-only permissions
 * and removed when the run ends.
 *
 * WHY THERE IS NO "run unconfined" FALLBACK. FR-SH-7 requires a run to fail
 * closed when confinement is unavailable. A fallback path is the thing that
 * eventually runs, because it is the path that never fails, so it does not
 * exist here: `runSandboxed` either confines the command or returns a
 * failure naming the reason.
 */

import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildLinuxLaunch, linuxSandboxAvailability } from './bwrap.js'
import type { LinuxAvailabilityDependencies } from './bwrap.js'
import { buildSandboxProfile, describeSandboxRules, SandboxProfileError } from './profile.js'
import type { EffectiveSandboxRules, SandboxProfileSpec } from './profile.js'
import { unixSocketFilter } from './seccomp.js'

/** Where macOS keeps the sandbox wrapper. Absent on every other platform, which is what makes confinement unavailable there. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

export type SandboxRunRequest = {
  readonly spec: SandboxProfileSpec
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  /**
   * Cancels the run. Not passed to `spawn`'s own `signal` option: that kills
   * `sandbox-exec` itself, and the confined child it exec'd can outlive it.
   * The listener below kills the process GROUP instead, so a cancelled build
   * does not leave a compiler running unconfined-looking in the background.
   */
  readonly signal?: AbortSignal
}

export type SandboxRunResult =
  | {
      readonly outcome: 'ran'
      readonly exitCode: number | null
      readonly stdout: string
      readonly stderr: string
      readonly timedOut: boolean
      readonly rules: EffectiveSandboxRules
    }
  /** Confinement could not be applied. Never a silent downgrade to an unconfined run. */
  | { readonly outcome: 'unavailable'; readonly reason: string }

export type SandboxExecDependencies = {
  readonly platform?: NodeJS.Platform
  readonly sandboxExecPath?: string
  readonly pathExists?: (path: string) => boolean
  /** Linux: tool paths, the probe, and the two builders, so tests can break one layer on purpose. */
  readonly linux?: LinuxAvailabilityDependencies & {
    readonly unixSocketFilter?: typeof unixSocketFilter
    readonly buildLaunch?: typeof buildLinuxLaunch
  }
}

/**
 * Whether this machine can confine a run at all.
 *
 * Returned as a reason rather than a boolean because `relay doctor` and the
 * run's own failure message both need to say WHY, and "sandboxing is
 * unavailable" without a cause is the kind of message that gets worked
 * around instead of fixed.
 */
export function sandboxAvailability(deps: SandboxExecDependencies = {}): { available: true } | { available: false; reason: string } {
  const platform = deps.platform ?? process.platform
  const exists = deps.pathExists ?? existsSync
  const path = deps.sandboxExecPath ?? SANDBOX_EXEC_PATH

  if (platform === 'linux') {
    return linuxSandboxAvailability({ ...deps.linux, ...(deps.pathExists !== undefined ? { pathExists: deps.pathExists } : {}) })
  }
  if (platform !== 'darwin') {
    return {
      available: false,
      reason:
        'OS-level confinement is implemented with macOS `sandbox-exec` and, on Linux, bubblewrap and pasta; ' +
        `this is ${platform}. FR-SH-7 requires a run to fail closed rather than run unconfined, so coding runs are refused here.`,
    }
  }
  if (!exists(path)) {
    return {
      available: false,
      reason: `${path} is missing, so a coding run cannot be confined and will not be started (FR-SH-7).`,
    }
  }
  return { available: true }
}

type Launch = { readonly command: string; readonly args: readonly string[] }

/** macOS: the SBPL profile, written to the run's folder and passed with `-f`. */
function macLaunch(directory: string, spec: SandboxProfileSpec, request: SandboxRunRequest, deps: SandboxExecDependencies): Launch {
  const profilePath = join(directory, 'run.sb')
  writeFileSync(profilePath, buildSandboxProfile(spec), 'utf8')
  // The profile maps the operator's granted paths. Readable only by them.
  chmodSync(profilePath, 0o600)
  return { command: deps.sandboxExecPath ?? SANDBOX_EXEC_PATH, args: ['-f', profilePath, request.command, ...(request.args ?? [])] }
}

/** Linux: the socket filter, written to the run's folder, and the pasta plus bwrap command line around the command. */
function linuxLaunch(directory: string, spec: SandboxProfileSpec, request: SandboxRunRequest, deps: SandboxExecDependencies): Launch {
  const filter = (deps.linux?.unixSocketFilter ?? unixSocketFilter)(deps.linux?.arch)
  if (filter === undefined) throw new SandboxProfileError(`no socket filter exists for ${deps.linux?.arch ?? process.arch}, so the run cannot be confined (FR-SH-7).`)
  const filterPath = join(directory, 'filter.bpf')
  writeFileSync(filterPath, filter)
  chmodSync(filterPath, 0o600)
  const linux = deps.linux ?? {}
  return (linux.buildLaunch ?? buildLinuxLaunch)(
    {
      spec,
      filterPath,
      command: request.command,
      ...(request.args !== undefined ? { args: request.args } : {}),
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(linux.bwrapPath !== undefined ? { bwrapPath: linux.bwrapPath } : {}),
      ...(linux.pastaPath !== undefined ? { pastaPath: linux.pastaPath } : {}),
    },
    { ...(linux.home !== undefined ? { home: linux.home } : {}), ...(deps.pathExists !== undefined ? { pathExists: deps.pathExists } : {}) },
  )
}

/** Runs `command` confined by a profile generated from `spec`. */
export async function runSandboxed(
  request: SandboxRunRequest,
  deps: SandboxExecDependencies = {},
): Promise<SandboxRunResult> {
  const availability = sandboxAvailability(deps)
  if (!availability.available) return { outcome: 'unavailable', reason: availability.reason }

  // One directory per run, holding both the profile and the run's scratch
  // space. The scratch is granted in the profile and becomes the child's
  // TMPDIR, so a toolchain gets somewhere to write without the profile
  // having to grant the whole per-user temporary directory, which would make
  // every concurrent run writable by every other one.
  const directory = mkdtempSync(join(tmpdir(), 'relay-sandbox-'))
  const scratch = join(directory, 'scratch')
  mkdirSync(scratch, { recursive: true })

  let launch: Launch
  let rules: EffectiveSandboxRules
  const spec = { ...request.spec, temporaryDirectory: request.spec.temporaryDirectory ?? scratch }
  try {
    launch = (deps.platform ?? process.platform) === 'linux' ? linuxLaunch(directory, spec, request, deps) : macLaunch(directory, spec, request, deps)
    rules = describeSandboxRules(spec)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    if (error instanceof SandboxProfileError) return { outcome: 'unavailable', reason: error.message }
    throw error
  }

  try {
    // Output goes to owner-only files in the run's folder, not pipes: Node's
    // pipes are socket pairs, and pasta drops a socket handed to it as
    // stdout (the run printed nothing at all). Files behave the same under
    // sandbox-exec.
    const stdoutPath = join(directory, 'stdout')
    const stderrPath = join(directory, 'stderr')
    const outputFds = [openSync(stdoutPath, 'w', 0o600), openSync(stderrPath, 'w', 0o600)] as const
    /** The run's output so far; '' when a file cannot be read, so a run always resolves. */
    const readOutput = (path: string): string => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return ''
      }
    }

    return await new Promise<SandboxRunResult>((resolve) => {
      const baseEnv = request.env ?? process.env
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(launch.command, launch.args as string[], {
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          // Pointed at the granted scratch, so a tool that honours TMPDIR
          // writes somewhere the profile actually permits.
          env: { ...baseEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
          stdio: ['ignore', outputFds[0], outputFds[1]],
          // Its own process group, so cancellation can kill the confined
          // child too. Killing sandbox-exec alone leaves whatever it exec'd
          // running, which is how a cancelled build keeps compiling.
          detached: true,
        })
      } catch (error) {
        resolve({ outcome: 'unavailable', reason: `${launch.command} could not be started: ${(error as Error).message}` })
        return
      } finally {
        // The child holds its own copies, or there is no child.
        for (const fd of outputFds) closeSync(fd)
      }
      let timedOut = false

      /** Kills the whole group. Negative pid is the POSIX spelling for "the process group". */
      const killGroup = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          // Already gone, which is the outcome this wanted anyway.
        }
      }

      const timer =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              killGroup()
            }, request.timeoutMs)

      const onAbort = (): void => killGroup()
      if (request.signal !== undefined) {
        if (request.signal.aborted) killGroup()
        else request.signal.addEventListener('abort', onAbort, { once: true })
      }
      const stopListening = (): void => request.signal?.removeEventListener('abort', onAbort)

      child.on('error', (error) => {
        if (timer !== undefined) clearTimeout(timer)
        stopListening()
        resolve({ outcome: 'unavailable', reason: `${launch.command} could not be started: ${error.message}` })
      })
      child.on('close', (exitCode) => {
        if (timer !== undefined) clearTimeout(timer)
        stopListening()
        resolve({
          outcome: 'ran',
          exitCode,
          stdout: readOutput(stdoutPath),
          stderr: readOutput(stderrPath),
          timedOut,
          rules,
        })
      })
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
