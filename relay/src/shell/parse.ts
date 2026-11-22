/**
 * Reads one Slack message as shell lines (README, "Shell from Slack").
 *
 * A message is shell when one of its lines starts with `!`. Lines before the
 * first `!` line are a note to the people in the thread (`@Ahsan look at
 * this`) and never run. From the first `!` line on, every non-empty line must
 * start with `!`; a mix there is refused rather than half run, so a stray
 * sentence between commands never becomes a command.
 * Slack's transport encoding is undone exactly once and nothing else changes:
 * a command runs as the owner typed it, or not at all. That is why a link
 * Slack relabelled, or a mention Slack turned into an id, refuses the message
 * instead of running something the owner did not type.
 */

import type { ShellMessage } from './types.js'

/** One user mention at the very start, `<@U123>` or `<@U123|name>`: how a message that mentions Relay begins. */
const LEADING_MENTION = /^\s*<@[A-Z0-9]+(?:\|[^>]*)?>/

/** Slack escapes a literal `<`, so every `<...>` in message text is a token Slack added (a link or a mention). */
const SLACK_TOKEN = /<([^>]*)>/g

/** The three entities Slack escapes in message text, read in one pass so `&amp;lt;` becomes `&lt;`, not `<`. */
const SLACK_ENTITY = /&(lt|gt|amp);/g
const ENTITY_TEXT: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&' }

/** The schemes Slack drops from a link's label when it autolinks what the user typed. */
const AUTOLINK_SCHEME = /^(?:https?:\/\/|mailto:)/

const NOTHING_RAN = 'Nothing ran.'

export function parseShellMessage(text: string, options: { readonly mentionsBot: boolean }): ShellMessage {
  const body = options.mentionsBot ? text.replace(LEADING_MENTION, '') : text
  const allLines = body.split(/\r?\n/).map((line) => line.trimStart()).filter((line) => line !== '')
  const first = allLines.findIndex((line) => line.startsWith('!'))
  if (first === -1) return { kind: 'not_shell' }
  const lines = allLines.slice(first)
  if (lines.some((line) => !line.startsWith('!'))) return refused(`Every line after the first \`!\` line needs to start with \`!\`. ${NOTHING_RAN}`)

  const commands: string[] = []
  for (const line of lines) {
    const command = line.slice(1).trim()
    if (command === '') return refused(`A line has \`!\` with no command after it. ${NOTHING_RAN}`)
    const decoded = decodeSlackText(command)
    if (decoded.kind === 'refused') return decoded
    commands.push(decoded.text)
  }
  return { kind: 'shell', commands }
}

/** Undoes Slack's encoding of one command: its link tokens, then its entities, each once. */
function decodeSlackText(command: string): { readonly kind: 'decoded'; readonly text: string } | { readonly kind: 'refused'; readonly reason: string } {
  let problem: string | undefined
  const unlinked = command.replace(SLACK_TOKEN, (token, inner: string) => {
    const text = tokenText(inner)
    if (text === undefined) problem ??= refusalFor(token, inner)
    return text ?? token
  })
  if (problem !== undefined) return refused(problem)
  return { kind: 'decoded', text: unlinked.replace(SLACK_ENTITY, (_, name: string) => ENTITY_TEXT[name] ?? '') }
}

/** What the user typed where Slack put this token, or undefined when that cannot be known for sure. */
function tokenText(inner: string): string | undefined {
  if (isMention(inner)) return undefined
  const bar = inner.indexOf('|')
  if (bar === -1) return inner
  const url = inner.slice(0, bar)
  const label = inner.slice(bar + 1)
  return label === url || label === url.replace(AUTOLINK_SCHEME, '') ? label : undefined
}

function isMention(inner: string): boolean {
  return inner.startsWith('@') || inner.startsWith('#') || inner.startsWith('!')
}

function refusalFor(token: string, inner: string): string {
  if (isMention(inner)) return `Slack turned part of a line into a mention (\`${token}\`), so the command would not be what you typed. ${NOTHING_RAN}`
  return `Slack turned part of a line into a link with a different label (\`${token}\`), so the command would not be what you typed. ${NOTHING_RAN}`
}

function refused(reason: string): { readonly kind: 'refused'; readonly reason: string } {
  return { kind: 'refused', reason }
}
