import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RelayConfig } from '../../src/config/schema.js'
import { createDaemonSecretProvider, removePidFile, writePidFile } from '../../src/secrets/daemon.js'
import { createSecretProvider } from '../../src/secrets/index.js'
import { KeychainSecretProvider } from '../../src/secrets/keychain.js'

const config = { secrets: { provider: 'keychain' } } as unknown as RelayConfig

/**
 * The reader is chosen by entrypoint (user decision 7): the daemon reads
 * through relay-secrets, the only program on relay's items' access list;
 * CLI entrypoints read through /usr/bin/security, which makes macOS ask.
 */
describe('createDaemonSecretProvider', () => {
  it('reads through relay-secrets after recording its own pid for the helper', async () => {
    const order: string[] = []
    const provider = createDaemonSecretProvider(config, '/Users/op/.relay', {
      pathExists: () => true,
      pid: 4242,
      onExit: () => {},
      writePidFile: (path, pid) => order.push(`pid ${path} ${pid}`),
      execFile: async (file, args) => {
        order.push(`exec ${file} ${args.join(' ')}`)
        return { stdout: 'value', stderr: '' }
      },
    })

    await provider.get('relay-slack-bot-token')
    expect(order).toEqual([
      'pid /Users/op/.relay/run/relay-daemon.pid 4242',
      'exec /Users/op/.relay/bin/relay-secrets get relay-slack-bot-token',
    ])
  })

  it('removes its pid file at exit, so a later process reusing the pid is not trusted', () => {
    const exits: Array<() => void> = []
    const removed: string[] = []
    createDaemonSecretProvider(config, '/r', {
      pathExists: () => true,
      pid: 7,
      writePidFile: () => {},
      removePidFile: (path, pid) => removed.push(`${path} ${pid}`),
      onExit: (handler) => exits.push(handler),
    })
    expect(removed).toEqual([])
    exits.forEach((handler) => handler())
    expect(removed).toEqual(['/r/run/relay-daemon.pid 7'])
  })

  it('rewrites an existing pid file as 0600, and removes it only while it names this pid', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'relay-pid-')), 'run', 'relay-daemon.pid')
    writePidFile(path, 1)
    writeFileSync(path, '1\n', { mode: 0o644 })
    writePidFile(path, 2)
    expect(readFileSync(path, 'utf8')).toBe('2\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)

    removePidFile(path, 3)
    expect(existsSync(path)).toBe(true)
    removePidFile(path, 2)
    expect(existsSync(path)).toBe(false)
  })

  it('refuses to start without the helper, naming it', () => {
    expect(() => createDaemonSecretProvider(config, '/r', { pathExists: () => false, writePidFile: () => {} })).toThrow(
      '/r/bin/relay-secrets does not exist',
    )
  })

  it('leaves a CLI entrypoint on the default reader, /usr/bin/security (asserted in keychain.test.ts)', () => {
    expect(createSecretProvider(config)).toBeInstanceOf(KeychainSecretProvider)
  })
})
