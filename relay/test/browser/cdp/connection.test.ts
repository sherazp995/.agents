import { describe, expect, it, vi } from 'vitest'

import {
  CdpConnection,
  CdpProtocolError,
  CdpTransportError,
  connectToCdp,
} from '../../../src/browser/cdp/connection.js'
import type { CdpSocket } from '../../../src/browser/cdp/connection.js'

/**
 * A socket driven by hand: the test decides exactly what frames arrive and
 * exactly when the close happens, so every branch of the transport is
 * reachable without Chrome, a network, or a real timer. The real socket is
 * exercised separately, against a real Chrome, in
 * test/browser/cdp/endpoint.integration.test.ts.
 */
function fakeSocket(): {
  readonly socket: CdpSocket
  readonly sent: string[]
  deliver(message: unknown): void
  fireClose(reason: string): void
  readonly closeCalls: number
  failNextSend(error: Error): void
} {
  const sent: string[] = []
  let messageListener: ((data: string) => void) | undefined
  let closeListener: ((reason: string) => void) | undefined
  let closeCalls = 0
  let sendFailure: Error | undefined

  const state = {
    socket: {
      send: (data: string) => {
        if (sendFailure !== undefined) {
          const failure = sendFailure
          sendFailure = undefined
          throw failure
        }
        sent.push(data)
      },
      onMessage: (listener: (data: string) => void) => {
        messageListener = listener
      },
      onClose: (listener: (reason: string) => void) => {
        closeListener = listener
      },
      close: () => {
        closeCalls++
        closeListener?.('socket closed')
      },
    } satisfies CdpSocket,
    sent,
    deliver: (message: unknown) => {
      messageListener?.(typeof message === 'string' ? message : JSON.stringify(message))
    },
    fireClose: (reason: string) => closeListener?.(reason),
    get closeCalls() {
      return closeCalls
    },
    failNextSend: (error: Error) => {
      sendFailure = error
    },
  }
  return state
}

function lastSent(sent: readonly string[]): Record<string, unknown> {
  const raw = sent[sent.length - 1]
  expect(raw).toBeDefined()
  return JSON.parse(raw as string) as Record<string, unknown>
}

describe('CdpConnection command correlation', () => {
  it('resolves a command with the result of the reply carrying its own id', async () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)

    const pending = connection.send('Page.navigate', { url: 'https://example.test/' })
    const frame = lastSent(fake.sent)
    expect(frame['method']).toBe('Page.navigate')
    expect(frame['params']).toEqual({ url: 'https://example.test/' })

    fake.deliver({ id: frame['id'], result: { frameId: 'F1' } })
    await expect(pending).resolves.toEqual({ frameId: 'F1' })
  })

  it('routes two concurrent replies to their own callers even when they arrive out of order', async () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)

    const first = connection.send('Runtime.evaluate', { expression: '1' })
    const firstId = lastSent(fake.sent)['id']
    const second = connection.send('Runtime.evaluate', { expression: '2' })
    const secondId = lastSent(fake.sent)['id']
    expect(firstId).not.toBe(secondId)

    fake.deliver({ id: secondId, result: { value: 'second' } })
    fake.deliver({ id: firstId, result: { value: 'first' } })

    await expect(first).resolves.toEqual({ value: 'first' })
    await expect(second).resolves.toEqual({ value: 'second' })
  })

  it('stamps sessionId onto the outgoing frame only when one is given', () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)

    void connection.send('Page.enable', {}, 'SESSION-1').catch(() => {})
    expect(lastSent(fake.sent)['sessionId']).toBe('SESSION-1')

    void connection.send('Page.enable').catch(() => {})
    expect(lastSent(fake.sent)).not.toHaveProperty('sessionId')
  })

  it('resolves with an empty object when the reply carries no result member', async () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)

    const pending = connection.send('Page.enable')
    fake.deliver({ id: lastSent(fake.sent)['id'] })
    await expect(pending).resolves.toEqual({})
  })
})

describe('CdpConnection error mapping', () => {
  it('rejects with CdpProtocolError carrying the code Chrome returned, not a generic failure', async () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)

    const pending = connection.send('DOM.querySelector', { selector: '#missing' })
    fake.deliver({
      id: lastSent(fake.sent)['id'],
      error: { code: -32000, message: 'Could not find node with given id', data: 'selector #missing' },
    })

    await expect(pending).rejects.toBeInstanceOf(CdpProtocolError)
    await pending.catch((error: unknown) => {
      const protocolError = error as CdpProtocolError
      expect(protocolError.code).toBe(-32000)
      expect(protocolError.method).toBe('DOM.querySelector')
      expect(protocolError.data).toBe('selector #missing')
      expect(protocolError.message).toContain('Could not find node with given id')
    })
  })

  it('rejects with a transport error, not a protocol error, when the socket refuses the write', async () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)
    fake.failNextSend(new Error('EPIPE'))

    const pending = connection.send('Page.navigate')
    await expect(pending).rejects.toBeInstanceOf(CdpTransportError)
    await expect(pending).rejects.toThrow(/EPIPE/)
  })

  it('ignores an unparseable frame rather than throwing back into the socket callback', () => {
    const fake = fakeSocket()
    new CdpConnection(fake.socket)
    expect(() => {
      fake.deliver('{not json')
    }).not.toThrow()
  })
})

