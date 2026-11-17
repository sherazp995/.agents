/**
 * `relay db create`: creates the Postgres role and database that
 * `database.url` names, so a fresh machine needs no hand-typed psql.
 *
 * It first tries the URL as configured; when that already connects there is
 * nothing to do. Otherwise it creates the role (or resets its password to
 * the one in the URL) and the database it owns, as a Postgres superuser:
 * `sudo -u postgres psql` on Linux, where sudo asks for the operator's
 * password in the terminal, and `psql` as the operator on macOS, which is
 * how Homebrew's Postgres is set up (plan decision 2). Only a server on this
 * machine is touched; for any other host the SQL is printed instead.
 *
 * The password never reaches argv (the process table is world readable) or
 * the report: the SQL goes to psql on stdin, and the printed SQL holds a
 * placeholder.
 */

import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import { parseDocument } from 'yaml'
import { keystoreReference, resolveDatabaseUrl } from '../config/database-url.js'
import { loadRelayConfig } from '../config/load.js'
import { resolveMigrationsDirectory, resolveRelayHome } from '../config/paths.js'
import { applyMigrations, selectPendingMigrations } from '../db/migrate.js'
import { closePool, createPool } from '../db/pool.js'
import { createSecretProvider } from '../secrets/index.js'
import { DATABASE_URL_SECRET, daemonPidFilePath, relaySecretsHelperPath } from '../secrets/keychain.js'

/**
 * Where `relay db move` keeps the URL Relay used before the move, so going
 * back is one `relay secrets set relay-database-url`. Its own item, so the
 * admin URL `relay secrets migrate` keeps is never overwritten.
 */
export const DATABASE_LOCAL_URL_SECRET = 'relay-database-local-url'
import type { SecretProvider } from '../secrets/provider.js'
import { registerSecretValue, scrubSecrets } from '../secrets/scrubber.js'
import { runSecretsSet } from './secrets.js'
import { SERVICE_LABEL, SYSTEMD_UNIT } from './service.js'

export type DbResult = { readonly report: string; readonly exitCode: number }

export type DbCreateParams = { readonly configPath: string }

export type DbConnection = { readonly user: string; readonly database: string }

export type DbCreateDependencies = {
  /** The database URL to create; defaults to config's database.url, resolved through the keystore. */
  readonly resolveUrl?: (configPath: string) => Promise<string>
  /** Connects and runs one query; rejects when the URL does not connect. */
  readonly connect?: (url: string) => Promise<DbConnection>
  /** Runs `command args` with `sql` on stdin and the terminal for everything else; resolves with the exit code. */
  readonly runPsql?: (command: string, args: readonly string[], sql: string) => Promise<number>
  readonly platform?: NodeJS.Platform
}

/** Plain identifiers only, so the quoting below is belt and braces, not the only guard. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
/** The DO block's dollar quote; a password holding it is refused rather than escaped. */
const DOLLAR_TAG = '$relay_db_create$'
const PASSWORD_PLACEHOLDER = '<the password in database.url>'
const CONNECT_TIMEOUT_MS = 3000

export type DatabaseTarget = {
  readonly user: string
  readonly password: string
  /** Empty for a Unix socket in the default directory. */
  readonly host: string
  readonly port: number
  readonly database: string
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function parseDatabaseUrl(url: string): DatabaseTarget {
  const parsed = new URL(url)
  const hostParam = parsed.searchParams.get('host') ?? ''
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname !== '' ? parsed.hostname.replace(/^\[(.*)\]$/, '$1') : hostParam,
    port: parsed.port !== '' ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  }
}

/** localhost, a loopback address, or a Unix socket (no host, or a host that is a directory). */
export function isLocalHost(host: string): boolean {
  return host === '' || host.startsWith('/') || LOCAL_HOSTS.has(host)
}

/** The SQL that makes `target.user` a login role with its password and `target.database` a database it owns; psql runs it. */
export function buildCreateSql(target: Pick<DatabaseTarget, 'user' | 'password' | 'database'>): string {
  const role = quoteIdentifier(target.user)
  const password = target.password === '' ? '' : ` PASSWORD ${quoteLiteral(target.password)}`
  return [
    `DO ${DOLLAR_TAG}`,
    'BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(target.user)}) THEN`,
    `    CREATE ROLE ${role} LOGIN${password};`,
    '  ELSE',
    `    ALTER ROLE ${role} LOGIN${password};`,
    '  END IF;',
    'END',
    `${DOLLAR_TAG};`,
    // CREATE DATABASE cannot run inside a DO block or a transaction, so psql
    // runs it as its own statement, and only when the database is missing.
    `SELECT ${quoteLiteral(`CREATE DATABASE ${quoteIdentifier(target.database)} OWNER ${role}`)}`,
    `WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(target.database)})\\gexec`,
    '',
  ].join('\n')
}

