/**
 * The autonomous guard (plan step 8): the one decision every autonomous
 * worker's shell call (claude and codex, through scripts/hook-pretooluse.ts
 * and the hook bridge) and MCP call (through the MCP gateway) reaches.
 *
 * Order of checks, each one denying on its own: malformed request; no
 * per-invocation token; kill switch engaged; task gone or cancel requested;
 * the token's invocation or lease generation is no longer the task's
 * current one. Then a shell call's git commands go through
 * `checkGitOperation` (src/repos/git-safety.ts), and an MCP call is allowed
 * only for a read-only tool or a proxy-enforced server; anything else
 * becomes a durable operation waiting for the requester's approval.
 *
 * Every dependency failure throws out of here, and the bridge turns a throw
 * (or a slow answer) into deny. Nothing in this file allows by default.
 *
 * WHAT THE SHELL PARSE IS, AND IS NOT. It reads the command as a shell
 * would (quotes, separators, `$(...)`, backticks, `sh -c` and `eval`) well
 * enough that an ordinary `git merge` or `git push` cannot slip through by
 * quoting or chaining. It is not a boundary against a worker that hides
 * git behind an interpreter (`python -c`), a script file it wrote, or an
 * alias in a repo config it edited: the worker holds no write credentials,
 * which is what stops an unapproved push, and the guard is the cheap layer
 * in front of that, per the plan's "Remote writes".
 */

import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { Policy } from '../config/schema.js'
import type { HookDecisionRequest, HookDecisionResult } from '../engine/hook-bridge.js'
import type { KillSwitch } from '../killswitch.js'
import { checkGitOperation } from '../repos/git-safety.js'
import type { InvocationContext, McpCallDecision, McpCallRequest, McpOperations } from './mcp-protocol.js'
import type { AutonomousTask } from './store.js'

export type RemoteWritesPolicy = NonNullable<Policy['remote_writes']>

export type GuardDeps = {
  loadTask(taskId: string): Promise<AutonomousTask | undefined>
  /** Whether `invocationId` is an invocation of `taskId` still in state `started`. */
  isInvocationCurrent(taskId: string, invocationId: string): Promise<boolean>
  /** Re-reads the durable kill switch; see `killSwitchCheck`. A rejection denies. */
  isKillSwitchEngaged(): Promise<boolean>
  operations: McpOperations
  /** Read per call, so a policy reload applies to the next call. */
  remoteWrites(): Policy['remote_writes']
  /** QA checkouts relay created for this task; only those under `<relayHome>/tasks/<task id>/qa/` count. */
  qaCheckouts(taskId: string): Promise<string[]>
  /** The default branch of the task's repository, for `checkGitOperation`'s protected-branch rule. */
  defaultBranch(task: AutonomousTask): Promise<string>
  relayHome: string
}

export type AutonomousGuard = {
  decide(request: HookDecisionRequest, context: InvocationContext | undefined): Promise<HookDecisionResult>
  decideMcpCall(call: McpCallRequest, context: InvocationContext | undefined, signal?: AbortSignal): Promise<McpCallDecision>
}

/** The kill switch as the guard reads it: the durable state, so an engage from the CLI applies to the very next call. */
export function killSwitchCheck(killSwitch: Pick<KillSwitch, 'refresh'>): () => Promise<boolean> {
  return async () => (await killSwitch.refresh()).engaged
}

