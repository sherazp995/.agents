/**
 * The rules every stored env shares, used by `relay env` and by the resolver
 * that builds a session's env (README, "Envs for Relay's sessions"): which
 * names may be stored, and the one form a folder is kept in.
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

/** One stored env's place: '' host means every laptop, '' folder every folder. */
export type EnvScope = { readonly host: string; readonly folder: string; readonly name: string }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Names Relay or the login pool set for every session. A stored HOME would
 * hide the session's chats from resume and failover chat sync; a stored login
 * token would bypass the login pool.
 */
const RESERVED = new Set([
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'HOME',
  'RELAY_HOOK_URL',
  'RELAY_HOOK_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
])

/** Relay's own secrets reach it through these; they are never passed to a session (src/live/direct-session.ts). */
const RESERVED_PREFIX = 'RELAY_SECRET_'

/** Why `name` cannot be stored, or undefined when it can. */
export function refusedName(name: string): string | undefined {
  if (!NAME.test(name)) return `"${name}" is not an env name: use letters, digits and underscore, not starting with a digit.`
  if (RESERVED.has(name) || name.startsWith(RESERVED_PREFIX)) return `${name} is set by Relay or the login pool for every session, so it cannot be stored.`
  return undefined
}

/**
 * The stored form of a folder typed on this laptop: absolute, no trailing
 * separator, `.` and `..` resolved, and `~`-based when it sits under this
 * laptop's home, so the same entry matches on a laptop with another username.
 */
export function storedFolder(input: string, home: string = homedir(), cwd: string = process.cwd()): string {
  const expanded = input === '~' ? home : input.startsWith('~/') ? home + input.slice(1) : input
  const absolute = resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded))
  const root = trimSep(home)
  if (absolute === root) return '~'
  if (absolute.startsWith(root + sep)) return `~${absolute.slice(root.length)}`
  return absolute
}

/** A stored folder as a path on this laptop. */
export function localFolder(stored: string, home: string): string {
  if (stored === '~') return trimSep(home)
  return stored.startsWith('~/') ? trimSep(home) + stored.slice(1) : stored
}

function trimSep(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path
}
