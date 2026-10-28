/**
 * Inbound side of an autonomous task, kept short because Slack delivery is
 * one serial queue: redact any extension token, take the event in with
 * `intakeMention` (one transaction), record the inbound facts, wake the
 * scheduler. Everything slow (file downloads, worker turns) is the
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
import { registerSecretValue } from '../secrets/scrubber.js'
import { parseAgentPreference } from './accounts.js'
import { extensionTokenKey, parseExtensionToken, type TaskSecretStore } from './extension-grant.js'
import { pendingFiles } from './files.js'
import { intakeMention, recordInboundFacts, type IntakeOutbox, type IntakeResult } from './store.js'

const INTAKE_ATTEMPTS = 3
/** Waits between attempts; together they stay inside two seconds. */
const RETRY_DELAYS_MS = [250, 750]

export const STOPPED_TEXT = 'This task is stopped.'

export type RouterDeps = {
  pool: Pool
  outbox: IntakeOutbox
  secrets: TaskSecretStore
  isOperator: (principalId: string) => Promise<boolean>
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
  const { text, token } = parseExtensionToken(unwrapForAudit(event.text))
  if (token !== null) registerSecretValue(token)

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
    mentionRef: { ...event.ref, channel: event.ref.channel, message },
    replyRef: thread.replyRef,
    files: pendingFiles(event.files),
    adopt: options.adopt === true,
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
  if (preference !== null) await recordInboundFacts(deps.pool, task.id, { agentPreference: preference })
  if (token !== null) await grantExtension(deps, { taskId: task.id, workspaceId: event.workspaceId, requesterPrincipalId: task.requesterPrincipalId }, principalId, token, thread.replyRef)

  deps.wake()
  return 'handled'
}

async function intakeWithRetry(deps: RouterDeps, params: Parameters<typeof intakeMention>[2]): Promise<IntakeResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown
  for (let attempt = 0; attempt < INTAKE_ATTEMPTS; attempt += 1) {
    try {
      return await intakeMention(deps.pool, deps.outbox, params)
    } catch (error) {
      lastError = error
      deps.log.warn({ err: error, attempt: attempt + 1 }, 'autonomous intake failed')
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay !== undefined) await sleep(delay)
    }
  }
  throw new IntakeFailedError('autonomous intake failed after retries', { cause: lastError })
}

/**
 * Only the requester or an operator may grant. A new token replaces the old
 * one and takes effect at the next spawn. Relay cannot delete the sender's
 * Slack message, so the reply asks them to.
 */
async function grantExtension(
  deps: RouterDeps,
  task: { taskId: string; workspaceId: string; requesterPrincipalId: string },
  senderPrincipalId: string,
  token: string,
  replyRef: ChatRef,
): Promise<void> {
  const allowed = senderPrincipalId === task.requesterPrincipalId || (await deps.isOperator(senderPrincipalId))
  if (!allowed) {
    await deps.outbox.enqueue(
      { kind: 'post', ref: replyRef, text: 'Only the requester or an operator can grant the extension; please delete that token.' },
      task.workspaceId,
    )
    return
  }
  await deps.secrets.set(extensionTokenKey(task.taskId), token)
  await recordInboundFacts(deps.pool, task.taskId, { extensionGrantedBy: senderPrincipalId })
  await deps.outbox.enqueue(
    { kind: 'post', ref: replyRef, text: 'Extension granted; please delete the token message.' },
    task.workspaceId,
  )
}
