/**
 * The engine hook bridge, per the Task 5 design note
 * (.superpowers/sdd/2026-08-10-relay-p0.4-policy-and-approvals/task-5-design-note.md,
 * DEC-1's resolution in docs/decisions/open-questions.md, commit 6d1414f).
 *
 * A `claude -p` subprocess's `PreToolUse` hook cannot hold a decision open
 * for a human: proven empirically that exceeding the hook's own timeout
 * fails OPEN, not closed (the tool call proceeds as if no hook fired at
 * all). So this bridge never blocks. Every call it handles is a fast,
 * synchronous, local classify()/decide() evaluation, answered in
 * milliseconds; the moment a human is actually needed, it says `defer`
 * (empirically proven print-mode-only and solo-tool-call-only, see the
 * design note) and the subprocess exits on its own, cleanly, naming the
 * pending call. Relay's orchestrator (Task 3's territory, not this file)
 * resumes the session later with a fresh decision once approved.
 *
 * WHY THIS DOES NOT REUSE src/policy/engine.ts's mediate(). mediate()
 * requires the capability to be a name registered in Relay's OWN
 * capability registry (src/capabilities/registry.ts) and denies outright
 * when it is not. That registry holds capabilities RELAY ITSELF executes
 * (echo, and later shell.exec, fs.delete, and so on). Claude Code's
 * built-in tools (Bash, Edit, Write, Read, ...) are executed by the Claude
 * Code subprocess, never by Relay's own loop; Relay only approves or
 * denies them. Registering every Claude Code tool name as a Relay
 * capability, complete with a `run` implementation Relay would never
 * actually call, would misuse that registry's own meaning. This file
 * therefore calls classify()/decide() directly, with its own declared-tier
 * mapping for Claude Code's tool names (below), which is a genuinely
 * separate policy surface from Relay's capability registry. Flagging this
 * as a real design line drawn here, not a gap: a real command-level
 * classifier for Bash (matching, say, FR-CODE's `git_hard_blocks` and
 * `shell.exec`'s `allow_binaries`) is real, substantial future work this
 * file does not attempt.
 *
 * FACT EXTRACTION IS ALSO OUT OF SCOPE HERE. classify()'s escalation rules
 * (amount, item count, credential presence, first contact) need per-call
 * facts derived from `tool_input`, which is tool-specific work (parsing a
 * Bash command, noticing a dollar amount in an Edit's content, ...) this
 * file does not attempt either. A caller MAY supply any of those facts on
 * `HookDecisionRequest`; when it does not, classify() simply has nothing to
 * escalate on, and the capability's own declared tier is what decide() acts
 * on. That is honest today, not silently wrong: the mechanism (fail-closed,
 * fast, deferring only when a human is truly needed) is what this task
 * proves; per-tool fact extraction is future work on top of it.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { RiskTier } from '../capabilities/registry.js'
import type { Policy } from '../config/schema.js'
import { classify } from '../policy/classify.js'
import { decide } from '../policy/decide.js'
import type { Logger } from '../obs/logger.js'
import { registerSecretValue } from '../secrets/scrubber.js'
import {
  MCP_CALL_PATH,
  MCP_RESULT_PATH,
  type InvocationContext,
  type McpCallDecision,
  type McpCallRequest,
  type McpResultRequest,
} from '../autonomous/mcp-protocol.js'
import type { ClassificationContext, DecisionContext, ProposedCall } from '../policy/schema.js'

// ---------------------------------------------------------------------------
// Claude Code tool name -> declared risk tier.
// ---------------------------------------------------------------------------

/**
 * A first-cut, deliberately conservative mapping from Claude Code's
 * built-in tool names to a §10.1 risk tier. Provisional: revisit once a
 * real command-level classifier exists for Bash in particular, per this
 * file's header comment. `Bash` is `irreversible`, matching the
 * requirements' own §18.4 example policy choice for `shell.exec` and for
 * the identical reason: a shell can do anything, so the only honest
 * default for something this general is the most conservative tier, not a
 * guess at what a given command will actually do.
 */
