/**
 * A local file a session sends to Slack (`--file` on `relay live say` and
 * `relay notify`): a plan, a visual QA report, a QA video. Queued in relay's
 * outbox like any post, so the CLI never reads the bot token. The row holds
 * the file's absolute path, not its bytes; the daemon reads the file when it
 * uploads (loadUploadFile in src/chat/outbox.ts), so keep it in place until
 * it is sent.
 */

import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Pool } from 'pg'
import type { ChatRef } from '../chat/contract.js'

/** Slack's own limit for one file. */
export const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024

export type UploadFile = { filename: string; path: string }

export async function readUploadFile(path: string): Promise<UploadFile> {
  const absolute = resolve(path)
  const info = await stat(absolute).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`${path} is not a file`)
  if (info.size === 0) throw new Error(`${path} is empty`)
  if (info.size > UPLOAD_MAX_BYTES) throw new Error(`${path} is ${info.size} bytes; Slack's limit is ${UPLOAD_MAX_BYTES}`)
  return { filename: basename(absolute), path: absolute }
}

export async function queueUpload(pool: Pool, workspaceId: string, ref: ChatRef, file: UploadFile): Promise<void> {
  await pool.query(
    `INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'slack', $2, now())`,
    [workspaceId, { kind: 'upload', ref, filename: file.filename, path: file.path }],
  )
}