/** `isInvocationCurrent` on autonomous_invocations. */
export function currentInvocationLookup(pool: Pool): GuardDeps['isInvocationCurrent'] {
  return async (taskId, invocationId) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM autonomous_invocations WHERE id = $1 AND task_id = $2 AND state = 'started'`,
      [invocationId, taskId],
    )
    return rows.length === 1
  }
}

const requestSchema = z
  .object({
    toolUseId: z.string().trim().min(1),
    toolName: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    cwd: z.string().optional(),
    toolInput: z.unknown().optional(),
  })
  .passthrough()

const shellInputSchema = z.object({ command: z.string().min(1), workdir: z.string().optional() }).passthrough()

type Denial = { decision: 'deny'; reason: string }
const deny = (reason: string): Denial => ({ decision: 'deny', reason })

export function createAutonomousGuard(deps: GuardDeps): AutonomousGuard {
  /** The checks every call passes first; the task when they all pass. */
  async function admit(context: InvocationContext | undefined): Promise<{ task: AutonomousTask; context: InvocationContext } | Denial> {
    if (context === undefined) return deny('this call carries no per-invocation token; autonomous calls need one')
    if (await deps.isKillSwitchEngaged()) return deny('the relay kill switch is engaged')
    const task = await deps.loadTask(context.taskId)
    if (task === undefined || task.workspaceId !== context.workspaceId) return deny('the task for this token no longer exists')
    if (task.cancelRequestedAt !== null) return deny('the task was stopped; finish without running anything else')
    if (task.leaseGeneration !== context.leaseGeneration) return deny('this worker was superseded (stale lease generation)')
    if (!(await deps.isInvocationCurrent(task.id, context.invocationId))) {
      return deny('this worker invocation is no longer the current one for its task')
    }
    return { task, context }
  }

  async function decide(request: HookDecisionRequest, context: InvocationContext | undefined): Promise<HookDecisionResult> {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) return deny('malformed hook decision request')
    const admitted = await admit(context)
    if ('decision' in admitted) return admitted
    if (parsed.data.toolName !== 'Bash') return deny(`the autonomous hook governs Bash only, not ${parsed.data.toolName}`)
    const input = shellInputSchema.safeParse(parsed.data.toolInput)
    if (!input.success) return deny('malformed Bash tool input: no command')
    const verdict = await checkShellCommand(input.data.command, {
      task: admitted.task,
      workdir: shellDirectory(input.data.workdir, parsed.data.cwd),
    })
    return verdict ?? { decision: 'allow', reason: 'no blocked git operation in this command' }
  }

  /** Undefined when the command holds no blocked git operation, else the denial. */
  async function checkShellCommand(command: string, at: { task: AutonomousTask; workdir: string | undefined }): Promise<Denial | undefined> {
    const analysis = analyseShell(command)
    if ('error' in analysis) return deny(`could not parse this command (${analysis.error}); rewrite it plainly`)
    if (analysis.invocations.length === 0) return undefined
    const defaultBranch = await deps.defaultBranch(at.task)
    for (const invocation of analysis.invocations) {
      if (invocation.error !== undefined) return deny(`could not tell what this git command does: ${invocation.error}`)
      const subcommand = invocation.subcommand
      if (subcommand === undefined) continue
      if (invocation.subcommandDynamic || (invocation.dynamic && SENSITIVE_SUBCOMMANDS.has(subcommand))) {
        return deny(`\`git ${subcommand}\` with a variable or substituted argument cannot be checked; write the values out`)
      }
      const decision = checkGitOperation(subcommand, invocation.args, defaultBranch)
      if (decision.allowed) continue
      if (subcommand === 'merge' && (await isQaMerge(invocation, analysis, at))) continue
      return deny(decision.reason)
    }
    return undefined
  }

  /** The one merge relay allows: `git merge --no-commit --no-ff` inside a QA checkout registered for this task. */
  async function isQaMerge(invocation: GitInvocation, analysis: ShellAnalysis, at: { task: AutonomousTask; workdir: string | undefined }): Promise<boolean> {
    if (invocation.nested || invocation.dynamic || invocation.relocated || analysis.relocatesGit) return false
    const flags = invocation.args.filter((argument) => argument.startsWith('-'))
    if (!flags.includes('--no-commit') || !flags.includes('--no-ff')) return false
    if (flags.some((flag) => !QA_MERGE_FLAGS.has(flag))) return false
    const target = await mergeTarget(invocation, analysis, at.workdir)
    if (target === undefined) return false
    const qaRoot = await realpathOrUndefined(resolve(deps.relayHome, 'tasks', at.task.id, 'qa'))
    if (qaRoot === undefined) return false
    for (const checkout of await deps.qaCheckouts(at.task.id)) {
      const real = await realpathOrUndefined(checkout)
      if (real === undefined || !isInside(real, qaRoot) || real === qaRoot) continue
      if (target === real || isInside(target, real)) return true
    }
    return false
  }

  async function decideMcpCall(call: McpCallRequest, context: InvocationContext | undefined, signal?: AbortSignal): Promise<McpCallDecision> {
    if (typeof call?.server !== 'string' || call.server === '' || typeof call.tool !== 'string' || call.tool === '') {
      return deny('malformed MCP call')
    }
    const admitted = await admit(context)
    if ('decision' in admitted) return admitted
    const policy = deps.remoteWrites()
    if (isReadOnlyMcpTool(call, policy) || (policy?.proxy_enforced_mcp_servers ?? []).includes(call.server)) {
      return { decision: 'allow' }
    }
    // The bridge already answered deny: creating or claiming an operation now would leave state the gateway never saw.
    if (signal?.aborted === true) return deny('the decision exceeded its deadline')
    const answer = await deps.operations.requestMcpOperation(admitted.context, call, signal)
    if (answer.kind === 'pending') {
      return {
        decision: 'pending',
        operationId: answer.operationId,
        message: `operation ${answer.operationId} needs the requester's approval in the thread; continue other work`,
      }
    }
    if (answer.kind === 'execute') return { decision: 'execute', operationId: answer.operationId, args: answer.args }
    return deny(answer.reason)
  }

  return { decide, decideMcpCall }
}

