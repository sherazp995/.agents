import { describe, expect, it } from 'vitest'
import { parseShellMessage } from '../../src/shell/parse.js'

const plain = { mentionsBot: false }

describe('parseShellMessage', () => {
  it('reads every ! line as one command, trimmed, skipping blank lines', () => {
    expect(parseShellMessage('  ! git status \n\n   \n!git add .', plain)).toEqual({ kind: 'shell', commands: ['git status', 'git add .'] })
  })

  it('is not a shell message when no line starts with !, or there is no line', () => {
    expect(parseShellMessage('hello', plain)).toEqual({ kind: 'not_shell' })
    expect(parseShellMessage('hello\nI like ! marks', plain)).toEqual({ kind: 'not_shell' })
    expect(parseShellMessage(' \n ', plain)).toEqual({ kind: 'not_shell' })
  })

  it('treats lines before the first ! line as a note that never runs', () => {
    expect(parseShellMessage('<@U0CGSMKU23B> ye dekh\n\n!pwd', plain)).toEqual({ kind: 'shell', commands: ['pwd'] })
    expect(parseShellMessage('<@UBOT> ye dekh\n!pwd', { mentionsBot: true })).toEqual({ kind: 'shell', commands: ['pwd'] })
    expect(parseShellMessage('look at <https://x.io|this>\n! ls\n! pwd', plain)).toEqual({ kind: 'shell', commands: ['ls', 'pwd'] })
  })

  it('refuses a message that mixes other lines in after the first ! line', () => {
    const reason = 'Every line after the first `!` line needs to start with `!`. Nothing ran.'
    expect(parseShellMessage('! ls\nhello', plain)).toEqual({ kind: 'refused', reason })
    expect(parseShellMessage('note\n! ls\nhello\n! pwd', plain)).toEqual({ kind: 'refused', reason })
  })

  it('refuses a lone !', () => {
    expect(parseShellMessage('! ls\n!  ', plain)).toMatchObject({ kind: 'refused' })
  })

  it('strips one leading mention only when the message mentions Relay', () => {
    expect(parseShellMessage('<@UBOT> ! pwd', { mentionsBot: true })).toEqual({ kind: 'shell', commands: ['pwd'] })
    expect(parseShellMessage(' <@UBOT|relay>\n! pwd', { mentionsBot: true })).toEqual({ kind: 'shell', commands: ['pwd'] })
    expect(parseShellMessage('<@UBOT> ! pwd', plain)).toEqual({ kind: 'not_shell' })
    expect(parseShellMessage('<@UBOT> <@UBOT> ! pwd', { mentionsBot: true })).toEqual({ kind: 'not_shell' })
  })

  it('decodes Slack entities exactly once', () => {
    expect(parseShellMessage('! git commit -m "a &amp; b"', plain)).toEqual({ kind: 'shell', commands: ['git commit -m "a & b"'] })
    expect(parseShellMessage('! echo 1 &gt; f &lt; g &amp;lt;', plain)).toEqual({ kind: 'shell', commands: ['echo 1 > f < g &lt;'] })
  })

  it('leaves curly quotes as typed', () => {
    expect(parseShellMessage('! echo “hi”', plain)).toEqual({ kind: 'shell', commands: ['echo “hi”'] })
  })

  it('turns links Slack added back into what was typed', () => {
    expect(parseShellMessage('! curl <https://x.io/a?b=1&amp;c=2>', plain)).toEqual({ kind: 'shell', commands: ['curl https://x.io/a?b=1&c=2'] })
    expect(parseShellMessage('! echo <https://x.io|x.io>', plain)).toEqual({ kind: 'shell', commands: ['echo x.io'] })
    expect(parseShellMessage('! echo <mailto:a@b.co|a@b.co>', plain)).toEqual({ kind: 'shell', commands: ['echo a@b.co'] })
    expect(parseShellMessage('! open <http://x.io|http://x.io>', plain)).toEqual({ kind: 'shell', commands: ['open http://x.io'] })
  })

  it('refuses a link with a different label', () => {
    const parsed = parseShellMessage('! echo <https://x.io|click>', plain)
    expect(parsed).toMatchObject({ kind: 'refused' })
    expect(parsed.kind === 'refused' && parsed.reason).toContain('a link with a different label')
  })

  it('refuses a user, channel or special mention inside a command', () => {
    for (const token of ['<@U123>', '<#C123|general>', '<!here>']) {
      const parsed = parseShellMessage(`! echo ${token}`, { mentionsBot: true })
      expect(parsed.kind === 'refused' && parsed.reason).toContain('into a mention')
    }
  })
})
