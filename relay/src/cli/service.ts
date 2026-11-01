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
 *
 * ON LINUX the same supervisor is a systemd user unit with
 * `Restart=on-failure`, which has the same clean-stop-stays-stopped meaning.
 * A user unit, not a system one, because the daemon reads its secrets from
 * the login keyring, which only unlocks when the operator logs in. There is
 * no relay-secrets helper to build there: that helper exists for the macOS
 * keychain's per-program access list, and libsecret has no such list.
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

/** The systemd user unit's name; `systemctl --user stop relay` finds it by this. */
export const SYSTEMD_UNIT = 'relay.service'

export function servicePlistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

export function serviceUnitPath(home = homedir()): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
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

export type SystemdUnitOptions = {
  readonly nodePath: string
  readonly scriptPath: string
  readonly workingDirectory: string
  readonly logPath: string
  readonly relayHome: string
  /** systemd starts user units with its own short PATH; this one holds the CLIs relay spawns by name. */
  readonly path: string
}

/**
 * One value made safe for a unit file. A newline would end the directive
 * and start another, so it is refused rather than escaped. `%` starts a
 * specifier in every directive, so it is doubled.
 */
function systemdValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`a systemd unit value cannot hold a newline: ${JSON.stringify(value)}`)
  return value.replace(/%/g, '%%')
}

/** A double quoted word, so a value with spaces stays one word; backslash and quote are C style escaped. */
function systemdQuoted(value: string): string {
  return `"${systemdValue(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** ExecStart also expands `$NAME`, so a literal `$` is doubled there. */
function systemdCommandWord(value: string): string {
  return systemdQuoted(value.replace(/\$/g, '$$$$'))
}

/**
 * RELAY_CONFIG_PATH and RELAY_POLICY_PATH are set because the daemon reads
 * them, and otherwise resolves both against its working directory.
 */
export function buildSystemdUnit(options: SystemdUnitOptions): string {
  const environment: Array<[string, string]> = [
    ['RELAY_HOME', options.relayHome],
    ['RELAY_CONFIG_PATH', join(options.relayHome, 'config', 'relay.config.yaml')],
    ['RELAY_POLICY_PATH', join(options.relayHome, 'config', 'policy.yaml')],
    ['PATH', options.path],
  ]
  return `[Unit]
Description=Relay orchestrator
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdValue(options.workingDirectory)}
${environment.map(([key, value]) => `Environment=${systemdQuoted(`${key}=${value}`)}\n`).join('')}ExecStart=${systemdCommandWord(options.nodePath)} ${systemdCommandWord(options.scriptPath)}
Restart=on-failure
RestartSec=10
StandardOutput=append:${systemdValue(options.logPath)}
StandardError=append:${systemdValue(options.logPath)}

[Install]
WantedBy=default.target
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
 * name), and gh when autonomous tasks are on. Codex is optional: when it is
 * missing every chat runs on a claude account (src/autonomous/accounts.ts),
 * so it is added to the PATH when found and never stops the install.
 * Configured paths win over the installer's own PATH.
 */
