/**
 * Picks the stored envs that apply to one session (README, "Envs for Relay's
 * sessions"). Per name, the order is: daemon env < channel description
 * (fallback) < default < this machine < folder < folder on this machine.
 * Inside a folder layer the deepest matching folder wins. Only the winners
 * are ever opened, so an entry for another folder that this laptop cannot
 * read never blocks a session.
 */

import { createHash } from 'node:crypto'
import { basename, dirname, sep } from 'node:path'
import type { Pool } from 'pg'
import { mapPath } from '../failover/paths.js'
import type { ReaderKey } from './seal.js'
import { localFolder } from './scope.js'
import { describeScope, isMissingTable, listEntries, openEntries, WorkerEnvError, type EnvEntry } from './store.js'

/** Where a session runs: this laptop's failover name (null when failover is off), its folder, and what maps stored paths here. */
export type EnvPlace = {
  readonly host: string | null
  readonly cwd: string
  readonly home: string
  /** Every laptop home failover knows, so a folder stored under the other laptop's home matches here. */
  readonly homes: readonly string[]
  /** The registered repositories' folders. */
  readonly repos: readonly string[]
}

/** What reads the stored envs: `key` is null when this laptop has no env key (keystore unavailable). */
export type EnvSource = { readonly pool: Pool; readonly workspaceId: string; readonly key: ReaderKey | null }

export type ResolvedEnv = { readonly env: Readonly<Record<string, string>>; readonly fingerprint: string }

/** True when `folder` is a `<repo>-<name>` worktree next to `repo`. */
export function isSiblingWorktree(folder: string, repo: string): boolean {
  return dirname(folder) === dirname(repo) && basename(folder).startsWith(`${basename(repo)}-`)
}

/** 1 default, 2 this machine, 3 folder, 4 folder on this machine; undefined for another machine's entry. */
function layerOf(entry: EnvEntry, host: string | null): number | undefined {
  if (entry.host !== '' && entry.host !== host) return undefined
  const machine = entry.host !== '' ? 1 : 0
  return entry.folder === '' ? 1 + machine : 3 + machine
}

function trimSep(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path
}

function isAtOrUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === sep ? sep : folder + sep)
}

/**
 * The stored folder as a path here when the session folder is it or sits
 * inside it, at a path component boundary, or sits in a `<repo>-<name>`
 * worktree of it when it is a registered repository and the worktree is not
 * one itself (decision 3).
 */
function matchedFolder(stored: string, place: EnvPlace, repos: readonly string[], cwd: string): string | undefined {
  const folder = trimSep(mapPath(localFolder(stored, place.home), place.homes, place.home))
  if (isAtOrUnder(cwd, folder)) return folder
  if (!repos.includes(folder)) return undefined
  const parent = dirname(folder)
  if (!cwd.startsWith(parent === sep ? sep : parent + sep)) return undefined
  const top = cwd.slice(parent.length).split(sep).filter((part) => part !== '')[0]
  if (top === undefined) return undefined
  const worktree = `${parent === sep ? '' : parent}${sep}${top}`
  // A sibling that is itself a registered repository (`app-admin` next to `app`) is not a worktree of it.
  return isSiblingWorktree(worktree, folder) && !repos.includes(worktree) ? folder : undefined
}

type Ranked = { entry: EnvEntry; rank: readonly [number, number, number] }

/** a before b when a should win; the last tie breaks on the stored text and id, never on row order. */
function beats(a: Ranked, b: Ranked): boolean {
  for (let i = 0; i < a.rank.length; i++) {
    if (a.rank[i] !== b.rank[i]) return (a.rank[i] ?? 0) > (b.rank[i] ?? 0)
  }
  if (a.entry.folder !== b.entry.folder) return a.entry.folder > b.entry.folder
  return a.entry.id > b.entry.id
}

/** The winning entry per name for `place`, by name. Opens nothing. */
export function pickEntries(entries: readonly EnvEntry[], place: EnvPlace): EnvEntry[] {
  const cwd = trimSep(place.cwd)
  const repos = place.repos.map((repo) => trimSep(mapPath(repo, place.homes, place.home)))
  const best = new Map<string, Ranked>()
  for (const entry of entries) {
    const layer = layerOf(entry, place.host)
    if (layer === undefined) continue
    let depth = 0
    if (entry.folder !== '') {
      const folder = matchedFolder(entry.folder, place, repos, cwd)
      if (folder === undefined) continue
      depth = folder.length
    }
    const candidate: Ranked = { entry, rank: [layer, depth, entry.folder.length] }
    const current = best.get(entry.name)
    if (current === undefined || beats(candidate, current)) best.set(entry.name, candidate)
  }
  return [...best.values()].map((ranked) => ranked.entry).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The description values a stored winner does not override. */
function fallbackLeft(winners: readonly EnvEntry[], fallback: Readonly<Record<string, string>>): [string, string][] {
  const stored = new Set(winners.map((entry) => entry.name))
  return Object.entries(fallback)
    .filter(([name]) => !stored.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Changes when a winner is added, removed, replaced or swapped for another,
 * or a description value still in use changes. Values are hashed, never kept.
 */
export function envFingerprint(winners: readonly EnvEntry[], fallback: Readonly<Record<string, string>>): string {
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  const parts = [
    ...winners.map((entry) => ['stored', entry.name, entry.id, entry.updatedAt.toISOString()]),
    ...fallbackLeft(winners, fallback).map(([name, value]) => ['fallback', name, hash(value)]),
  ]
  return hash(JSON.stringify(parts))
}

/** The winners for `place`; none on a database without the env tables. */
export async function storedWinners(source: EnvSource, place: EnvPlace): Promise<EnvEntry[]> {
  try {
    return pickEntries(await listEntries(source.pool, source.workspaceId, { host: place.host ?? '' }), place)
  } catch (error) {
    if (isMissingTable(error)) return []
    throw error
  }
}

/**
 * The env for a session at `place`: the description `fallback` under the
 * stored winners. Throws a WorkerEnvError when a winner cannot be read here.
 */
export async function resolveWorkerEnv(source: EnvSource, place: EnvPlace, fallback: Readonly<Record<string, string>>): Promise<ResolvedEnv> {
  const winners = await storedWinners(source, place)
  const first = winners[0]
  if (first !== undefined && source.key === null) {
    throw new WorkerEnvError('unreadable', `This laptop has no env key in its keystore, so it cannot read the env ${describeScope(first)}. Check the Relay log for the keystore problem.`)
  }
  const opened = source.key === null ? new Map<string, string>() : await openEntries(source.pool, source.workspaceId, source.key, winners)
  const env: Record<string, string> = Object.fromEntries(fallbackLeft(winners, fallback))
  for (const entry of winners) {
    const value = opened.get(entry.id)
    if (value !== undefined) env[entry.name] = value
  }
  return { env, fingerprint: envFingerprint(winners, fallback) }
}

/** The fingerprint resolveWorkerEnv would give now, without opening any value. */
export async function currentEnvFingerprint(source: EnvSource, place: EnvPlace, fallback: Readonly<Record<string, string>>): Promise<string> {
  return envFingerprint(await storedWinners(source, place), fallback)
}
