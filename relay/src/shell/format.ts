/**
 * Renders a shell reply as standard Markdown for one Slack `markdown` block:
 * the folder, then each command as `` `$ cmd` `` with its output in a bash
 * block and a status line when it did not succeed, then the lines still
 * waiting or skipped, then the notice.
 *
 * The reply must fit one message, so outputs are shrunk to fit (the biggest
 * first, keeping their start and end) and nothing else is ever dropped: every
 * command and its status stays visible, which matters most when it failed.
 */

import { MARKDOWN_BLOCK_MAX_CHARS, SLACK_MAX_MESSAGE_BYTES } from '../chat/slack/adapter.js'
import type { CapturedOutput, LineOutcome, LineResult, ShellReport } from './types.js'

export type ShellReplyOptions = { readonly home: string; readonly maxChars: number; readonly maxBytes: number }

/** Below Slack's limits by enough to leave room for the password button block that may sit under the reply. */
export const SHELL_REPLY_LIMITS = { maxChars: MARKDOWN_BLOCK_MAX_CHARS - 300, maxBytes: SLACK_MAX_MESSAGE_BYTES - 2000 } as const

const ZERO_WIDTH_SPACE = '​'

export function formatShellReply(report: ShellReport, options: ShellReplyOptions): string {
  const fits = (text: string): boolean => text.length <= options.maxChars && Buffer.byteLength(text, 'utf8') <= options.maxBytes
  const render = (cap: number): string => renderReport(report, options.home, (output) => shrinkOutput(output, cap))

  const largest = Math.max(0, ...report.results.map((result) => outputBytes(result.output)))
  const whole = render(largest)
  if (fits(whole)) return whole

  // One byte cap for every output cuts the biggest first and leaves small ones whole; find the largest cap that fits.
  let low = 0
  let high = largest
  while (low < high) {
    const cap = Math.ceil((low + high) / 2)
    if (fits(render(cap))) low = cap
    else high = cap - 1
  }
  const shrunk = render(low)
  // Only when the commands and statuses alone are too long; the cut text still says it was cut.
  return fits(shrunk) ? shrunk : cutToFit(shrunk, fits)
}

function renderReport(report: ShellReport, home: string, shown: (output: CapturedOutput) => CapturedOutput): string {
  const sections = [header(report, home)]
  for (const result of report.results) sections.push(renderResult(result, shown(result.output)))
  if (report.running !== undefined) sections.push(`${commandLine(report.running)}\n⏳ running…`)
  for (const command of report.pending) sections.push(`${commandLine(command)}\n_waiting_`)
  for (const command of report.skipped) sections.push(`${commandLine(command)}\n_skipped_`)
  if (report.notice !== undefined) sections.push(`_${report.notice}_`)
  return sections.join('\n\n')
}

function header(report: ShellReport, home: string): string {
  let line = `📁 ${inlineCode(displayFolder(report.folder, home))}`
  if (report.sessionFolder !== undefined && report.sessionFolder !== report.folder) line += ` (session folder: ${inlineCode(displayFolder(report.sessionFolder, home))})`
  if (report.host !== undefined) line += ` on ${report.host}`
  return line
}

function displayFolder(folder: string, home: string): string {
  if (folder === home) return '~'
  return folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder
}

function renderResult(result: LineResult, output: CapturedOutput): string {
  const lines = [commandLine(result.command), outputBlock(output)]
  const status = statusLine(result.outcome)
  if (status !== undefined) lines.push(status)
  return lines.join('\n')
}

function statusLine(outcome: LineOutcome): string | undefined {
  switch (outcome.kind) {
    case 'exited':
      return outcome.code === 0 ? undefined : `❌ exit ${outcome.code}`
    case 'killed':
      return outcome.why === 'timeout' ? '⏱ stopped after the time limit' : `⛔ stopped: ${outcome.reason}`
    case 'signal':
      return `❌ ended by ${outcome.signal}`
    case 'spawn_failed':
      return `❌ could not start: ${outcome.message}`
  }
}

function commandLine(command: string): string {
  return inlineCode(`$ ${command}`)
}

/** Inline code that holds backticks: a delimiter longer than any backtick run inside, padded when the text starts or ends with one (CommonMark code spans). */
function inlineCode(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(longestRun + 1)
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${text}${padding}${fence}`
}

function outputBlock(output: CapturedOutput): string {
  if (output.omittedBytes === 0 && (output.head + output.tail).trim() === '') return '_no output_'
  let body = output.head
  if (output.omittedBytes > 0) {
    if (body !== '' && !body.endsWith('\n')) body += '\n'
    body += `… ${output.omittedBytes} bytes left out …`
    if (output.tail !== '') body += `\n${output.tail}`
  } else {
    body += output.tail
  }
  // A zero width space between backticks keeps a ``` in the output from closing the block early, in any renderer.
  const safe = body.replace(/\n$/, '').replaceAll(/`(?=`)/g, `\`${ZERO_WIDTH_SPACE}`)
  return `\`\`\`bash\n${safe}\n\`\`\``
}

function outputBytes(output: CapturedOutput): number {
  return Buffer.byteLength(output.head, 'utf8') + Buffer.byteLength(output.tail, 'utf8')
}

/** Keeps at most `cap` bytes of an output, its start and its end, adding what it cut to `omittedBytes`. */
function shrinkOutput(output: CapturedOutput, cap: number): CapturedOutput {
  const total = outputBytes(output)
  if (total <= cap) return output
  // With nothing omitted yet the output is one text, so its end comes from the head too.
  const start = output.omittedBytes === 0 ? output.head + output.tail : output.head
  const end = output.omittedBytes === 0 ? output.head + output.tail : output.tail
  const startBudget = output.omittedBytes === 0 ? Math.ceil(cap / 2) : Math.max(Math.ceil(cap / 2), cap - Buffer.byteLength(end, 'utf8'))
  const head = prefixWithin(start, startBudget)
  const tail = suffixWithin(end, cap - Buffer.byteLength(head, 'utf8'))
  return { head, tail, omittedBytes: output.omittedBytes + total - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8') }
}

/** The longest start of `text` within `maxBytes` UTF-8 bytes, cut between code points. */
function prefixWithin(text: string, maxBytes: number): string {
  let bytes = 0
  let kept = 0
  for (const char of text) {
    bytes += Buffer.byteLength(char, 'utf8')
    if (bytes > maxBytes) break
    kept += char.length
  }
  return text.slice(0, kept)
}

/** The longest end of `text` within `maxBytes` UTF-8 bytes, cut between code points. */
function suffixWithin(text: string, maxBytes: number): string {
  const chars = Array.from(text)
  let bytes = 0
  let index = chars.length
  while (index > 0) {
    const size = Buffer.byteLength(chars[index - 1] ?? '', 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    index -= 1
  }
  return chars.slice(index).join('')
}

/** The last resort when even empty outputs do not fit: the longest start that fits with a closing mark. */
function cutToFit(text: string, fits: (text: string) => boolean): string {
  const mark = '\n\n_… reply cut to fit Slack …_'
  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  while (low < high) {
    const count = Math.ceil((low + high) / 2)
    if (fits(chars.slice(0, count).join('') + mark)) low = count
    else high = count - 1
  }
  return chars.slice(0, low).join('') + mark
}
