/**
 * The "who is answering" record (README, "Failover"). Every time and expiry
 * here is the database's clock, and every change is one atomic statement, so
 * laptop clocks and two laptops racing do not matter. Each grant bumps the
 * generation, so a laptop that lost the record is told apart from the one
 * holding it now even when both use the same name.
 *
 * Hand back is cooperative: the preferred laptop raises wants_back_at, the
 * holder sees it on its next renewal and releases, and only then can the
 * preferred laptop claim. A raised flag never takes the record from a holder.
 */

import type { Pool, QueryResult, QueryResultRow } from 'pg'

/** How long a claim or renewal holds the record, in database seconds. */
export const LEASE_TTL_SECONDS = 60
/** A laptop not seen for this long is treated as gone: its hand back flag and its workers stop counting. */
export const HOST_FRESH_SECONDS = 60

export type HostRegistration = {
  readonly name: string
  readonly home: string
  /** The newest migration file this build ships. */
  readonly buildMigration: string
  readonly preferred: boolean
}

export type Renewal = {
  /** False once the record is no longer ours (expired, taken, or released). */
  readonly held: boolean
  /** A preferred laptop seen within HOST_FRESH_SECONDS is asking for the record back. */
  readonly wantsBack: boolean
}

/** The one query shape the failover statements use. */
export type LeaseDb = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

/**
 * Limits every request. query_timeout makes pg drop the stuck connection; the
 * outer timer also covers the wait for a connection from the pool.
 */
export function boundedLeaseDb(pool: Pool, limitMs: number): LeaseDb {
  return {
    query: <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) =>
      new Promise<QueryResult<R>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`a failover database request took longer than ${limitMs} ms`)), limitMs)
        const config = { text, ...(values ? { values } : {}), query_timeout: limitMs }
        pool.query<R>(config).then(resolve, reject).finally(() => clearTimeout(timer))
      }),
  }
}

/** True once migration 0030 has made the failover tables. */
export async function failoverTablesExist(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>("SELECT to_regclass('failover_lease') IS NOT NULL AS exists")
  return rows[0]?.exists === true
}

/** Adds or refreshes this laptop's row. A restarted laptop decides afresh whether to ask for the record back. */
export async function registerHost(pool: LeaseDb, host: HostRegistration): Promise<void> {
  await pool.query(
    `INSERT INTO failover_hosts (name, home, build_migration, preferred, wants_back_at, last_seen_at)
     VALUES ($1, $2, $3, $4, NULL, now())
     ON CONFLICT (name) DO UPDATE SET home = EXCLUDED.home, build_migration = EXCLUDED.build_migration,
       preferred = EXCLUDED.preferred, wants_back_at = NULL, last_seen_at = now()`,
    [host.name, host.home, host.buildMigration, host.preferred],
  )
}

/** Keeps this laptop's last seen time fresh, so the other laptop treats its workers as alive. */
export async function touchHost(pool: LeaseDb, name: string): Promise<void> {
  await pool.query('UPDATE failover_hosts SET last_seen_at = now() WHERE name = $1', [name])
}

/**
 * Takes the record when it is free or expired, and returns the new
 * generation; null when someone else holds it, or when another laptop's
 * fresh hand back flag reserves it for that laptop. The row lock makes two
 * laptops claiming at once see each other: the second re-checks the row the
 * first just wrote and finds it held.
 */
export async function claimLease(pool: LeaseDb, host: string, ttlSeconds = LEASE_TTL_SECONDS): Promise<string | null> {
  const { rows } = await pool.query<{ generation: string }>(
    `WITH claimed AS (
       UPDATE failover_lease
          SET holder = $1, generation = generation + 1, renewed_at = now(),
              expires_at = now() + make_interval(secs => $2::float8)
        WHERE id = 1
          AND (holder IS NULL OR expires_at < now())
          AND NOT EXISTS (
            SELECT 1 FROM failover_hosts h
             WHERE h.name <> $1 AND h.wants_back_at IS NOT NULL
               AND h.last_seen_at > now() - make_interval(secs => $3::float8))
       RETURNING generation
     ), cleared AS (
       UPDATE failover_hosts SET wants_back_at = NULL, last_seen_at = now()
        WHERE name = $1 AND EXISTS (SELECT 1 FROM claimed)
     )
     SELECT generation::text AS generation FROM claimed`,
    [host, ttlSeconds, HOST_FRESH_SECONDS],
  )
  return rows[0]?.generation ?? null
}

