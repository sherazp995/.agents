import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../../src/config/errors.js'
import { databasePasswordInConfig, resolveDatabaseUrl, resolveOperatorDatabaseUrl } from '../../src/config/database-url.js'
import { relayConfigSchema } from '../../src/config/schema.js'
import { loadRelayConfig } from '../../src/config/load.js'
import type { Policy, RelayConfig } from '../../src/config/schema.js'
import { checkConfiguredPostgres, checkDatabaseSecret, checkReceiptKey } from '../../src/doctor/checks.js'
import '../../src/doctor/checks/audit.js'
import { defaultChecks } from '../../src/doctor/registry.js'
import type { CheckContext } from '../../src/doctor/registry.js'
import { EnvSecretProvider } from '../../src/secrets/env.js'
import type { SecretProvider } from '../../src/secrets/provider.js'
import { getTestDatabaseUrl } from '../support/database.js'

const MISSING = 'keystore:relay-test-missing-database-url'

function configWith(url: string): RelayConfig {
  return { database: { url }, secrets: { provider: 'keychain' } } as unknown as RelayConfig
}

/** EnvSecretProvider maps relay-database-url to RELAY_SECRET_RELAY_DATABASE_URL. */
function keystoreHolding(url: string): SecretProvider {
  return new EnvSecretProvider({ RELAY_SECRET_RELAY_DATABASE_URL: url })
}

function context(url: string, secrets: SecretProvider): CheckContext {
  return { config: configWith(url), policy: {} as Policy, secrets }
}

describe('resolveOperatorDatabaseUrl', () => {
  it('uses operator_url without asking the keystore, and database.url when it is unset', async () => {
    const config = { database: { url: MISSING, operator_url: 'postgres://relay_app@localhost:5432/relay' }, secrets: { provider: 'keychain' } } as unknown as RelayConfig
    await expect(resolveOperatorDatabaseUrl(config, new EnvSecretProvider({}))).resolves.toBe('postgres://relay_app@localhost:5432/relay')
    const url = 'postgres://relay_app:generated@localhost:5432/relay'
    await expect(resolveOperatorDatabaseUrl(configWith('keystore:relay-database-url'), keystoreHolding(url))).resolves.toBe(url)
  })

  it('refuses an operator_url that holds a password', () => {
    const database = (operatorUrl: string) => relayConfigSchema.shape.database.safeParse({ url: MISSING, operator_url: operatorUrl }).success
    expect(database('postgres://relay_app@localhost:5432/relay')).toBe(true)
    expect(database('postgres://relay_app:secret@localhost:5432/relay')).toBe(false)
    expect(database('postgres://relay_app@localhost:5432/relay?password=secret')).toBe(false)
  })
})

describe('resolveDatabaseUrl', () => {
  it('returns a literal URL unchanged, so an unmigrated install still works', async () => {
    const url = 'postgres://relay:relay@localhost:5432/relay'
    await expect(resolveDatabaseUrl(configWith(url), new EnvSecretProvider({}))).resolves.toBe(url)
  })

  it('reads a keystore reference from the keystore', async () => {
    const url = 'postgres://relay_app:generated@localhost:5432/relay'
    await expect(resolveDatabaseUrl(configWith('keystore:relay-database-url'), keystoreHolding(url))).resolves.toBe(url)
  })

  it('fails naming the reference, and never a value, when the item is missing', async () => {
    const error = await resolveDatabaseUrl(configWith(MISSING), new EnvSecretProvider({})).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).reason).toContain('relay-test-missing-database-url')
  })

  it('refuses an item that does not hold a postgres URL, without printing it', async () => {
    const secrets = new EnvSecretProvider({ RELAY_SECRET_RELAY_DATABASE_URL: 'hunter2' })
    const error = await resolveDatabaseUrl(configWith('keystore:relay-database-url'), secrets).catch((caught: unknown) => caught)
    expect((error as Error).message).toContain('does not hold a postgres URL')
    expect((error as Error).message).not.toContain('hunter2')
  })

  it('is what the config schema now accepts for database.url', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-database-url-'))
    const path = join(dir, 'relay.config.yaml')
    writeFileSync(
      path,
      'model_provider:\n  name: anthropic\n  zero_data_retention: true\ndatabase:\n  url: keystore:relay-database-url\n' +
        'redis:\n  url: redis://localhost:6379/8\nlogging:\n  level: error\nsecrets:\n  provider: keychain\n',
    )
    expect(loadRelayConfig(path).database.url).toBe('keystore:relay-database-url')
  })
})

