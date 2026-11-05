import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensurePersonasDir, movePersonaAside, newPersonaFileName, personaPath, PersonaFileNotSaved, readPersona, savePersonaFile, type FileOps } from '../../src/projects/persona-files.js'

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'relay-persona-files-')), 'personas')
const realOps: FileOps = { write: (path, text) => writeFileSync(path, text, { flag: 'wx' }), rename: renameSync, remove: (path) => rmSync(path, { force: true }) }
/** Only the visible persona files, so a leftover temp file shows up too. */
const filesIn = (dir: string) => readdirSync(dir).filter((name) => name !== '.gitignore').sort()

describe('persona files', () => {
  it('names a file from the persona\'s slug plus a short id, and refuses a name that would leave the folder', () => {
    expect(newPersonaFileName('Senior Reviewer!', 'abc123')).toBe('senior-reviewer-abc123.md')
    expect(newPersonaFileName('***', 'abc123')).toBe('persona-abc123.md')
    for (const bad of ['../x.md', 'a/b.md', '.hidden.md', 'x.txt', '/etc/passwd']) expect(() => personaPath('/tmp/p', bad)).toThrow()
  })

  it('writes the file only after the commit succeeds, and leaves nothing when the commit fails', async () => {
    const dir = freshDir()
    await expect(savePersonaFile(dir, 'dev-aaaaaa.md', '# Dev', async () => { throw new Error('commit failed') })).rejects.toThrow('commit failed')
    expect(filesIn(dir)).toEqual([])

    await savePersonaFile(dir, 'dev-aaaaaa.md', '# Dev', async () => undefined)
    expect(readPersona(dir, 'dev-aaaaaa.md')).toBe('# Dev\n')
    // A hand edit is read back as it is.
    writeFileSync(join(dir, 'dev-aaaaaa.md'), 'edited by hand')
    expect(readPersona(dir, 'dev-aaaaaa.md')).toBe('edited by hand')
    expect(readPersona(dir, 'gone-aaaaaa.md')).toBeUndefined()
  })

  it('keeps the old file and says so when the rename fails after the commit', async () => {
    const dir = freshDir()
    await savePersonaFile(dir, 'dev-aaaaaa.md', '# Old', async () => undefined)
    const failingRename: FileOps = { ...realOps, rename: () => { throw new Error('disk full') } }

    await expect(savePersonaFile(dir, 'dev-aaaaaa.md', '# New', async () => 'committed', failingRename)).rejects.toThrow(PersonaFileNotSaved)
    expect(readPersona(dir, 'dev-aaaaaa.md')).toBe('# Old\n')
    expect(filesIn(dir)).toEqual(['dev-aaaaaa.md'])
  })

  it('moves a removed file aside, twice in a row, without overwriting the first', () => {
    const dir = freshDir()
    ensurePersonasDir(dir)
    const now = new Date('2026-11-05T10:00:00Z')
    writeFileSync(join(dir, 'dev-aaaaaa.md'), 'one')
    const first = movePersonaAside(dir, 'dev-aaaaaa.md', now)
    writeFileSync(join(dir, 'dev-aaaaaa.md'), 'two')
    const second = movePersonaAside(dir, 'dev-aaaaaa.md', now)

    expect(first).not.toBe(second)
    expect([readFileSync(first ?? '', 'utf8'), readFileSync(second ?? '', 'utf8')]).toEqual(['one', 'two'])
    expect(movePersonaAside(dir, 'dev-aaaaaa.md', now)).toBeUndefined()
  })

  it('stays out of git when the folder sits inside a repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'relay-home-repo-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const dir = join(repo, 'personas')
    await savePersonaFile(dir, 'lead-aaaaaa.md', '# Lead', async () => undefined)
    movePersonaAside(dir, 'lead-aaaaaa.md')

    expect(existsSync(join(dir, '.removed'))).toBe(true)
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })).toBe('')
  })
})