/**
 * Extends the record if it is still ours and not yet expired, and bumps this
 * laptop's last seen time either way. An expired record is not revived: the
 * laptop has already stopped trusting it, and the other laptop may be about
 * to take it.
 */
export async function renewLease(pool: LeaseDb, host: string, generation: string, ttlSeconds = LEASE_TTL_SECONDS): Promise<Renewal> {
  const { rows } = await pool.query<{ held: boolean; wants_back: boolean }>(
    `WITH renewed AS (
       UPDATE failover_lease
          SET renewed_at = now(), expires_at = now() + make_interval(secs => $3::float8)
        WHERE id = 1 AND holder = $1 AND generation = $2::bigint AND expires_at > now()
       RETURNING 1
     ), seen AS (
       UPDATE failover_hosts SET last_seen_at = now() WHERE name = $1
     )
     SELECT EXISTS (SELECT 1 FROM renewed) AS held,
            EXISTS (SELECT 1 FROM failover_hosts h
                     WHERE h.name <> $1 AND h.preferred AND h.wants_back_at IS NOT NULL
                       AND h.last_seen_at > now() - make_interval(secs => $4::float8)) AS wants_back`,
    [host, generation, ttlSeconds, HOST_FRESH_SECONDS],
  )
  return { held: rows[0]?.held === true, wantsBack: rows[0]?.wants_back === true }
}

/** The live holder of the default record, by the database's clock; null when nobody holds it. */
export async function liveHolder(pool: LeaseDb): Promise<string | null> {
  const { rows } = await pool.query<{ holder: string }>('SELECT holder FROM failover_lease WHERE id = 1 AND holder IS NOT NULL AND expires_at > now()')
  return rows[0]?.holder ?? null
}

/**
 * The laptops that can take work now: seen within HOST_FRESH_SECONDS and on
 * a build that knows every migration the database has. A laptop on an older
 * build keeps updating its last seen time while it waits to be updated, so
 * being seen alone does not make it ready.
 */
export async function readyHosts(pool: LeaseDb): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM failover_hosts
      WHERE last_seen_at > now() - make_interval(secs => $1::float8)
        AND build_migration >= COALESCE((SELECT max(name) FROM schema_migrations), '')
      ORDER BY name`,
    [HOST_FRESH_SECONDS],
  )
  return rows.map((row) => row.name)
}

/** Publishes the Slack reminder channels this laptop's config lists, so a reminder the other laptop receives is passed here. */
export async function publishReminderChannels(pool: LeaseDb, host: string, channels: readonly string[]): Promise<void> {
  await pool.query('UPDATE failover_hosts SET reminder_channels = $2 WHERE name = $1', [host, [...channels]])
}

/** The ready laptop whose config lists `channel` as a reminder channel, if any. */
export async function reminderHost(pool: LeaseDb, channel: string): Promise<string | null> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM failover_hosts
      WHERE $1 = ANY (reminder_channels) AND last_seen_at > now() - make_interval(secs => $2::float8)
      ORDER BY name LIMIT 1`,
    [channel, HOST_FRESH_SECONDS],
  )
  return rows[0]?.name ?? null
}

/** True once migration 0034 has added the pause columns; before it, a laptop cannot be asked to pause. */
export async function pauseSupported(pool: LeaseDb): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'failover_hosts' AND column_name = 'pause_requested_at'",
  )
  return rows.length > 0
}

