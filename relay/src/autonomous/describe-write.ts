/**
 * One plain-English line for a lone remote write, the title of its approval
 * card ("Push branch feature-x to origin", "Open a pull request: Fix
 * login"). The card still shows the exact command underneath, so this only
 * has to be right, never complete: any shape it does not know for sure (a
 * flag it has not seen, a substituted word, a wrapper in front, a chain)
 * reads as the safe fallback naming the write, and it never throws.
 *
 * It reads the command with the guard's own parser, so the line and the
 * guard can never disagree about what the words are.
 */

import { basename } from 'node:path'
import { GIT_OPTIONS_WITH_VALUE, loneCommandWords, remoteWrites } from './guard.js'

export function describeRemoteWrite(command: string): string {
  const writes = remoteWrites(command)
  const name = Array.isArray(writes) && writes.length === 1 ? writes[0] : undefined
  const fallback = name === undefined ? 'Run a command that writes to a remote' : `Run ${name} (writes to ${name.startsWith('gh') ? 'GitHub' : 'a remote'})`
  const words = loneCommandWords(command)
  if (name === undefined || words === undefined || words.some((word) => word.dynamic)) return fallback
  const [program, ...rest] = words.map((word) => word.text)
  const line = basename(program ?? '') === 'git' ? describeGit(rest) : basename(program ?? '') === 'gh' ? describeGh(rest, name) : undefined
  return line ?? fallback
}

/** `git push` flags that take no value, by what they change in the line. */
const PUSH_FLAGS = new Map<string, 'force' | 'delete' | 'tags' | 'all' | 'plain'>([
  ['-f', 'force'], ['--force', 'force'], ['--force-with-lease', 'force'], ['--force-if-includes', 'force'],
  ['-d', 'delete'], ['--delete', 'delete'], ['--tags', 'tags'], ['--all', 'all'],
  ['--follow-tags', 'plain'], ['-u', 'plain'], ['--set-upstream', 'plain'], ['-q', 'plain'], ['--quiet', 'plain'],
  ['-v', 'plain'], ['--verbose', 'plain'], ['--no-verify', 'plain'], ['--atomic', 'plain'],
])

function describeGit(words: string[]): string | undefined {
  let position = 0
  while ((words[position] ?? '').startsWith('-')) position += GIT_OPTIONS_WITH_VALUE.has(words[position] ?? '') ? 2 : 1
  if (words[position] !== 'push') return undefined
  const effects = new Set<string>()
  const positional: string[] = []
  for (const word of words.slice(position + 1)) {
    if (!word.startsWith('-')) positional.push(word)
    else if (word.startsWith('--force-with-lease=')) effects.add('force')
    else {
      // `-fu` is `-f -u`; any flag not in the table is a shape this does not know.
      const flags = /^-[a-z]{2,}$/.test(word) ? [...word.slice(1)].map((letter) => `-${letter}`) : [word]
      for (const flag of flags) {
        const effect = PUSH_FLAGS.get(flag)
        if (effect === undefined) return undefined
        effects.add(effect)
      }
    }
  }
  const [remote, ...refspecs] = positional
  if (refspecs.some((refspec) => refspec.startsWith('+'))) effects.add('force')
  const destinations = refspecs.map((refspec) => refspec.replace(/^\+/, '').split(':').pop() ?? '')
  const deleted = refspecs.filter((refspec) => refspec.startsWith(':')).map((refspec) => refspec.slice(1))
  const where = remote === undefined ? 'its upstream' : remote
  const push = effects.has('force') ? 'FORCE push' : 'Push'

  if (effects.has('delete') || deleted.length > 0) {
    const targets = effects.has('delete') ? destinations : deleted
    if (remote === undefined || targets.length === 0 || targets.length !== refspecs.length) return undefined
    return `Delete ${refList(targets)} on ${remote}`
  }
  const every = effects.has('all') ? 'all branches' : effects.has('tags') ? 'all tags' : undefined
  if (every !== undefined) return refspecs.length === 0 ? `${push} ${every} to ${remote ?? 'the default remote'}` : undefined
  if (destinations.some((destination) => destination === '')) return undefined
  if (refspecs.length === 0 || (refspecs.length === 1 && destinations[0] === 'HEAD')) return `${push} the current branch to ${where}`
  return `${push} ${refList(destinations)} to ${where}`
}

