/**
 * A named secret retrieval seam. Concrete implementations read a Keychain
 * item or an environment variable; callers ask for a secret by name and
 * receive its value only from the return of `get`, so a value never has
 * to pass through a log line, an error message, or a serialised object.
 */
export interface SecretProvider {
  get(name: string): Promise<string>
  has(name: string): Promise<boolean>
  readonly kind: 'keychain' | 'libsecret' | 'env'
}

/**
 * Raised when a secret cannot be found. Stores the secret's NAME only,
 * never its value, so the message and stack of this error are always safe
 * to log, per FR-SEC-1. Deliberately has no `toJSON`: the default
 * `Error.prototype` serialisation already includes only this error's own
 * enumerable fields (`name`, `name_`), and adding one could only widen
 * what a `JSON.stringify` of the error exposes.
 */
export class SecretNotFoundError extends Error {
  readonly name_: string

  constructor(name: string) {
    super(`Secret not found: ${name}`)
    this.name = 'SecretNotFoundError'
    this.name_ = name
  }
}
