import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildRelaySecretsHelper } from '../../src/cli/service.js'
import { daemonPidFilePath } from '../../src/secrets/keychain.js'

/**
 * The real compiled helper, built the way `relay install-service` builds it,
 * into a temporary RELAY_HOME. Only the refusal paths run: each exits before
 * the helper opens the keychain, so the operator's keychain is never read:
 * this build names a node binary that does not exist, so `get` can never
 * pass its parent check from a test.
 * A machine without the command line tools fails here rather than skipping.
 */
const NOT_THE_DAEMON_NODE = '/nonexistent/relay-test/node'
let relayHome: string
let helper: string

function runHelper(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(helper, args as string[], (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
    })
  })
}

beforeAll(() => {
  relayHome = mkdtempSync(join(tmpdir(), 'relay-secrets-helper-'))
  helper = buildRelaySecretsHelper(
    process.cwd(),
    relayHome,
    NOT_THE_DAEMON_NODE,
    (file, args) => {
      execFileSync(file, args as string[], { stdio: 'pipe' })
    },
    (path) => mkdirSync(path, { recursive: true }),
  )
}, 60_000)

describe('relay-secrets get', () => {
  it('is built and signed into <RELAY_HOME>/bin', () => {
    expect(existsSync(helper)).toBe(true)
    expect(execFileSync('/usr/bin/codesign', ['--verify', helper], { stdio: 'pipe' }).toString()).toBe('')
  })

  it('refuses when no daemon pid is recorded', async () => {
    const result = await runHelper(['get', 'relay-approval-receipt-key'])
    expect(result).toMatchObject({ code: 77, stdout: '' })
    expect(result.stderr).toContain('not the relay daemon')
  })

  it('refuses a caller whose parent is not the recorded daemon pid', async () => {
    mkdirSync(join(relayHome, 'run'), { recursive: true })
    // This test process is the helper's parent; record a different pid.
    writeFileSync(daemonPidFilePath(relayHome), `${process.pid + 100000}\n`)
    const result = await runHelper(['get', 'relay-approval-receipt-key'])
    expect(result).toMatchObject({ code: 77, stdout: '' })
  })

  it('refuses a parent with the recorded pid whose executable is not the daemon node binary', async () => {
    // A worker that writes its own pid into the file still runs some other
    // executable than the node binary baked in at install.
    mkdirSync(join(relayHome, 'run'), { recursive: true })
    writeFileSync(daemonPidFilePath(relayHome), `${process.pid}\n`)
    const result = await runHelper(['get', 'relay-approval-receipt-key'])
    expect(result).toMatchObject({ code: 77, stdout: '' })
  })

  it('ignores RELAY_HOME in its environment: the pid file is found next to the binary', async () => {
    const forged = mkdtempSync(join(tmpdir(), 'relay-secrets-forged-'))
    mkdirSync(join(forged, 'run'))
    writeFileSync(join(forged, 'run', 'relay-daemon.pid'), `${process.pid}\n`)
    const result = await new Promise<number>((resolve) => {
      execFile(helper, ['get', 'relay-approval-receipt-key'], { env: { RELAY_HOME: forged } }, (error) => {
        resolve(error === null ? 0 : Number(error.code))
      })
    })
    expect(result).toBe(77)
  })

  it('rejects an unknown command without touching the keychain', async () => {
    expect((await runHelper(['dump', 'x'])).code).toBe(64)
  })
})
