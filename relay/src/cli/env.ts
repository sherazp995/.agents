/**
 * `relay env add | list | remove`: envs for the sessions Relay starts, kept
 * in the shared database per laptop and per folder (README, "Envs for
 * Relay's sessions"). A value is never taken from an argument, never read
 * back by `list`, and never printed in a message: messages name the scope.
 */

import { homedir } from 'node:os'
import type { Pool } from 'pg'
import { MINIMUM_SECRET_LENGTH } from '../secrets/scrubber.js'
import { refusedName, storedFolder, type EnvScope } from '../worker-env/scope.js'
import { describeScope, isMissingTable, listEntries, putEntry, removeEntry, WorkerEnvError } from '../worker-env/store.js'
import { resolveCliWorkspace } from './workspace.js'

/** What a `relay env` command prints (`out` to stdout, `err` to stderr) and exits with. */
export type EnvCommandResult = { readonly exitCode: number; readonly out: readonly string[]; readonly err: readonly string[] }

/** The scope flags every subcommand takes. */
export type EnvScopeOptions = { readonly host?: string; readonly folder?: string; readonly workspaceId?: string }

export type EnvDeps = { readonly pool: Pool; readonly home?: string; readonly cwd?: string }

export type EnvAddDeps = EnvDeps & {
  /** Reads the value: a hidden prompt on a terminal, stdin otherwise. Called only once every other check passed. */
  readonly readValue: () => Promise<string>
  /** True when this laptop's config has a `failover` block; machine entries are ignored without one. */
  readonly failoverOn: boolean
}

export const VALUE_MASK = '********'

export const MISSING_TABLES =
  'The database has not been updated for relay env yet. Update and restart the laptop that answers Slack first.'

export async function runEnvAdd(name: string, options: EnvScopeOptions, deps: EnvAddDeps): Promise<EnvCommandResult> {
  const refused = refusedArgument('add', name) ?? refusedName(name)
  if (refused !== undefined) return failure(refused)
  const scope = scopeOf(name, options, deps)
  return withWorkspace(deps.pool, options, scope, 'store', async (workspaceId) => {
    const err: string[] = []
    if (scope.host !== '') {
      const hosts = await failoverHosts(deps.pool)
      if (!hosts.includes(scope.host)) {
        const known = hosts.length === 0 ? 'No laptop has registered a failover host name yet.' : `Known laptops: ${hosts.join(', ')}.`
        return failure(`No laptop is called "${scope.host}". ${known}`)
      }
      if (!deps.failoverOn) err.push(`Warning: failover is off in this config, so machine entries like ${describeScope(scope)} are ignored on this laptop until it is on.`)
    }
    const value = await deps.readValue()
    if (value === '') return failure(`No value given for ${describeScope(scope)}; nothing was stored.`)
    if (value.length < MINIMUM_SECRET_LENGTH) err.push(`Warning: the value is shorter than ${MINIMUM_SECRET_LENGTH} characters, so Relay cannot scrub it from session output.`)
    await putEntry(deps.pool, workspaceId, scope, value)
    return { exitCode: 0, out: [`Stored ${describeScope(scope)}. New sessions get it; running ones wait for a fresh session.`], err }
  })
}

export async function runEnvList(options: EnvScopeOptions, deps: EnvDeps): Promise<EnvCommandResult> {
  const filter = scopeOf('', options, deps)
  return withWorkspace(deps.pool, options, undefined, 'list', async (workspaceId) => {
    const entries = (await listEntries(deps.pool, workspaceId, options.host === undefined ? {} : { host: filter.host })).filter(
      (entry) => options.folder === undefined || entry.folder === '' || entry.folder === filter.folder,
    )
    if (entries.length === 0) return { exitCode: 0, out: ['No envs are stored.'], err: [] }
    const rows = [
      ['NAME', 'HOST', 'FOLDER', 'UPDATED', 'VALUE'],
      ...entries.map((entry) => [
        entry.name,
        entry.host === '' ? 'every laptop' : entry.host,
        entry.folder === '' ? 'every folder' : entry.folder,
        entry.updatedAt.toISOString().replace(/\.\d+Z$/, 'Z'),
        VALUE_MASK,
      ]),
    ]
    return { exitCode: 0, out: table(rows), err: [] }
  })
}

export async function runEnvRemove(name: string, options: EnvScopeOptions, deps: EnvDeps): Promise<EnvCommandResult> {
  const refused = refusedArgument('remove', name)
  if (refused !== undefined) return failure(refused)
  const scope = scopeOf(name, options, deps)
  return withWorkspace(deps.pool, options, scope, 'remove', async (workspaceId) => {
    if (!(await removeEntry(deps.pool, workspaceId, scope))) return failure(`No env ${describeScope(scope)} is stored; nothing was removed.`)
    return { exitCode: 0, out: [`Removed ${describeScope(scope)}. New sessions fall back to the next layer down, if any.`], err: [] }
  })
}

/** `NAME=value` typed as one argument: refused without echoing any of it after the `=`. */
function refusedArgument(verb: 'add' | 'remove', name: string): string | undefined {
  const equals = name.indexOf('=')
  if (equals === -1) return undefined
  return verb === 'add' ? `Give only the name, as in \`relay env add ${name.slice(0, equals)}\`. The value is asked for separately (hidden prompt or stdin) so it stays out of shell history; nothing was stored.` : `Give only the name, as in \`relay env remove ${name.slice(0, equals)}\`; nothing was removed.`
}

function scopeOf(name: string, options: EnvScopeOptions, deps: EnvDeps): EnvScope {
  return {
    name,
    host: options.host ?? '',
    folder: options.folder === undefined ? '' : storedFolder(options.folder, deps.home ?? homedir(), deps.cwd ?? process.cwd()),
  }
}

async function failoverHosts(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM failover_hosts ORDER BY name')
  return rows.map((row) => row.name)
}

/**
 * Resolves the workspace, runs `body`, and turns every database failure into
 * a message that names the scope at most. A raw driver error is never
 * printed: its detail can quote a query parameter, and the value is one.
 */
async function withWorkspace(
  pool: Pool,
  options: EnvScopeOptions,
  scope: EnvScope | undefined,
  verb: string,
  body: (workspaceId: string) => Promise<EnvCommandResult>,
): Promise<EnvCommandResult> {
  try {
    const choice = await resolveCliWorkspace(pool, options.workspaceId)
    if (choice.kind === 'refused') return failure(choice.message)
    return await body(choice.workspaceId)
  } catch (error) {
    if (error instanceof WorkerEnvError) return failure(error.message)
    if (isMissingTable(error)) return failure(MISSING_TABLES)
    const code = (error as { code?: unknown } | null)?.code
    const target = scope === undefined ? 'the envs' : describeScope(scope)
    return failure(`Could not ${verb} ${target}: ${typeof code === 'string' ? `the database refused it (code ${code})` : 'the database call failed'}.`)
  }
}

function failure(message: string): EnvCommandResult {
  return { exitCode: 1, out: [], err: [message] }
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd())
}
