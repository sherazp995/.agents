/**
 * Where a Slackbot reminder goes once handleChatEvent has checked its
 * principal, membership and the kill switch: into a new read-only
 * autonomous task, and nowhere else. It never asks the folder question
 * (no one is there to answer a reminder), and when autonomous mode is off
 * or the thread already belongs to another session it stops with a log
 * line instead of falling through to the governed or direct paths, which
 * have no read-only limit.
 */
import type { ChatEvent, ChatRef } from './chat/contract.js'
import type { FolderQuestions } from './chat/slack/folder-questions.js'
import type { Logger } from './obs/logger.js'
import type { AutonomousRouting } from './orchestrator.js'

export type ReminderRouteDeps = {
  readonly autonomous?: AutonomousRouting
  readonly folderQuestions?: FolderQuestions
  readonly log: Logger
}

export async function routeReminder(deps: ReminderRouteDeps, event: ChatEvent, thread: { threadRef: string; replyRef: ChatRef }): Promise<void> {
  const context = { workspaceId: event.workspaceId, threadRef: thread.threadRef }
  if (!deps.autonomous) {
    deps.log.warn(context, 'ignored a Slackbot reminder: reminders only start read-only autonomous tasks, and autonomous mode is off')
    return
  }
  const chatCwd = await deps.folderQuestions?.existingChannelFolder(event.ref.channel)
  const routed = await deps.autonomous.route(event, thread, chatCwd !== undefined ? { chatCwd } : {})
  if (routed !== 'handled') deps.log.warn(context, 'ignored a Slackbot reminder: its thread already has a session, and a reminder only starts its own read-only task')
}
