/**
 * The MCP gateway (step 8): a stdio MCP proxy relay writes as the command of
 * every server in the worker's MCP set. It starts the real server as its
 * child and forwards every newline-delimited JSON-RPC message both ways
 * unchanged, except a `tools/call` request from the client, which goes to the
 * hook bridge first (src/autonomous/mcp-protocol.ts). The gateway holds no
 * database access and no policy: the bridge decides.
 *
 * Fail closed: an unreachable bridge, a non-200 answer, a timeout or a
 * malformed answer denies the call. A denied, pending or failed call is
 * answered with a tool result carrying `isError: true`, never forwarded.
 * A client method outside FORWARDED_METHODS is refused, so a server method
 * that could act without a `tools/call` never reaches the server.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { MCP_CALL_PATH, MCP_RESULT_PATH, type McpCallDecision, type McpCallRequest, type McpResultRequest } from './mcp-protocol.js'

export const BRIDGE_TIMEOUT_MS = 10_000
const CHILD_KILL_GRACE_MS = 2_000
/** How long a closed stdin waits for calls in flight before the child is stopped. */
const DRAIN_TIMEOUT_MS = 5_000

/** Client requests forwarded to the server as they are; `notifications/*` and responses are forwarded too. */
const FORWARDED_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'logging/setLevel',
])

type JsonRpcId = string | number
type JsonRpcMessage = {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

export type BridgeClient = {
  url: string
  token: string
  timeoutMs?: number
}

export type McpGatewayOptions = {
  server: string
  command: string
  args: readonly string[]
  /** Undefined when RELAY_HOOK_URL or RELAY_HOOK_TOKEN is missing: every call is denied. */
  bridge: BridgeClient | undefined
  input: Readable
  output: Writable
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function idKey(id: JsonRpcId): string {
  return JSON.stringify(id)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A `tools/call` answered by the gateway itself: a tool error, not a protocol error, so the worker reads the reason. */
function toolErrorResponse(id: JsonRpcId, text: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })
}

function parseDecision(value: unknown): McpCallDecision | undefined {
  if (!isObject(value)) return undefined
  switch (value.decision) {
    case 'allow':
      return { decision: 'allow' }
    case 'deny':
      return typeof value.reason === 'string' ? { decision: 'deny', reason: value.reason } : undefined
    case 'pending':
      return typeof value.operationId === 'string' && value.operationId.length > 0 && typeof value.message === 'string'
        ? { decision: 'pending', operationId: value.operationId, message: value.message }
        : undefined
    case 'execute':
      // Tool arguments are an object or absent; anything else is malformed.
      return typeof value.operationId === 'string' && value.operationId.length > 0 && (value.args === undefined || isObject(value.args))
        ? { decision: 'execute', operationId: value.operationId, args: value.args }
        : undefined
    default:
      return undefined
  }
}

async function postJson(bridge: BridgeClient, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${bridge.url.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(bridge.timeoutMs ?? BRIDGE_TIMEOUT_MS),
  })
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error(`bridge answered HTTP ${response.status}`)
  }
  return response.json()
}

/** Asks the bridge what to do with one call; any failure is a deny. */
async function decideMcpCall(bridge: BridgeClient | undefined, call: McpCallRequest): Promise<McpCallDecision> {
  if (bridge === undefined) return { decision: 'deny', reason: 'relay MCP gateway: RELAY_HOOK_URL or RELAY_HOOK_TOKEN is not set' }
  try {
    const decision = parseDecision(await postJson(bridge, MCP_CALL_PATH, call))
    return decision ?? { decision: 'deny', reason: 'relay MCP gateway: the bridge answer was malformed' }
  } catch (error) {
    return { decision: 'deny', reason: `relay MCP gateway: the bridge could not be reached (${(error as Error).message})` }
  }
}

/**
 * Runs the proxy until the child exits; resolves with the child's exit code.
 * Closing the client's stdin kills the child.
 */
