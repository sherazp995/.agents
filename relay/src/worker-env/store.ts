/**
 * Stored envs and the laptop keys that may read them (migration 0031).
 * Values only ever leave this module sealed (to the database) or opened for
 * this laptop's own key; listing never reads them.
 */

import type { Pool, PoolClient } from 'pg'
import { registerSecretValue } from '../secrets/scrubber.js'
import { open, seal, sealContext, type ReaderKey } from './seal.js'
import type { EnvScope } from './scope.js'

/** A stored env without its value. */
export type EnvEntry = EnvScope & { readonly id: string; readonly updatedAt: Date }

/** A laptop key published in the database. */
export type EnvReader = { readonly fingerprint: string; readonly publicKey: string; readonly host: string }

/**
 * A failure whose message names the scope and never a value:
 * `no_readers` when no laptop key may read the entry yet, `unreadable` when
 * this laptop holds no copy or its copy does not open.
 */
export class WorkerEnvError extends Error {
  constructor(
    readonly kind: 'no_readers' | 'unreadable',
    message: string,
  ) {
    super(message)
    this.name = 'WorkerEnvError'
  }
}

/** True for Postgres "relation does not exist": the database has not been migrated to 0031 yet. */
export function isMissingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01'
}

/**
 * Publishes this laptop's key. Publishing it again refreshes the host name;
 * when that changed, the key loses its copies of the old host's values.
 */
export async function publishReader(pool: Pool, workspaceId: string, reader: EnvReader): Promise<void> {
  await pool.query(
    `INSERT INTO worker_env_readers (workspace_id, fingerprint, public_key, host) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, fingerprint) DO UPDATE SET host = EXCLUDED.host`,
    [workspaceId, reader.fingerprint, reader.publicKey, reader.host],
  )
  await pool.query(
    `DELETE FROM worker_env_copies c USING worker_env e
     WHERE c.workspace_id = $1 AND c.fingerprint = $2 AND e.id = c.entry_id AND e.host <> '' AND e.host <> $3`,
    [workspaceId, reader.fingerprint, reader.host],
  )
}

export async function listReaders(pool: Pool | PoolClient, workspaceId: string): Promise<EnvReader[]> {
  const { rows } = await pool.query<{ fingerprint: string; public_key: string; host: string }>(
    'SELECT fingerprint, public_key, host FROM worker_env_readers WHERE workspace_id = $1 ORDER BY created_at, fingerprint',
    [workspaceId],
  )
  return rows.map((row) => ({ fingerprint: row.fingerprint, publicKey: row.public_key, host: row.host }))
}

/** A host entry is for that host's keys only; every other entry is for all keys. */
export function mayRead(reader: EnvReader, entryHost: string): boolean {
  return entryHost === '' || reader.host === entryHost
}

/**
 * Stores `value` at `scope`, replacing any value there, sealed for every key
 * allowed to read it. All or nothing: the entry and its copies change in one
 * transaction.
 */
export async function putEntry(pool: Pool, workspaceId: string, scope: EnvScope, value: string): Promise<void> {
  registerSecretValue(value)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const readers = (await listReaders(client, workspaceId)).filter((reader) => mayRead(reader, scope.host))
    if (readers.length === 0) {
      throw new WorkerEnvError(
        'no_readers',
        scope.host === ''
          ? 'No laptop has published its key yet. Start Relay with this build on each laptop once, then add the env again.'
          : `The laptop "${scope.host}" has not published its key yet. Start Relay with this build there once, then add the env again.`,
      )
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO worker_env (workspace_id, host, folder, name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, host, folder, name) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [workspaceId, scope.host, scope.folder, scope.name],
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('putEntry: INSERT returned no id')
    await client.query('DELETE FROM worker_env_copies WHERE entry_id = $1', [id])
    const context = sealContext(workspaceId, scope)
    for (const reader of readers) {
      await client.query('INSERT INTO worker_env_copies (workspace_id, entry_id, fingerprint, sealed) VALUES ($1, $2, $3, $4)', [
        workspaceId,
        id,
        reader.fingerprint,
        seal(value, reader.publicKey, context),
      ])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Removes the entry at `scope`; false when there was none. */
export async function removeEntry(pool: Pool, workspaceId: string, scope: EnvScope): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM worker_env WHERE workspace_id = $1 AND host = $2 AND folder = $3 AND name = $4', [
    workspaceId,
    scope.host,
    scope.folder,
    scope.name,
  ])
  return (rowCount ?? 0) > 0
}

