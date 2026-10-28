import { describe, expect, it } from 'vitest'
import { MockAdapter } from '../../src/chat/mock.js'
import { runChatAdapterConformance } from './conformance.js'

runChatAdapterConformance('MockAdapter', async () => {
  const adapter = new MockAdapter()
  return { adapter, cleanup: async () => adapter.stop() }
})

describe('MockAdapter', () => {
  it('failNextPerform makes exactly the next perform call reject, then reverts to normal', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    const boom = new Error('boom')
    adapter.failNextPerform(boom)

    await expect(
      adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'hi' }),
    ).rejects.toBe(boom)

    await expect(
      adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'hi again' }),
    ).resolves.toMatchObject({ ref: { channel: 'C1' } })
  })

  it('does not record a failed perform in performed, only successful ones', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    adapter.failNextPerform(new Error('nope'))

    await expect(
      adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'dropped' }),
    ).rejects.toThrow('nope')

    expect(adapter.performed).toEqual([])
  })

  it('records every performed action in order', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})
    await adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'a' })
    await adapter.perform({ kind: 'setStatus', ref: { channel: 'C1' }, status: 'typing' })

    expect(adapter.performed).toEqual([
      { kind: 'post', ref: { channel: 'C1' }, text: 'a' },
      { kind: 'setStatus', ref: { channel: 'C1' }, status: 'typing' },
    ])
  })

  it('rejects an edit against a message id it never issued, rather than rubber-stamping it', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})

    await expect(
      adapter.perform({
        kind: 'edit',
        ref: { channel: 'C1', message: 'never-posted' },
        text: 'x',
      }),
    ).rejects.toThrow(/never-posted/)
  })

  it('rejects perform with a clear error naming editMessage when it is disabled', async () => {
    const adapter = new MockAdapter({
      buttons: true,
      editMessage: false,
      fileUpload: true,
      modals: true,
      threads: true,
      maxMessageBytes: 4000,
    })
    await adapter.start(async () => {})

    await expect(
      adapter.perform({ kind: 'edit', ref: { channel: 'C1', message: 'm1' }, text: 'x' }),
    ).rejects.toThrow(/editMessage/)
  })

  // The ref below is BOTH unissued and aimed at a disabled capability, so
  // this pins the order of the two checks in perform(). A capability the
  // adapter has openly declared false is the more fundamental complaint
  // and must win; if the issued-message check ever moves ahead of it, the
  // error stops naming editMessage and this fails.
  it('reports a disabled capability, not an unissued ref, when an edit violates both', async () => {
    const adapter = new MockAdapter({
      buttons: true,
      editMessage: false,
      fileUpload: true,
      modals: true,
      threads: true,
      maxMessageBytes: 4000,
    })
    await adapter.start(async () => {})

    await expect(
      adapter.perform({ kind: 'edit', ref: { channel: 'C1', message: 'never-issued' }, text: 'x' }),
    ).rejects.toThrow(/editMessage/)
  })

  // An oversized edit against an unissued ref violates both rules. The
  // issued-message check must win, because a ref that identifies nothing
  // makes the size question moot: there is no message to be too long for.
  it('reports an unissued ref, not the byte limit, when an oversized edit violates both', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})

    await expect(
      adapter.perform({
        kind: 'edit',
        ref: { channel: 'C1', message: 'never-issued' },
        text: 'x'.repeat(adapter.capabilities.maxMessageBytes + 1),
      }),
    ).rejects.toThrow(/never-issued/)
  })

  it('accepts an edit against a ref a prior post actually issued', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})

    const posted = await adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'a' })
    const message = posted.ref.message
    if (!message) throw new Error('post did not return a message id to edit against')

    await expect(
      adapter.perform({ kind: 'edit', ref: { channel: 'C1', message }, text: 'edited' }),
    ).resolves.toEqual({ ref: { channel: 'C1', message } })
  })

  it('mints a distinct message id for every post', async () => {
    const adapter = new MockAdapter()
    await adapter.start(async () => {})

    const first = await adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'a' })
    const second = await adapter.perform({ kind: 'post', ref: { channel: 'C1' }, text: 'b' })

    expect(second.ref.message).not.toBe(first.ref.message)
  })
})
