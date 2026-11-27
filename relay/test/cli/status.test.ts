import { describe, expect, it } from 'vitest'
import { lastLogLine, runStatus } from '../../src/cli/status.js'

// Shapes captured from `launchctl print gui/501/<label>` on macOS 26 (2026-11-21): the crash-looping daemon, and a
// running agent's state and pid lines. Nested blocks indent further, so only one-tab lines are the service's own.
const LAUNCHD_CRASHING = [
  'gui/501/com.relay.orchestrator = {',
  '\tactive count = 0',
  '\tpath = /Users/me/Library/LaunchAgents/com.relay.orchestrator.plist',
  '\tstate = spawn scheduled',
  '',
  '\tstdout path = /relay/tmp/relay.log',
  '\tstderr path = /relay/tmp/relay.log',
  '\truns = 188',
  '\tlast exit code = 1',
  '\tendpoints = {',
  '\t\tstate = active',
  '\t}',
  '}',
].join('\n')
const LAUNCHD_RUNNING = LAUNCHD_CRASHING.replace('\tstate = spawn scheduled', '\tstate = running').replace('\truns = 188', '\truns = 1\n\tpid = 32870').replace('\tlast exit code = 1', '\tlast exit code = (never exited)')

const json = (time: number, msg: string) => JSON.stringify({ level: 30, time, msg })
const T = Date.parse('2026-11-20T18:22:59.000Z')

