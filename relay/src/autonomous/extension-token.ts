/**
 * Each channel's Playwright extension token, from its Slack description. A
 * line `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<token>` in the description gives that
 * channel's workers the token; no line, a DM or a description that cannot be
 * read gives none. Read when a worker starts and again before a new message
 * joins a running one, so removing the line stops the token from the next
 * message on. Attached CLI chats (the courier) are not covered: they run on
 * the operator's own environment.
 */
import type { Logger } from '../obs/logger.js'
import { registerSecretValue } from '../secrets/scrubber.js'

export const EXTENSION_TOKEN_ENV = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN'
const READ_TIMEOUT_MS = 5_000

/** The token the first `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` line names, with surrounding quotes or backticks stripped. */
export function extensionTokenIn(description: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s\`'"])${EXTENSION_TOKEN_ENV}=([^\\s]+)`).exec(description)
  const value = (match?.[1] ?? '').replace(/^[`'"]+|[`'"]+$/g, '')
  return value === '' ? undefined : value
}

export type ExtensionTokenDeps = {
  /** The channel's description text. */
  readPurpose(channel: string): Promise<string>
  log: Logger
  timeoutMs?: number
}

export type ExtensionTokens = {
  /** The token for a worker starting in `channel`; remembered for `taskId` so a later message can be checked against it. */
  forWorker(taskId: string, channel: string): Promise<string | undefined>
  /** True when the channel's token is no longer the one `taskId`'s worker started with. */
  changedSince(taskId: string, channel: string): Promise<boolean>
}

export function createExtensionTokens(deps: ExtensionTokenDeps): ExtensionTokens {
  const startedWith = new Map<string, string | undefined>()
  const current = async (channel: string): Promise<string | undefined> => {
    if (channel === '' || channel.startsWith('D')) return undefined
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('channel description lookup timed out')), deps.timeoutMs ?? READ_TIMEOUT_MS)
      })
      const token = extensionTokenIn(await Promise.race([deps.readPurpose(channel), timeout]))
      // Registered before anything can log or post it.
      if (token !== undefined) registerSecretValue(token)
      return token
    } catch (error) {
      deps.log.warn({ err: error, channel }, 'could not read the channel description; the worker starts without an extension token')
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    async forWorker(taskId, channel) {
      const token = await current(channel)
      startedWith.set(taskId, token)
      return token
    },
    async changedSince(taskId, channel) {
      if (!startedWith.has(taskId)) return false
      return (await current(channel)) !== startedWith.get(taskId)
    },
  }
}
