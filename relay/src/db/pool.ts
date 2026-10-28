import pg from 'pg'

const { Pool } = pg
type Pool = InstanceType<typeof pg.Pool>

/**
 * Creates the Postgres pool. One module knows connection details.
 *
 * The connection timeout is bounded so `relay doctor` reports an unreachable
 * server promptly instead of appearing to hang.
 */
export function createPool(url: string): Pool {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 3000 })
  // pg's Pool emits 'error' on a client that is idle in the pool when its
  // backend connection drops, for example a server restart or an admin
  // running pg_terminate_backend. With no listener, Node treats that as an
  // unhandled 'error' event and crashes the process. The pool itself already
  // discards the broken client and creates a fresh one on the next checkout,
  // so there is nothing to do here beyond preventing the crash.
  pool.on('error', () => {})
  return pool
}

/** Closes the pool. Always awaited in shutdown paths so tests do not hang. */
export async function closePool(pool: Pool): Promise<void> {
  await pool.end()
}