export const CLAUDE_CODE_TOOL_TIERS: Readonly<Record<string, RiskTier>> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  WebSearch: 'read',
  Edit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
  TodoWrite: 'write',
  WebFetch: 'sensitive',
  Task: 'sensitive',
  Bash: 'irreversible',
}

/** The tier for any tool name not in CLAUDE_CODE_TOOL_TIERS, an MCP tool this bridge has no specific mapping for, or an empty/malformed name. Irreversible: the most conservative tier, per FR-POL-3's "unmatched defaults toward the safe side" spirit applied to this file's own table rather than only to policy.yaml. */
const DEFAULT_TIER: RiskTier = 'irreversible'

/** Resolves a Claude Code tool name to its declared tier. Never throws; an unrecognised name (or one that formats oddly through no fault of this function) simply falls to DEFAULT_TIER. */
export function resolveDeclaredTier(toolName: string): RiskTier {
  return CLAUDE_CODE_TOOL_TIERS[toolName] ?? DEFAULT_TIER
}

// ---------------------------------------------------------------------------
// The decision request/response shape this file's server speaks.
// ---------------------------------------------------------------------------

/**
 * What the hook script (scripts/hook-pretooluse.ts) sends, derived from the
 * PreToolUse stdin payload Claude Code gives it. Every optional field here
 * mirrors ProposedCall's own fields for the same reason ProposedCall states
 * in its own doc comment: derived, non-secret facts only, never a raw
 * argument value, so a credential can never reach a decision reason.
 */
export interface HookDecisionRequest {
  readonly toolUseId: string
  readonly toolName: string
  readonly sessionId: string
  /** The hook payload's `cwd`: where the agent session runs. The autonomous guard resolves a git target directory from it. */
  readonly cwd?: string
  /** Forwarded for a future approval card to use; not parsed or inspected by resolveHookDecision itself, per this file's header comment. */
  readonly toolInput?: unknown
  readonly destination?: string
  readonly amountUsd?: number
  readonly affectedCount?: number
  readonly recipientCount?: number
  readonly irreversible?: boolean
  readonly containsCredential?: boolean
}

/** Runtime validation for HookDecisionRequest: this data crosses a process boundary (the hook script's own parse of Claude Code's stdin, then a network hop to this server), so it is never trusted as already being the right shape just because a caller's TypeScript type claims so. A request that fails this parse denies outright, per this file's own fail-closed rule; see resolveHookDecision's own self-attack test for the guard this backs. */
const hookDecisionRequestSchema = z
  .object({
    toolUseId: z.string().trim().min(1),
    toolName: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    cwd: z.string().optional(),
    toolInput: z.unknown().optional(),
    destination: z.string().trim().min(1).optional(),
    amountUsd: z.number().optional(),
    affectedCount: z.number().optional(),
    recipientCount: z.number().optional(),
    irreversible: z.boolean().optional(),
    containsCredential: z.boolean().optional(),
  })
  .passthrough()

export type HookBridgeDecision = 'allow' | 'deny' | 'defer'

export interface HookDecisionResult {
  readonly decision: HookBridgeDecision
  readonly reason: string
}

export interface HookDecisionContext {
  readonly policy: Policy
  readonly knownOrigins?: readonly string[]
}

const INTERNAL_ERROR_REASON = 'internal error resolving hook decision; denying rather than risking a silent allow'
const MALFORMED_REQUEST_REASON = 'malformed hook decision request; denying rather than risking a silent allow'

/**
 * Pure(-ish): classify() and decide() are pure, and this function performs
 * no I/O of its own, but it is defensive rather than total the way they
 * are, per this task's own fail-closed requirement. Every failure mode
 * (a request that does not parse, an internal exception from classify() or
 * decide()) resolves to `deny`, never propagates as a thrown exception and
 * never resolves to `allow`. `decide()`'s own `ask` maps to this bridge's
 * `defer`, since the bridge is the one place that distinction actually
 * matters: a hook cannot itself ask a human, only defer to one.
 */
