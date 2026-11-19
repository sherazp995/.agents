import { describe, expect, it } from 'vitest'
import { localFolder, refusedName, storedFolder } from '../../src/worker-env/scope.js'

describe('env scope rules', () => {
  it('keeps folders under home as ~ paths in one form', () => {
    const home = '/Users/hassan'
    expect(storedFolder('~/code/app/', home)).toBe('~/code/app')
    expect(storedFolder('/Users/hassan/code/app/../app', home)).toBe('~/code/app')
    expect(storedFolder('app', home, '/Users/hassan/code')).toBe('~/code/app')
    expect(storedFolder('.', home, '/Users/hassan')).toBe('~')
    expect(storedFolder('/opt/shared/', home)).toBe('/opt/shared')
    expect(storedFolder('/Users/hassanx/app', home)).toBe('/Users/hassanx/app')
  })

  it('reads a stored ~ folder under the local home', () => {
    expect(localFolder('~/code/app', '/Users/zubair')).toBe('/Users/zubair/code/app')
    expect(localFolder('~', '/Users/zubair/')).toBe('/Users/zubair')
    expect(localFolder('/opt/shared', '/Users/zubair')).toBe('/opt/shared')
  })

  it('refuses names Relay or the login pool set, and malformed names', () => {
    expect(refusedName('PLAYWRIGHT_MCP_EXTENSION_TOKEN')).toBeUndefined()
    expect(refusedName('PATH')).toBeUndefined()
    for (const name of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RELAY_HOOK_TOKEN', 'RELAY_SECRET_X', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
      expect(refusedName(name)).toContain('cannot be stored')
    }
    expect(refusedName('1BAD')).toContain('not an env name')
    expect(refusedName('A-B')).toContain('not an env name')
  })
})
