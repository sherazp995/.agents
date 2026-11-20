/**
 * `relay claude` and `relay codex`: the operator's own terminal chat, started
 * the way Relay starts its Slack sessions. It runs on a login that is not
 * cooling down, with the stored envs for this laptop and folder, is told about
 * the folder's project and team, and gets a Slack thread: in the project's
 * channel when the folder belongs to one, otherwise in the laptop owner's DM.
 *
 * A Claude chat is attached to its thread (replies are pushed into it, as for
 * `relay notify`), and when it exits on a usage limit or an expired login it
 * resumes on the next free login. A Codex chat can post in its thread; replies
 * there go to Relay's own loop, and on a limit the resume command is printed.
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
import { blockedReasonIn, chooseAccount, COOLDOWN_MS, type Account, type AccountClient, type BlockedReason, type CooldownStore } from '../autonomous/accounts.js'
import { knownHomes } from '../failover/paths.js'
import { buildReplyCommand } from '../live/control.js'
import { listMembers, projectForFolder, type Project, type TeamMember } from '../projects/store.js'
import type { SecretProvider } from '../secrets/provider.js'
import { readReaderKey } from '../worker-env/keys.js'
import { resolveWorkerEnv, storedWinners } from '../worker-env/resolve.js'
import { laptopOwner, NotifyError, openLinkedThread, slackWorkspaceId } from './notify.js'

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
export function chatBrief(client: AccountClient, params: { thread: LaunchThread | null; project: LaunchProject | null }): string {
  const lines: string[] = []
  const { thread, project } = params
  if (thread !== null) {
    lines.push(
      `This chat was started with \`relay ${client}\` and has a Slack thread (channel ${thread.channel}, thread ${thread.thread}).`,
      `Post in it with: ${buildReplyCommand(thread)}`,
      client === 'claude'
        ? 'Messages people send in that thread are pushed into this chat; answer them in the thread with that command.'
        : "Messages people send in that thread do not reach this chat; Relay's own loop answers them.",
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
  return lines.join('\n')
}

/** The opening message of the thread. */
export function openingLine(client: AccountClient, params: { account: string; cwd: string; host: string | null }): string {
  const where = params.host === null ? '' : ` on ${params.host}`
  const replies = client === 'claude' ? 'Replies here go to that chat.' : "Replies here are answered by Relay's own loop, not by the terminal chat."
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

/** The chat's environment: the operator's, without an alias's login, then the stored envs, then the chosen login. */
export function launchEnv(base: NodeJS.ProcessEnv, stored: Readonly<Record<string, string>>, account: Account): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME
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
  readonly run: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>
  readonly readTranscript: (path: string) => Promise<string | null>
  /** The real folder a Claude login keeps its chats in; defaults to the login's projects folder. */
  readonly projectsDir?: (account: Account) => Promise<string | null>
  readonly say: (text: string) => void
  readonly baseEnv: NodeJS.ProcessEnv
  readonly newId?: () => string
}

/** Runs the chat, moving to the next login after a limit (Claude) or printing how to (Codex). Returns the exit code. */
export async function runLaunch(deps: LaunchDeps): Promise<number> {
  const pool = (await deps.accounts()).filter((account) => account.client === deps.client)
  const chat = opensChat(deps.client, deps.userArgs)
  // Only a chat gets a chat id and a brief: `claude mcp list --session-id ...` would fail.
  const session = deps.client === 'claude' && chat ? claudeSession(deps.userArgs, deps.newId) : null
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
    const brief = chat ? chatBrief(deps.client, { thread: prepared.thread, project: prepared.project }) : ''
    const code = await deps.run(deps.bin, launchArgs(deps.client, args, { session: first ? session : null, brief }), launchEnv(deps.baseEnv, prepared.env, account))
    first = false

    if (deps.client !== 'claude' || session === null || session.kind === 'unknown') return code
    const transcript = await deps.readTranscript(join(account.configDir ?? join(homedir(), '.claude'), 'projects', claudeProjectSlug(deps.cwd), `${session.id}.jsonl`))
    const reason = transcript === null ? null : transcriptBlockedReason(transcript)
    if (reason === null) return code
    await deps.withCooldowns((cooldowns) => cooldowns.coolDown(account.key, Date.now() + COOLDOWN_MS[reason]))
    const next = await deps.withCooldowns((cooldowns) => chooseAccount(pool, { cooldowns, isCodexEligible: deps.isCodexEligible, exclude: tried }))
    if (next.kind === 'none') {
      deps.say(`${account.key} hit its ${reason === 'auth' ? 'login expiry' : 'usage limit'} and no other Claude login is free. Resume later with: relay claude --resume ${session.id}`)
      return code
    }
    // A chat resumes only on a login that keeps its chats in the same folder.
    const projectsDir = deps.projectsDir ?? claudeProjectsDir
    const here = await projectsDir(account)
    if (here === null || (await projectsDir(next.account)) !== here) {
      deps.say(`${account.key} hit its ${reason === 'auth' ? 'login expiry' : 'usage limit'}, and ${next.account.key} keeps its chats elsewhere, so this chat cannot move there. Start a new one with: relay claude`)
      return code
    }
    deps.say(`${account.key} hit its ${reason === 'auth' ? 'login expiry' : 'usage limit'}; resuming this chat on the next free login.`)
    args = resumeArgs(deps.userArgs, session.id)
  }
}

/** Runs `bin args` in this terminal and resolves with its exit code. */
export function runInTerminal(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', env })
    child.on('error', reject)
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
