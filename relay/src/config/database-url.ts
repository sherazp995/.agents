import { ConfigError } from './errors.js'
import type { RelayConfig } from './schema.js'
import { SecretNotFoundError } from '../secrets/provider.js'
import type { SecretProvider } from '../secrets/provider.js'

/**
 * `database.url` is either a literal postgres URL or `keystore:<item>`, a
 * reference to a keystore item holding one (user decision 7: after
 * `relay secrets migrate` no database password sits in a plain file).
 */
export const KEYSTORE_REFERENCE_PREFIX = 'keystore:'

/** The referenced item name, or undefined for a literal URL. */
export function keystoreReferenceName(value: string): string | undefined {
  if (!value.startsWith(KEYSTORE_REFERENCE_PREFIX)) return undefined
  return value.slice(KEYSTORE_REFERENCE_PREFIX.length)
}

/** The names relay's keystore items may have; also the only shape `relay secrets set` accepts. */
export function isKeystoreItemName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name)
}

export function keystoreReference(name: string): string {
  return `${KEYSTORE_REFERENCE_PREFIX}${name}`
}

function isPostgresUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'postgres:' || protocol === 'postgresql:'
  } catch {
    return false
  }
}

/**
 * The one way every consumer turns `config.database.url` into a connection
 * string. A literal URL is returned as is; a reference is read from
 * `secrets`, so the daemon reads it through `relay-secrets` and a CLI
 * command through `security`. A missing item, or an item that is not a
 * postgres URL, fails naming the reference and never the value.
 */
export async function resolveDatabaseUrl(config: RelayConfig, secrets: SecretProvider): Promise<string> {
  const name = keystoreReferenceName(config.database.url)
  if (name === undefined) return config.database.url
  if (!isKeystoreItemName(name)) {
    throw new ConfigError('database.url', `"${config.database.url}" is not a valid keystore reference`)
  }
  let value: string
  try {
    value = await secrets.get(name)
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error
    throw new ConfigError(
      'database.url',
      `${config.database.url} names keystore item "${name}", which the ${secrets.kind} keystore did not return; ` +
        'run `relay secrets migrate` or `relay secrets set ' + name + '`',
    )
  }
  if (!isPostgresUrl(value)) {
    throw new ConfigError('database.url', `keystore item "${name}" (${config.database.url}) does not hold a postgres URL`)
  }
  return value
}

/**
 * What operator commands (the CLI, doctor, smoke) connect with:
 * `database.operator_url` when set, otherwise database.url as the daemon
 * resolves it. The daemon itself always uses resolveDatabaseUrl, because
 * only it can read the keystore item without a prompt.
 */
export async function resolveOperatorDatabaseUrl(config: RelayConfig, secrets: SecretProvider): Promise<string> {
  return config.database.operator_url ?? resolveDatabaseUrl(config, secrets)
}

/**
 * Whether config itself holds a database password, in the URL's userinfo or
 * as libpq's `?password=`, which doctor fails (only a keystore reference may).
 */
export function databasePasswordInConfig(config: RelayConfig): boolean {
  if (keystoreReferenceName(config.database.url) !== undefined) return false
  try {
    const url = new URL(config.database.url)
    return url.password !== '' || (url.searchParams.get('password') ?? '') !== ''
  } catch {
    return false
  }
}