/** Other laptops seen recently, with their build: who must pause, or be stopped, before a migration. */
export async function otherFreshHosts(pool: LeaseDb, host: string): Promise<{ name: string; buildMigration: string }[]> {
  const { rows } = await pool.query<{ name: string; build_migration: string }>(
    `SELECT name, build_migration FROM failover_hosts
      WHERE name <> $1 AND last_seen_at > now() - make_interval(secs => $2::float8) ORDER BY name`,
    [host, HOST_FRESH_SECONDS],
  )
  return rows.map((row) => ({ name: row.name, buildMigration: row.build_migration }))
}

/** This laptop asks the others to stop starting work so it can migrate (null withdraws the request). */
export async function setPauseRequest(pool: LeaseDb, host: string, requested: boolean): Promise<void> {
  await pool.query(
    `UPDATE failover_hosts SET pause_requested_at = CASE WHEN $2 THEN COALESCE(pause_requested_at, now()) END, last_seen_at = now() WHERE name = $1`,
    [host, requested],
  )
}

/** True while another laptop seen recently asks this one to pause. */
export async function pauseRequestedByOther(pool: LeaseDb, host: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM failover_hosts
      WHERE name <> $1 AND pause_requested_at IS NOT NULL AND last_seen_at > now() - make_interval(secs => $2::float8)`,
    [host, HOST_FRESH_SECONDS],
  )
  return rows.length > 0
}

/** Records that this laptop has stopped starting work for a pause request (false: it has resumed). */
export async function setPausedAt(pool: LeaseDb, host: string, paused: boolean): Promise<void> {
  await pool.query('UPDATE failover_hosts SET paused_at = CASE WHEN $2 THEN now() END WHERE name = $1', [host, paused])
}

/** True when every other laptop seen recently has paused since this laptop asked. */
export async function othersPaused(pool: LeaseDb, host: string): Promise<boolean> {
  const { rows } = await pool.query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM failover_hosts o, failover_hosts me
        WHERE me.name = $1 AND o.name <> $1 AND o.last_seen_at > now() - make_interval(secs => $2::float8)
          AND (me.pause_requested_at IS NULL OR o.paused_at IS NULL OR o.paused_at < me.pause_requested_at)
     ) AS waiting`,
    [host, HOST_FRESH_SECONDS],
  )
  return rows[0]?.waiting === false
}

/** Gives the record up so the other laptop can claim it at once; a no-op when it is no longer ours. */
export async function releaseLease(pool: LeaseDb, host: string, generation: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE failover_lease SET holder = NULL, renewed_at = NULL, expires_at = NULL
      WHERE id = 1 AND holder = $1 AND generation = $2::bigint`,
    [host, generation],
  )
  return rowCount === 1
}

/** The preferred laptop asks for the record back; only a preferred laptop's flag counts. */
export async function raiseWantsBack(pool: LeaseDb, host: string): Promise<void> {
  await pool.query(
    `UPDATE failover_hosts SET wants_back_at = COALESCE(wants_back_at, now()), last_seen_at = now()
      WHERE name = $1 AND preferred`,
    [host],
  )
}

/**
 * The newest migration the database has applied that this build does not
 * know, or null. A build older than the database must not answer: its
 * queries may not match the schema.
 */
export async function newerAppliedMigration(pool: LeaseDb, buildMigration: string): Promise<string | null> {
  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations WHERE name > $1 ORDER BY name DESC LIMIT 1',
    [buildMigration],
  )
  return rows[0]?.name ?? null
}

/** True while another laptop seen recently still has workers running; migrations wait for them. */
export async function otherHostsHaveRunningWorkers(pool: LeaseDb, host: string): Promise<boolean> {
  const { rows } = await pool.query<{ busy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM failover_hosts h
        WHERE h.name <> $1 AND h.last_seen_at > now() - make_interval(secs => $2::float8)
          AND (EXISTS (SELECT 1 FROM autonomous_tasks t WHERE t.worker_host = h.name AND t.worker_pgid IS NOT NULL)
            OR EXISTS (SELECT 1 FROM team_assignments a WHERE a.worker_host = h.name AND a.worker_pgid IS NOT NULL))
     ) AS busy`,
    [host, HOST_FRESH_SECONDS],
  )
  return rows[0]?.busy === true
}
