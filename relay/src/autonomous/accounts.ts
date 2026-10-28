/**
 * The worker account pool (user decision 3): every claude login first (the
 * default, then ~/.agents/accounts.toml in file order), then every codex
 * login the same way. A new alias in that file joins the pool with no relay
 * change. Its format belongs to `agents-hub account`; relay reads only
 * `client`, `alias` and `dir`.
 *
 * An account that hits a usage or rate limit, fails auth, or whose CLI is
 * missing cools down; the next account is used and the thread is told.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Redis } from '../redis/client.js'
import type { Logger } from '../obs/logger.js'

export const ACCOUNT_CLIENTS = ['claude', 'codex'] as const
export type AccountClient = (typeof ACCOUNT_CLIENTS)[number]

export type Account = {
  /** Stable key: the alias, or the client name for its default login. */
  key: string
  client: AccountClient
  /** Null for the client's default login. */
  configDir: string | null
  /** The env var that selects this login, when it is not the default. */
  env: Record<string, string>
}

export const DEFAULT_ACCOUNTS_FILE = join(homedir(), '.agents', 'accounts.toml')

const CONFIG_DIR_VAR: Record<AccountClient, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }

function defaultAccount(client: AccountClient): Account {
  return { key: client, client, configDir: null, env: {} }
}

function expandHome(dir: string, home: string): string {
  if (dir === '~') return home
  return dir.startsWith('~/') ? join(home, dir.slice(2)) : dir
}

function isClient(value: unknown): value is AccountClient {
  return ACCOUNT_CLIENTS.some((client) => client === value)
}

/** Builds the ordered pool from the file's text; undefined or malformed text gives the two defaults. */
export function buildAccountPool(text: string | undefined, options: { home?: string; log?: Logger } = {}): Account[] {
  const home = options.home ?? homedir()
  const extra: Account[] = []
  if (text !== undefined) {
    let entries: unknown[] = []
    try {
      const parsed = parseToml(text) as { accounts?: unknown }
      entries = Array.isArray(parsed.accounts) ? parsed.accounts : []
    } catch (error) {
      options.log?.error({ err: error }, 'accounts.toml could not be parsed; using the default logins only')
    }
    for (const entry of entries) {
      const { client, alias, dir } = (entry ?? {}) as { client?: unknown; alias?: unknown; dir?: unknown }
      if (!isClient(client)) {
        options.log?.warn({ client }, 'accounts.toml entry has an unknown client; skipped')
        continue
      }
      if (typeof alias !== 'string' || alias === '' || typeof dir !== 'string' || dir === '') {
        options.log?.warn({ alias }, 'accounts.toml entry lacks an alias or dir; skipped')
        continue
      }
      const configDir = expandHome(dir, home)
      if (!isAbsolute(configDir)) {
        options.log?.warn({ alias }, 'accounts.toml entry has a relative dir; skipped')
        continue
      }
      // Cooldowns are keyed by alias, so two accounts may not share one.
      if (alias === 'claude' || alias === 'codex' || extra.some((account) => account.key === alias)) {
        options.log?.warn({ alias }, 'accounts.toml alias is already taken; skipped')
        continue
      }
      extra.push({ key: alias, client, configDir, env: { [CONFIG_DIR_VAR[client]]: configDir } })
    }
  }
  return ACCOUNT_CLIENTS.flatMap((client) => [defaultAccount(client), ...extra.filter((account) => account.client === client)])
}

/** Read at each task start, so a newly added alias is used without a restart. */
export async function readAccountPool(path: string = DEFAULT_ACCOUNTS_FILE, log?: Logger): Promise<Account[]> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  return buildAccountPool(text, log ? { log } : {})
}

/** A mention's preference ("use codex") puts that client's accounts first; fallback order is otherwise unchanged. */
export function orderForPreference(pool: readonly Account[], preference: AccountClient | null): Account[] {
  if (preference === null) return [...pool]
  return [...pool.filter((account) => account.client === preference), ...pool.filter((account) => account.client !== preference)]
}

