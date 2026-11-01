/**
 * `relay repos add <path>`: registers one of the operator's git checkouts in
 * repos.yaml (FR-CODE-1), so nobody has to copy config/repos.example.yaml
 * and edit it by hand.
 *
 * The entry it writes is the most conservative one the schema accepts:
 * `permitted_operations: [read, write]`, never `publish`, which stays the
 * operator's own deliberate edit (src/repos/schema.ts explains why it is a
 * separate permission). The file is edited as a YAML document, so the
 * existing entries and their comments are kept, and the result is loaded
 * with loadRepoRegistry before the command reports success: a write the
 * registry would refuse is rolled back.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { loadRepoRegistry } from '../config/load.js'
import type { RepoOperation } from '../repos/schema.js'

export type ReposResult = { readonly report: string; readonly exitCode: number }

export type ReposAddParams = {
  /** The checkout to register; any folder inside it works, the work tree's top level is what gets registered. */
  readonly path: string
  readonly reposPath: string
  /** Defaults to the folder's name, lowercased and reduced to letters, digits, `.`, `_` and `-`. */
  readonly name?: string
  readonly operations?: readonly RepoOperation[]
}

export type ReposAddDependencies = {
  /** Runs git with `args`; resolves with trimmed stdout, rejects when git exits non-zero. */
  readonly git?: (args: readonly string[]) => Promise<string>
}

const DEFAULT_OPERATIONS: readonly RepoOperation[] = ['read', 'write']

function runGit(args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args as string[], (error, stdout) => (error ? reject(error) : resolvePromise(stdout.trim())))
  })
}

/** The folder's name as a registry handle; empty when nothing usable is left. */
export function repoNameFromFolder(folder: string): string {
  return basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

async function defaultBranch(git: NonNullable<ReposAddDependencies['git']>, top: string): Promise<string> {
  const remoteHead = await git(['-C', top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  if (remoteHead !== '') return remoteHead.replace(/^origin\//, '')
  const current = await git(['-C', top, 'symbolic-ref', '--short', 'HEAD']).catch(() => '')
  return current !== '' ? current : 'main'
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export async function runReposAdd(params: ReposAddParams, deps: ReposAddDependencies = {}): Promise<ReposResult> {
  const git = deps.git ?? runGit
  const requested = realOrResolved(params.path)
  if (!existsSync(requested)) return { report: `${requested} does not exist.`, exitCode: 1 }

  const top = await git(['-C', requested, 'rev-parse', '--show-toplevel']).catch(() => '')
  if (top === '') return { report: `${requested} is not inside a git work tree, so Relay cannot register it.`, exitCode: 1 }
  const path = realOrResolved(top)

  const name = params.name?.trim() ?? repoNameFromFolder(path)
  if (name === '') return { report: `Could not derive a name from ${path}; pass one with --name.`, exitCode: 1 }

  const previous = existsSync(params.reposPath) ? readFileSync(params.reposPath, 'utf8') : undefined
  const doc = parseDocument(previous ?? 'version: 1\nrepos: []\n')
  if (doc.errors.length > 0) return { report: `${params.reposPath} is not valid YAML: ${doc.errors[0]?.message ?? ''}`, exitCode: 1 }
  if (!isMap(doc.contents)) return { report: `${params.reposPath} does not hold a YAML mapping.`, exitCode: 1 }
  if (!doc.has('version')) doc.set('version', 1)
  if (!isSeq(doc.get('repos'))) doc.set('repos', doc.createNode([]))

  const existing = (doc.toJS() as { repos?: Array<{ name?: string; aliases?: string[]; path?: string }> }).repos ?? []
  for (const entry of existing) {
    const handles = [entry.name ?? '', ...(entry.aliases ?? [])].map((handle) => handle.trim().toLowerCase())
    if (handles.includes(name.toLowerCase())) {
      return { report: `"${name}" already names a repository in ${params.reposPath}; pass a different --name.`, exitCode: 1 }
    }
    if (entry.path !== undefined && realOrResolved(entry.path) === path) {
      return { report: `${path} is already registered as "${entry.name ?? '(unnamed)'}" in ${params.reposPath}.`, exitCode: 1 }
    }
  }

  const entry = {
    name,
    path,
    default_branch: await defaultBranch(git, path),
    permitted_operations: [...(params.operations ?? DEFAULT_OPERATIONS)],
  }
  doc.addIn(['repos'], doc.createNode(entry))

  mkdirSync(dirname(params.reposPath), { recursive: true })
  writeFileSync(params.reposPath, doc.toString())
  try {
    loadRepoRegistry(params.reposPath)
  } catch (error) {
    if (previous === undefined) rmSync(params.reposPath, { force: true })
    else writeFileSync(params.reposPath, previous)
    const reason = error instanceof Error ? error.message : String(error)
    return { report: `The new entry would make ${params.reposPath} invalid, so it was left unchanged: ${reason}`, exitCode: 1 }
  }

  return {
    report: [
      `Added "${entry.name}" to ${params.reposPath}:`,
      `  path: ${entry.path}`,
      `  default_branch: ${entry.default_branch}`,
      `  permitted_operations: [${entry.permitted_operations.join(', ')}]`,
      entry.permitted_operations.includes('publish')
        ? '`publish` is granted.'
        : '`publish` is not granted; add it and a `remote` by hand once you have watched a run.',
    ].join('\n'),
    exitCode: 0,
  }
}