/**
 * `remote_writes.read_only_mcp_tools` entries are `server/tool`, naming one
 * tool on one server. A bare `tool` matches nothing: a tool name alone says
 * nothing about which server, and so which side effects, it reaches.
 */
export function isReadOnlyMcpTool(call: McpCallRequest, policy: Policy['remote_writes']): boolean {
  return (policy?.read_only_mcp_tools ?? []).some((entry) => entry === `${call.server}/${call.tool}`)
}

/** Entries the guard ignores because they are not `server/tool`; for the doctor to report. */
export function ignoredReadOnlyMcpEntries(policy: Policy['remote_writes']): string[] {
  return (policy?.read_only_mcp_tools ?? []).filter((entry) => !/^[^/]+\/[^/]+$/.test(entry))
}

/** The subcommands `checkGitOperation` can refuse: with a variable argument the refusal cannot be ruled out. */
const SENSITIVE_SUBCOMMANDS = new Set(['push', 'merge', 'rebase', 'reset', 'clean', 'filter-branch', 'filter-repo'])
const QA_MERGE_FLAGS = new Set(['--no-commit', '--no-ff', '--no-edit', '-q', '--quiet'])

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/** Where the shell runs: codex's `tool_input.workdir` (relative to the session cwd when relative), else the session cwd. */
function shellDirectory(workdir: string | undefined, cwd: string | undefined): string | undefined {
  const base = cwd !== undefined && isAbsolute(cwd) ? cwd : undefined
  if (workdir === undefined || workdir === '') return base
  if (isAbsolute(workdir)) return workdir
  return base !== undefined ? resolve(base, workdir) : undefined
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/**
 * The directory a top-level merge acts in: the realpath of its last `-C`,
 * resolved against a leading `cd <dir> &&` chain, else the shell's workdir
 * or the session cwd. Undefined (deny) when any step is not a plain path.
 */
async function mergeTarget(invocation: GitInvocation, analysis: ShellAnalysis, workdir: string | undefined): Promise<string | undefined> {
  let base = workdir
  if (analysis.cdSegments.some((index) => index !== 0 && index <= invocation.segment)) return undefined
  if (analysis.cdSegments.includes(0)) {
    const cd = analysis.segments[0]
    const dir = cd?.words[1]
    if (cd?.words[0]?.text !== 'cd' || dir === undefined || cd.words.length !== 2 || dir.dynamic || dir.text.startsWith('-')) return undefined
    // If the cd fails, anything not chained to it with && runs in the old directory.
    for (let index = 0; index < invocation.segment; index += 1) {
      if (analysis.segments[index]?.separator !== '&&') return undefined
    }
    base = isAbsolute(dir.text) ? dir.text : base !== undefined ? resolve(base, dir.text) : undefined
  }
  let target = base
  for (const dir of invocation.dirs) {
    target = isAbsolute(dir) ? dir : target !== undefined ? resolve(target, dir) : undefined
  }
  return target === undefined ? undefined : realpathOrUndefined(target)
}

// ---------------------------------------------------------------------------
// Shell reading: just enough of POSIX sh to find every git invocation.
// ---------------------------------------------------------------------------

type Word = { text: string; quoted: boolean; dynamic: boolean }
type Segment = { words: Word[]; separator: string }

export type GitInvocation = {
  subcommand: string | undefined
  args: string[]
  /** `-C` directories in order. */
  dirs: string[]
  /** `--git-dir`, `--work-tree` and the like: the repository is not where the directory says. */
  relocated: boolean
  /** A word in the invocation holds an expansion relay cannot evaluate. */
  dynamic: boolean
  /** The subcommand word itself is such an expansion. */
  subcommandDynamic: boolean
  /** Found inside `$(...)`, backticks, `sh -c` or `eval`. */
  nested: boolean
  /** Index of its top-level segment (nested ones: -1). */
  segment: number
  error?: string
}

export type ShellAnalysis = {
  segments: Segment[]
  invocations: GitInvocation[]
  /** Top-level segments that change directory. */
  cdSegments: number[]
  /** The command sets GIT_DIR or a sibling, or groups commands in a subshell. */
  relocatesGit: boolean
}

const MAX_NESTING = 8
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const DIRECTORY_CHANGERS = new Set(['cd', 'pushd', 'popd'])
/** git's global options that take the next word as their value. */
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
const GLOBAL_RELOCATING = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--bare'])
const GLOBAL_FLAGS = new Set([
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
  '--version',
  '--help',
  '-h',
])

export function analyseShell(command: string): ShellAnalysis | { error: string } {
  const top = tokenize(command)
  if ('error' in top) return top
  const invocations: GitInvocation[] = []
  const pending: { text: string; depth: number }[] = top.nested.map((text) => ({ text, depth: 1 }))
  top.segments.forEach((segment, index) => {
    invocations.push(...gitInvocations(segment, index, false))
    pending.push(...innerCommands(segment).map((text) => ({ text, depth: 1 })))
  })
  while (pending.length > 0) {
    const next = pending.shift()
    if (next === undefined) break
    if (next.depth > MAX_NESTING) return { error: 'commands nested too deeply' }
    const inner = tokenize(next.text)
    if ('error' in inner) return inner
    pending.push(...inner.nested.map((text) => ({ text, depth: next.depth + 1 })))
    for (const segment of inner.segments) {
      invocations.push(...gitInvocations(segment, -1, true))
      pending.push(...innerCommands(segment).map((text) => ({ text, depth: next.depth + 1 })))
    }
  }
  const cdSegments = top.segments.flatMap((segment, index) => (DIRECTORY_CHANGERS.has(segment.words[0]?.text ?? '') ? [index] : []))
  return {
    segments: top.segments,
    invocations,
    cdSegments,
    relocatesGit: top.grouped || /\bGIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE)\b/.test(command),
  }
}

