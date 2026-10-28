import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheckResult } from '../../src/doctor/checks.js'
import { checkSlackTokenValid } from '../../src/doctor/checks/slack.js'
import { defaultChecks } from '../../src/doctor/registry.js'
import type { Check, CheckContext } from '../../src/doctor/registry.js'
// Importing run.js is what pulls in its side-effect `import './checks/slack.js'`
// and, through checks.js, the postgres and redis registrations. The default
// registry test below depends on this import having happened, exactly as the
// CLI does.
import { formatResults, runDoctor } from '../../src/doctor/run.js'
import type { SecretProvider } from '../../src/secrets/provider.js'
import { registerSecretValue, resetSecretScrubberForTests } from '../../src/secrets/scrubber.js'

const REAL_CONFIG_PATH = 'config/relay.config.yaml'
const REAL_POLICY_PATH = 'config/policy.yaml'

describe('formatResults', () => {
  it('lists every check, including the ones that passed', () => {
    const results: CheckResult[] = [
      { name: 'node', status: 'ok', detail: 'v22.18.0' },
      { name: 'postgres', status: 'failed', detail: 'connection refused', remediation: 'docker compose up -d' },
    ]
    const output = formatResults(results)
    expect(output).toContain('node')
    expect(output).toContain('postgres')
    expect(output).toContain('docker compose up -d')
  })

  it('never reports a check as passing when it was not run', () => {
    expect(formatResults([])).toContain('no checks ran')
  })
})

