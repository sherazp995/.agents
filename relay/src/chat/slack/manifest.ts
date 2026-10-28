/**
 * Generates the Slack app manifest an operator pastes into
 * api.slack.com/apps when creating the app "from a manifest". The bot scope
 * list comes from scopes.ts rather than being written out again here, so
 * the manifest and the doctor's slack-scopes check can never disagree about
 * what Relay is allowed to ask Slack for, per FR-SLA-4 and FR-SLA-5.
 */
import { SLACK_BOT_SCOPES } from './scopes.js'

export type BuildAppManifestOptions = {
  appName?: string
  description?: string
  backgroundColor?: string
  slashCommand?: string
  slashCommandDescription?: string
  slashCommandUsageHint?: string
}

const DEFAULT_APP_NAME = 'Relay'
const DEFAULT_DESCRIPTION = 'Chat driven computer use agent'
const DEFAULT_BACKGROUND_COLOR = '#2c2d30'
const DEFAULT_SLASH_COMMAND = '/relay'
const DEFAULT_SLASH_COMMAND_DESCRIPTION = 'Run a Relay task'
const DEFAULT_SLASH_COMMAND_USAGE_HINT = '[task]'

/**
 * Builds the manifest object Slack's app creation flow accepts, either as
 * JSON directly or converted to YAML by the caller. Socket Mode means no
 * request URL is ever declared, per FR-SLA-8: `event_subscriptions` names
 * only the bot events Relay listens for, with no `request_url` field at
 * all, and `socket_mode_enabled` is always true.
 *
 * The slash command is declared only to legitimately justify requesting the
 * `commands` scope; it is not wired up to any behaviour until phase 2
 * (FR-SL-9).
 */
export function buildAppManifest(opts: BuildAppManifestOptions = {}): object {
  const appName = opts.appName ?? DEFAULT_APP_NAME

  return {
    display_information: {
      name: appName,
      description: opts.description ?? DEFAULT_DESCRIPTION,
      background_color: opts.backgroundColor ?? DEFAULT_BACKGROUND_COLOR,
    },
    features: {
      bot_user: {
        display_name: appName,
        always_online: false,
      },
      // Without this block Slack defaults the Messages tab to read only,
      // which shows "Sending messages to this app has been turned off" and
      // makes DMs to the bot impossible. The bot can still post to you, so
      // the failure looks like a one way channel rather than a settings
      // problem, which is exactly the bug this block exists to prevent a
      // generated manifest from reintroducing.
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: opts.slashCommand ?? DEFAULT_SLASH_COMMAND,
          description: opts.slashCommandDescription ?? DEFAULT_SLASH_COMMAND_DESCRIPTION,
          usage_hint: opts.slashCommandUsageHint ?? DEFAULT_SLASH_COMMAND_USAGE_HINT,
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['app_mention', 'message.im', 'message.channels', 'message.groups'],
      },
      interactivity: {
        is_enabled: true,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }
}
