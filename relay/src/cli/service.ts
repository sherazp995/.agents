/**
 * `relay install-service`: puts a supervisor behind the daemon.
 *
 * THE BUG THIS FIXES, observed in production rather than imagined. The
 * orchestrator's health check deliberately exits non-zero after repeated
 * Slack connectivity failures, with the comment "exiting so a supervisor can
 * restart with a fresh Socket Mode connection". That is a good design: an
 * in-process reconnect is one more thing that can fail silently, and exiting
 * loudly beats running deaf.
 *
 * It assumed a supervisor. There was none. The documented way to start Relay
 * was `nohup ... &`, so the first transient DNS failure exited the process
 * and nothing brought it back. Relay was down for two days, silently,
 * because its own recovery strategy had nothing to recover it.
 *
 * WHY launchd RATHER THAN A RETRY LOOP. The exit path is already correct and
 * well reasoned; the missing piece is genuinely a supervisor, so adding one
 * is a smaller change than rewriting the reasoning. launchd also gives two
 * things a loop cannot: the daemon comes back after a reboot, and it comes
 * back after a crash the process could not have caught.
 *
 * `SuccessfulExit: false` rather than a bare `KeepAlive: true`. A clean stop
 * (Ctrl-C, `relay stop`, a deliberate shutdown) exits zero and STAYS
 * stopped; only a failure exit is restarted. A supervisor that fights the
 * operator when they are trying to stop something is worse than none.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveRelayHome } from '../config/paths.js'
import type { RelayConfig } from '../config/schema.js'
import { relaySecretsHelperPath } from '../secrets/keychain.js'

export const SERVICE_LABEL = 'com.relay.orchestrator'

export type ServiceResult = { readonly report: string; readonly exitCode: number }

export function servicePlistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

/** XML escaping, because a path can legitimately contain `&` and an unescaped one makes the plist unparseable. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type PlistOptions = {
  readonly nodePath: string
  readonly scriptPath: string
  readonly workingDirectory: string
  readonly logPath: string
  readonly relayHome?: string
  /** launchd starts agents with a bare PATH; this one holds the CLIs relay spawns by name. */
  readonly path?: string
}

/** The standard system directories, after the binaries' own, so `git`, `ssh` and `sh` still resolve. */
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** A PATH holding each binary's directory once, in order, then the system directories. */
export function plistPathValue(binaryPaths: readonly string[]): string {
  return [...new Set([...binaryPaths.map((path) => dirname(path)), ...SYSTEM_PATH])].join(':')
}

export function buildPlist(options: PlistOptions): string {
  const variables: Array<[string, string]> = []
  if (options.relayHome !== undefined) variables.push(['RELAY_HOME', options.relayHome])
  if (options.path !== undefined) variables.push(['PATH', options.path])
  const env =
    variables.length === 0
      ? ''
      : `  <key>EnvironmentVariables</key>
  <dict>
${variables.map(([key, value]) => `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>\n`).join('')}  </dict>
`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodePath)}</string>
    <string>${escapeXml(options.scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.logPath)}</string>
