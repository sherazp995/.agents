/**
 * `code.task`: the capability that turns a sentence in Slack into a change
 * in a git worktree, verified, with nothing touched outside it.
 *
 * It is the assembly point rather than the mechanism. Each piece already
 * exists and is tested on its own:
 *
 *   - `src/repos/resolve.ts` decides WHICH repository, or refuses (FR-CODE-2)
 *   - `src/repos/worktree.ts` decides WHERE, outside the operator's own
 *     checkout, on a named branch (FR-CODE-10, 16)
 *   - `src/repos/engine.ts` runs the engine inside the sandbox and classifies
 *     what happened (FR-CODE-20, 22, 25)
 *   - verification runs the registry's own test command (FR-CODE-30)
 *
 * THE ORDER IS THE SAFETY PROPERTY. Resolution and permission are checked
 * before a worktree exists; the worktree exists before the engine runs; the
 * engine's network is confined before it starts. Nothing here is reachable
 * by a run that failed an earlier gate, which is what makes the gates worth
 * having.
 *
 * A RUN NEVER REPORTS SUCCESS ON ITS OWN SAY-SO. FR-CODE-30 is explicit that
 * verification decides, and this returns `ok: false` for a change whose
 * tests failed even when the engine is perfectly happy with itself. The
 * commonest way an agent lies is by summarising its intentions as its
 * results.
 */

import { z } from 'zod'

import { loadRepoRegistryIfPresent } from '../../config/load.js'
import { defaultReposPath } from '../../config/paths.js'
import { checkRepoOperation, resolveRepo } from '../../repos/resolve.js'
import { createWorktree } from '../../repos/worktree.js'
import { runEngine, verify } from '../../repos/engine.js'
import type { Capability } from '../loop.js'
import type { CapabilityDefinition } from '../../capabilities/registry.js'

export const CODE_CAPABILITY_NAME = 'code'

export const codeInputSchema = z
  .object({
    /** The repository, by name or alias. Never inferred: FR-CODE-2 forbids guessing. */
    repo: z
      .string({ required_error: 'name the repository this task is for; Relay never infers one' })
      .trim()
      .min(1, 'name the repository this task is for'),
    /** What to do, in the operator's own words, passed to the engine unchanged. */
    task: z.string({ required_error: 'describe the task' }).trim().min(1, 'describe the task'),
    /** Used for the branch name, so a worktree is recognisable later. */
    title: z.string().trim().min(1).optional(),
    timeout_seconds: z.number().int().positive().max(3600).optional(),
  })
  .strict()

export type CodeInput = z.infer<typeof codeInputSchema>

export type CodeOutput = {
  readonly ok: boolean
  readonly refused?: string
  readonly repo?: string
  readonly branch?: string
  readonly worktree?: string
  readonly base_commit?: string
  /** FR-CODE-25's taxonomy, surfaced rather than collapsed. */
  readonly engine_outcome?: string
  readonly engine_detail?: string
  /** FR-CODE-30: what verified this, and what it said. */
  readonly verification?: Record<string, unknown>
  /** FR-SH-6: destinations the run tried to reach and was refused. */
  readonly blocked_destinations?: readonly string[]
}

export type CodeDependencies = {
  readonly reposPath?: string
  readonly worktreeRoot?: string
}

export const code: Capability = async (rawInput: unknown, signal?: AbortSignal): Promise<CodeOutput> =>
  runCodeTask(rawInput, signal)

export async function runCodeTask(rawInput: unknown, signal?: AbortSignal, deps: CodeDependencies = {}): Promise<CodeOutput> {
  const parsed = codeInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, refused: `the code call's input was not valid: ${parsed.error.issues[0]?.message ?? 'unknown error'}` }
  }
  const input = parsed.data

  let registry
  try {
    registry = loadRepoRegistryIfPresent(deps.reposPath ?? defaultReposPath())
  } catch (error) {
    return { ok: false, refused: `the repository registry could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }

  // FR-CODE-2: resolved or refused, never guessed.
  const resolution = resolveRepo(input.repo, registry)
  if (resolution.outcome !== 'resolved') return { ok: false, refused: resolution.reason }
  const repo = resolution.repo

  // FR-CODE-1: a coding task writes, so `write` must be permitted.
  const permission = checkRepoOperation(repo, 'write')
  if (!permission.allowed) return { ok: false, refused: permission.reason }

  const runId = `run-${Date.now().toString(36)}`
  const created = createWorktree(repo, runId, input.title ?? input.task, {
    ...(deps.worktreeRoot !== undefined ? { worktreeRoot: deps.worktreeRoot } : {}),
  })
  if (created.outcome !== 'created') return { ok: false, refused: created.reason, repo: repo.name }

  const base = {
    repo: repo.name,
    branch: created.branch,
    worktree: created.path,
    base_commit: created.baseCommit,
  }

  const engine = await runEngine({
    repo,
    worktreePath: created.path,
    task: input.task,
    ...(input.timeout_seconds !== undefined ? { timeoutSeconds: input.timeout_seconds } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })

  if (engine.kind !== 'completed') {
    return {
      ok: false,
      ...base,
      engine_outcome: engine.kind,
      engine_detail: describeEngineFailure(engine),
    }
  }

  // FR-CODE-30: verification decides, not the engine's own account of
  // itself. The commonest way an agent lies is by summarising its
  // intentions as its results.
  const verification = await verify(repo, created.path)

  return {
    ok: verification.kind === 'passed',
    ...base,
    engine_outcome: 'completed',
    engine_detail: engine.output,
    blocked_destinations: engine.blockedDestinations,
    verification: { ...verification },
  }
}

function describeEngineFailure(outcome: Exclude<Awaited<ReturnType<typeof runEngine>>, { kind: 'completed' }>): string {
  switch (outcome.kind) {
    case 'crashed':
      return `the engine exited ${outcome.exitCode ?? 'abnormally'}: ${outcome.stderr.slice(0, 2000)}`
    case 'timed_out':
      return (
        `the engine ran past its ${outcome.seconds}s limit and was stopped. Whatever it had done is still in the ` +
        `worktree, which is not deleted. Partial output: ${outcome.partialOutput.slice(0, 2000)}`
      )
    case 'could_not_complete':
      return `the engine ran normally and reports it could not do this: ${outcome.explanation.slice(0, 2000)}`
    case 'refused':
      return outcome.reason
  }
}

export const CODE_CAPABILITY_DEFINITION: CapabilityDefinition = {
  name: CODE_CAPABILITY_NAME,
  description:
    'Makes a change in a registered repository. The work happens in a dedicated git worktree on its own branch, ' +
    'never in your checkout, and the engine runs OS-confined with no network except Anthropic. The repository must ' +
    'be named: Relay never guesses between two, and never touches one that is not registered. The run reports ' +
    'success only if the repository\'s own test command passes.',
  inputSchema: codeInputSchema,
  outputSchema: z.unknown(),
  // `write`, not `irreversible`: the work lands on a Relay-owned branch in a
  // Relay-owned worktree, and nothing is pushed. Publishing is its own gate.
  riskTier: 'write',
  idempotencyClass: 'mutating',
  requiredRunnerFeatures: [],
  costHint: 'spends model tokens for the duration of the coding run',
  requiresMachineLock: false,
  inputExamples: [
    { repo: 'acme-api', task: 'Add a health check endpoint at /healthz that returns 200 and the build SHA.' },
    { repo: 'acme-api', task: 'Fix the flaky retry test in test/retry.test.ts', title: 'fix flaky retry test' },
  ],
  run: code,
}
