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
import pg from 'pg'
import { resolveDatabaseUrl } from '../config/database-url.js'
import { loadRelayConfig } from '../config/load.js'
import { createSecretProvider } from '../secrets/index.js'

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
