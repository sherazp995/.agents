import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildCodexMcpOverrides,
  buildWorkerMcpSet,
  parseMcpServers,
  renderClaudeMcpConfig,
  writeClaudeMcpConfig,
  type WorkerMcpParams,
} from '../../src/autonomous/mcp-config.js'

const dir = mkdtempSync(join(tmpdir(), 'relay-mcp-config-'))
const caCertPath = join(dir, 'ca.pem')
const GATEWAY = { command: '/usr/local/bin/node', args: ['/relay/dist/scripts/mcp-gateway.js'] }

// The shape of ~/.agents/mcp/servers.json, plus a third server.
const SERVERS = parseMcpServers(JSON.stringify({
  mcpServers: {
    playwright: { clients: ['codex'], type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
    'playwright-extension': { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--extension'], env: {}, env_vars: ['PLAYWRIGHT_MCP_EXTENSION_TOKEN'] },
    notes: { command: 'notes-mcp', args: ['--stdio'], env: { NOTES_MODE: 'ro' } },
  },
}))

// The codex home's config.toml: native entries for both playwright servers, one the set lacks, and a url server.
const CODEX_CONFIG = `
model = "gpt"
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]
[mcp_servers.playwright.env]
PLAYWRIGHT_MCP_CDP_ENDPOINT = "http://127.0.0.1:9222"
[mcp_servers.playwright.tools.browser_click]
approval_mode = "approve"
[mcp_servers.playwright-extension]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--extension"]
env_vars = ["PLAYWRIGHT_MCP_EXTENSION_TOKEN"]
[mcp_servers.hand-added]
command = "/opt/tool"
[mcp_servers.remote]
url = "https://example.com/mcp"
`

beforeAll(() => {
  execFileSync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=relay task CA',
    '-keyout', join(dir, 'ca.key'), '-out', caCertPath,
  ], { stdio: 'ignore' })
})

function params(overrides: Partial<WorkerMcpParams> = {}): WorkerMcpParams {
  return {
    servers: SERVERS,
    gateway: GATEWAY,
    extensionGranted: false,
    proxyUrl: 'http://127.0.0.1:41000',
    caCertPath,
    playwrightConfigPath: join(dir, 'playwright.json'),
    ...overrides,
  }
}

/** Applies `-c` overrides the way codex does: tables merge, other values replace. */
function applyOverrides(configToml: string, overrides: string[]): Record<string, Record<string, unknown>> {
  const merge = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...base }
    for (const [key, value] of Object.entries(patch)) {
      const existing = out[key]
      out[key] = typeof value === 'object' && !Array.isArray(value) && typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? merge(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value
    }
    return out
  }
  let config = parseToml(configToml) as Record<string, unknown>
  for (const override of overrides) config = merge(config, parseToml(override.replace('=', ' = ')) as Record<string, unknown>)
  return config.mcp_servers as Record<string, Record<string, unknown>>
}

describe('worker MCP set', () => {
  it('wraps every server with the gateway and leaves playwright-extension out without a grant', () => {
    const set = buildWorkerMcpSet(params())

    expect(set.allowedMcpServerNames).toEqual(['playwright', 'notes'])
    expect(set.servers.notes).toEqual({
      command: GATEWAY.command,
      args: [...GATEWAY.args, 'notes', '--', 'notes-mcp', '--stdio'],
      env: { NOTES_MODE: 'ro' },
      envVars: ['RELAY_HOOK_URL', 'RELAY_HOOK_TOKEN'],
    })
    const claude = JSON.parse(renderClaudeMcpConfig(set, {})) as { mcpServers: Record<string, { command: string }> }
    expect(Object.keys(claude.mcpServers)).toEqual(['playwright', 'notes'])
    expect(Object.values(claude.mcpServers).every((server) => server.command === GATEWAY.command)).toBe(true)
  })

  it('runs headless playwright behind the proxy trusting only the task CA', () => {
    const set = buildWorkerMcpSet(params())
    const playwright = set.servers.playwright

    expect(playwright?.args).toEqual([
      ...GATEWAY.args, 'playwright', '--', 'npx', '@playwright/mcp@latest',
      '--headless', '--isolated', '--proxy-server', 'http://127.0.0.1:41000', '--config', join(dir, 'playwright.json'),
    ])
    expect(playwright?.args).not.toContain('--ignore-https-errors')
    expect(playwright?.env).toMatchObject({ PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS: 'false', PLAYWRIGHT_MCP_PROXY_BYPASS: '', PLAYWRIGHT_MCP_CDP_ENDPOINT: '' })
    const spki = new X509Certificate(readFileSync(caCertPath)).publicKey.export({ type: 'spki', format: 'der' })
    expect(JSON.parse(set.playwrightConfig ?? '{}')).toEqual({
      browser: { launchOptions: { args: [`--ignore-certificate-errors-spki-list=${createHash('sha256').update(spki).digest('base64')}`] } },
    })
  })

  it('refuses a servers.json playwright entry that would skip the proxy or the CA check', () => {
    const servers = { ...SERVERS, playwright: { ...SERVERS.playwright!, args: ['@playwright/mcp@latest', '--ignore-https-errors'] } }

    expect(() => buildWorkerMcpSet(params({ servers }))).toThrow(/--ignore-https-errors/)
  })

  it('adds playwright-extension with a grant, its token forwarded from the worker env only', () => {
    const set = buildWorkerMcpSet(params({ extensionGranted: true }))

    expect(set.allowedMcpServerNames).toContain('playwright-extension')
    expect(set.servers['playwright-extension']?.envVars).toContain('PLAYWRIGHT_MCP_EXTENSION_TOKEN')
    expect(set.servers['playwright-extension']?.env).toEqual({})
  })

  it('never forwards a PLAYWRIGHT_MCP_ variable to headless playwright', () => {
    const servers = { ...SERVERS, playwright: { ...SERVERS.playwright!, env_vars: ['PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS', 'LANG'] } }
    const set = buildWorkerMcpSet(params({ servers }))

    expect(set.servers.playwright?.envVars).toEqual(['RELAY_HOOK_URL', 'RELAY_HOOK_TOKEN', 'LANG'])
    const claude = JSON.parse(renderClaudeMcpConfig(set, { PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS: 'true', LANG: 'C' })) as {
      mcpServers: Record<string, { env: Record<string, string> }>
    }
    expect(claude.mcpServers.playwright?.env).toMatchObject({ PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS: 'false', LANG: 'C' })
  })

  it('writes the bridge and extension tokens into the claude config, mode 0600', () => {
    const set = buildWorkerMcpSet(params({ extensionGranted: true }))
    const path = join(dir, 'claude-mcp.json')
    writeClaudeMcpConfig(path, set, { RELAY_HOOK_URL: 'http://127.0.0.1:1/hook', RELAY_HOOK_TOKEN: 'tok', PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'ext', OTHER: 'x' })
    const claude = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> }

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(claude.mcpServers.notes?.env).toEqual({ NOTES_MODE: 'ro', RELAY_HOOK_URL: 'http://127.0.0.1:1/hook', RELAY_HOOK_TOKEN: 'tok' })
    expect(claude.mcpServers['playwright-extension']?.env).toEqual({ RELAY_HOOK_URL: 'http://127.0.0.1:1/hook', RELAY_HOOK_TOKEN: 'tok', PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'ext' })
    expect(claude.mcpServers.playwright?.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('')
  })
})