export function resolveHookDecision(request: HookDecisionRequest, context: HookDecisionContext): HookDecisionResult {
  const parsed = hookDecisionRequestSchema.safeParse(request)
  if (!parsed.success) {
    return { decision: 'deny', reason: MALFORMED_REQUEST_REASON }
  }

  try {
    const req = parsed.data
    const call: ProposedCall = {
      capability: req.toolName,
      declaredTier: resolveDeclaredTier(req.toolName),
      ...(req.destination !== undefined ? { destination: req.destination } : {}),
      ...(req.amountUsd !== undefined ? { amountUsd: req.amountUsd } : {}),
      ...(req.affectedCount !== undefined ? { affectedCount: req.affectedCount } : {}),
      ...(req.recipientCount !== undefined ? { recipientCount: req.recipientCount } : {}),
      ...(req.irreversible !== undefined ? { irreversible: req.irreversible } : {}),
      ...(req.containsCredential !== undefined ? { containsCredential: req.containsCredential } : {}),
    }
    const classificationContext: ClassificationContext = {
      policy: context.policy,
      knownOrigins: context.knownOrigins ?? [],
    }
    const classification = classify(call, classificationContext)

    const decisionContext: DecisionContext = {
      policy: context.policy,
      capability: req.toolName,
      ...(req.destination !== undefined ? { destination: req.destination } : {}),
    }
    const { decision, reason } = decide(classification, decisionContext)

    if (decision === 'ask') return { decision: 'defer', reason }
    return { decision, reason }
  } catch {
    // classify()/decide() are documented as total over a well-formed
    // Policy, but this bridge does not get to assume its own caller passed
    // one: a Policy object that reached this file via a path other than
    // loadPolicy() (a test double, a future caller) is not guaranteed to
    // satisfy every invariant loadPolicy()'s validation enforces. Denying
    // here is what makes that gap safe rather than merely hoped-safe.
    return { decision: 'deny', reason: INTERNAL_ERROR_REASON }
  }
}

// ---------------------------------------------------------------------------
// The local HTTP server the hook script (scripts/hook-pretooluse.ts) talks
// to. One instance per run, its whole lifetime bounded by that run.
// ---------------------------------------------------------------------------

/**
 * The decision the server asks for on every `/pre-tool-use` request.
 * `context` is the InvocationContext of the per-invocation token the request
 * authenticated with, or undefined for the instance's own single token.
 */
export type HookDecide = (request: HookDecisionRequest, context: InvocationContext | undefined) => Promise<HookDecisionResult>
/**
 * `signal` aborts when the deadline has already answered deny: an
 * implementation checks it before committing anything (an operation, an
 * approval, a claim), so a late answer never leaves state the caller was
 * told did not happen.
 */
export type McpCallDecide = (call: McpCallRequest, context: InvocationContext | undefined, signal: AbortSignal) => Promise<McpCallDecision>
export type McpResultRecorder = (result: McpResultRequest, context: InvocationContext | undefined, signal: AbortSignal) => Promise<void>

/** The governed decision: resolveHookDecision, unchanged, behind the async seam. */
export function governedDecide(policy: Policy, knownOrigins: readonly string[] = []): HookDecide {
  return async (request) => resolveHookDecision(request, { policy, knownOrigins })
}

