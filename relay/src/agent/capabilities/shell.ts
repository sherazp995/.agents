/**
 * FR-SH-1: `shell` runs a command with an explicit working directory, an
 * environment allowlist, a timeout, an output size cap, and no interactive
 * TTY. Commands are checked against an allowlist of permitted binaries and a
 * denylist of patterns, and a denylisted command is refused with an
 * explanation BEFORE execution.
 *
 * THIS IS ALSO THE SANDBOX'S FIRST CALLER. FR-SH-6 requires OS-level
 * confinement on every coding run, and confinement with no caller is not a
 * feature: this project has shipped complete, tested, uncalled modules
 * before and mistaken them for working. Every execution here goes through
 * `runSandboxed`, and when confinement is unavailable the call is REFUSED
 * rather than run unconfined, which is FR-SH-7's fail-closed rule.
 *
 * NO SHELL STRING, EVER. The input is a binary plus an argument array, not a
 * command line. FR-SH-1's denylist names `curl | sh`, and a pattern matcher
 * over a shell string is a losing game: `curl|sh`, `curl  |sh`,
 * `c$'u'rl | sh`, and a hundred other spellings all mean the same thing.
 * Taking an argv instead makes pipes, redirects, command substitution and
 * chaining structurally impossible rather than merely matched against. The
 * denylist below then covers what remains, which is dangerous BINARIES and
 * dangerous ARGUMENTS, both of which survive argv form.
 *
 * The allowlist is the primary control and the denylist is defence in depth.
 * An allowlist alone would let `git` run `git config --global core.pager` to
 * something awful; a denylist alone would be a guessing game about what
 * exists on the machine.
 */

import { z } from 'zod'

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { loadPolicy } from '../../config/load.js'
import { defaultPolicyPath, resolveRelayHome } from '../../config/paths.js'
import { runSandboxed, sandboxAvailability } from '../../sandbox/exec.js'
import { startEgressProxy } from '../../sandbox/proxy.js'
import type { Capability } from '../loop.js'
import type { CapabilityDefinition } from '../../capabilities/registry.js'

export const SHELL_CAPABILITY_NAME = 'shell'

/** FR-SH-1's output size cap. Enough for a real test run's tail, small enough that one command cannot fill a context window. */
export const MAX_SHELL_OUTPUT_CHARACTERS = 20_000

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 120
export const MAX_SHELL_TIMEOUT_SECONDS = 900

/**
 * Binaries a coding run may execute.
 *
 * Deliberately a list of DEVELOPMENT tools. It is not "everything harmless":
 * a capability that can run any binary the machine has is a capability whose
 * blast radius is the machine, and the sandbox confines writes and network
 * but does not stop a run reading whatever it likes.
 */
export const DEFAULT_ALLOWED_BINARIES: readonly string[] = [
  // Inspection
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg', 'file', 'stat', 'du', 'diff', 'sort', 'uniq', 'echo', 'pwd',
  // Source control. Note that a push still cannot happen: the sandbox denies
  // the network, and the proxy would have to declare the remote.
  'git',
  // Toolchains
  'node', 'npm', 'pnpm', 'yarn', 'npx', 'tsc', 'python3', 'pip3', 'ruby', 'bundle', 'rake',
  'cargo', 'rustc', 'go', 'make', 'java', 'mvn', 'gradle', 'swift', 'dotnet', 'php', 'composer',
  // Test runners commonly invoked directly
  'jest', 'vitest', 'pytest', 'rspec',
]

/**
 * Binaries that are refused no matter what the allowlist says.
 *
 * Each is here because it either escalates privilege, reconfigures the
 * machine, or writes below the filesystem layer the sandbox operates at. A
 * raw disk write is not stopped by a profile that confines file writes.
 */
const GENERIC_DENIAL =
  'it either escalates privilege, reconfigures the machine, or writes below the layer the sandbox confines'

