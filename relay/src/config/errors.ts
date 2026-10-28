/**
 * Raised when a configuration file is missing, malformed, or semantically
 * invalid. Relay fails closed on any of these, per FR-POL-2. The message
 * always names the file so the operator knows where to look.
 */
export class ConfigError extends Error {
  readonly filePath: string
  readonly reason: string

  constructor(filePath: string, reason: string) {
    super(`Invalid configuration in ${filePath}: ${reason}`)
    this.name = 'ConfigError'
    this.filePath = filePath
    this.reason = reason
  }
}