export function runMcpGateway(options: McpGatewayOptions): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(options.command, [...options.args], {
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  /** Calls forwarded for an approved operation, by client request id, awaiting the child's response. */
  const executing = new Map<string, string>()
  /** Calls waiting for the bridge, by client request id. */
  const deciding = new Set<string>()
  /** Bridge decisions and results held until their outcome is reported; a closed stdin and exit wait for them. */
  const inFlight = new Set<Promise<void>>()
  let childOpen = true

  // A reader that went away (EPIPE) must not crash the gateway; the close paths end it.
  child.stdin.on('error', (error) => log(`relay MCP gateway: server stdin: ${error.message}`))
  options.output.on('error', (error) => log(`relay MCP gateway: client stdout: ${error.message}`))

  const track = (work: Promise<void>): void => {
    inFlight.add(work)
    void work.finally(() => inFlight.delete(work))
  }
  const toClient = (line: string): void => {
    if (options.output.writable) options.output.write(`${line}\n`)
  }
  const toChild = (line: string): void => {
    if (childOpen && child.stdin.writable) child.stdin.write(`${line}\n`)
  }

  const handleCall = async (message: JsonRpcMessage & { id: JsonRpcId }): Promise<void> => {
    const params = isObject(message.params) ? message.params : {}
    const tool = params.name
    if (typeof tool !== 'string') {
      toClient(toolErrorResponse(message.id, 'relay MCP gateway: tools/call without a tool name'))
      return
    }
    const decision = await decideMcpCall(options.bridge, { server: options.server, tool, args: params.arguments ?? null })
    switch (decision.decision) {
      case 'allow':
        toChild(JSON.stringify(message))
        return
      case 'deny':
        toClient(toolErrorResponse(message.id, decision.reason))
        return
      case 'pending':
        toClient(toolErrorResponse(message.id, decision.message.includes(decision.operationId)
          ? decision.message
          : `${decision.message} (operation ${decision.operationId})`))
        return
      case 'execute':
        executing.set(idKey(message.id), decision.operationId)
        toChild(JSON.stringify({ ...message, params: { ...params, arguments: decision.args } }))
        return
    }
  }

  const reportOutcome = async (operationId: string, response: JsonRpcMessage): Promise<void> => {
    const ok = response.error === undefined && !(isObject(response.result) && response.result.isError === true)
    const body: McpResultRequest = { operationId, ok, result: response.error ?? response.result ?? null }
    if (options.bridge === undefined) return
    try {
      await postJson(options.bridge, MCP_RESULT_PATH, body)
    } catch (error) {
      // The call already ran; the daemon reconciles the operation as uncertain.
      log(`relay MCP gateway: could not report operation ${operationId}: ${(error as Error).message}`)
    }
  }

  const fromClient = (message: JsonRpcMessage): void => {
    const method = message.method
    // A response to a server request (sampling, roots, elicitation) carries no method.
    if (method === undefined || (typeof method === 'string' && (FORWARDED_METHODS.has(method) || method.startsWith('notifications/')))) {
      toChild(JSON.stringify(message))
      return
    }
    // A notification has no id to answer; one outside the list is dropped, never forwarded.
    if (!isId(message.id)) return
    if (method !== 'tools/call') {
      toClient(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found (relay MCP gateway)' } }))
      return
    }
    const key = idKey(message.id)
    if (deciding.has(key) || executing.has(key)) {
      toClient(toolErrorResponse(message.id, 'relay MCP gateway: a call with this request id is already in progress'))
      return
    }
    deciding.add(key)
    track(handleCall(message as JsonRpcMessage & { id: JsonRpcId }).finally(() => deciding.delete(key)))
  }

  const fromChild = (line: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      toClient(line)
      return
    }
    // A batch is reported member by member, then forwarded as it came.
    const reports: Array<Promise<void>> = []
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isObject(message) || message.method !== undefined || !isId(message.id)) continue
      const operationId = executing.get(idKey(message.id))
      if (operationId === undefined) continue
      executing.delete(idKey(message.id))
      reports.push(reportOutcome(operationId, message))
    }
    if (reports.length === 0) {
      toClient(line)
      return
    }
    track(Promise.all(reports).then(() => toClient(line)))
  }

  /** Waits, bounded, until no call is deciding, executing or reporting. */
  const drain = async (): Promise<void> => {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while ((inFlight.size > 0 || executing.size > 0) && childOpen && Date.now() < deadline) {
      const tick = new Promise((resolve) => setTimeout(resolve, 50))
      await (inFlight.size > 0 ? Promise.race([Promise.allSettled([...inFlight]), tick]) : tick)
    }
  }

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', fromChild)

  const clientLines = createInterface({ input: options.input, crlfDelay: Infinity })
  clientLines.on('line', (line) => {
    if (line.trim().length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Unparseable input is dropped rather than passed to a server whose parser may read it differently.
      log('relay MCP gateway: dropped a client line that is not JSON')
      return
    }
    // A batch is split, so every call in it is decided on its own.
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isObject(message)) fromClient(message)
    }
  })
  let killTimer: NodeJS.Timeout | undefined
  clientLines.on('close', () => {
    void drain().then(() => {
      child.stdin.end()
      if (!childOpen) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_GRACE_MS)
      killTimer.unref()
    })
  })

  return new Promise((resolve) => {
    child.on('error', (error) => {
      childOpen = false
      log(`relay MCP gateway: could not start ${options.server}: ${error.message}`)
      resolve(1)
    })
    // 'close' fires after the child's stdout is drained, so every held result has started reporting.
    child.on('close', (code, signal) => {
      childOpen = false
      clearTimeout(killTimer)
      void Promise.allSettled([...inFlight]).then(() => resolve(code ?? (signal !== null ? 1 : 0)))
    })
  })
}

/**
 * Deny-all mode: stands in for a native server excluded from this task. It
 * starts no child, lists no tools, and refuses every call.
 */
export function runDenyAllGateway(options: { server: string; input: Readable; output: Writable }): Promise<number> {
  const reply = (body: Record<string, unknown>): void => {
    options.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...body })}\n`)
  }
  const handle = (message: JsonRpcMessage): void => {
    if (!isId(message.id) || typeof message.method !== 'string') return
    const params = isObject(message.params) ? message.params : {}
    switch (message.method) {
      case 'initialize':
        reply({
          id: message.id,
          result: {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: `relay-deny-all-${options.server}`, version: '1' },
          },
        })
        return
      case 'ping':
        reply({ id: message.id, result: {} })
        return
      case 'tools/list':
        reply({ id: message.id, result: { tools: [] } })
        return
      case 'tools/call':
        reply({ id: message.id, result: { content: [{ type: 'text', text: `relay: MCP server ${options.server} is not enabled for this task` }], isError: true } })
        return
      default:
        reply({ id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
  const lines = createInterface({ input: options.input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    try {
      const parsed: unknown = JSON.parse(line)
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        if (isObject(message)) handle(message)
      }
    } catch {
      // Not JSON: nothing to answer.
    }
  })
  return new Promise((resolve) => lines.on('close', () => resolve(0)))
}
