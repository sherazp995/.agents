/**
 * Starts a direct Claude Code session for a Slack thread and makes the
 * thread direct (FR-ATT-30): from a `direct` message, or from the answer to
 * the folder question that `direct` message raised
 * (src/chat/slack/folder-questions.ts). The owner check is repeated here
 * because the answer can arrive long after the request was checked.
 */

import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { OWNER_ONLY_REPLY, principalIsOwner } from '../tenancy/access.js'
import { findOrCreateSession, markSessionDirect } from '../sessions/store.js'
import { startDirectSession } from './direct-router.js'
import type { DirectSessionDependencies } from './direct-session.js'

export type DirectThreadRequest = {
  readonly workspaceId: string
  readonly principalId: string
  readonly threadRef: string
  /** The words after `direct`. */
  readonly text: string
  /** The channel's folder (or the one named in answer to the folder question); wins over the command's. */
  readonly channelDirectory?: string
  readonly post: (text: string) => Promise<unknown>
  readonly log?: Logger
}

export async function startDirectThread(pool: Pool, request: DirectThreadRequest, deps: DirectSessionDependencies = {}): Promise<void> {
  // Checked here, at the start itself: an answered folder question can start
  // a `direct` request up to a day after it was asked, and roles can change.
  if (!(await principalIsOwner(pool, request.workspaceId, request.principalId))) {
    await request.post(OWNER_ONLY_REPLY)
    return
  }

  const outcome = await startDirectSession(
    {
      text: request.text,
      defaultDirectory: process.cwd(),
      ...(request.channelDirectory !== undefined ? { channelDirectory: request.channelDirectory } : {}),
    },
    deps,
  )
  if (outcome.outcome !== 'started') {
    await request.post(outcome.text)
    return
  }

  // The turn has run: bind the thread before telling anyone, so a failed post
  // never leaves a session the thread cannot reach, and never fails the start.
  const session = await findOrCreateSession(pool, {
    workspaceId: request.workspaceId,
    principalId: request.principalId,
    adapter: 'slack',
    threadRef: request.threadRef,
  })
  await markSessionDirect(pool, session.id, outcome.sessionId, outcome.cwd)

  await postAfterStart(request, outcome.text)
  // Scrubbed for the same reason every other reply path is: this text came
  // from a session that reads arbitrary files.
  if (outcome.reply !== undefined && outcome.reply.trim() !== '') {
    await postAfterStart(request, scrubSecrets(outcome.reply))
  }
}

async function postAfterStart(request: DirectThreadRequest, text: string): Promise<void> {
  try {
    await request.post(text)
  } catch (error) {
    request.log?.warn({ err: error, threadRef: request.threadRef }, 'a direct session started but its reply could not be posted')
  }
}
