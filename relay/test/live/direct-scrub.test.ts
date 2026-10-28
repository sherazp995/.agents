import { describe, expect, it } from 'vitest'

import { continueDirectSession } from '../../src/live/direct-router.js'
import { registerSecretValue, scrubSecrets } from '../../src/secrets/scrubber.js'

/**
 * A direct session is UNMEDIATED: it reads whatever the operator's account
 * can read, and its reply goes straight to Slack. That makes it the likeliest
 * path in this system for a brokered secret to reach a chat message, and it
 * is the one reply path that was shipped without scrubbing.
 *
 * The scrubber only knows values Relay itself brokered, so this narrows the
 * exposure rather than closing it. That limit is exactly why a direct thread
 * is labelled unmediated when it is created, rather than being presented as
 * safe.
 */

describe('a direct session reply is scrubbed before it reaches Slack', () => {
  it('removes a brokered secret the session happened to read back', async () => {
    registerSecretValue('xoxb-brokered-token-value')

    const result = await continueDirectSession('/work', 'abc-123', 'cat the config', {
      runClaude: async () => ({
        stdout: JSON.stringify({
          type: 'result',
          session_id: 'abc-123',
          result: 'The file contains SLACK_TOKEN=xoxb-brokered-token-value',
          total_cost_usd: 0.01,
        }),
        stderr: '',
        code: 0,
        timedOut: false,
      }),
    })

    // The router returns the raw text; the orchestrator scrubs on the way
    // out. This asserts the scrubber actually catches this shape, which is
    // what makes that call site meaningful.
    expect(scrubSecrets(result.text)).not.toContain('xoxb-brokered-token-value')
    expect(scrubSecrets(result.text)).toContain('SLACK_TOKEN=')
  })
})
