/**
 * Delivers a Slack reply into an open `relay codex` chat with
 * `codex queue --thread <chat id> --message=<text>`, which hands the message
 * to the chat's own Codex process on its login (measured on 2026-11-20: the
 * chat answered within two seconds, in a turn Codex marks as queue-started).
 *
 * A message counts as delivered only when the chat's saved record holds a
 * queue-started turn, written after the call, whose user message carries
 * this message's own id. Once `codex queue` took the message (or timed out
 * without saying), Relay waits for that turn as long as the chat stays open,
 * so a busy chat never gets the message answered twice; a clear refusal, or
 * the chat closing before the turn shows up, hands it back to Relay's loop.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { findRolloutById } from './codex-rollouts.js'
import type { CodexChatRecord } from './open-codex.js'

export const CODEX_QUEUE_TIMEOUT_MS = 15_000
/**
 * How long a taken message waits for its turn to show while the chat stays open. Past it the message counts as
 * delivered: the chat took it (or may have), and answering it with Relay's loop too would answer it twice if only
 * the turn's record changed shape in a Codex update.
 */
export const CODEX_TURN_WAIT_MS = 10 * 60 * 1000

export type QueueCall = 'accepted' | 'refused' | 'unknown'

export type CodexDelivery =
  /** `confirmed` false: the turn never showed within the wait, though the chat stayed open. */
  | { readonly outcome: 'delivered'; readonly confirmed: boolean }
  | { readonly outcome: 'not_delivered'; readonly reason: string }

export type CodexQueueDeps = {
  /** The configured codex binary. */
  readonly bin: string
  /** The shared sessions folder every Codex login saves its chats in. */
  readonly sessionsRoot: string
  /** Whether the chat is still open (its record and process). */
  readonly isOpen: () => Promise<boolean>
  readonly pollMs?: number
  readonly turnWaitMs?: number
  /** Injected for tests; runs `codex queue` and reports what it said. */
  readonly queue?: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ call: QueueCall; detail: string }>
  readonly now?: () => number
}

/** The text the chat receives: the message, its id (how its turn is recognised), and how to answer. */
export function codexQueueText(params: { messageId: string; body: string; replyCommand: string }): string {
  return [
    `Message from your operator in this chat's Slack thread (Relay message ${params.messageId}):`,
    params.body,
    '',
    `Answer in the thread with: ${params.replyCommand}`,
  ].join('\n')
}

/** Runs `codex queue` without a shell, on the chat's login, for at most 15 seconds. */
function runQueue(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ call: QueueCall; detail: string }> {
  return new Promise((resolve) => {
    execFile(bin, args as string[], { env, timeout: CODEX_QUEUE_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ call: 'accepted', detail: stdout.trim() })
        return
      }
      // Killed at the limit: it may already have handed the message over.
      if (error.killed === true || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        resolve({ call: 'unknown', detail: `codex queue gave no answer within ${CODEX_QUEUE_TIMEOUT_MS / 1000} seconds` })
        return
      }
      resolve({ call: 'refused', detail: (stderr.trim() || error.message).slice(0, 300) })
    })
  })
}

type Entry = { timestamp?: string; type?: string; payload?: { type?: string; role?: string; turn_attribution?: { turn_trigger?: string }; content?: unknown } }

/** True when the record holds a queue-started turn begun at or after `sinceMs` whose user message holds `token`. */
export function hasQueueTurn(rollout: string, token: string, sinceMs: number): boolean {
  let inQueueTurn = false
  for (const line of rollout.split('\n')) {
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    const payload = entry.payload
    if (entry.type === 'event_msg' && payload?.type === 'task_started') {
      inQueueTurn = payload.turn_attribution?.turn_trigger === 'queue' && Date.parse(entry.timestamp ?? '') >= sinceMs
      continue
    }
    if (!inQueueTurn || entry.type !== 'response_item' || payload?.role !== 'user') continue
    if (JSON.stringify(payload.content ?? '').includes(token)) return true
  }
  return false
}

/** Queues `text` (carrying `token`) into the open chat `chat`, and waits until it is delivered or cannot be. */
export async function deliverToCodexChat(chat: CodexChatRecord, text: string, token: string, deps: CodexQueueDeps): Promise<CodexDelivery> {
  const now = deps.now ?? Date.now
  // A second of slack for the clock of the turn's timestamp, which Codex writes in milliseconds.
  const since = now() - 1_000
  const queue = deps.queue ?? runQueue
  const { call, detail } = await queue(deps.bin, ['queue', '--thread', chat.chatId, `--message=${text}`], { ...process.env, CODEX_HOME: chat.codexHome })
  if (call === 'refused') return { outcome: 'not_delivered', reason: `codex queue refused it: ${detail}` }

  const pollMs = deps.pollMs ?? 1_000
  const deadline = now() + (deps.turnWaitMs ?? CODEX_TURN_WAIT_MS)
  let path: string | null = null
  for (;;) {
    const open = await deps.isOpen()
    path ??= await findRolloutById(deps.sessionsRoot, chat.chatId, since - 60_000)
    const rollout = path === null ? '' : await readFile(path, 'utf8').catch(() => '')
    if (hasQueueTurn(rollout, token, since)) return { outcome: 'delivered', confirmed: true }
    // Read after the open check, so a turn written just before the chat closed still counts.
    if (!open) return { outcome: 'not_delivered', reason: 'the chat closed before it took the message' }
    if (now() >= deadline) return { outcome: 'delivered', confirmed: false }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
