/**
 * Each thread's Playwright extension token and Chrome profile. A channel's
 * come from its Slack description: a line
 * `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<token>` gives that channel's workers the
 * token, and a line `PLAYWRIGHT_MCP_PROFILE_DIR_NAME="Profile 16"` names the
 * Chrome profile the extension connects to (Default or Profile N, quoted
 * because of its space); without it Playwright picks the last used profile
 * that has the extension, which can be another project's. A description is
 * read when a worker starts and again before a new message joins a running
 * one, so removing the line stops the token from the next message on.
 *
 * A DM has no description: the owner sends the same lines in a message of the
 * thread, and the router remembers them here for that thread, in memory only,
 * until a Relay restart. A later message with the lines replaces both values.
 * Attached CLI chats (the courier) are not covered: they run on the
 * operator's own environment.
 */
import type { Logger } from '../obs/logger.js'
import { registerSecretValue } from '../secrets/scrubber.js'

export const EXTENSION_TOKEN_ENV = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN'
export const EXTENSION_PROFILE_ENV = 'PLAYWRIGHT_MCP_PROFILE_DIR_NAME'
const READ_TIMEOUT_MS = 5_000

/** The token the first `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` line names, with surrounding quotes or backticks stripped. */
export function extensionTokenIn(description: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s\`'"])${EXTENSION_TOKEN_ENV}=([^\\s]+)`).exec(description)
  const value = (match?.[1] ?? '').replace(/^[`'"]+|[`'"]+$/g, '')
  return value === '' ? undefined : value
}

/** A Chrome profile directory name, and nothing else: Default or Profile N. */
const PROFILE_DIR = /^(Default|Profile \d+)$/

/**
 * The profile the first `PLAYWRIGHT_MCP_PROFILE_DIR_NAME=` line names. Its value
 * holds a space, so it is read inside straight or curly double quotes, single
 * quotes or backticks (Slack may curl typed quotes), or bare up to the next
 * space or quote. Anything that is not a profile directory name gives none.
 */
export function extensionProfileIn(description: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s\`'"])${EXTENSION_PROFILE_ENV}=(?:"([^"]*)"|\u201c([^\u201d]*)\u201d|'([^']*)'|\`([^\`]*)\`|([^\\s\`'"\u201d]+))`).exec(description)
  const value = (match?.slice(1).find((group) => group !== undefined) ?? '').trim()
  return PROFILE_DIR.test(value) ? value : undefined
}

/** What a channel's description sets for the extension; either may be absent. */
export type ChannelBrowser = { token?: string; profile?: string }

/** Stored in place of a message that held nothing but the extension lines, so the turn it starts is not empty. */
export const EXTENSION_ONLY_NOTE = '(set the Playwright extension variables)'

/** Every `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` or `PLAYWRIGHT_MCP_PROFILE_DIR_NAME=` word, its quoted or bare value, and backticks around it. */
const EXTENSION_WORD = new RegExp(
  `(^|[\\s'"])\`?(?:${EXTENSION_TOKEN_ENV}|${EXTENSION_PROFILE_ENV})=(?:"[^"\\n]*"|\u201c[^\u201d\\n]*\u201d|'[^'\\n]*'|\`[^\`\\n]*\`|[^\\s\`]*)\`?`,
  'g',
)

/** The text with every extension word removed, valid or not. Unchanged when it holds none. */
export function withoutExtensionLines(text: string): string {
  const stripped = text.replace(EXTENSION_WORD, '$1')
  if (stripped === text) return text
  return stripped.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').trim()
}

/**
 * A message's extension values and its text without the extension words.
 * `found` is true when any extension word was there, even one whose value is
 * not usable. The token is registered for scrubbing before anything can log or post it.
 */
export function takeExtensionLines(text: string): { text: string; found: boolean; browser: ChannelBrowser } {
  const rest = withoutExtensionLines(text)
  if (rest === text) return { text, found: false, browser: {} }
  const token = extensionTokenIn(text)
  const profile = extensionProfileIn(text)
  if (token !== undefined) registerSecretValue(token)
  return {
    text: rest === '' ? EXTENSION_ONLY_NOTE : rest,
    found: true,
    browser: { ...(token !== undefined ? { token } : {}), ...(profile !== undefined ? { profile } : {}) },
  }
}

export type ExtensionTokenDeps = {
  /** The channel's description text. */
  readPurpose(channel: string): Promise<string>
  log: Logger
  timeoutMs?: number
}

export type ExtensionTokens = {
  /** The token and profile for a worker starting in `threadRef` (`<channel>:<thread>`); remembered for `taskId` so a later message can be checked against them. */
  forWorker(taskId: string, threadRef: string): Promise<ChannelBrowser>
  /** True when the thread's token or profile is no longer the one `taskId`'s worker started with. */
  changedSince(taskId: string, threadRef: string): Promise<boolean>
  /** Sets or replaces the values a DM thread's workers start with. */
  rememberDm(threadRef: string, browser: ChannelBrowser): void
  /** Drops what is kept for a task and its thread, once the task has stopped. */
  forget(taskId: string, threadRef: string): void
}

export function createExtensionTokens(deps: ExtensionTokenDeps): ExtensionTokens {
  const startedWith = new Map<string, ChannelBrowser>()
  const dmValues = new Map<string, ChannelBrowser>()
  const fromDescription = async (channel: string): Promise<ChannelBrowser> => {
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('channel description lookup timed out')), deps.timeoutMs ?? READ_TIMEOUT_MS)
      })
      const description = await Promise.race([deps.readPurpose(channel), timeout])
      const token = extensionTokenIn(description)
      const profile = extensionProfileIn(description)
      // Registered before anything can log or post it.
      if (token !== undefined) registerSecretValue(token)
      return { ...(token !== undefined ? { token } : {}), ...(profile !== undefined ? { profile } : {}) }
    } catch (error) {
      deps.log.warn({ err: error, channel }, 'could not read the channel description; the worker starts without an extension token')
      return {}
    } finally {
      clearTimeout(timer)
    }
  }
  const current = async (threadRef: string): Promise<ChannelBrowser> => {
    // A thread ref is `<channel>:<thread>`.
    const channel = threadRef.split(':')[0] ?? ''
    if (channel === '') return {}
    if (channel.startsWith('D')) return dmValues.get(threadRef) ?? {}
    return fromDescription(channel)
  }
  return {
    async forWorker(taskId, threadRef) {
      const browser = await current(threadRef)
      startedWith.set(taskId, browser)
      return browser
    },
    async changedSince(taskId, threadRef) {
      const before = startedWith.get(taskId)
      if (before === undefined) return false
      const now = await current(threadRef)
      return now.token !== before.token || now.profile !== before.profile
    },
    rememberDm(threadRef, browser) {
      dmValues.set(threadRef, browser)
    },
    forget(taskId, threadRef) {
      startedWith.delete(taskId)
      dmValues.delete(threadRef)
    },
  }
}
