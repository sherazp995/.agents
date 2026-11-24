import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const wrapper = resolve(import.meta.dirname, '../../bin/relay')
const bash = execFileSync('/usr/bin/which', ['bash'], { encoding: 'utf8' }).trim()
const service = `gui/${process.getuid?.()}/com.relay.orchestrator`

type Outcome = { readonly code: number; readonly stdout: string; readonly stderr: string }

/**
 * A PATH of linked tools plus fakes only: the real launchctl and systemctl
 * live in /bin and /usr/bin, which never go on it, so no test can reach the
 * live daemon. The fake for the other system is a tripwire.
 */
function machine(system: 'Darwin' | 'Linux', state: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-start-stop-'))
  const bin = join(dir, 'bin')
  const home = join(dir, 'home')
  mkdirSync(bin)
  mkdirSync(home)
  for (const tool of ['dirname', 'readlink', 'id', 'sleep']) symlinkSync(execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim(), join(bin, tool))
  symlinkSync(bash, join(bin, 'bash'))
  for (const [key, value] of Object.entries(state)) writeFileSync(join(dir, key), value)
  const calls = join(dir, 'calls')
  writeFileSync(calls, '')
  const tripwire = join(dir, 'tripwire')
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!${bash}\nd=${JSON.stringify(dir)}\nget() { [ -f "$d/$1" ] && echo "$(<"$d/$1")"; }\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  fake('uname', `echo ${system}`)
  const wire = `echo "$0 $*" >> "$d/tripwire"; exit 99`
  const launchctl = `echo "$*" >> "$d/calls"
case "$1" in
  print)
    left=$(get gone_after)
    if [ -n "$left" ]; then
      if [ "$left" -le 0 ]; then echo missing > "$d/job"; else echo $((left - 1)) > "$d/gone_after"; fi
    fi
    case "$(get job)" in
      missing) echo "Could not find service \\"com.relay.orchestrator\\" in domain for user gui: 501" >&2; exit 113 ;;
      running) printf '%s = {\\n\\tactive count = 1\\n\\tstate = running\\n\\tpid = 4242\\n\\tendpoints = {\\n\\t\\tstate = active\\n\\t}\\n}\\n' "$2" ;;
      broken) echo "Bad request." >&2; exit 5 ;;
      # Nested blocks carry their own state and pid lines; only the job's one-tab lines say whether it runs.
      *) printf '%s = {\\n\\tactive count = 0\\n\\tstate = not running\\n\\tendpoints = {\\n\\t\\tstate = running\\n\\t\\tpid = 77\\n\\t}\\n}\\n' "$2" ;;
    esac ;;
  bootout)
    code=$(get bootout_exit); code=\${code:-0}
    [ "$code" = 0 ] && [ -z "$(get gone_after)" ] && echo missing > "$d/job"
    exit "$code" ;;
  bootstrap)
    if [ "$(get bootstrap_fails)" = once ]; then echo spent > "$d/bootstrap_fails"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    echo running > "$d/job" ;;
  kickstart) echo running > "$d/job" ;;
esac`
  const systemctl = `echo "$*" >> "$d/calls"
[ "$(get bus)" = down ] && { echo "Failed to connect to bus: No medium found" >&2; exit 1; }
case "$2" in
  show) echo "LoadState=$(get load)"; echo "ActiveState=$(get active)" ;;
  start) echo active > "$d/active" ;;
  stop) echo inactive > "$d/active" ;;
esac`
  fake('launchctl', system === 'Darwin' ? launchctl : wire)
  fake('systemctl', system === 'Linux' ? systemctl : wire)
  const plist = join(home, 'Library', 'LaunchAgents', 'com.relay.orchestrator.plist')
  return {
    plist,
    installPlist: () => {
      mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
      writeFileSync(plist, '<plist/>')
    },
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
    read: (key: string) => readFileSync(join(dir, key), 'utf8').trim(),
    tripped: () => existsSync(tripwire),
    relay: async (command: 'start' | 'stop', env: Record<string, string> = {}): Promise<Outcome> => {
      try {
        const { stdout, stderr } = await run(wrapper, [command], { env: { PATH: bin, HOME: home, ...env } })
        return { code: 0, stdout, stderr }
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string }
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr }
      }
    },
  }
}

describe('relay stop on macOS', () => {
  it('boots out a loaded job and says stopped only once launchd has let it go', async () => {
    const mac = machine('Darwin', { job: 'running', gone_after: '2' })
    const result = await mac.relay('stop')
    expect(result).toMatchObject({ code: 0, stdout: 'stopped com.relay.orchestrator\n' })
    const calls = mac.calls()
    expect(calls.slice(0, 2)).toEqual([`print ${service}`, `bootout ${service}`])
    expect(calls.filter((call) => call.startsWith('print')).length).toBeGreaterThanOrEqual(3)
    expect(mac.read('job')).toBe('missing')
    expect(mac.tripped()).toBe(false)
  })

  it('takes exit 36 as still stopping and waits for the job to go', async () => {
    const mac = machine('Darwin', { job: 'running', bootout_exit: '36', gone_after: '1' })
    expect(await mac.relay('stop')).toMatchObject({ code: 0, stdout: 'stopped com.relay.orchestrator\n' })
    expect(mac.read('job')).toBe('missing')
  })

  it('exits 1 when the job is still there after the wait', async () => {
    const mac = machine('Darwin', { job: 'running', bootout_exit: '36', gone_after: '1000' })
    const result = await mac.relay('stop', { RELAY_SERVICE_WAIT_SECONDS: '1' })
    expect(result).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('still stopping com.relay.orchestrator after 1s') })
  })

  it('says relay was not running when launchd has no job', async () => {
    const mac = machine('Darwin', { job: 'missing' })
    expect(await mac.relay('stop')).toMatchObject({ code: 0, stdout: 'relay was not running, so nothing was stopped\n' })
    expect(mac.calls()).toEqual([`print ${service}`])
  })

  it('exits 1 with the reason when launchctl refuses the bootout', async () => {
    const mac = machine('Darwin', { job: 'running', bootout_exit: '1' })
    const result = await mac.relay('stop')
    expect(result).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('launchctl could not stop com.relay.orchestrator') })
  })
})

