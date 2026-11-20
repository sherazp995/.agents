/**
 * `relay claude` and `relay codex`: the operator's own terminal chat, started
 * the way Relay starts its Slack sessions. It runs on a login that is not
 * cooling down, with the stored envs for this laptop and folder, is told about
 * the folder's project and team, and gets a Slack thread: in the project's
 * channel when the folder belongs to one, otherwise in the laptop owner's DM.
 *
 * A Claude chat is attached to its thread (replies are pushed into it, as for
 * `relay notify`). A Codex chat is linked once Codex saves it (after its first
 * message; src/cli/launch-codex.ts), and replies are queued into it while it
 * is open. When either exits on a usage limit or an expired login it resumes
 * on the next free login.
 *
 * Nothing is held open while the chat runs: the database pool and Redis are
 * closed before the chat starts, so a long chat takes none of the pooler's
 * few connections.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { codexHomeOf } from '../live/open-codex.js'
import { CodexChatWatch, codexChatFromArgs, codexMarkerLine, codexResumeArgs, type CodexLaunchDeps } from './launch-codex.js'
import { blockedReasonIn, chooseAccount, COOLDOWN_MS, type Account, type AccountClient, type BlockedReason, type CooldownStore } from '../autonomous/accounts.js'
import { knownHomes } from '../failover/paths.js'
import { buildReplyCommand } from '../live/control.js'
import { listMembers, projectForFolder, type Project, type TeamMember } from '../projects/store.js'
import type { SecretProvider } from '../secrets/provider.js'
import { readReaderKey } from '../worker-env/keys.js'
import { resolveWorkerEnv, storedWinners } from '../worker-env/resolve.js'
import { laptopOwner, linkCodexChat, NotifyError, openLinkedThread, postInThread, slackWorkspaceId } from './notify.js'

/** How long the launcher waits for the daemon to post the opening message. */
export const THREAD_WAIT_MS = 5_000

/** Exits that mean "this login cannot serve now; carry on on the next one". */
const SWITCH_REASONS: readonly BlockedReason[] = ['usage_limit', 'auth']

export type LaunchThread = { readonly channel: string; readonly thread: string }
export type LaunchProject = { readonly project: Project; readonly members: readonly TeamMember[] }

/** The chat id a Claude launch attaches its thread to, read from the arguments the user gave. */
export type ClaudeSession =
  /** A new chat: the launcher picks its id and passes --session-id. */
  | { readonly kind: 'new'; readonly id: string }
  /** --resume <id> or --session-id <id>: that chat. */
  | { readonly kind: 'given'; readonly id: string }
  /** --continue or a bare --resume: no id known before it starts, so nothing is attached. */
  | { readonly kind: 'unknown' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reads which chat `args` start, without changing them. */
export function claudeSession(args: readonly string[], newId: () => string = randomUUID): ClaudeSession {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (flag === '--session-id' || flag === '--resume' || flag === '-r') {
      const value = inline ?? args[index + 1]
      if (value !== undefined && UUID.test(value)) return { kind: 'given', id: value }
      return { kind: 'unknown' }
    }
    if (flag === '--continue' || flag === '-c') return { kind: 'unknown' }
  }
  return { kind: 'new', id: newId() }
}

/** Subcommands that are not a chat (from `claude --help` 2.1.329 and `codex --help` 0.166.0); codex `resume` and `fork` are chats. */
const NOT_A_CHAT: Record<AccountClient, ReadonlySet<string>> = {
  claude: new Set(['agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp', 'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade']),
  codex: new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'cloud', 'exec-server', 'features', 'help']),
}
const NOT_A_CHAT_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h', '--print', '-p'])

/** True when `args` open an interactive chat, which gets a thread; --version, --help, -p and other subcommands do not. */
export function opensChat(client: AccountClient, args: readonly string[]): boolean {
  if (args.some((arg) => NOT_A_CHAT_FLAGS.has(arg))) return false
  const first = args[0]
  return first === undefined || first.startsWith('-') || !NOT_A_CHAT[client].has(first)
}

