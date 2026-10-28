/**
 * The folder a new Slack thread's chat runs in, chosen by the user: the
 * first message names a registered repository (its name or an alias, as a
 * whole word) or a folder by absolute or ~ path. Otherwise the first
 * registered repository, then the home folder.
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RepoEntry } from '../repos/schema.js'

export function chatFolder(text: string, repos: readonly RepoEntry[], home: string = homedir()): string {
  // A quoted path may hold spaces; an unquoted one ends at the first space.
  const quoted = [...text.matchAll(/(["'`])((?:~\/|\/)[^"'`\n]+)\1/g)].map((match) => match[2] ?? '')
  const bare = [...text.matchAll(/(?:^|[\s(`'"])((?:~\/|\/)[^\s`'"()<>]+)/g)].map((match) => match[1] ?? '')
  for (const named of [...quoted, ...bare]) {
    const path = named.startsWith('~/') ? join(home, named.slice(2)) : resolve(named)
    if (isFolder(path)) return path
  }
  const words = new Set(text.toLowerCase().split(/[^a-z0-9._-]+/))
  const repo = repos.find((entry) => [entry.name, ...(entry.aliases ?? [])].some((name) => words.has(name.toLowerCase())))
  return repo?.path ?? repos[0]?.path ?? home
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
