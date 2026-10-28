/**
 * The worker's MCP set (step 7, user decision 6): every server in
 * ~/.agents/mcp/servers.json, the same for claude and codex, ignoring the
 * `clients` field, each wrapped by the MCP gateway (scripts/mcp-gateway.ts).
 *
 * - `playwright` (headless) runs isolated behind the task's egress proxy and
 *   trusts only the task CA, through Chrome's SPKI allow list; it never gets
 *   `--ignore-https-errors`.
 * - `playwright-extension` is included only with the task's extension grant;
 *   its token (PLAYWRIGHT_MCP_EXTENSION_TOKEN, the worker's extraEnv) reaches
 *   codex through `env_vars` and claude through its per-invocation 0600
 *   config file, never servers.json or config.toml.
 * - Claude gets the set as a `--mcp-config` file (with `--strict-mcp-config`).
 * - Codex gets `-c` overrides. Codex merges an override into the native table
 *   (tables merge, arrays and values replace), so every native
 *   `[mcp_servers.<name>]` in the codex home's config.toml is overridden:
 *   wrapped when in the set, otherwise pointed at the deny-all gateway with
 *   `enabled = false`, and native env keys the set does not define are blanked.
 */

import { X509Certificate, createHash } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'

export const DEFAULT_MCP_SERVERS_FILE = join(homedir(), '.agents', 'mcp', 'servers.json')
export const HEADLESS_PLAYWRIGHT = 'playwright'
export const PLAYWRIGHT_EXTENSION = 'playwright-extension'

/** What the gateway needs from the worker env; codex forwards only listed variables to a server. */
const GATEWAY_ENV_VARS = ['RELAY_HOOK_URL', 'RELAY_HOOK_TOKEN']

/** Flags the headless server must not receive from servers.json: each would bypass the proxy or the CA check, or attach to a real browser. */
const REFUSED_PLAYWRIGHT_FLAGS = ['--ignore-https-errors', '--extension', '--cdp-endpoint', '--endpoint', '--proxy-server', '--proxy-bypass', '--config', '--user-data-dir']

/** Blanked in the headless server's env so an operator variable cannot override the flags relay passes (an empty value reads as unset). */
const BLANKED_PLAYWRIGHT_ENV = {
  PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS: 'false',
  PLAYWRIGHT_MCP_EXTENSION: 'false',
  PLAYWRIGHT_MCP_EXTENSION_TOKEN: '',
  PLAYWRIGHT_MCP_CDP_ENDPOINT: '',
  PLAYWRIGHT_MCP_ENDPOINT: '',
  PLAYWRIGHT_MCP_PROXY_BYPASS: '',
  PLAYWRIGHT_MCP_PROXY_SERVER: '',
  PLAYWRIGHT_MCP_CONFIG: '',
  PLAYWRIGHT_MCP_USER_DATA_DIR: '',
}

const serverSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  env_vars: z.array(z.string()).default([]),
})

const serversFileSchema = z.object({ mcpServers: z.record(serverSchema) })

export type McpServerDefinition = z.infer<typeof serverSchema>

/** One server as the worker's clients launch it: already wrapped by the gateway. */
export type WorkerMcpServer = {
  command: string
  args: string[]
  /** Static, non-secret values only. */
  env: Record<string, string>
  /** Codex: variables forwarded from the worker env (secrets arrive this way). */
  envVars: string[]
}

export type WorkerMcpSet = {
  servers: Record<string, WorkerMcpServer>
  /** For runWorkerTurn's claude init check. */
  allowedMcpServerNames: string[]
  /** The deny-all stand-in for a native codex server outside the set. */
  denyAll: (name: string) => WorkerMcpServer
}

/** How the gateway is launched, e.g. `{ command: process.execPath, args: ['<relay>/dist/scripts/mcp-gateway.js'] }`. */
export type GatewayCommand = { command: string; args: readonly string[] }

export type WorkerMcpParams = {
  servers: Record<string, McpServerDefinition>
  gateway: GatewayCommand
  /** The task has an extension grant (step 10). */
  extensionGranted: boolean
  /** The task's egress proxy, e.g. `http://127.0.0.1:<port>`. */
  proxyUrl: string
  /** The task CA's PEM certificate. */
  caCertPath: string
  /** Where the caller writes `playwrightConfig` (relay-written, no secrets). */
  playwrightConfigPath: string
}

