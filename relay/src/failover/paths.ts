/**
 * Stored folders are absolute paths written by whichever laptop made them.
 * The other laptop may have another username, so a path under a known
 * laptop's home is read as the same place under this laptop's home. Paths
 * outside every known home are left as they are.
 */

import { sep } from 'node:path'
import type { Pool } from 'pg'

/** `path` under this laptop's home when it sits under one of `homes`; otherwise unchanged. */
export function mapPath(path: string, homes: readonly string[], localHome: string): string {
  if (isUnder(path, localHome)) return path
  // Longest home first, so /Users/a/b wins over /Users/a for a nested home.
  for (const home of [...homes].sort((a, b) => b.length - a.length)) {
    if (home !== localHome && isUnder(path, home)) return localHome + path.slice(trimSep(home).length)
  }
  return path
}

function isUnder(path: string, home: string): boolean {
  const root = trimSep(home)
  return path === root || path.startsWith(root + sep)
}

function trimSep(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path
}

/** Every laptop home failover_hosts knows; empty before failover ran (or on a database without the table rows). */
export async function knownHomes(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ home: string }>('SELECT home FROM failover_hosts')
  return rows.map((row) => row.home)
}
