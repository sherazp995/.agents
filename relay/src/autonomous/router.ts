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

export const STOPPED_TEXT = 'This task has ended. Start a new message to begin a new task.'
/**
 * A message that lands while a Stop is still shutting the work down. The pause keeps only messages
 * Relay received after the "stop" (by the adapter's receive time), so one sent just before it but
 * routed late is dropped: the reply promises only what holds in both cases.
 */
export const STILL_STOPPING_TEXT = 'Still stopping. Messages sent after the stop will be picked up once it finishes.'
export const REMINDER_NO_FOLDER_TEXT =
  "I could not tell which folder this reminder is about. Name the repo in the reminder's text, or put the folder in this channel's description."

export type RouterDeps = {
  pool: Pool
  outbox: IntakeOutbox
  /** The folder a new thread's chat runs in, from its first message. */
  chatFolder: (text: string) => string
  /** The folder a reminder's text names, with no fallback: a reminder runs where it says or not at all. */
  reminderFolder: (text: string) => string | undefined
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
  options: { adopt?: boolean; chatCwd?: string } = {},
): Promise<RouteResult> {
  const principalId = event.principalId
  if (principalId === null) return 'not_autonomous'
  const message = event.ref.message
  if (message === undefined) return 'not_autonomous'

  // Before anything is stored: the token value never reaches the database.
  // Stored as the sender's words; the scheduler renders it for the worker as untrusted data.
  const text = unwrapForAudit(event.text)
  const reminder = event.origin === 'reminder'
  const chatCwd = options.chatCwd ?? (reminder ? deps.reminderFolder(text) : deps.chatFolder(text))
  if (chatCwd === undefined) {
    await deps.outbox.enqueue({ kind: 'post', ref: thread.replyRef, text: REMINDER_NO_FOLDER_TEXT }, event.workspaceId)
    return 'handled'
  }

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
      ...(reminder ? { origin: 'reminder' as const } : {}),
    },
    replyRef: thread.replyRef,
    files: pendingFiles(event.files),
    // A reminder never adopts another session: it only ever starts its own read-only task.
    adopt: options.adopt === true && !reminder,
    // A folder decided before routing (the channel's) wins over the message's.
    chatCwd,
    ...(reminder ? { readOnly: true } : {}),
  })
  if (result.kind === 'not_autonomous') return 'not_autonomous'
  if (result.kind === 'appended' && result.duplicate) return 'handled'

  const task = result.task
  // An ended task takes no more work; the message is answered, never acted on.
  if (task.phase === 'stopped') {
    await deps.outbox.enqueue({ kind: 'post', ref: thread.replyRef, text: STOPPED_TEXT }, event.workspaceId)
    return 'handled'
  }
  // A Stop still in progress: the message stays pending and the pause wakes the task for it.
  if (task.cancelRequestedAt !== null) {
    await deps.outbox.enqueue({ kind: 'post', ref: thread.replyRef, text: STILL_STOPPING_TEXT }, event.workspaceId)
    return 'handled'
  }
  const preference = result.kind === 'created' ? parseAgentPreference(text) : null
  // The task is already committed: a failed preference write must not read as a failed intake (that would ask for a resend).
  if (preference !== null) {
    await recordAgentPreference(deps.pool, task.id, preference).catch((error: unknown) => {
      deps.log.warn({ err: error, taskId: task.id }, 'could not record the agent preference; the task runs with the default')
    })
  }

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