export function readMcpServers(path: string = DEFAULT_MCP_SERVERS_FILE): Record<string, McpServerDefinition> {
  return parseMcpServers(readFileSync(path, 'utf8'))
}

export function parseMcpServers(text: string): Record<string, McpServerDefinition> {
  return serversFileSchema.parse(JSON.parse(text)).mcpServers
}

/** Chrome's `--ignore-certificate-errors-spki-list` value for a PEM certificate: base64 SHA-256 of its SubjectPublicKeyInfo. */
export function spkiHash(pem: string): string {
  const der = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('base64')
}

/**
 * The @playwright/mcp config file for the headless server (checked against
 * 0.0.83: it has no CA option, so Chrome is told to trust certificates whose
 * chain holds the task CA's key; the proxy must send the CA in its chain).
 */
export function renderPlaywrightConfig(caCertPem: string): string {
  return `${JSON.stringify({ browser: { launchOptions: { args: [`--ignore-certificate-errors-spki-list=${spkiHash(caCertPem)}`] } } }, null, 2)}\n`
}

function wrap(gateway: GatewayCommand, name: string, command: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: gateway.command, args: [...gateway.args, name, '--', command, ...args] }
}

export function buildWorkerMcpSet(params: WorkerMcpParams): WorkerMcpSet & { playwrightConfig: string | undefined } {
  const servers: Record<string, WorkerMcpServer> = {}
  let playwrightConfig: string | undefined
  for (const [name, definition] of Object.entries(params.servers)) {
    if (name === PLAYWRIGHT_EXTENSION && !params.extensionGranted) continue
    let args = definition.args
    let env = definition.env
    let envVars = definition.env_vars
    if (name === HEADLESS_PLAYWRIGHT) {
      const refused = args.filter((arg) => REFUSED_PLAYWRIGHT_FLAGS.includes(arg.split('=')[0] ?? arg))
      if (refused.length > 0) throw new Error(`servers.json gives ${HEADLESS_PLAYWRIGHT} ${refused.join(', ')}, which relay refuses`)
      playwrightConfig = renderPlaywrightConfig(readFileSync(params.caCertPath, 'utf8'))
      args = [...args, '--headless', '--isolated', '--proxy-server', params.proxyUrl, '--config', params.playwrightConfigPath]
      env = { ...env, ...BLANKED_PLAYWRIGHT_ENV }
      // A forwarded PLAYWRIGHT_MCP_* variable could undo the blanking, so none is forwarded.
      envVars = envVars.filter((variable) => !variable.startsWith('PLAYWRIGHT_MCP_'))
    }
    servers[name] = {
      ...wrap(params.gateway, name, definition.command, args),
      env,
      envVars: [...new Set([...GATEWAY_ENV_VARS, ...envVars])],
    }
  }
  return {
    servers,
    allowedMcpServerNames: Object.keys(servers),
    denyAll: (name) => ({ command: params.gateway.command, args: [...params.gateway.args, '--deny-all', name], env: {}, envVars: [] }),
    playwrightConfig,
  }
}

/**
 * The `--mcp-config` file claude reads. Claude's env handling for stdio
 * servers is not something relay relies on, so each server's forwarded
 * variables (the per-invocation bridge token, the extension token) are copied
 * from `workerEnv` into its `env`; the file is per invocation and written with
 * mode 0600 by writeClaudeMcpConfig. Static values win, so the headless
 * server's blanking holds.
 */
