/**
 * This laptop's env key (README, "Envs for Relay's sessions"). The daemon
 * reads the private half from its keystore, or makes a key pair the first
 * time and stores it the way `relay secrets set` does. It then publishes the
 * public half for every workspace and, on a timer, seals the values it can
 * read for laptops that have joined since, so a new laptop gets its copies
 * without the other one restarting.
 *
 * A key problem never stops Relay: it runs without a key, and only sessions
 * that need a stored value wait. Key material is never logged.
 */

import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'
import type { SecretProvider } from '../secrets/provider.js'
import { generateReaderKey, readerKeyFromPrivate, type ReaderKey } from './seal.js'
import { isMissingTable, publishReader, relockForNewReaders } from './store.js'

export const WORKER_ENV_KEY_SECRET = 'relay-worker-env-key'
export const RELOCK_INTERVAL_MS = 60_000

/** Stores a new keystore item, never replacing one (runSecretsSet with replace: false). */
export type StoreSecret = (name: string, value: string) => Promise<{ readonly exitCode: number; readonly report: string }>

export type LoadKeyDeps = {
  readonly secrets: SecretProvider
  readonly storeSecret: StoreSecret
  readonly log: Logger
  readonly generate?: () => ReaderKey
}

/** This laptop's key, made and stored on first use; null when the keystore cannot give or keep one. */
export async function loadReaderKey(deps: LoadKeyDeps): Promise<ReaderKey | null> {
  if (deps.secrets.kind === 'env') {
    deps.log.warn('the env secret provider cannot store this laptop\'s env key; sessions that need a stored env will wait')
    return null
  }
  try {
    if (await deps.secrets.has(WORKER_ENV_KEY_SECRET)) return readerKeyFromPrivate(await deps.secrets.get(WORKER_ENV_KEY_SECRET))
  } catch (error) {
    deps.log.warn({ errName: (error as Error).name }, `could not read ${WORKER_ENV_KEY_SECRET} from the keystore; sessions that need a stored env will wait`)
    return null
  }
  const key = (deps.generate ?? generateReaderKey)()
  const stored = await deps.storeSecret(WORKER_ENV_KEY_SECRET, key.privateKey).catch((error: unknown) => ({ exitCode: 1, report: (error as Error).name }))
  if (stored.exitCode !== 0) {
    deps.log.warn({ report: stored.report }, `could not store a new ${WORKER_ENV_KEY_SECRET}; sessions that need a stored env will wait`)
    return null
  }
  deps.log.info({ fingerprint: key.fingerprint }, 'made this laptop\'s env key')
  return key
}

/** This laptop's key when the keystore has one; never makes one, for commands that must not change the keystore. */
export async function readReaderKey(secrets: SecretProvider): Promise<ReaderKey | null> {
  if (secrets.kind === 'env' || !(await secrets.has(WORKER_ENV_KEY_SECRET))) return null
  return readerKeyFromPrivate(await secrets.get(WORKER_ENV_KEY_SECRET))
}

/** Publishes the key for every workspace and gives laptops without copies theirs. */
export async function syncReaderKey(pool: Pool, key: ReaderKey, host: string, log: Logger): Promise<void> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id')
  for (const { id } of rows) {
    await publishReader(pool, id, { fingerprint: key.fingerprint, publicKey: key.publicKey, host })
    const added = await relockForNewReaders(pool, id, key)
    if (added > 0) log.info({ workspaceId: id, added }, 'sealed stored envs for a laptop that joined')
  }
}

export type ReaderKeySync = {
  /** One pass now; never throws. */
  sync(): Promise<void>
  stop(): void
}

/**
 * Runs syncReaderKey now and every `intervalMs`. A database not yet migrated
 * to the env tables (a laptop waiting for the other one to apply migrations) is retried
 * quietly. The timer is unreferenced: it never keeps the process alive.
 */
export function startReaderKeySync(deps: { pool: Pool; key: ReaderKey; host: string; log: Logger; intervalMs?: number }): ReaderKeySync {
  let running: Promise<void> | undefined
  const sync = (): Promise<void> => {
    running ??= syncReaderKey(deps.pool, deps.key, deps.host, deps.log)
      .catch((error: unknown) => {
        if (!isMissingTable(error)) deps.log.warn({ err: error }, 'could not publish this laptop\'s env key or seal envs for a new laptop; retrying later')
      })
      .finally(() => {
        running = undefined
      })
    return running
  }
  const timer = setInterval(() => void sync(), deps.intervalMs ?? RELOCK_INTERVAL_MS)
  timer.unref()
  void sync()
  return { sync, stop: () => clearInterval(timer) }
}