/** Strings a segment hands to a shell to run: `sh -c '<string>'` and `eval <words>`. */
function innerCommands(segment: Segment): string[] {
  const found: string[] = []
  segment.words.forEach((word, index) => {
    if (word.text === 'eval') found.push(segment.words.slice(index + 1).map((rest) => rest.text).join(' '))
    if (!SHELLS.has(basename(word.text))) return
    const flag = segment.words.slice(index + 1).findIndex((rest) => /^-[a-z]*c[a-z]*$/.test(rest.text))
    const script = flag === -1 ? undefined : segment.words[index + 1 + flag + 1]
    if (script !== undefined) found.push(script.text)
  })
  return found
}

/**
 * `-c` and `--config-env` keys a command line may set. Deny by default: many
 * keys run a program (core.sshCommand, core.pager, credential.helper,
 * diff.external, filter.*, *.textconv, alias.*, ...), and listing the
 * harmless ones is shorter than listing those.
 */
const ALLOWED_CONFIG_KEYS = new Set([
  'user.name',
  'user.email',
  'core.quotepath',
  'core.abbrev',
  'core.autocrlf',
  'core.safecrlf',
  'color.ui',
  'commit.gpgsign',
  'tag.gpgsign',
  'init.defaultbranch',
  'merge.conflictstyle',
  'diff.renames',
  'log.showsignature',
  'safe.directory',
  'protocol.version',
])
const ALLOWED_CONFIG_PREFIXES = ['color.', 'advice.']

