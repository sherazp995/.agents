/**
 * Each Slack thread's shell folder (migration 0033): the only thing the shell
 * from Slack stores. Paths are saved as this laptop sees them and read back
 * under this laptop's home, because the other failover laptop may have
 * another home folder (src/failover/paths.ts).
 */

import { homedir } from 'node:os'
import type { Pool } from 'pg'
import { knownHomes, mapPath } from '../failover/paths.js'

export type ShellThread = { readonly workspaceId: string; readonly adapter: string; readonly threadRef: string }

/** The thread's saved folder, mapped to this laptop's home; undefined when the thread has never run a `!` line. */
export async function readShellFolder(pool: Pool, thread: ShellThread, home: string = homedir()): Promise<string | undefined> {
  const { rows } = await pool.query<{ folder: string }>(
    'SELECT folder FROM shell_folders WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3',
    [thread.workspaceId, thread.adapter, thread.threadRef],
  )
  const folder = rows[0]?.folder
  return folder === undefined ? undefined : mapPath(folder, await knownHomes(pool), home)
}

export async function saveShellFolder(pool: Pool, thread: ShellThread, folder: string): Promise<void> {
  await pool.query(
    `INSERT INTO shell_folders (workspace_id, adapter, thread_ref, folder) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, adapter, thread_ref) DO UPDATE SET folder = EXCLUDED.folder, updated_at = now()`,
    [thread.workspaceId, thread.adapter, thread.threadRef, folder],
  )
}

/** Whether the thread has ever run a `!` line here, for the adapter's unmentioned reply gate. */
export async function hasShellFolder(pool: Pool, thread: ShellThread): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM shell_folders WHERE workspace_id = $1 AND adapter = $2 AND thread_ref = $3 LIMIT 1',
    [thread.workspaceId, thread.adapter, thread.threadRef],
  )
  return rows.length > 0
}
