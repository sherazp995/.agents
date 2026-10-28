/**
 * `relay secrets set <name>` and `relay secrets migrate` (user decision 7).
 *
 * Relay's own secrets leave plain files and leave `/usr/bin/security`'s
 * reach: every item relay owns is created by the `relay-secrets` helper with
 * an access list holding only that helper, and config/relay.config.yaml's
 * database URL becomes a keystore reference to a `relay_app` role whose
 * password exists only in the keystore.
 *
 * Values never pass through argv (the process table is world readable),
 * stdout, or an error message: they go to the helper on stdin, and every
 * report line names items, never values.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import { parseDocument } from 'yaml'
import { AUDIT_SIGNING_KEY_SECRET } from '../audit/signing.js'
import { SLACK_APP_TOKEN_SECRET, SLACK_BOT_TOKEN_SECRET } from '../chat/slack/adapter.js'
import { isKeystoreItemName, keystoreReference, keystoreReferenceName } from '../config/database-url.js'
import { loadRelayConfig } from '../config/load.js'
import {
  APPROVAL_RECEIPT_KEY_SECRET,
  DATABASE_ADMIN_URL_SECRET,
  DATABASE_URL_SECRET,
  type ExecFileFn,
  KeychainSecretProvider,
  type KeychainItemStatus,
  keychainItemStatus,
} from '../secrets/keychain.js'

export const APP_ROLE = 'relay_app'

/** Items relay created before the helper existed; migrate recreates any still readable by other programs. */
export const RELAY_KEYCHAIN_ITEMS: readonly string[] = [
  SLACK_BOT_TOKEN_SECRET,
  SLACK_APP_TOKEN_SECRET,
  AUDIT_SIGNING_KEY_SECRET,
  APPROVAL_RECEIPT_KEY_SECRET,
  DATABASE_URL_SECRET,
  DATABASE_ADMIN_URL_SECRET,
]

/** The helper's exit for `set` on an item that already exists (native/relay-secrets). */
const HELPER_EXIT_EXISTS = 73

export type HelperResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

export type SecretsCliDependencies = {
  readonly helperPath: string
  /** Runs the helper with `input` on stdin; resolves with any exit code rather than rejecting. */
  readonly runHelper?: (helperPath: string, args: readonly string[], input?: string) => Promise<HelperResult>
  /** `/usr/bin/security`, for reading and deleting items the helper does not own yet; the operator answers its dialogs. */
  readonly security?: ExecFileFn
  readonly pathExists?: (path: string) => boolean
  readonly randomSecret?: (bytes: number) => string
}

export type SecretsResult = { readonly report: string; readonly exitCode: number }

export function runHelperProcess(helperPath: string, args: readonly string[], input?: string): Promise<HelperResult> {
  return new Promise((resolve) => {
    const child = execFile(helperPath, args as string[], (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ exitCode: code, stdout, stderr })
    })
    // A helper that exits before reading stdin (a refusal, a usage error)
    // makes this write fail with EPIPE; its exit code already reports that,
    // and an unhandled stream error would crash the CLI instead.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}

function securityExec(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args as string[], (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })))
  })
}

function holdingName(name: string): string {
  return `${name}.relay-migrating`
}

class SecretStore {
  readonly #deps: SecretsCliDependencies
  readonly #run: NonNullable<SecretsCliDependencies['runHelper']>
  readonly #security: ExecFileFn

  constructor(deps: SecretsCliDependencies) {
    this.#deps = deps
    this.#run = deps.runHelper ?? runHelperProcess
    this.#security = deps.security ?? securityExec
  }