/** What the chat is told about its thread and its project. Empty when there is neither. */
export function chatBrief(client: AccountClient, params: { thread: LaunchThread | null; project: LaunchProject | null; marker?: string | null }): string {
  const lines: string[] = []
  const { thread, project } = params
  if (thread !== null) {
    lines.push(
      `This chat was started with \`relay ${client}\` and has a Slack thread (channel ${thread.channel}, thread ${thread.thread}).`,
      `Post in it with: ${buildReplyCommand(thread)}`,
      client === 'claude'
        ? 'Messages people send in that thread are pushed into this chat; answer them in the thread with that command.'
        : "Messages people send in that thread reach this chat once Relay has linked it (the terminal says when); until then Relay's own loop answers them. Answer them in the thread with that command.",
    )
  }
  if (project !== null) {
    const { project: p, members } = project
    if (lines.length > 0) lines.push('')
    lines.push(`This folder belongs to the Relay project ${p.name} (folder ${p.folder}; linked repos: ${p.repos.length === 0 ? 'none' : p.repos.join(', ')}).`)
    if (members.length > 0) {
      lines.push('Its team:')
      for (const member of members) lines.push(`- ${member.name}: ${member.role}${member.isLead ? ' (lead)' : ''} (${member.client}${member.model !== null ? `, ${member.model}` : ''})`)
      lines.push('Team requests (`relay team ...`) only run inside a Slack thread Relay itself runs, not from this chat; to use the team, ask in the project channel.')
    }
  }
  if (params.marker !== undefined && params.marker !== null) {
    if (lines.length > 0) lines.push('')
    lines.push(codexMarkerLine(params.marker))
  }
  return lines.join('\n')
}

/** The opening message of the thread. */
export function openingLine(client: AccountClient, params: { account: string; cwd: string; host: string | null }): string {
  const where = params.host === null ? '' : ` on ${params.host}`
  const replies = client === 'claude' ? 'Replies here go to that chat.' : "Replies here reach that chat once Relay links it, after its first message; until then Relay's own loop answers them."
  return `Started a terminal ${client === 'claude' ? 'Claude' : 'Codex'} chat (${params.account}) in \`${params.cwd}\`${where}. ${replies}`
}

/** The real command's arguments: the user's, with the chat id and brief added in front. */
export function launchArgs(client: AccountClient, userArgs: readonly string[], params: { session: ClaudeSession | null; brief: string }): string[] {
  if (client === 'claude') {
    return [
      ...(params.session?.kind === 'new' ? ['--session-id', params.session.id] : []),
      ...(params.brief === '' ? [] : ['--append-system-prompt', params.brief]),
      ...userArgs,
    ]
  }
  // codex reads -c values as TOML; a JSON string is a valid TOML basic string.
  return [...(params.brief === '' ? [] : ['-c', `developer_instructions=${JSON.stringify(params.brief)}`]), ...userArgs]
}

/**
 * Set by a running Claude Code chat for the processes it starts. Inherited, they make the launched chat a child of
 * that one: it then never registers as a chat of its own, so Slack replies cannot be pushed into it. Measured
 * 2026-11-20 with `relay claude` run from inside a Claude Code session.
 */
const PARENT_CHAT_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
] as const

/** The chat's environment: the operator's, without an alias's login, then the stored envs, then the chosen login. */
export function launchEnv(base: NodeJS.ProcessEnv, stored: Readonly<Record<string, string>>, account: Account): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME
  for (const name of PARENT_CHAT_VARS) delete env[name]
  return { ...env, ...stored, ...account.env }
}

/** The user's arguments with any chat choice replaced by `--resume <id>`. */
export function resumeArgs(userArgs: readonly string[], id: string): string[] {
  const kept: string[] = []
  for (let index = 0; index < userArgs.length; index++) {
    const arg = userArgs[index] ?? ''
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (flag === '--session-id' || flag === '--resume' || flag === '-r') {
      if (!arg.includes('=') && UUID.test(userArgs[index + 1] ?? '')) index++
      continue
    }
    kept.push(arg)
  }
  return ['--resume', id, ...kept]
}