export function renderClaudeMcpConfig(set: WorkerMcpSet, workerEnv: NodeJS.ProcessEnv): string {
  const mcpServers = Object.fromEntries(
    Object.entries(set.servers).map(([name, server]) => {
      const forwarded = server.envVars.flatMap((variable) => {
        const value = workerEnv[variable]
        return value === undefined ? [] : [[variable, value] as const]
      })
      return [name, { type: 'stdio', command: server.command, args: server.args, env: { ...Object.fromEntries(forwarded), ...server.env } }]
    }),
  )
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`
}

export function writeClaudeMcpConfig(path: string, set: WorkerMcpSet, workerEnv: NodeJS.ProcessEnv): void {
  writeFileSync(path, renderClaudeMcpConfig(set, workerEnv), { mode: 0o600 })
  chmodSync(path, 0o600)
}

type NativeServer = Record<string, unknown> & { env?: unknown; url?: unknown }

/**
 * Native keys a wrapped stdio entry may keep after codex merges the override
 * in. Any other key (`cwd`, `url`, `bearer_token_env_var`, `http_headers`, ...)
 * would survive the merge and change how the gateway runs, so it is refused.
 */
const KEPT_NATIVE_KEYS = new Set([
  'command', 'args', 'env', 'env_vars', 'enabled', 'tools', 'enabled_tools', 'disabled_tools',
  'startup_timeout_sec', 'startup_timeout_ms', 'tool_timeout_sec',
])

function unkeptKeys(existing: NativeServer | undefined): string[] {
  return existing === undefined ? [] : Object.keys(existing).filter((key) => !KEPT_NATIVE_KEYS.has(key))
}

/** The native `[mcp_servers]` tables of a codex home's config.toml text; undefined text means none. */
export function readCodexNativeServers(configToml: string | undefined): Record<string, NativeServer> {
  if (configToml === undefined) return {}
  const parsed = parseToml(configToml) as { mcp_servers?: unknown }
  const servers = parsed.mcp_servers
  if (servers === undefined) return {}
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) throw new Error('codex config.toml mcp_servers is not a table')
  return servers as Record<string, NativeServer>
}

/**
 * `-c` overrides (without the `-c`) that leave no unwrapped server in codex:
 * the set's servers wrapped, every other native name disabled. A native entry
 * for a server in the set with a key outside KEPT_NATIVE_KEYS throws.
 */
export function buildCodexMcpOverrides(set: WorkerMcpSet, configToml: string | undefined): string[] {
  const native = readCodexNativeServers(configToml)
  const overrides: string[] = []
  for (const [name, server] of Object.entries(set.servers)) {
    const existing = native[name]
    const unkept = unkeptKeys(existing)
    if (unkept.length > 0) throw new Error(`codex config.toml gives ${name} ${unkept.join(', ')}, which a gateway entry cannot keep; remove them`)
    overrides.push(codexOverride(name, { ...server, enabled: true }, existing))
  }
  for (const [name, existing] of Object.entries(native)) {
    if (name in set.servers) continue
    // An override cannot remove a key, so an entry with any other key (a url server, a cwd) is only disabled.
    overrides.push(unkeptKeys(existing).length > 0
      ? `mcp_servers.${serverKey(name)}.enabled=false`
      : codexOverride(name, { ...set.denyAll(name), enabled: false }, existing))
  }
  return overrides
}

function codexOverride(name: string, server: WorkerMcpServer & { enabled: boolean }, existing: NativeServer | undefined): string {
  // Native env keys survive a merge, so the ones the set does not define are blanked.
  const nativeEnv = existing !== undefined && typeof existing.env === 'object' && existing.env !== null ? Object.keys(existing.env) : []
  const env = { ...Object.fromEntries(nativeEnv.map((key) => [key, ''])), ...server.env }
  const table = { command: server.command, args: server.args, env, env_vars: server.envVars, enabled: server.enabled }
  return `mcp_servers.${serverKey(name)}=${tomlValue(table)}`
}

/**
 * Codex splits a `-c` key path on every dot and does not read quoted keys
 * (codex-cli 0.164.0 treats `mcp_servers."a b"` as a new server named `"a b"`),
 * so a server name that is not a bare key cannot be overridden: refused.
 */
function serverKey(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`MCP server name ${JSON.stringify(name)} cannot be overridden through codex -c; rename it`)
  return name
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

/** A TOML inline value; JSON string escapes are valid TOML basic-string escapes. */
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).map(([key, entry]) => `${tomlKey(key)}=${tomlValue(entry)}`).join(',')}}`
  }
  throw new Error(`cannot write ${typeof value} as a TOML value`)
}
