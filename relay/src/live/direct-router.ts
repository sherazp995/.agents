/**
 * Routing a Slack thread to a direct Claude Code session.
 *
 * The operator's framing, which decides the shape of this: Relay is "a
 * simple mechanism for me to control my system from Slack when I'm not near
 * my machine". So `/direct` is one command, it takes an optional directory
 * and an optional first message, and everything after it in that thread goes
 * to the same session.
 *
 * WHY THE MODE IS STORED ON THE THREAD rather than re-derived per message.
 * A thread is a conversation, and asking "is this one direct?" of every
 * message means the answer can change halfway through, which is the one
 * thing a conversation must not do. It is decided once, when `/direct`
 * creates the session, and it stays decided.
 */

import { homedir } from 'node:os'
import { statSync } from 'node:fs'

import { runDirectTurn, renderSessionStarted } from './direct-session.js'
import type { DirectSessionDependencies } from './direct-session.js'
import { expandHome, parseDirectCommand } from './session-mode.js'

export type DirectStartRequest = {
  readonly text: string
  /** Where a `/direct` with no directory runs. The operator's default working folder. */
  readonly defaultDirectory: string
  readonly home?: string
}

export type DirectStartOutcome =
  | { readonly outcome: 'started'; readonly sessionId: string; readonly cwd: string; readonly text: string; readonly reply?: string }
  | { readonly outcome: 'refused'; readonly text: string }

/**
 * Handles `/direct`.
 *
 * The directory is validated before anything is spawned, because a session
 * started in the wrong place looks identical to one started in the right
 * place until the operator asks it to read a file, and by then it has a
 * transcript of its own in a directory nobody meant to use.
 */
export async function startDirectSession(
  request: DirectStartRequest,
  deps: DirectSessionDependencies = {},
): Promise<DirectStartOutcome> {
  const home = request.home ?? homedir()
  const parsed = parseDirectCommand(request.text)
  const cwd = expandHome(parsed.directory ?? request.defaultDirectory, home)

  // One guarded check rather than exists-then-stat: `statSync` throws on a
  // dangling symlink and on a path whose parent is unreadable, and an
  // unhandled throw here would take down the command rather than answer it.
  let isDirectory = false
  try {
    isDirectory = statSync(cwd).isDirectory()
  } catch {
    isDirectory = false
  }

  if (!isDirectory) {
    return {
      outcome: 'refused',
      text:
        `\`${cwd}\` is not a directory Relay can use, so no session was started. A session started in the wrong ` +
        'place looks identical to one started in the right place until you ask it to read a file.',
    }
  }

  // An opening message is optional. Without one the session still has to be
  // created, so it is given a minimal prompt rather than a made-up task: an
  // invented first turn would put words in the operator's mouth in a
  // transcript they can read later.
  const message = parsed.message ?? 'Say hello in one short line, and nothing else.'

  const turn = await runDirectTurn({ cwd, message }, deps)

  if (turn.outcome !== 'replied') {
    return { outcome: 'refused', text: `Could not start a session in \`${cwd}\`: ${turn.reason}` }
  }

  return {
    outcome: 'started',
    sessionId: turn.sessionId,
    cwd,
    text: renderSessionStarted(turn.sessionId, cwd),
    ...(parsed.message === undefined ? {} : { reply: turn.text }),
  }
}

/** A later message in a thread that is already direct. */
export async function continueDirectSession(
  cwd: string,
  sessionId: string,
  message: string,
  deps: DirectSessionDependencies = {},
): Promise<{ readonly text: string }> {
  const turn = await runDirectTurn({ cwd, resume: sessionId, message }, deps)

  if (turn.outcome === 'replied') return { text: turn.text }
  if (turn.outcome === 'resume_rejected') return { text: turn.reason }
  return { text: `That turn failed: ${turn.reason}` }
}
