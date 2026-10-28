/**
 * FR-ATT-1 and FR-ATT-2: discovers the Claude Code sessions that already
 * exist on this machine, so the operator can attach Relay to one from their
 * phone without going and looking for it.
 *
 * Claude Code stores one JSONL transcript per session, grouped into a
 * directory per working directory, under `~/.claude/projects`. The directory
 * name is the working directory with separators replaced, which is lossy:
 * `/Users/you/.projects/relay` becomes `-Users-you--projects-relay`,
 * so a dot and a separator both collapse to the same character and the
 * original path cannot be recovered from the name. Every transcript record
 * carries an explicit `cwd` field, so that is read instead. Verified against
 * real transcripts on this machine before this module was written.
 *
 * FR-SEC-1 governs everything here, and it is why a session is identified by
 * its working directory and its recency rather than by anything said in it.
 *
 * The first draft of this module derived a human readable label from the
 * session's opening message and scrubbed it. That was wrong. The scrubber in
 * src/secrets/scrubber.ts is a registry of values Relay itself brokered, by
 * deliberate design, so it cannot redact a credential Relay never issued: a
 * key the operator pasted into a chat, a customer record, a quoted file. A
 * transcript is the most secret dense artifact on this machine, and a label
 * drawn from one imports that entire exposure for a cosmetic gain. The
 * operator's standing instruction is that a response carries what they asked
 * for and nothing else.
 *
 * So this module reads a bounded prefix of each transcript, takes the working
 * directory out of it, and discards the rest. No transcript content is
 * returned, which makes the exposure impossible by construction rather than
 * dependent on a redaction being correct.
 */

import { readdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * How much of a transcript's head is read to recover its working directory.
 * Transcripts reach tens of megabytes, so reading one whole would be both
 * slow and an unnecessary exposure of content this module has no business
 * handling.
 */
const TRANSCRIPT_PREFIX_BYTES = 64 * 1024

export type EngineSession = {
  /** The session id, which is what `claude --resume` takes. */
  readonly sessionId: string
  /** The working directory the session ran in, read from the transcript rather than decoded from the directory name. */
  readonly cwd: string
  /** Last write to the transcript. The ordering key, and the input to liveness. */
  readonly lastModifiedAt: Date
  readonly sizeBytes: number
}

export type ListEngineSessionsOptions = {
  /** Defaults to `~/.claude/projects`. Injected so tests never touch the operator's real sessions. */
  readonly root?: string
  /** Restricts the result to sessions whose working directory matches exactly. */
  readonly cwd?: string
  /** Only chats a person opened in the terminal (entrypoint `cli`), leaving out `claude -p` runs such as relay's workers and couriers. */
  readonly interactiveOnly?: boolean
  readonly limit?: number
}

/**
 * Reads the head of a transcript and pulls out its working directory and
 * entrypoint, discarding everything else. The return type is deliberately narrow: it
 * carries one path and one label and no content, so no caller can accidentally surface
 * transcript text through this module.
 */
async function readTranscriptHead(path: string): Promise<{ cwd: string; entrypoint: string | undefined } | undefined> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, TRANSCRIPT_PREFIX_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')

    // The final line of a bounded read is usually truncated, so it is dropped
    // rather than parsed. A record split across the boundary is not a record.
    const lines = text.split('\n')
    lines.pop()

    for (const line of lines) {
      if (line === '') continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        // A transcript is an append log written by another process, so a torn
        // or partial line is expected rather than exceptional. One unreadable
        // line is not a reason to hide a session the operator may want.
        continue
      }
      if (typeof record !== 'object' || record === null) continue
      const cwd = (record as Record<string, unknown>)['cwd']
      const entrypoint = (record as Record<string, unknown>)['entrypoint']
      if (typeof cwd === 'string') return { cwd, entrypoint: typeof entrypoint === 'string' ? entrypoint : undefined }
    }

    return undefined
  } finally {
    await handle.close()
  }
}

export function defaultSessionsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/**
 * Enumerates every session under `root`, most recently written first.
 *
 * A session whose transcript cannot be read or parsed is omitted rather than
 * raising: discovery runs on the operator's whole machine, and one unreadable
 * file must not deny them access to every other session.
 */
export async function listEngineSessions(options: ListEngineSessionsOptions = {}): Promise<readonly EngineSession[]> {
  const root = options.root ?? defaultSessionsRoot()

  let projectDirs: readonly string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }

  const sessions: EngineSession[] = []

  for (const dir of projectDirs) {
    const dirPath = join(root, dir)
    let files: readonly string[]
    try {
      files = await readdir(dirPath)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dirPath, file)

      try {
        const stats = await stat(path)
        if (!stats.isFile()) continue
        const head = await readTranscriptHead(path)
        // A transcript with no cwd cannot be resumed correctly, because the
        // working directory is what gives the session its project settings,
        // skills, and agents. Offering it would produce a session that looks
        // right and behaves wrongly, so it is omitted.
        if (head === undefined) continue
        if (options.interactiveOnly === true && head.entrypoint !== 'cli') continue
        const cwd = head.cwd
        if (options.cwd !== undefined && cwd !== options.cwd) continue

        sessions.push({
          sessionId: file.slice(0, -'.jsonl'.length),
          cwd,
          lastModifiedAt: stats.mtime,
          sizeBytes: stats.size,
        })
      } catch {
        continue
      }
    }
  }

  sessions.sort((a, b) => b.lastModifiedAt.getTime() - a.lastModifiedAt.getTime())

  return options.limit === undefined ? sessions : sessions.slice(0, options.limit)
}
