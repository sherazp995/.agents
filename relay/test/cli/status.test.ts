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

describe('relay status', () => {
  it('reports a running daemon with its pid, that it answers Slack, its last log line and log path, exit 0', () => {
    const tail = [json(T - 9000, 'failover is on: waiting until this laptop holds the record before connecting to Slack'), json(T, 'orchestrator is running: Socket Mode is connected')].join('\n')
    const result = runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, readTail: (path) => (path === '/relay/tmp/relay.log' ? tail : null) })
    expect(result).toEqual({
      exitCode: 0,
      report: 'Relay daemon: running (pid 32870), answering Slack\nLast log line: 18:22:59 UTC: orchestrator is running: Socket Mode is connected\nLog: /relay/tmp/relay.log',
    })
  })

  it('says a running daemon stands by when the last state line is the failover wait', () => {
    const tail = [json(T - 9000, 'orchestrator is running: Socket Mode is connected'), json(T, 'failover is on: waiting until this laptop holds the record before connecting to Slack')].join('\n')
    const result = runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_RUNNING, readTail: () => tail })
    expect(result.report.split('\n')[0]).toBe('Relay daemon: running (pid 32870), standing by (another laptop answers)')
  })

  it('reports a crash-looping daemon as not running with its exit code, start count and the error it died on, exit 1', () => {
    const tail = `${json(T, 'failover is on: waiting')}\nrelay-orchestrator failed: Connection terminated due to connection timeout\n`
    const result = runStatus({ platform: 'darwin', uid: 501, run: () => LAUNCHD_CRASHING, readTail: () => tail })
    expect(result).toEqual({
      exitCode: 1,
      report:
        'Relay daemon: not running (launchd state: spawn scheduled, last exit code 1, started 188 times)\n' +
        'Last log line: relay-orchestrator failed: Connection terminated due to connection timeout\nLog: /relay/tmp/relay.log',
    })
  })

  it('asks launchd for this user and label, and says how to install when launchd has no such service', () => {
    const calls: string[][] = []
    const result = runStatus({
      platform: 'darwin',
      uid: 501,
      run: (file, args) => {
        calls.push([file, ...args])
        throw new Error('Could not find service "com.relay.orchestrator" in domain for user gui: 501')
      },
    })
    expect(calls).toEqual([['/bin/launchctl', 'print', 'gui/501/com.relay.orchestrator']])
    expect(result).toEqual({ exitCode: 1, report: 'Relay daemon: not installed (launchd has no com.relay.orchestrator). Install it with: relay install-service --start' })
  })

  it('on Linux reads systemd and the log path from the unit file', () => {
    const show = 'ActiveState=active\nSubState=running\nMainPID=4242\nExecMainStatus=0\nNRestarts=0\nLoadState=loaded\n'
    const unit = '[Service]\nStandardOutput=append:/home/me/relay/tmp/relay.log\n'
    const result = runStatus({ platform: 'linux', home: '/home/me', run: () => show, readFile: () => unit, readTail: () => json(T, 'orchestrator is running') })
    expect(result).toEqual({ exitCode: 0, report: 'Relay daemon: running (pid 4242), answering Slack\nLast log line: 18:22:59 UTC: orchestrator is running\nLog: /home/me/relay/tmp/relay.log' })

    const failed = runStatus({ platform: 'linux', home: '/home/me', run: () => 'ActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainStatus=1\nNRestarts=7\nLoadState=loaded\n', readFile: () => unit, readTail: () => null })
    expect(failed).toEqual({ exitCode: 1, report: 'Relay daemon: not running (systemd: activating/auto-restart, last exit code 1, restarted 7 times)\nLog: /home/me/relay/tmp/relay.log' })

    expect(runStatus({ platform: 'linux', run: () => 'LoadState=not-found\nActiveState=inactive\n' }).report).toContain('not installed (no relay.service)')
  })

  it('takes an error line message when a JSON log line has no msg, and the last non-empty line only', () => {
    expect(lastLogLine(`${JSON.stringify({ level: 50, time: T, err: { message: 'boom' } })}\n\n`)).toBe('18:22:59 UTC: boom')
    expect(lastLogLine('\n \n')).toBeUndefined()
  })
})