/**
 * Binaries refused no matter what the allowlist says, each with the reason
 * it is here.
 *
 * A map rather than a list because the reasons genuinely differ, and this is
 * checked BEFORE the allowlist so the specific reason is the one the
 * operator sees. When `rm` was merely absent from the allowlist, its useful
 * explanation was dead code and the refusal said only "not permitted",
 * which teaches nobody where deletion actually belongs.
 */
export const DENIED_BINARIES: Readonly<Record<string, string>> = {
  sudo: GENERIC_DENIAL, su: GENERIC_DENIAL, doas: GENERIC_DENIAL, login: GENERIC_DENIAL,
  launchctl: GENERIC_DENIAL, systemctl: GENERIC_DENIAL, service: GENERIC_DENIAL,
  diskutil: GENERIC_DENIAL, fdisk: GENERIC_DENIAL, newfs: GENERIC_DENIAL, mkfs: GENERIC_DENIAL,
  hdiutil: GENERIC_DENIAL, asr: GENERIC_DENIAL,
  csrutil: GENERIC_DENIAL, spctl: GENERIC_DENIAL, nvram: GENERIC_DENIAL, kextload: GENERIC_DENIAL, kmutil: GENERIC_DENIAL,
  shutdown: GENERIC_DENIAL, halt: GENERIC_DENIAL, reboot: GENERIC_DENIAL,
  chown: GENERIC_DENIAL, chmod: GENERIC_DENIAL,
  dd: 'it writes at the block level, which a profile confining FILE writes does not stop',
  security: 'it reads the Keychain, and Relay never brokers a secret into a command a model composed',
  defaults: GENERIC_DENIAL,
  // Deletion has a capability of its own, and this reason is the whole point
  // of naming rm here rather than merely leaving it off the allowlist.
  rm: 'deleting files belongs to the filesystem capability, which previews the change and moves files to a recoverable trash directory (FR-SH-3, FR-SH-4), rather than to an unrecoverable shell call',
  rmdir: 'removing directories belongs to the filesystem capability, which previews the change and keeps it recoverable (FR-SH-3, FR-SH-4)',
  // Shells, because accepting one reintroduces exactly the command-line
  // parsing this capability's argv-only design exists to avoid.
  sh: 'a shell reintroduces the command line, and with it pipes, redirects and chaining, which this capability makes structurally impossible by taking an argument list instead',
  bash: 'a shell reintroduces the command line, and with it pipes, redirects and chaining, which this capability makes structurally impossible by taking an argument list instead',
  zsh: 'a shell reintroduces the command line, and with it pipes, redirects and chaining, which this capability makes structurally impossible by taking an argument list instead',
  fish: 'a shell reintroduces the command line', dash: 'a shell reintroduces the command line',
  ksh: 'a shell reintroduces the command line', csh: 'a shell reintroduces the command line',
  tcsh: 'a shell reintroduces the command line',
  osascript: 'it drives other applications through AppleScript, which is a capability of its own with its own approval path, not a shell call',
}

export type ShellRefusal = { readonly reason: string }

/** The binary's own name, without any directory part, lower-cased. A denylist keyed on `sudo` must also refuse `/usr/bin/sudo`. */
export function binaryName(command: string): string {
  const trimmed = command.trim()
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1)).toLowerCase()
}

/**
 * Why a command is refused, or `undefined` if it is permitted.
 *
 * Returns the REASON rather than a boolean because FR-SH-1's acceptance
 * criterion is that the refusal carries an explanation. A bare "not
 * allowed" teaches nobody which part was the problem, and the operator ends
 * up widening the allowlist blindly.
 */
export function shellRefusalReason(
  command: string,
  args: readonly string[],
  allowedBinaries: readonly string[] = DEFAULT_ALLOWED_BINARIES,
): string | undefined {
  const name = binaryName(command)

  if (name === '') return 'no command was given.'

  // Checked BEFORE the allowlist, so the specific reason wins over a
  // generic "not permitted".
  const denial = DENIED_BINARIES[name]
  if (denial !== undefined) {
    return `"${name}" is refused for any task (FR-SH-1): ${denial}. The allowlist cannot override this.`
  }

  if (!allowedBinaries.includes(name)) {
    return (
      `"${name}" is not in the permitted binary list, so it was refused before it ran (FR-SH-1). Permitted: ` +
      `${allowedBinaries.join(', ')}.`
    )
  }

  const argumentReason = deniedArgumentReason(name, args)
  if (argumentReason !== undefined) return argumentReason

  return undefined
}

