/**
 * Files attached to a task's messages. Recorded as `pending` at intake and
 * downloaded by the scheduler before the next worker turn, never inside the
 * inbound handler (Slack delivery is one serial queue).
 *
 * Only Slack's own file host is fetched, with the bot token, under a size
 * cap, into the task's inbox under a sanitised name. Anything else is
 * skipped with a reason the thread is told.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ChatFile } from '../chat/contract.js'
import type { Pool } from 'pg'
import { loadTask, updateTask, type AutonomousTask, type Lease, type TaskFile } from './store.js'

export const SLACK_FILE_HOST = 'files.slack.com'
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
export const DEFAULT_FILE_TIMEOUT_MS = 60_000

export type FileFetch = (url: string, init: { headers: Record<string, string>; redirect: 'error'; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  body: AsyncIterable<Uint8Array> | null
}>

export type DownloadDeps = {
  fetch: FileFetch
  botToken: string
  inboxDir: string
  maxBytes?: number
  timeoutMs?: number
}

/** Pending task files from an event's attachments. */
export function pendingFiles(files: readonly ChatFile[]): TaskFile[] {
  return files.map((file) => ({ slackFileId: file.id, name: file.name, url: file.urlPrivate, sizeBytes: file.sizeBytes, status: 'pending' }))
}

/** A name safe to write inside the inbox: no directories, no leading dots, no control or path characters. */
export function sanitizeFileName(name: string, slackFileId: string): string {
  const cleaned = basename(name.replaceAll('\\', '/'))
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200)
  const id = slackFileId.replace(/[^\w-]+/g, '_')
  return `${id}-${cleaned === '' ? 'file' : cleaned}`
}

/**
 * Downloads every pending file and returns the whole list with each one
 * marked `downloaded` (with its path) or `skipped` (with its reason).
 * Files already settled are returned unchanged.
 */
export async function downloadPendingFiles(files: readonly TaskFile[], deps: DownloadDeps): Promise<TaskFile[]> {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_FILE_BYTES
  const settled: TaskFile[] = []
  for (const file of files) {
    settled.push(file.status === 'pending' ? await downloadOne(file, deps, maxBytes) : file)
  }
  return settled
}

async function downloadOne(file: TaskFile, deps: DownloadDeps, maxBytes: number): Promise<TaskFile> {
  const skip = (reason: string): TaskFile => ({ ...file, status: 'skipped', reason })
  let url: URL
  try {
    url = new URL(file.url)
  } catch {
    return skip('not a valid URL')
  }
  if (url.protocol !== 'https:' || url.hostname !== SLACK_FILE_HOST || url.username !== '' || url.password !== '') {
    return skip(`not hosted on ${SLACK_FILE_HOST}`)
  }
  if (file.sizeBytes > maxBytes) return skip(`larger than the ${maxBytes} byte limit`)

  try {
    // redirect: 'error', so the token is never sent on to another host.
    const response = await deps.fetch(url.toString(), {
      headers: { Authorization: `Bearer ${deps.botToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_FILE_TIMEOUT_MS),
    })
    if (!response.ok) return skip(`Slack answered ${response.status}`)
    const bytes = await readCapped(response.body, maxBytes)
    if (bytes === undefined) return skip(`larger than the ${maxBytes} byte limit`)

    await mkdir(deps.inboxDir, { recursive: true, mode: 0o700 })
    const localPath = join(deps.inboxDir, sanitizeFileName(file.name, file.slackFileId))
    await writeFile(localPath, bytes, { mode: 0o600 })
    return { ...file, status: 'downloaded', localPath }
  } catch (error) {
    return skip(`download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The body's bytes, or undefined as soon as it passes the cap (a missing or lying length is never trusted). */
async function readCapped(body: AsyncIterable<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body ?? []) {
    total += chunk.byteLength
    if (total > maxBytes) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** One line per skipped file, for the thread. */
export function describeSkipped(files: readonly TaskFile[]): string[] {
  return files.filter((file) => file.status === 'skipped').map((file) => `${file.name}: skipped (${file.reason ?? 'unknown reason'})`)
}

/** Downloads a task's pending files before a turn; returns one line per newly skipped file for the thread. */
export async function downloadTaskFiles(pool: Pool, task: AutonomousTask, lease: Lease, deps: DownloadDeps): Promise<string[]> {
  if (!task.files.some((file) => file.status === 'pending')) return []
  const settled = await downloadPendingFiles(task.files, deps)
  // Merged by id into the list as it is now, so a file a message added during the download is kept.
  const byId = new Map(settled.map((file) => [file.slackFileId, file]))
  const current = (await loadTask(pool, task.id))?.files ?? task.files
  await updateTask(pool, lease, { files: current.map((file) => byId.get(file.slackFileId) ?? file) })
  const before = new Set(task.files.filter((file) => file.status === 'skipped').map((file) => file.slackFileId))
  return describeSkipped(settled.filter((file) => !before.has(file.slackFileId)))
}
