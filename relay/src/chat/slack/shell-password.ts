/**
 * The Slack side of a shell command's sudo password (src/shell/types.ts,
 * ShellPasswordPort): the reply's "Enter password" and "Cancel" buttons, the
 * popup the first one opens, and that popup's submission. SlackAdapter.start()
 * registers the three handlers, outside its delivery queue.
 *
 * The password exists only inside handleShellPasswordSubmission, on its way
 * to `port.submit`. It is never logged, never put in an error, never stored:
 * no handler here logs `envelope.view`, its state, or an error the port threw
 * while holding the password.
 */
import type { Logger } from '../../obs/logger.js'
import type { ShellPasswordPort } from '../../shell/types.js'
import type { SlackApiClient, SlackBlockActionEnvelope, SlackViewSubmissionEnvelope, SlackViewSubmissionResponse } from './types.js'

export const SHELL_PASSWORD_ACTION_IDS = {
  enter: 'relay_shell_password_enter',
  cancel: 'relay_shell_password_cancel',
} as const
export const SHELL_PASSWORD_CALLBACK_ID = 'relay_shell_password_modal'
export const SHELL_PASSWORD_BLOCK_ID = 'relay_shell_password_block'
export const SHELL_PASSWORD_INPUT_ACTION_ID = 'relay_shell_password_input'

/** The popup's inline error when anything goes wrong before the password reached sudo. */
export const SHELL_PASSWORD_GENERIC_ERROR = 'Something went wrong; the password was not sent. Please try again.'
const REFUSED_ERROR = 'Only the owner who ran this command can answer.'
const EXPIRED_ERROR = 'This password request has ended.'
const EMPTY_ERROR = 'Type the password.'

/** `port` is undefined when no shell password handler is wired: every click and submission is then refused with a log line. */
export type ShellPasswordContext = {
  port: ShellPasswordPort | undefined
  apiClient: SlackApiClient
  log: Logger | undefined
}

/** A shell reply as Slack blocks: its Markdown, plus the password buttons while `passwordRequestId` waits for an answer. */
export function shellReplyBlocks(text: string, passwordRequestId?: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [{ type: 'markdown', text }]
  if (passwordRequestId === undefined) return blocks
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: SHELL_PASSWORD_ACTION_IDS.enter,
        style: 'primary',
        text: { type: 'plain_text', text: 'Enter password' },
        value: passwordRequestId,
      },
      {
        type: 'button',
        action_id: SHELL_PASSWORD_ACTION_IDS.cancel,
        text: { type: 'plain_text', text: 'Cancel' },
        value: passwordRequestId,
      },
    ],
  })
  return blocks
}

function passwordModal(requestId: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: SHELL_PASSWORD_CALLBACK_ID,
    private_metadata: JSON.stringify({ requestId }),
    title: { type: 'plain_text', text: 'sudo password' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: SHELL_PASSWORD_BLOCK_ID,
        label: { type: 'plain_text', text: 'Password (shown as you type)' },
        element: { type: 'plain_text_input', action_id: SHELL_PASSWORD_INPUT_ACTION_ID, multiline: false },
      },
    ],
  }
}

/** The "Enter password" button: opens the popup, only for a user the port says may answer. */
export async function handleShellPasswordButton(ctx: ShellPasswordContext, envelope: SlackBlockActionEnvelope): Promise<void> {
  const requestId = envelope.actions[0]?.value
  const platformUserId = envelope.user.id
  if (!requestId) {
    ctx.log?.warn({ platformUserId }, 'SlackAdapter: shell password button carried no request id; ignoring')
    return
  }
  if (!ctx.port) {
    ctx.log?.warn({ platformUserId }, 'SlackAdapter: no shell password handler is wired; ignoring the password button')
    return
  }
  try {
    if (!(await ctx.port.canAnswer({ requestId, platformUserId }))) {
      ctx.log?.warn({ platformUserId }, 'SlackAdapter: shell password button refused: not the owner, or the request ended')
      return
    }
    if (!envelope.trigger_id) {
      ctx.log?.warn({ platformUserId }, 'SlackAdapter: shell password button carried no trigger_id; cannot open the popup')
      return
    }
    // Straight to the client, not through #callApi: a trigger_id lasts a few seconds, so a rate limit wait would only open nothing later.
    await ctx.apiClient.openModal({ triggerId: envelope.trigger_id, view: passwordModal(requestId) })
  } catch (error) {
    ctx.log?.error({ err: error, platformUserId }, 'SlackAdapter: shell password button failed')
  }
}

