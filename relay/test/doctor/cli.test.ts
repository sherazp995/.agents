// relay-test-needs: services (relay doctor checks this laptop's real database, Redis, Keychain and Slack)
import { execFile, spawn } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SKIP_CODEX_PROOF_ENV } from '../../src/doctor/checks/autonomous.js'
import { RELAY_VERSION } from '../../src/version.js'

const execFileAsync = promisify(execFile)

const BUILD_TIMEOUT_MS = 120000
// Doctor probes each codex login live (about 15 to 25 seconds, side by side), so this leaves room for a slow one.
const CLI_TIMEOUT_MS = 60000
/**
 * The build under test: inside the checkout (git-ignored tmp/) so node_modules resolves, and never dist, which the
 * launchd daemon runs. Building into dist put uncommitted code, once code needing a migration not yet run, live.
 */
const BUILD_DIR = join('tmp', `doctor-build-${process.pid}`)
/** The live dist's entry point, stamped before the build, to prove this file never rewrites it. */
const LIVE_CLI = join('dist', 'src', 'cli.js')
const liveStamp = (): number | null => {
  try {
    return statSync(LIVE_CLI).mtimeMs
  } catch {
    return null
  }
}
const liveBefore = liveStamp()

/**
 * Spawns the compiled CLI as a real subprocess and collects its exit code
 * and output. Nothing else in this repository executes dist output with
 * plain node, so a module-load failure in any dependency, such as an ESM
 * interop break, would otherwise be invisible until an operator hit it by
 * hand.
 */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(BUILD_DIR, 'src', 'cli.js'), ...args], { env: { ...process.env, [SKIP_CODEX_PROOF_ENV]: '1' } })
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
    await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--outDir', BUILD_DIR], { timeout: BUILD_TIMEOUT_MS })
    await execFileAsync('node', ['scripts/copy-assets.mjs', BUILD_DIR], { timeout: BUILD_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`the build failed, so the compiled CLI could not be verified: ${(error as Error).message}`)
  }
}, 2 * BUILD_TIMEOUT_MS + 10000)

afterAll(() => {
  rmSync(BUILD_DIR, { recursive: true, force: true })
})

describe('compiled CLI', () => {
  it('runs relay doctor against real dependencies, names every check, and exits 0', async () => {
    const { code, stdout } = await runCli(['doctor'])
    // The output is the message, so a failure names the check that failed.
    expect(code, stdout).toBe(0)
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

  it('builds into its own folder and leaves the dist the daemon runs untouched', () => {
    expect(statSync(join(BUILD_DIR, 'egress-audit.json')).isFile()).toBe(true)
    expect(statSync(join(BUILD_DIR, 'src', 'db', 'migrations')).isDirectory()).toBe(true)
    expect(liveStamp()).toBe(liveBefore)
  })

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
