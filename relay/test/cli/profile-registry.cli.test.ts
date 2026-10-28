import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const BUILD_TIMEOUT_MS = 120000
const CLI_TIMEOUT_MS = 30000

/**
 * The unit tests in `profile-registry.test.ts` call the run* functions
 * directly. That leaves the part most likely to be wrong untested: the
 * commander wiring in `src/cli.ts`, where a repeatable `--origin` needs a
 * custom accumulator or it silently keeps only the LAST value. A profile
 * registered with one origin instead of three fails later, at task time,
 * looking like an enforcement bug rather than a parsing one.
 *
 * So this drives the compiled CLI as a real subprocess against a temporary
 * registry, which is the only way to see that wiring at all.
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

/** Reads a profile's allowlist back out of the written file, so assertions are about values rather than YAML formatting. */
function originsOf(path: string, name: string): string[] {
  const registry = parseYaml(readFileSync(path, 'utf8')) as { profiles?: Array<{ name?: string; allowed_origins?: string[] }> }
  return registry.profiles?.find((profile) => profile.name === name)?.allowed_origins ?? []
}

let workspace: string
let registryPath: string
let profileDir: string

beforeAll(async () => {
  try {
    await execFileAsync('pnpm', ['build'], { timeout: BUILD_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`pnpm build failed, so the compiled CLI could not be verified: ${(error as Error).message}`)
  }
  workspace = mkdtempSync(join(tmpdir(), 'relay-registry-cli-'))
  registryPath = join(workspace, 'profiles.yaml')
  profileDir = join(workspace, 'acme-profile')
  mkdirSync(profileDir, { recursive: true })
}, BUILD_TIMEOUT_MS + 10000)

afterAll(() => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
})

describe('the profile registry commands, through the compiled CLI', () => {
  it(
    'keeps EVERY --origin, not just the last one',
    async () => {
      // Without a custom accumulator commander overwrites, and the profile
      // would silently end up scoped to one host out of three.
      const result = await runCli([
        'profile-add',
        'acme',
        '--dir',
        profileDir,
        '--origin',
        'acme.example',
        '--origin',
        '*.acme.example',
        '--origin',
        'billing.acme.example',
        '--profiles',
        registryPath,
      ])

      expect(result.code).toBe(0)
      // Asserted by parsing rather than by substring: quote style is the
      // yaml library's business, and the claim here is about the VALUES
      // surviving, including the leading-asterisk pattern that must be
      // quoted or YAML reads it as an alias.
      expect(originsOf(registryPath, 'acme')).toEqual(['acme.example', '*.acme.example', 'billing.acme.example'])
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'pins the client profile to tier 2, so scoping is enforced rather than detected',
    async () => {
      expect(readFileSync(registryPath, 'utf8')).toContain('pinned_tier: 2')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'lists what is registered and what it may reach',
    async () => {
      const result = await runCli(['profile-registry', '--profiles', registryPath])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('acme')
      expect(result.stdout).toContain('billing.acme.example')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'widens an allowlist, which is the edit that recurs as real tasks are refused',
    async () => {
      const result = await runCli(['profile-origins', 'acme', '--allow', 'reports.acme.example', '--profiles', registryPath])

      expect(result.code).toBe(0)
      expect(readFileSync(registryPath, 'utf8')).toContain('reports.acme.example')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'exits NON-ZERO when an edit is refused, so a script does not read failure as success',
    async () => {
      const result = await runCli(['profile-add', 'acme', '--dir', profileDir, '--origin', 'other.example', '--profiles', registryPath])

      expect(result.code).toBe(1)
      expect(result.stdout).toContain('already registered')
      // And the refusal left the file alone.
      expect(readFileSync(registryPath, 'utf8')).not.toContain('other.example')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'refuses a profile with no origins at all, per FR-PRF-1',
    async () => {
      const result = await runCli(['profile-add', 'empty', '--dir', profileDir, '--profiles', registryPath])

      expect(result.code).toBe(1)
      expect(result.stdout).toContain('FR-PRF-1')
      expect(readFileSync(registryPath, 'utf8')).not.toContain('name: empty')
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'unregisters on request',
    async () => {
      const result = await runCli(['profile-remove', 'acme', '--profiles', registryPath])

      expect(result.code).toBe(0)
      expect(readFileSync(registryPath, 'utf8')).not.toContain('name: acme')
    },
    CLI_TIMEOUT_MS,
  )
})