/** Parses "use codex", "start a claude session" and the like from a mention. */
export function parseAgentPreference(text: string): AccountClient | null {
  const match = /\b(?:use|start|with|run)\s+(?:a\s+|an\s+)?(claude|codex)\b/i.exec(text)
  const client = match?.[1]?.toLowerCase()
  return isClient(client) ? client : null
}

export type BlockedReason = 'usage_limit' | 'rate_limit' | 'auth' | 'missing_cli'

/** The one place stderr is matched. Each pattern names why an account cannot serve right now. */
const BLOCKED_PATTERNS: readonly { reason: BlockedReason; pattern: RegExp }[] = [
  { reason: 'usage_limit', pattern: /usage limit|limit reached|quota|credit balance is too low|out of credits/i },
  { reason: 'rate_limit', pattern: /rate limit|too many requests|\b429\b|overloaded/i },
  { reason: 'auth', pattern: /not logged in|please log in|login required|unauthorized|\b401\b|invalid api key|authentication/i },
]

/** Why this exit means "try the next account", or null when it was an ordinary failure of the task itself. */
export function classifyBlocked(result: { exitCode: number | null; stderr: string; spawnErrorCode?: string }): BlockedReason | null {
  if (result.spawnErrorCode === 'ENOENT') return 'missing_cli'
  if (result.exitCode === 0) return null
  return BLOCKED_PATTERNS.find(({ pattern }) => pattern.test(result.stderr))?.reason ?? null
}

/** How long each kind of block cools an account down. */
export const COOLDOWN_MS: Record<BlockedReason, number> = {
  usage_limit: 60 * 60 * 1000,
  rate_limit: 5 * 60 * 1000,
  auth: 6 * 60 * 60 * 1000,
  missing_cli: 6 * 60 * 60 * 1000,
}

export interface CooldownStore {
  /** Epoch ms the account is cooling until, or null when free. */
  cooldownUntil(key: string): Promise<number | null>
  coolDown(key: string, untilMs: number): Promise<void>
}

export class RedisCooldownStore implements CooldownStore {
  constructor(private readonly redis: Redis, private readonly prefix = 'relay:autonomous:cooldown:') {}

  async cooldownUntil(key: string): Promise<number | null> {
    const value = await this.redis.get(this.prefix + key)
    const until = value === null ? null : Number(value)
    return until !== null && until > Date.now() ? until : null
  }

  async coolDown(key: string, untilMs: number): Promise<void> {
    const ttlMs = Math.max(1, untilMs - Date.now())
    await this.redis.set(this.prefix + key, String(untilMs), 'PX', ttlMs)
  }
}

export type AccountChoice =
  | { kind: 'account'; account: Account }
  /** Every account is cooling down or ineligible; wake at the earliest cooldown end (null when none will end). */
  | { kind: 'none'; wakeAtMs: number | null }

/**
 * The first account that is not cooling down and, for codex, passed the
 * doctor's hook and usage probes. An ineligible codex account is skipped for
 * every autonomous invocation.
 */
export async function chooseAccount(
  pool: readonly Account[],
  deps: { cooldowns: CooldownStore; isCodexEligible: (account: Account) => Promise<boolean>; exclude?: readonly string[] },
): Promise<AccountChoice> {
  let wakeAtMs: number | null = null
  for (const account of pool) {
    if (deps.exclude?.includes(account.key)) continue
    const until = await deps.cooldowns.cooldownUntil(account.key)
    if (until === null) {
      if (account.client === 'codex' && !(await deps.isCodexEligible(account))) continue
      return { kind: 'account', account }
    }
    wakeAtMs = wakeAtMs === null ? until : Math.min(wakeAtMs, until)
  }
  return { kind: 'none', wakeAtMs }
}
