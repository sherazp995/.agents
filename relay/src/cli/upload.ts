/**
 * A local file a session sends to Slack (`--file` on `relay live say` and
 * `relay notify`): a plan, a visual QA report, a QA video. Queued in relay's
 * outbox like any post, so the CLI never reads the bot token. The bytes go
 * into outbox_files with the outbox row, because with failover the laptop
 * that posts may not be the one that has the file; the row names the file
 * by `file_id`, and the daemon deletes it once the upload is settled
 * (loadUploadFile in src/chat/outbox.ts).
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Pool } from 'pg'
import type { ChatRef } from '../chat/contract.js'

/** Below Slack's 1 GB, to keep one row well inside Postgres bytea and the free cloud database's 500 MB. */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024

export type UploadFile = { filename: string; content: Buffer }

export async function readUploadFile(path: string): Promise<UploadFile> {
  const absolute = resolve(path)
  const info = await stat(absolute).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`${path} is not a file`)
  if (info.size === 0) throw new Error(`${path} is empty`)
  // Checked before reading, so an oversized file is never loaded into memory.
  if (info.size > UPLOAD_MAX_BYTES) throw new Error(`${path} is ${info.size} bytes; relay stores files up to 100 MB (${UPLOAD_MAX_BYTES} bytes)`)
  return { filename: basename(absolute), content: await readFile(absolute) }
}

export async function queueUpload(pool: Pool, workspaceId: string, ref: ChatRef, file: UploadFile): Promise<void> {
  const client = await pool.connect()
  try {
    // One transaction, so a stored file never sits without the row that posts and deletes it.
    await client.query('BEGIN')
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO outbox_files (workspace_id, filename, content) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, file.filename, file.content],
    )
    await client.query(
      `INSERT INTO outbox (workspace_id, adapter, action, next_attempt_at) VALUES ($1, 'slack', $2, now())`,
      [workspaceId, { kind: 'upload', ref, filename: file.filename, file_id: rows[0]?.id }],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