/** Below the hook script's own 8 s deadline, so the server's deny always reaches the script before the script gives up. */
export const DEFAULT_DECISION_DEADLINE_MS = 5_000
/** Request bodies above this are refused unread: a hook payload or an MCP call's arguments, never a file upload. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

const mcpCallRequestSchema = z.object({ server: z.string().trim().min(1), tool: z.string().trim().min(1), args: z.unknown() }).strict()
const mcpResultRequestSchema = z.object({ operationId: z.string().trim().min(1), ok: z.boolean(), result: z.unknown() }).strict()
/** What `decideMcpCall` may answer; anything else is denied rather than forwarded to the gateway. */
const mcpCallDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }).strict(),
  z.object({ decision: z.literal('deny'), reason: z.string() }).strict(),
  z.object({ decision: z.literal('pending'), operationId: z.string().min(1), message: z.string() }).strict(),
  z
    .object({
      decision: z.literal('execute'),
      operationId: z.string().min(1),
      args: z.record(z.unknown()).optional(),
    })
    .strict(),
])

export interface HookBridgeServerOptions {
  /** The governed policy. Used to build the default `decide` when none is given; one of the two is required. */
  readonly policy?: Policy
  readonly knownOrigins?: readonly string[]
  /** Overrides the governed decision (the autonomous guard). Throwing or exceeding `deadlineMs` denies. */
  readonly decide?: HookDecide
  /** Answers POST MCP_CALL_PATH. Absent: every MCP call is denied. */
  readonly decideMcpCall?: McpCallDecide
  /** Answers POST MCP_RESULT_PATH. Absent: every result report fails. */
  readonly recordMcpResult?: McpResultRecorder
  /** How long `decide`, `decideMcpCall` or `recordMcpResult` may take before the server answers deny. */
  readonly deadlineMs?: number
  /** Where a failure to answer a request is reported. */
  readonly logger?: Pick<Logger, 'error'>
  /**
   * Bind host, defaults to `127.0.0.1`. This must never be reachable from
   * outside the machine: the token below is this server's only defense
   * against an unauthorized caller, and a token is far easier for another
   * process on the SAME machine to obtain (an env var of a process it can
   * inspect, a stray log line) than for a remote attacker to obtain at all,
   * so binding loopback-only removes the entire remote half of that
   * exposure regardless of how the token is protected.
   */
  readonly host?: string
}

class DeadlineExceededError extends Error {}

/**
 * Resolves to `work`'s value, or rejects with DeadlineExceededError once `ms`
 * passes. The work is not cancelled: its signal aborts at the deadline and
 * its late answer is ignored.
 */
async function withinDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DeadlineExceededError(`no decision within ${ms} ms`))
    }, ms)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline])
  } finally {
    clearTimeout(timer)
  }
}

function failureReason(error: unknown): string {
  return error instanceof DeadlineExceededError
    ? 'the decision exceeded its deadline; denying rather than risking a silent allow'
    : INTERNAL_ERROR_REASON
}

/**
 * Server-side half of the bridge. `token` is generated fresh per instance
 * (32 random bytes, hex-encoded) and registered with the process-wide
 * secret scrubber (src/secrets/scrubber.js) the instant it exists, so it
 * can never reach a log line even by accident, the same backstop every
 * other secret in this codebase gets, per FR-SEC-1. Tokens issued per
 * invocation by `issueToken` get the same treatment and carry their
 * InvocationContext to `decide`.
 *
 * WHAT THE TOKEN DEFENDS AGAINST, STATED PLAINLY. Relay spawns the `claude
 * -p` subprocess and controls its environment, so the token travels to the
 * real hook script via an environment variable only that subprocess (and
 * its own children, including the hook script Code spawns) ever sees. An
 * unrelated process on this machine, run by the same operator or a
 * different one, has no way to read another process's environment on
 * macOS without already having the privilege to do far worse (attach a
 * debugger, read the operator's Keychain), so this token is a real barrier
 * against "anything on this machine could otherwise approve its own
 * actions." What it does NOT defend against: the operator's own shell,
 * which already has the same trust this entire system extends to the
 * operator's authenticated Claude Code session per DEC-1. An operator who
 * reads their own subprocess's environment and replays the token is not
 * an attacker bypassing a boundary, they are the principal this system
 * already trusts, exactly as true of every other local safety mechanism
 * this milestone builds.
 */
