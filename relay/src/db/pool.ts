import pg from 'pg'

const { Pool } = pg
type Pool = InstanceType<typeof pg.Pool>

/**
 * Connections the daemon may hold when `database.pool_max` is unset. The
 * hosted pooler caps each login (one per laptop) at a fixed number of
 * clients, so the daemon stays well under it and leaves room for commands.
 */
export const DAEMON_POOL_MAX = 5

/**
 * Connections a one-shot command (doctor, live, notify, ...) may hold. Two,
 * not one: a LISTEN wait or an advisory lock keeps one client checked out
 * while the same command still runs queries on the pool.
 */
export const COMMAND_POOL_MAX = 2

/**
 * Creates the Postgres pool. One module knows connection details.
 *
 * The connection timeout is bounded so `relay doctor` reports an unreachable
 * server promptly instead of appearing to hang. Idle clients close after ten
 * seconds and sockets carry TCP keepalives, so a connection left behind by a
 * laptop that slept or changed network is noticed instead of holding one of
 * the pooler's few slots.
 */
export function createPool(url: string, options: { max?: number } = {}): Pool {
  const pool = new Pool({
    connectionString: url,
    max: options.max ?? COMMAND_POOL_MAX,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  })
  // pg's Pool emits 'error' on a client that is idle in the pool when its
  // backend connection drops, for example a server restart or an admin
  // running pg_terminate_backend. With no listener, Node treats that as an
  // unhandled 'error' event and crashes the process. The pool itself already
  // discards the broken client and creates a fresh one on the next checkout,
  // so there is nothing to do here beyond preventing the crash.
  pool.on('error', () => {})
  // The pool's listener covers idle clients only. A client a caller holds
  // between queries (a transaction, a LISTEN wait) raises the same 'error' on
  // itself, and the daemon crashed on one when the pooler timed out. Its next
  // query rejects, and the pool drops it on release, so ignoring it is safe.
  pool.on('connect', (client) => {
    client.on('error', () => {})
  })
  return pool
}

/** Closes the pool. Always awaited in shutdown paths so tests do not hang. */
export async function closePool(pool: Pool): Promise<void> {
  await pool.end()
}
