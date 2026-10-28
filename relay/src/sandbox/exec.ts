/**
 * FR-SH-6: running a command inside the generated sandbox profile.
 *
 * The profile is written to a file and passed with `-f` rather than inline
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSandboxProfile, describeSandboxRules, SandboxProfileError } from './profile.js'
import type { EffectiveSandboxRules, SandboxProfileSpec } from './profile.js'

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

  if (platform !== 'darwin') {
    return {
      available: false,
      reason:
        `OS-level confinement is implemented with macOS \`sandbox-exec\`, and this is ${platform}. ` +
        'FR-SH-7 requires a run to fail closed rather than run unconfined, so coding runs are refused here.',
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
  const profilePath = join(directory, 'run.sb')
  const scratch = join(directory, 'scratch')
  mkdirSync(scratch, { recursive: true })

  let profile: string
  let rules: EffectiveSandboxRules
  const spec = { ...request.spec, temporaryDirectory: request.spec.temporaryDirectory ?? scratch }
  try {
    profile = buildSandboxProfile(spec)
    rules = describeSandboxRules(spec)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    if (error instanceof SandboxProfileError) return { outcome: 'unavailable', reason: error.message }
    throw error
  }

  try {
    writeFileSync(profilePath, profile, 'utf8')
    // The profile maps the operator's granted paths. Readable only by them.
    chmodSync(profilePath, 0o600)

    return await new Promise<SandboxRunResult>((resolve) => {
      const baseEnv = request.env ?? process.env
      const child = spawn(
        deps.sandboxExecPath ?? SANDBOX_EXEC_PATH,
        ['-f', profilePath, request.command, ...(request.args ?? [])],
        {
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          // Pointed at the granted scratch, so a tool that honours TMPDIR
          // writes somewhere the profile actually permits.
          env: { ...baseEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group, so cancellation can kill the confined
          // child too. Killing sandbox-exec alone leaves whatever it exec'd
          // running, which is how a cancelled build keeps compiling.
          detached: true,
        },
      )

      let stdout = ''
      let stderr = ''
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

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        if (timer !== undefined) clearTimeout(timer)
        stopListening()
        resolve({ outcome: 'unavailable', reason: `sandbox-exec could not be started: ${error.message}` })
      })
      child.on('close', (exitCode) => {
        if (timer !== undefined) clearTimeout(timer)
        stopListening()
        resolve({ outcome: 'ran', exitCode, stdout, stderr, timedOut, rules })
      })
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
