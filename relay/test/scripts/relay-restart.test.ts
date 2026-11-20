import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const wrapper = resolve(import.meta.dirname, '../../bin/relay')

/** A PATH whose launchctl records its arguments, answers `print`, and exits with `kickstartExit` on kickstart. */
function fakeLaunchctl(kickstartExit: number): { readonly path: string; readonly calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-restart-'))
  const calls = join(dir, 'calls')
  writeFileSync(calls, '')
  const stub = join(dir, 'launchctl')
  writeFileSync(stub, `#!/bin/sh\necho "$*" >> "${calls}"\necho launchctl-noise\n[ "$1" = kickstart ] && exit ${kickstartExit}\nexit 0\n`)
  chmodSync(stub, 0o755)
  return { path: `${dir}:/usr/bin:/bin`, calls }
}

describe('relay restart', () => {
  it('kickstarts the launchd service without building, and prints only its own line', async () => {
    const fake = fakeLaunchctl(0)
    const { stdout } = await run(wrapper, ['restart'], { env: { PATH: fake.path, HOME: tmpdir() } })
    expect(stdout).toBe('restarted com.relay.orchestrator\n')
    const service = `gui/${process.getuid?.()}/com.relay.orchestrator`
    expect(readFileSync(fake.calls, 'utf8').trim().split('\n')).toEqual([`print ${service}`, `kickstart -k ${service}`])
  })

  it('exits 1 and says so when launchctl refuses the restart', async () => {
    const fake = fakeLaunchctl(5)
    const failure = await run(wrapper, ['restart'], { env: { PATH: fake.path, HOME: tmpdir() } }).catch((error: unknown) => error as { code: number; stderr: string })
    expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining('launchctl could not restart com.relay.orchestrator') })
  })

  it('says no daemon is running when neither launchd nor systemd is on PATH', async () => {
    // Only the tools the wrapper needs, linked in: the real launchctl lives in /bin, so /bin itself must not be on PATH.
    const bin = mkdtempSync(join(tmpdir(), 'relay-restart-none-'))
    for (const tool of ['bash', 'dirname', 'readlink', 'id']) symlinkSync(execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim(), join(bin, tool))
    const { stdout } = await run(wrapper, ['restart'], { env: { PATH: bin, HOME: tmpdir() } })
    expect(stdout).toBe('no daemon is running, so none was restarted\n')
  })
})
