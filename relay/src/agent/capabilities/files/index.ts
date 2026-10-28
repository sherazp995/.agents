/**
 * FR-SH-2, FR-SH-3, FR-SH-4: the path-scoped filesystem capability.
 *
 * `shell` refuses `rm` and tells the model deletion belongs here, which was a
 * promise shipped code could not keep until this existed.
 *
 * THREE RULES, each from its own requirement:
 *
 *   - FR-SH-2, SCOPE. Every path is checked against configured roots, after
 *     resolving symlinks and `..`, so the decision is about the file the
 *     operation would really touch. Its acceptance criterion is that reading
 *     `~/.ssh/id_rsa` is refused by default, and with no roots configured
 *     EVERYTHING is refused, because "unconfigured" must not read as "open".
 *   - FR-SH-3, PREVIEW. A mutating operation returns the list of affected
 *     paths and does nothing, unless the caller confirms. The threshold is
 *     one, so any mutation previews first; an irreversible one always does,
 *     whatever the count.
 *   - FR-SH-4, TRASH. A delete is a move into a dated trash directory,
 *     recoverable for seven days. Where it cannot be made recoverable, it is
 *     ABANDONED rather than completed.
 *
 * WHY PREVIEW IS A RETURN VALUE RATHER THAN AN APPROVAL PROMPT. Relay
 * already has an approval path, and routing this through it would ask the
 * operator to adjudicate every single-file write, which is how an approval
 * prompt becomes something people click through. Instead the model sees
 * exactly what would change and must say so back, which keeps the human in
 * the loop for the thing that matters, the RISK TIER, without spending their
 * attention on each write.
 */

import { z } from 'zod'
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { loadPolicy } from '../../../config/load.js'
import { defaultPolicyPath, resolveRelayHome } from '../../../config/paths.js'
import { checkPathScope } from './scope.js'
import { moveToTrash } from './trash.js'
import type { Capability } from '../../loop.js'
import type { CapabilityDefinition } from '../../../capabilities/registry.js'

export const FILES_CAPABILITY_NAME = 'files'

/** Enough to read a source file whole; small enough that one read cannot fill a context window. */
export const MAX_FILE_READ_CHARACTERS = 100_000

/** FR-SH-3's default threshold. One, so every mutation previews before it happens. */
export const PREVIEW_THRESHOLD = 1

export const filesInputSchema = z
  .object({
    operation: z.enum(['read', 'write', 'list', 'move', 'copy', 'delete', 'stat']),
    path: z.string().trim().min(1, 'a path is required'),
    /** The second path, for move and copy. */
    destination: z.string().trim().min(1).optional(),
    /** The content, for write. */
    content: z.string().optional(),
    /**
     * FR-SH-3: set only after seeing a preview, to carry it out. Named for
     * what it means rather than `force`, which reads like a way past a
     * safety check rather than the second half of one.
     */
    confirm: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.operation === 'move' || input.operation === 'copy') && input.destination === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['destination'], message: `${input.operation} needs a destination` })
    }
    if (input.operation === 'write' && input.content === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'write needs content' })
    }
  })

export type FilesInput = z.infer<typeof filesInputSchema>

export type FilesOutput = {
  readonly ok: boolean
  readonly refused?: string
  /** FR-SH-3's preview: what WOULD change, with nothing changed yet. */
  readonly preview?: { readonly action: string; readonly affected: readonly string[]; readonly irreversible: boolean; readonly confirm_with: string }
  readonly content?: string
  readonly truncated?: boolean
  readonly entries?: readonly string[]
  readonly stat?: Record<string, unknown>
  readonly moved_to?: string
  readonly trashed_to?: string
  readonly recoverable_until?: string
}

/** Operations that change something. Everything here previews before it acts. */
const MUTATING = new Set(['write', 'move', 'copy', 'delete'])

/** Delete is the one that cannot be undone by re-running the inverse, which is why it always previews regardless of count. */
const IRREVERSIBLE = new Set(['delete'])

export type FilesDependencies = {
  readonly roots?: readonly string[]
  readonly trashRoot?: string
}

/**
 * The roots a task may work in.
 *
 * Defaults to a workspace directory inside the Relay home, per FR-SH-2's
 * "default: a workspace directory plus explicitly granted paths". Anything
 * beyond that is an explicit grant in policy, not an inference.
 */
export function defaultFilesystemRoots(home = resolveRelayHome().path, policyPath: string = defaultPolicyPath()): readonly string[] {
  const workspace = join(home, 'workspace')
  let granted: readonly string[] = []
  try {
    granted = loadPolicy(policyPath).filesystem?.roots ?? []
  } catch {
    // A policy that cannot be read is not permission to reach anything
    // extra. The built-in workspace still applies, so a broken policy
    // narrows the capability rather than widening or breaking it.
    granted = []
  }
  return [workspace, ...granted]
}

export function defaultTrashRoot(home = resolveRelayHome().path): string {
  return join(home, 'trash')
}

/**
 * The registered capability. Two arguments, matching the registry's contract
 * exactly: a capability that quietly took a third would still satisfy the
 * type while depending on something no caller passes.
 */
export const files: Capability = async (rawInput: unknown): Promise<FilesOutput> => runFiles(rawInput)

