/**
 * The playwright-extension grant. The extension token is the user's own
 * credential for their real Chrome, so it arrives per task in the thread,
 * from the requester or an operator, and is kept only in relay's keystore.
 * Its value is replaced with `[redacted]` before the message text is stored,
 * rendered for the worker or logged, and registered with the scrubber so no
 * relay post can carry it.
 */

export const EXTENSION_TOKEN_VAR = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN'
export const EXTENSION_SERVER = 'playwright-extension'
const REDACTED = '[redacted]'

const ASSIGNMENT = new RegExp(`${EXTENSION_TOKEN_VAR}\\s*=\\s*['"\`]?([^\\s'"\`]+)['"\`]?`, 'g')

export type ExtensionTokenParse = {
  /** The text with every token value replaced by `[redacted]`. */
  text: string
  /** The last value assigned in the text, if any. */
  token: string | null
}

export function parseExtensionToken(text: string): ExtensionTokenParse {
  let token: string | null = null
  const redacted = text.replace(ASSIGNMENT, (_match, value: string) => {
    token = value
    return `${EXTENSION_TOKEN_VAR}=${REDACTED}`
  })
  return { text: redacted, token }
}

/** The keystore item holding a task's extension token. */
export function extensionTokenKey(taskId: string): string {
  return `task/${taskId}/playwright_extension_token`
}

/** The part of relay's keystore the grant uses. */
export interface TaskSecretStore {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}
