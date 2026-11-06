/**
 * FR-SH-6 on Linux: the "equivalent OS confinement" the requirement allows
 * where macOS `sandbox-exec` does not exist.
 *
 * Three layers, each closing what the others cannot:
 *
 *   - pasta (passt) starts the run in a network namespace whose only
 *     interface is loopback, and forwards exactly one loopback port, the
 *     egress proxy's, out to the host (`--splice-only`, every other
 *     forwarding direction `none`). A direct socket to anywhere else has no
 *     route, so the proxy cannot be bypassed. With no proxy port nothing is
 *     forwarded at all, which is FR-SH-8's no-network shape.
 *   - bubblewrap mounts the whole filesystem read-only, then binds the
 *     worktree, the granted paths and the per-run scratch writable, then
 *     re-binds the protected paths read-only AFTER them so a grant cannot
 *     reopen them. /run, /tmp and /var/tmp are covered with empty folders,
 *     and for runs that need no login the login files are covered too.
 *   - the seccomp filter (./seccomp.ts) refuses every new Unix socket. A
 *     visible socket file is still a door to an unconfined program (the
 *     session bus runs `systemd-run --user` on request), and hiding folders
 *     alone was beaten in testing by a worktree chosen under /run/user.
 *
 * pasta starts first and bwrap runs inside it: pasta cannot join bwrap's
 * namespaces from outside ("Operation not permitted"). pasta also closes
 * descriptors it does not know, so the filter is opened INSIDE, by a fixed
 * `sh -c` that takes the filter path and the bwrap command line as
 * positional arguments; nothing from the run is ever interpolated into
 * shell text.
 *
 * The run keeps one process group and bwrap is not given its own session,
 * so the runner's group kill reaches everything; bwrap's own process ID
 * namespace ends every process left inside when its first process dies.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveForProfile, SandboxProfileError } from './profile.js'
import type { SandboxProfileSpec } from './profile.js'
import { SUPPORTED_FILTER_ARCHES, unixSocketFilter } from './seccomp.js'

export const BWRAP_PATH = '/usr/bin/bwrap'
export const PASTA_PATH = '/usr/bin/pasta'

/** Folders that hold other programs' sockets and runtime files; covered with empty folders when they exist. */
export const HIDDEN_FOLDERS: readonly string[] = ['/run', '/tmp', '/var/tmp']

/**
 * Login files and folders, relative to the home folder, covered for every
 * run that does not set `exposeLogins`. On Linux these are plain files any
 * process of the operator can read, and a run that may reach github.com
 * could send them there.
 */
export const LOGIN_PATHS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.config/gh',
  '.aws',
  '.docker',
  '.netrc',
  '.git-credentials',
  '.relay/config',
  '.codex/auth.json',
]
/** Each Claude Code config folder (`.claude`, `.claude1`, ...) keeps its login here. */
const CLAUDE_LOGIN_FILE = '.credentials.json'
const CLAUDE_CONFIG_FOLDER = /^\.claude[^/]*$/

/**
 * Why a resolved path cannot be a write grant or a read-only bind here, or
 * undefined when it can. Binding anything under /run, or /tmp or /var/tmp
 * themselves, or a parent of them, puts back the folders the hiding covers.
 */
export function unsafeBindReason(path: string): string | undefined {
  if (path === '/run' || path.startsWith('/run/')) {
    return `"${path}" is under /run, which holds other programs' sockets and is hidden from confined runs.`
  }
  for (const hidden of HIDDEN_FOLDERS) {
    if (path === hidden) return `"${path}" is a shared folder hidden from confined runs; use a folder inside it.`
    if (hidden.startsWith(path === '/' ? '/' : `${path}/`)) {
      return `"${path}" contains ${hidden}, which is hidden from confined runs, so binding it would show it again.`
    }
  }
  return undefined
}

function resolveBind(path: string): string {
  const resolved = resolveForProfile(path)
  const unsafe = unsafeBindReason(resolved)
  if (unsafe !== undefined) throw new SandboxProfileError(unsafe)
  return resolved
}

export type LinuxPathDependencies = {
  readonly home?: string
  readonly pathExists?: (path: string) => boolean
}

/** Mount arguments that cover each existing login path: an empty read-only folder, or /dev/null for a file. */
export function loginCoverArgs(deps: LinuxPathDependencies = {}): string[] {
  const home = deps.home ?? homedir()
  let claudeFolders: string[] = []
  try {
    claudeFolders = readdirSync(home).filter((name) => CLAUDE_CONFIG_FOLDER.test(name))
  } catch {
    // An unreadable home folder has no logins to list.
  }
  const candidates = [...LOGIN_PATHS, ...claudeFolders.map((folder) => join(folder, CLAUDE_LOGIN_FILE))].map((path) =>
    join(home, path),
  )

  const args: string[] = []
  for (const candidate of candidates) {
    // Covered at its resolved location: bwrap mounts on the symlink's target anyway.
    let target: string
    let isDirectory: boolean
    try {
      target = realpathSync(candidate)
      isDirectory = lstatSync(target).isDirectory()
    } catch {
      continue // absent, or a dangling symlink: nothing to read
    }
    if (isDirectory) args.push('--tmpfs', target, '--remount-ro', target)
    else args.push('--ro-bind', '/dev/null', target)
  }
  return args
}

export type LinuxLaunchRequest = {
  readonly spec: SandboxProfileSpec
  /** The filter file, written by the caller with owner-only permissions. */
  readonly filterPath: string
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly bwrapPath?: string
  readonly pastaPath?: string
}

