import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatFolder, namedFolder, textFolder } from '../../src/autonomous/folder.js'
import type { RepoEntry } from '../../src/repos/schema.js'

const home = mkdtempSync(join(tmpdir(), 'relay-folder-'))
mkdirSync(join(home, 'My Project'))
mkdirSync(join(home, 'code'))
const repos = [
  { name: 'agents', path: '/repos/agents' },
  { name: 'winad', path: '/repos/winad', aliases: ['wa'] },
] as unknown as RepoEntry[]

describe('chatFolder', () => {
  it('takes a folder the message names, quoted with spaces or bare, by ~ or absolute path', () => {
    expect(chatFolder('work in ~/code please', repos, home)).toBe(join(home, 'code'))
    expect(chatFolder(`work in "${join(home, 'My Project')}"`, repos, home)).toBe(join(home, 'My Project'))
    expect(chatFolder('look at `~/My Project` now', repos, home)).toBe(join(home, 'My Project'))
  })

  it('then a registered repo by name or alias, then the first repo, then home', () => {
    expect(chatFolder('fix the login in wa', repos, home)).toBe('/repos/winad')
    expect(chatFolder('check ~/missing for me', repos, home)).toBe('/repos/agents')
    expect(chatFolder('hello', [], home)).toBe(home)
  })
})

describe('namedFolder', () => {
  it('takes only a folder the text names, never a repo or home', () => {
    expect(namedFolder('use ~/code', home)).toBe(join(home, 'code'))
    expect(namedFolder('use agents', home)).toBeUndefined()
    expect(namedFolder('use ~/missing', home)).toBeUndefined()
  })
})

describe('textFolder', () => {
  it('matches a repo name that ends a sentence, as the real reminder "status update for hassan in cohabit." does', () => {
    const withCohabit = [...repos, { name: 'cohabit', path: '/repos/cohabit' }] as unknown as RepoEntry[]
    expect(textFolder("give me today's status update for hassan in cohabit.", withCohabit, home)).toBe('/repos/cohabit')
    expect(textFolder('hello there.', withCohabit, home)).toBeUndefined()
  })
})
