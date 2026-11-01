import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runReposAdd } from '../../src/cli/repos.js'
import { loadRepoRegistry } from '../../src/config/load.js'

function gitRepo(name: string): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'relay-repos-'))), name)
  mkdirSync(dir)
  execFileSync('git', ['init', '-q', '-b', 'trunk', dir])
  return dir
}

describe('runReposAdd', () => {
  it('creates repos.yaml with an entry loadRepoRegistry accepts, keeping earlier entries and comments', async () => {
    const repo = gitRepo('My Repo')
    const reposPath = join(mkdtempSync(join(tmpdir(), 'relay-reposyaml-')), 'nested', 'repos.yaml')

    const first = await runReposAdd({ path: repo, reposPath })

    expect(first.exitCode).toBe(0)
    expect(first.report).toContain('`publish` is not granted')
    expect(loadRepoRegistry(reposPath).repos).toEqual([
      expect.objectContaining({ name: 'my-repo', path: repo, default_branch: 'trunk', permitted_operations: ['read', 'write'] }),
    ])

    writeFileSync(reposPath, `# keep me\n${readFileSync(reposPath, 'utf8')}`)
    const second = await runReposAdd({ path: gitRepo('other'), reposPath })

    expect(second.exitCode).toBe(0)
    expect(readFileSync(reposPath, 'utf8')).toContain('# keep me')
    expect(loadRepoRegistry(reposPath).repos.map((entry) => entry.name)).toEqual(['my-repo', 'other'])
  })

  it('refuses a duplicate name or path and a folder outside git, leaving the file unchanged', async () => {
    const repo = gitRepo('dup')
    const reposPath = join(mkdtempSync(join(tmpdir(), 'relay-reposyaml-')), 'repos.yaml')
    await runReposAdd({ path: repo, reposPath })
    const before = readFileSync(reposPath, 'utf8')

    const sameName = await runReposAdd({ path: gitRepo('elsewhere'), reposPath, name: 'DUP' })
    const samePath = await runReposAdd({ path: repo, reposPath, name: 'again' })
    const notGit = await runReposAdd({ path: mkdtempSync(join(tmpdir(), 'relay-plain-')), reposPath })

    expect(sameName).toMatchObject({ exitCode: 1, report: expect.stringContaining('already names') })
    expect(samePath).toMatchObject({ exitCode: 1, report: expect.stringContaining('already registered') })
    expect(notGit).toMatchObject({ exitCode: 1, report: expect.stringContaining('not inside a git work tree') })
    expect(readFileSync(reposPath, 'utf8')).toBe(before)
  })

  it('rolls back an entry the registry refuses', async () => {
    const reposPath = join(mkdtempSync(join(tmpdir(), 'relay-reposyaml-')), 'repos.yaml')
    writeFileSync(reposPath, 'version: 1\nrepos: []\n')

    const result = await runReposAdd({ path: gitRepo('pub'), reposPath, operations: ['read', 'publish'] })

    expect(result.exitCode).toBe(1)
    expect(readFileSync(reposPath, 'utf8')).toBe('version: 1\nrepos: []\n')
  })
})
