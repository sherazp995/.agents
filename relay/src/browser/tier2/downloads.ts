/**
 * FR-BR-5's "download file", which GT-2 and UC-2 need: "pull last month's
 * transactions from this portal as CSV and post it here."
 *
 * DOWNLOADS ARE A BROWSER-LEVEL CONCERN, NOT A PAGE-LEVEL ONE, which is why
 * they live here rather than in page.ts. Chrome's download events arrive on
 * the browser connection with no session id, because a download outlives
 * the page that started it: the page can navigate away, or close, while the
 * bytes are still arriving. A page that owned its downloads would lose them
 * exactly when a real task most wants them.
 *
 * THE FILENAME A PAGE SUGGESTS IS UNTRUSTED, and this is the security
 * decision worth reading. `Browser.setDownloadBehavior` offers two relevant
 * modes: `allow`, which saves under the page's own suggested filename, and
 * `allowAndName`, which saves under the download's GUID. This module uses
 * `allowAndName`.
 *
 * The reason is the same one behind every other boundary in this codebase:
 * a suggested filename is a string an attacker controls. `../../.ssh/
 * authorized_keys` is a suggested filename. Chrome sanitises, and relying
 * on that sanitisation is relying on someone else's code to hold a boundary
 * Relay is accountable for. Saving under a GUID makes the question
 * unaskable: the path Relay writes to is one Relay generated, and the
 * page's suggestion survives only as reported METADATA, never as a path.
 *
 * DOWNLOADS ARE BOUNDED. A page can start a download of any size, and a run
 * that filled the operator's disk would be a denial of service Relay
 * performed on itself. A download past the cap is CANCELLED, through
 * Chrome's own `Browser.cancelDownload`, and reported as cancelled with its
 * size rather than quietly abandoned.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CdpEventListener } from '../cdp/connection.js'

/**
 * The two things this module needs from a CDP connection, as an interface
 * rather than the `CdpConnection` class.
 *
 * Same reason `DrivablePage` exists in page.ts: `CdpConnection` has private
 * fields, so it is nominal, so a test double has to be cast past the
 * compiler, and a cast is exactly how a double silently falls out of date.
 * A narrow interface makes the double compiler-checked against the real
 * surface.
 */
export type DownloadCapableConnection = {
  on(method: string, listener: CdpEventListener): () => void
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}

/**
 * The cap on one download, in bytes. Chosen, not measured: generous for the
 * CSV exports and PDFs a real task fetches, small enough that a runaway
 * download is stopped long before it matters. An operator who needs more
 * raises it; the point is that there is a number and that exceeding it is
 * reported.
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** The cap on how many downloads one browser lifetime keeps track of. */
export const MAX_TRACKED_DOWNLOADS = 50

export type DownloadState = 'in_progress' | 'completed' | 'canceled' | 'too_large'

export type DownloadRecord = {
  /** Chrome's own identifier, and, because of `allowAndName`, the file's name on disk. */
  readonly guid: string
  readonly url: string
  /** What the PAGE said the file should be called. Reported so a caller can name it sensibly when it hands it on; never used as a path. See this file's header comment. */
  readonly suggestedFilename: string
  /** Where Relay actually wrote it. Always inside this browser's own download directory, always named by guid. */
  readonly path: string
  readonly state: DownloadState
  readonly receivedBytes: number
  readonly totalBytes: number
  /** Present only for a download that did not complete, saying why in words. */
  readonly reason?: string
}

export type DownloadTracker = {
  readonly directory: string
  readonly downloads: readonly DownloadRecord[]
  /**
   * Waits for a download that is not yet complete to finish, or reports
   * that none arrived. Never throws: "no download started" is an answer a
   * caller acts on.
   */
  waitForDownload(options?: { readonly timeoutMs?: number }): Promise<DownloadWaitResult>
  /**
   * Removes the download directory, but ONLY if this tracker created it.
   *
   * The ownership rule matters more than it looks. A browser is closed at
   * the end of a capability call, and a downloaded file deleted at that
   * moment is a file nobody can use: the whole point of UC-2 is to hand it
   * on afterwards. So a caller that intends to keep what was downloaded
   * supplies its own directory and owns its lifetime; a caller that does
   * not gets a temporary one that is cleaned up.
   */
  dispose(): void
}

export type DownloadWaitResult =
  | { readonly outcome: 'downloaded'; readonly download: DownloadRecord }
  | { readonly outcome: 'none'; readonly reason: string }

export const DEFAULT_DOWNLOAD_WAIT_MS = 60_000

