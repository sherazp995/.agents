/**
 * Saved Claude chats for Slack task threads (README, "Failover"), so the
 * laptop that picks a thread up continues the same conversation.
 *
 * After each Claude turn the chat file `<session>.jsonl` and its folder
 * `<session>/` (tool results, subagent files) are packed from the login's
 * projects folder for the turn's working folder, gzipped, and stored in
 * failover_chats with a revision that only goes up. A marker file next to
 * the chat records the revision this laptop's copy is at, so a laptop whose
 * copy is older than the stored one restores it before the turn, and a save
 * built on an older copy is refused instead of overwriting a newer chat.
 *
 * Every failure leaves the turn to start a fresh chat with the thread's
 * history, as it does without failover. Claude only: Codex chats are not
 * saved.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'

export const CHAT_KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const CHAT_TOTAL_BYTES = 300 * 1024 * 1024
/** Generous for a long chat with its tool results; a bigger one is not saved. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
const MARKER_SUFFIX = '.relay-revision'

/** Where one chat lives on this laptop: a Claude login's projects folder and the folder the turn runs in. */
export type ChatPlace = { taskId: string; sessionId: string; cwd: string; projectsDir: string }

export type SaveResult = 'saved' | 'refused' | 'missing'

/**
 * The folder name Claude Code keeps a working folder's chats under: the
 * real path with every character other than a letter or digit turned into
 * a dash (`/Users/a/.agents` is `-Users-a--agents`).
 */
export function claudeProjectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The chat's folder inside the projects folder, from the real path, as Claude itself sees the folder it runs in. */
async function chatDir(place: Pick<ChatPlace, 'cwd' | 'projectsDir'>): Promise<string> {
  const real = await realpath(place.cwd).catch(() => place.cwd)
  return join(place.projectsDir, claudeProjectFolder(real))
}

async function readMarker(dir: string, sessionId: string): Promise<number> {
  const text = await readFile(join(dir, `${sessionId}${MARKER_SUFFIX}`), 'utf8').catch(() => '')
  const revision = Number(text.trim())
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0
}

async function writeMarker(dir: string, sessionId: string, revision: number): Promise<void> {
  await writeFile(join(dir, `${sessionId}${MARKER_SUFFIX}`), `${revision}\n`, { mode: 0o600 })
}

