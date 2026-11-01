import { describe, expect, it, vi } from 'vitest'

import {
  buildPlist,
  buildSystemdUnit,
  escapeXml,
  findOnPath,
  plistPathValue,
  serviceBinaries,
  runInstallService,
  runUninstallService,
  SERVICE_LABEL,
  serviceInstalled,
  servicePlistPath,
  serviceUnitPath,
} from '../../src/cli/service.js'

/**
 * This exists because of a real two-day outage. The orchestrator exits
 * non-zero after repeated Slack connectivity failures, on purpose, with a
 * comment saying a supervisor will restart it. Nothing was supervising it,
 * so one transient DNS failure took Relay down and it stayed down.
 */

describe('the plist expresses the behaviour the outage needed', () => {
  it('restarts on a FAILURE exit but not a clean one', () => {
    // A bare KeepAlive:true fights the operator when they are deliberately
    // stopping the daemon. SuccessfulExit:false restarts only the case the
    // daemon actually produces on a health failure.
    const plist = buildPlist({ nodePath: '/usr/bin/node', scriptPath: '/r/dist/scripts/relay-orchestrator.js', workingDirectory: '/r', logPath: '/r/tmp/relay.log' })

    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('<key>SuccessfulExit</key>')
    expect(plist).toContain('<false/>')
  })

  it('starts at login, so a reboot does not leave Relay down', () => {
    const plist = buildPlist({ nodePath: '/usr/bin/node', scriptPath: '/r/s.js', workingDirectory: '/r', logPath: '/r/tmp/relay.log' })

    expect(plist).toContain('<key>RunAtLoad</key>')
  })

  it('throttles, so a genuinely broken build does not spin', () => {
    expect(buildPlist({ nodePath: '/n', scriptPath: '/s', workingDirectory: '/r', logPath: '/l' })).toContain('ThrottleInterval')
  })

  it('carries RELAY_HOME when the installation is elsewhere', () => {
    const plist = buildPlist({ nodePath: '/n', scriptPath: '/s', workingDirectory: '/r', logPath: '/l', relayHome: '/Users/op/.relay' })

    expect(plist).toContain('RELAY_HOME')
    expect(plist).toContain('/Users/op/.relay')
  })

  it('ESCAPES a path, since an unescaped & makes the plist unparseable', () => {
    // A directory called "R&D" is entirely legal and would silently produce
    // a plist launchd refuses to load.
    expect(escapeXml('/Users/op/R&D/relay')).toBe('/Users/op/R&amp;D/relay')
    expect(buildPlist({ nodePath: '/n', scriptPath: '/a&b/s.js', workingDirectory: '/r', logPath: '/l' })).toContain('/a&amp;b/s.js')
  })
})

