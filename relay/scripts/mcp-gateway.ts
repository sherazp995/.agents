#!/usr/bin/env node
/**
 * The MCP gateway entry (src/autonomous/mcp-gateway.ts). Relay writes it as
 * the command of every MCP server it gives a worker.
 *
 * Usage:
 *   mcp-gateway <server-name> -- <command> [args...]
 *   mcp-gateway --deny-all <server-name>
 *
 * The bridge address and token come from RELAY_HOOK_URL and RELAY_HOOK_TOKEN;
 * without them every tool call is denied.
 */

import { runDenyAllGateway, runMcpGateway } from '../src/autonomous/mcp-gateway.js'

const USAGE = 'usage: mcp-gateway <server-name> -- <command> [args...] | mcp-gateway --deny-all <server-name>'

async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--deny-all' && argv.length === 2 && argv[1] !== undefined) {
    return runDenyAllGateway({ server: argv[1], input: process.stdin, output: process.stdout })
  }
  const [server, separator, command, ...args] = argv
  if (server === undefined || server.startsWith('-') || separator !== '--' || command === undefined) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  const url = process.env.RELAY_HOOK_URL?.trim()
  const token = process.env.RELAY_HOOK_TOKEN?.trim()
  const bridge = url !== undefined && url.length > 0 && token !== undefined && token.length > 0 ? { url, token } : undefined
  return runMcpGateway({ server, command, args, bridge, input: process.stdin, output: process.stdout })
}

main(process.argv.slice(2)).then(
  (code) => process.stdout.write('', () => process.exit(code)),
  (error: unknown) => {
    process.stderr.write(`relay MCP gateway failed: ${(error as Error).message}\n`)
    process.exit(1)
  },
)
