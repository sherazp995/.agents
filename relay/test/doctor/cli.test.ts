import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { RELAY_VERSION } from '../../src/version.js'

const execFileAsync = promisify(execFile)

const BUILD_TIMEOUT_MS = 120000
const CLI_TIMEOUT_MS = 30000

/**
 * Spawns the compiled CLI as a real subprocess and collects its exit code
 * and output. Nothing else in this repository executes dist output with
 * plain node, so a module-load failure in any dependency, such as an ESM
 * interop break, would otherwise be invisible until an operator hit it by
 * hand.
 */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/src/cli.js', ...args])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * Builds fresh before the guard runs, so this always exercises current
 * source rather than a stale dist directory that happens to still work.
 */
beforeAll(async () => {
  try {
    await execFileAsync('pnpm', ['build'], { timeout: BUILD_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`pnpm build failed, so the compiled CLI could not be verified: ${(error as Error).message}`)
  }
}, BUILD_TIMEOUT_MS + 10000)

describe('compiled CLI', () => {
  it('runs relay doctor against real dependencies, names every check, and exits 0', async () => {
    const { code, stdout } = await runCli(['doctor'])
    expect(code).toBe(0)
    expect(stdout).toContain('node')
    expect(stdout).toContain('config')
    expect(stdout).toContain('postgres')
    expect(stdout).toContain('redis')
    // Fix round 1 addendum, item 1: the capability registry's wiring
    // (registerBuiltinCapabilities(), src/capabilities/wiring.ts) is
    // reached through this check (src/doctor/checks/capabilities.ts) as
    // COMPILED JS run by a real `node` subprocess, not through Vitest's
    // on-the-fly transform. Asserting `echo` by name, not just the
    // `capabilities` check's own presence, is the actual proof: a
    // `capabilities` line with an empty list would still contain the word
    // "capabilities" while proving nothing was actually wired.
    expect(stdout).toContain('capabilities')
    expect(stdout).toContain('echo')
  }, CLI_TIMEOUT_MS)

  it('prints the version and exits 0, independent of database and redis', async () => {
    const { code, stdout } = await runCli(['--version'])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe(RELAY_VERSION)
  }, CLI_TIMEOUT_MS)

  /**
   * `relay principals add`, added in a fix round on Task 8 so an operator
   * refused by the fail closed path has a real command to run, not just a
   * module that compiles. `--help` needs no database at all, so this is
   * the cheap half of "does the compiled command actually run": the
   * functional round trip (provision, then resolvePrincipal resolves it)
   * is proven against real Postgres in test/cli/principals.test.ts, which
   * calls runPrincipalsAdd directly rather than spawning a second `pnpm
   * build`; that would race this file's own build step.
   */
  it('principals add --help describes every flag without touching the database', async () => {
    const { code, stdout } = await runCli(['principals', 'add', '--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('--platform')
    expect(stdout).toContain('--user')
    expect(stdout).toContain('--display-name')
    expect(stdout).toContain('--role')
    expect(stdout).toContain('--workspace-id')
  }, CLI_TIMEOUT_MS)
})
