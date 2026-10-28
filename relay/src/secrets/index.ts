import { ConfigError } from '../config/errors.js'
import type { RelayConfig } from '../config/schema.js'
import { KeychainSecretProvider } from './keychain.js'
import { LibSecretProvider } from './libsecret.js'
import type { SecretProvider } from './provider.js'

export type { SecretProvider } from './provider.js'
export { SecretNotFoundError } from './provider.js'
export { EnvSecretProvider } from './env.js'
export { KeychainSecretProvider } from './keychain.js'
export { LibSecretProvider } from './libsecret.js'

/**
 * Selects a SecretProvider by `config.secrets.provider`. The config schema
 * already defaults an omitted value to 'keychain'. The schema accepts only
 * OS KEYSTORES, 'keychain' on macOS and 'libsecret' on Linux: FR-SLA-6
 * requires production Slack tokens live in a keystore, never in an
 * environment dump, so this
 * function is deliberately not how EnvSecretProvider is ever reached.
 * EnvSecretProvider stays available for tests, which construct it directly
 * (see test/secrets/provider.test.ts) or inject it explicitly, never
 * through a config value. Anything other than 'keychain' fails closed with
 * a ConfigError rather than silently falling back to a default, because a
 * silent default is exactly the failure mode FR-SEC-2 forbids for a secret
 * source; in practice that only happens through a cast that bypasses the
 * schema, since the schema itself rejects any other value before this
 * function ever runs.
 */
export function createSecretProvider(config: RelayConfig): SecretProvider {
  const provider = config.secrets.provider
  if (provider === 'keychain') return new KeychainSecretProvider()
  // The Linux keystore. Accepted here for the same reason 'keychain' is, and
  // 'env' still is not: both of these are OS keystores, so FR-SLA-6's
  // "never in an environment dump" holds on either platform.
  if (provider === 'libsecret') return new LibSecretProvider()
  throw new ConfigError('secrets.provider', `unknown secrets provider: ${String(provider)}`)
}