export function serviceBinaries(
  autonomous: RelayConfig['autonomous'],
  find: (name: string) => string | undefined = (name) => findOnPath(name),
): ServiceBinary[] {
  const enabled = autonomous?.enabled === true
  return [
    { name: 'claude', path: autonomous?.claude_bin ?? find('claude'), required: true },
    { name: 'codex', path: autonomous?.codex_bin ?? find('codex'), required: false },
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
  if (platform !== 'darwin' && platform !== 'linux') {
    return {
      report:
        'A supervisor is only wired for macOS launchd and Linux systemd here. Run the orchestrator under a ' +
        'supervisor that restarts it on a failure exit; the daemon exits non-zero on repeated Slack failures ' +
        'precisely so something can restart it.',
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
        'absolute path. The supervisor resolves a relative one against its own working directory, not your shell.',
      exitCode: 1,
    }
  }
  const missing = binaries.filter((binary) => binary.required && (binary.path === undefined || !exists(binary.path)))
  if (missing.length > 0) {
    return {
      report:
        `Not installed: ${missing.map((binary) => `${binary.name} (${binary.path ?? 'not on PATH'})`).join(', ')} ` +
        'could not be found. The supervisor has no shell PATH, so the daemon needs each one at a known path; install it ' +
        'or set its path in the relay config (autonomous.claude_bin, autonomous.codex_bin).',
      exitCode: 1,
    }
  }
  const found = binaries.flatMap((binary) => (binary.path !== undefined && exists(binary.path) ? [binary.path] : []))

  // Always written to the service, so the daemon finds its config, helper and
  // pid file exactly where this install did. Resolved from where the command
  // runs, as every other relay command does, never from repoRoot: a checkout
  // carries its own development config, which would shadow ~/.relay.
  const relayHome = options.relayHome ?? resolveRelayHome({ home, pathExists: exists }).path
  if (platform === 'linux') {
    return installSystemdService({ repoRoot, scriptPath, relayHome, found, start: options.start === true, home, write, run, makeDirectory })
  }
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

function installSystemdService(input: {
  readonly repoRoot: string
  readonly scriptPath: string
  readonly relayHome: string
  readonly found: readonly string[]
  readonly start: boolean
  readonly home: string
  readonly write: (path: string, contents: string) => void
  readonly run: (file: string, args: readonly string[]) => void
  readonly makeDirectory: (path: string) => void
}): ServiceResult {
  const unitPath = serviceUnitPath(input.home)
  const logPath = join(input.repoRoot, 'tmp', 'relay.log')
  let unit: string
  try {
    unit = buildSystemdUnit({
      nodePath: process.execPath,
      scriptPath: input.scriptPath,
      workingDirectory: input.repoRoot,
      logPath,
      relayHome: input.relayHome,
      path: plistPathValue([process.execPath, ...input.found]),
    })
    input.makeDirectory(dirname(unitPath))
    input.makeDirectory(dirname(logPath))
    input.write(unitPath, unit)
  } catch (error) {
    return { report: `Could not write ${unitPath}: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
  }

  // restart rather than start, so re-running with --start picks up a new build.
  const commands: string[][] = [['daemon-reload'], ['enable', SYSTEMD_UNIT], ...(input.start ? [['restart', SYSTEMD_UNIT]] : [])]
  for (const [index, args] of commands.entries()) {
    try {
      input.run('systemctl', ['--user', ...args])
    } catch (error) {
      return {
        report:
          `Wrote ${unitPath}, but \`systemctl --user ${args.join(' ')}\` failed: ${error instanceof Error ? error.message : String(error)}\n` +
          'There may be no systemd user session (a login over plain su or sudo has none). From a login session, run:\n' +
          commands.slice(index).map((rest) => `  systemctl --user ${rest.join(' ')}`).join('\n'),
        exitCode: 1,
      }
    }
  }

  return {
    report: [
      input.start
        ? `Installed and started ${SYSTEMD_UNIT} as a systemd user unit.`
        : `Installed and enabled ${SYSTEMD_UNIT} as a systemd user unit. It starts at your next login; start it now with \`relay install-service --start\`.`,
      '',
      `  unit:  ${unitPath}`,
      `  log:   ${logPath}`,
      '',
      'It restarts on a FAILURE exit, which is what the daemon does after repeated Slack connectivity failures.',
      'A clean stop stays stopped, so this will not fight you when you want it down.',
      'It starts at login, not at boot: the daemon reads its secrets from the login keyring, which must be unlocked.',
      '',
      `Stop it:      systemctl --user stop relay`,
      'Remove it:    relay uninstall-service',
    ].join('\n'),
    exitCode: 0,
  }
}

export function runUninstallService(deps: ServiceDependencies = {}): ServiceResult {
  const home = deps.home ?? homedir()
  const run = deps.run ?? ((file: string, args: readonly string[]) => { execFileSync(file, args as string[], { stdio: 'ignore' }) })
  if ((deps.platform ?? process.platform) === 'linux') {
    const remove = deps.removeFile ?? ((path: string) => { rmSync(path, { force: true }) })
    const unitPath = serviceUnitPath(home)
    try {
      run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
    } catch {
      // Not enabled, or no user session; the unit file is still removed.
    }
    try {
      remove(unitPath)
    } catch (error) {
      return { report: `Stopped the unit but could not remove ${unitPath}: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
    }
    try {
      run('systemctl', ['--user', 'daemon-reload'])
    } catch {
      // systemd forgets the removed unit at the next reload anyway.
    }
    return { report: `Removed ${SYSTEMD_UNIT}. Relay will no longer start at login or restart itself.`, exitCode: 0 }
  }
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
  const home = deps.home ?? homedir()
  return exists((deps.platform ?? process.platform) === 'linux' ? serviceUnitPath(home) : servicePlistPath(home))
}