/**
 * Arguments that make an otherwise-permitted binary dangerous.
 *
 * Kept separate from the binary check because the reasons differ per
 * binary, and a single flat pattern list over the whole command line was
 * how the shell-string version of this went wrong.
 */
export function deniedArgumentReason(name: string, args: readonly string[]): string | undefined {
  const joined = args.join(' ')

  // An interpreter handed inline program text is a shell. `node -e`,
  // `python3 -c`, `ruby -e` all execute arbitrary source, which would walk
  // straight around the argv-only design.
  if (['node', 'python3', 'ruby', 'php'].includes(name)) {
    const inlineFlags = ['-e', '-c', '--eval', '--command']
    const found = args.find((argument) => inlineFlags.includes(argument))
    if (found !== undefined) {
      return (
        `\`${name} ${found}\` executes program text supplied inline, which is a shell by another name and would ` +
        'bypass the argument-list design that makes pipes and chaining impossible here. Put the code in a file ' +
        'inside the worktree and run that instead.'
      )
    }
  }

  // A run cannot reach the network except through the declared destination
  // list, so a git remote operation would fail at the proxy anyway. Refusing
  // it here means the operator gets a reason rather than a network error,
  // and it keeps FR-CODE-22's "no direct git remote operations" true at the
  // capability layer as well as at the OS layer.
  if (name === 'git') {
    const remoteSubcommands = ['push', 'pull', 'fetch', 'clone', 'remote']
    const subcommand = args.find((argument) => !argument.startsWith('-'))
    if (subcommand !== undefined && remoteSubcommands.includes(subcommand)) {
      return (
        `\`git ${subcommand}\` talks to a remote. Remote operations go through Relay's reviewed publish gate ` +
        '(FR-CODE-47a), not through a shell call, and the sandbox would deny the network for this one regardless.'
      )
    }
  }

  // Package managers installing GLOBALLY reach outside the worktree by
  // design. A project-local install is fine and is how a build works.
  if (['npm', 'pnpm', 'yarn', 'pip3', 'gem', 'composer'].includes(name)) {
    if (args.some((argument) => ['-g', '--global', '--location=global'].includes(argument))) {
      return `a global install with \`${name}\` writes outside the worktree, which the sandbox denies anyway. Install into the project instead.`
    }
  }

  // A null byte truncates a C string, so an argument carrying one can mean
  // one thing to the checks above and another to the kernel.
  if (joined.includes('\0')) return 'the arguments contain a null byte, which no legitimate command needs.'

  return undefined
}

export const shellInputSchema = z
  .object({
    command: z.string().trim().min(1, 'a command is required'),
    args: z.array(z.string()).default([]),
    /** FR-SH-1's explicit working directory. Also the sandbox worktree: the one place this call may write. */
    working_directory: z.string().trim().min(1, 'an explicit working directory is required'),
    timeout_seconds: z.number().int().positive().max(MAX_SHELL_TIMEOUT_SECONDS).optional(),
  })
  .strict()

export type ShellInput = z.infer<typeof shellInputSchema>

export type ShellOutput = {
  readonly ok: boolean
  readonly refused?: string
  readonly exit_code?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly timed_out?: boolean
  readonly truncated?: boolean
  /** FR-SH-6 requires the effective rules be recorded, so a denial can be read afterwards rather than guessed at. */
  readonly sandbox?: Record<string, unknown>
}