/** The full command line: pasta, the fixed `sh -c` that opens the filter, bwrap, then the run's own command. */
export function buildLinuxLaunch(
  request: LinuxLaunchRequest,
  deps: LinuxPathDependencies = {},
): { readonly command: string; readonly args: readonly string[] } {
  const { spec } = request
  const exists = deps.pathExists ?? existsSync
  const worktree = resolveBind(spec.worktree)
  const writable = [
    worktree,
    ...(spec.writablePaths ?? []).map(resolveBind),
    ...(spec.temporaryDirectory !== undefined ? [resolveBind(spec.temporaryDirectory)] : []),
  ]
  const readOnly = (spec.readOnlyPaths ?? []).map(resolveBind)

  if (spec.proxyPort !== undefined && (!Number.isInteger(spec.proxyPort) || spec.proxyPort < 1 || spec.proxyPort > 65535)) {
    throw new SandboxProfileError(`"${spec.proxyPort}" is not a usable TCP port for the egress proxy.`)
  }

  const bwrap = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    ...HIDDEN_FOLDERS.filter((folder) => exists(folder)).flatMap((folder) => ['--tmpfs', folder]),
    ...writable.flatMap((path) => ['--bind', path, path]),
    // After the grants, so they win over any grant that covers them.
    ...readOnly.flatMap((path) => ['--ro-bind', path, path]),
    ...(spec.exposeLogins === true ? [] : loginCoverArgs(deps)),
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--die-with-parent',
    '--cap-drop', 'ALL',
    '--seccomp', '9',
    '--chdir', request.cwd ?? worktree,
    '--', request.command, ...(request.args ?? []),
  ]

  const port = spec.proxyPort === undefined ? 'none' : String(spec.proxyPort)
  return {
    command: request.pastaPath ?? PASTA_PATH,
    args: [
      '--splice-only', '--quiet', '--foreground',
      // Only the namespace-to-host direction for the proxy port; nothing in, nothing else out.
      '-t', 'none', '-u', 'none', '-T', port, '-U', 'none',
      '--', '/bin/sh', '-c', 'exec 9<"$0" && exec "$@"', request.filterPath,
      request.bwrapPath ?? BWRAP_PATH, ...bwrap,
    ],
  }
}

export type LinuxAvailabilityDependencies = LinuxPathDependencies & {
  readonly arch?: string
  readonly bwrapPath?: string
  readonly pastaPath?: string
  /** Runs the real launch once; returns why it failed, or undefined. Defaults to a cached real probe. */
  readonly probe?: () => string | undefined
}

/** Set once a probe has passed. A failure is not cached, so a transient one (a timeout under load) does not refuse every run until restart. */
let probePassed = false

/**
 * Runs `/bin/true` through the exact launch a real run uses, once per
 * process. A check for the binaries alone would report a sandbox that
 * cannot run where unprivileged namespaces are blocked (Ubuntu's default),
 * or where /run holds the programs themselves (NixOS).
 */
function probeOnce(deps: LinuxAvailabilityDependencies): string | undefined {
  if (probePassed) return undefined
  const directory = mkdtempSync(join(tmpdir(), 'relay-sandbox-probe-'))
  try {
    const filterPath = join(directory, 'filter.bpf')
    // Only reached after linuxSandboxAvailability checked the architecture.
    writeFileSync(filterPath, unixSocketFilter(deps.arch) ?? Buffer.alloc(0))
    chmodSync(filterPath, 0o600)
    const launch = buildLinuxLaunch({
      spec: { worktree: realpathSync(directory) },
      filterPath,
      command: '/bin/true',
      ...(deps.bwrapPath !== undefined ? { bwrapPath: deps.bwrapPath } : {}),
      ...(deps.pastaPath !== undefined ? { pastaPath: deps.pastaPath } : {}),
    })
    const result = spawnSync(launch.command, launch.args as string[], { encoding: 'utf8', timeout: 15_000 })
    if (result.status === 0) {
      probePassed = true
      return undefined
    }
    // stderr is null when the spawn itself failed.
    const stderr = result.stderr?.trim() ?? ''
    const cause = result.error?.message ?? `exit ${result.status ?? result.signal}`
    return `a test run through pasta and bubblewrap failed (${cause}${stderr !== '' ? `; ${stderr}` : ''}), so runs cannot be confined here (FR-SH-7).`
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Whether this Linux machine can confine a run, with the reason when it cannot. */
export function linuxSandboxAvailability(
  deps: LinuxAvailabilityDependencies = {},
): { available: true } | { available: false; reason: string } {
  const exists = deps.pathExists ?? existsSync
  const arch = deps.arch ?? process.arch
  if (unixSocketFilter(arch) === undefined) {
    return {
      available: false,
      reason:
        `the Linux sandbox's socket filter supports ${SUPPORTED_FILTER_ARCHES.join(' and ')}, and this machine is ${arch}, ` +
        'so coding runs are refused here (FR-SH-7).',
    }
  }
  const bwrap = deps.bwrapPath ?? BWRAP_PATH
  if (!exists(bwrap)) {
    return { available: false, reason: `${bwrap} is missing; install bubblewrap (the "bubblewrap" package) to confine coding runs (FR-SH-7).` }
  }
  const pasta = deps.pastaPath ?? PASTA_PATH
  if (!exists(pasta)) {
    return { available: false, reason: `${pasta} is missing; install pasta (the "passt" package) to confine coding runs (FR-SH-7).` }
  }
  const failure = (deps.probe ?? (() => probeOnce(deps)))()
  return failure === undefined ? { available: true } : { available: false, reason: failure }
}