/** Claude's folder name for a working directory: every character outside [A-Za-z0-9] becomes '-'. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Why a Claude chat's transcript ended on a blocked login, from its last API error; null when it did not. */
export function transcriptBlockedReason(transcript: string): BlockedReason | null {
  const lines = transcript.trimEnd().split('\n').reverse()
  for (const line of lines) {
    let entry: { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    if (entry.type !== 'assistant') continue
    // Only the chat's final answer counts: an error it got past earlier is not why it stopped.
    if (entry.isApiErrorMessage !== true) return null
    const content = entry.message?.content
    const text = Array.isArray(content) ? content.map((part: { text?: unknown }) => (typeof part.text === 'string' ? part.text : '')).join(' ') : String(content ?? '')
    const reason = blockedReasonIn(text)
    return reason !== null && SWITCH_REASONS.includes(reason) ? reason : null
  }
  return null
}

/** The real folder a Claude login keeps its chats in. */
async function claudeProjectsDir(account: Account): Promise<string | null> {
  return realpath(join(account.configDir ?? join(homedir(), '.claude'), 'projects')).catch(() => null)
}

export type PreparedLaunch = {
  readonly env: Readonly<Record<string, string>>
  readonly thread: LaunchThread | null
  readonly project: LaunchProject | null
  /** Said once before the chat starts: what was and was not set up. */
  readonly notes: readonly string[]
}

export type LaunchDeps = {
  readonly client: AccountClient
  readonly bin: string
  readonly userArgs: readonly string[]
  readonly cwd: string
  readonly host: string | null
  readonly accounts: () => Promise<readonly Account[]>
  /** Opened per use and closed after, so nothing is held while the chat runs. */
  readonly withCooldowns: <T>(use: (cooldowns: CooldownStore) => Promise<T>) => Promise<T>
  readonly isCodexEligible: (account: Account) => Promise<boolean>
  /** Envs, project and thread, with the database open only inside. `attachTo` is the Claude chat id, when known. */
  readonly prepare: (params: { account: Account; attachTo: string | null; openThread: boolean }) => Promise<PreparedLaunch>
  /** Runs the chat in this terminal; `onStart` gets the chat's process id once it runs. */
  readonly run: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv, onStart?: (pid: number) => void) => Promise<number>
  readonly readTranscript: (path: string) => Promise<string | null>
  /** The real folder a Claude login keeps its chats in; defaults to the login's projects folder. */
  readonly projectsDir?: (account: Account) => Promise<string | null>
  readonly say: (text: string) => void
  readonly baseEnv: NodeJS.ProcessEnv
  readonly newId?: () => string
  /** Finding, linking and recording a Codex chat; without it a Codex chat runs unlinked and is not moved on a limit. */
  readonly codex?: CodexLaunchDeps
  /** The real sessions folder of a Codex login; defaults to the login's sessions folder. */
  readonly codexSessionsDir?: (account: Account) => Promise<string | null>
}

/** The real folder a Codex login keeps its chats in. */
async function codexSessionsDir(account: Account): Promise<string | null> {
  return realpath(join(codexHomeOf(account.configDir), 'sessions')).catch(() => null)
}

function limitName(reason: BlockedReason): string {
  return reason === 'auth' ? 'login expiry' : 'usage limit'
}