describe('relay start on macOS', () => {
  it('loads an installed job that launchd does not have', async () => {
    const mac = machine('Darwin', { job: 'missing' })
    mac.installPlist()
    expect(await mac.relay('start')).toMatchObject({ code: 0, stdout: 'started com.relay.orchestrator\n' })
    expect(mac.calls()).toEqual([`print ${service}`, `bootstrap gui/${process.getuid?.()} ${mac.plist}`])
    expect(mac.tripped()).toBe(false)
  })

  it('loads again once when the first load is refused while the old job is still going', async () => {
    const mac = machine('Darwin', { job: 'missing', bootstrap_fails: 'once' })
    mac.installPlist()
    expect(await mac.relay('start')).toMatchObject({ code: 0, stdout: 'started com.relay.orchestrator\n' })
    const load = `bootstrap gui/${process.getuid?.()} ${mac.plist}`
    expect(mac.calls()).toEqual([`print ${service}`, load, `print ${service}`, load])
    expect(mac.read('job')).toBe('running')
  })

  it('starts a loaded job that is not running, without killing anything', async () => {
    const mac = machine('Darwin', { job: 'stopped' })
    expect(await mac.relay('start')).toMatchObject({ code: 0, stdout: 'started com.relay.orchestrator\n' })
    expect(mac.calls()).toEqual([`print ${service}`, `kickstart ${service}`])
  })

  it('says already running and changes nothing', async () => {
    const mac = machine('Darwin', { job: 'running' })
    expect(await mac.relay('start')).toMatchObject({ code: 0, stdout: 'relay is already running (com.relay.orchestrator)\n' })
    expect(mac.calls()).toEqual([`print ${service}`])
  })

  it('exits 1 with the install hint when there is no plist', async () => {
    const mac = machine('Darwin', { job: 'missing' })
    const result = await mac.relay('start')
    expect(result).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('relay install-service --start') })
    expect(mac.calls()).toEqual([`print ${service}`])
  })

  it('exits 1 when launchctl print fails for another reason, without loading anything', async () => {
    const mac = machine('Darwin', { job: 'broken' })
    mac.installPlist()
    const result = await mac.relay('start')
    expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('launchctl print failed: Bad request.') })
    expect(mac.calls()).toEqual([`print ${service}`])
  })
})

describe('relay stop and start on Linux', () => {
  it('stop stops an active unit', async () => {
    const linux = machine('Linux', { load: 'loaded', active: 'active' })
    expect(await linux.relay('stop')).toMatchObject({ code: 0, stdout: 'stopped relay.service\n' })
    expect(linux.calls()).toEqual(['--user show relay.service -p LoadState -p ActiveState', '--user stop relay.service'])
    expect(linux.tripped()).toBe(false)
  })

  it('stop also stops a unit waiting to restart itself', async () => {
    const linux = machine('Linux', { load: 'loaded', active: 'activating' })
    expect(await linux.relay('stop')).toMatchObject({ code: 0, stdout: 'stopped relay.service\n' })
    expect(linux.read('active')).toBe('inactive')
  })

  it('stop says not running for an inactive or missing unit', async () => {
    for (const state of [{ load: 'loaded', active: 'inactive' }, { load: 'not-found', active: 'inactive' }]) {
      const linux = machine('Linux', state)
      expect(await linux.relay('stop')).toMatchObject({ code: 0, stdout: 'relay was not running, so nothing was stopped\n' })
      expect(linux.calls()).toHaveLength(1)
    }
  })

  it('stop and start exit 1 with the login session hint when there is no user bus', async () => {
    for (const command of ['stop', 'start'] as const) {
      const linux = machine('Linux', { bus: 'down' })
      const result = await linux.relay(command)
      expect(result).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Failed to connect to bus') })
      expect(result.stderr).toContain(`run relay ${command} from a login session`)
    }
  })

  it('start starts an inactive unit', async () => {
    const linux = machine('Linux', { load: 'loaded', active: 'inactive' })
    expect(await linux.relay('start')).toMatchObject({ code: 0, stdout: 'started relay.service\n' })
    expect(linux.calls()).toEqual(['--user show relay.service -p LoadState -p ActiveState', '--user start relay.service'])
    expect(linux.tripped()).toBe(false)
  })

  it('start says already running for an active unit', async () => {
    const linux = machine('Linux', { load: 'loaded', active: 'active' })
    expect(await linux.relay('start')).toMatchObject({ code: 0, stdout: 'relay is already running (relay.service)\n' })
    expect(linux.calls()).toHaveLength(1)
  })

  it('start exits 1 with the install hint when the unit is not installed', async () => {
    const linux = machine('Linux', { load: 'not-found', active: 'inactive' })
    const result = await linux.relay('start')
    expect(result).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('relay install-service --start') })
    expect(linux.calls()).toHaveLength(1)
  })
})