export class HookBridgeServer {
  readonly token: string
  private readonly server: Server
  private readonly decide: HookDecide
  private readonly decideMcpCall: McpCallDecide | undefined
  private readonly recordMcpResult: McpResultRecorder | undefined
  private readonly deadlineMs: number
  private readonly logger: Pick<Logger, 'error'> | undefined
  private readonly host: string
  private readonly invocationTokens = new Map<string, InvocationContext>()
  private boundUrl: string | undefined

  constructor(options: HookBridgeServerOptions) {
    if (options.decide !== undefined) {
      this.decide = options.decide
    } else if (options.policy !== undefined) {
      this.decide = governedDecide(options.policy, options.knownOrigins ?? [])
    } else {
      throw new Error('HookBridgeServer needs a policy or a decide function')
    }
    this.decideMcpCall = options.decideMcpCall
    this.recordMcpResult = options.recordMcpResult
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DECISION_DEADLINE_MS
    this.logger = options.logger
    this.host = options.host ?? '127.0.0.1'
    this.token = randomBytes(32).toString('hex')
    registerSecretValue(this.token)
    this.server = createServer((req, res) => this.handleRequest(req, res))
  }

  /** The full URL the hook script should POST to. Throws if read before start() resolves: there is no meaningful default URL for a server that has not bound a port yet, and returning an empty string instead would let a caller silently POST nowhere. */
  get url(): string {
    if (this.boundUrl === undefined) {
      throw new Error('HookBridgeServer.url read before start() resolved')
    }
    return this.boundUrl
  }

  /** A fresh token for one worker invocation; requests bearing it reach `decide` with `context`. */
  issueToken(context: InvocationContext): string {
    const token = randomBytes(32).toString('hex')
    registerSecretValue(token)
    this.invocationTokens.set(token, { ...context })
    return token
  }

  /** Requests bearing a revoked token are refused as unauthorized. Revoking an unknown token is a no-op. */
  revokeToken(token: string): void {
    this.invocationTokens.delete(token)
  }