describe('codex MCP overrides', () => {
  it('cover every native mcp_servers name, so none runs unwrapped', () => {
    const set = buildWorkerMcpSet(params())
    const overrides = buildCodexMcpOverrides(set, CODEX_CONFIG)
    const effective = applyOverrides(CODEX_CONFIG, overrides)

    expect(Object.keys(effective).sort()).toEqual(['hand-added', 'notes', 'playwright', 'playwright-extension', 'remote'])
    for (const [name, server] of Object.entries(effective)) {
      if (server.enabled === false) continue
      expect({ name, command: server.command }).toEqual({ name, command: GATEWAY.command })
      expect(server.url).toBeUndefined()
    }
    expect(effective.playwright).toMatchObject({ enabled: true, env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: '' } })
    expect(effective.notes).toMatchObject({ enabled: true, env_vars: ['RELAY_HOOK_URL', 'RELAY_HOOK_TOKEN'] })
    expect(effective['playwright-extension']).toMatchObject({ enabled: false, command: GATEWAY.command, args: [...GATEWAY.args, '--deny-all', 'playwright-extension'], env_vars: [] })
    expect(effective['hand-added']).toMatchObject({ enabled: false, args: [...GATEWAY.args, '--deny-all', 'hand-added'] })
    expect(effective.remote).toMatchObject({ enabled: false, url: 'https://example.com/mcp' })
  })

  it('wraps playwright-extension for codex with a grant', () => {
    const set = buildWorkerMcpSet(params({ extensionGranted: true }))
    const effective = applyOverrides(CODEX_CONFIG, buildCodexMcpOverrides(set, CODEX_CONFIG))

    expect(effective['playwright-extension']).toMatchObject({
      enabled: true,
      command: GATEWAY.command,
      env_vars: ['RELAY_HOOK_URL', 'RELAY_HOOK_TOKEN', 'PLAYWRIGHT_MCP_EXTENSION_TOKEN'],
    })
  })

  it('refuses a native server name codex cannot override', () => {
    const set = buildWorkerMcpSet(params())

    expect(() => buildCodexMcpOverrides(set, '[mcp_servers."hand added"]\ncommand = "/opt/tool"\n')).toThrow(/cannot be overridden/)
  })

  it('refuses a native entry for a set server with a key the merge would keep', () => {
    const set = buildWorkerMcpSet(params())

    expect(() => buildCodexMcpOverrides(set, '[mcp_servers.notes]\nurl = "https://x"\n')).toThrow(/url/)
    expect(() => buildCodexMcpOverrides(set, '[mcp_servers.notes]\ncommand = "n"\ncwd = "/tmp"\n')).toThrow(/cwd/)
  })

  it('only disables a native entry outside the set that has such a key', () => {
    const set = buildWorkerMcpSet(params())

    expect(buildCodexMcpOverrides(set, '[mcp_servers.other]\ncommand = "n"\ncwd = "/tmp"\n')).toContain('mcp_servers.other.enabled=false')
  })

  // The real codex parses the overrides and lists only gateway entries or disabled ones; skipped without codex.
  it.skipIf(!existsCodex())('real codex mcp list shows no enabled server outside the gateway', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-codex-home-'))
    writeFileSync(join(home, 'config.toml'), CODEX_CONFIG)
    const set = buildWorkerMcpSet(params())
    const args = ['mcp', 'list', '--json', ...buildCodexMcpOverrides(set, CODEX_CONFIG).flatMap((override) => ['-c', override])]
    const listed = JSON.parse(execFileSync('codex', args, { env: { ...process.env, CODEX_HOME: home }, cwd: home, timeout: 20_000 }).toString()) as Array<{
      name: string; enabled: boolean; transport: { command?: string }
    }>

    expect(listed.map((server) => server.name).sort()).toEqual(['hand-added', 'notes', 'playwright', 'playwright-extension', 'remote'])
    expect(listed.filter((server) => server.enabled).every((server) => server.transport.command === GATEWAY.command)).toBe(true)
  })
})

function existsCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