export type DownloadTrackerDependencies = {
  readonly directory?: string
  readonly maxBytes?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly sizeOf?: (path: string) => number | undefined
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function realSizeOf(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

/**
 * Turns on downloading for `connection`, into a directory this browser
 * owns, and starts tracking what arrives.
 *
 * Returns the tracker even if enabling fails, with the failure recorded as
 * the tracker reporting no downloads: a browser that cannot download is
 * still a usable browser for every other task, and refusing to open one
 * over it would be a worse trade.
 */
export async function startDownloadTracker(
  connection: DownloadCapableConnection,
  deps: DownloadTrackerDependencies = {},
): Promise<DownloadTracker> {
  const callerOwnsDirectory = deps.directory !== undefined
  const directory = deps.directory ?? mkdtempSync(join(tmpdir(), 'relay-downloads-'))
  const maxBytes = deps.maxBytes ?? MAX_DOWNLOAD_BYTES
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const sizeOf = deps.sizeOf ?? realSizeOf

  const records = new Map<string, DownloadRecord>()
  const order: string[] = []

  const put = (guid: string, record: DownloadRecord): void => {
    if (!records.has(guid)) {
      if (order.length >= MAX_TRACKED_DOWNLOADS) return
      order.push(guid)
    }
    records.set(guid, record)
  }

  connection.on('Browser.downloadWillBegin', (params) => {
    const guid = typeof params['guid'] === 'string' ? params['guid'] : undefined
    if (guid === undefined) return
    put(guid, {
      guid,
      url: typeof params['url'] === 'string' ? params['url'] : '',
      suggestedFilename: typeof params['suggestedFilename'] === 'string' ? params['suggestedFilename'] : '',
      // `allowAndName` below means the file on disk is named by guid, so
      // this path is composed from a value Relay controls rather than from
      // anything the page said.
      path: join(directory, guid),
      state: 'in_progress',
      receivedBytes: 0,
      totalBytes: typeof params['totalBytes'] === 'number' ? params['totalBytes'] : 0,
    })
  })

  connection.on('Browser.downloadProgress', (params) => {
    const guid = typeof params['guid'] === 'string' ? params['guid'] : undefined
    if (guid === undefined) return
    const existing = records.get(guid)
    if (existing === undefined) return

    const receivedBytes = typeof params['receivedBytes'] === 'number' ? params['receivedBytes'] : existing.receivedBytes
    const totalBytes = typeof params['totalBytes'] === 'number' && params['totalBytes'] > 0 ? params['totalBytes'] : existing.totalBytes
    const reported = typeof params['state'] === 'string' ? params['state'] : 'inProgress'

    if (receivedBytes > maxBytes || totalBytes > maxBytes) {
      put(guid, {
        ...existing,
        state: 'too_large',
        receivedBytes,
        totalBytes,
        reason:
          `the download exceeded Relay's ${maxBytes} byte cap (${totalBytes > 0 ? `${totalBytes} bytes declared` : `${receivedBytes} bytes received`}) ` +
          'and was cancelled rather than allowed to fill the disk',
      })
      // Chrome's own cancel, not merely a flag: the bytes stop arriving.
      void connection.send('Browser.cancelDownload', { guid }).catch(() => {
        // A download that has already finished cannot be cancelled, and
        // the record above already says what happened.
      })
      return
    }

    const state: DownloadState =
      reported === 'completed' ? 'completed' : reported === 'canceled' ? 'canceled' : 'in_progress'
    put(guid, {
      ...existing,
      state,
      receivedBytes,
      totalBytes,
      ...(state === 'canceled' ? { reason: 'the browser cancelled this download' } : {}),
    })
  })

  try {
    await connection.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: directory,
      eventsEnabled: true,
    })
  } catch {
    // See this function's doc comment: a browser that cannot download is
    // still worth having. The tracker simply never records anything, and
    // `waitForDownload` reports that no download arrived, which is true.
  }

  const snapshot = (): readonly DownloadRecord[] =>
    order.flatMap((guid) => {
      const record = records.get(guid)
      if (record === undefined) return []
      // The size on disk is the honest number for a completed download:
      // Chrome's own receivedBytes is occasionally zero on the completion
      // event, and reporting a real file as empty would be a lie a caller
      // would act on.
      if (record.state !== 'completed') return [record]
      const size = sizeOf(record.path)
      return [size === undefined ? record : { ...record, receivedBytes: size }]
    })

  return {
    directory,
    get downloads() {
      return snapshot()
    },
    waitForDownload: async (options = {}) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_WAIT_MS
      const start = now()
      for (;;) {
        const settled = snapshot().find((record) => record.state !== 'in_progress')
        if (settled !== undefined) {
          return settled.state === 'completed'
            ? { outcome: 'downloaded', download: settled }
            : { outcome: 'none', reason: settled.reason ?? `the download ended as "${settled.state}"` }
        }
        const elapsed = now() - start
        if (elapsed >= timeoutMs) {
          const started = snapshot().length > 0
          return {
            outcome: 'none',
            reason: started
              ? `a download started but had not finished after ${timeoutMs}ms`
              : `no download started within ${timeoutMs}ms`,
          }
        }
        await sleep(Math.min(100, timeoutMs - elapsed))
      }
    },
    dispose: () => {
      // See the DownloadTracker type's own comment on this rule.
      if (callerOwnsDirectory) return
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // A leaked temp directory is not worth failing a browser shutdown
        // over, and the operating system reclaims it.
      }
    },
  }
}
