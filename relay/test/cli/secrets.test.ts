import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  provisionAppRole,
  runHelperProcess,
  runSecretsMigrate,
  runSecretsSet,
  type HelperResult,
  type SecretsCliDependencies,
} from '../../src/cli/secrets.js'
import { resolveDatabaseUrl } from '../../src/config/database-url.js'
import { loadRelayConfig } from '../../src/config/load.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { createDaemonSecretProvider } from '../../src/secrets/daemon.js'
import { getTestDatabaseUrl } from '../support/database.js'

/**
 * A fake keychain behind a fake relay-secrets and a fake /usr/bin/security.
 * Each item records whether only the helper may read it ("relay-only") or
 * the operator's `security` may too ("shared", how items were created
 * before the helper existed). Every argv either fake sees is kept, so a
 * test can prove no value ever reached one.
 */
class FakeKeychain {
  readonly items = new Map<string, { value: string; access: 'relay-only' | 'shared' }>()
  readonly argv: string[][] = []

  readonly deps = (overrides: Partial<SecretsCliDependencies> = {}): SecretsCliDependencies => ({
    helperPath: '/h/bin/relay-secrets',
    pathExists: () => true,
    runHelper: async (helperPath, args, input) => this.helper(helperPath, args, input),
    security: async (file, args) => this.security(file, args),
    ...overrides,
  })