  status(name: string): Promise<KeychainItemStatus> {
    return keychainItemStatus(name, this.#deps.helperPath, async (file, args) => {
      const result = await this.#run(file, args)
      if (result.exitCode !== 0) throw new Error(`relay-secrets status ${name} exited ${result.exitCode}`)
      return result
    })
  }

  /** Creates the item with the helper-only access list. Never replaces one. */
  async create(name: string, value: string): Promise<void> {
    const result = await this.#run(this.#deps.helperPath, ['set', name], value)
    if (result.exitCode === HELPER_EXIT_EXISTS) throw new Error(`${name} already exists in the keychain`)
    if (result.exitCode !== 0) throw new Error(`relay-secrets could not store ${name} (exit ${result.exitCode})`)
  }

  /** Through `security`, so macOS asks the operator when the item's access list does not name it. */
  async delete(name: string): Promise<void> {
    await this.#security('/usr/bin/security', ['delete-generic-password', '-s', name])
  }

  /** Through `security`, which raises a keychain dialog for the operator on a helper-owned item. */
  read(name: string): Promise<string> {
    return new KeychainSecretProvider(this.#security).get(name)
  }

  /**
   * Finishes a replace an earlier run left part way. With `name` gone and
   * its holding copy present, the value lives only in the copy, so it is
   * restored first; with both present, `name` was already recreated and the
   * copy is stale. Returns whether anything was done.
   */
  async recover(name: string): Promise<boolean> {
    const holding = holdingName(name)
    if ((await this.status(holding)) === 'missing') return false
    if ((await this.status(name)) === 'missing') await this.create(name, await this.read(holding))
    await this.delete(holding)
    return true
  }

  /**
   * Replaces an item without a moment where its value exists nowhere: a
   * copy goes to `<name>.relay-migrating` first and is removed last, so a
   * failure part way leaves that copy, which `recover` restores next run.
   */
  async replace(name: string, value: string): Promise<void> {
    await this.recover(name)
    if ((await this.status(name)) === 'missing') {
      await this.create(name, value)
      return
    }
    const holding = holdingName(name)
    await this.create(holding, value)
    try {
      await this.delete(name)
      await this.create(name, value)
    } catch (error) {
      throw new Error(`${name} could not be replaced (${(error as Error).message}); its value is kept in ${holding}, which the next run restores`)
    }
    await this.delete(holding)
  }
}

function helperMissing(deps: SecretsCliDependencies): SecretsResult | undefined {
  if ((deps.pathExists ?? existsSync)(deps.helperPath)) return undefined
  return { report: `${deps.helperPath} does not exist. Run \`relay install-service\`, which builds it.`, exitCode: 1 }
}

/** `relay secrets set <name>`: the value comes from stdin and goes to the helper on stdin. */
export async function runSecretsSet(
  options: { readonly name: string; readonly value: string; readonly replace: boolean },
  deps: SecretsCliDependencies,
): Promise<SecretsResult> {
  if (!isKeystoreItemName(options.name)) {
    return { report: `"${options.name}" is not a keystore item name: use letters, digits, dot, underscore and dash.`, exitCode: 1 }
  }
  const missing = helperMissing(deps)
  if (missing) return missing
  if (options.value === '') return { report: 'No value arrived on stdin; nothing was stored.', exitCode: 1 }
  const store = new SecretStore(deps)
  try {
    const status = await store.status(options.name)
    if (status !== 'missing' && !options.replace) {
      return { report: `${options.name} already exists. Pass --replace to overwrite it.`, exitCode: 1 }
    }
    await store.replace(options.name, options.value)
  } catch (error) {
    return { report: `relay secrets set failed: ${(error as Error).message}`, exitCode: 1 }
  }
  return { report: `Stored ${options.name}; only relay-secrets can read it.`, exitCode: 0 }
}

function assertRoleName(role: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`"${role}" is not a plain Postgres role name`)
}

/**
 * Creates (or re-passwords) `role` and makes it the owner of relay's
 * objects in the connected database's public schema, so the daemon, which
 * applies migrations at startup, runs entirely as it. It gets no
 * superuser, database or role creation rights, and nothing outside this
 * database. Returns the URL that connects as it.
 */