function isAllowedConfigKey(assignment: string): boolean {
  const key = (assignment.split('=')[0] ?? '').toLowerCase()
  return ALLOWED_CONFIG_KEYS.has(key) || ALLOWED_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix) && !key.includes('.', prefix.length))
}

/**
 * Every word that is `git` (or a path ending in `/git`) starts an invocation
 * running to the end of its segment, whatever precedes it: a wrapper like
 * `xargs`, `env` or `sudo` cannot hide one, `echo git push` reads as a push,
 * and in `xargs git log git merge` both are read, which is the safe mistake
 * to make.
 */
function gitInvocations(segment: Segment, index: number, nested: boolean): GitInvocation[] {
  return segment.words.flatMap((word, start) =>
    word.text === 'git' || word.text.endsWith('/git') ? [parseGit(segment.words.slice(start + 1), index, nested)] : [],
  )
}

function parseGit(words: Word[], segment: number, nested: boolean): GitInvocation {
  const invocation: GitInvocation = {
    subcommand: undefined,
    args: [],
    dirs: [],
    relocated: false,
    dynamic: words.some((word) => word.dynamic),
    subcommandDynamic: false,
    nested,
    segment,
  }
  let position = 0
  while (position < words.length) {
    const word = words[position]?.text ?? ''
    if (!word.startsWith('-')) break
    const [name = '', inlineValue] = word.split(/=(.*)/s, 2)
    if (GLOBAL_FLAGS.has(word)) {
      position += 1
      continue
    }
    if (!GLOBAL_WITH_VALUE.has(name) && !GLOBAL_RELOCATING.has(name)) {
      return { ...invocation, error: `unknown git option ${word}` }
    }
    if (GLOBAL_RELOCATING.has(name)) invocation.relocated = true
    const takesValue = GLOBAL_WITH_VALUE.has(name) && inlineValue === undefined
    const value = takesValue ? words[position + 1]?.text : inlineValue
    if (GLOBAL_WITH_VALUE.has(name) && value === undefined) return { ...invocation, error: `git option ${name} without a value` }
    if (name === '-C' && value !== undefined) invocation.dirs.push(value)
    if ((name === '-c' || name === '--config-env') && value !== undefined && !isAllowedConfigKey(value)) {
      return { ...invocation, error: `git ${name} ${value.split('=')[0] ?? ''} is not on relay's list of harmless config keys` }
    }
    position += takesValue ? 2 : 1
  }
  invocation.subcommand = words[position]?.text
  invocation.subcommandDynamic = words[position]?.dynamic ?? false
  invocation.args = words.slice(position + 1).map((word) => word.text)
  return invocation
}

type Tokens = { segments: Segment[]; nested: string[]; grouped: boolean }

/**
 * Splits a command into segments at `;`, `&`, `|`, `&&`, `||`, newlines and
 * parentheses, honouring quotes and backslashes, and collects every
 * `$(...)`, `<(...)`, `>(...)` and backtick body for a separate pass.
 * Redirections and their targets are dropped. An unterminated quote or
 * substitution is an error, never a guess.
 */
