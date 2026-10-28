import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { McpCallDecision, McpCallRequest, McpResultRequest } from '../../src/autonomous/mcp-protocol.js'

const execFileAsync = promisify(execFile)
const BUILD_TIMEOUT_MS = 120_000

const dir = mkdtempSync(join(tmpdir(), 'relay-mcp-gateway-'))
const gatewayScript = join(dir, 'out', 'scripts', 'mcp-gateway.js')
const serverLog = join(dir, 'server-calls.log')
const startMarker = join(dir, 'server-started')
const pidFile = join(dir, 'server-pid')

// A fake MCP server: answers initialize and tools/list, echoes each call's arguments and logs it.
// batch_thing answers inside a JSON array; any other method is logged and answered, so a forwarded one shows.
const FAKE_SERVER = `
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
writeFileSync(${JSON.stringify(startMarker)}, 'started')
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...body }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'read_thing', inputSchema: { type: 'object' } }, { name: 'write_thing', inputSchema: { type: 'object' } }] } })
  else if (message.method === 'tools/call') {
    appendFileSync(${JSON.stringify(serverLog)}, JSON.stringify(message.params) + '\\n')
    const response = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ran ' + message.params.name + ' ' + JSON.stringify(message.params.arguments) }] } }
    process.stdout.write(JSON.stringify(message.params.name === 'batch_thing' ? [response] : response) + '\\n')
  } else if (message.id !== undefined) {
    appendFileSync(${JSON.stringify(serverLog)}, JSON.stringify({ method: message.method }) + '\\n')
    send({ id: message.id, result: { forwarded: message.method } })
  }
})
`
const fakeServer = join(dir, 'fake-server.mjs')

beforeAll(async () => {
  writeFileSync(fakeServer, FAKE_SERVER)
  // Same shape as the hook script test: a targeted tsc build of the entry's dependency closure.
  await execFileAsync('npx', [
    'tsc', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--lib', 'ES2023', '--strict', '--noUncheckedIndexedAccess', '--noImplicitOverride',
    '--exactOptionalPropertyTypes', '--verbatimModuleSyntax', '--skipLibCheck',
    '--outDir', join(dir, 'out'), '--rootDir', '.', 'scripts/mcp-gateway.ts',
  ], { timeout: BUILD_TIMEOUT_MS })
}, BUILD_TIMEOUT_MS + 10_000)

type Bridge = { url: string; calls: McpCallRequest[]; results: McpResultRequest[]; auth: string[]; server: Server }

async function startBridge(decide: (call: McpCallRequest) => McpCallDecision | 'malformed', delayMs = 0): Promise<Bridge> {
  const bridge: Omit<Bridge, 'url'> = { calls: [], results: [], auth: [], server: undefined as unknown as Server }
  bridge.server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      bridge.auth.push(req.headers.authorization ?? '')
      if (req.url === '/hook/mcp-call') {
        const call = JSON.parse(body) as McpCallRequest
        bridge.calls.push(call)
        const decision = decide(call)
        setTimeout(() => res.end(decision === 'malformed' ? '{"decision":"execute"}' : JSON.stringify(decision)), delayMs)
      } else if (req.url === '/hook/mcp-result') {
        bridge.results.push(JSON.parse(body) as McpResultRequest)
        res.end('{}')
      } else {
        res.statusCode = 404
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => bridge.server.listen(0, '127.0.0.1', resolve))
  const port = (bridge.server.address() as AddressInfo).port
  return { ...bridge, url: `http://127.0.0.1:${port}/hook` }
}

type Client = {
  child: ChildProcessWithoutNullStreams
  /** Every line the gateway wrote, parsed. */
  received: Array<Record<string, unknown>>
  request: (id: number, method: string, params?: unknown) => Promise<Record<string, unknown>>
}

const openChildren: ChildProcessWithoutNullStreams[] = []
const openBridges: Server[] = []

afterEach(async () => {
  // Closing stdin lets each gateway stop its server, so no orphan writes markers into a later test.
  await Promise.all(openChildren.splice(0).map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.stdin.end()
  })))
  for (const server of openBridges.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  writeFileSync(serverLog, '')
})

