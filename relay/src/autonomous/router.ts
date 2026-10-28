/**
 * Inbound side of a Slack chat, kept short because Slack delivery is one
 * serial queue: take the event in with `intakeMention` (one transaction),
 * record the inbound facts, wake the scheduler. Everything slow (file downloads, worker turns) is the
 * scheduler's.
 *
 * Slack does not redeliver an event whose handler failed (Bolt acks the
 * envelope on receipt), so the router retries the intake itself and, when
 * every attempt fails, throws IntakeFailedError for the adapter to release
 * the dedupe key and tell the thread.
 */

import type { Pool } from 'pg'
import { unwrapForAudit } from '../agent/untrusted.js'
import { IntakeFailedError, type ChatEvent, type ChatRef } from '../chat/contract.js'
import type { Logger } from '../obs/logger.js'
import { parseAgentPreference } from './accounts.js'
import { pendingFiles } from './files.js'
import { intakeMention, recordAgentPreference, type IntakeOutbox, type IntakeResult } from './store.js'

const INTAKE_ATTEMPTS = 3
/** Waits between attempts; together they stay inside two seconds. */
const RETRY_DELAYS_MS = [250, 750]

export const STOPPED_TEXT = 'This task is stopped.'

export type RouterDeps = {
  pool: Pool
  outbox: IntakeOutbox
  /** The folder a new thread's chat runs in, from its first message. */
  chatFolder: (text: string) => string
  /** Tells the scheduler a task has new work. */
  wake: () => void
  log: Logger
  sleep?: (ms: number) => Promise<void>
}

export type RouteResult = 'handled' | 'not_autonomous'

export async function routeAutonomousEvent(
  deps: RouterDeps,
  event: ChatEvent,
  thread: { threadRef: string; replyRef: ChatRef },
  options: { adopt?: boolean } = {},
): Promise<RouteResult> {
  const principalId = event.principalId
  if (principalId === null) return 'not_autonomous'
  const message = event.ref.message
  if (message === undefined) return 'not_autonomous'

  // Before anything is stored: the token value never reaches the database.
  // Stored as the sender's words; the scheduler renders it for the worker as untrusted data.
  const text = unwrapForAudit(event.text)

  const result = await intakeWithRetry(deps, {
    workspaceId: event.workspaceId,
    principalId,
    adapter: event.adapter,
    threadRef: thread.threadRef,
    event: {
      id: event.platformEventId,
      principalId,
      text,
      ref: event.ref,
      fileIds: event.files.map((file) => file.id),
      receivedAt: event.receivedAt,
    },
    replyRef: thread.replyRef,
    files: pendingFiles(event.files),
    adopt: options.adopt === true,
    chatCwd: deps.chatFolder(text),
  })
  if (result.kind === 'not_autonomous') return 'not_autonomous'
  if (result.kind === 'appended' && result.duplicate) return 'handled'

  const task = result.task
  // A stopped task takes no more work; the message is answered, never acted on.
  if (task.phase === 'stopped' || task.cancelRequestedAt !== null) {
    await deps.outbox.enqueue({ kind: 'post', ref: thread.replyRef, text: STOPPED_TEXT }, event.workspaceId)
    return 'handled'
  }
  const preference = result.kind === 'created' ? parseAgentPreference(text) : null
  if (preference !== null) await recordAgentPreference(deps.pool, task.id, preference)

  deps.wake()
  return 'handled'
}

async function intakeWithRetry(deps: RouterDeps, params: Parameters<typeof intakeMention>[1]): Promise<IntakeResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown
  for (let attempt = 0; attempt < INTAKE_ATTEMPTS; attempt += 1) {
    try {
      return await intakeMention(deps.pool, params)
    } catch (error) {
      lastError = error
      deps.log.warn({ err: error, attempt: attempt + 1 }, 'autonomous intake failed')
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay !== undefined) await sleep(delay)
    }
  }
  throw new IntakeFailedError('autonomous intake failed after retries', { cause: lastError })
}
