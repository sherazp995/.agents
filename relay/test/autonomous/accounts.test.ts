import { describe, expect, it } from 'vitest'
import {
  buildAccountPool,
  chooseAccount,
  classifyBlocked,
  orderForPreference,
  parseAgentPreference,
  type Account,
  type CooldownStore,
} from '../../src/autonomous/accounts.js'

const FIXTURE = `
[[accounts]]
client = "claude"
alias = "claude1"
dir = "~/.claude1"

[[accounts]]
client = "codex"
alias = "codex1"
dir = "/opt/codex1"

[[accounts]]
client = "gemini"
alias = "g1"
dir = "~/.gemini"

[[accounts]]
client = "claude"
alias = "claude9"
dir = "~/.claude9"
`

function memoryCooldowns(cooling: Record<string, number> = {}): CooldownStore {
  return {
    async cooldownUntil(key) {
      return cooling[key] ?? null
    },
    async coolDown(key, until) {
      cooling[key] = until
    },
  }
}

describe('account pool', () => {
  it('orders default claude, claude aliases in file order, default codex, codex aliases; skips unknown clients; expands ~', () => {
    const pool = buildAccountPool(FIXTURE, { home: '/home/op' })

    expect(pool.map((account) => account.key)).toEqual(['claude', 'claude1', 'claude9', 'codex', 'codex1'])
    expect(pool.find((account) => account.key === 'claude1')?.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/op/.claude1' })
    expect(pool.find((account) => account.key === 'codex1')?.env).toEqual({ CODEX_HOME: '/opt/codex1' })
    expect(pool.find((account) => account.key === 'claude')?.env).toEqual({})
  })

  it('falls back to the two default logins for a missing or malformed file', () => {
    expect(buildAccountPool(undefined).map((account) => account.key)).toEqual(['claude', 'codex'])
    expect(buildAccountPool('[[accounts\nbroken').map((account) => account.key)).toEqual(['claude', 'codex'])
  })

  it('puts the preferred client first', () => {
    const pool = buildAccountPool(FIXTURE, { home: '/h' })
    expect(orderForPreference(pool, 'codex').map((account) => account.key)).toEqual(['codex', 'codex1', 'claude', 'claude1', 'claude9'])
    expect(parseAgentPreference('<@U1> use codex for this')).toBe('codex')
    expect(parseAgentPreference('start a claude session please')).toBe('claude')
    expect(parseAgentPreference('review PR 12')).toBeNull()
  })

  it('classifies blocked exits by stderr and a missing binary, and an ordinary failure as not blocked', () => {
    expect(classifyBlocked({ exitCode: 1, stderr: 'Claude usage limit reached' })).toBe('usage_limit')
    expect(classifyBlocked({ exitCode: 1, stderr: "You've hit your monthly spend limit" })).toBe('usage_limit')
    expect(classifyBlocked({ exitCode: 1, stderr: "You've hit your session limit" })).toBe('usage_limit')
    expect(classifyBlocked({ exitCode: 1, stderr: "You've hit your rate limit" })).toBe('rate_limit')
    expect(classifyBlocked({ exitCode: 1, stderr: 'the test hit your branch and the old file size limit' })).toBeNull()
    expect(classifyBlocked({ exitCode: 1, stderr: 'HTTP 429 Too Many Requests' })).toBe('rate_limit')
    expect(classifyBlocked({ exitCode: 1, stderr: 'Not logged in. Please run /login' })).toBe('auth')
    expect(classifyBlocked({ exitCode: null, stderr: '', spawnErrorCode: 'ENOENT' })).toBe('missing_cli')
    expect(classifyBlocked({ exitCode: 1, stderr: 'TypeError in test' })).toBeNull()
  })

  it('skips cooling and ineligible codex accounts, and reports the earliest wakeup when none is free', async () => {
    const pool = buildAccountPool(FIXTURE, { home: '/h' })
    const eligibleOnly = (keys: string[]) => async (account: Account) => keys.includes(account.key)

    const choice = await chooseAccount(orderForPreference(pool, 'codex'), {
      cooldowns: memoryCooldowns({ codex1: Date.now() + 1000 }),
      isCodexEligible: eligibleOnly(['codex1']),
    })
    expect(choice).toEqual({ kind: 'account', account: pool[0] })

    const until = Date.now() + 5000
    const none = await chooseAccount(pool, {
      cooldowns: memoryCooldowns({ claude: until + 10, claude1: until, claude9: until + 20 }),
      isCodexEligible: eligibleOnly([]),
    })
    expect(none).toEqual({ kind: 'none', wakeAtMs: until })
  })
})