function tar(args: readonly string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('tar', [...args], { encoding: 'buffer', maxBuffer: MAX_ARCHIVE_BYTES }, (error, stdout, stderr) => {
      if (error) reject(new Error(`tar failed: ${stderr.toString().trim() || error.message}`))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

/**
 * Saves the chat after a turn. Its revision is one past the copy this laptop
 * holds, so a laptop that missed a newer save is refused; a different chat
 * (a fresh one after a failed restore) replaces the stored one. Old and
 * oversized chats are pruned after.
 */
export async function saveChat(pool: Pool, place: ChatPlace & { workspaceId: string; host: string }): Promise<SaveResult> {
  const dir = await chatDir(place)
  const file = `${place.sessionId}.jsonl`
  if (!existsSync(join(dir, file))) return 'missing'
  const members = existsSync(join(dir, place.sessionId)) ? [file, place.sessionId] : [file]
  const archive = await tar(['-czf', '-', '-C', dir, ...members])
  const { rows } = await pool.query<{ session_id: string; revision: string }>('SELECT session_id, revision FROM failover_chats WHERE task_id = $1', [place.taskId])
  const stored = rows[0]
  const revision = stored !== undefined && stored.session_id !== place.sessionId ? Number(stored.revision) + 1 : (await readMarker(dir, place.sessionId)) + 1
  const { rowCount } = await pool.query(
    `INSERT INTO failover_chats (task_id, workspace_id, session_id, cwd, revision, archive, size_bytes, saved_by, saved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (task_id) DO UPDATE
       SET session_id = EXCLUDED.session_id, cwd = EXCLUDED.cwd, revision = EXCLUDED.revision, archive = EXCLUDED.archive,
           size_bytes = EXCLUDED.size_bytes, saved_by = EXCLUDED.saved_by, saved_at = now()
       WHERE failover_chats.revision < EXCLUDED.revision`,
    [place.taskId, place.workspaceId, place.sessionId, place.cwd, revision, archive, archive.byteLength, place.host],
  )
  if (rowCount !== 1) return 'refused'
  await writeMarker(dir, place.sessionId, revision)
  await pruneChats(pool)
  return 'saved'
}

/**
 * Before a turn: puts the stored chat into this laptop's projects folder for
 * the turn's folder when this laptop's copy is older or missing. True when a
 * copy at the stored revision is in place afterwards, so the turn may resume
 * it whichever login made it; false when nothing is stored for this session.
 */
export async function restoreChat(pool: Pool, place: ChatPlace): Promise<boolean> {
  const { rows } = await pool.query<{ session_id: string; revision: string; archive: Buffer }>(
    'SELECT session_id, revision, archive FROM failover_chats WHERE task_id = $1',
    [place.taskId],
  )
  const stored = rows[0]
  if (stored === undefined || stored.session_id !== place.sessionId) return false
  const revision = Number(stored.revision)
  const dir = await chatDir(place)
  const file = `${place.sessionId}.jsonl`
  if (existsSync(join(dir, file)) && (await readMarker(dir, place.sessionId)) >= revision) return true

  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Unpacked beside the chat first, so a bad archive never replaces a good copy and only the two expected names move in.
  const staging = await mkdtemp(join(dir, '.relay-restore-'))
  try {
    await tar(['-xzf', '-', '-C', staging], stored.archive)
    const entries = await readdir(staging)
    if (!entries.includes(file) || entries.some((entry) => entry !== file && entry !== place.sessionId)) throw new Error('the saved chat holds unexpected files')
    if (!(await lstat(join(staging, file))).isFile()) throw new Error('the saved chat file is not a file')
    if (entries.includes(place.sessionId) && !(await lstat(join(staging, place.sessionId))).isDirectory()) throw new Error('the saved chat folder is not a folder')
    await rm(join(dir, place.sessionId), { recursive: true, force: true })
    if (entries.includes(place.sessionId)) await rename(join(staging, place.sessionId), join(dir, place.sessionId))
    await rename(join(staging, file), join(dir, file))
    await writeMarker(dir, place.sessionId, revision)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return true
}

/** Drops chats saved more than `keepMs` ago, then the oldest until the rest fit in `totalBytes`. */
export async function pruneChats(pool: Pool, limits: { keepMs?: number; totalBytes?: number } = {}): Promise<void> {
  await pool.query(`DELETE FROM failover_chats WHERE saved_at < now() - ($1 * interval '1 millisecond')`, [limits.keepMs ?? CHAT_KEEP_MS])
  await pool.query(
    `DELETE FROM failover_chats WHERE task_id IN (
       SELECT task_id FROM (SELECT task_id, sum(size_bytes) OVER (ORDER BY saved_at DESC, task_id) AS kept FROM failover_chats) AS newest_first
       WHERE kept > $1)`,
    [limits.totalBytes ?? CHAT_TOTAL_BYTES],
  )
}

/**
 * What the turn runner uses. restore says 'current' when a copy at the
 * stored revision is in place, 'none' when nothing is stored for this
 * session, and 'failed' when one is stored but could not be put in place:
 * then this laptop's own copy may be older, so the turn must start fresh
 * rather than resume it. A failure is logged.
 */
export type RestoreResult = 'current' | 'none' | 'failed'
export type ChatSync = {
  restore(place: ChatPlace): Promise<RestoreResult>
  save(place: ChatPlace & { workspaceId: string }): Promise<void>
}

export function createChatSync(pool: Pool, host: string, log: Logger): ChatSync {
  return {
    async restore(place) {
      try {
        return (await restoreChat(pool, place)) ? 'current' : 'none'
      } catch (error) {
        log.warn({ err: error, taskId: place.taskId }, 'could not restore the saved chat; the turn starts fresh')
        return 'failed'
      }
    },
    async save(place) {
      try {
        const result = await saveChat(pool, { ...place, host })
        if (result !== 'saved') log.warn({ taskId: place.taskId, result }, 'the chat was not saved for the other laptop')
      } catch (error) {
        log.warn({ err: error, taskId: place.taskId }, 'could not save the chat for the other laptop')
      }
    },
  }
}
