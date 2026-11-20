import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Account, CooldownStore } from '../../src/autonomous/accounts.js'
import { chatBrief, claudeProjectSlug, claudeSession, launchArgs, launchEnv, opensChat, resumeArgs, runLaunch, transcriptBlockedReason, type LaunchDeps, type PreparedLaunch } from '../../src/cli/launch.js'

const ID = '11111111-2222-3333-4444-555555555555'

// Real API error lines Claude Code wrote into transcripts on this laptop.
const WEEKLY_LIMIT = "You've hit your weekly limit · resets Nov 9 at 3pm (Asia/Karachi)"
const SPEND_LIMIT = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets 3am (Asia/Karachi)"
const LOGIN_EXPIRED = 'Login expired · Please run /login'
const SLEPT = 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.'

const line = (entry: object): string => JSON.stringify(entry)
const apiError = (text: string): string => line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text }] } })
const answer = (text: string): string => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

const claude = (key: string, configDir: string | null): Account => ({ key, client: 'claude', configDir, env: configDir === null ? {} : { CLAUDE_CONFIG_DIR: configDir } })

class MemoryCooldowns implements CooldownStore {
  readonly until = new Map<string, number>()
  async cooldownUntil(key: string): Promise<number | null> {
    return this.until.get(key) ?? null
  }
  async coolDown(key: string, untilMs: number): Promise<void> {
    this.until.set(key, untilMs)
  }
}

function harness(overrides: Partial<LaunchDeps> & { transcripts?: Record<string, string> } = {}) {
  const cooldowns = new MemoryCooldowns()
  const runs: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
  const said: string[] = []
  const prepared: PreparedLaunch = { env: { API_TOKEN: 'from-relay-env' }, thread: { channel: 'C1', thread: '1.2' }, project: null, notes: ['Slack thread opened in your DM.'] }
  const prepareCalls: { account: string; attachTo: string | null; openThread: boolean }[] = []
  const deps: LaunchDeps = {
    client: 'claude',
    bin: '/bin/claude',
    userArgs: ['--model', 'opus'],
    cwd: '/Users/me/app',
    host: 'laptop',
    // Every login shares one projects folder here (/tmp), so a chat can resume on any of them.
    accounts: async () => [claude('claude', null), claude('claude1', '/tmp'), { key: 'codex', client: 'codex', configDir: null, env: {} }],
    withCooldowns: (use) => use(cooldowns),
    isCodexEligible: async () => true,
    prepare: async ({ account, attachTo, openThread }) => {
      prepareCalls.push({ account: account.key, attachTo, openThread })
      return prepared
    },
    run: async (_bin, args, env) => {
      runs.push({ args, env })
      return 0
    },
    readTranscript: async (path) => overrides.transcripts?.[path] ?? null,
    say: (text) => said.push(text),
    baseEnv: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/Users/me/.claude2' },
    newId: () => ID,
    ...overrides,
  }
  return { deps, cooldowns, runs, said, prepareCalls }
}