/** Runs the chat, moving it to the next free login after a usage limit or an expired login. Returns the exit code. */
export async function runLaunch(deps: LaunchDeps): Promise<number> {
  const pool = (await deps.accounts()).filter((account) => account.client === deps.client)
  const chat = opensChat(deps.client, deps.userArgs)
  // Only a chat gets a chat id and a brief: `claude mcp list --session-id ...` would fail.
  const session = deps.client === 'claude' && chat ? claudeSession(deps.userArgs, deps.newId) : null
  // A Codex chat is found by a marker in its instructions, since its id is known only once Codex saves it.
  const marker = deps.client === 'codex' && chat && deps.codex !== undefined ? `relay-${(deps.newId ?? randomUUID)()}` : null
  const launchedAt = Date.now()
  let watch: CodexChatWatch | null = null
  const tried: string[] = []
  let prepared: PreparedLaunch | null = null
  let args = [...deps.userArgs]
  let first = true
  for (;;) {
    const choice = await deps.withCooldowns((cooldowns) => chooseAccount(pool, { cooldowns, isCodexEligible: deps.isCodexEligible, exclude: tried }))
    if (choice.kind === 'none') {
      const when = choice.wakeAtMs === null ? '' : ` The first frees up at ${new Date(choice.wakeAtMs).toLocaleTimeString()}.`
      deps.say(`No ${deps.client} login can start a chat now: ${tried.length > 0 ? `tried ${tried.join(', ')}; the rest are` : 'every one is'} cooling down${deps.client === 'codex' ? ' or not proven by relay doctor' : ''}.${when}`)
      return 1
    }
    const account = choice.account
    tried.push(account.key)
    if (prepared === null) {
      prepared = await deps.prepare({ account, attachTo: session !== null && session.kind !== 'unknown' ? session.id : null, openThread: chat })
      for (const note of prepared.notes) deps.say(note)
    }
    deps.say(`Starting ${deps.client} on ${account.key}.`)
    const brief = chat ? chatBrief(deps.client, { thread: prepared.thread, project: prepared.project, marker }) : ''
    if (marker !== null && deps.codex !== undefined && watch === null) {
      watch = new CodexChatWatch(deps.codex, { marker, sinceMs: launchedAt - 1_000, thread: prepared.thread, knownChat: codexChatFromArgs(deps.userArgs), say: deps.say })
    }
    const running = watch
    const onStart = running === null ? undefined : (pid: number) => running.start(pid, codexHomeOf(account.configDir), account.key)
    let code: number
    try {
      code = await deps.run(deps.bin, launchArgs(deps.client, args, { session: first ? session : null, brief }), launchEnv(deps.baseEnv, prepared.env, account), onStart)
    } finally {
      await running?.stop()
    }
    first = false

    if (deps.client === 'codex') {
      if (running === null || deps.codex === undefined) return code
      const chatId = running.chatId
      if (chatId === null) {
        if (code !== 0) deps.say(`${account.key} exited before Codex saved the chat, so there is no chat to resume on another login. If its login expired, run relay codex again.`)
        return code
      }
      // Only this run's own turns count: a resumed chat may already end on an old limit.
      const reason = await running.blockedThisRun()
      if (reason === null) return code
      const next = await moveOn(deps, pool, tried, account, reason, deps.codexSessionsDir ?? codexSessionsDir)
      if (next !== 'resume') {
        if (next === 'no_login') deps.say(`Resume it later with: relay codex resume ${chatId}`)
        return code
      }
      args = codexResumeArgs(deps.userArgs, chatId)
      continue
    }

    if (deps.client !== 'claude' || session === null || session.kind === 'unknown') return code
    const transcript = await deps.readTranscript(join(account.configDir ?? join(homedir(), '.claude'), 'projects', claudeProjectSlug(deps.cwd), `${session.id}.jsonl`))
    const reason = transcript === null ? null : transcriptBlockedReason(transcript)
    if (reason === null) return code
    const next = await moveOn(deps, pool, tried, account, reason, deps.projectsDir ?? claudeProjectsDir)
    if (next !== 'resume') {
      if (next === 'no_login') deps.say(`Resume it later with: relay claude --resume ${session.id}`)
      return code
    }
    args = resumeArgs(deps.userArgs, session.id)
  }
}

/**
 * After a limit: cools the login down and checks the next free login keeps
 * its chats in the same folder, so the chat can resume there. Otherwise says
 * why it cannot move and whether a later resume can work.
 */
async function moveOn(
  deps: LaunchDeps,
  pool: readonly Account[],
  tried: readonly string[],
  account: Account,
  reason: BlockedReason,
  chatsDir: (account: Account) => Promise<string | null>,
): Promise<'resume' | 'no_login' | 'elsewhere'> {
  await deps.withCooldowns((cooldowns) => cooldowns.coolDown(account.key, Date.now() + COOLDOWN_MS[reason]))
  const next = await deps.withCooldowns((cooldowns) => chooseAccount(pool, { cooldowns, isCodexEligible: deps.isCodexEligible, exclude: tried }))
  const name = deps.client === 'claude' ? 'Claude' : 'Codex'
  if (next.kind === 'none') {
    deps.say(`${account.key} hit its ${limitName(reason)} and no other ${name} login is free.`)
    return 'no_login'
  }
  const here = await chatsDir(account)
  if (here === null || (await chatsDir(next.account)) !== here) {
    deps.say(`${account.key} hit its ${limitName(reason)}, and ${next.account.key} keeps its chats elsewhere, so this chat cannot move there. Start a new one with: relay ${deps.client}`)
    return 'elsewhere'
  }
  deps.say(`${account.key} hit its ${limitName(reason)}; resuming this chat on the next free login.`)
  return 'resume'
}

/** Runs `bin args` in this terminal and resolves with its exit code. */
export function runInTerminal(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, onStart?: (pid: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('spawn', () => {
      if (child.pid !== undefined) onStart?.(child.pid)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)))
  })
}

