import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SESSION_MODE,
  DIRECT_SLASH_COMMAND,
  expandHome,
  parseDirectCommand,
  renderModeHint,
} from '../../src/live/session-mode.js'

/**
 * The operator's own framing is the one that matters: Relay is "a simple
 * mechanism to control my system from Slack when I'm not near my machine".
 * The governed mode is not always what someone wants at ten at night from a
 * phone, so there are two, and saying which is one command.
 */

describe('the default is the mode WITH the guarantees', () => {
  it('defaults to governed, so unmediated is never somewhere you end up by omission', () => {
    expect(DEFAULT_SESSION_MODE).toBe('governed')
  })

  it('names the command that switches, in the hint a thread actually sees', () => {
    expect(renderModeHint()).toContain(DIRECT_SLASH_COMMAND)
  })
})

describe('parsing /direct', () => {
  it('takes a bare command, since "just talk to my machine" is the common case', () => {
    expect(parseDirectCommand('')).toEqual({})
  })

  it('reads a leading path as the directory', () => {
    expect(parseDirectCommand('/Users/op/code/thing')).toEqual({ directory: '/Users/op/code/thing' })
    expect(parseDirectCommand('~/code/thing')).toEqual({ directory: '~/code/thing' })
  })

  it('takes a directory AND a first message', () => {
    expect(parseDirectCommand('~/code/thing check the failing test')).toEqual({
      directory: '~/code/thing',
      message: 'check the failing test',
    })
  })

  it('does NOT read the first word as a path when it plainly is not one', () => {
    // Guessing that the first word is always a directory would turn
    // "/direct check the logs" into a session in a folder called "check".
    expect(parseDirectCommand('check the logs')).toEqual({ message: 'check the logs' })
  })

  it('expands a leading ~, since someone typing on a phone will', () => {
    expect(expandHome('~/code', '/Users/op')).toBe('/Users/op/code')
    expect(expandHome('~', '/Users/op')).toBe('/Users/op')
    expect(expandHome('/absolute', '/Users/op')).toBe('/absolute')
  })
})