describe('doctor: relay secrets (user decision 7)', () => {
  it('fails a config holding a plaintext database password', () => {
    expect(databasePasswordInConfig(configWith('postgres://relay:relay@localhost:5432/relay'))).toBe(true)
    const result = checkDatabaseSecret(configWith('postgres://relay:relay@localhost:5432/relay'))
    expect(result.status).toBe('failed')
    expect(result.remediation).toContain('relay secrets migrate')
    expect(result.detail).not.toContain('relay:relay')
  })

  it('also fails a password given as libpq\'s ?password= query parameter', () => {
    expect(checkDatabaseSecret(configWith('postgres://relay@localhost:5433/relay?password=hunter2')).status).toBe('failed')
    expect(checkDatabaseSecret(configWith('postgres://relay@localhost:5433/relay?sslmode=disable')).status).toBe('ok')
  })

  it('passes a keystore reference, and a literal URL with no password', () => {
    expect(checkDatabaseSecret(configWith('keystore:relay-database-url')).status).toBe('ok')
    expect(checkDatabaseSecret(configWith('postgres://localhost:5432/relay')).status).toBe('ok')
  })

  it('checks the receipt key through relay-secrets status on the keychain, printing no value', async () => {
    const asked: string[] = []
    const ctx = context('keystore:relay-database-url', { kind: 'keychain', get: async () => { throw new Error('must not read a value') }, has: async () => true })
    const status = (answer: 'missing' | 'relay-only') => async (name: string, helperPath: string) => {
      asked.push(`${helperPath} ${name}`)
      return answer
    }

    expect((await checkReceiptKey(ctx, { relayHome: '/r', status: status('relay-only') })).status).toBe('ok')
    const missing = await checkReceiptKey(ctx, { relayHome: '/r', status: status('missing') })
    expect(missing.status).toBe('failed')
    expect(missing.remediation).toContain('relay secrets migrate')
    expect(asked[0]).toBe('/r/bin/relay-secrets relay-approval-receipt-key')
  })

  it('fails the receipt key check when the helper cannot answer', async () => {
    const ctx = context('keystore:relay-database-url', new EnvSecretProvider({}))
    const keychainCtx = { ...ctx, secrets: { kind: 'keychain' as const, get: ctx.secrets.get, has: ctx.secrets.has } }
    const result = await checkReceiptKey(keychainCtx, { relayHome: '/r', status: async () => { throw new Error('ENOENT') } })
    expect(result.status).toBe('failed')
    expect(result.remediation).toContain('relay install-service')
  })

  it('registers both checks with doctor', () => {
    const names = defaultChecks().map((check) => check.name)
    expect(names).toEqual(expect.arrayContaining(['postgres', 'database-secret', 'receipt-key', 'audit']))
  })
})

describe('database consumers resolve through the keystore', () => {
  it('doctor postgres connects through a keystore reference, and fails naming a missing one', async () => {
    const url = await getTestDatabaseUrl()
    expect((await checkConfiguredPostgres(context('keystore:relay-database-url', keystoreHolding(url)))).status).toBe('ok')

    const missing = await checkConfiguredPostgres(context(MISSING, new EnvSecretProvider({})))
    expect(missing.status).toBe('failed')
    expect(missing.detail).toContain('relay-test-missing-database-url')
  })

  it('the audit check reads through a keystore reference, and fails naming a missing one', async () => {
    const audit = defaultChecks().find((check) => check.name === 'audit')
    const url = await getTestDatabaseUrl()

    // Any answer but the "could not be resolved" one proves it connected.
    const connected = await audit?.run(context('keystore:relay-database-url', keystoreHolding(url)))
    expect(connected?.detail).not.toContain('could not be resolved')

    const missing = await audit?.run(context(MISSING, new EnvSecretProvider({})))
    expect(missing?.status).toBe('failed')
    expect(missing?.detail).toContain('relay-test-missing-database-url')
  })
})
