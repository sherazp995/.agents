/**
 * Where Relay's configuration and migrations live, so the CLI works from any
 * directory rather than only from a checkout.
 *
 * THE PROBLEM THIS SOLVES. Every default path was relative: `relay doctor`
 * run anywhere but the repository root reported "config/relay.config.yaml:
 * file could not be read" and suggested fixing a path that, from where the
 * operator was standing, did not exist. That is fine for a project you
 * develop in and fatal for one you install.
 *
 * THE LOOKUP ORDER, most explicit first:
 *
 *   1. `RELAY_HOME`, if set. An explicit answer always wins, and it is what
 *      makes more than one installation on a machine possible.
 *   2. The current directory, IF it actually looks like a Relay
 *      installation. Checked by the presence of `config/relay.config.yaml`
 *      rather than by any directory name, because the question is "is the
 *      configuration here" and nothing else is evidence of that. This keeps
 *      a checkout working exactly as before.
 *   3. `~/.relay`, the installed default.
 *
 * The order matters in one specific way: the current directory is checked
 * BEFORE the home directory, so a developer working inside a checkout never
 * silently picks up the configuration of an unrelated installed copy, which
 * would be a very confusing way to lose an afternoon.
 *
 * MIGRATIONS ARE NOT CONFIGURATION and are resolved differently: they ship
 * WITH the code, so they are found relative to this module rather than
 * relative to any directory the operator might be in. A migration set that
 * moved with the working directory would mean the schema applied depended on
 * where the command was typed.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The file whose presence marks a directory as a Relay installation. */
export const CONFIG_MARKER = join('config', 'relay.config.yaml')

export type RelayHomeDependencies = {
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly home?: string
  readonly pathExists?: (path: string) => boolean
}

export type RelayHome = {
  readonly path: string
  /** Which rule chose it, so `relay doctor` can say WHERE it looked rather than only that it failed. */
  readonly source: 'RELAY_HOME' | 'current directory' | 'home directory'
}

export function resolveRelayHome(deps: RelayHomeDependencies = {}): RelayHome {
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? process.cwd()
  const home = deps.home ?? homedir()
  const exists = deps.pathExists ?? existsSync

  const explicit = env.RELAY_HOME
  if (explicit !== undefined && explicit.trim() !== '') {
    return { path: isAbsolute(explicit) ? explicit : resolve(cwd, explicit), source: 'RELAY_HOME' }
  }

  // Checked before the home directory, so a checkout is never shadowed by an
  // installed copy.
  if (exists(join(cwd, CONFIG_MARKER))) return { path: cwd, source: 'current directory' }

  return { path: join(home, '.relay'), source: 'home directory' }
}

/** A path inside the resolved Relay home. */
export function relayPath(...segments: readonly string[]): string {
  return join(resolveRelayHome().path, ...segments)
}

export const DEFAULT_CONFIG_FILENAME = join('config', 'relay.config.yaml')
export const DEFAULT_POLICY_FILENAME = join('config', 'policy.yaml')
export const DEFAULT_PROFILES_FILENAME = join('config', 'profiles.yaml')
export const DEFAULT_REPOS_FILENAME = join('config', 'repos.yaml')

/**
 * The three config paths, resolved against the Relay home.
 *
 * Functions rather than constants so the answer follows the environment at
 * call time. A constant evaluated at import would freeze whatever the
 * working directory happened to be when the module graph loaded, which under
 * a test runner is not the directory any individual test is talking about.
 */
export const defaultConfigPath = (): string => relayPath(DEFAULT_CONFIG_FILENAME)
export const defaultPolicyPath = (): string => relayPath(DEFAULT_POLICY_FILENAME)
export const defaultProfilesPath = (): string => relayPath(DEFAULT_PROFILES_FILENAME)
export const defaultReposPath = (): string => relayPath(DEFAULT_REPOS_FILENAME)

/**
 * Migrations, resolved relative to THIS module rather than to the working
 * directory, because they ship with the code.
 *
 * Walks up from the compiled location (`dist/src/config/paths.js`) to the
 * package root, then down to the migrations. Falls back to the source tree
 * layout so that running under Vitest, which loads TypeScript directly from
 * `src/`, finds them too.
 */
export function resolveMigrationsDirectory(pathExists: (path: string) => boolean = existsSync): string {
  const here = dirname(fileURLToPath(import.meta.url))

  const candidates = [
    // Compiled or running from source, both resolve as <here>/../db/migrations:
    // dist/src/config -> dist/src/db/migrations, and src/config ->
    // src/db/migrations. The .sql files are copied into dist by the build,
    // since tsc emits only JavaScript.
    join(here, '..', 'db', 'migrations'),
    // Compiled, but the build's copy step did not run. Falls back to the
    // source tree beside dist, which keeps a partially built checkout usable.
    join(here, '..', '..', '..', 'src', 'db', 'migrations'),
  ]

  for (const candidate of candidates) {
    if (pathExists(candidate)) return resolve(candidate)
  }

  // Reported rather than silently returning a path that does not exist: a
  // missing migrations directory produces an empty migration run, which
  // looks like "already up to date" and is the worst possible way to fail.
  throw new Error(
    `Relay's migrations directory could not be found near ${here}. Looked in: ${candidates.join(', ')}. ` +
      'This means the installation is incomplete rather than misconfigured.',
  )
}