/** The superuser psql for this platform; never carries the SQL or the password. */
export function psqlCommand(platform: NodeJS.Platform, target: DatabaseTarget): { command: string; args: string[] } {
  const common = ['-v', 'ON_ERROR_STOP=1', '-p', String(target.port), '-d', 'postgres']
  if (platform === 'darwin') return { command: 'psql', args: [...(target.host !== '' ? ['-h', target.host] : []), ...common] }
  // The postgres OS user reaches the server over its default socket with peer authentication.
  return { command: 'sudo', args: ['-u', 'postgres', 'psql', ...common] }
}

async function resolveConfiguredUrl(configPath: string): Promise<string> {
  const config = loadRelayConfig(configPath)
  return resolveDatabaseUrl(config, createSecretProvider(config))
}

async function connectOnce(url: string): Promise<DbConnection> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS })
  await client.connect()
  try {
    const { rows } = await client.query<{ user: string; database: string }>('SELECT current_user AS user, current_database() AS database')
    return { user: rows[0]?.user ?? '', database: rows[0]?.database ?? '' }
  } finally {
    await client.end().catch(() => {})
  }
}

/** Spawns psql with the SQL on stdin; sudo reads its password from the terminal, not stdin, so both work at once. */
export function runPsqlProcess(command: string, args: readonly string[], sql: string): Promise<number> {
  return new Promise((resolvePromise) => {
    // cwd `/`, because the postgres user often cannot read the operator's current folder and psql warns about it.
    const child = spawn(command, args as string[], { cwd: '/', stdio: ['pipe', 'inherit', 'inherit'] })
    child.on('error', () => resolvePromise(127))
    child.on('close', (code) => resolvePromise(code ?? 1))
    child.stdin.on('error', () => {})
    child.stdin.end(sql)
  })
}

async function tryConnect(connect: NonNullable<DbCreateDependencies['connect']>, url: string): Promise<DbConnection | Error> {
  try {
    return await connect(url)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

export async function runDbCreate(params: DbCreateParams, deps: DbCreateDependencies = {}): Promise<DbResult> {
  const connect = deps.connect ?? connectOnce
  const platform = deps.platform ?? process.platform

  let url: string
  try {
    url = await (deps.resolveUrl ?? resolveConfiguredUrl)(params.configPath)
  } catch (error) {
    return { report: `Could not read the database URL: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
  }

  const first = await tryConnect(connect, url)
  if (!(first instanceof Error)) {
    return { report: `database.url already connects as ${first.user} to ${first.database}; nothing to do.`, exitCode: 0 }
  }

  let target: DatabaseTarget
  try {
    target = parseDatabaseUrl(url)
  } catch {
    return { report: 'database.url is not a URL Relay can parse, so it cannot create its role and database.', exitCode: 1 }
  }
  if (!IDENTIFIER.test(target.user) || !IDENTIFIER.test(target.database)) {
    return {
      report: `database.url names role "${target.user}" and database "${target.database}"; relay db create only creates plain names (letters, digits, _ and -).`,
      exitCode: 1,
    }
  }
  if (target.password.includes(DOLLAR_TAG)) {
    return { report: `The password in database.url contains ${DOLLAR_TAG}, which relay db create cannot quote; pick another password.`, exitCode: 1 }
  }

  if (!isLocalHost(target.host)) {
    return {
      report: [
        `database.url does not connect (${first.message}), and its host ${target.host} is not this machine, so Relay will not create anything there.`,
        'Run this as a superuser on that server, replacing the placeholder:',
        '',
        buildCreateSql({ ...target, password: target.password === '' ? '' : PASSWORD_PLACEHOLDER }),
      ].join('\n'),
      exitCode: 1,
    }
  }

  const { command, args } = psqlCommand(platform, target)
  const exitCode = await (deps.runPsql ?? runPsqlProcess)(command, args, buildCreateSql(target))
  if (exitCode !== 0) {
    return { report: `\`${command} ${args.join(' ')}\` exited ${exitCode}; the role and database may not exist yet.`, exitCode: 1 }
  }

  const second = await tryConnect(connect, url)
  if (second instanceof Error) {
    return { report: `Created role ${target.user} and database ${target.database}, but database.url still does not connect: ${second.message}`, exitCode: 1 }
  }
  return { report: `Created role ${target.user} and database ${target.database}; database.url now connects as ${second.user} to ${second.database}.`, exitCode: 0 }
}

// ---------------------------------------------------------------------------
// `relay db move <url>`: copies this laptop's Relay database into an empty
// Postgres (the shared cloud one for failover, README "Failover") once, then
// points config at it. Everything that can fail runs before config or the
// keystore change, so a failed move leaves the local setup as it was.
// ---------------------------------------------------------------------------

export type DbMoveParams = {
  readonly configPath: string
  /** The target's connection URL, password included; it goes to the keystore, never into a report. */
  readonly targetUrl: string
  readonly migrationsDir?: string
}

export type DbMoveDependencies = {
  /** Where the daemon's pid file lives; defaults to RELAY_HOME. */
  readonly relayHome?: string
  /** Reads database.url when it is a keystore reference; defaults to the CLI's provider (a Keychain prompt on macOS). */
  readonly secrets?: SecretProvider
  /** Stores one keystore item, replacing any value; defaults to `relay secrets set --replace`. */
  readonly storeSecret?: (name: string, value: string) => Promise<DbResult>
}

/** Tables migrations fill themselves, so a fresh target is not "in use" because of them. The lease row names no laptop until failover_hosts has one. */
const SEEDED_BY_MIGRATIONS = new Set(['schema_migrations', 'failover_lease'])
const MOVE_FETCH_ROWS = 100

/** The daemon's pid when its pid file names a live process; only a daemon reading the Keychain writes the file. */
export function runningDaemonPid(relayHome: string): number | undefined {
  let pid: number
  try {
    pid = Number(readFileSync(daemonPidFilePath(relayHome), 'utf8').trim())
  } catch {
    return undefined
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    // EPERM: the process exists but belongs to someone else, so it still runs.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : undefined
  }
}

/** host:port/database, the only part of a URL a report shows. */
function describeTarget(url: string): string {
  const target = parseDatabaseUrl(url)
  return `${target.host === '' ? 'local socket' : target.host}:${target.port}/${target.database}`
}

function sameDatabase(a: string, b: string): boolean {
  const left = parseDatabaseUrl(a)
  const right = parseDatabaseUrl(b)
  return left.host === right.host && left.port === right.port && left.database === right.database
}

async function publicTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY relname`,
  )
  return rows.map((row) => row.name)
}

async function tableColumns(client: pg.Client, table: string): Promise<Map<string, string>> {
  const { rows } = await client.query<{ name: string; type: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attnum`,
    [table],
  )
  return new Map(rows.map((row) => [row.name, row.type]))
}