/** Applies FR-SH-1's output cap, keeping the TAIL, which is where a failing build says why. */
export function capOutput(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_SHELL_OUTPUT_CHARACTERS) return { text: value, truncated: false }
  return {
    text: `[… ${value.length - MAX_SHELL_OUTPUT_CHARACTERS} characters trimmed from the start …]\n${value.slice(-MAX_SHELL_OUTPUT_CHARACTERS)}`,
    truncated: true,
  }
}

export const shell: Capability = async (rawInput: unknown, signal?: AbortSignal): Promise<ShellOutput> => {
  const parsed = shellInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, refused: `the shell call's input was not valid: ${parsed.error.issues[0]?.message ?? 'unknown error'}` }
  }
  const input = parsed.data

  // Refused BEFORE execution, which is FR-SH-1's acceptance criterion.
  const refusal = shellRefusalReason(input.command, input.args)
  if (refusal !== undefined) return { ok: false, refused: refusal }

  // FR-SH-7: no unconfined fallback. A machine that cannot confine does not
  // get to run the command anyway.
  const availability = sandboxAvailability()
  if (!availability.available) return { ok: false, refused: availability.reason }

  // The working directory becomes the ONE path this run may write to, so it
  // cannot be taken on trust from a model that read an attacker-controlled
  // page. It must exist and be a directory, and it must not be a path whose
  // contents Relay's own guarantees depend on.
  const checked = validateWorktree(input.working_directory)
  if (!checked.ok) return { ok: false, refused: checked.reason }
  const worktree = checked.path

  // FR-SH-6's enforcing proxy. The sandbox denies direct egress at the
  // kernel, so this is the ONLY route out, and it terminates anything not on
  // the declared destination list while recording every attempt.
  //
  // The list comes from POLICY, never from the call. A model choosing the
  // hosts its own command may reach is not a destination list, it is a
  // formality.
  const proxy = await startEgressProxy({ allowedHosts: policyAllowedHosts() })

  try {
    const result = await runSandboxed({
      spec: {
        worktree,
        proxyPort: proxy.port,
        // The operator's own checkout stays read-only even though nothing
        // above grants it, so a worktree that overlaps it cannot become a
        // write path (FR-SH-6, FR-CFG-4).
        readOnlyPaths: protectedPaths(),
      },
      command: input.command,
      args: input.args,
      cwd: worktree,
      // FR-SH-1's environment allowlist: the child gets only what a toolchain
      // genuinely needs, so an inherited token cannot travel into a command
      // whose output the model then reads.
      env: buildShellEnv(),
      timeoutMs: (input.timeout_seconds ?? DEFAULT_SHELL_TIMEOUT_SECONDS) * 1000,
      ...(signal !== undefined ? { signal } : {}),
    })

    if (result.outcome === 'unavailable') return { ok: false, refused: result.reason }

    const stdout = capOutput(result.stdout)
    const stderr = capOutput(result.stderr)

    // Every refused destination, named. FR-SH-6 requires the denial to appear
    // in the run record, and a blocked host that shows up only as a failed
    // build is indistinguishable from a network that happened to be down.
    const blocked = proxy.attempts.filter((attempt) => !attempt.allowed)

    return {
      ok: result.exitCode === 0 && !result.timedOut,
      exit_code: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timed_out: result.timedOut,
      truncated: stdout.truncated || stderr.truncated,
      sandbox: {
        ...result.rules,
        egress_attempts: proxy.attempts.length,
        blocked_destinations: [...new Set(blocked.map((attempt) => attempt.host))],
      },
    }
  } finally {
    await proxy.close()
  }
}

/**
 * Paths that stay read-only whatever the working directory is.
 *
 * Relay's own installation is the one that matters: a run that could edit
 * the policy file, the profile registry or Relay's compiled code could widen
 * every other boundary in this system from inside the sandbox, which would
 * make the rest of the confinement decorative.
 */
export function protectedPaths(home = resolveRelayHome().path): readonly string[] {
  return [home]
}

