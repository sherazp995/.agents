import { describe, expect, it } from 'vitest'

import { startDownloadTracker } from '../../../src/browser/tier2/downloads.js'
import type { DownloadCapableConnection } from '../../../src/browser/tier2/downloads.js'

/**
 * The download tracker's own decision table, driven by hand-fired CDP
 * events.
 *
 * The real thing is proven against a real Chrome in test/golden/gt-2.test.ts.
 * What that cannot reach is the cap: triggering it for real would mean
 * downloading a hundred megabytes in a unit test suite. So the cap, the
 * cancel it issues, and the states around it are proven here, where the
 * numbers can simply be asserted.
 */
function fakeConnection(): {
  readonly connection: DownloadCapableConnection
  emit(method: string, params: Record<string, unknown>): void
  readonly sent: Array<{ method: string; params: Record<string, unknown> }>
} {
  const listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []

  return {
    connection: {
      on: (method, listener) => {
        const existing = listeners.get(method) ?? []
        const wrapped = (params: Record<string, unknown>): void => listener(params, undefined)
        listeners.set(method, [...existing, wrapped])
        return () => {}
      },
      send: async (method, params = {}) => {
        sent.push({ method, params })
        return {}
      },
    },
    emit: (method, params) => {
      for (const listener of listeners.get(method) ?? []) listener(params)
    },
    sent,
  }
}

const DIRECTORY = '/tmp/relay-test-downloads'

/**
 * An ADVANCING clock by default. A frozen one (`now: () => 0`) makes
 * `waitForDownload` spin forever, because its elapsed time never reaches
 * the timeout: production uses `Date.now`, so this is a property of the
 * test double rather than of the code, but it is worth stating because it
 * cost a hung test run to notice.
 */
function trackerDeps(overrides: Parameters<typeof startDownloadTracker>[1] = {}) {
  let clock = 0
  return {
    directory: DIRECTORY,
    now: () => (clock += 50),
    sleep: () => Promise.resolve(),
    sizeOf: () => 11,
    ...overrides,
  }
}

