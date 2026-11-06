/**
 * The folder a new Slack thread's chat runs in, chosen by the user: the
 * first message names a registered repository (its name or an alias, as a
 * whole word) or a folder by absolute or ~ path. Otherwise the first
 * registered repository, then the home folder.
 *
 * A channel whose description names a folder overrides all of this for its
 * new threads (src/chat/slack/folder-questions.ts).
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RepoEntry } from '../repos/schema.js'

export function chatFolder(text: string, repos: readonly RepoEntry[], home: string = homedir()): string {
  return textFolder(text, repos, home) ?? repos[0]?.path ?? home
}

/** The folder the text itself names, by path or by a registered repository's name or alias; never a fallback. */
export function textFolder(text: string, repos: readonly RepoEntry[], home: string = homedir()): string | undefined {
  const named = namedFolder(text, home)
  if (named !== undefined) return named
  // Dots stay inside a word ("relay.config") but not at its ends, so "in cohabit." still names cohabit.
  const words = new Set(text.toLowerCase().split(/[^a-z0-9._-]+/).map((word) => word.replace(/^\.+|\.+$/g, '')))
  return repos.find((entry) => [entry.name, ...(entry.aliases ?? [])].some((name) => words.has(name.toLowerCase())))?.path
}

/** The first existing folder the text names by absolute or ~ path, quoted ones first; never a repository or home fallback. */
export function namedFolder(text: string, home: string = homedir()): string | undefined {
  // A quoted path may hold spaces; an unquoted one ends at the first space.
  const quoted = [...text.matchAll(/(["'`])((?:~\/|\/)[^"'`\n]+)\1/g)].map((match) => match[2] ?? '')
  const bare = [...text.matchAll(/(?:^|[\s(`'"])((?:~\/|\/)[^\s`'"()<>]+)/g)].map((match) => match[1] ?? '')
  for (const named of [...quoted, ...bare]) {
    const path = named.startsWith('~/') ? join(home, named.slice(2)) : resolve(named)
    if (isFolder(path)) return path
  }
  return undefined
}

/** False for a missing path, a file, a dangling symlink or an unreadable parent. */
export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