describe('relay status', async () => {
  it.each([
    ['the default laptop', ['failover: this laptop is now the default'], 'answering Slack, the default laptop'],
    ['no longer the default', ['failover: this laptop is now the default', 'failover: this laptop is no longer the default; it keeps answering its own threads'], 'answering Slack, its own threads and messages naming it'],
    ['off Slack without the database', ['failover: the database has not answered for the trust window; leaving Slack until it does'], 'off Slack until the database answers again'],
    ['back on Slack', ['failover: the database has not answered for the trust window; leaving Slack until it does', 'failover: the database answers again; reconnecting to Slack'], 'answering Slack'],
    ['paused for a migration', ['failover: another laptop is migrating the database; starting no new work until it finishes'], 'paused while the other laptop migrates the database'],
  ])('says when the daemon is %s', async (_name, messages, doing) => {
    const tail = ['orchestrator is running: Socket Mode is connected', ...messages].map((message, index) => json(T + index, message)).join('\n')
    const result = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, processStartMs: () => T - 10_000, readTail: () => tail })
    expect(result.report.split('\n')[0]).toBe(`Relay daemon: running (pid 32870, started 1 time), ${doing}`)
  })

  it('reports a running daemon with its pid, that it answers Slack, its last log line and log path, exit 0', async () => {
    const tail = [json(T - 9000, 'failover is on: connecting to Slack'), json(T, 'orchestrator is running: Socket Mode is connected')].join('\n')
    const result = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, processStartMs: () => T - 10_000, readTail: (path) => (path === '/relay/tmp/relay.log' ? tail : null) })
    expect(result).toEqual({
      exitCode: 0,
      report: 'Relay daemon: running (pid 32870, started 1 time), answering Slack\nLast log line: 18:22:59 UTC: orchestrator is running: Socket Mode is connected\nLog: /relay/tmp/relay.log',
    })
  })

  it('says a laptop waiting to migrate is waiting for the other one to pause', async () => {
    const tail = [json(T - 9000, 'orchestrator is running: Socket Mode is connected'), json(T, 'failover: waiting for zubair-mbp to pause and finish its running turns before applying migrations')].join('\n')
    const result = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, processStartMs: () => T - 10_000, readTail: () => tail })
    expect(result.report.split('\n')[0]).toBe('Relay daemon: running (pid 32870, started 1 time), waiting for the other laptop to pause before migrating')
  })

  it('reports a crash-looping daemon as not running with its exit code, start count and the error it died on, exit 1', async () => {
    const tail = `${json(T, 'failover is on: waiting')}\nrelay-orchestrator failed: Connection terminated due to connection timeout\n`
    const result = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_CRASHING, readTail: () => tail })
    expect(result).toEqual({
      exitCode: 1,
      report:
        'Relay daemon: not running (launchd state: spawn scheduled, last exit code 1, started 188 times)\n' +
        'Last log line: relay-orchestrator failed: Connection terminated due to connection timeout\nLog: /relay/tmp/relay.log',
    })
  })

  it('asks launchd for this user and label; no job and no plist is not installed, no job beside a plist is stopped', async () => {
    const calls: string[][] = []
    const reads: string[] = []
    const noJob = (file: string, args: readonly string[]): string => {
      calls.push([file, ...args])
      throw Object.assign(new Error('Command failed: /bin/launchctl print gui/501/com.relay.orchestrator'), {
        status: 113,
        stderr: 'Bad request.\nCould not find service "com.relay.orchestrator" in domain for user gui: 501\n',
      })
    }
    const result = await runStatus({ platform: 'darwin', uid: 501, home: '/Users/me', run: noJob, readFile: (path) => (reads.push(path), null) })
    expect(calls).toEqual([['/bin/launchctl', 'print', 'gui/501/com.relay.orchestrator']])
    expect(reads).toEqual(['/Users/me/Library/LaunchAgents/com.relay.orchestrator.plist'])
    expect(result).toEqual({ exitCode: 1, report: 'Relay daemon: not installed (launchd has no com.relay.orchestrator). Install it with: relay install-service --start' })

    const stopped = await runStatus({ platform: 'darwin', uid: 501, home: '/Users/me', run: noJob, readFile: () => '<plist/>' })
    expect(stopped).toEqual({ exitCode: 1, report: 'Relay daemon: stopped (launchd has not loaded com.relay.orchestrator). Start it with: relay start' })
  })

  it('on Linux reads systemd and the log path from the unit file', async () => {
    const show = 'ActiveState=active\nSubState=running\nMainPID=4242\nExecMainStatus=0\nNRestarts=0\nLoadState=loaded\n'
    const unit = '[Service]\nStandardOutput=append:/home/me/relay/tmp/relay.log\n'
    const result = await runStatus({ platform: 'linux', home: '/home/me', run: () => show, processStartMs: () => T - 10_000, readFile: () => unit, readTail: () => json(T, 'orchestrator is running') })
    expect(result).toEqual({ exitCode: 0, report: 'Relay daemon: running (pid 4242), answering Slack\nLast log line: 18:22:59 UTC: orchestrator is running\nLog: /home/me/relay/tmp/relay.log' })

    const failed = await runStatus({ platform: 'linux', home: '/home/me', run: () => 'ActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainStatus=1\nNRestarts=7\nLoadState=loaded\n', readFile: () => unit, readTail: () => null })
    expect(failed).toEqual({ exitCode: 1, report: 'Relay daemon: not running (systemd: activating/auto-restart, last exit code 1, restarted 7 times)\nLog: /home/me/relay/tmp/relay.log' })

    expect((await runStatus({ platform: 'linux', run: () => 'LoadState=not-found\nActiveState=inactive\n' })).report).toContain('not installed (no relay.service)')
  })

  it('describes a running daemon only by lines of its own run: none yet means no role and no old line', async () => {
    const older = [json(T - 60_000, 'orchestrator is running: Socket Mode is connected'), 'relay-orchestrator failed: boom'].join('\n')
    const result = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, processStartMs: () => T, readTail: () => older })
    expect(result.report).toBe('Relay daemon: running (pid 32870, started 1 time)\nLog: /relay/tmp/relay.log')
  })

  it('shows the last error of this run when a later line hides it, and not an error from an earlier run', async () => {
    const tail = [
      JSON.stringify({ level: 50, time: T - 60_000, err: { message: 'old run error' } }),
      json(T, 'failover is on: waiting until this laptop holds the record before connecting to Slack'),
      JSON.stringify({ level: 40, time: T + 3_000, err: { message: 'Connection terminated due to connection timeout' } }),
      json(T + 9_000, 'failover is on: waiting until this laptop holds the record before connecting to Slack'),
    ].join('\n')
    const result = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, processStartMs: () => T, readTail: () => tail })
    expect(result.report.split('\n').slice(1)).toEqual([
      'Last log line: 18:23:08 UTC: failover is on: waiting until this laptop holds the record before connecting to Slack',
      'Last error since it started: 18:23:02 UTC: Connection terminated due to connection timeout',
      'Log: /relay/tmp/relay.log',
    ])
  })

  it('adds a database line: reachable with the connect time, or not reachable with the error, and still exits by the process', async () => {
    const up = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, processStartMs: () => T, readTail: () => json(T, 'orchestrator is running'), checkDatabase: async () => ({ ok: true, ms: 6_240 }) })
    expect(up.report.split('\n').at(-2)).toBe('Database: reachable (connected in 6.2s)')
    expect(up.exitCode).toBe(0)
    const down = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_CRASHING, readTail: () => null, checkDatabase: async () => ({ ok: false, ms: 10_012, error: 'Connection terminated due to connection timeout\nstack' }) })
    expect(down.report.split('\n').at(-2)).toBe('Database: not reachable after 10.0s (Connection terminated due to connection timeout)')
    expect(down.exitCode).toBe(1)
  })

  it('reports a launchctl failure other than a missing service (a timeout) as unknown, not as not installed', async () => {
    const result = await runStatus({
      platform: 'darwin',
      uid: 501,
      run: () => {
        throw Object.assign(new Error('spawnSync /bin/launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' })
      },
    })
    expect(result).toEqual({ exitCode: 1, report: 'Relay daemon: unknown (launchctl print failed: spawnSync /bin/launchctl ETIMEDOUT)' })
  })

  it('checks the database only after launchctl and ps, so its time is its own', async () => {
    const order: string[] = []
    await runStatus({
      platform: 'darwin',
      uid: 501,
      run: () => (order.push('launchctl'), LAUNCHD_RUNNING),
      processStartMs: () => (order.push('ps'), T),
      readTail: () => null,
      checkDatabase: async () => (order.push('database'), { ok: true, ms: 1 }),
    })
    expect(order).toEqual(['launchctl', 'ps', 'database'])
  })

  it('gives a running daemon no role or log line when its start time cannot be read', async () => {
    const result = await runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, processStartMs: () => null, readTail: () => json(T, 'orchestrator is running') })
    expect(result.report).toBe('Relay daemon: running (pid 32870, started 1 time)\nLog: /relay/tmp/relay.log')
  })

  it('takes an error line message when a JSON log line has no msg, and the last non-empty line only', () => {
    expect(lastLogLine(`${JSON.stringify({ level: 50, time: T, err: { message: 'boom' } })}\n\n`)).toBe('18:22:59 UTC: boom')
    expect(lastLogLine('\n \n')).toBeUndefined()
  })
})
