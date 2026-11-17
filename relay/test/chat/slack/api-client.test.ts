import { App } from '@slack/bolt'
import { describe, expect, it, vi } from 'vitest'
import { createGatedSocketModeReceiver } from '../../../src/chat/slack/api-client.js'
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
  await vi.waitFor(() => expect(ack.mock.calls.length + stepDowns(gate)).toBeGreaterThan(0))
  // Let Bolt finish dispatching to listeners after its ack.
  await new Promise((resolve) => setImmediate(resolve))
  return { ack, heard }
}

function stepDowns(gate: FailoverGate): number {
  return (gate.stepDown as ReturnType<typeof vi.fn>).mock.calls.length
}

function gate(fresh: boolean): FailoverGate {
  return { host: 'zubair', holdsFresh: () => fresh, mayStartWork: async () => fresh, stepDown: vi.fn() }
}

describe('createGatedSocketModeReceiver', () => {
  it('acknowledges and delivers an event while the claim is fresh', async () => {
    const fresh = gate(true)
    const { ack, heard } = await deliverMention(fresh)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(heard).toEqual(['<@UBOT> hi'])
    expect(stepDowns(fresh)).toBe(0)
  })

  it('leaves an event unacknowledged and steps down once the claim is stale, so Slack resends it', async () => {
    const stale = gate(false)
    const { ack, heard } = await deliverMention(stale)
    expect(ack).not.toHaveBeenCalled()
    expect(heard).toEqual([])
    expect(stepDowns(stale)).toBe(1)
  })
})