/** The same logic with its roots and trash injectable, which is how the tests drive it without touching the operator's real ones. */
export async function runFiles(rawInput: unknown, deps: FilesDependencies = {}): Promise<FilesOutput> {
  const parsed = filesInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, refused: `the files call's input was not valid: ${parsed.error.issues[0]?.message ?? 'unknown error'}` }
  }
  const input = parsed.data
  const roots = deps.roots ?? defaultFilesystemRoots()
  const trashRoot = deps.trashRoot ?? defaultTrashRoot()

  // FR-SH-2: scope first, before anything is opened. Both paths for a move
  // or a copy, because a copy OUT of scope is an exfiltration and a copy IN
  // is a write nobody authorised.
  const source = checkPathScope(input.path, roots)
  if (!source.allowed) return { ok: false, refused: source.reason }

  let destination: string | undefined
  if (input.destination !== undefined) {
    const checked = checkPathScope(input.destination, roots)
    if (!checked.allowed) return { ok: false, refused: checked.reason }
    destination = checked.path
  }

  // FR-SH-3: preview, then act only on confirmation.
  if (MUTATING.has(input.operation) && !input.confirm) {
    const affected = destination === undefined ? [source.path] : [source.path, destination]
    const irreversible = IRREVERSIBLE.has(input.operation)
    if (affected.length > PREVIEW_THRESHOLD - 1 || irreversible) {
      return {
        ok: true,
        preview: {
          action: describeAction(input.operation, source.path, destination),
          affected,
          irreversible,
          confirm_with: 'repeat this call with "confirm": true to carry it out. Nothing has changed yet.',
        },
      }
    }
  }

  try {
    switch (input.operation) {
      case 'read':
        return readFile(source.path)
      case 'list':
        return { ok: true, entries: readdirSync(source.path) }
      case 'stat': {
        const info = statSync(source.path)
        return {
          ok: true,
          stat: {
            path: source.path,
            is_directory: info.isDirectory(),
            size_bytes: info.size,
            modified: info.mtime.toISOString(),
          },
        }
      }
      case 'write':
        mkdirSync(dirname(source.path), { recursive: true })
        writeFileSync(source.path, input.content ?? '', 'utf8')
        return { ok: true, moved_to: source.path }
      // Narrowed rather than cast. The schema already requires a destination
      // for these two, but a cast would keep compiling if that ever changed,
      // and the failure would be a rename to "undefined".
      case 'move': {
        if (destination === undefined) return { ok: false, refused: 'move needs a destination' }
        mkdirSync(dirname(destination), { recursive: true })
        renameSync(source.path, destination)
        return { ok: true, moved_to: destination }
      }
      case 'copy': {
        if (destination === undefined) return { ok: false, refused: 'copy needs a destination' }
        mkdirSync(dirname(destination), { recursive: true })
        if (statSync(source.path).isDirectory()) cpSync(source.path, destination, { recursive: true })
        else copyFileSync(source.path, destination)
        return { ok: true, moved_to: destination }
      }
      case 'delete': {
        // FR-SH-4: a move into the trash, never an unlink.
        const trashed = moveToTrash(source.path, trashRoot)
        if (!trashed.ok) return { ok: false, refused: trashed.reason }
        return { ok: true, trashed_to: trashed.trashedTo, recoverable_until: trashed.recoverableUntil }
      }
    }
  } catch (error) {
    return { ok: false, refused: `${input.operation} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function readFile(path: string): FilesOutput {
  const raw = readFileSync(path, 'utf8')
  if (raw.length <= MAX_FILE_READ_CHARACTERS) return { ok: true, content: raw, truncated: false }
  return {
    ok: true,
    content: `${raw.slice(0, MAX_FILE_READ_CHARACTERS)}\n[… ${raw.length - MAX_FILE_READ_CHARACTERS} characters trimmed …]`,
    truncated: true,
  }
}

function describeAction(operation: string, source: string, destination: string | undefined): string {
  switch (operation) {
    case 'write':
      return `write to ${source}`
    case 'move':
      return `move ${source} to ${destination}`
    case 'copy':
      return `copy ${source} to ${destination}`
    case 'delete':
      return `delete ${source}, moving it to Relay's trash where it stays recoverable for 7 days`
    default:
      return `${operation} ${source}`
  }
}

export const FILES_CAPABILITY_DEFINITION: CapabilityDefinition = {
  name: FILES_CAPABILITY_NAME,
  description:
    'Reads, writes, lists, moves, copies, deletes and stats files, but only inside the filesystem roots this ' +
    'installation permits. A change previews first: the call returns what WOULD be affected and does nothing, and ' +
    'you repeat it with "confirm": true to carry it out. Deletes move to a trash directory and stay recoverable ' +
    'for 7 days rather than being unlinked.',
  inputSchema: filesInputSchema,
  outputSchema: z.unknown(),
  riskTier: 'write',
  idempotencyClass: 'mutating',
  requiredRunnerFeatures: [],
  costHint: 'free',
  requiresMachineLock: false,
  inputExamples: [
    { operation: 'read', path: '/path/inside/a/root/notes.md' },
    { operation: 'write', path: '/path/inside/a/root/out.txt', content: 'hello', confirm: true },
    { operation: 'delete', path: '/path/inside/a/root/stale.log', confirm: true },
  ],
  run: files,
}
