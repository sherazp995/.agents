/**
 * The Phase 0 minimum Slack bot scope set, per FR-SLA-4. This is the single
 * source of truth: the app manifest (manifest.ts) generates its requested
 * scopes from this list, and the doctor's slack-scopes check
 * (src/doctor/checks/slack.ts) compares granted scopes against this same
 * list, so the two can never drift apart the way a hand copied duplicate
 * would eventually let them.
 *
 * Deliberately excludes every workspace wide read scope, per FR-SLA-5: no
 * search:read, no users:read.email. Relay only ever sees the channels it is
 * invited to plus its own DMs.
 */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'im:history',
  'im:read',
  'im:write',
  'channels:history',
  'groups:history',
  'files:read',
  'files:write',
  'reactions:read',
  'reactions:write',
  'commands',
] as const

/** One scope from the declared minimum set. */
export type SlackBotScope = (typeof SLACK_BOT_SCOPES)[number]

/**
 * Workspace wide read scopes Relay must never request, named explicitly so
 * a test can assert their absence rather than only asserting the positive
 * list, per FR-SLA-5. Kept next to SLACK_BOT_SCOPES so a reviewer sees both
 * lists together instead of the forbidden set living only inside a test.
 */
export const FORBIDDEN_WORKSPACE_WIDE_SCOPES = ['search:read', 'users:read.email'] as const