/**
 * Checks the working directory before it becomes the run's write grant.
 *
 * Returns the resolved path, or a REFUSAL STRING explaining the problem. The
 * value arrives from a model that may have been reading an
 * attacker-controlled page, and it is the single thing deciding what this
 * run may write to, so "it was in the input" is not enough to act on.
 */
export type WorktreeCheck = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }

export function validateWorktree(
  candidate: string,
  deps: { readonly stat?: (path: string) => { isDirectory(): boolean }; readonly home?: string } = {},
): WorktreeCheck {
  const stat = deps.stat ?? statSync
  const resolved = resolve(candidate)

  let entry: { isDirectory(): boolean }
  try {
    entry = stat(resolved)
  } catch {
    return {
      ok: false,
      reason: `the working directory "${resolved}" does not exist, so there is nothing to run in and nothing to confine the run to.`,
    }
  }
  if (!entry.isDirectory()) return { ok: false, reason: `"${resolved}" is not a directory, so it cannot be a working directory.` }

  // The filesystem root, or a home directory, as the write grant would make
  // confinement meaningless while still technically confining something.
  const home = deps.home ?? homedir()
  if (resolved === '/' || resolved === home) {
    return {
      ok: false,
      reason:
        `"${resolved}" is too broad to be a working directory: granting write access to it would make the sandbox's ` +
        'worktree confinement meaningless. Name the specific project directory instead.',
    }
  }

  return { ok: true, path: resolved }
}

/**
 * The destination list the proxy enforces, from policy.
 *
 * Empty when policy declares no `origins.allow`, and empty means the proxy
 * refuses everything, which is the correct default: a run's network reach
 * should be something an operator granted, not something it inherited. The
 * proxy still runs in that case rather than being skipped, because its other
 * job is recording what was attempted.
 */
export function policyAllowedHosts(policyPath: string = defaultPolicyPath()): readonly string[] {
  try {
    return loadPolicy(policyPath).origins?.allow ?? []
  } catch {
    // A policy that cannot be read is not permission to reach anything.
    return []
  }
}

/**
 * FR-SH-1's environment allowlist.
 *
 * An inherited environment carries whatever the operator has exported,
 * which routinely includes API tokens. A command's output is read by the
 * model, so an environment dump reaching stdout is a straight path from the
 * operator's shell profile into a prompt.
 */
export function buildShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'SHELL', 'USER', 'LOGNAME']
  const env: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  // Signals non-interactivity to tools that check, which is FR-SH-1's "no
  // interactive TTY" in the form most build tools actually read.
  env.CI = '1'
  env.TERM = env.TERM ?? 'dumb'
  return env
}

export const SHELL_CAPABILITY_DEFINITION: CapabilityDefinition = {
  name: SHELL_CAPABILITY_NAME,
  description:
    'Runs a single development command inside an OS-confined sandbox: it may write only inside the working ' +
    'directory you name, and it has no network access except through Relay\'s declared destination list. Takes a ' +
    'binary and an argument list, never a shell command line, so pipes, redirects and chaining are not available. ' +
    'Dangerous binaries and remote git operations are refused before they run, with a reason.',
  inputSchema: shellInputSchema,
  outputSchema: z.unknown(),
  // `write`, not `read`: it can modify the worktree. Not `irreversible`,
  // because deletion is refused and routed to the filesystem capability's
  // preview-and-trash path instead.
  riskTier: 'write',
  idempotencyClass: 'mutating',
  requiredRunnerFeatures: [],
  costHint: 'free',
  // The sandbox is headless and touches nothing on the operator's screen,
  // so it does not contend for the machine the way a GUI action does.
  requiresMachineLock: false,
  // Objects, not JSON strings: the registry validates every example against
  // inputSchema at registration, so a wrong example fails the build rather
  // than teaching the model a shape that will be rejected at run time.
  inputExamples: [
    { command: 'git', args: ['status', '--short'], working_directory: '/path/to/repo' },
    { command: 'pnpm', args: ['test'], working_directory: '/path/to/repo', timeout_seconds: 300 },
  ],
  run: shell,
}
