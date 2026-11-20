/**
 * The launcher's record of an open `relay codex` chat, so the daemon can tell
 * whether a Slack reply can be queued into it.
 *
 * Codex has no registry of open chats like Claude's sessions folder, so the
 * launcher that started the chat writes one file per chat under
 * `<relay home>/run/codex-chats/` and removes it when the chat exits. A file
 * left behind by a crash does not count: the chat is open only while the
 * recorded process is alive AND started at the recorded time, so a process id
 * the system has since reused is not mistaken for the chat.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readAccountPool } from '../autonomous/accounts.js'
import { relayPath } from '../config/paths.js'
import { defaultExecFile, type ExecFileFn } from '../sessions/liveness.js'

export type CodexChatRecord = {
  /** Codex's own chat (thread) id. */
  readonly chatId: string
  readonly pid: number
  /** The process start time as `ps -o lstart=` prints it. */
  readonly startedAt: string
  /** The login the chat runs on (its CODEX_HOME), which `codex queue` must use. */
  readonly codexHome: string
}

export type OpenCodexDeps = {
  /** Folder holding the records; defaults to `<relay home>/run/codex-chats`. */
  readonly dir?: string
  readonly execFile?: ExecFileFn
}

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The default login's folder, for a login with no CODEX_HOME. */
export function codexHomeOf(configDir: string | null, home: string = homedir()): string {
  return resolve(configDir ?? join(home, '.codex'))
}

/** Every Codex login's folder from the account pool (~/.agents/accounts.toml plus the default login). */
export async function knownCodexHomes(): Promise<string[]> {
  return (await readAccountPool()).filter((account) => account.client === 'codex').map((account) => codexHomeOf(account.configDir))
}

/** Whether the Codex chat `chatId` is open in a terminal on a known login. */
export type CodexChatLookup = (chatId: string) => Promise<CodexChatRecord | null>

export const defaultCodexChatLookup: CodexChatLookup = async (chatId) => findOpenCodexChat(chatId, await knownCodexHomes())

function recordsDir(deps: OpenCodexDeps): string {
  return deps.dir ?? relayPath('run', 'codex-chats')
}

function recordPath(deps: OpenCodexDeps, chatId: string): string {
  // The id names a file, so only a real id is accepted.
  if (!CHAT_ID.test(chatId)) throw new Error(`not a Codex chat id: ${chatId}`)
  return join(recordsDir(deps), `${chatId}.json`)
}

/** When `pid` started, or null when no such process runs. */
// The launcher (a terminal) and the daemon (launchd) may have different TZ or locale, and ps prints the start in both.
const psInUtc: ExecFileFn = (file, args) => defaultExecFile(file, args, { ...process.env, TZ: 'UTC', LC_ALL: 'C' })

export async function processStartedAt(pid: number, execFileFn: ExecFileFn = psInUtc): Promise<string | null> {
  try {
    // Through the shared wrapper (src/sessions/liveness.ts), as the Claude process scan runs ps.
    const { stdout } = await execFileFn('ps', ['-o', 'lstart=', '-p', String(pid)])
    const started = stdout.trim()
    return started === '' ? null : started
  } catch {
    // ps exits 1 when the process is gone.
    return null
  }
}

/** Writes (or rewrites, after a move to another login) the record; written whole, so a reader never sees half of it. */
export async function writeCodexChatRecord(record: { chatId: string; pid: number; codexHome: string }, deps: OpenCodexDeps = {}): Promise<void> {
  const startedAt = await processStartedAt(record.pid, deps.execFile)
  if (startedAt === null) throw new Error(`the Codex process ${record.pid} is not running`)
  const path = recordPath(deps, record.chatId)
  await mkdir(recordsDir(deps), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const body: CodexChatRecord = { chatId: record.chatId, pid: record.pid, startedAt, codexHome: resolve(record.codexHome) }
  await writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export async function deleteCodexChatRecord(chatId: string, deps: OpenCodexDeps = {}): Promise<void> {
  await rm(recordPath(deps, chatId), { force: true })
}

/**
 * The record of the chat `chatId` while it is open, or null. A record whose
 * process is gone, whose process id now belongs to a later process, or whose
 * login is not one of `knownHomes` is not an open chat.
 */
export async function findOpenCodexChat(chatId: string, knownHomes: readonly string[], deps: OpenCodexDeps = {}): Promise<CodexChatRecord | null> {
  if (!CHAT_ID.test(chatId)) return null
  let record: CodexChatRecord
  try {
    record = JSON.parse(await readFile(recordPath(deps, chatId), 'utf8')) as CodexChatRecord
  } catch {
    return null
  }
  if (record.chatId !== chatId || !Number.isInteger(record.pid) || typeof record.codexHome !== 'string' || typeof record.startedAt !== 'string') return null
  const homes = new Set(knownHomes.map((home) => resolve(home)))
  if (!homes.has(resolve(record.codexHome))) return null
  const startedAt = await processStartedAt(record.pid, deps.execFile)
  return startedAt !== null && startedAt === record.startedAt ? record : null
}
