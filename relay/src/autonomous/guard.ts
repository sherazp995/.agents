/**
 * The guard hook for Slack chats: relay's one check on a worker's shell
 * calls (claude and codex, through scripts/hook-pretooluse.ts and the hook
 * bridge). A command that writes to a remote (`git push`, a `gh` write)
 * waits for the requester's approval in the thread and then runs once;
 * everything else runs, because the worker is a regular chat.
 *
 * Every dependency failure throws out of here, and the bridge turns a throw
 * (or a slow answer) into deny.
 *
 * The shell parse reads quotes, separators, `$(...)`, backticks, `sh -c`
 * and `eval`, so an ordinary push cannot slip through by quoting or
 * chaining. It is not a boundary against a worker that hides git behind an
 * interpreter or a script it wrote.
 */

import { basename } from 'node:path'
import { z } from 'zod'
import type { HookDecisionRequest, HookDecisionResult, InvocationContext } from '../engine/hook-bridge.js'
import type { KillSwitch } from '../killswitch.js'
import type { AutonomousTask } from './store.js'

export type ShellWriteAnswer = { kind: 'approved' } | { kind: 'pending' } | { kind: 'refused'; reason: string }

export type GuardDeps = {
  loadTask(taskId: string): Promise<AutonomousTask | undefined>
  /** Re-reads the durable kill switch; see `killSwitchCheck`. A rejection denies. */
  isKillSwitchEngaged(): Promise<boolean>
  /** Uses up an approval for this exact command, or reports or requests one. */
  requestShellWrite(context: InvocationContext, write: { command: string; cwd: string }): Promise<ShellWriteAnswer>
}

export type AutonomousGuard = {
  decide(request: HookDecisionRequest, context: InvocationContext | undefined): Promise<HookDecisionResult>
}

/** The kill switch as the guard reads it: the durable state, so an engage from the CLI applies to the very next call. */
export function killSwitchCheck(killSwitch: Pick<KillSwitch, 'refresh'>): () => Promise<boolean> {
  return async () => (await killSwitch.refresh()).engaged
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

const deny = (reason: string): HookDecisionResult => ({ decision: 'deny', reason })

export function createAutonomousGuard(deps: GuardDeps): AutonomousGuard {
  async function decide(request: HookDecisionRequest, context: InvocationContext | undefined): Promise<HookDecisionResult> {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) return deny('malformed hook decision request')
    if (context === undefined) return deny('this call carries no per-turn token')
    if (await deps.isKillSwitchEngaged()) return deny('the relay kill switch is engaged')
    const task = await deps.loadTask(context.taskId)
    if (task === undefined || task.workspaceId !== context.workspaceId) return deny('the task for this token no longer exists')
    if (task.cancelRequestedAt !== null) return deny('the task was stopped; finish without running anything else')
    if (task.leaseGeneration !== context.leaseGeneration) return deny('this worker was superseded (stale lease generation)')
    if (parsed.data.toolName !== 'Bash') return { decision: 'allow', reason: 'only shell commands are checked' }
    const input = shellInputSchema.safeParse(parsed.data.toolInput)
    if (!input.success) return deny('malformed Bash tool input: no command')

    const writes = remoteWrites(input.data.command)
    if ('error' in writes) return deny(`could not parse this command (${writes.error}); rewrite it plainly`)
    if (writes.length === 0) return { decision: 'allow', reason: 'no remote write' }
    const answer = await deps.requestShellWrite(context, { command: input.data.command, cwd: input.data.workdir ?? parsed.data.cwd ?? '' })
    if (answer.kind === 'approved') return { decision: 'allow', reason: 'approved in the Slack thread' }
    if (answer.kind === 'refused') return deny(answer.reason)
    return deny(
      `This writes to a remote (${writes.join(', ')}), so it needs the user's approval in the Slack thread first; the card is posted. ` +
        'Stop here and say it is waiting for approval. Once approved you will be told to run the exact same command again.',
    )
  }

  return { decide }
}

