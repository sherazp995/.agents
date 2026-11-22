import { describe, expect, it } from 'vitest'
import { formatShellReply, SHELL_REPLY_LIMITS } from '../../src/shell/format.js'
import type { CapturedOutput, LineOutcome, LineResult, ShellReport } from '../../src/shell/types.js'

const HOME = '/Users/me'
const options = { home: HOME, ...SHELL_REPLY_LIMITS }

function output(head: string, omittedBytes = 0, tail = ''): CapturedOutput {
  return { head, tail, omittedBytes }
}

function result(command: string, captured: CapturedOutput, outcome: LineOutcome = { kind: 'exited', code: 0 }): LineResult {
  return { command, outcome, output: captured, folderAfter: `${HOME}/repo` }
}

function report(fields: Partial<ShellReport> = {}): ShellReport {
  return { folder: `${HOME}/repo`, results: [], pending: [], skipped: [], ...fields }
}

function withinLimits(text: string, limits: { maxChars: number; maxBytes: number }): void {
  expect(text.length).toBeLessThanOrEqual(limits.maxChars)
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(limits.maxBytes)
}

describe('formatShellReply', () => {
  it('renders the three line git example: each command, its output, the failure, the skipped line', () => {
    const text = formatShellReply(
      report({
        results: [result('git status', output('On branch main\n')), result('git add .', output('fatal: not a repo\n'), { kind: 'exited', code: 128 })],
        skipped: ['git commit -m x'],
      }),
      options,
    )
    expect(text).toBe(
      [
        '📁 `~/repo`',
        '`$ git status`\n```bash\nOn branch main\n```',
        '`$ git add .`\n```bash\nfatal: not a repo\n```\n❌ exit 128',
        '`$ git commit -m x`\n_skipped_',
      ].join('\n\n'),
    )
  })

  it('shows the session folder when it differs, and the host', () => {
    expect(formatShellReply(report({ sessionFolder: '/srv/app', host: 'laptop-2' }), options)).toBe('📁 `~/repo` (session folder: `/srv/app`) on laptop-2')
    expect(formatShellReply(report({ folder: HOME, sessionFolder: HOME }), options)).toBe('📁 `~`')
  })

  it('says when a line had no output', () => {
    expect(formatShellReply(report({ results: [result('true', output(''))] }), options)).toContain('`$ true`\n_no output_')
  })

  it('gives each outcome its status line', () => {
    const statuses: [LineOutcome, string][] = [
      [{ kind: 'killed', why: 'timeout', reason: 'time limit' }, '⏱ stopped after the time limit'],
      [{ kind: 'killed', why: 'cancelled', reason: 'Stop' }, '⛔ stopped: Stop'],
      [{ kind: 'signal', signal: 'SIGSEGV' }, '❌ ended by SIGSEGV'],
      [{ kind: 'spawn_failed', message: 'ENOENT' }, '❌ could not start: ENOENT'],
    ]
    for (const [outcome, status] of statuses) {
      expect(formatShellReply(report({ results: [result('x', output('out'), outcome)] }), options)).toMatch(new RegExp(`\`\`\`\\n${status}$`))
    }
  })

  it('shows the running line, waiting lines and the notice', () => {
    expect(formatShellReply(report({ running: 'sleep 9', pending: ['ls'], notice: 'Waiting for a password' }), options)).toBe(
      '📁 `~/repo`\n\n`$ sleep 9`\n⏳ running…\n\n`$ ls`\n_waiting_\n\n_Waiting for a password_',
    )
  })

  it('shows bytes left out between head and tail', () => {
    expect(formatShellReply(report({ results: [result('yes', output('y\ny', 500, 'y\n'))] }), options)).toContain('```bash\ny\ny\n… 500 bytes left out …\ny\n```')
  })

  it('keeps a command with backticks inside its inline code', () => {
    expect(formatShellReply(report({ running: 'echo `date`' }), options)).toContain('`` $ echo `date` ``')
  })

  it('keeps ``` in the output from closing the block', () => {
    const text = formatShellReply(report({ results: [result('cat a.md', output('```\nrm -rf x\n```\n'))] }), options)
    const fences = text.split('\n').filter((line) => line.startsWith('```'))
    expect(fences).toEqual(['```bash', '```'])
    expect(text.replaceAll('​', '')).toContain('```\nrm -rf x\n```\n```')
  })

  it('shrinks huge outputs to fit, keeping every command and status, start and end of each', () => {
    const big = `START${'x'.repeat(200_000)}END`
    const text = formatShellReply(
      report({ results: [result('a', output(big)), result('b', output('small')), result('c', output(big), { kind: 'exited', code: 2 })], skipped: ['d'] }),
      options,
    )
    withinLimits(text, SHELL_REPLY_LIMITS)
    expect(text.length).toBeGreaterThan(SHELL_REPLY_LIMITS.maxChars - 200)
    for (const piece of ['`$ a`', '```bash\nsmall\n```', '`$ c`', '❌ exit 2', '`$ d`\n_skipped_']) expect(text).toContain(piece)
    expect(text.match(/```bash\nSTARTx+\n… \d+ bytes left out …\nx+END\n```/g)).toHaveLength(2)
  })

  it('holds the byte limit for multibyte output without splitting a character', () => {
    const limits = { maxChars: 10_000, maxBytes: 1_000 }
    const text = formatShellReply(report({ results: [result('cat', output('é😀'.repeat(2_000)))] }), { home: HOME, ...limits })
    withinLimits(text, limits)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(900)
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(text).not.toContain('�')
    const omitted = Number(/… (\d+) bytes left out …/.exec(text)?.[1])
    const shown = /```bash\n([^]*)\n… \d+ bytes left out …\n([^]*)\n```/.exec(text)
    expect(Buffer.byteLength(`${shown?.[1]}${shown?.[2]}`) + omitted).toBe(Buffer.byteLength('é😀'.repeat(2_000)))
  })
})
