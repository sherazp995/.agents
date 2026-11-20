import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Account, CooldownStore } from '../../src/autonomous/accounts.js'
import { codexChatFromArgs, codexResumeArgs, codexRolloutBlockedReason } from '../../src/cli/launch-codex.js'
import { chatBrief, claudeProjectSlug, claudeSession, launchArgs, launchEnv, opensChat, readIfPresent, resumeArgs, runInTerminal, runLaunch, transcriptBlockedReason, type LaunchDeps, type PreparedLaunch } from '../../src/cli/launch.js'

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

    // Started from inside a Claude Code chat (env captured 2026-11-20): without this the new chat is that one's child and never registers.
    const parent = { CLAUDECODE: '1', CLAUDE_PID: '49393', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_CHILD_NOTES_DIR: '/tmp/n', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/49393.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'tok', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXECPATH: '/x', CLAUDE_CODE_USE_BEDROCK: '1' }
    expect(launchEnv({ PATH: '/bin', ...parent }, {}, claude('claude', null))).toEqual({ PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1' })
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
    expect(chatBrief('codex', { thread: { channel: 'C1', thread: '1.2' }, project: null })).toContain("until then Relay's own loop answers them")
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

  // The policy is covered above with a fake runner; this one runs a real child process, reads the transcript it
  // wrote from disk, and checks the two logins share a projects folder the way ~/.claude1 and ~/.claude2 link to ~/.claude.
  it('resumes on the next login through a real child process that wrote a real usage-limit line into its transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-launch-real-'))
    const [first, second] = [join(root, 'login-a'), join(root, 'login-b')]
    mkdirSync(join(first, 'projects'), { recursive: true })
    mkdirSync(second)
    symlinkSync(join(first, 'projects'), join(second, 'projects'))
    const log = join(root, 'runs.log')
    const bin = join(root, 'claude')
    writeFileSync(bin, [
      '#!/bin/sh',
      'id=""; how=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then id="$a"; how="$prev"; fi; prev="$a"; done',
      'echo "$CLAUDE_CONFIG_DIR $how $id" >> "$RUN_LOG"',
      'dir="$CLAUDE_CONFIG_DIR/projects/$SLUG"; mkdir -p "$dir"',
      'if [ "$CLAUDE_CONFIG_DIR" = "$FIRST_LOGIN" ]; then printf \'%s\\n\' "$LIMIT_LINE" >> "$dir/$id.jsonl"; else printf \'%s\\n\' "$OK_LINE" >> "$dir/$id.jsonl"; fi',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const cwd = process.cwd()
    const { deps, cooldowns, said } = harness({
      bin,
      cwd,
      userArgs: [],
      accounts: async () => [claude('a', first), claude('b', second)],
      run: runInTerminal,
      readTranscript: readIfPresent,
      baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', RUN_LOG: log, SLUG: claudeProjectSlug(cwd), FIRST_LOGIN: first, LIMIT_LINE: apiError(WEEKLY_LIMIT), OK_LINE: answer('done') },
    })

    expect(await runLaunch(deps)).toBe(0)

    const runs = readFileSync(log, 'utf8').trim().split('\n')
    expect(runs).toEqual([`${first} --session-id ${ID}`, `${second} --resume ${ID}`])
    expect(cooldowns.until.has('a')).toBe(true)
    expect(said.some((text) => text.includes('resuming this chat on the next free login'))).toBe(true)
  })

  // Each case runs a real fake-codex process with sleeps (about 1.5 seconds a run); a busy machine needs room.
  describe('a Codex chat', { timeout: 20_000 }, () => {
    const CHAT = '01a1f9b7-c23a-7fd1-879a-5c2da28c6dff'
    const OTHER = '01a1f9b7-0000-7000-8000-000000000002'
    // The real usage-limit record Codex wrote on this laptop (rollout-2026-11-04T11-49-52-01a1a552-...).
    const LIMIT = line({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'You’ve hit your usage limit. Upgrade to Pro or try again at Nov 5th, 2026 6:09 PM.' } } })
    const DONE = line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } })

    /** Two Codex logins sharing one sessions folder, as ~/.codex1/sessions links to ~/.codex/sessions, and a fake codex. */
    function codexSetup(mode: 'normal' | 'twice' | 'expired' | 'quiet' = 'normal') {
      const root = mkdtempSync(join(tmpdir(), 'relay-codex-launch-'))
      const sessions = join(root, 'sessions')
      mkdirSync(sessions)
      const [first, second] = [join(root, 'login-a'), join(root, 'login-b')]
      for (const login of [first, second]) {
        mkdirSync(login)
        symlinkSync(sessions, join(login, 'sessions'))
      }
      const log = join(root, 'runs.log')
      const bin = join(root, 'codex')
      writeFileSync(bin, [
        '#!/bin/sh',
        'marker=""; resume=""; prev=""',
        'for a in "$@"; do',
        '  case "$a" in developer_instructions=*) marker=$(printf "%s" "$a" | grep -o "relay-[0-9a-f-]*" | head -1);; esac',
        '  if [ "$prev" = "resume" ]; then resume="$a"; fi; prev="$a"',
        'done',
        'echo "$CODEX_HOME ${resume:-new}" >> "$RUN_LOG"',
        '[ "$MODE" = expired ] && exit 1',
        // Opened and quit at once, with no new turn.
        '[ "$MODE" = quiet ] && { sleep 0.3; exit 0; }',
        'id="${resume:-$CHAT_ID}"; day="$SESSIONS/2026/11/20"; f="$day/rollout-2026-11-20T21-00-00-$id.jsonl"; mkdir -p "$day"',
        // Saved late, as Codex saves a chat only after its first message.
        'sleep 0.4',
        '[ -f "$f" ] || printf \'{"type":"session_meta","payload":{"id":"%s"}}\\n\' "$id" > "$f"',
        '[ -n "$marker" ] && printf \'{"type":"response_item","payload":{"type":"message","role":"developer","text":"%s"}}\\n\' "$marker" >> "$f"',
        '[ "$MODE" = twice ] && printf \'{"type":"session_meta","payload":{"id":"%s"}}\\n{"text":"%s"}\\n\' "$OTHER_ID" "$marker" > "$day/rollout-2026-11-20T21-00-01-$OTHER_ID.jsonl"',
        'sleep 0.4',
        'if [ "$CODEX_HOME" = "$FIRST_LOGIN" ]; then printf "%s\\n" "$LIMIT_LINE" >> "$f"; else printf "%s\\n" "$DONE_LINE" >> "$f"; fi',
        'sleep 0.4',
        '',
      ].join('\n'))
      chmodSync(bin, 0o755)
      const links: { thread: unknown; chatId: string }[] = []
      const notes: string[] = []
      const records: string[] = []
      const codexLogin = (key: string, dir: string): Account => ({ key, client: 'codex', configDir: dir, env: { CODEX_HOME: dir } })
      const made = harness({
        client: 'codex',
        bin,
        userArgs: [],
        accounts: async () => [codexLogin('cx-a', first), codexLogin('cx-b', second)],
        run: runInTerminal,
        readTranscript: readIfPresent,
        baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', RUN_LOG: log, SESSIONS: sessions, MODE: mode, CHAT_ID: CHAT, OTHER_ID: OTHER, FIRST_LOGIN: first, LIMIT_LINE: LIMIT, DONE_LINE: DONE },
        codex: {
          sessionsRoot: sessions,
          pollMs: 50,
          link: async (thread, chatId) => {
            links.push({ thread, chatId })
          },
          noteInThread: async (_thread, text) => {
            notes.push(text)
          },
          writeRecord: async (record) => {
            records.push(`write ${record.chatId} ${record.codexHome} ${record.pid > 0}`)
          },
          deleteRecord: async (chatId) => {
            records.push(`delete ${chatId}`)
          },
        },
      })
      const runs = () => readFileSync(log, 'utf8').trim().split('\n')
      return { ...made, first, second, sessions, links, notes, records, runs }
    }

    it('finds the chat by its marker once Codex saves it, links the thread, and after a usage limit resumes it on the next login', async () => {
      const setup = codexSetup()

      expect(await runLaunch(setup.deps)).toBe(0)

      expect(setup.runs()).toEqual([`${setup.first} new`, `${setup.second} ${CHAT}`])
      expect(setup.links).toEqual([{ thread: { channel: 'C1', thread: '1.2' }, chatId: CHAT }])
      // The record follows the chat to the second login, and is gone after each run.
      expect(setup.records).toEqual([`write ${CHAT} ${setup.first} true`, `delete ${CHAT}`, `write ${CHAT} ${setup.second} true`, `delete ${CHAT}`])
      // Decision 1 A: the thread is told at once; the chat moves when it exits.
      expect(setup.notes).toEqual(['cx-a hit its usage limit. Quit the terminal chat (/exit) and Relay resumes it on the next free Codex login.'])
      expect(setup.cooldowns.until.has('cx-a')).toBe(true)
      expect(setup.said.some((text) => text.includes('resuming this chat on the next free login'))).toBe(true)
    })

    it('takes the chat id from `resume <id>`, and keeps the options but not the prompt when it moves', async () => {
      const setup = codexSetup()
      const resumed = { ...setup.deps, userArgs: ['resume', CHAT, '-m', 'o3', 'and now the tests'] }

      expect(await runLaunch(resumed)).toBe(0)

      expect(setup.runs()).toEqual([`${setup.first} ${CHAT}`, `${setup.second} ${CHAT}`])
      expect(setup.links.map((link) => link.chatId)).toEqual([CHAT])
      expect(codexResumeArgs(['resume', CHAT, '-m', 'o3', 'and now the tests'], CHAT)).toEqual(['resume', CHAT, '-m', 'o3'])
      expect(codexResumeArgs(['fix the login bug', '--search', '-c', 'x=1'], CHAT)).toEqual(['resume', CHAT, '--search', '-c', 'x=1'])
    })

    it("ignores a subagent's chat that repeats the launch marker", async () => {
      const setup = codexSetup()
      const day = join(setup.sessions, '2026', '11', '20')
      mkdirSync(day, { recursive: true })
      // Real shape: session_meta source {"subagent": {"other": "guardian"}} (rollout-2026-11-18T13-03-14-01a1edae-...).
      const guardian = '01a1edae-6ed3-7142-a365-ae1336385a8d'
      writeFileSync(join(day, `rollout-2026-11-20T21-00-02-${guardian}.jsonl`), `${line({ type: 'session_meta', payload: { id: guardian, source: { subagent: { other: 'guardian' } } } })}\n${line({ text: `relay-${ID}` })}\n`)

      await runLaunch(setup.deps)

      expect(setup.links.map((link) => link.chatId)).toEqual([CHAT])
    })

    it('does not move a resumed chat whose record already ended on an old limit when this run added no turn', async () => {
      const setup = codexSetup('quiet')
      const day = join(setup.sessions, '2026', '11', '20')
      mkdirSync(day, { recursive: true })
      writeFileSync(join(day, `rollout-2026-11-20T09-00-00-${CHAT}.jsonl`), `${line({ type: 'session_meta', payload: { id: CHAT } })}\n${LIMIT}\n`)

      expect(await runLaunch({ ...setup.deps, userArgs: ['resume', CHAT] })).toBe(0)

      expect(setup.runs()).toEqual([`${setup.first} ${CHAT}`])
      expect(setup.cooldowns.until.size).toBe(0)
      expect(setup.notes).toEqual([])
    })

    it('tries the link again when it failed for another reason than Relay having the thread', async () => {
      const setup = codexSetup()
      let failures = 1
      const link = setup.deps.codex?.link
      if (link === undefined) throw new Error('no link')
      const codex = { ...setup.deps.codex, link: async (thread: { channel: string; thread: string }, chatId: string) => {
        if (failures-- > 0) throw new Error('Connection terminated due to connection timeout')
        await link(thread, chatId)
      } } as NonNullable<LaunchDeps['codex']>

      await runLaunch({ ...setup.deps, codex })

      expect(setup.links.map((entry) => entry.chatId)).toEqual([CHAT])
    })

    it('links nothing when two chats hold the launch marker', async () => {
      const setup = codexSetup('twice')

      await runLaunch(setup.deps)

      expect(setup.links).toEqual([])
      expect(setup.records).toEqual([])
      expect(setup.said.some((text) => text.includes('Found 2 Codex chats from this launch'))).toBe(true)
    })

    it('says so and starts nothing more when the chat exits before Codex saved it, as with an expired login', async () => {
      const setup = codexSetup('expired')

      expect(await runLaunch(setup.deps)).toBe(1)

      expect(setup.runs()).toEqual([`${setup.first} new`])
      expect(setup.links).toEqual([])
      expect(setup.said.at(-1)).toContain('exited before Codex saved the chat')
    })

    it('reads a limit only from the last finished turn of a real Codex record', () => {
      expect(codexRolloutBlockedReason([LIMIT, DONE].join('\n'))).toBeNull()
      expect(codexRolloutBlockedReason([DONE, LIMIT, line({ type: 'event_msg', payload: { type: 'token_count' } })].join('\n'))).toBe('usage_limit')
      expect(codexRolloutBlockedReason(line({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'Login expired · Please run /login' } } }))).toBe('auth')
      expect(codexChatFromArgs(['resume', CHAT])).toBe(CHAT)
      expect(codexChatFromArgs(['-m', 'o3', 'resume', CHAT])).toBe(CHAT)
      for (const args of [['resume'], ['resume', '--last'], ['fork', CHAT], []]) expect(codexChatFromArgs(args)).toBeNull()
    })
  })

  it('does not move a chat to a login that keeps its chats elsewhere', async () => {
    const transcript = join(homedir(), '.claude', 'projects', '-Users-me-app', `${ID}.jsonl`)
    const { deps, runs, said } = harness({ transcripts: { [transcript]: apiError(LOGIN_EXPIRED) }, projectsDir: async (account) => `/projects/${account.key}` })
    expect(await runLaunch(deps)).toBe(0)
    expect(runs).toHaveLength(1)
    expect(said.at(-1)).toBe('claude hit its login expiry, and claude1 keeps its chats elsewhere, so this chat cannot move there. Start a new one with: relay claude')
  })
})