  /** Binds an OS-assigned loopback port. Never a fixed, predictable port: a fixed port is one less thing an unrelated local process needs to guess. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, this.host, () => {
        this.server.removeListener('error', reject)
        const address = this.server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('HookBridgeServer failed to bind a TCP port'))
          return
        }
        this.boundUrl = `http://${this.host}:${address.port}/pre-tool-use`
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST' || (path !== '/pre-tool-use' && path !== MCP_CALL_PATH && path !== MCP_RESULT_PATH)) {
      res.writeHead(404).end()
      return
    }
    const auth = this.authenticate(req)
    if (!auth.ok) {
      this.respondJson(res, 401, { decision: 'deny', reason: 'unauthorized: missing or incorrect bearer token' })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        if (!refused) {
          // Stop reading: close the connection once the refusal is written instead of draining the rest.
          res.setHeader('connection', 'close')
          res.once('finish', () => req.destroy())
          this.respondJson(res, 413, { decision: 'deny', reason: 'request body too large' })
        }
        refused = true
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => {
      this.respondJson(res, 500, { decision: 'deny', reason: 'request stream error' })
    })
    req.on('end', () => {
      if (refused) return
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        this.respondJson(res, 400, { decision: 'deny', reason: 'malformed JSON request body' })
        return
      }
      const answer =
        path === MCP_CALL_PATH
          ? this.answerMcpCall(body, auth.context)
          : path === MCP_RESULT_PATH
            ? this.answerMcpResult(body, auth.context)
            : this.answerPreToolUse(body, auth.context)
      answer
        .then(({ status, body: reply }) => this.respondJson(res, status, reply))
        .catch((error: unknown) => {
          this.logger?.error({ err: error, path }, 'hook bridge failed to answer a request')
          try {
            this.respondJson(res, 500, { decision: 'deny', reason: INTERNAL_ERROR_REASON })
          } catch {
            res.destroy()
          }
        })
    })
  }

  private async answerPreToolUse(body: unknown, context: InvocationContext | undefined): Promise<{ status: number; body: unknown }> {
    try {
      const result = await withinDeadline(() => this.decide(body as HookDecisionRequest, context), this.deadlineMs)
      if (result.decision !== 'allow' && result.decision !== 'deny' && result.decision !== 'defer') {
        return { status: 200, body: { decision: 'deny', reason: INTERNAL_ERROR_REASON } }
      }
      return { status: 200, body: result }
    } catch (error) {
      return { status: 200, body: { decision: 'deny', reason: failureReason(error) } }
    }
  }

  private async answerMcpCall(body: unknown, context: InvocationContext | undefined): Promise<{ status: number; body: McpCallDecision }> {
    const parsed = mcpCallRequestSchema.safeParse(body)
    if (!parsed.success) return { status: 200, body: { decision: 'deny', reason: MALFORMED_REQUEST_REASON } }
    const decideMcpCall = this.decideMcpCall
    if (decideMcpCall === undefined) return { status: 200, body: { decision: 'deny', reason: 'this bridge does not gate MCP calls' } }
    try {
      const call: McpCallRequest = { server: parsed.data.server, tool: parsed.data.tool, args: parsed.data.args }
      const decision = mcpCallDecisionSchema.safeParse(
        await withinDeadline((signal) => decideMcpCall(call, context, signal), this.deadlineMs),
      )
      if (!decision.success) return { status: 200, body: { decision: 'deny', reason: INTERNAL_ERROR_REASON } }
      return { status: 200, body: decision.data as McpCallDecision }
    } catch (error) {
      return { status: 200, body: { decision: 'deny', reason: failureReason(error) } }
    }
  }

  private async answerMcpResult(body: unknown, context: InvocationContext | undefined): Promise<{ status: number; body: unknown }> {
    const parsed = mcpResultRequestSchema.safeParse(body)
    if (!parsed.success) return { status: 400, body: { ok: false, reason: MALFORMED_REQUEST_REASON } }
    const recordMcpResult = this.recordMcpResult
    if (recordMcpResult === undefined) return { status: 404, body: { ok: false, reason: 'this bridge does not record MCP results' } }
    try {
      const result: McpResultRequest = { operationId: parsed.data.operationId, ok: parsed.data.ok, result: parsed.data.result }
      await withinDeadline((signal) => recordMcpResult(result, context, signal), this.deadlineMs)
      return { status: 200, body: { ok: true } }
    } catch (error) {
      return { status: 500, body: { ok: false, reason: failureReason(error) } }
    }
  }

  private respondJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return
    // Serialize before the headers go out, so a body that cannot be serialized still leaves room for a 500.
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(text)
  }

  /**
   * Timing-safe by construction: a naive `===` comparison short-circuits at
   * the first mismatched byte, and the resulting response-time difference
   * is enough for a local attacker to brute-force the token one byte at a
   * time. `timingSafeEqual` requires equal-length buffers, so the length
   * check below is a fast, safe rejection for the overwhelmingly common
   * case (wrong token entirely) without ever comparing byte-for-byte. Every
   * live token is compared, so which one matched leaks nothing either.
   */
  private authenticate(req: IncomingMessage): { ok: true; context: InvocationContext | undefined } | { ok: false } {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return { ok: false }
    const provided = Buffer.from(header.slice('Bearer '.length), 'utf8')
    let match: { ok: true; context: InvocationContext | undefined } | { ok: false } = { ok: false }
    const candidates: [string, InvocationContext | undefined][] = [[this.token, undefined], ...this.invocationTokens]
    for (const [token, context] of candidates) {
      const expected = Buffer.from(token, 'utf8')
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) match = { ok: true, context }
    }
    return match
  }
}
