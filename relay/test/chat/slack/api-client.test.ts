import { App } from '@slack/bolt'
import { describe, expect, it, vi } from 'vitest'
import { CONFIRM_MODAL_BLOCK_ID, CONFIRM_MODAL_CALLBACK_ID, EDIT_MODAL_BLOCK_ID, EDIT_MODAL_CALLBACK_ID } from '../../../src/approvals/blockkit.js'
import { createGatedSocketModeReceiver, viewFallbackErrors } from '../../../src/chat/slack/api-client.js'
import { SHELL_PASSWORD_BLOCK_ID, SHELL_PASSWORD_CALLBACK_ID, SHELL_PASSWORD_GENERIC_ERROR } from '../../../src/chat/slack/shell-password.js'
import type { FailoverGate } from '../../../src/failover/types.js'

/**
 * Bolt's real App and SocketModeReceiver; only the websocket is replaced, by
 * emitting the event the Socket Mode client emits for a delivered envelope.
 */
async function deliverMention(gate: FailoverGate): Promise<{ ack: ReturnType<typeof vi.fn>; heard: string[] }> {
  const receiver = createGatedSocketModeReceiver('xapp-test', gate)
  const app = new App({ receiver, authorize: async () => ({ botToken: 'xoxb-test', botUserId: 'UBOT' }) })
  const heard: string[] = []
  app.event('app_mention', async ({ event }) => void heard.push(event.text))

  const ack = vi.fn(async () => {})
  receiver.client.emit('slack_event', {
    ack,
    retry_num: 0,
    retry_reason: '',
    body: {
      type: 'event_callback',
      team_id: 'T1',
      api_app_id: 'A1',
      event_id: 'Ev1',
      event_time: 1,
      event: { type: 'app_mention', user: 'U1', text: '<@UBOT> hi', ts: '1.1', channel: 'C1', event_ts: '1.1' },
    },
  })
  // A refused event is never acknowledged, so the wait is for the gate's answer or the ack.
  await vi.waitFor(() => expect(ack.mock.calls.length + (gate.holdsFresh as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0))
  // Let Bolt finish dispatching to listeners after its ack.
  await new Promise((resolve) => setImmediate(resolve))
  return { ack, heard }
}

function gate(fresh: boolean): FailoverGate {
  return { host: 'zubair', holdsFresh: vi.fn(() => fresh), mayStartWork: async () => fresh }
}

describe('createGatedSocketModeReceiver', () => {
  it('acknowledges and delivers an event while the claim is fresh', async () => {
    const fresh = gate(true)
    const { ack, heard } = await deliverMention(fresh)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(heard).toEqual(['<@UBOT> hi'])
  })

  it('leaves an event unacknowledged while the claim is not trusted, so Slack can resend it', async () => {
    const stale = gate(false)
    const { ack, heard } = await deliverMention(stale)
    expect(ack).not.toHaveBeenCalled()
    expect(heard).toEqual([])
  })
})

describe('viewFallbackErrors', () => {
  const approvalText = 'Something went wrong; your decision was not recorded. Please try again.'

  it.each([
    [CONFIRM_MODAL_CALLBACK_ID, CONFIRM_MODAL_BLOCK_ID, approvalText],
    [EDIT_MODAL_CALLBACK_ID, EDIT_MODAL_BLOCK_ID, approvalText],
    [SHELL_PASSWORD_CALLBACK_ID, SHELL_PASSWORD_BLOCK_ID, SHELL_PASSWORD_GENERIC_ERROR],
    ['unknown_popup', CONFIRM_MODAL_BLOCK_ID, approvalText],
  ])('puts the error for %s on its own block', (callbackId, blockId, text) => {
    expect(viewFallbackErrors(callbackId)).toEqual({ [blockId]: text })
  })
})