${env}</dict>
</plist>
`
}

/** A CLI the daemon spawns. `path` is undefined when it could not be found; a required one stops the install. */
export type ServiceBinary = { readonly name: string; readonly path: string | undefined; readonly required: boolean }

export function findOnPath(name: string, envPath = process.env.PATH ?? '', exists: (path: string) => boolean = existsSync): string | undefined {
  for (const directory of envPath.split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * The CLIs the daemon spawns: claude always (the governed loop spawns it by
 * name), and codex and gh when autonomous tasks are on. Configured paths win
 * over the installer's own PATH.
 */
export function serviceBinaries(
  autonomous: RelayConfig['autonomous'],
  find: (name: string) => string | undefined = (name) => findOnPath(name),
): ServiceBinary[] {
  const enabled = autonomous?.enabled === true
  return [
    { name: 'claude', path: autonomous?.claude_bin ?? find('claude'), required: true },
    { name: 'codex', path: autonomous?.codex_bin ?? find('codex'), required: enabled },
    { name: 'gh', path: find('gh'), required: enabled },
  ]
}

export type ServiceDependencies = {
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly writeFile?: (path: string, contents: string) => void
  readonly makeDirectory?: (path: string) => void
  readonly run?: (file: string, args: readonly string[]) => void
  readonly pathExists?: (path: string) => boolean
  readonly removeFile?: (path: string) => void
}

/**
 * Compiles native/relay-secrets into <RELAY_HOME>/bin and signs it ad hoc.
 * Its signature is what relay's keychain items trust, so a rebuild means
 * running `relay secrets migrate` again. `nodePath` (resolved) is baked in:
 * `get` answers only a parent running that binary, so a node upgrade that
 * moves it means installing again.
 */
export function buildRelaySecretsHelper(
  repoRoot: string,
  relayHome: string,
  nodePath: string,
  run: (file: string, args: readonly string[]) => void,
  makeDirectory: (path: string) => void,
): string {
  const nodeLiteral = `"${nodePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const output = relaySecretsHelperPath(relayHome)
  makeDirectory(dirname(output))
  run('/usr/bin/cc', [
    '-O2',
    '-Wall',
    '-Wno-deprecated-declarations',
    '-framework',
    'Security',
    '-framework',
    'CoreFoundation',
    `-DRELAY_NODE_PATH=${nodeLiteral}`,
    '-o',
    output,
    join(repoRoot, 'native', 'relay-secrets', 'relay-secrets.c'),
  ])
  run('/usr/bin/codesign', ['--force', '--sign', '-', output])
  return output
}

