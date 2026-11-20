/**
 * Reading Codex's saved chats ("rollouts"): one JSONL file per chat under the
 * shared sessions folder (YYYY/MM/DD/rollout-<time>-<chat id>.jsonl), whose
 * first line (session_meta) names the chat.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RolloutLine = { type?: string; payload?: { id?: string; source?: unknown } }

/**
 * Chat files under the sessions folder (its YYYY/MM/DD day folders) written at or after `sinceMs`. Every day is
 * looked at: a resumed chat keeps writing to the file of the day it began (about a thousand files take ~10ms).
 */
async function recentRollouts(root: string, sinceMs: number, nameEnds = '.jsonl'): Promise<string[]> {
  const found: string[] = []
  const days: string[] = []
  for (const year of await readdir(root).catch(() => [])) {
    for (const month of await readdir(join(root, year)).catch(() => [])) {
      for (const day of await readdir(join(root, year, month)).catch(() => [])) days.push(join(root, year, month, day))
    }
  }
  for (const dir of days) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.startsWith('rollout-') || !name.endsWith(nameEnds)) continue
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (info !== null && info.mtimeMs >= sinceMs) found.push(path)
    }
  }
  return found
}

/**
 * The chat id in a rollout's first line (its session_meta), or null. A
 * subagent's chat (source {"subagent": ...}, such as the approvals
 * "guardian") is never the terminal chat, even when it repeats its parent's
 * instructions, so it is skipped.
 */
function rolloutChatId(rollout: string): string | null {
  try {
    const first = JSON.parse(rollout.slice(0, rollout.indexOf('\n') === -1 ? undefined : rollout.indexOf('\n'))) as RolloutLine
    if (first.type !== 'session_meta') return null
    const source = first.payload?.source
    if (typeof source === 'object' && source !== null && 'subagent' in source) return null
    const id = first.payload?.id
    return typeof id === 'string' && UUID.test(id) ? id : null
  } catch {
    return null
  }
}

/** Every chat written at or after `sinceMs` that holds `marker`. */
export async function findChatsByMarker(root: string, marker: string, sinceMs: number): Promise<{ chatId: string; path: string }[]> {
  const matches: { chatId: string; path: string }[] = []
  for (const path of await recentRollouts(root, sinceMs)) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (!text.includes(marker)) continue
    const chatId = rolloutChatId(text)
    if (chatId !== null && !matches.some((match) => match.chatId === chatId)) matches.push({ chatId, path })
  }
  return matches
}

/** The saved chat `chatId`, searched in the recent day folders. */
export async function findRolloutById(root: string, chatId: string, sinceMs: number): Promise<string | null> {
  return (await recentRollouts(root, sinceMs, `-${chatId}.jsonl`))[0] ?? null
}