export async function readIfPresent(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

export type RelayPrepareDeps = {
  readonly client: AccountClient
  readonly cwd: string
  readonly host: string | null
  /** launcher.dm_to from this laptop's config. */
  readonly dmTo: string | undefined
  readonly openPool: () => Promise<Pool>
  readonly closePool: (pool: Pool) => Promise<void>
  readonly secrets: SecretProvider
  readonly repos: () => readonly string[]
}

/**
 * Reads the envs, the folder's project and team, and opens the thread, with
 * the database open only for this. A stored env that cannot be read here
 * throws, so the chat never starts without an env it was meant to have; a
 * thread that cannot be opened is only a note.
 */
export function relayPrepare(deps: RelayPrepareDeps): LaunchDeps['prepare'] {
  return async ({ account, attachTo, openThread }) => {
    const notes: string[] = []
    const pool = await deps.openPool()
    try {
      const workspaceId = await slackWorkspaceId(pool)
      const repos = deps.repos()
      const place = { host: deps.host, cwd: deps.cwd, home: homedir(), homes: await knownHomes(pool), repos }
      // The keystore is read only when an env applies here: macOS asks before a command reads it.
      const winners = await storedWinners({ pool, workspaceId, key: null }, place)
      const env = winners.length === 0 ? {} : (await resolveWorkerEnv({ pool, workspaceId, key: await readReaderKey(deps.secrets) }, place, {})).env
      if (winners.length > 0) notes.push(`Stored envs for this folder: ${winners.map((entry) => entry.name).join(', ')}.`)

      const found = await projectForFolder(pool, workspaceId, deps.cwd, repos)
      const project = found === undefined ? null : { project: found, members: await listMembers(pool, workspaceId, found.id) }

      if (!openThread) return { env, thread: null, project, notes }
      const opened = await openThreadFor(pool, workspaceId, deps, { account, attachTo, project })
      notes.push(opened.note)
      return { env, thread: opened.thread, project, notes }
    } finally {
      await deps.closePool(pool)
    }
  }
}

/**
 * Linking and thread notes for a Codex chat, each opening the database only
 * for its own query: the chat may run for hours, and holds no connection.
 */
export function relayCodexLink(deps: RelayPrepareDeps): Pick<CodexLaunchDeps, 'link' | 'noteInThread'> {
  const withPool = async <T>(use: (pool: Pool, workspaceId: string) => Promise<T>): Promise<T> => {
    const pool = await deps.openPool()
    try {
      return await use(pool, await slackWorkspaceId(pool))
    } finally {
      await deps.closePool(pool)
    }
  }
  return {
    link: (thread, chatId) =>
      withPool(async (pool, workspaceId) =>
        linkCodexChat(pool, { workspaceId, owner: await laptopOwner(pool, workspaceId, deps.dmTo), thread, chatId, cwd: deps.cwd, host: deps.host }),
      ),
    noteInThread: (thread, text) => withPool((pool, workspaceId) => postInThread(pool, workspaceId, thread, text)),
  }
}

/** Opens the chat's thread; a thread that cannot be opened is a note, never a failed start. */
async function openThreadFor(
  pool: Pool,
  workspaceId: string,
  deps: RelayPrepareDeps,
  params: { account: Account; attachTo: string | null; project: LaunchProject | null },
): Promise<{ thread: LaunchThread | null; note: string }> {
  const { account, attachTo, project } = params
  let thread: LaunchThread | null
  try {
    thread = await openLinkedThread(pool, {
      workspaceId,
      owner: await laptopOwner(pool, workspaceId, deps.dmTo),
      ...(project !== null ? { channel: project.project.slackChannel } : {}),
      text: openingLine(deps.client, { account: account.key, cwd: deps.cwd, host: deps.host }),
      ...(deps.client === 'claude' && attachTo !== null ? { attach: { engineSessionId: attachTo, cwd: deps.cwd, ...(deps.host !== null ? { host: deps.host } : {}) } } : {}),
      sendWaitMs: THREAD_WAIT_MS,
    })
  } catch (error) {
    if (!(error instanceof NotifyError)) throw error
    return { thread: null, note: `No Slack thread: ${error.message}` }
  }
  if (thread === null) return { thread, note: `No Slack thread: the Relay daemon did not post within ${THREAD_WAIT_MS / 1000} seconds, so this chat runs without one.` }
  const unlinked = deps.client === 'claude' && attachTo === null ? "; it is not linked, because this chat's id is not known before it starts" : ''
  return { thread, note: `Slack thread opened in ${project !== null ? `the ${project.project.name} channel` : 'your DM'}${unlinked}.` }
}
