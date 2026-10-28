import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The CLI's own database consumers (`relay live *` and `relay kill *`
 * through one pool helper, `relay live drain`, `relay principals add`)
 * resolve database.url through resolveDatabaseUrl. Run as a real process,
 * a reference to an item no keychain holds fails each one naming it. The
 * lookup is `security find-generic-password` for a random name that does
 * not exist, the same read test/secrets/keychain.test.ts makes; nothing is
 * written. The resolver's success path is covered in
 * test/config/database-url.test.ts and test/cli/smoke.test.ts.
 */
const CLI_TIMEOUT_MS = 30_000

function runCli(args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile('npx', ['tsx', 'src/cli.ts', ...args], { timeout: CLI_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code ?? 1), output: `${stdout}${stderr}` })
    })
  })
}

describe('CLI database consumers with a missing keystore reference', () => {
  const item = `relay-test-missing-${randomUUID()}`
  const configPath = join(mkdtempSync(join(tmpdir(), 'relay-cli-db-')), 'relay.config.yaml')
  writeFileSync(
    configPath,
    'model_provider:\n  name: anthropic\n  zero_data_retention: true\n' +
      `database:\n  url: keystore:${item}\nredis:\n  url: redis://localhost:6379/8\nlogging:\n  level: error\nsecrets:\n  provider: keychain\n`,
  )

  it.each([
    ['kill engage', ['kill', 'engage', 'test', '--config', configPath]],
    ['live drain', ['live', 'drain', '--config', configPath]],
    ['principals add', ['principals', 'add', '--platform', 'slack', '--user', 'U1', '--display-name', 'x', '--config', configPath]],
  ])('%s fails naming the reference', async (_name, args) => {
    const result = await runCli(args)
    expect(result.code).not.toBe(0)
    expect(result.output).toContain(item)
  }, CLI_TIMEOUT_MS)

  it('install-service reports an unloadable config as a refusal, not a stack trace', async () => {
    const missing = join(tmpdir(), `relay-missing-${randomUUID()}.yaml`)
    const result = await runCli(['install-service', '--config', missing])
    expect(result.code).toBe(1)
    expect(result.output).toContain('Not installed: the relay config could not be loaded')
    expect(result.output).not.toContain('    at ')
  }, CLI_TIMEOUT_MS)
})
