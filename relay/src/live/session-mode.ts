/**
 * Which of Relay's two modes a Slack thread is in.
 *
 * The operator's own framing, which is the one that matters: Relay is "a
 * simple mechanism to control my system from Slack when I'm not near my
 * machine". Everything else this system does is in service of the governed
 * mode, and the governed mode is not always what someone wants at ten at
 * night from a phone.
 *
 *   - DIRECT: an ordinary `claude` session in a directory. Relay carries
 *     messages to it and answers back. The conversation is Claude Code's, on
 *     disk, resumable at a keyboard. UNMEDIATED (FR-ATT-30): outside the
 *     sandbox, the policy engine, approvals and budget caps.
 *   - GOVERNED: Relay's own loop, with all of that machinery.
 *   - AUTONOMOUS: a task opened by a mention. Relay runs the operator's
 *     headless CLIs through interview, plan approval and the work itself,
 *     under its own guard (src/autonomous).
 *
 * THE DEFAULT IS GOVERNED, and that asymmetry is on purpose. A thread that
 * has not said which it wants gets the mode with the guarantees. Becoming
 * unmediated is something the operator asks for explicitly; it is never
 * somewhere they end up by omission.
 */

export const SESSION_MODES = ['direct', 'governed', 'autonomous'] as const
export type SessionMode = (typeof SESSION_MODES)[number]

export const DEFAULT_SESSION_MODE: SessionMode = 'governed'

/** The slash command that puts a thread in direct mode, declared in docs/slack-app-manifest.yaml. */
export const DIRECT_SLASH_COMMAND = '/direct'

export type DirectRequest = {
  /** Where the session runs. Absent means the configured default directory. */
  readonly directory?: string
  /** The first message, when the operator sent one with the command. */
  readonly message?: string
}

/**
 * Parses `/direct [directory] [message]`.
 *
 * The directory is recognised by SHAPE rather than by position alone: a
 * leading `~` or `/` is a path and anything else is the start of the
 * message. Requiring a directory every time would make the common case
 * ("just talk to my machine") the awkward one, and guessing that the first
 * word is always a path would turn `/direct check the logs` into a session
 * in a directory called "check".
 */
export function parseDirectCommand(text: string): DirectRequest {
  const trimmed = text.trim()
  if (trimmed === '') return {}

  const [first, ...rest] = trimmed.split(/\s+/)
  const looksLikePath = first !== undefined && (first.startsWith('/') || first.startsWith('~') || first.startsWith('./'))

  if (!looksLikePath) return { message: trimmed }

  const message = rest.join(' ').trim()
  return { directory: first, ...(message === '' ? {} : { message }) }
}

/** Expands a leading `~`, since an operator typing on a phone will. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`
  return path
}

/**
 * What a thread is told when it has no session yet and the operator has not
 * said which mode they want.
 *
 * Deliberately short. This appears in a thread where someone asked for
 * something, and a wall of explanation about two execution models is not an
 * answer to what they asked.
 */
export function renderModeHint(): string {
  return 'Running this under Relay\'s policy, approvals and sandbox. Use `/direct` instead for a plain Claude Code session in a directory, which is faster and unmediated.'
}
