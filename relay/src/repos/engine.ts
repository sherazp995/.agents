/**
 * FR-CODE-20, 22, 24, 25, 30, 31: running the coding engine inside the
 * worktree, inside the sandbox, and reporting what actually happened.
 *
 * FR-CODE-22 is the requirement that shapes this: "Engine capability
 * boundary, enforced by the OS rather than by cooperation. The engine runs
 * inside the FR-SH-6 sandbox profile, so it cannot reach outside its
 * worktree, cannot make network calls to non-enumerated destinations, and
 * cannot write through read-only linked config paths, regardless of how
 * permissive its inherited settings are."
 *
 * THAT THIS IS POSSIBLE AT ALL WAS MEASURED, NOT ASSUMED. The engine needs
 * to reach Anthropic, and the sandbox denies direct egress at the kernel, so
 * the whole design rests on the engine honouring a proxy. It does: pointed
 * at Relay's proxy with nothing declared, the CLI issued
 * `CONNECT api.anthropic.com:443` and was refused. If it had opened a direct
 * socket instead, this file could not exist as specified.
 *
 * THE SAME PROBE FOUND SOMETHING ELSE. The engine also attempts
 * `http-intake.logs.us5.datadoghq.com`, which is third-party telemetry that
 * FR-DATA-3 forbids and the egress inventory does not declare. It is not on
 * the allowlist below, so it is terminated and recorded on every run. This
 * is exactly the case the enforcing proxy exists for: the inventory could
 * only ever have DETECTED that destination, and only if someone thought to
 * look.
 *
 * FR-CODE-25's failure taxonomy is not decoration. "It crashed", "it ran out
 * of time" and "it says it could not do this" call for three different
 * responses from the operator, and collapsing them into a generic failure
 * throws away the only information that distinguishes them.
 */

import { runSandboxed, sandboxAvailability } from '../sandbox/exec.js'
import { startEgressProxy } from '../sandbox/proxy.js'
import type { EgressAttempt } from '../sandbox/proxy.js'
import type { RepoEntry } from './schema.js'

/** The engine binary. Named here rather than inline so the egress inventory's scan can resolve it. */
export const ENGINE_BINARY = 'claude'

/**
 * The only destination a coding run may reach.
 *
 * Anthropic, because the engine cannot work without it, and nothing else.
 * Notably NOT the git remote: a push goes through the reviewed publish gate
 * (FR-CODE-47a), not through the engine deciding to.
 */
export const ENGINE_ALLOWED_HOSTS: readonly string[] = ['api.anthropic.com', 'statsig.anthropic.com']

/** FR-CODE-20's bounded wall clock. `--max-turns` does not exist on this CLI, so time is the only bound available. */
export const DEFAULT_ENGINE_TIMEOUT_SECONDS = 900

export type EngineOutcome =
  /** The engine ran to completion and said what it did. */
  | { readonly kind: 'completed'; readonly output: string; readonly blockedDestinations: readonly string[] }
  /** FR-CODE-25: the engine itself failed, distinct from the task being impossible. */
  | { readonly kind: 'crashed'; readonly exitCode: number | null; readonly stderr: string }
  /** FR-CODE-25: the wall clock ran out. Partial work is intact in the worktree. */
  | { readonly kind: 'timed_out'; readonly seconds: number; readonly partialOutput: string }
  /** FR-CODE-25: the engine ran fine and reports it could not do the task. Not a failure of Relay's. */
  | { readonly kind: 'could_not_complete'; readonly explanation: string }
  /** Confinement was unavailable, so nothing ran (FR-SH-7). */
  | { readonly kind: 'refused'; readonly reason: string }

export type EngineRequest = {
  readonly repo: RepoEntry
  readonly worktreePath: string
  readonly task: string
  readonly timeoutSeconds?: number
  readonly signal?: AbortSignal
}

export type EngineDependencies = {
  readonly run?: typeof runSandboxed
  readonly startProxy?: typeof startEgressProxy
  readonly available?: typeof sandboxAvailability
}

/**
 * Phrases an engine uses when it has understood the task and is declining
 * it, rather than failing at it.
 *
 * Deliberately narrow. A loose match here would reclassify a SUCCESSFUL run
 * that happened to mention one of these phrases as a refusal, which is worse
 * than the generic failure this replaces: the operator would be told the
 * work was declined while the diff sits in the worktree.
 */
