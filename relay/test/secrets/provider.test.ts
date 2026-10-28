import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../../src/config/errors.js'
import type { RelayConfig } from '../../src/config/schema.js'
import { EnvSecretProvider } from '../../src/secrets/env.js'
import { KeychainSecretProvider } from '../../src/secrets/keychain.js'
import { createSecretProvider } from '../../src/secrets/index.js'
import { SecretNotFoundError } from '../../src/secrets/provider.js'
import { resetSecretScrubberForTests, scrubSecrets } from '../../src/secrets/scrubber.js'

// Distinctive sentinel so a leak into a message, a stack, or a
// serialisation is unmistakable and cannot be confused with ordinary test
// fixture text.
const SENTINEL = 'SUPERSECRET_VALUE_DO_NOT_LEAK'

/**
 * Builds a RelayConfig-shaped object for createSecretProvider tests without
 * going through loadRelayConfig, since some cases (an unknown provider
 * value) must exercise a value the real schema would already reject.
 */
function buildConfig(provider: string): RelayConfig {
  return {
    model_provider: { name: 'anthropic', zero_data_retention: true },
    database: { url: 'postgres://localhost:5432/relay' },
    redis: { url: 'redis://localhost:6379' },
    logging: { level: 'info' },
    secrets: { provider },
  } as unknown as RelayConfig
}

describe('EnvSecretProvider', () => {
  afterEach(() => {
    resetSecretScrubberForTests()
  })

  it('returns a stored value', async () => {
    const provider = new EnvSecretProvider({ RELAY_SECRET_FOO_BAR: 'the-value' })
    await expect(provider.get('foo-bar')).resolves.toBe('the-value')
  })

  it('rejects a missing name with SecretNotFoundError', async () => {
    const provider = new EnvSecretProvider({})
    await expect(provider.get('missing-name')).rejects.toBeInstanceOf(SecretNotFoundError)
  })

  it('never exposes the secret value in the thrown error message or stack', async () => {
    const env: NodeJS.ProcessEnv = { RELAY_SECRET_STORED_NAME: SENTINEL }
    const provider = new EnvSecretProvider(env)

    // A different, never-stored name.
    try {
      await provider.get('missing-name')
      throw new Error('expected get to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(SecretNotFoundError)
      expect((error as Error).message).not.toContain(SENTINEL)
      expect((error as Error).stack ?? '').not.toContain(SENTINEL)
      expect((error as Error).message).toContain('missing-name')
    }

    // The stored name, after unsetting it.
    delete env.RELAY_SECRET_STORED_NAME
    try {
      await provider.get('stored-name')
      throw new Error('expected get to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(SecretNotFoundError)
      expect((error as Error).message).not.toContain(SENTINEL)
      expect((error as Error).stack ?? '').not.toContain(SENTINEL)
      expect((error as Error).message).toContain('stored-name')
    }
  })

  it('has returns true then false correctly, and never throws', async () => {
    const env: NodeJS.ProcessEnv = { RELAY_SECRET_TOGGLE: 'value' }
    const provider = new EnvSecretProvider(env)
    await expect(provider.has('toggle')).resolves.toBe(true)
    delete env.RELAY_SECRET_TOGGLE
    await expect(provider.has('toggle')).resolves.toBe(false)
  })

  it('has kind "env"', () => {
    expect(new EnvSecretProvider({}).kind).toBe('env')
  })

  it('maps a hyphenated name to RELAY_SECRET_<NAME> by upper-casing and turning non-alphanumerics into underscores', async () => {
    const provider = new EnvSecretProvider({ RELAY_SECRET_RELAY_SLACK_BOT_TOKEN: 'a-token' })
    await expect(provider.get('relay-slack-bot-token')).resolves.toBe('a-token')
  })

  it('never exposes a secret value when the provider itself is JSON.stringified', () => {
    const provider = new EnvSecretProvider({ RELAY_SECRET_STORED_NAME: SENTINEL })
    expect(JSON.stringify(provider)).not.toContain(SENTINEL)
  })

  it('never exposes a secret value when a thrown error is JSON.stringified', async () => {
    const provider = new EnvSecretProvider({ RELAY_SECRET_STORED_NAME: SENTINEL })
    try {
      await provider.get('missing-name')
      throw new Error('expected get to reject')
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(SENTINEL)
    }
  })

  /**
   * FR-SEC-1 backstop (src/secrets/scrubber.ts): `get` is the single choke
   * point every env-sourced secret value passes through, so registering the
   * value there, rather than at each call site that later builds output, is
   * what makes scrubbing the default instead of something every future
   * caller has to opt into. This proves the registration actually happens,
   * not just that it is described in a comment: scrubSecrets could not
   * redact this value at all unless `get` had registered it.
   */
  it('registers the value it returns with the secret scrubber, so a future output boundary can redact it', async () => {
    const provider = new EnvSecretProvider({ RELAY_SECRET_STORED_NAME: SENTINEL })

    await provider.get('stored-name')

    expect(scrubSecrets(`leaked in some unrelated error: ${SENTINEL}`)).not.toContain(SENTINEL)
  })
})

describe('createSecretProvider', () => {
  it('creates a KeychainSecretProvider for the "keychain" provider', () => {
    const provider = createSecretProvider(buildConfig('keychain'))
    expect(provider).toBeInstanceOf(KeychainSecretProvider)
    expect(provider.kind).toBe('keychain')
  })

  // This used to assert createSecretProvider('env') built an
  // EnvSecretProvider: that pinned exactly the behaviour FR-SLA-6 forbids
  // in production, an environment-sourced secret reachable through runtime
  // configuration. The schema no longer accepts 'env' at all (see
  // src/config/schema.ts), so 'env' now behaves like any other value the
  // schema would reject: createSecretProvider fails closed on it, the same
  // as the 'bogus' case below. EnvSecretProvider itself is still fully
  // usable, just never through config; the suite above constructs it
  // directly.
  it('fails closed with ConfigError when config asks for the removed "env" provider, rather than building an EnvSecretProvider from it', () => {
    expect(() => createSecretProvider(buildConfig('env'))).toThrow(ConfigError)
  })

  it('fails closed with ConfigError on an unknown provider value, rather than silently defaulting', () => {
    expect(() => createSecretProvider(buildConfig('bogus'))).toThrow(ConfigError)
  })
})