function tokenize(command: string): Tokens | { error: string } {
  const segments: Segment[] = []
  const nested: string[] = []
  let grouped = false
  let words: Word[] = []
  let current: Word | undefined
  let dropNextWord = false

  const word = (): Word => (current ??= { text: '', quoted: false, dynamic: false })
  const endWord = (): void => {
    if (current !== undefined) {
      if (dropNextWord) dropNextWord = false
      else words.push(current)
    }
    current = undefined
  }
  const endSegment = (separator: string): void => {
    endWord()
    if (words.length > 0) segments.push({ words, separator })
    else if (separator !== '' && segments.length > 0) {
      const last = segments[segments.length - 1]
      if (last !== undefined) last.separator = separator
    }
    words = []
  }
  /** Reads a `$(`-style body from `start` (just past the opening paren) to its matching close; returns the index after it. */
  const readParenBody = (start: number): number | undefined => {
    let depth = 1
    let quote: string | undefined
    for (let index = start; index < command.length; index += 1) {
      const char = command[index]
      if (quote !== undefined) {
        if (char === '\\' && quote === '"') index += 1
        else if (char === quote) quote = undefined
        continue
      }
      if (char === '\\') index += 1
      else if (char === "'" || char === '"') quote = char
      else if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          nested.push(command.slice(start, index))
          return index + 1
        }
      }
    }
    return undefined
  }
  const readBackticks = (start: number): number | undefined => {
    const end = command.indexOf('`', start)
    if (end === -1) return undefined
    nested.push(command.slice(start, end))
    return end + 1
  }

  let index = 0
  while (index < command.length) {
    const char = command[index] ?? ''
    const next = command[index + 1] ?? ''
    if (char === '\\') {
      if (next === '\n') {
        index += 2
        continue
      }
      word().text += next
      index += 2
      continue
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1)
      if (end === -1) return { error: 'unterminated single quote' }
      const target = word()
      target.text += command.slice(index + 1, end)
      target.quoted = true
      index = end + 1
      continue
    }
    if (char === '"') {
      const target = word()
      target.quoted = true
      index += 1
      let closed = false
      while (index < command.length) {
        const inner = command[index] ?? ''
        if (inner === '"') {
          closed = true
          index += 1
          break
        }
        if (inner === '\\' && '"\\$`\n'.includes(command[index + 1] ?? '')) {
          target.text += command[index + 1]
          index += 2
          continue
        }
        if (inner === '$' && command[index + 1] === '(') {
          const after = readParenBody(index + 2)
          if (after === undefined) return { error: 'unterminated $(' }
          target.dynamic = true
          index = after
          continue
        }
        if (inner === '`') {
          const after = readBackticks(index + 1)
          if (after === undefined) return { error: 'unterminated backtick' }
          target.dynamic = true
          index = after
          continue
        }
        if (inner === '$') target.dynamic = true
        target.text += inner
        index += 1
      }
      if (!closed) return { error: 'unterminated double quote' }
      continue
    }
    if ((char === '$' || char === '<' || char === '>') && next === '(') {
      const after = readParenBody(index + 2)
      if (after === undefined) return { error: `unterminated ${char}(` }
      if (char !== '$') endWord()
      word().dynamic = true
      index = after
      continue
    }
    if (char === '`') {
      const after = readBackticks(index + 1)
      if (after === undefined) return { error: 'unterminated backtick' }
      word().dynamic = true
      index = after
      continue
    }
    if (char === '>' || char === '<') {
      // `2>&1`, `> out`, `<<EOF`: the fd number and the target are not arguments.
      if (current !== undefined && /^\d+$/.test(current.text) && !current.quoted) current = undefined
      endWord()
      index += 1
      while (command[index] === '>' || command[index] === '<' || command[index] === '&' || command[index] === '|') index += 1
      if (/\d/.test(command[index] ?? '') && command[index - 1] === '&') {
        while (/\d|-/.test(command[index] ?? '')) index += 1
        continue
      }
      dropNextWord = true
      continue
    }
    if (char === '&' || char === '|' || char === ';' || char === '\n') {
      const double = (char === '&' || char === '|' || char === ';') && next === char
      endSegment(double ? char + char : char)
      index += double ? 2 : 1
      continue
    }
    if (char === '(' || char === ')') {
      grouped = true
      endSegment(';')
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord()
      index += 1
      continue
    }
    const target = word()
    if (char === '$' || '*?['.includes(char) || (char === '~' && target.text === '')) target.dynamic = true
    target.text += char
    index += 1
  }
  endSegment('')
  return { segments, nested, grouped }
}