async function countRows(client: pg.Client, table: string): Promise<number> {
  const { rows } = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM public.${client.escapeIdentifier(table)}`)
  return rows[0]?.count ?? 0
}

/**
 * Parents before children, from the target's foreign keys. A table that
 * references itself would also need its rows ordered; none does today, and
 * if one appears its insert fails and the whole copy rolls back.
 */
async function dependencyOrder(client: pg.Client, tables: readonly string[]): Promise<string[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(
    `SELECT child.relname AS child, parent.relname AS parent
       FROM pg_constraint k
       JOIN pg_class child ON child.oid = k.conrelid
       JOIN pg_class parent ON parent.oid = k.confrelid
      WHERE k.contype = 'f' AND k.conrelid <> k.confrelid
        AND child.relnamespace = 'public'::regnamespace AND parent.relnamespace = 'public'::regnamespace`,
  )
  const wanted = new Set(tables)
  const parents = new Map(tables.map((table) => [table, new Set<string>()]))
  for (const row of rows) if (wanted.has(row.child) && wanted.has(row.parent)) parents.get(row.child)?.add(row.parent)
  const ordered: string[] = []
  const done = new Set<string>()
  while (ordered.length < tables.length) {
    const ready = tables.filter((table) => !done.has(table) && [...(parents.get(table) ?? [])].every((parent) => done.has(parent)))
    if (ready.length === 0) throw new Error(`the foreign keys between ${tables.filter((table) => !done.has(table)).join(', ')} form a cycle`)
    for (const table of ready) {
      ordered.push(table)
      done.add(table)
    }
  }
  return ordered
}

/** Both sides speak the same text formats, so timestamps keep their microseconds and bytea its bytes: no value passes through JavaScript. */
async function setTextFormats(client: pg.Client): Promise<void> {
  await client.query(`SET DateStyle = 'ISO, MDY'; SET TimeZone = 'UTC'; SET IntervalStyle = 'postgres'; SET bytea_output = 'hex'; SET extra_float_digits = 3`)
}

async function copyTable(source: pg.Client, target: pg.Client, table: string): Promise<number> {
  const sourceColumns = await tableColumns(source, table)
  const targetColumns = await tableColumns(target, table)
  const missing = [...sourceColumns.keys()].filter((column) => !targetColumns.has(column))
  if (missing.length > 0) throw new Error(`${table} has column(s) ${missing.join(', ')} locally that this build's schema lacks`)
  // Columns only the target has (a migration the local database had not run) keep their defaults.
  const columns = [...sourceColumns.keys()]
  const quotedTable = `public.${target.escapeIdentifier(table)}`
  const columnList = columns.map((column) => target.escapeIdentifier(column)).join(', ')
  const selectList = columns.map((column) => `${source.escapeIdentifier(column)}::text`).join(', ')

  await source.query(`DECLARE relay_move NO SCROLL CURSOR FOR SELECT ${selectList} FROM public.${source.escapeIdentifier(table)}`)
  let copied = 0
  try {
    for (;;) {
      const batch = await source.query<(string | null)[]>({ text: `FETCH ${MOVE_FETCH_ROWS} FROM relay_move`, rowMode: 'array' })
      if (batch.rows.length === 0) break
      const values: (string | null)[] = []
      const tuples = batch.rows.map((row) => {
        const placeholders = columns.map((column, index) => {
          values.push(row[index] ?? null)
          return `$${values.length}::${targetColumns.get(column)}`
        })
        return `(${placeholders.join(', ')})`
      })
      await target.query(`INSERT INTO ${quotedTable} (${columnList}) VALUES ${tuples.join(', ')}`, values)
      copied += batch.rows.length
    }
  } finally {
    await source.query('CLOSE relay_move')
  }
  return copied
}

