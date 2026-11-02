import { describe, expect, it } from 'vitest'
import { firstFolderPath, lookupChannelFolder } from '../../../src/chat/slack/channel-folder.js'

describe('firstFolderPath', () => {
  it('takes the first ~ or absolute path in text order, quoted paths keeping their spaces', () => {
    expect(firstFolderPath('this should start sessions only from /Documents/zubair549/cohabit-web')).toBe('/Documents/zubair549/cohabit-web')
    expect(firstFolderPath('sessions in ~/code/web, docs in /srv/docs')).toBe('~/code/web')
    expect(firstFolderPath('use /srv/a or "~/My Project"')).toBe('/srv/a')
    expect(firstFolderPath('work from "~/My Project" please')).toBe('~/My Project')
  })

  it('drops trailing punctuation, skips URLs, and finds nothing in plain text', () => {
    expect(firstFolderPath('Folder: ~/code/web.')).toBe('~/code/web')
    expect(firstFolderPath('see <https://example.com/docs|docs> then ~/code/web')).toBe('~/code/web')
    expect(firstFolderPath('Project chat, no folder here')).toBeUndefined()
    expect(firstFolderPath('frontend / backend work')).toBeUndefined()
  })

  it("keeps an apostrophe inside a quoted path, and reads `~/` alone as home", () => {
    expect(firstFolderPath(`use "/srv/team's repo" here`)).toBe("/srv/team's repo")
    expect(firstFolderPath('use ~/ then /tmp')).toBe('~/')
    expect(firstFolderPath('use "/" here')).toBeUndefined()
  })
})

describe('lookupChannelFolder', () => {
  const home = '/Users/me'

  it('expands ~ and reports a description with no folder, without touching Slack for a DM', async () => {
    expect(await lookupChannelFolder(async () => 'only from ~/code/web', 'C1', { home })).toEqual({ kind: 'folder', path: '/Users/me/code/web' })
    expect(await lookupChannelFolder(async () => 'chat', 'C1', { home })).toEqual({ kind: 'none' })
    const dm = await lookupChannelFolder(async () => {
      throw new Error('a DM must not be looked up')
    }, 'D1', { home })
    expect(dm).toEqual({ kind: 'none' })
  })

  it('tells a missing scope apart from any other failure', async () => {
    const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), { data: { ok: false, error: 'missing_scope' } })
    expect(await lookupChannelFolder(async () => Promise.reject(missingScope), 'C1')).toEqual({ kind: 'failed', missingScope: true })
    expect(await lookupChannelFolder(async () => Promise.reject(new Error('socket hang up')), 'C1')).toEqual({ kind: 'failed', missingScope: false })
  })

  it('gives up on a lookup that hangs', async () => {
    const started = Date.now()
    const result = await lookupChannelFolder(() => new Promise<string>(() => {}), 'C1', { timeoutMs: 50 })
    expect(result).toEqual({ kind: 'failed', missingScope: false })
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })
})
