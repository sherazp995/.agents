import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeSkipped, downloadPendingFiles, sanitizeFileName, type FileFetch } from '../../src/autonomous/files.js'
import type { TaskFile } from '../../src/autonomous/store.js'

function file(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    slackFileId: 'F1',
    name: 'notes.txt',
    url: 'https://files.slack.com/files-pri/T1-F1/notes.txt',
    sizeBytes: 5,
    status: 'pending',
    ...overrides,
  }
}

async function* chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* parts
}

function fetchReturning(status: number, body = 'hello'): FileFetch & { calls: { url: string; auth: string | undefined }[] } {
  const calls: { url: string; auth: string | undefined }[] = []
  const fn = (async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization })
    return { ok: status < 400, status, body: chunks(new TextEncoder().encode(body)) }
  }) as FileFetch & { calls: typeof calls }
  fn.calls = calls
  return fn
}

describe('downloadPendingFiles', () => {
  const inboxDir = () => join(mkdtempSync(join(tmpdir(), 'relay-files-')), 'inbox')

  it('downloads a Slack-hosted file with the bot token into the inbox', async () => {
    const fetch = fetchReturning(200)
    const [result] = await downloadPendingFiles([file()], { fetch, botToken: 'xoxb-test', inboxDir: inboxDir() })

    expect(result?.status).toBe('downloaded')
    expect(readFileSync(result?.localPath ?? '', 'utf8')).toBe('hello')
    expect(fetch.calls).toEqual([{ url: 'https://files.slack.com/files-pri/T1-F1/notes.txt', auth: 'Bearer xoxb-test' }])
  })

  it('refuses a non-Slack host without fetching, and names it', async () => {
    const fetch = fetchReturning(200)
    const files = await downloadPendingFiles([file({ url: 'https://evil.example/x' })], { fetch, botToken: 't', inboxDir: inboxDir() })

    expect(files[0]).toMatchObject({ status: 'skipped', reason: 'not hosted on files.slack.com' })
    expect(fetch.calls).toHaveLength(0)
    expect(describeSkipped(files)).toEqual(['notes.txt: skipped (not hosted on files.slack.com)'])
  })

  it('rejects an oversize file by its declared size and by its real size', async () => {
    const declared = await downloadPendingFiles([file({ sizeBytes: 100 })], { fetch: fetchReturning(200), botToken: 't', inboxDir: inboxDir(), maxBytes: 10 })
    const real = await downloadPendingFiles([file({ sizeBytes: 1 })], { fetch: fetchReturning(200, 'x'.repeat(50)), botToken: 't', inboxDir: inboxDir(), maxBytes: 10 })

    expect(declared[0]?.reason).toBe('larger than the 10 byte limit')
    expect(real[0]?.reason).toBe('larger than the 10 byte limit')
  })

  it('refuses a Slack URL that carries credentials', async () => {
    const fetch = fetchReturning(200)
    const files = await downloadPendingFiles([file({ url: 'https://u:p@files.slack.com/x' })], { fetch, botToken: 't', inboxDir: inboxDir() })
    expect(files[0]?.status).toBe('skipped')
    expect(fetch.calls).toHaveLength(0)
  })

  it('marks the file skipped when the download throws', async () => {
    const failing: FileFetch = async () => {
      throw new Error('socket hang up')
    }
    const files = await downloadPendingFiles([file()], { fetch: failing, botToken: 't', inboxDir: inboxDir() })
    expect(files[0]).toMatchObject({ status: 'skipped', reason: 'download failed: socket hang up' })
  })

  it('reports a 403 from Slack', async () => {
    const files = await downloadPendingFiles([file()], { fetch: fetchReturning(403), botToken: 't', inboxDir: inboxDir() })
    expect(files[0]).toMatchObject({ status: 'skipped', reason: 'Slack answered 403' })
  })

  it('keeps a traversal name inside the inbox', async () => {
    const dir = inboxDir()
    const [result] = await downloadPendingFiles([file({ name: '../../x' })], { fetch: fetchReturning(200), botToken: 't', inboxDir: dir })

    expect(dirname(result?.localPath ?? '')).toBe(dir)
    expect(sanitizeFileName('../x', 'F9')).toBe('F9-x')
    expect(sanitizeFileName('..', 'F9')).toBe('F9-file')
  })

  it('leaves already settled files untouched', async () => {
    const fetch = fetchReturning(200)
    const settled = file({ status: 'downloaded', localPath: '/tmp/a' })
    expect(await downloadPendingFiles([settled], { fetch, botToken: 't', inboxDir: inboxDir() })).toEqual([settled])
    expect(fetch.calls).toHaveLength(0)
  })
})