function startGateway(args: string[], env: Record<string, string | undefined>): Client {
  const child = spawn(process.execPath, [gatewayScript, ...args], { env: { ...process.env, ...env } })
  openChildren.push(child)
  const waiting = new Map<number, (message: Record<string, unknown>) => void>()
  const received: Array<Record<string, unknown>> = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const parsed = JSON.parse(line) as Record<string, unknown> | Array<Record<string, unknown>>
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      received.push(message)
      waiting.get(message.id as number)?.(message)
    }
  })
  return {
    child,
    received,
    request: (id, method, params) => new Promise((resolve) => {
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }),
  }
}

function gatewayFor(bridge: Bridge | { url: string }): Client {
  return startGateway(['fake', '--', process.execPath, fakeServer], { RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: 'tok-1' })
}

function serverCalls(): Array<{ name: string; arguments: unknown }> {
  if (!existsSync(serverLog)) return []
  return readFileSync(serverLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { name: string; arguments: unknown })
}

function text(response: Record<string, unknown>): string {
  return ((response.result as { content: Array<{ text: string }> }).content[0]?.text) ?? ''
}

describe('MCP gateway process', () => {
  it('forwards tools/list unchanged and a call the bridge allows', async () => {
    const bridge = await startBridge(() => ({ decision: 'allow' }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const listed = await client.request(1, 'tools/list')
    expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(['read_thing', 'write_thing'])
    const called = await client.request(2, 'tools/call', { name: 'read_thing', arguments: { q: 1 } })

    expect(text(called)).toBe('ran read_thing {"q":1}')
    expect(called.result).not.toHaveProperty('isError')
    expect(bridge.calls).toEqual([{ server: 'fake', tool: 'read_thing', args: { q: 1 } }])
    expect(bridge.auth).toEqual(['Bearer tok-1'])
  })

  it('returns the pending message as a tool error and never runs the write', async () => {
    const bridge = await startBridge(() => ({ decision: 'pending', operationId: 'op-7', message: 'operation op-7 waits for approval' }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const called = await client.request(1, 'tools/call', { name: 'write_thing', arguments: { body: 'x' } })

    expect(called.result).toMatchObject({ isError: true })
    expect(text(called)).toBe('operation op-7 waits for approval')
    expect(called).not.toHaveProperty('error')
    expect(serverCalls()).toEqual([])
  })

  it('executes with the stored arguments exactly once and reports the result', async () => {
    const bridge = await startBridge((call) => (call.tool === 'write_thing'
      ? { decision: 'execute', operationId: 'op-9', args: { body: 'stored' } }
      : { decision: 'allow' }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const called = await client.request(1, 'tools/call', { name: 'write_thing', arguments: { body: 'client' } })

    expect(text(called)).toBe('ran write_thing {"body":"stored"}')
    expect(serverCalls()).toEqual([{ name: 'write_thing', arguments: { body: 'stored' } }])
    expect(bridge.results).toEqual([{ operationId: 'op-9', ok: true, result: called.result }])
  })

  it('sends the client arguments, not an approved operation\'s, so the bridge decides a changed call as new', async () => {
    const bridge = await startBridge((call) => (JSON.stringify(call.args) === '{"body":"approved"}'
      ? { decision: 'execute', operationId: 'op-1', args: { body: 'approved' } }
      : { decision: 'pending', operationId: 'op-2', message: 'operation op-2 waits for approval' }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const changed = await client.request(1, 'tools/call', { name: 'write_thing', arguments: { body: 'changed' } })

    expect(bridge.calls).toEqual([{ server: 'fake', tool: 'write_thing', args: { body: 'changed' } }])
    expect(text(changed)).toBe('operation op-2 waits for approval')
    expect(serverCalls()).toEqual([])
    expect(bridge.results).toEqual([])
  })

  it('keeps responses matched to their ids under concurrent calls', async () => {
    const bridge = await startBridge((call) => (call.tool === 'write_thing'
      ? { decision: 'deny', reason: 'no' }
      : { decision: 'allow' }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const responses = await Promise.all([1, 2, 3, 4].map((id) => client.request(id, 'tools/call', { name: id % 2 === 0 ? 'write_thing' : 'read_thing', arguments: { id } })))

    expect(responses.map((response) => [response.id, text(response)])).toEqual([
      [1, 'ran read_thing {"id":1}'], [2, 'no'], [3, 'ran read_thing {"id":3}'], [4, 'no'],
    ])
  })

  it('denies when the bridge is unreachable, malformed or the token is missing', async () => {
    const closed = await startBridge(() => ({ decision: 'allow' }))
    await new Promise<void>((resolve) => closed.server.close(() => resolve()))
    const malformed = await startBridge(() => 'malformed')
    openBridges.push(malformed.server)

    for (const client of [
      gatewayFor(closed),
      gatewayFor(malformed),
      startGateway(['fake', '--', process.execPath, fakeServer], { RELAY_HOOK_URL: malformed.url, RELAY_HOOK_TOKEN: undefined }),
    ]) {
      const called = await client.request(1, 'tools/call', { name: 'read_thing', arguments: {} })
      expect(called.result).toMatchObject({ isError: true })
    }
    expect(serverCalls()).toEqual([])
  })

  it('kills the server when stdin closes and exits', async () => {
    const bridge = await startBridge(() => ({ decision: 'allow' }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)
    await client.request(1, 'tools/list')
    const serverPid = Number(readFileSync(pidFile, 'utf8'))

    const exited = new Promise<number | null>((resolve) => client.child.on('exit', resolve))
    client.child.stdin.end()

    expect(await exited).not.toBeNull()
    expect(() => process.kill(serverPid, 0)).toThrow()
  })

  it('finishes a call in flight when stdin closes before stopping the server', async () => {
    const bridge = await startBridge(() => ({ decision: 'execute', operationId: 'op-3', args: { body: 'stored' } }), 300)
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const called = client.request(1, 'tools/call', { name: 'write_thing', arguments: { body: 'stored' } })
    client.child.stdin.end()

    expect(text(await called)).toBe('ran write_thing {"body":"stored"}')
    expect(bridge.results.map((result) => result.operationId)).toEqual(['op-3'])
  })

  it('refuses a client method outside the forwarded list and forwards a listed one', async () => {
    const bridge = await startBridge(() => ({ decision: 'allow' }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const refused = await client.request(1, 'custom/act', { x: 1 })
    const read = await client.request(2, 'resources/read', { uri: 'file:///x' })

    expect(refused.error).toMatchObject({ code: -32601 })
    expect(read.result).toEqual({ forwarded: 'resources/read' })
    expect(serverCalls()).toEqual([{ method: 'resources/read' }])
  })

  it('reports an executed result that the server answers inside a batch', async () => {
    const bridge = await startBridge(() => ({ decision: 'execute', operationId: 'op-4', args: { n: 1 } }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const called = await client.request(1, 'tools/call', { name: 'batch_thing', arguments: { n: 1 } })

    expect(text(called)).toBe('ran batch_thing {"n":1}')
    expect(bridge.results).toEqual([{ operationId: 'op-4', ok: true, result: called.result }])
  })

  it('refuses a call whose id is already in progress', async () => {
    const bridge = await startBridge(() => ({ decision: 'allow' }), 200)
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const first = client.request(1, 'tools/call', { name: 'read_thing', arguments: { n: 1 } })
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_thing', arguments: {} } })}\n`)
    await first
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(bridge.calls.map((call) => call.tool)).toEqual(['read_thing'])
    expect(client.received.map(text).sort()).toEqual(['ran read_thing {"n":1}', 'relay MCP gateway: a call with this request id is already in progress'])
  })

  it('denies an execute decision whose stored arguments are not an object', async () => {
    const bridge = await startBridge(() => ({ decision: 'execute', operationId: 'op-5', args: 'rm -rf' }))
    openBridges.push(bridge.server)
    const client = gatewayFor(bridge)

    const called = await client.request(1, 'tools/call', { name: 'write_thing', arguments: {} })

    expect(called.result).toMatchObject({ isError: true })
    expect(serverCalls()).toEqual([])
  })

  it('in deny-all mode starts no server and lists no tools', async () => {
    writeFileSync(startMarker, '')
    const client = startGateway(['--deny-all', 'playwright-extension'], {})

    const listed = await client.request(1, 'tools/list')
    const called = await client.request(2, 'tools/call', { name: 'browser_navigate', arguments: {} })

    expect(listed.result).toEqual({ tools: [] })
    expect(called.result).toMatchObject({ isError: true })
    expect(readFileSync(startMarker, 'utf8')).toBe('')
  })
})
