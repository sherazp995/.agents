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

import type { Pool } from 'pg'

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

/** True once migration 0030 has made the failover tables. */
export async function failoverTablesExist(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>("SELECT to_regclass('failover_lease') IS NOT NULL AS exists")
  return rows[0]?.exists === true
}

/** Adds or refreshes this laptop's row. A restarted laptop decides afresh whether to ask for the record back. */
export async function registerHost(pool: Pool, host: HostRegistration): Promise<void> {
  await pool.query(
    `INSERT INTO failover_hosts (name, home, build_migration, preferred, wants_back_at, last_seen_at)
     VALUES ($1, $2, $3, $4, NULL, now())
     ON CONFLICT (name) DO UPDATE SET home = EXCLUDED.home, build_migration = EXCLUDED.build_migration,
       preferred = EXCLUDED.preferred, wants_back_at = NULL, last_seen_at = now()`,
    [host.name, host.home, host.buildMigration, host.preferred],
  )
}

/** Keeps this laptop's last seen time fresh, so the other laptop treats its workers as alive. */
export async function touchHost(pool: Pool, name: string): Promise<void> {
  await pool.query('UPDATE failover_hosts SET last_seen_at = now() WHERE name = $1', [name])
}

/**
 * Takes the record when it is free or expired, and returns the new
 * generation; null when someone else holds it, or when another laptop's
 * fresh hand back flag reserves it for that laptop. The row lock makes two
 * laptops claiming at once see each other: the second re-checks the row the
 * first just wrote and finds it held.
 */
export async function claimLease(pool: Pool, host: string, ttlSeconds = LEASE_TTL_SECONDS): Promise<string | null> {
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
export async function renewLease(pool: Pool, host: string, generation: string, ttlSeconds = LEASE_TTL_SECONDS): Promise<Renewal> {
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

/** True while the record is still ours at this generation and unexpired: the check before starting work. */
export async function stillHolds(pool: Pool, host: string, generation: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM failover_lease WHERE id = 1 AND holder = $1 AND generation = $2::bigint AND expires_at > now()',
    [host, generation],
  )
  return rows.length > 0
}

/** Gives the record up so the other laptop can claim it at once; a no-op when it is no longer ours. */
export async function releaseLease(pool: Pool, host: string, generation: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE failover_lease SET holder = NULL, renewed_at = NULL, expires_at = NULL
      WHERE id = 1 AND holder = $1 AND generation = $2::bigint`,
    [host, generation],
  )
  return rowCount === 1
}

/** The preferred laptop asks for the record back; only a preferred laptop's flag counts. */
export async function raiseWantsBack(pool: Pool, host: string): Promise<void> {
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
export async function newerAppliedMigration(pool: Pool, buildMigration: string): Promise<string | null> {
  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations WHERE name > $1 ORDER BY name DESC LIMIT 1',
    [buildMigration],
  )
  return rows[0]?.name ?? null
}

/**
 * True while `host` has a worker process recorded: a task or team member
 * whose process group is still set. The runtime clears it when the worker
 * ends.
 */
export async function hostHasRunningWorkers(pool: Pool, host: string): Promise<boolean> {
  const { rows } = await pool.query<{ busy: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM autonomous_tasks WHERE worker_host = $1 AND worker_pgid IS NOT NULL)
         OR EXISTS (SELECT 1 FROM team_assignments WHERE worker_host = $1 AND worker_pgid IS NOT NULL) AS busy`,
    [host],
  )
  return rows[0]?.busy === true
}

/** True while another laptop seen recently still has workers running; migrations wait for them. */
export async function otherHostsHaveRunningWorkers(pool: Pool, host: string): Promise<boolean> {
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