/** Sequences behind bigserial columns, so the next id on the target follows the copied rows. */
async function copySequences(source: pg.Client, target: pg.Client): Promise<number> {
  const { rows } = await source.query<{ name: string }>(
    `SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S' ORDER BY relname`,
  )
  for (const { name } of rows) {
    const quoted = `public.${source.escapeIdentifier(name)}`
    const state = await source.query<{ last_value: string; is_called: boolean }>(`SELECT last_value::text AS last_value, is_called FROM ${quoted}`)
    const value = state.rows[0]
    if (value !== undefined) await target.query('SELECT setval($1::regclass, $2::bigint, $3)', [quoted, value.last_value, value.is_called])
  }
  return rows.length
}

/** Points database.url at the keystore item and drops operator_url, which names the old database, in one rename. */
function switchConfigDatabase(configPath: string): boolean {
  const doc = parseDocument(readFileSync(configPath, 'utf8'))
  doc.setIn(['database', 'url'], keystoreReference(DATABASE_URL_SECRET))
  const hadOperatorUrl = doc.deleteIn(['database', 'operator_url'])
  const temporary = `${configPath}.relay-moving`
  writeFileSync(temporary, String(doc), { mode: 0o600 })
  renameSync(temporary, configPath)
  return hadOperatorUrl
}

async function connectClient(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 })
  client.on('error', () => {})
  await client.connect()
  return client
}

function defaultStoreSecret(name: string, value: string): Promise<DbResult> {
  return runSecretsSet({ name, value, replace: true }, { helperPath: relaySecretsHelperPath(resolveRelayHome().path) })
}