describe('CdpConnection: a command always settles', () => {
  it('rejects a command that is never answered, once its timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSocket()
      const connection = new CdpConnection(fake.socket, { commandTimeoutMs: 5_000 })

      const pending = connection.send('Page.navigate')
      const assertion = expect(pending).rejects.toThrow(/did not answer within 5000ms/)
      await vi.advanceTimersByTimeAsync(5_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a reply that arrives after its command already timed out, rather than resolving a caller that gave up', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeSocket()
      const connection = new CdpConnection(fake.socket, { commandTimeoutMs: 1_000 })

      const pending = connection.send('Page.navigate')
      const id = lastSent(fake.sent)['id']
      const assertion = expect(pending).rejects.toThrow(/did not answer/)
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion

      expect(() => {
        fake.deliver({ id, result: { frameId: 'late' } })
      }).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('SELF-ATTACK, the guard this file exists for: an in-flight command rejects the moment the socket closes, instead of waiting out its full timeout', async () => {
    const fake = fakeSocket()
    // A timeout far beyond any test's patience: if closing did not reject
    // the pending command, this test could only pass by hanging.
    const connection = new CdpConnection(fake.socket, { commandTimeoutMs: 10 * 60 * 1_000 })

    const pending = connection.send('Page.captureScreenshot')
    fake.fireClose('chrome exited')

    await expect(pending).rejects.toBeInstanceOf(CdpTransportError)
    await expect(pending).rejects.toThrow(/was in flight when the connection closed: chrome exited/)
    expect(connection.closed).toBe(true)
  })

  it('rejects every in-flight command on close, not merely the first', async () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket, { commandTimeoutMs: 10 * 60 * 1_000 })

    const commands = [
      connection.send('Page.enable'),
      connection.send('DOM.enable'),
      connection.send('Runtime.enable'),
    ]
    fake.fireClose('target detached')

    const settled = await Promise.allSettled(commands)
    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected', 'rejected'])
  })

  it('rejects a command sent after close immediately, rather than queueing it for a socket that will never carry it', async () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)
    connection.close('done')

    await expect(connection.send('Page.enable')).rejects.toThrow(/the CDP connection is closed \(done\)/)
    expect(fake.sent).toHaveLength(0)
  })
})

describe('CdpConnection events', () => {
  it('delivers an event to its subscribers with the session it arrived on', () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)
    const seen: Array<{ params: Record<string, unknown>; sessionId: string | undefined }> = []
    connection.on('Page.loadEventFired', (params, sessionId) => {
      seen.push({ params, sessionId })
    })

    fake.deliver({ method: 'Page.loadEventFired', params: { timestamp: 12 }, sessionId: 'S1' })

    expect(seen).toEqual([{ params: { timestamp: 12 }, sessionId: 'S1' }])
  })

  it('does not deliver an event to a subscriber of a different method', () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)
    const other = vi.fn()
    connection.on('Page.loadEventFired', other)

    fake.deliver({ method: 'Network.requestWillBeSent', params: {} })

    expect(other).not.toHaveBeenCalled()
  })

  it('stops delivering once the returned unsubscribe is called', () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)
    const listener = vi.fn()
    const unsubscribe = connection.on('Page.loadEventFired', listener)

    fake.deliver({ method: 'Page.loadEventFired', params: {} })
    unsubscribe()
    fake.deliver({ method: 'Page.loadEventFired', params: {} })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps delivering to the remaining subscribers when one of them throws', () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)
    const good = vi.fn()
    connection.on('Page.loadEventFired', () => {
      throw new Error('listener blew up')
    })
    connection.on('Page.loadEventFired', good)

    expect(() => {
      fake.deliver({ method: 'Page.loadEventFired', params: {} })
    }).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('survives a listener that unsubscribes itself while being called', () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)
    const second = vi.fn()
    const unsubscribe = connection.on('Page.loadEventFired', () => {
      unsubscribe()
    })
    connection.on('Page.loadEventFired', second)

    expect(() => {
      fake.deliver({ method: 'Page.loadEventFired', params: {} })
    }).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('CdpConnection close', () => {
  it('is idempotent: a second close is a no-op, not an error, and does not re-close the socket', () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)

    connection.close()
    connection.close()

    expect(fake.closeCalls).toBe(1)
  })

  it('reports the reason the socket gave when the socket closed underneath it, not a generic one', async () => {
    const fake = fakeSocket()
    const connection = new CdpConnection(fake.socket)
    const pending = connection.send('Page.enable')

    fake.fireClose('chrome crashed with SIGSEGV')

    await expect(pending).rejects.toThrow(/chrome crashed with SIGSEGV/)
  })
})

describe('connectToCdp', () => {
  it('opens the socket for the given url and returns a live connection', async () => {
    const fake = fakeSocket()
    const openSocket = vi.fn(() => Promise.resolve(fake.socket))

    const connection = await connectToCdp('ws://127.0.0.1:9222/devtools/browser/abc', { openSocket })

    expect(openSocket).toHaveBeenCalledWith('ws://127.0.0.1:9222/devtools/browser/abc')
    expect(connection.closed).toBe(false)
  })

  it('propagates a failure to open rather than returning a connection that can never send', async () => {
    const openSocket = vi.fn(() => Promise.reject(new CdpTransportError('nothing is listening')))

    await expect(connectToCdp('ws://127.0.0.1:1/devtools/browser/abc', { openSocket })).rejects.toThrow(
      /nothing is listening/,
    )
  })
})