describe('installing', () => {
  it('REFUSES when there is no build, rather than creating a restart loop', () => {
    // A supervisor pointed at a missing script restarts forever, which is a
    // worse failure than the one it was installed to fix.
    const run = vi.fn()
    const result = runInstallService({ repoRoot: '/r' }, { platform: 'darwin', pathExists: () => false, run, writeFile: () => {}, makeDirectory: () => {} })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('pnpm build')
    expect(run).not.toHaveBeenCalled()
  })

  it('writes the plist and loads it with --start', () => {
    const written: Array<[string, string]> = []
    const commands: string[][] = []
    const result = runInstallService(
      { repoRoot: '/r', start: true },
      {
        platform: 'darwin',
        home: '/Users/op',
        pathExists: () => true,
        writeFile: (path, contents) => written.push([path, contents]),
        makeDirectory: () => {},
        run: (file, args) => commands.push([file, ...args]),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(written[0]?.[0]).toContain(`${SERVICE_LABEL}.plist`)
    expect(commands.some((command) => command.includes('bootstrap'))).toBe(true)
  })

  it('unloads first, so re-running is an update rather than an error', () => {
    const commands: string[][] = []
    runInstallService(
      { repoRoot: '/r', start: true },
      { platform: 'darwin', home: '/Users/op', pathExists: () => true, writeFile: () => {}, makeDirectory: () => {}, run: (file, args) => commands.push([file, ...args]) },
    )

    const bootout = commands.findIndex((command) => command.includes('bootout'))
    expect(bootout).toBeGreaterThanOrEqual(0)
    expect(bootout).toBeLessThan(commands.findIndex((command) => command.includes('bootstrap')))
  })

  it('builds and signs relay-secrets, then stops the agent and leaves it unloaded until migrate has run', () => {
    // A daemon started on a fresh helper build would raise keychain dialogs
    // from launchd, since no item trusts that build until migrate recreates it.
    const commands: string[][] = []
    const written: string[] = []
    const removed: string[] = []
    const result = runInstallService(
      { repoRoot: '/r', relayHome: '/Users/op/.relay' },
      {
        platform: 'darwin',
        home: '/Users/op',
        pathExists: () => true,
        writeFile: (_path, contents) => written.push(contents),
        removeFile: (path) => removed.push(path),
        makeDirectory: () => {},
        run: (file, args) => commands.push([file, ...args]),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(commands[0]?.[0]).toBe('/usr/bin/cc')
    expect(commands[0]).toEqual(expect.arrayContaining(['-o', '/Users/op/.relay/bin/relay-secrets', '/r/native/relay-secrets/relay-secrets.c']))
    expect(commands[0]?.some((arg) => arg.startsWith('-DRELAY_NODE_PATH="/'))).toBe(true)
    expect(commands[1]).toEqual(['/usr/bin/codesign', '--force', '--sign', '-', '/Users/op/.relay/bin/relay-secrets'])
    expect(commands.some((command) => command.includes('bootout'))).toBe(true)
    expect(commands.some((command) => command.includes('bootstrap'))).toBe(false)
    expect(written).toEqual([])
    expect(removed).toEqual([servicePlistPath('/Users/op')])
    expect(result.report).toContain('relay secrets migrate')
    expect(result.report).toContain('relay install-service --start')
  })

  it('--start loads without rebuilding the helper, and refuses when it was never built', () => {
    const commands: string[][] = []
    const written: string[] = []
    const started = runInstallService(
      { repoRoot: '/r', relayHome: '/Users/op/.relay', start: true },
      { platform: 'darwin', home: '/Users/op', pathExists: () => true, writeFile: (_path, contents) => written.push(contents), makeDirectory: () => {}, run: (file, args) => commands.push([file, ...args]) },
    )
    expect(started.exitCode).toBe(0)
    expect(commands.some((command) => command[0] === '/usr/bin/cc')).toBe(false)
    expect(written[0]).toContain('<string>/Users/op/.relay</string>')

    const refused = runInstallService(
      { repoRoot: '/r', relayHome: '/h', start: true },
      { platform: 'darwin', pathExists: (path) => !path.endsWith('relay-secrets'), writeFile: () => {}, makeDirectory: () => {}, run: () => {} },
    )
    expect(refused.exitCode).toBe(1)
    expect(refused.report).toContain('/h/bin/relay-secrets')
  })

  it('refuses a relative claude or codex path, which launchd would resolve against its own directory', () => {
    const run = vi.fn()
    const result = runInstallService(
      { repoRoot: '/r', relayHome: '/h', binaries: [{ name: 'codex', path: 'bin/codex', required: true }] },
      { platform: 'darwin', pathExists: () => true, run, writeFile: () => {}, makeDirectory: () => {} },
    )
    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('codex (bin/codex) must be an absolute path')
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses, naming it, when the helper cannot be compiled', () => {
    const result = runInstallService(
      { repoRoot: '/r', relayHome: '/h' },
      {
        platform: 'darwin',
        pathExists: () => true,
        writeFile: () => {},
        makeDirectory: () => {},
        removeFile: () => {},
        run: (file) => {
          if (file === '/usr/bin/cc') throw new Error('xcrun: error: invalid active developer path')
        },
      },
    )
    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('relay-secrets')
  })

  it('writes a PATH holding each binary directory, since launchd has no shell PATH', () => {
    const written: string[] = []
    runInstallService(
      {
        repoRoot: '/r',
        relayHome: '/h',
        start: true,
        binaries: [
          { name: 'claude', path: '/Users/op/.local/bin/claude', required: true },
          { name: 'gh', path: '/opt/homebrew/bin/gh', required: false },
        ],
      },
      { platform: 'darwin', home: '/Users/op', pathExists: () => true, writeFile: (_path, contents) => written.push(contents), makeDirectory: () => {}, run: () => {} },
    )

    const path = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(written[0] ?? '')?.[1]
    expect(path?.split(':')).toEqual(expect.arrayContaining(['/Users/op/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']))
  })

  it('REFUSES when a required binary is missing, naming it, before building or loading anything', () => {
    const run = vi.fn()
    const result = runInstallService(
      { repoRoot: '/r', relayHome: '/h', binaries: [{ name: 'codex', path: '/opt/homebrew/bin/codex', required: true }] },
      { platform: 'darwin', pathExists: (path) => !path.endsWith('codex'), run, writeFile: () => {}, makeDirectory: () => {} },
    )

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('codex (/opt/homebrew/bin/codex)')
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a platform with no supervisor wired, rather than pretending to support it', () => {
    const result = runInstallService({ repoRoot: '/r' }, { platform: 'win32' })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('supervisor')
  })
})

describe('installing on Linux as a systemd user unit', () => {
  function installLinux(start: boolean, run: (file: string, args: readonly string[]) => void = () => {}) {
    const written: Array<[string, string]> = []
    const commands: string[][] = []
    const result = runInstallService(
      { repoRoot: '/r', relayHome: '/home/op/.relay', start },
      {
        platform: 'linux',
        home: '/home/op',
        pathExists: () => true,
        writeFile: (path, contents) => written.push([path, contents]),
        makeDirectory: () => {},
        run: (file, args) => {
          commands.push([file, ...args])
          run(file, args)
        },
      },
    )
    return { result, written, commands }
  }

  it('points the daemon at ~/.relay, not at the checkout it runs from, when no RELAY_HOME is set', () => {
    const previous = process.env.RELAY_HOME
    delete process.env.RELAY_HOME
    const written: Array<[string, string]> = []
    try {
      runInstallService(
        { repoRoot: '/checkout' },
        {
          platform: 'linux',
          home: '/home/op',
          // The checkout carries its own development config; the folder the command runs from does not.
          pathExists: (path) => path !== `${process.cwd()}/config/relay.config.yaml`,
          writeFile: (path, contents) => written.push([path, contents]),
          makeDirectory: () => {},
          run: () => {},
        },
      )
    } finally {
      if (previous !== undefined) process.env.RELAY_HOME = previous
    }

    expect(written[0]?.[1]).toContain('Environment="RELAY_HOME=/home/op/.relay"')
  })

  it('writes a unit that restarts on failure and points the daemon at RELAY_HOME, then enables it without building a helper', () => {
    const { result, written, commands } = installLinux(false)

    expect(result.exitCode).toBe(0)
    expect(written.map(([path]) => path)).toEqual(['/home/op/.config/systemd/user/relay.service'])
    const unit = written[0]?.[1] ?? ''
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('WorkingDirectory=/r\n')
    expect(unit).toContain('Environment="RELAY_HOME=/home/op/.relay"')
    expect(unit).toContain('Environment="RELAY_CONFIG_PATH=/home/op/.relay/config/relay.config.yaml"')
    expect(unit).toContain('Environment="RELAY_POLICY_PATH=/home/op/.relay/config/policy.yaml"')
    expect(unit).toContain('WantedBy=default.target')
    expect(commands).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'relay.service'],
    ])
    expect(result.report).toContain('next login')
    expect(result.report).toContain('systemctl --user stop relay')
    expect(result.report).toContain('keyring')
  })

  it('--start also restarts it, so a new build is picked up', () => {
    const { result, commands } = installLinux(true)

    expect(result.exitCode).toBe(0)
    expect(commands.at(-1)).toEqual(['systemctl', '--user', 'restart', 'relay.service'])
  })

  it('names the unit and the commands still to run when systemctl fails', () => {
    const { result } = installLinux(true, (_file, args) => {
      if (args.includes('enable')) throw new Error('Failed to connect to bus')
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('/home/op/.config/systemd/user/relay.service')
    expect(result.report).toContain('  systemctl --user enable relay.service\n  systemctl --user restart relay.service')
  })

  it('keeps a value with spaces one word and escapes what systemd would expand', () => {
    const unit = buildSystemdUnit({ nodePath: '/opt/my node/node', scriptPath: '/r/$s%.js', workingDirectory: '/r', logPath: '/l', relayHome: '/h', path: '/a b:/usr/bin' })

    expect(unit).toContain('ExecStart="/opt/my node/node" "/r/$$s%%.js"')
    expect(unit).toContain('Environment="PATH=/a b:/usr/bin"')
    expect(() => buildSystemdUnit({ nodePath: '/n', scriptPath: '/s', workingDirectory: '/r\nExecStartPre=/x', logPath: '/l', relayHome: '/h', path: '/p' })).toThrow(/newline/)
  })
})

describe('uninstalling and detection', () => {
  it('unloads and removes', () => {
    const commands: string[][] = []
    const result = runUninstallService({ platform: 'darwin', home: '/Users/op', run: (file, args) => commands.push([file, ...args]) })

    expect(result.exitCode).toBe(0)
    expect(commands[0]).toContain('bootout')
  })

  it('on Linux disables and removes the unit, even when systemctl has no session', () => {
    const commands: string[][] = []
    const removed: string[] = []
    const result = runUninstallService({
      platform: 'linux',
      home: '/home/op',
      removeFile: (path) => removed.push(path),
      run: (file, args) => {
        commands.push([file, ...args])
        throw new Error('Failed to connect to bus')
      },
    })

    expect(result.exitCode).toBe(0)
    expect(commands).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'relay.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ])
    expect(removed).toEqual([serviceUnitPath('/home/op')])
    expect(serviceInstalled({ platform: 'linux', home: '/home/op', pathExists: (path) => path === serviceUnitPath('/home/op') })).toBe(true)
  })

  it('reports whether a supervisor is installed, which is what doctor asks', () => {
    expect(serviceInstalled({ home: '/Users/op', pathExists: () => true })).toBe(true)
    expect(serviceInstalled({ home: '/Users/op', pathExists: () => false })).toBe(false)
  })

  it('puts the plist where launchd looks for a user agent', () => {
    expect(servicePlistPath('/Users/op')).toBe(`/Users/op/Library/LaunchAgents/${SERVICE_LABEL}.plist`)
  })
})

describe('the daemon PATH', () => {
  it('lists each directory once, binaries first, then the system directories', () => {
    expect(plistPathValue(['/opt/homebrew/bin/node', '/opt/homebrew/bin/gh', '/Users/op/.local/bin/claude'])).toBe(
      '/opt/homebrew/bin:/Users/op/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    )
  })

  it('requires claude always and gh only when autonomous tasks are on; codex never', () => {
    const find = (name: string) => (name === 'gh' ? '/opt/homebrew/bin/gh' : undefined)
    expect(serviceBinaries(undefined, find)).toEqual([
      { name: 'claude', path: undefined, required: true },
      { name: 'codex', path: undefined, required: false },
      { name: 'gh', path: '/opt/homebrew/bin/gh', required: false },
    ])
    const autonomous = { enabled: true, claude_bin: '/c/claude', codex_bin: '/x/codex' } as Parameters<typeof serviceBinaries>[0]
    expect(serviceBinaries(autonomous, find).map((binary) => [binary.path, binary.required])).toEqual([
      ['/c/claude', true],
      ['/x/codex', false],
      ['/opt/homebrew/bin/gh', true],
    ])
  })

  it('finds a binary on the installer\'s own PATH', () => {
    expect(findOnPath('gh', '/a:/b', (path) => path === '/b/gh')).toBe('/b/gh')
    expect(findOnPath('gh', '/a', () => false)).toBeUndefined()
  })
})