const MAX_NESTING = 8
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** git's global options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
/** gh command groups that never write to a remote. */
const GH_LOCAL_GROUPS = new Set(['auth', 'browse', 'completion', 'config', 'extension', 'alias', 'help', 'search', 'status', 'version'])
/** gh subcommands that only read (or fetch to the local machine). */
const GH_READ_SUBCOMMANDS = new Set(['view', 'list', 'ls', 'status', 'diff', 'checks', 'download', 'watch', 'logs', 'verify'])
/** Reads only in their own group: `gh label clone` writes labels, `gh repo clone` only fetches. */
const GH_LOCAL_COMMANDS = new Set(['repo clone', 'gist clone', 'pr checkout', 'repo set-default'])
const GH_BODY_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input'])

/** The remote writes a command holds, by name (`git push`, `gh pr create`, `gh api POST`); empty when it holds none. */
export function remoteWrites(command: string): string[] | { error: string } {
  const found: string[] = []
  const pending = [{ text: command, depth: 0 }]
  while (pending.length > 0) {
    const next = pending.shift()
    if (next === undefined) break
    if (next.depth > MAX_NESTING) return { error: 'commands nested too deeply' }
    const tokens = tokenize(next.text)
    if ('error' in tokens) return tokens
    pending.push(...tokens.nested.map((text) => ({ text, depth: next.depth + 1 })))
    for (const segment of tokens.segments) {
      found.push(...writesIn(segment))
      pending.push(...innerCommands(segment).map((text) => ({ text, depth: next.depth + 1 })))
    }
  }
  return found
}

/**
 * Every word that is `git` or `gh` (or a path ending in one) starts a
 * command running to the end of its segment, whatever precedes it: a
 * wrapper like `xargs`, `env` or `sudo` cannot hide one, and `echo git push`
 * reads as a push, which is the safe mistake to make.
 */
function writesIn(segment: Segment): string[] {
  return segment.words.flatMap((word, start) => {
    const rest = segment.words.slice(start + 1)
    const name = basename(word.text)
    if (name === 'git') return gitWrite(rest)
    if (name === 'gh') return ghWrite(rest)
    return []
  })
}

function gitWrite(words: Word[]): string[] {
  let position = 0
  while (position < words.length && (words[position]?.text ?? '').startsWith('-')) {
    const option = words[position]?.text ?? ''
    position += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1
  }
  const subcommand = words[position]
  if (subcommand === undefined) return []
  if (subcommand.dynamic) return ['git with a substituted subcommand']
  return subcommand.text === 'push' ? ['git push'] : []
}

function ghWrite(words: Word[]): string[] {
  const texts = words.map((word) => word.text)
  const positional: Word[] = []
  for (let index = 0; index < words.length && positional.length < 2; index += 1) {
    const text = texts[index] ?? ''
    if (text === '-R' || text === '--repo') index += 1
    else if (!text.startsWith('-')) positional.push(words[index] as Word)
  }
  const [group, subcommand] = positional
  if (group === undefined) return []
  if (group.dynamic || subcommand?.dynamic === true) return ['gh with a substituted command']
  if (group.text === 'api') {
    const method = apiMethod(texts) ?? (texts.some((text) => GH_BODY_FLAGS.has(text) || /^(-[fF].|--(raw-)?field=|--input=)/.test(text)) ? 'POST' : 'GET')
    return method === 'GET' ? [] : [`gh api ${method}`]
  }
  if (GH_LOCAL_GROUPS.has(group.text) || subcommand === undefined || GH_READ_SUBCOMMANDS.has(subcommand.text)) return []
  if (GH_LOCAL_COMMANDS.has(`${group.text} ${subcommand.text}`)) return []
  return [`gh ${group.text} ${subcommand.text}`]
}

/** The method gh uses: the last -X or --method given. */
function apiMethod(texts: readonly string[]): string | undefined {
  let method: string | undefined
  for (const [index, text] of texts.entries()) {
    if (text === '-X' || text === '--method') method = texts[index + 1]?.toUpperCase()
    const inline = /^(?:-X=?|--method=)(.+)$/.exec(text)
    if (inline?.[1] !== undefined) method = inline[1].toUpperCase()
  }
  return method
}

type Word = { text: string; quoted: boolean; dynamic: boolean }
type Segment = { words: Word[]; separator: string }

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
