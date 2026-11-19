/**
 * The env each session of a thread starts with, and whether it changed since
 * (README, "Envs for Relay's sessions"). A thread's own session keeps a
 * snapshot of the folder and laptop it started with, so the change check
 * resolves the same place again: the task row's stored folder may be the
 * other laptop's path. The check compares entry versions only and opens
 * nothing.
 */

import type { Logger } from '../obs/logger.js'
import { currentEnvFingerprint, resolveWorkerEnv, type EnvPlace, type EnvSource } from './resolve.js'
import { WorkerEnvError } from './store.js'

export type SessionEnvOutcome =
  | { readonly kind: 'ready'; readonly env: Readonly<Record<string, string>> }
  /** A matching stored value cannot be read here; the session must not start. `reason` names the scope, never a value. */
  | { readonly kind: 'unreadable'; readonly reason: string }

export type SessionEnvDeps = {
  readonly source: EnvSource
  readonly host: string | null
  readonly home: string
  readonly homes: () => Promise<readonly string[]>
  readonly repos: () => readonly string[]
  /** The channel description's (or DM thread's) values for `threadRef`; {} when none or unreadable. */
  readonly fallback: (threadRef: string) => Promise<Readonly<Record<string, string>>>
  readonly log: Logger
}

export type SessionEnvs = {
  /**
   * The env for a session in `cwd`. With `track`, the session is the
   * thread's own and its place and fingerprint are kept for changedSince.
   */
  forSession(params: { taskId: string; threadRef: string; cwd: string; track: boolean }): Promise<SessionEnvOutcome>
  /** True when the env the thread's session started with is no longer current. Throws when it cannot tell. */
  changedSince(taskId: string): Promise<boolean>
  forget(taskId: string): void
}

type Snapshot = { threadRef: string; place: EnvPlace; fingerprint: string }

export const DATABASE_UNREADABLE = 'The stored envs could not be read from the database.'

export function createSessionEnvs(deps: SessionEnvDeps): SessionEnvs {
  const startedWith = new Map<string, Snapshot>()
  const placeFor = async (cwd: string): Promise<EnvPlace> => ({ host: deps.host, cwd, home: deps.home, homes: await deps.homes(), repos: deps.repos() })
  return {
    async forSession({ taskId, threadRef, cwd, track }) {
      try {
        const place = await placeFor(cwd)
        const resolved = await resolveWorkerEnv(deps.source, place, await deps.fallback(threadRef))
        if (track) startedWith.set(taskId, { threadRef, place, fingerprint: resolved.fingerprint })
        return { kind: 'ready', env: resolved.env }
      } catch (error) {
        if (error instanceof WorkerEnvError) return { kind: 'unreadable', reason: error.message }
        deps.log.warn({ err: error, taskId }, 'could not read the stored envs; the session waits')
        return { kind: 'unreadable', reason: DATABASE_UNREADABLE }
      }
    },
    async changedSince(taskId) {
      const before = startedWith.get(taskId)
      if (before === undefined) return false
      return (await currentEnvFingerprint(deps.source, before.place, await deps.fallback(before.threadRef))) !== before.fingerprint
    },
    forget(taskId) {
      startedWith.delete(taskId)
    },
  }
}