export function runInstallService(
  options: {
    readonly repoRoot: string
    readonly relayHome?: string
    readonly binaries?: readonly ServiceBinary[]
    /** Write and load the agent; without it, only build the helper and stop the agent. */
    readonly start?: boolean
  },
  deps: ServiceDependencies = {},
): ServiceResult {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') {
    return {
      report:
        'A supervisor is only wired for macOS launchd here. On Linux, run the orchestrator under systemd with ' +
        'Restart=on-failure; the daemon exits non-zero on repeated Slack failures precisely so something can ' +
        'restart it.',
      exitCode: 1,
    }
  }

  const home = deps.home ?? homedir()
  const exists = deps.pathExists ?? existsSync
  const write = deps.writeFile ?? ((path: string, contents: string) => writeFileSync(path, contents, 'utf8'))
  const run = deps.run ?? ((file: string, args: readonly string[]) => { execFileSync(file, args as string[], { stdio: 'ignore' }) })
  const makeDirectory = deps.makeDirectory ?? ((path: string) => { mkdirSync(path, { recursive: true }) })
  const remove = deps.removeFile ?? ((path: string) => { rmSync(path, { force: true }) })

  const repoRoot = resolve(options.repoRoot)
  const scriptPath = join(repoRoot, 'dist', 'scripts', 'relay-orchestrator.js')
  if (!exists(scriptPath)) {
    return { report: `There is no build at ${scriptPath}. Run \`pnpm build\` first: a supervisor pointed at a missing script would restart-loop forever.`, exitCode: 1 }
  }

  const binaries = options.binaries ?? []
  const relative = binaries.filter((binary) => binary.path !== undefined && !isAbsolute(binary.path))
  if (relative.length > 0) {
    return {
      report:
        `Not installed: ${relative.map((binary) => `${binary.name} (${binary.path ?? ''})`).join(', ')} must be an ` +
        'absolute path. launchd resolves a relative one against its own working directory, not your shell.',
      exitCode: 1,
    }
  }
  const missing = binaries.filter((binary) => binary.required && (binary.path === undefined || !exists(binary.path)))
  if (missing.length > 0) {
    return {
      report:
        `Not installed: ${missing.map((binary) => `${binary.name} (${binary.path ?? 'not on PATH'})`).join(', ')} ` +
        'could not be found. launchd has no shell PATH, so the daemon needs each one at a known path; install it ' +
        'or set its path in the relay config (autonomous.claude_bin, autonomous.codex_bin).',
      exitCode: 1,
    }
  }
  const found = binaries.flatMap((binary) => (binary.path !== undefined && exists(binary.path) ? [binary.path] : []))

  // Always written to the plist, so the daemon finds the helper and its pid
  // file exactly where this install built them.
  const relayHome = options.relayHome ?? resolveRelayHome({ cwd: repoRoot, pathExists: exists }).path
  const helperPath = relaySecretsHelperPath(relayHome)
  const plistPath = servicePlistPath(home)
  const target = `gui/${process.getuid?.() ?? 501}`
  const bootout = (): void => {
    try {
      run('/bin/launchctl', ['bootout', `${target}/${SERVICE_LABEL}`])
    } catch {
      // Not loaded, which is the normal first-run case.
    }
  }

  // A fresh helper build is not on any keychain item's access list until
  // `relay secrets migrate` recreates them, and a daemon started before
  // that would raise keychain dialogs from launchd. So building stops the
  // agent and removes its plist (RunAtLoad would start it at next login);
  // `--start` writes and loads it once migrate has run.
  if (options.start !== true) {
    try {
      buildRelaySecretsHelper(repoRoot, relayHome, realpathSync(process.execPath), run, makeDirectory)
    } catch (error) {
      return {
        report:
          `Could not build relay-secrets: ${error instanceof Error ? error.message : String(error)}\n` +
          'It needs the Xcode command line tools (`xcode-select --install`).',
        exitCode: 1,
      }
    }
    bootout()
    try {
      remove(plistPath)
    } catch (error) {
      return { report: `Built ${helperPath}, but could not remove ${plistPath}: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
    }
    return {
      report: [
        `Built and signed ${helperPath}. The daemon is stopped and not loaded yet.`,
        '',
        'The keychain trusts this exact helper build, so next run:',
        '  relay secrets migrate',
        '  relay install-service --start',
      ].join('\n'),
      exitCode: 0,
    }
  }

  if (!exists(helperPath)) {
    return { report: `${helperPath} does not exist. Run \`relay install-service\`, then \`relay secrets migrate\`, first.`, exitCode: 1 }
  }

  const logPath = join(repoRoot, 'tmp', 'relay.log')
  const plist = buildPlist({
    nodePath: process.execPath,
    scriptPath,
    workingDirectory: repoRoot,
    logPath,
    relayHome,
    path: plistPathValue([process.execPath, ...found]),
  })

  try {
    makeDirectory(dirname(plistPath))
    makeDirectory(dirname(logPath))
    write(plistPath, plist)
  } catch (error) {
    return { report: `Could not write ${plistPath}: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
  }

  // Unloaded first so re-running this is an update rather than an error.
  bootout()

  try {
    run('/bin/launchctl', ['bootstrap', target, plistPath])
  } catch (error) {
    return {
      report:
        `Wrote ${plistPath}, but launchctl refused to load it: ${error instanceof Error ? error.message : String(error)}\n` +
        `Load it by hand with:\n  launchctl bootstrap ${target} ${plistPath}`,
      exitCode: 1,
    }
  }

  return {
    report: [
      `Installed ${SERVICE_LABEL} as a launchd agent.`,
      '',
      `  plist:  ${plistPath}`,
      `  log:    ${logPath}`,
      `  helper: ${helperPath}`,
      '',
      'It starts at login and restarts on a FAILURE exit, which is what the daemon does after repeated Slack',
      'connectivity failures. A clean stop stays stopped, so this will not fight you when you want it down.',
      '',
      'Stop it:      launchctl bootout ' + target + '/' + SERVICE_LABEL,
      'Remove it:    relay uninstall-service',
    ].join('\n'),
    exitCode: 0,
  }
}

export function runUninstallService(deps: ServiceDependencies = {}): ServiceResult {
  const home = deps.home ?? homedir()
  const run = deps.run ?? ((file: string, args: readonly string[]) => { execFileSync(file, args as string[], { stdio: 'ignore' }) })
  const plistPath = servicePlistPath(home)
  const target = `gui/${process.getuid?.() ?? 501}`

  try {
    run('/bin/launchctl', ['bootout', `${target}/${SERVICE_LABEL}`])
  } catch {
    // Already unloaded.
  }
  try {
    rmSync(plistPath, { force: true })
  } catch (error) {
    return { report: `Unloaded the agent but could not remove ${plistPath}: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
  }

  return { report: `Removed ${SERVICE_LABEL}. Relay will no longer start at login or restart itself.`, exitCode: 0 }
}

/** Whether a supervisor is actually installed, for `relay doctor`. */
export function serviceInstalled(deps: ServiceDependencies = {}): boolean {
  const exists = deps.pathExists ?? existsSync
  return exists(servicePlistPath(deps.home ?? homedir()))
}
