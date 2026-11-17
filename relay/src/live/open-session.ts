/**
 * Which open Claude Code chat a thread belongs to, by session id.
 *
 * WHY THIS EXISTS. The courier used to find its target by folder when the
 * thread had no exact peer recorded, and a folder is not an address: three
 * open chats in cohabit-web made the courier refuse to guess, and the message
 * went to a cold `claude -p --resume` while the chat the operator was sitting
 * in never saw it. Relay already records the thread's engine session id, and
 * every running Claude Code chat publishes `~/.claude/sessions/<pid>.json`
 * with that id and its peer name, so the exact chat is known without any
 * guessing.
 *
 * Only the `.json` registry files are read. The `.key` files next to them are
 * secrets and are never opened.
 *
 * With failover, a thread's terminal chat may be open on the other laptop
 * (sessions.engine_host), where this laptop cannot reach it; such a thread is
 * refused with that laptop's name (openElsewhere).
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'

export type OpenSessionDependencies = {
  readonly root?: string
  readonly isAlive?: (pid: number) => boolean
}

export function defaultRegistryRoot(): string {
  return join(homedir(), '.claude', 'sessions')
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The peer name of the interactive chat running `sessionId`, or null when no
 * live one is. A registry file whose process has exited is stale and ignored,
 * so a closed chat never receives a push.
 */
export async function findOpenSessionName(sessionId: string, deps: OpenSessionDependencies = {}): Promise<string | null> {
  const root = deps.root ?? defaultRegistryRoot()
  const isAlive = deps.isAlive ?? pidIsAlive
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(await readFile(join(root, entry), 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    if (record.sessionId !== sessionId || record.kind !== 'interactive') continue
    if (typeof record.pid !== 'number' || typeof record.name !== 'string' || record.name.length === 0) continue
    if (!isAlive(record.pid)) continue
    return record.name
  }
  return null
}

/** The reply for a thread whose terminal chat is open on another laptop. */
export function otherLaptopText(laptop: string): string {
  return `This thread's terminal chat is open on ${laptop}, not on this laptop, so I cannot reach it from here. Continue it on ${laptop}, or close it there and mention me to carry on.`
}

/**
 * The refusal for a live session whose chat runs on another laptop, or null
 * when it is this laptop's (or failover is off, `host` null, or the session
 * predates failover).
 */
export async function openElsewhere(db: Pool | PoolClient, sessionId: string, host: string | null): Promise<string | null> {
  if (host === null) return null
  const { rows } = await db.query<{ engine_host: string | null }>('SELECT engine_host FROM sessions WHERE id = $1', [sessionId])
  const laptop = rows[0]?.engine_host ?? null
  return laptop === null || laptop === host ? null : otherLaptopText(laptop)
}