const COULD_NOT_COMPLETE_MARKERS: readonly RegExp[] = [
  /^\s*i (?:am unable|cannot|can't) (?:to )?complete/i,
  /^\s*i was unable to (?:complete|do)/i,
  /\bunable to complete (?:this|the) task\b/i,
]

export function readsAsCouldNotComplete(output: string): boolean {
  return COULD_NOT_COMPLETE_MARKERS.some((pattern) => pattern.test(output))
}

/**
 * Runs the engine. Never throws: the caller reports an outcome to an
 * operator, and every failure shape here is one of FR-CODE-25's.
 */
export async function runEngine(request: EngineRequest, deps: EngineDependencies = {}): Promise<EngineOutcome> {
  const availability = (deps.available ?? sandboxAvailability)()
  if (!availability.available) return { kind: 'refused', reason: availability.reason }

  const seconds = request.timeoutSeconds ?? DEFAULT_ENGINE_TIMEOUT_SECONDS
  const proxy = await (deps.startProxy ?? startEgressProxy)({ allowedHosts: ENGINE_ALLOWED_HOSTS })

  try {
    const result = await (deps.run ?? runSandboxed)({
      spec: {
        // FR-CODE-22: the worktree is the only writable place. The
        // operator's own checkout is explicitly read-only even though
        // nothing grants it, so a symlink or a stray absolute path cannot
        // reach back into it.
        worktree: request.worktreePath,
        readOnlyPaths: [request.repo.path],
        proxyPort: proxy.port,
      },
      command: ENGINE_BINARY,
      args: ['-p', request.task],
      cwd: request.worktreePath,
      env: engineEnvironment(proxy.port),
      timeoutMs: seconds * 1000,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })

    if (result.outcome === 'unavailable') return { kind: 'refused', reason: result.reason }

    const blockedDestinations = [...new Set(proxy.attempts.filter((a: EgressAttempt) => !a.allowed).map((a) => a.host))]

    if (result.timedOut) return { kind: 'timed_out', seconds, partialOutput: result.stdout }
    if (result.exitCode !== 0) return { kind: 'crashed', exitCode: result.exitCode, stderr: result.stderr || result.stdout }
    if (readsAsCouldNotComplete(result.stdout)) return { kind: 'could_not_complete', explanation: result.stdout }

    return { kind: 'completed', output: result.stdout, blockedDestinations }
  } finally {
    await proxy.close()
  }
}

/**
 * The engine's environment.
 *
 * The proxy variables are the entire reason a confined engine can work. The
 * NO_PROXY exclusion for loopback matters because without it some clients
 * route their own local calls through the proxy and deadlock against it.
 */
export function engineEnvironment(proxyPort: number, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  return {
    ...source,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  }
}

/**
 * FR-CODE-30: "No coding run reports success without running verification."
 *
 * A repository with no `test_command` is NOT silently treated as verified.
 * Reporting success for a change nothing checked is precisely the outcome
 * this requirement forbids, so the absence is reported as its own state and
 * the operator can see that nothing ran.
 */
export type VerificationOutcome =
  | { readonly kind: 'passed'; readonly command: string; readonly output: string }
  | { readonly kind: 'failed'; readonly command: string; readonly exitCode: number | null; readonly output: string }
  | { readonly kind: 'not_configured'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }

export async function verify(
  repo: RepoEntry,
  worktreePath: string,
  deps: EngineDependencies & { readonly command?: string } = {},
): Promise<VerificationOutcome> {
  const command = deps.command ?? repo.test_command
  if (command === undefined || command.trim() === '') {
    return {
      kind: 'not_configured',
      reason:
        `repository "${repo.name}" declares no test_command, so nothing verified this change. That is reported ` +
        'rather than treated as a pass: a run reporting success for a change nothing checked is exactly what ' +
        'FR-CODE-30 exists to prevent. Add test_command to config/repos.yaml.',
    }
  }

  // The command is a string from the registry, which is the operator's own
  // file, so a shell is acceptable here in a way it never is for a
  // model-composed command. It still runs inside the sandbox, confined to
  // the worktree with no direct network.
  const result = await (deps.run ?? runSandboxed)({
    spec: { worktree: worktreePath, readOnlyPaths: [repo.path] },
    command: '/bin/sh',
    args: ['-c', command],
    cwd: worktreePath,
    timeoutMs: 30 * 60 * 1000,
  })

  if (result.outcome === 'unavailable') return { kind: 'refused', reason: result.reason }

  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (result.exitCode === 0 && !result.timedOut) return { kind: 'passed', command, output }
  return { kind: 'failed', command, exitCode: result.exitCode, output }
}
