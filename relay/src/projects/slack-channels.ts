/**
 * The Slack channels the bot is in, public and private, for the project
 * page's channel picker: Slack's users.conversations, paged by cursor. A
 * project may only name a channel from this list.
 */

import { WebClient } from '@slack/web-api'

export type SlackChannel = { readonly id: string; readonly name: string }
export type ChannelPage = { readonly channels: readonly SlackChannel[]; readonly nextCursor?: string }
export type FetchChannelPage = (cursor: string | undefined) => Promise<ChannelPage>

export type ChannelList = { readonly kind: 'ok'; readonly channels: readonly SlackChannel[] } | { readonly kind: 'failed'; readonly message: string }

const PAGE_LIMIT = 200
const MAX_PAGES = 50
const TIMEOUT_MS = 10_000

export const MISSING_SCOPE_MESSAGE =
  'Slack refused to list the bot\'s channels: reinstall the Slack app from `docs/slack-app-manifest.yaml`, which asks for `channels:read` and `groups:read`.'

export function slackChannelPages(botToken: () => Promise<string>): FetchChannelPage {
  let client: WebClient | undefined
  return async (cursor) => {
    client ??= new WebClient(await botToken(), { timeout: TIMEOUT_MS, retryConfig: { retries: 1 } })
    const result = await client.users.conversations({ types: 'public_channel,private_channel', exclude_archived: true, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) })
    const channels = (result.channels ?? []).flatMap((channel) => (channel.id && channel.name ? [{ id: channel.id, name: channel.name }] : []))
    const next = result.response_metadata?.next_cursor
    return { channels, ...(next ? { nextCursor: next } : {}) }
  }
}

/** Every page, sorted by name; a Slack error becomes a message the page can show. */
export async function listBotChannels(fetchPage: FetchChannelPage): Promise<ChannelList> {
  const channels: SlackChannel[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await fetchPage(cursor)
      channels.push(...result.channels)
      cursor = result.nextCursor
      if (cursor === undefined) break
    }
  } catch (error) {
    const code = (error as { data?: { error?: unknown } } | null)?.data?.error
    return { kind: 'failed', message: code === 'missing_scope' ? MISSING_SCOPE_MESSAGE : `Could not list Slack channels: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { kind: 'ok', channels: channels.sort((a, b) => a.name.localeCompare(b.name)) }
}
