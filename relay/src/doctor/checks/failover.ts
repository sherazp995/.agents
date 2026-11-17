/**
 * Who answers Slack when two laptops share one database (README,
 * "Failover"): which laptop holds the record and how long ago it renewed,
 * by the database's clock, and whether a build is too old to take over.
 * A laptop whose build lacks a migration the database has refuses to
 * answer, so this laptop failing that is `failed`; the other laptop failing
 * it is `degraded`, because Relay still answers from here.
 */

import { readdirSync } from 'node:fs'
import { resolveOperatorDatabaseUrl } from '../../config/database-url.js'
import { ConfigError } from '../../config/errors.js'
import { resolveMigrationsDirectory } from '../../config/paths.js'
import { selectPendingMigrations } from '../../db/migrate.js'
import { closePool, createPool } from '../../db/pool.js'
import type { CheckResult } from '../checks.js'
import { registerCheck, type Check, type CheckContext } from '../registry.js'

const NAME = 'failover'

export type FailoverCheckDependencies = {
  /** The newest migration this build ships; defaults to the last file in the migrations folder. */
  readonly buildMigration?: string
}

/** The newest migration file in `directory`, by the order migrations apply in. */
export function newestMigration(directory: string = resolveMigrationsDirectory()): string {
  return selectPendingMigrations(readdirSync(directory), new Set()).at(-1) ?? ''
}

type LeaseRow = { holder: string | null; renewed_ago: number | null; expired_ago: number | null }
type HostRow = { name: string; build_migration: string; preferred: boolean; seen_ago: number }

function ago(seconds: number): string {
  if (seconds < 120) return `${seconds}s ago`
  if (seconds < 7200) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

export function checkFailover(deps: FailoverCheckDependencies = {}): Check {
  return {
    name: NAME,
    async run(context: CheckContext): Promise<CheckResult> {
      const failover = context.config.failover
      if (failover === undefined) return { name: NAME, status: 'ok', detail: 'off: this laptop answers alone' }

      let url: string
      try {
        url = await resolveOperatorDatabaseUrl(context.config, context.secrets)
      } catch (error) {
        return {
          name: NAME,
          status: 'failed',
          detail: `the database URL could not be resolved: ${error instanceof ConfigError ? error.reason : (error as Error).message}`,
          remediation: 'Store this laptop\'s database URL with `relay secrets set relay-database-url`.',
        }
      }

      const build = deps.buildMigration ?? newestMigration()
      const pool = createPool(url)
      try {
        const lease = (
          await pool.query<LeaseRow>(
            `SELECT holder,
                    floor(extract(epoch FROM now() - renewed_at))::int AS renewed_ago,
                    CASE WHEN expires_at <= now() THEN floor(extract(epoch FROM now() - expires_at))::int END AS expired_ago
               FROM failover_lease WHERE id = 1`,
          )
        ).rows[0]
        const hosts = (
          await pool.query<HostRow>(
            `SELECT name, build_migration, preferred, floor(extract(epoch FROM now() - last_seen_at))::int AS seen_ago
               FROM failover_hosts ORDER BY name`,
          )
        ).rows
        const applied = (await pool.query<{ name: string | null }>('SELECT max(name) AS name FROM schema_migrations')).rows[0]?.name ?? ''

        const holder =
          lease?.holder == null
            ? 'no laptop holds the record'
            : lease.expired_ago !== null
              ? `${lease.holder} held the record, which expired ${ago(lease.expired_ago)}`
              : `${lease.holder} answers, renewed ${ago(lease.renewed_ago ?? 0)} (database time)`
        const self = `this laptop is ${failover.host}, ${failover.preferred ? 'preferred' : 'not preferred'}`
        const detail = `${holder}; ${self}`

        if (build < applied) {
          return {
            name: NAME,
            status: 'failed',
            detail: `${detail}; this build's newest migration ${build} is older than the database's ${applied}, so this laptop will not answer`,
            remediation: 'Update Relay on this laptop (git pull, pnpm install, pnpm build), then restart the daemon.',
          }
        }
        const behind = hosts.filter((host) => host.name !== failover.host && host.build_migration < applied)
        if (behind.length > 0) {
          return {
            name: NAME,
            status: 'degraded',
            detail: `${detail}; ${behind.map((host) => `${host.name} runs a build at ${host.build_migration}, older than the database's ${applied}, so it cannot take over`).join('; ')}`,
            remediation: `Update Relay on ${behind.map((host) => host.name).join(', ')}, then restart its daemon.`,
          }
        }
        const others = hosts.filter((host) => host.name !== failover.host).map((host) => `${host.name} last seen ${ago(host.seen_ago)}`)
        return { name: NAME, status: 'ok', detail: others.length > 0 ? `${detail}; ${others.join('; ')}` : detail }
      } catch (error) {
        const message = (error as Error).message
        const unmigrated = /relation .*failover_(lease|hosts).* does not exist/i.test(message)
        return {
          name: NAME,
          status: 'failed',
          detail: unmigrated ? 'failover is configured but the database has no failover tables yet' : `the failover record could not be read: ${message}`,
          remediation: unmigrated ? 'Start the daemon once, which applies migrations.' : 'Check the database is reachable from this laptop.',
        }
      } finally {
        await closePool(pool)
      }
    },
  }
}

registerCheck(checkFailover())