/** The "Cancel" button: sudo fails at once, when the port accepts this user. */
export async function handleShellPasswordCancel(ctx: ShellPasswordContext, envelope: SlackBlockActionEnvelope): Promise<void> {
  const requestId = envelope.actions[0]?.value
  const platformUserId = envelope.user.id
  if (!requestId) {
    ctx.log?.warn({ platformUserId }, 'SlackAdapter: shell password cancel carried no request id; ignoring')
    return
  }
  if (!ctx.port) {
    ctx.log?.warn({ platformUserId }, 'SlackAdapter: no shell password handler is wired; ignoring the cancel button')
    return
  }
  try {
    const outcome = await ctx.port.cancel({ requestId, platformUserId })
    ctx.log?.info({ platformUserId, outcome }, 'SlackAdapter: shell password cancel handled')
  } catch (error) {
    ctx.log?.error({ err: error, platformUserId }, 'SlackAdapter: shell password cancel failed')
  }
}

function inlineError(text: string): SlackViewSubmissionResponse {
  return { response_action: 'errors', errors: { [SHELL_PASSWORD_BLOCK_ID]: text } }
}

function readRequestId(privateMetadata: string): string | undefined {
  try {
    const parsed = JSON.parse(privateMetadata) as { requestId?: unknown }
    return typeof parsed.requestId === 'string' && parsed.requestId !== '' ? parsed.requestId : undefined
  } catch {
    return undefined
  }
}

/**
 * The popup's Send. Never throws: createLiveSlackBoltApp acks with whatever
 * this returns, and `undefined` (close the popup) only means the waiting sudo
 * got the password. Everything else keeps the popup open with an inline error.
 */
export async function handleShellPasswordSubmission(ctx: ShellPasswordContext, envelope: SlackViewSubmissionEnvelope): Promise<SlackViewSubmissionResponse> {
  const platformUserId = envelope.user.id
  try {
    const requestId = readRequestId(envelope.view.private_metadata)
    if (requestId === undefined) {
      ctx.log?.error({ platformUserId }, 'SlackAdapter: shell password popup carried malformed private_metadata')
      return inlineError(SHELL_PASSWORD_GENERIC_ERROR)
    }
    if (!ctx.port) {
      ctx.log?.warn({ platformUserId }, 'SlackAdapter: no shell password handler is wired; refusing the popup')
      return inlineError(SHELL_PASSWORD_GENERIC_ERROR)
    }
    const password = envelope.view.state.values[SHELL_PASSWORD_BLOCK_ID]?.[SHELL_PASSWORD_INPUT_ACTION_ID]?.value
    if (!password) return inlineError(EMPTY_ERROR)

    const outcome = await ctx.port.submit({ requestId, platformUserId, password })
    ctx.log?.info({ platformUserId, outcome }, 'SlackAdapter: shell password popup handled')
    if (outcome === 'accepted') return undefined
    return inlineError(outcome === 'refused' ? REFUSED_ERROR : EXPIRED_ERROR)
  } catch (error) {
    // Only the error's name: whatever threw held the password, so its message or fields could carry it.
    const errorName = error instanceof Error ? error.name : typeof error
    ctx.log?.error({ platformUserId, errorName }, 'SlackAdapter: shell password popup failed')
    return inlineError(SHELL_PASSWORD_GENERIC_ERROR)
  }
}
