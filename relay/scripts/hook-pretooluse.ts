#!/usr/bin/env node
/**
 * The actual `PreToolUse` hook Claude Code invokes as a `type: "command"`
 * hook, per the Task 5 design note. Reads the real Claude Code hook
 * payload on stdin, asks src/engine/hook-bridge.ts's HTTP server (running
 * in-process inside Relay's orchestrator for the duration of this run)
 * what policy says, and prints Claude Code's own `hookSpecificOutput`
 * shape on stdout.
 *
 * EVERY FAILURE MODE DENIES, NEVER ALLOWS, AND ALWAYS EXITS 0.
 * Per the design note's empirical findings: exit code 0 with a parsed
 * `permissionDecision` is the only outcome this script ever produces,
 * because any OTHER exit code is a "non-blocking error" that lets the
 * tool call proceed regardless of what this script's own logic decided,
 * which is the exact fail-open hazard the whole bridge exists to avoid.
 * That is why literally everything here, including stdin itself failing
 * to arrive, is wrapped so it can only ever end in an explicit deny
 * decision printed to stdout, not a thrown exception or a non-zero exit.
 *
 * A HARD INTERNAL DEADLINE, separate from Claude Code's own hook timeout.
 * If this script relied only on Code's own configured hook timeout to
 * bound how long it runs, a hang in ANY phase (stdin never closing, the
 * fetch to the bridge never resolving) would be indistinguishable from the
 * exact fail-open scenario the design note proved: Code's timeout fires,
 * this script's output is discarded, the tool call proceeds. HARD_DEADLINE_MS
 * below is this script's own, shorter deadline: whichever phase is stuck,
 * once it fires, an explicit deny is printed and the process exits
 * immediately. The settings.json entry that registers this hook MUST set
 * Code's own `timeout` field comfortably above HARD_DEADLINE_MS, so this
 * script's own deadline is always the one that fires first.
 *
 * CODEX. Codex runs this same script as its PreToolUse hook for Bash, with
 * `--codex` appended to the command (src/autonomous/worker-config.ts). Its
 * payload names the shell command `tool_input.command` (or `cmd`, possibly
 * as an argv list) with the shell's own `tool_input.workdir`, and may carry
 * no `tool_use_id`, so one is generated. Codex rejects
 * `permissionDecision: allow` and has no `defer`: under `--codex` an allow
 * prints nothing (exit 0 with empty stdout is codex's allow) and a defer
 * becomes a deny.
 */

import { randomUUID } from 'node:crypto'
import type { HookBridgeDecision, HookDecisionRequest } from '../src/engine/hook-bridge.js'

/** How long this script gives itself, total, from start to a printed decision. Comfortably under any sane hook timeout the settings config sets; see this file's header comment for why this matters more than it looks like it should. */
const HARD_DEADLINE_MS = 8_000
/** How long the fetch to the bridge itself gets, strictly less than HARD_DEADLINE_MS so there is always time left to print a deny and exit cleanly afterward. */
const FETCH_TIMEOUT_MS = 5_000

const FAIL_CLOSED_REASON_PREFIX = 'relay hook bridge unavailable or failed'

const FOR_CODEX = process.argv.includes('--codex')

interface ClaudeCodeHookInput {
  readonly session_id?: unknown
  readonly tool_name?: unknown
  readonly tool_input?: unknown
  readonly tool_use_id?: unknown
  readonly cwd?: unknown
}

let decided = false

/** Prints Claude Code's own PreToolUse output shape and marks a decision as made. Idempotent: a second call is a silent no-op, so a race between the hard deadline timer and the normal async flow can never print two competing decisions to the same stdout stream. */
function emitDecision(decision: HookBridgeDecision, reason: string): void {
  if (decided) return
  decided = true
  if (FOR_CODEX && decision === 'allow') return
  const codexDefer = FOR_CODEX && decision === 'defer'
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: codexDefer ? 'deny' : decision,
      permissionDecisionReason: codexDefer ? `relay cannot defer a codex tool call: ${reason}` : reason,
    },
  }
  try {
    process.stdout.write(JSON.stringify(payload))
  } catch {
    // stdout itself is broken. There is genuinely nothing left this script
    // can do to communicate a decision safely; see the outer catch-all
    // below for why exiting 0 with no output is still the least-bad
    // outcome available, not a novel failure mode this script introduces.
  }
}