describe('relay claude / relay codex', () => {
  it('passes the user arguments through, after the chat id and brief it adds', () => {
    expect(launchArgs('claude', ['--model', 'opus', '-p', 'hi'], { session: { kind: 'new', id: ID }, brief: 'B' })).toEqual(['--session-id', ID, '--append-system-prompt', 'B', '--model', 'opus', '-p', 'hi'])
    expect(launchArgs('claude', ['--resume', ID], { session: { kind: 'given', id: ID }, brief: '' })).toEqual(['--resume', ID])
    expect(launchArgs('codex', ['--model', 'o3'], { session: null, brief: 'say "hi"' })).toEqual(['-c', 'developer_instructions="say \\"hi\\""', '--model', 'o3'])
  })

  it('knows which chat the arguments start, and when it cannot know before the chat runs', () => {
    expect(claudeSession([], () => ID)).toEqual({ kind: 'new', id: ID })
    expect(claudeSession(['--resume', ID])).toEqual({ kind: 'given', id: ID })
    expect(claudeSession([`--session-id=${ID}`])).toEqual({ kind: 'given', id: ID })
    for (const args of [['--continue'], ['-c'], ['--resume']]) expect(claudeSession(args)).toEqual({ kind: 'unknown' })
  })

  it('opens a thread only for a chat, and leaves other calls exactly as typed', async () => {
    expect(opensChat('claude', [])).toBe(true)
    expect(opensChat('claude', ['fix the login bug'])).toBe(true)
    expect(opensChat('codex', ['resume', ID])).toBe(true)
    for (const args of [['--version'], ['-p', 'hi'], ['mcp', 'list'], ['doctor']]) expect(opensChat('claude', args)).toBe(false)
    expect(opensChat('codex', ['exec', 'hi'])).toBe(false)

    const { deps, runs, prepareCalls } = harness({ userArgs: ['mcp', 'list'] })
    expect(await runLaunch(deps)).toBe(0)
    expect(runs[0]?.args).toEqual(['mcp', 'list'])
    expect(prepareCalls).toEqual([{ account: 'claude', attachTo: null, openThread: false }])
  })

  it('resumes with the chat id in place of any chat choice the user gave', () => {
    expect(resumeArgs(['--model', 'opus'], ID)).toEqual(['--resume', ID, '--model', 'opus'])
    expect(resumeArgs(['--session-id', ID, '--model', 'opus'], ID)).toEqual(['--resume', ID, '--model', 'opus'])
    expect(resumeArgs([`--resume=${ID}`], ID)).toEqual(['--resume', ID])
  })

  it("puts stored envs and the chosen login in the chat's environment, dropping an alias's login", () => {
    const env = launchEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/Users/me/.claude2', CODEX_HOME: '/x' }, { API_TOKEN: 't' }, claude('claude1', '/Users/me/.claude1'))
    expect(env).toEqual({ PATH: '/bin', API_TOKEN: 't', CLAUDE_CONFIG_DIR: '/Users/me/.claude1' })
    expect(launchEnv({ CLAUDE_CONFIG_DIR: '/Users/me/.claude2' }, {}, claude('claude', null))).toEqual({})
  })

  it("reads a usage limit or expired login from the chat's last answer only, on real messages", () => {
    expect(transcriptBlockedReason([answer('hi'), apiError(WEEKLY_LIMIT)].join('\n'))).toBe('usage_limit')
    expect(transcriptBlockedReason(`${apiError(SPEND_LIMIT)}\n`)).toBe('usage_limit')
    expect(transcriptBlockedReason(apiError(LOGIN_EXPIRED))).toBe('auth')
    expect(transcriptBlockedReason(apiError(SLEPT))).toBeNull()
    expect(transcriptBlockedReason([apiError(WEEKLY_LIMIT), line({ type: 'user', message: { content: 'go on' } }), answer('done')].join('\n'))).toBeNull()
    expect(claudeProjectSlug('/Users/hassan/.agents')).toBe('-Users-hassan--agents')
  })

  it('tells the chat its thread and team, never the team commands it cannot run', () => {
    const project = {
      project: { id: 'p', name: 'Insitu', slackChannel: 'C1', folder: '/w/insitu', repos: ['laktattest'] },
      members: [
        { id: 'm1', name: 'Ada', role: 'Lead', isLead: true, personaId: 'x', personaName: 'Lead', client: 'claude' as const, model: null },
        { id: 'm2', name: 'Sol', role: 'Reviewer', isLead: false, personaId: 'y', personaName: 'Reviewer', client: 'codex' as const, model: 'gpt-6' },
      ],
    }
    const brief = chatBrief('claude', { thread: { channel: 'C1', thread: '1.2' }, project })
    expect(brief).toContain('relay live say --channel C1 --thread 1.2')
    expect(brief).toContain('are pushed into this chat')
    expect(brief).toContain('- Ada: Lead (lead) (claude)')
    expect(brief).toContain('- Sol: Reviewer (codex, gpt-6)')
    expect(brief).not.toMatch(/relay team (start|assign|merge)/)
    expect(chatBrief('codex', { thread: { channel: 'C1', thread: '1.2' }, project: null })).toContain('do not reach this chat')
    expect(chatBrief('claude', { thread: null, project: null })).toBe('')
  })

  it('starts on the first free login with the stored envs, attaching the thread to the chat id it passes', async () => {
    const { deps, cooldowns, runs, said, prepareCalls } = harness()
    cooldowns.until.set('claude', Date.now() + 60_000)

    expect(await runLaunch(deps)).toBe(0)
    expect(prepareCalls).toEqual([{ account: 'claude1', attachTo: ID, openThread: true }])
    expect(runs).toHaveLength(1)
    expect(runs[0]?.args.slice(0, 2)).toEqual(['--session-id', ID])
    expect(runs[0]?.args.slice(-2)).toEqual(['--model', 'opus'])
    expect(runs[0]?.args.join(' ')).not.toContain('from-relay-env')
    expect(runs[0]?.env).toMatchObject({ API_TOKEN: 'from-relay-env', CLAUDE_CONFIG_DIR: '/tmp' })
    expect(said).toEqual(['Slack thread opened in your DM.', 'Starting claude on claude1.'])
  })

  it('starts nothing when every login is cooling down, and says when the first frees up', async () => {
    const { deps, cooldowns, runs, said } = harness()
    for (const key of ['claude', 'claude1']) cooldowns.until.set(key, Date.now() + 60_000)
    expect(await runLaunch(deps)).toBe(1)
    expect(runs).toHaveLength(0)
    expect(said[0]).toMatch(/^No claude login can start a chat now: every one is cooling down\. The first frees up at /)
  })

  it('skips a Codex login relay doctor has not proven', async () => {
    const { deps, runs, said } = harness({
      client: 'codex',
      accounts: async () => [{ key: 'codex', client: 'codex', configDir: null, env: {} }, { key: 'codex1', client: 'codex', configDir: '/c1', env: { CODEX_HOME: '/c1' } }],
      isCodexEligible: async (account) => account.key === 'codex1',
    })
    expect(await runLaunch(deps)).toBe(0)
    expect(runs[0]?.env.CODEX_HOME).toBe('/c1')
    expect(said).toContain('Starting codex on codex1.')
  })

  it('after a usage limit, cools the login down and resumes the same chat on the next one; a normal exit does not', async () => {
    const transcript = join(homedir(), '.claude', 'projects', '-Users-me-app', `${ID}.jsonl`)
    const limited = harness({ transcripts: { [transcript]: [answer('working'), apiError(WEEKLY_LIMIT)].join('\n') }, projectsDir: async () => '/shared' })

    expect(await runLaunch(limited.deps)).toBe(0)
    expect(limited.runs.map((run) => run.env.CLAUDE_CONFIG_DIR)).toEqual([undefined, '/tmp'])
    expect(limited.runs[1]?.args.slice(2)).toEqual(['--resume', ID, '--model', 'opus'])
    expect(limited.cooldowns.until.get('claude')).toBeGreaterThan(Date.now())
    expect(limited.said).toContain('claude hit its usage limit; resuming this chat on the next free login.')

    const normal = harness({ transcripts: { [transcript]: answer('done') }, projectsDir: async () => '/shared' })
    expect(await runLaunch(normal.deps)).toBe(0)
    expect(normal.runs).toHaveLength(1)
  })

  it('does not move a chat to a login that keeps its chats elsewhere', async () => {
    const transcript = join(homedir(), '.claude', 'projects', '-Users-me-app', `${ID}.jsonl`)
    const { deps, runs, said } = harness({ transcripts: { [transcript]: apiError(LOGIN_EXPIRED) }, projectsDir: async (account) => `/projects/${account.key}` })
    expect(await runLaunch(deps)).toBe(0)
    expect(runs).toHaveLength(1)
    expect(said.at(-1)).toBe('claude hit its login expiry, and claude1 keeps its chats elsewhere, so this chat cannot move there. Start a new one with: relay claude')
  })
})
