import { describe, expect, it } from 'vitest'
import { threadChatRef } from '../../src/autonomous/operations.js'
import { composeThreadRef } from '../../src/chat/slack/adapter.js'

describe('threadChatRef', () => {
  it('reads back the channel and thread composeThreadRef stored', () => {
    expect(threadChatRef(composeThreadRef('D0BPT8XL44Q', '1793220090.387709'))).toEqual({ channel: 'D0BPT8XL44Q', thread: '1793220090.387709' })
  })

  it('refuses a ref with no channel', () => {
    expect(() => threadChatRef('')).toThrow('is not <channel>:<thread>')
  })
})
