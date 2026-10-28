/**
 * The Slack thread a task lives in, read when a turn starts a fresh Claude
 * session (a new task, a rejected resume, an account switch). Without it a
 * mention halfway down a thread, or a reply under a `relay notify` DM,
 * reaches a worker that has only the one new message.
 *
 * Read with the bot token through conversations.replies, which needs the
 * channels/groups/im history scopes relay already requests.
 */

import { WebClient } from '@slack/web-api'

export type ThreadMessage = { ts: string; text: string; user?: string; bot: boolean }
export type FetchThreadReplies = (channel: string, thread: string) => Promise<ThreadMessage[]>

/** Enough to give the worker the conversation without flooding its first turn. */
const MAX_MESSAGES = 50
const MAX_CHARS = 20_000

export function slackThreadReplies(botToken: string): FetchThreadReplies {
  const client = new WebClient(botToken, { rejectRateLimitedCalls: true })
  return async (channel, thread) => {
    const messages: ThreadMessage[] = []
    let cursor: string | undefined
    do {
      const page = await client.conversations.replies({ channel, ts: thread, limit: 200, ...(cursor ? { cursor } : {}) })
      for (const message of page.messages ?? []) {
        if (typeof message.ts !== 'string') continue
        messages.push({ ts: message.ts, text: message.text ?? '', bot: message.bot_id !== undefined, ...(message.user ? { user: message.user } : {}) })
      }
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor)
    return messages
  }
}

/** The messages before `beforeTs` (the first one the worker gets anyway), newest kept when trimmed; null when there are none. */
export function renderThreadHistory(messages: readonly ThreadMessage[], beforeTs: string | null): string | null {
  const earlier = messages.filter((message) => beforeTs === null || Number(message.ts) < Number(beforeTs))
  const lines = earlier.slice(-MAX_MESSAGES).map((message) => `- ${message.bot ? 'relay (you)' : (message.user ?? 'someone')}: ${message.text}`)
  while (lines.length > 1 && lines.join('\n').length > MAX_CHARS) lines.shift()
  return lines.length === 0 ? null : lines.join('\n')
}