  async helper(helperPath: string, args: readonly string[], input?: string): Promise<HelperResult> {
    this.argv.push([helperPath, ...args])
    const [command, name = ''] = args
    const item = this.items.get(name)
    if (command === 'status') return { exitCode: 0, stdout: `${item?.access ?? 'missing'}\n`, stderr: '' }
    if (command === 'set') {
      if (item) return { exitCode: 73, stdout: '', stderr: 'exists' }
      this.items.set(name, { value: input ?? '', access: 'relay-only' })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (command === 'get') return item ? { exitCode: 0, stdout: item.value, stderr: '' } : { exitCode: 66, stdout: '', stderr: '' }
    return { exitCode: 64, stdout: '', stderr: '' }
  }

  async security(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.argv.push([file, ...args])
    const name = args[args.indexOf('-s') + 1] ?? ''
    const item = this.items.get(name)
    if (!item) throw new Error('The specified item could not be found in the keychain.')
    if (args[0] === 'delete-generic-password') {
      this.items.delete(name)
      return { stdout: '', stderr: '' }
    }
    return { stdout: `${item.value}\n`, stderr: '' }
  }

  /** What the daemon's KeychainSecretProvider would get from the helper. */
  readonly daemonExec = async (file: string, args: readonly string[]) => {
    const result = await this.helper(file, args)
    if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`)
    return { stdout: result.stdout, stderr: result.stderr }
  }

  everyArgv(): string {
    return this.argv.map((argv) => argv.join(' ')).join('\n')
  }
}

describe('relay secrets set', () => {
  it('stores a value from stdin with the helper-only access list, never on argv', async () => {
    const keychain = new FakeKeychain()
    const result = await runSecretsSet({ name: 'relay-mcp-linear-token', value: 'lin_secret_value', replace: false }, keychain.deps())

    expect(result.exitCode).toBe(0)
    expect(keychain.items.get('relay-mcp-linear-token')).toEqual({ value: 'lin_secret_value', access: 'relay-only' })
    expect(keychain.everyArgv()).not.toContain('lin_secret_value')
    expect(result.report).not.toContain('lin_secret_value')
  })

  it('refuses to overwrite an existing item unless --replace, and replaces through a holding copy', async () => {
    const keychain = new FakeKeychain()
    keychain.items.set('relay-github-read-token', { value: 'old', access: 'relay-only' })

    expect((await runSecretsSet({ name: 'relay-github-read-token', value: 'new', replace: false }, keychain.deps())).exitCode).toBe(1)
    expect(keychain.items.get('relay-github-read-token')?.value).toBe('old')

    expect((await runSecretsSet({ name: 'relay-github-read-token', value: 'new', replace: true }, keychain.deps())).exitCode).toBe(0)
    expect(keychain.items.get('relay-github-read-token')).toEqual({ value: 'new', access: 'relay-only' })
    expect([...keychain.items.keys()]).toEqual(['relay-github-read-token'])
  })

  it('refuses without the helper, naming where it should be', async () => {
    const keychain = new FakeKeychain()
    const result = await runSecretsSet({ name: 'x', value: 'v', replace: false }, keychain.deps({ pathExists: () => false }))
    expect(result).toMatchObject({ exitCode: 1 })
    expect(result.report).toContain('/h/bin/relay-secrets')
    expect(result.report).toContain('relay install-service')
  })

  it('refuses a name outside the keystore item rule before touching the helper', async () => {
    const keychain = new FakeKeychain()
    const result = await runSecretsSet({ name: 'bad name;rm', value: 'v', replace: false }, keychain.deps())
    expect(result.exitCode).toBe(1)
    expect(keychain.argv).toEqual([])
  })

  it('survives a helper that exits without reading stdin (EPIPE), reporting its exit code', async () => {
    // /usr/bin/false never reads stdin; a megabyte cannot fit the pipe buffer.
    await expect(runHelperProcess('/usr/bin/false', [], 'x'.repeat(1 << 20))).resolves.toMatchObject({ exitCode: 1 })
  })

  it('restores an item an interrupted replace left only in its holding copy, then replaces it', async () => {
    const keychain = new FakeKeychain()
    keychain.items.set('relay-github-read-token.relay-migrating', { value: 'kept', access: 'relay-only' })

    const result = await runSecretsSet({ name: 'relay-github-read-token', value: 'new', replace: true }, keychain.deps())
    expect(result.exitCode, result.report).toBe(0)
    expect(keychain.items.get('relay-github-read-token')?.value).toBe('new')
    expect([...keychain.items.keys()]).toEqual(['relay-github-read-token'])
  })

  it('refuses an empty stdin', async () => {
    expect((await runSecretsSet({ name: 'x', value: '', replace: false }, new FakeKeychain().deps())).exitCode).toBe(1)
  })
})

describe('relay secrets migrate, against the test Postgres', () => {
  const role = `relay_app_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  let adminUrl: string

  beforeAll(async () => {
    adminUrl = await getTestDatabaseUrl()
    const pool = createPool(adminUrl)
    try {
      await applyMigrations(pool, 'src/db/migrations')
    } finally {
      await closePool(pool)
    }
  }, 60_000)

  afterAll(async () => {
    const pool = createPool(adminUrl)
    try {
      const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
      if (exists.rowCount !== 0) {
        // A non-superuser owner needs the role's privileges to take its objects back.
        await pool.query(`GRANT ${role} TO CURRENT_USER WITH INHERIT TRUE`)
        await pool.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER`)
        await pool.query(`DROP OWNED BY ${role}`)
        await pool.query(`DROP ROLE ${role}`)
      }
    } finally {
      await closePool(pool)
    }
  })

  function writeConfig(url: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'relay-secrets-migrate-')), 'relay.config.yaml')
    writeFileSync(
      path,
      '# operator comment kept\nmodel_provider:\n  name: anthropic\n  zero_data_retention: true\n' +
        `database:\n  url: ${url}\nredis:\n  url: redis://localhost:6379/8\nlogging:\n  level: error\nsecrets:\n  provider: keychain\n`,
    )
    return path
  }

  it('moves the URL into the keystore, connects the daemon as the new role, and is idempotent', async () => {
    const keychain = new FakeKeychain()
    keychain.items.set('relay-slack-bot-token', { value: 'xoxb-shared-token', access: 'shared' })
    const configPath = writeConfig(adminUrl)
    const provision = vi.fn(provisionAppRole)

    const first = await runSecretsMigrate({ configPath, role, provision }, keychain.deps())
    expect(first.exitCode, first.report).toBe(0)

    // Config holds a reference only, and keeps the operator's comment.
    const rewritten = readFileSync(configPath, 'utf8')
    expect(rewritten).toContain('url: keystore:relay-database-url')
    expect(rewritten).toContain('# operator comment kept')
    expect(rewritten).not.toContain(adminUrl)
    expect(rewritten).not.toContain('postgres:')

    // Every relay item is helper-only now, including the one created by `security` before.
    expect(keychain.items.get('relay-slack-bot-token')).toEqual({ value: 'xoxb-shared-token', access: 'relay-only' })
    expect(keychain.items.get('relay-approval-receipt-key')?.value).toMatch(/^[0-9a-f]{64}$/)
    expect(keychain.items.get('relay-database-admin-url')?.value).toBe(adminUrl)
    const appUrl = keychain.items.get('relay-database-url')?.value ?? ''
    expect(new URL(appUrl).username).toBe(role)

    // No value reached an argv or the report.
    for (const item of keychain.items.values()) {
      expect(keychain.everyArgv()).not.toContain(item.value)
      expect(first.report).not.toContain(item.value)
    }

    // The daemon's path: load the rewritten config, read through relay-secrets, connect.
    const config = loadRelayConfig(configPath)
    const secrets = createDaemonSecretProvider(config, '/h', { pathExists: () => true, writePidFile: () => {}, execFile: keychain.daemonExec })
    const pool = createPool(await resolveDatabaseUrl(config, secrets))
    try {
      const who = await pool.query<{ user: string }>('SELECT current_user AS user')
      expect(who.rows[0]?.user).toBe(role)
      await pool.query('SELECT count(*) FROM workspaces')
      // It owns relay's tables, so the daemon's startup migrations run as it.
      await applyMigrations(pool, 'src/db/migrations')
    } finally {
      await closePool(pool)
    }

    // Again: nothing to do, nothing replaced, no new role password.
    const before = new Map(keychain.items)
    const second = await runSecretsMigrate({ configPath, role, provision }, keychain.deps())
    expect(second.exitCode, second.report).toBe(0)
    expect(provision).toHaveBeenCalledTimes(1)
    expect(keychain.items).toEqual(before)
    expect(second.report).toContain('already')
  }, 60_000)

  it('the new role has no rights beyond relay\'s own database objects', async () => {
    const pool = createPool(adminUrl)
    try {
      const flags = await pool.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
        'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1',
        [role],
      )
      expect(flags.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false })
    } finally {
      await closePool(pool)
    }
  })

  it('finishes an interrupted replace first: restores a lone holding copy, drops a stale one', async () => {
    const keychain = new FakeKeychain()
    keychain.items.set('relay-database-url', { value: 'postgres://relay_app:p@localhost/relay', access: 'relay-only' })
    keychain.items.set('relay-database-url.relay-migrating', { value: 'postgres://stale@localhost/relay', access: 'relay-only' })
    keychain.items.set('relay-slack-bot-token.relay-migrating', { value: 'xoxb-only-copy', access: 'relay-only' })
    keychain.items.set('relay-approval-receipt-key', { value: 'k', access: 'relay-only' })

    const result = await runSecretsMigrate({ configPath: writeConfig('keystore:relay-database-url') }, keychain.deps())
    expect(result.exitCode, result.report).toBe(0)
    expect(keychain.items.get('relay-slack-bot-token')).toEqual({ value: 'xoxb-only-copy', access: 'relay-only' })
    expect(keychain.items.get('relay-database-url')?.value).toBe('postgres://relay_app:p@localhost/relay')
    expect([...keychain.items.keys()].filter((name) => name.endsWith('.relay-migrating'))).toEqual([])
    expect(result.report).toContain('finished an interrupted replace of relay-slack-bot-token')
  })

  it('stops naming a reference whose keystore item is missing', async () => {
    const keychain = new FakeKeychain()
    const result = await runSecretsMigrate({ configPath: writeConfig('keystore:relay-test-missing-db') }, keychain.deps())
    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('relay-test-missing-db')
  })
})