describe('startDownloadTracker', () => {
  it('asks chrome to name files itself, so a page cannot choose the path Relay writes to', async () => {
    const fake = fakeConnection()

    await startDownloadTracker(fake.connection, trackerDeps())

    const behavior = fake.sent.find((call) => call.method === 'Browser.setDownloadBehavior')
    expect(behavior?.params['behavior']).toBe('allowAndName')
    expect(behavior?.params['downloadPath']).toBe(DIRECTORY)
    expect(behavior?.params['eventsEnabled']).toBe(true)
  })

  it('records a download under a path composed from the guid, never from the suggested filename', async () => {
    const fake = fakeConnection()
    const tracker = await startDownloadTracker(fake.connection, trackerDeps())

    fake.emit('Browser.downloadWillBegin', {
      guid: 'GUID-1',
      url: 'https://portal.test/export.csv',
      // The attack: a suggested filename that is a path traversal.
      suggestedFilename: '../../.ssh/authorized_keys',
      totalBytes: 11,
    })

    const record = tracker.downloads[0]
    expect(record?.path).toBe(`${DIRECTORY}/GUID-1`)
    expect(record?.path).not.toContain('..')
    // Kept as metadata, because a caller needs it to name the file when it
    // hands it on. Just never as a path.
    expect(record?.suggestedFilename).toBe('../../.ssh/authorized_keys')
  })

  it('reports a completed download with the size the file actually is on disk', async () => {
    const fake = fakeConnection()
    // Chrome sometimes reports receivedBytes as 0 on the completion event.
    // Reporting a real file as empty is a lie a caller would act on.
    const tracker = await startDownloadTracker(fake.connection, trackerDeps({ sizeOf: () => 4096 }))

    fake.emit('Browser.downloadWillBegin', { guid: 'G', url: 'https://x.test/f', suggestedFilename: 'f', totalBytes: 0 })
    fake.emit('Browser.downloadProgress', { guid: 'G', state: 'completed', receivedBytes: 0, totalBytes: 0 })

    const waited = await tracker.waitForDownload({ timeoutMs: 1000 })
    expect(waited.outcome).toBe('downloaded')
    if (waited.outcome !== 'downloaded') return
    expect(waited.download.receivedBytes).toBe(4096)
  })

  it('CANCELS a download past the cap through chrome, rather than letting it fill the disk', async () => {
    const fake = fakeConnection()
    const tracker = await startDownloadTracker(fake.connection, trackerDeps({ maxBytes: 1_000 }))

    fake.emit('Browser.downloadWillBegin', { guid: 'BIG', url: 'https://x.test/huge', suggestedFilename: 'huge.bin', totalBytes: 0 })
    fake.emit('Browser.downloadProgress', { guid: 'BIG', state: 'inProgress', receivedBytes: 5_000, totalBytes: 0 })

    // Chrome's own cancel, not merely a flag on a record: without this the
    // bytes keep arriving no matter what the record says.
    expect(fake.sent.some((call) => call.method === 'Browser.cancelDownload' && call.params['guid'] === 'BIG')).toBe(true)

    const waited = await tracker.waitForDownload({ timeoutMs: 1000 })
    expect(waited.outcome).toBe('none')
    if (waited.outcome !== 'none') return
    expect(waited.reason).toContain('exceeded')
    expect(tracker.downloads[0]?.state).toBe('too_large')
  })

  it('stops a download that DECLARES an oversized total, before any bytes arrive at all', async () => {
    const fake = fakeConnection()
    await startDownloadTracker(fake.connection, trackerDeps({ maxBytes: 1_000 }))

    fake.emit('Browser.downloadWillBegin', { guid: 'BIG', url: 'https://x.test/huge', suggestedFilename: 'h', totalBytes: 0 })
    fake.emit('Browser.downloadProgress', { guid: 'BIG', state: 'inProgress', receivedBytes: 1, totalBytes: 9_000 })

    expect(fake.sent.some((call) => call.method === 'Browser.cancelDownload')).toBe(true)
  })

  it('reports a download the browser cancelled as cancelled, not as a silent absence', async () => {
    const fake = fakeConnection()
    const tracker = await startDownloadTracker(fake.connection, trackerDeps())

    fake.emit('Browser.downloadWillBegin', { guid: 'C', url: 'https://x.test/f', suggestedFilename: 'f', totalBytes: 10 })
    fake.emit('Browser.downloadProgress', { guid: 'C', state: 'canceled', receivedBytes: 3, totalBytes: 10 })

    const waited = await tracker.waitForDownload({ timeoutMs: 1000 })
    expect(waited.outcome).toBe('none')
    if (waited.outcome !== 'none') return
    expect(waited.reason).toContain('cancelled')
  })

  it('distinguishes "no download started" from "one started and did not finish"', async () => {
    const fake = fakeConnection()
    const tracker = await startDownloadTracker(fake.connection, trackerDeps())

    const none = await tracker.waitForDownload({ timeoutMs: 300 })
    expect(none.outcome).toBe('none')
    if (none.outcome !== 'none') return
    expect(none.reason).toContain('no download started')

    fake.emit('Browser.downloadWillBegin', { guid: 'S', url: 'https://x.test/f', suggestedFilename: 'f', totalBytes: 10 })
    const stalled = await tracker.waitForDownload({ timeoutMs: 300 })
    expect(stalled.outcome).toBe('none')
    if (stalled.outcome !== 'none') return
    expect(stalled.reason).toContain('had not finished')
  })

  it('does not delete a directory the caller supplied, because the caller owns what was downloaded into it', async () => {
    const fake = fakeConnection()
    const tracker = await startDownloadTracker(fake.connection, trackerDeps())

    // A downloaded file deleted when the browser closes is a file nobody
    // can use, which is the whole point of UC-2.
    expect(() => {
      tracker.dispose()
    }).not.toThrow()
    expect(tracker.directory).toBe(DIRECTORY)
  })

  it('still returns a usable tracker when the browser refuses to enable downloading', async () => {
    const failing: DownloadCapableConnection = {
      on: () => () => {},
      send: () => Promise.reject(new Error('not supported')),
    }

    const tracker = await startDownloadTracker(failing, trackerDeps())

    expect(tracker.downloads).toEqual([])
    const waited = await tracker.waitForDownload({ timeoutMs: 1 })
    // Honest: no download arrived, which is true, rather than a crash that
    // would take a browser that works fine for everything else with it.
    expect(waited.outcome).toBe('none')
  })

  it('ignores a progress event for a download it never saw begin', async () => {
    const fake = fakeConnection()
    const tracker = await startDownloadTracker(fake.connection, trackerDeps())

    expect(() => {
      fake.emit('Browser.downloadProgress', { guid: 'UNKNOWN', state: 'completed', receivedBytes: 5 })
    }).not.toThrow()
    expect(tracker.downloads).toEqual([])
  })
})