export async function provisionAppRole(adminUrl: string, role: string, password: string): Promise<string> {
  assertRoleName(role)
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    const quoted = client.escapeIdentifier(role)
    const literal = client.escapeLiteral(password)
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
    await client.query(
      exists.rowCount === 0
        ? `CREATE ROLE ${quoted} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal}`
        : `ALTER ROLE ${quoted} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal}`,
    )
    // A non-superuser owner (CREATEROLE) must be able to SET ROLE to hand its
    // objects over (Postgres 16+ does not grant that to a role's creator by
    // default). SET only: the owner does not inherit the app role's rights.
    const superuser = (await client.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0]?.rolsuper === true
    if (!superuser) await client.query(`GRANT ${quoted} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`)
    const database = (await client.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name ?? ''
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(database)} TO ${quoted}`)
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${quoted}`)

    // Tables first: a sequence owned by a column moves with its table, and
    // ALTER SEQUENCE on one would fail.
    const relations = await client.query<{ name: string; kind: string }>(
      `SELECT c.relname AS name, c.relkind AS kind FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
           AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [role],
    )
    for (const relation of relations.rows) {
      const statement = relation.kind === 'v' ? 'VIEW' : relation.kind === 'm' ? 'MATERIALIZED VIEW' : 'TABLE'
      await client.query(`ALTER ${statement} public.${client.escapeIdentifier(relation.name)} OWNER TO ${quoted}`)
    }
    const sequences = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
           AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = $1)
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))`,
      [role],
    )
    for (const sequence of sequences.rows) {
      await client.query(`ALTER SEQUENCE public.${client.escapeIdentifier(sequence.name)} OWNER TO ${quoted}`)
    }
    const types = await client.query<{ name: string }>(
      `SELECT t.typname AS name FROM pg_type t
         WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd') AND t.typrelid = 0
           AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [role],
    )
    for (const type of types.rows) {
      await client.query(`ALTER TYPE public.${client.escapeIdentifier(type.name)} OWNER TO ${quoted}`)
    }
    const functions = await client.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [role],
    )
    for (const fn of functions.rows) {
      await client.query(`ALTER ROUTINE ${fn.signature} OWNER TO ${quoted}`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await client.end()
  }

  const appUrl = new URL(adminUrl)
  appUrl.username = role
  appUrl.password = password
  return appUrl.toString()
}

/** Rewrites database.url in place, keeping every comment and other key, through a temp file and a rename. */
export function rewriteDatabaseUrl(configPath: string, reference: string): void {
  const doc = parseDocument(readFileSync(configPath, 'utf8'))
  doc.setIn(['database', 'url'], reference)
  const temporary = `${configPath}.relay-migrating`
  writeFileSync(temporary, String(doc), { mode: 0o600 })
  renameSync(temporary, configPath)
}

export type MigrateOptions = {
  readonly configPath: string
  readonly role?: string
  /** Ownership and the role's password, against the admin URL. Injected so a test can watch it. */
  readonly provision?: typeof provisionAppRole
}

/**
 * `relay secrets migrate`. Each step checks before it acts, so running it
 * again only finishes what an earlier run left; it never prints a value.
 */
export async function runSecretsMigrate(options: MigrateOptions, deps: SecretsCliDependencies): Promise<SecretsResult> {
  const missing = helperMissing(deps)
  if (missing) return missing
  const store = new SecretStore(deps)
  const random = deps.randomSecret ?? ((bytes: number) => randomBytes(bytes).toString('hex'))
  const lines: string[] = []

  try {
    for (const name of RELAY_KEYCHAIN_ITEMS) {
      if (await store.recover(name)) lines.push(`finished an interrupted replace of ${name}`)
    }

    if ((await store.status(APPROVAL_RECEIPT_KEY_SECRET)) === 'missing') {
      await store.create(APPROVAL_RECEIPT_KEY_SECRET, random(32))
      lines.push(`created ${APPROVAL_RECEIPT_KEY_SECRET}`)
    } else {
      lines.push(`${APPROVAL_RECEIPT_KEY_SECRET} already exists`)
    }

    const config = loadRelayConfig(options.configPath)
    const reference = keystoreReferenceName(config.database.url)
    if (reference !== undefined) {
      if ((await store.status(reference)) === 'missing') {
        throw new Error(`database.url names keystore item "${reference}", which is missing; store it with \`relay secrets set ${reference}\``)
      }
      lines.push(`database.url already names keystore item ${reference}`)
    } else {
      const role = options.role ?? APP_ROLE
      const adminUrl = config.database.url
      const appUrl = await (options.provision ?? provisionAppRole)(adminUrl, role, random(24))
      await store.replace(DATABASE_ADMIN_URL_SECRET, adminUrl)
      await store.replace(DATABASE_URL_SECRET, appUrl)
      rewriteDatabaseUrl(options.configPath, keystoreReference(DATABASE_URL_SECRET))
      lines.push(
        `created role ${role} owning relay's tables, stored its URL as ${DATABASE_URL_SECRET} and the previous URL as ` +
          `${DATABASE_ADMIN_URL_SECRET}, and set database.url to ${keystoreReference(DATABASE_URL_SECRET)}`,
      )
    }

    for (const name of RELAY_KEYCHAIN_ITEMS) {
      const status = await store.status(name)
      if (status !== 'shared') continue
      await store.replace(name, await store.read(name))
      lines.push(`recreated ${name} so only relay-secrets can read it`)
    }
  } catch (error) {
    lines.push(`relay secrets migrate stopped: ${(error as Error).message}`)
    lines.push('Run it again once that is fixed; finished steps are skipped.')
    return { report: lines.join('\n'), exitCode: 1 }
  }

  lines.push('Restart the daemon so it connects as the new role.')
  return { report: lines.join('\n'), exitCode: 0 }
}
