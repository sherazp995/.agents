/**
 * The folder a Slack channel's description (its "purpose") names, read fresh
 * for every new thread so an edited description applies to the next one.
 *
 * Read through conversations.info, which needs channels:read (public) and
 * groups:read (private), both in SLACK_BOT_SCOPES. A DM has no description.
 * Every failure is reported, never mistaken for "no folder": a session must
 * not start elsewhere when the channel's folder could not be read.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebClient } from '@slack/web-api'

export type ChannelFolderLookup =
  /** A DM, or a description that names no folder. */
  | { kind: 'none' }
  /** The first folder path in the description, with `~/` expanded; it may not exist on this machine. */
  | { kind: 'folder'; path: string }
  /** The description could not be read. `missingScope` means the Slack app has not been reinstalled with channels:read/groups:read. */
  | { kind: 'failed'; missingScope: boolean }

/** Returns the channel's description text. */
export type FetchChannelPurpose = (channel: string) => Promise<string>

/** One lookup stays well inside one inbound event: deliveries share a queue, so a hung call would hold up every other conversation. */
export const CHANNEL_LOOKUP_TIMEOUT_MS = 5_000

export function slackChannelPurpose(botToken: string): FetchChannelPurpose {
  const client = new WebClient(botToken, { rejectRateLimitedCalls: true, timeout: CHANNEL_LOOKUP_TIMEOUT_MS, retryConfig: { retries: 0 } })
  return async (channel) => {
    const result = await client.conversations.info({ channel })
    return result.channel?.purpose?.value ?? ''
  }
}

/** Reads the bot token on first use, so a token that cannot be read fails that lookup (and refuses that thread) rather than startup. */
export function lazySlackChannelPurpose(botToken: () => Promise<string>): FetchChannelPurpose {
  let fetchPurpose: FetchChannelPurpose | undefined
  return async (channel) => {
    fetchPurpose ??= slackChannelPurpose(await botToken())
    return fetchPurpose(channel)
  }
}

export async function lookupChannelFolder(
  fetchPurpose: FetchChannelPurpose,
  channel: string,
  options: { home?: string; timeoutMs?: number } = {},
): Promise<ChannelFolderLookup> {
  if (channel.startsWith('D')) return { kind: 'none' }
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('channel description lookup timed out')), options.timeoutMs ?? CHANNEL_LOOKUP_TIMEOUT_MS)
    })
    const purpose = await Promise.race([fetchPurpose(channel), timeout])
    const named = firstFolderPath(purpose)
    if (named === undefined) return { kind: 'none' }
    return { kind: 'folder', path: expandFolderPath(named, options.home ?? homedir()) }
  } catch (error) {
    return { kind: 'failed', missingScope: isMissingScope(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The first `~/` or absolute path in a description, in text order. A quoted
 * path may hold spaces; a bare one ends at whitespace and loses trailing
 * punctuation ("from ~/code/web." names ~/code/web). A URL is never a path:
 * its slashes follow "https:", not a space, and Slack's <url|label> markup
 * starts with "<".
 */
export function firstFolderPath(description: string): string | undefined {
  const text = decodeSlackEntities(description)
  // A quoted path ends only at its own closing quote, so "/srv/team's repo" keeps its apostrophe.
  const match = /(["'`])((?:~\/|\/)(?:(?!\1)[^\n])*)\1|(?:^|[\s(])(~\/[^\s`'"()<>]*|\/[^\s`'"()<>]+)/.exec(text)
  if (!match) return undefined
  if (match[2] !== undefined) return match[2] === '/' ? undefined : match[2]
  const bare = (match[3] ?? '').replace(/[.,;:!?]+$/, '')
  // `~/` alone is the home folder. A bare `/` is never the whole disk: it is prose, as in "frontend / backend".
  return bare === '/' || bare === '' ? undefined : bare
}

/** `~/` becomes the home folder; anything else is resolved as written. */
export function expandFolderPath(named: string, home: string): string {
  return named.startsWith('~/') ? join(home, named.slice(2)) : resolve(named)
}

/** Slack escapes these three in message and purpose text. */
function decodeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** @slack/web-api reports a Slack `{ ok: false, error }` answer as a platform error carrying `data.error`. */
function isMissingScope(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const data = (error as { data?: { error?: unknown } }).data
  return data?.error === 'missing_scope'
}