/** Stored entries without values; with `host`, only those for every laptop or for that one. */
export async function listEntries(pool: Pool, workspaceId: string, filter: { host?: string } = {}): Promise<EnvEntry[]> {
  const { rows } = await pool.query<{ id: string; host: string; folder: string; name: string; updated_at: Date }>(
    `SELECT id, host, folder, name, updated_at FROM worker_env
     WHERE workspace_id = $1 AND ($2::text IS NULL OR host IN ('', $2))
     ORDER BY name, host, folder`,
    [workspaceId, filter.host ?? null],
  )
  return rows.map((row) => ({ id: row.id, host: row.host, folder: row.folder, name: row.name, updatedAt: row.updated_at }))
}

/**
 * Opens `entries` with this laptop's key, by entry id. Throws a
 * WorkerEnvError naming the first entry this laptop cannot read. Every opened
 * value is registered with the output scrubber before it is returned.
 */
export async function openEntries(pool: Pool, workspaceId: string, key: ReaderKey, entries: readonly EnvEntry[]): Promise<Map<string, string>> {
  if (entries.length === 0) return new Map()
  const { rows } = await pool.query<{ entry_id: string; sealed: string }>(
    'SELECT entry_id, sealed FROM worker_env_copies WHERE workspace_id = $1 AND fingerprint = $2 AND entry_id = ANY($3::uuid[])',
    [workspaceId, key.fingerprint, entries.map((entry) => entry.id)],
  )
  const sealedBy = new Map(rows.map((row) => [row.entry_id, row.sealed]))
  const values = new Map<string, string>()
  for (const entry of entries) {
    const sealed = sealedBy.get(entry.id)
    const value = sealed === undefined ? undefined : tryOpen(sealed, key, sealContext(workspaceId, entry))
    if (value === undefined) throw new WorkerEnvError('unreadable', `This laptop cannot read the env ${describeScope(entry)}. Add it again with \`relay env add\`.`)
    registerSecretValue(value)
    values.set(entry.id, value)
  }
  return values
}

/**
 * Gives every key that may read an entry, but has no copy yet, a copy sealed
 * from this laptop's own. Entries this laptop cannot read are left for a
 * laptop that can. Returns how many copies were added.
 */
export async function relockForNewReaders(pool: Pool, workspaceId: string, key: ReaderKey): Promise<number> {
  const { rows } = await pool.query<{ entry_id: string; host: string; folder: string; name: string; sealed: string; fingerprint: string; public_key: string }>(
    `SELECT e.id AS entry_id, e.host, e.folder, e.name, own.sealed, r.fingerprint, r.public_key
     FROM worker_env e
     JOIN worker_env_copies own ON own.entry_id = e.id AND own.fingerprint = $2
     JOIN worker_env_readers r ON r.workspace_id = e.workspace_id AND (e.host = '' OR r.host = e.host)
     WHERE e.workspace_id = $1
       AND NOT EXISTS (SELECT 1 FROM worker_env_copies c WHERE c.entry_id = e.id AND c.fingerprint = r.fingerprint)`,
    [workspaceId, key.fingerprint],
  )
  let added = 0
  for (const row of rows) {
    const context = sealContext(workspaceId, row)
    const value = tryOpen(row.sealed, key, context)
    if (value === undefined) continue
    const result = await pool.query(
      'INSERT INTO worker_env_copies (workspace_id, entry_id, fingerprint, sealed) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [workspaceId, row.entry_id, row.fingerprint, seal(value, row.public_key, context)],
    )
    added += result.rowCount ?? 0
  }
  return added
}

/** `NAME` with its host and folder, for messages; never the value. */
export function describeScope(scope: EnvScope): string {
  const where = [scope.host === '' ? '' : `on ${scope.host}`, scope.folder === '' ? '' : `in ${scope.folder}`].filter((part) => part !== '').join(' ')
  return where === '' ? `${scope.name} (default)` : `${scope.name} (${where})`
}

function tryOpen(sealed: string, key: ReaderKey, context: string): string | undefined {
  try {
    return open(sealed, key.privateKey, context)
  } catch {
    return undefined
  }
}
