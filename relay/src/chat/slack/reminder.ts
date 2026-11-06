/**
 * Slackbot channel reminders addressed to Relay. A reminder set with
 * "/remind #channel @Relay ..." fires as a root message Slackbot posts in the
 * channel: `user` is USLACKBOT, `bot_id` is set, there is no subtype, and the
 * text starts "Reminder: " and carries Relay's mention token. See the real
 * one in test/fixtures/slack/reminder-event.json.
 *
 * Such a message has no author Relay can map to a principal, so the operator
 * names, per channel, the Slack user it runs as (config `slack.reminders`).
 * Anyone who can set a reminder in that channel can therefore make Relay run
 * as that user; the task it starts is read-only for that reason.
 *
 * Slackbot also posts custom auto-responses, which any workspace member can
 * define, so the reminder text prefix is required and the reminder metadata
 * type, when Slack includes metadata, must match.
 */
import { mentionsUser } from './api-client.js'
import type { SlackRawEvent } from './types.js'

export const SLACKBOT_USER_ID = 'USLACKBOT'
const REMINDER_PREFIX = 'Reminder: '
const REMINDER_METADATA_TYPE = 'slack_system.reminders.posted_in_channel'

/** Channel id to the Slack user id a reminder in that channel runs as. */
export type ReminderChannels = ReadonlyMap<string, string>

/** The Slack user a reminder runs as, or undefined when `event` is not a reminder Relay takes. */
export function reminderActAs(event: SlackRawEvent, params: { channel: string; ts: string; botUserId: string; channels: ReminderChannels }): string | undefined {
  const actAs = params.channels.get(params.channel)
  if (actAs === undefined) return undefined
  if (event.user !== SLACKBOT_USER_ID || event.subtype !== undefined) return undefined
  if (event.thread_ts !== undefined && event.thread_ts !== params.ts) return undefined
  const text = typeof event.text === 'string' ? event.text : ''
  if (!text.startsWith(REMINDER_PREFIX) || !mentionsUser(text, params.botUserId)) return undefined
  if (!metadataAllowsReminder(event.metadata)) return undefined
  return actAs
}

function metadataAllowsReminder(metadata: unknown): boolean {
  if (metadata === undefined) return true
  return typeof metadata === 'object' && metadata !== null && (metadata as { event_type?: unknown }).event_type === REMINDER_METADATA_TYPE
}