describe('runDoctor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function writeInvalidPolicy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'relay-doctor-run-'))
    const path = join(dir, 'policy.yaml')
    writeFileSync(path, 'version: 1\ndefaults:\n  unmatched: ask\nhard_blocked_origins: []\n', 'utf8')
    return path
  }

  it('reports a check that throws as failed with its message, and leaves the other checks in the report', async () => {
    const throwing: Check = {
      name: 'throwing-check',
      run: async () => {
        throw new Error('boom')
      },
    }
    const passing: Check = {
      name: 'passing-check',
      run: async () => ({ name: 'passing-check', status: 'ok', detail: 'fine' }),
    }

    const { results } = await runDoctor(
      { configPath: REAL_CONFIG_PATH, policyPath: REAL_POLICY_PATH },
      [throwing, passing]
    )

    const node = results.find((result) => result.name === 'node')
    const config = results.find((result) => result.name === 'config')
    const throwingResult = results.find((result) => result.name === 'throwing-check')
    const passingResult = results.find((result) => result.name === 'passing-check')

    expect(node?.status).toBe('ok')
    expect(config?.status).toBe('ok')
    expect(throwingResult?.status).toBe('failed')
    expect(throwingResult?.detail).toBe('boom')
    expect(throwingResult?.remediation).toMatch(/internal Relay fault/)
    expect(passingResult?.status).toBe('ok')
    expect(results.map((result) => result.name)).toEqual(['node', 'config', 'throwing-check', 'passing-check'])
  })

  it('returns exit code 1 when a registered check throws', async () => {
    const throwing: Check = {
      name: 'throwing-check',
      run: async () => {
        throw new Error('boom')
      },
    }
    const { exitCode } = await runDoctor({ configPath: REAL_CONFIG_PATH, policyPath: REAL_POLICY_PATH }, [throwing])
    expect(exitCode).toBe(1)
  })

  it('reports every registered check as degraded, not passing, when configuration is invalid, and none of them actually run', async () => {
    const invalidPolicyPath = writeInvalidPolicy()
    const runSpy = vi.fn(async () => ({ name: 'never-run-check', status: 'ok' as const, detail: 'should not appear' }))
    const neverRun: Check = { name: 'never-run-check', run: runSpy }

    const { results, exitCode } = await runDoctor(
      { configPath: REAL_CONFIG_PATH, policyPath: invalidPolicyPath },
      [neverRun]
    )

    const config = results.find((result) => result.name === 'config')
    const never = results.find((result) => result.name === 'never-run-check')

    expect(config?.status).toBe('failed')
    expect(never?.status).toBe('degraded')
    expect(never?.detail).toMatch(/not attempted/)
    expect(runSpy).not.toHaveBeenCalled()
    expect(exitCode).toBe(1)
  })

  it('reports config as failed, without crashing, when loading it throws unexpectedly rather than raising ConfigError', async () => {
    const loadModule = await import('../../src/config/load.js')
    vi.spyOn(loadModule, 'loadRelayConfig').mockImplementationOnce(() => {
      throw new Error('unexpected disk fault')
    })

    const { results } = await runDoctor({ configPath: REAL_CONFIG_PATH, policyPath: REAL_POLICY_PATH }, [])

    const node = results.find((result) => result.name === 'node')
    const config = results.find((result) => result.name === 'config')
    expect(node?.status).toBe('ok')
    expect(config?.status).toBe('failed')
    expect(config?.detail).toBe('unexpected disk fault')
    expect(config?.remediation).toMatch(/internal Relay fault/)
  })

  /**
   * Every other test here passes an explicit `checks` array, which means none
   * of them ever evaluates runDoctor's `defaultChecks()` default parameter.
   * The registration wiring is therefore untested through the path production
   * actually uses: run.ts's side-effect `import './checks/slack.js'`, and the
   * two registerCheck calls at the bottom of checks.ts. Deleting that import,
   * or those calls, would leave every other test in this file passing while
   * `relay doctor` silently stopped running the checks entirely.
   *
   * This asserts the default registry's contents by name. It deliberately
   * does not run the checks: postgres, redis, and Slack all reach the network,
   * and what needs pinning is that they are wired in at all, not what they
   * report.
   */
  it('wires postgres, redis, and the Slack checks into the default registry, without being handed a checks array', () => {
    const names = defaultChecks().map((check) => check.name)

    for (const expected of [
      'postgres',
      'redis',
      'slack-token',
      'slack-token-valid',
      'slack-scopes',
      'slack-socket-mode',
      'slack-identity',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('reaches every check with a valid configuration and exits 0 when they all pass', async () => {
    const okCheck: Check = { name: 'ok-check', run: async () => ({ name: 'ok-check', status: 'ok', detail: 'fine' }) }
    const { results, exitCode } = await runDoctor(
      { configPath: REAL_CONFIG_PATH, policyPath: REAL_POLICY_PATH },
      [okCheck]
    )
    expect(results.map((result) => result.name)).toEqual(['node', 'config', 'ok-check'])
    expect(exitCode).toBe(0)
  })
})

/**
 * FR-SEC-1, second-round finding: readOptionalSecret in
 * src/doctor/checks/slack.ts is called outside every check's try block, so
 * a SecretProvider.get failure other than SecretNotFoundError rethrows and
 * escapes run() before redactToken ever sees it. It is then caught by
 * runCheckSafely, which used to build `detail` straight from the raw error
 * message with no redaction at all. src/secrets/scrubber.ts closes that
 * path from the output side: every value a SecretProvider has ever
 * returned is registered automatically, and runCheckSafely plus
 * formatResults both scrub before the text can reach a caller. This block
 * proves the exact path the finding described, not just the scrubber in
 * isolation.
 */
describe('secret scrubbing at the output boundary (FR-SEC-1)', () => {
  const LEAK_SENTINEL = 'xoxb-SENTINEL-9931-LEAKCHECK'

  afterEach(() => {
    resetSecretScrubberForTests()
    // Restores here rather than at the end of the one test that installs a spy:
    // a failing expect() would skip an in-body restore and leak the spy into
    // whatever test ran next, turning one real failure into several confusing
    // ones. afterEach runs regardless of how the test exited.
    vi.restoreAllMocks()
  })

  /**
   * A SecretProvider whose get() always rejects with a plain Error, not
   * SecretNotFoundError, and whose message happens to echo a secret value.
   * This stands in for a misbehaving provider, or a Keychain failure that
   * folds subprocess output into its error: readOptionalSecret only
   * swallows SecretNotFoundError, so this rethrows and escapes
   * checkSlackTokenValid's run() without ever reaching redactToken.
   */
  function throwingSecrets(message: string): SecretProvider {
    return {
      kind: 'env',
      async get() {
        throw new Error(message)
      },
      async has() {
        return true
      },
    }
  }

  function fetchShouldNeverBeCalled(): typeof fetch {
    return vi.fn(async () => {
      throw new Error('checkSlackTokenValid must not reach fetch when secrets.get() throws before a token is read')
    }) as unknown as typeof fetch
  }

  it('LEAK CONFIRMED regression: scrubs a secret that escapes readOptionalSecret outside its try block, all the way through runDoctor and formatResults', async () => {
    registerSecretValue(LEAK_SENTINEL)
    const fetchMock = fetchShouldNeverBeCalled()
    const leakingCheck: Check = {
      name: 'slack-token-valid',
      run: (ctx: CheckContext) =>
        checkSlackTokenValid(fetchMock).run({
          ...ctx,
          secrets: throwingSecrets(`secret backend exploded while holding ${LEAK_SENTINEL}`),
        }),
    }

    const { results } = await runDoctor(
      { configPath: REAL_CONFIG_PATH, policyPath: REAL_POLICY_PATH },
      [leakingCheck]
    )

    const leaked = results.find((result) => result.name === 'slack-token-valid')
    expect(leaked?.status).toBe('failed')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(results)).not.toContain(LEAK_SENTINEL)
    expect(formatResults(results)).not.toContain(LEAK_SENTINEL)
  })

  it('formatResults scrubs a CheckResult whose detail already contains a registered secret value, even when nothing upstream redacted it', () => {
    registerSecretValue(LEAK_SENTINEL)
    const results: CheckResult[] = [
      { name: 'careless-check', status: 'failed', detail: `raw failure: ${LEAK_SENTINEL} was rejected` },
    ]

    const output = formatResults(results)

    expect(output).not.toContain(LEAK_SENTINEL)
    expect(output).toContain('[redacted secret]')
  })

  it('the scrubbed placeholder carries no length or prefix hint of the secret it replaced', () => {
    const short = 'shortsecret'
    const long = 'aVeryVeryLongSecretValueThatIsMuchLonger1234567890'
    registerSecretValue(short)
    registerSecretValue(long)
    const results: CheckResult[] = [
      { name: 'a', status: 'failed', detail: `first: ${short}` },
      { name: 'b', status: 'failed', detail: `second: ${long}` },
    ]

    const output = formatResults(results)

    const placeholders = output.match(/\[redacted secret\]/g) ?? []
    expect(placeholders).toHaveLength(2)
    expect(output).not.toMatch(/shortsecret/)
    expect(output).not.toMatch(/aVeryVeryLong/)
    // Every placeholder is byte-identical regardless of which secret it
    // replaced, or how long that secret was.
    expect(new Set(placeholders).size).toBe(1)
  })

  /**
   * The config step runs before the registry, outside runCheckSafely, so it
   * has its own catch that builds `detail` from a raw exception message.
   * checkConfigDetailed reads config that can name a secret, so a throw on
   * this path has had no chance to pass through any construction-site
   * redaction, exactly like the runCheckSafely path above. This pins that
   * the config catch scrubs too, rather than being the one boundary that
   * was left raw.
   */
  it('scrubs a secret in an exception thrown by the config step, which runs outside runCheckSafely', async () => {
    registerSecretValue(LEAK_SENTINEL)
    // Spies on loadRelayConfig rather than checkConfigDetailed: run.ts imports
    // checkConfigDetailed directly by binding, so replacing it on the module
    // object would not affect the reference run.ts already holds. loadRelayConfig
    // is called from inside checkConfigDetailed, which is the seam the existing
    // "unexpected disk fault" test above uses for the same reason.
    const loadModule = await import('../../src/config/load.js')
    vi.spyOn(loadModule, 'loadRelayConfig').mockImplementationOnce(() => {
      throw new Error(`config loader exploded while holding ${LEAK_SENTINEL}`)
    })

    const { results } = await runDoctor({ configPath: REAL_CONFIG_PATH, policyPath: REAL_POLICY_PATH }, [])

    const config = results.find((result) => result.name === 'config')
    expect(config?.status).toBe('failed')
    expect(config?.detail).not.toContain(LEAK_SENTINEL)
    expect(config?.detail).toContain('[redacted secret]')
    expect(formatResults(results)).not.toContain(LEAK_SENTINEL)
  })
})
