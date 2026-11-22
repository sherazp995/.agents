/**
 * Shapes shared by Relay's shell from Slack (README, "Shell from Slack"): a
 * message whose lines start with `!` runs those lines one by one in the
 * owner's login shell, stops at the first failure, and edits one reply.
 *
 * parse.ts reads the message, run-line.ts runs one line, askpass.ts answers
 * sudo's password prompt, format.ts renders the reply, job.ts runs a whole
 * message, and src/chat/slack/shell-password.ts is the Slack button and popup.
 */

/** One Slack message read as shell lines. `commands` keep the text after each `!`, trimmed. */
export type ShellMessage =
  | { readonly kind: 'not_shell' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'shell'; readonly commands: readonly string[] }

/** A line's combined stdout and stderr: everything when it fits in `head`, else its first and last bytes and how many were left out between them. */
export type CapturedOutput = { readonly head: string; readonly tail: string; readonly omittedBytes: number }

export type LineOutcome =
  | { readonly kind: 'exited'; readonly code: number }
  /** Relay stopped it: its time limit, or a Stop, the kill switch, a handover or shutdown (`reason` says which). */
  | { readonly kind: 'killed'; readonly why: 'timeout' | 'cancelled'; readonly reason: string }
  /** Ended by a signal Relay did not send. */
  | { readonly kind: 'signal'; readonly signal: string }
  | { readonly kind: 'spawn_failed'; readonly message: string }

export type LineResult = {
  readonly command: string
  readonly outcome: LineOutcome
  readonly output: CapturedOutput
  /** The folder the line ended in when it exited 0; otherwise the folder it started in. */
  readonly folderAfter: string
}

export function lineSucceeded(result: LineResult): boolean {
  return result.outcome.kind === 'exited' && result.outcome.code === 0
}

/**
 * What puts Relay's `sudo` wrapper in front of the real one. `binDir` holds an
 * executable `sudo` that runs `/usr/bin/sudo -A "$@"`; it goes first on PATH
 * inside the command, after the login profile ran (macOS's path_helper
 * reorders PATH there). `env` holds SUDO_ASKPASS and the socket and token the
 * askpass helper needs.
 */
export type SudoSetup = { readonly binDir: string; readonly env: Readonly<Record<string, string>> }

export type RunLineOptions = {
  readonly command: string
  readonly cwd: string
  /** The login shell, run as `<shell> -l -c <script>`. */
  readonly shell: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  /** Aborting kills the line; `signal.reason` (a string) becomes the outcome's reason. */
  readonly signal?: AbortSignal
  readonly sudo?: SudoSetup
  /** How long after SIGTERM to the group before SIGKILL. */
  readonly graceMs?: number
  readonly headBytes?: number
  readonly tailBytes?: number
}

/** A pending sudo password request, as the job sees it. */
export type PasswordRequest = { readonly prompt: string }

/** Answers one password request: the password, or undefined to make sudo fail (timed out, cancelled). */
export type PasswordAnswerer = (request: PasswordRequest, signal: AbortSignal) => Promise<string | undefined>

export type AskpassHandle = {
  readonly sudo: SudoSetup
  /** Closes the socket, fails any waiting helper, and removes the private folder. */
  close(): Promise<void>
}

/** Everything the reply shows; format.ts renders it, job.ts fills it in as lines run. */
export type ShellReport = {
  /** The folder the message started in. */
  readonly folder: string
  /** The thread's Claude or Codex chat folder, shown only when it differs from `folder`. */
  readonly sessionFolder?: string
  /** This laptop's failover name, shown when failover is on. */
  readonly host?: string
  readonly results: readonly LineResult[]
  /** The line running now, when the job is still going. */
  readonly running?: string | undefined
  /** Lines not run yet, while the job is still going. */
  readonly pending: readonly string[]
  /** Lines skipped after a failure. */
  readonly skipped: readonly string[]
  /** One line of status under the results: waiting for a password, stopped, refused, and so on. */
  readonly notice?: string | undefined
}

/** Posts and edits one shell reply straight through Slack's API (not the outbox), so edits land in the order the job makes them and no password card outlives the result. */
export type ShellReplyPort = {
  post(args: { readonly channel: string; readonly thread: string; readonly text: string; readonly blocks: readonly Record<string, unknown>[] }): Promise<{ readonly channel: string; readonly ts: string }>
  update(args: { readonly channel: string; readonly ts: string; readonly text: string; readonly blocks: readonly Record<string, unknown>[] }): Promise<void>
}

/** The Slack side of a password request (src/chat/slack/shell-password.ts calls these). `requestId` is random and single use; it travels in the button's value. */
export type ShellPasswordPort = {
  /** Whether this Slack user may open the popup for this request: it is still waiting, and the user is the owner who sent the message. */
  canAnswer(request: { readonly requestId: string; readonly platformUserId: string }): Promise<boolean>
  /** Hands the password to the waiting sudo. Every other answer leaves the request as it was, except `accepted`, which uses it up. */
  submit(request: { readonly requestId: string; readonly platformUserId: string; readonly password: string }): Promise<'accepted' | 'refused' | 'expired'>
  /** The Cancel button: sudo fails at once. */
  cancel(request: { readonly requestId: string; readonly platformUserId: string }): Promise<'cancelled' | 'refused' | 'expired'>
}

/** Per command time limit (the user chose 5 minutes, password wait included). */
export const SHELL_LINE_TIMEOUT_MS = 5 * 60_000
/** How long a password request waits for an answer in Slack. */
export const SHELL_PASSWORD_TIMEOUT_MS = 2 * 60_000
/** SIGTERM to SIGKILL. */
export const SHELL_KILL_GRACE_MS = 3_000