export async function runDbMove(params: DbMoveParams, deps: DbMoveDependencies = {}): Promise<DbResult> {
  const migrationsDir = params.migrationsDir ?? resolveMigrationsDirectory()
  let targetName: string
  try {
    const protocol = new URL(params.targetUrl).protocol
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') throw new Error('not postgres')
    targetName = describeTarget(params.targetUrl)
  } catch {
    return { report: 'The target is not a postgres:// URL; nothing was changed.', exitCode: 1 }
  }
  registerSecretValue(parseDatabaseUrl(params.targetUrl).password)

  const config = loadRelayConfig(params.configPath)
  const previousUrl = await resolveDatabaseUrl(config, deps.secrets ?? createSecretProvider(config))
  const sourceUrl = config.database.operator_url ?? previousUrl
  if (sameDatabase(sourceUrl, params.targetUrl) || sameDatabase(previousUrl, params.targetUrl)) {
    return { report: `${targetName} is the database Relay already uses; nothing was changed.`, exitCode: 1 }
  }
  const daemonPid = runningDaemonPid(deps.relayHome ?? resolveRelayHome().path)
  if (daemonPid !== undefined) {
    return { report: `The Relay daemon is running (pid ${daemonPid}). Stop it first (macOS: launchctl bootout gui/$(id -u)/${SERVICE_LABEL}; Linux: systemctl --user stop ${SYSTEMD_UNIT}); nothing was changed.`, exitCode: 1 }
  }

  const lines: string[] = []
  let source: pg.Client | undefined
  let target: pg.Client | undefined
  try {
    source = await connectClient(sourceUrl)
    // A daemon without a pid file (the Linux Secret Service) still shows up as a connection.
    const others = await source.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
    )
    const otherCount = others.rows[0]?.count ?? 0
    if (otherCount > 0) {
      return {
        report:
          `${otherCount} other connection(s) are open to the local database (the daemon, a relay live wait, or psql). ` +
          'Stop them so no row is written during the copy; nothing was changed.',
        exitCode: 1,
      }
    }
    const buildMigrations = new Set(selectPendingMigrations(readdirSync(migrationsDir), new Set()))
    const sourceApplied = (await source.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name)
    const unknown = sourceApplied.filter((name) => !buildMigrations.has(name))
    if (unknown.length > 0) {
      return { report: `The local database has migrations this checkout does not know (${unknown.join(', ')}); update Relay first. Nothing was changed.`, exitCode: 1 }
    }

    target = await connectClient(params.targetUrl)
    const inUse: string[] = []
    for (const table of await publicTables(target)) {
      if (!SEEDED_BY_MIGRATIONS.has(table) && (await countRows(target, table)) > 0) inUse.push(table)
    }
    if (inUse.length > 0) {
      return { report: `${targetName} already has Relay rows (${inUse.join(', ')}), so Relay will not move into it; nothing was changed.`, exitCode: 1 }
    }

    const targetPool = createPool(params.targetUrl)
    try {
      const applied = await applyMigrations(targetPool, migrationsDir)
      lines.push(applied.length > 0 ? `applied ${applied.length} migration(s) on ${targetName}` : `${targetName} already had every migration`)
    } finally {
      await closePool(targetPool)
    }

    await setTextFormats(source)
    await setTextFormats(target)
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await target.query('BEGIN')
    try {
      const tables = (await publicTables(source)).filter((table) => table !== 'schema_migrations')
      const order = await dependencyOrder(target, tables)
      // Clears what migrations seeded (the lease row), children first.
      for (const table of [...order].reverse()) await target.query(`DELETE FROM public.${target.escapeIdentifier(table)}`)
      for (const table of order) {
        const copied = await copyTable(source, target, table)
        const local = await countRows(source, table)
        const moved = await countRows(target, table)
        if (copied !== local || moved !== local) throw new Error(`${table}: ${local} rows locally but ${moved} on ${targetName}`)
        lines.push(`${table}: ${moved} rows`)
      }
      lines.push(`set ${await copySequences(source, target)} sequence(s)`)
      await target.query('COMMIT')
    } catch (error) {
      await target.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      await source.query('ROLLBACK').catch(() => {})
    }
  } catch (error) {
    lines.push(`relay db move stopped: ${scrubSecrets((error as Error).message)}`)
    lines.push('config and the keystore were not changed, and no rows were copied.')
    return { report: lines.join('\n'), exitCode: 1 }
  } finally {
    await source?.end().catch(() => {})
    await target?.end().catch(() => {})
  }

  const store = deps.storeSecret ?? defaultStoreSecret
  // The backup first: if it fails nothing Relay reads has changed, and if the
  // second write fails only the backup item is new.
  for (const [name, value] of [
    [DATABASE_LOCAL_URL_SECRET, previousUrl],
    [DATABASE_URL_SECRET, params.targetUrl],
  ] as const) {
    const stored = await store(name, value)
    if (stored.exitCode !== 0) {
      lines.push(`The rows are on ${targetName}, but storing ${name} failed: ${stored.report}`)
      lines.push(
        `config and ${DATABASE_URL_SECRET} were not changed, so Relay still uses the local database. ` +
          'Fix the keystore, empty the target, and run the move again.',
      )
      return { report: lines.join('\n'), exitCode: 1 }
    }
  }
  const droppedOperatorUrl = switchConfigDatabase(params.configPath)
  lines.push(`stored the new URL as ${DATABASE_URL_SECRET} and the previous one as ${DATABASE_LOCAL_URL_SECRET}`)
  lines.push(
    `database.url is now ${keystoreReference(DATABASE_URL_SECRET)}` +
      (droppedOperatorUrl ? '; removed database.operator_url, which named the local database' : ''),
  )
  lines.push(`Start the daemon again with relay install-service --start; it now uses ${targetName}.`)
  return { report: lines.join('\n'), exitCode: 0 }
}
