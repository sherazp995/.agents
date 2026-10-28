import { SecretNotFoundError } from './provider.js'
import type { SecretProvider } from './provider.js'
import { registerSecretValue } from './scrubber.js'

/**
 * Maps a secret name to the environment variable that holds it: upper-case
 * the name, replace every character that is not a letter or digit with an
 * underscore, then prefix with RELAY_SECRET_. For example the name
 * "relay-slack-bot-token" maps to the variable
 * RELAY_SECRET_RELAY_SLACK_BOT_TOKEN.
 */
function envVarFor(name: string): string {
  return `RELAY_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * Reads secrets from environment variables, for local development and CI
 * where a Keychain is not available. The environment map is a private
 * class field (`#env`), so it never becomes an own enumerable property and
 * is invisible to `JSON.stringify` and `Object.keys`, per FR-SEC-1: an
 * accidental `logger.info({ provider })` cannot leak a value this way.
 */
export class EnvSecretProvider implements SecretProvider {
  readonly kind: 'env' = 'env'
  readonly #env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env
  }

  async get(name: string): Promise<string> {
    const value = this.#env[envVarFor(name)]
    if (value === undefined) throw new SecretNotFoundError(name)
    // Registers the value with the process-wide scrubber (src/secrets/scrubber.js)
    // before returning it, so any output built later, even one that skips
    // redacting at its own construction site, still gets this value scrubbed
    // at the output boundary. This is the single choke point every env
    // secret passes through, so registering here is what makes that
    // protection the default rather than something each caller opts into.
    registerSecretValue(value)
    return value
  }

  async has(name: string): Promise<boolean> {
    return this.#env[envVarFor(name)] !== undefined
  }
}