/** `feature-x` as "branch feature-x", `refs/tags/v1` as "tag v1", several joined. */
function refList(refs: string[]): string {
  const named = refs.map((ref) => (ref.startsWith('refs/tags/') ? `tag ${ref.slice(10)}` : `branch ${ref.replace(/^refs\/heads\//, '')}`))
  return named.join(', ')
}

/** gh flags (across pr, issue, release and api) whose value is the next word. */
const GH_VALUE_FLAGS = new Set([
  '-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-l', '--label', '-a', '--assignee',
  '-r', '--reviewer', '--milestone', '-p', '--project', '-c', '--comment', '--subject', '--author-email', '--match-head-commit', '-T', '--template',
  '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project',
  '-n', '--notes', '--notes-file', '--target', '-X', '--method', '-f', '--field', '--raw-field', '--header', '--input', '-q', '--jq', '--hostname', '--cache',
])

type GhCommand = { positional: string[]; values: Map<string, string>; flags: Set<string> }

function readGh(words: string[]): GhCommand {
  const parsed: GhCommand = { positional: [], values: new Map(), flags: new Set() }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ''
    const inline = /^(--[a-z-]+)=(.*)$/s.exec(word)
    if (inline?.[1] !== undefined) parsed.values.set(inline[1], inline[2] ?? '')
    else if (GH_VALUE_FLAGS.has(word)) {
      parsed.values.set(word, words[index + 1] ?? '')
      index += 1
    } else if (word.startsWith('-')) parsed.flags.add(word)
    else parsed.positional.push(word)
  }
  return parsed
}

const ITEM_NOUNS = new Map([['pr', 'pull request'], ['issue', 'issue']])
/** What a pr or issue subcommand does to its item; `{}` is where the item goes. */
const ITEM_ACTIONS = new Map([
  ['merge', 'Merge {}'], ['close', 'Close {}'], ['reopen', 'Reopen {}'], ['comment', 'Comment on {}'], ['edit', 'Edit {}'], ['ready', 'Mark {} ready for review'],
])

function describeGh(words: string[], name: string): string | undefined {
  const gh = readGh(words)
  const [group = '', subcommand = '', ...args] = gh.positional
  const repo = gh.values.get('-R') ?? gh.values.get('--repo')
  const inRepo = repo === undefined ? '' : ` in ${repo}`
  const rawTitle = gh.values.get('-t') ?? gh.values.get('--title')
  const title = rawTitle === undefined ? '' : `: ${rawTitle.replace(/\s+/g, ' ').trim()}`

  if (group === 'api') {
    // remoteWrites names it `gh api <METHOD>`; the one positional is the path.
    return subcommand === '' || args.length > 0 ? undefined : `Call the GitHub API: ${name.split(' ')[2]} ${subcommand}`
  }
  const noun = ITEM_NOUNS.get(group)
  if (noun !== undefined && subcommand === 'create' && args.length === 0) {
    const draft = gh.flags.has('-d') || gh.flags.has('--draft')
    return `Open ${noun === 'issue' ? 'an issue' : draft ? 'a draft pull request' : 'a pull request'}${inRepo}${title}`
  }
  const action = ITEM_ACTIONS.get(subcommand)
  if (noun !== undefined && action !== undefined && args.length <= 1) {
    const [item] = args
    // A pr command with no item acts on the current branch's pull request; an issue command always names one.
    if (item === undefined && noun === 'issue') return undefined
    const which = item === undefined ? `the current branch's ${noun}` : `${noun} ${/^\d+$/.test(item) ? `#${item}` : item}`
    return `${action.replace('{}', which)}${inRepo}`
  }
  const [tag] = args
  if (group === 'release' && subcommand === 'create' && tag !== undefined) return `Create release ${tag}${inRepo}${title}`
  return undefined
}