/** POSIX single-quoting, so an argv list joins into one command string that means the same thing. */
function shellQuote(part: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`
}

/** The shell command always under `command` as one string, as ~/.agents/hooks/adapters/run.py's tool_input() does; anything else passes through unchanged. */
function normalizeToolInput(toolInput: unknown): unknown {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return toolInput
  const data = toolInput as Record<string, unknown>
  const command = data.command ?? data.cmd
  if (Array.isArray(command)) return { ...data, command: command.map((part) => shellQuote(String(part))).join(' ') }
  if (command !== undefined && data.command === undefined) return { ...data, command }
  return toolInput
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function resolveViaBridge(url: string, token: string, body: HookDecisionRequest): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      emitDecision('deny', `${FAIL_CLOSED_REASON_PREFIX}: HTTP ${response.status}`)
      return
    }
    const parsed = (await response.json()) as { decision?: unknown; reason?: unknown }
    if (parsed.decision !== 'allow' && parsed.decision !== 'deny' && parsed.decision !== 'defer') {
      emitDecision('deny', `${FAIL_CLOSED_REASON_PREFIX}: unrecognised response shape`)
      return
    }
    emitDecision(parsed.decision, typeof parsed.reason === 'string' ? parsed.reason : 'no reason given')
  } catch {
    emitDecision('deny', `${FAIL_CLOSED_REASON_PREFIX}: network error or timeout reaching it`)
  } finally {
    clearTimeout(timeout)
  }
}

async function main(): Promise<void> {
  const url = process.env.RELAY_HOOK_URL
  const token = process.env.RELAY_HOOK_TOKEN
  if (url === undefined || url.trim().length === 0 || token === undefined || token.trim().length === 0) {
    emitDecision('deny', 'RELAY_HOOK_URL or RELAY_HOOK_TOKEN is not set in this process’s environment')
    return
  }

  let raw: string
  try {
    raw = await readStdin()
  } catch {
    emitDecision('deny', 'could not read the hook payload from stdin')
    return
  }

  let input: ClaudeCodeHookInput
  try {
    input = JSON.parse(raw) as ClaudeCodeHookInput
  } catch {
    emitDecision('deny', 'could not parse the hook payload from Claude Code as JSON')
    return
  }

  if (input === null || typeof input !== 'object') {
    emitDecision('deny', 'the hook payload was not a JSON object')
    return
  }
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : undefined
  const sessionId = typeof input.session_id === 'string' ? input.session_id : undefined
  if (toolName === undefined || sessionId === undefined) {
    emitDecision('deny', 'the hook payload was missing tool_name or session_id')
    return
  }
  // Codex may send no tool_use_id; the bridge only needs one to name the call.
  const toolUseId =
    typeof input.tool_use_id === 'string' && input.tool_use_id.length > 0 ? input.tool_use_id : `relay-${randomUUID()}`

  const request: HookDecisionRequest = {
    toolUseId,
    toolName,
    sessionId,
    ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    toolInput: normalizeToolInput(input.tool_input),
  }
  await resolveViaBridge(url, token, request)
}

const hardDeadline = setTimeout(() => {
  emitDecision('deny', 'this hook script exceeded its own internal deadline before reaching a decision')
  process.exit(0)
}, HARD_DEADLINE_MS)

main()
  .catch(() => {
    // The last resort. Every await inside main() already has its own
    // try/catch that ends in emitDecision(); this only fires if something
    // outside every one of them still threw, which emitDecision's own
    // idempotency guard means is still safe to call again here.
    emitDecision('deny', 'unexpected hook script failure')
  })
  .finally(() => {
    clearTimeout(hardDeadline)
    process.exit(0)
  })
