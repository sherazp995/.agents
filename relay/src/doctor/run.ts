import type { Logger } from '../obs/logger.js'
import { createSecretProvider } from '../secrets/index.js'
import type { SecretProvider } from '../secrets/provider.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { RELAY_VERSION } from '../version.js'
import { checkConfigDetailed, checkNodeVersion } from './checks.js'
import type { CheckResult } from './checks.js'
// Imported for its registration side effect: importing this module is what
// adds the Slack checks to the registry defaultChecks() reads from. checks.js
// registers postgres and redis the same way, at its own bottom.
import './checks/slack.js'
// Same pattern: adds the 'capabilities' check, which itself calls
// registerBuiltinCapabilities() (src/capabilities/wiring.js). See that
// check's own doc comment for why this exists.
import './checks/capabilities.js'
// Same pattern again: adds the 'egress' check, FR-DATA-14.
import './checks/egress.js'
// Same pattern again: adds the 'sandbox' check, FR-SH-7. It runs the real
// self-test against the real sandbox (sandbox-exec on macOS, pasta and
// bubblewrap on Linux), so this is the line that makes
// `relay doctor` able to say confinement holds on THIS machine.
import './checks/sandbox.js'
// Same pattern again: adds the 'audit' check, FR-AUD-2.
import './checks/audit.js'
// Same pattern again: adds the 'supervisor' check. A daemon that exits on
// purpose needs something to restart it, and for two days nothing did.
import './checks/supervisor.js'
// Adds 'autonomous-setup' and 'autonomous-codex-hook': they report 'ok, off' unless autonomous mode is on.
import './checks/autonomous.js'
// Adds 'failover': "off" unless config.failover is set, else who answers and whether a build is too old.
import './checks/failover.js'
import { defaultChecks } from './registry.js'
import type { Check, CheckContext } from './registry.js'

const SYMBOL: Record<CheckResult['status'], string> = {
  ok: 'ok',
  degraded: 'degraded',
  failed: 'FAILED',
}
const STATUS_WIDTH = 10

export type FormatOptions = {
  /** Also print each result's long `more` detail. */
  verbose?: boolean
  /** How long the run took, shown in the closing summary line. */
  elapsedMs?: number
}

/**
 * Renders every result, including passes, so silence is never mistaken for
 * health. Runs the whole rendered string through scrubSecrets before
 * returning it: individual checks already redact at their own construction
 * site (see redactToken in src/doctor/checks/slack.ts), and that stays the
 * correct place to do it, since only the construction site knows which
 * substrings are safe to keep. This is the backstop for whatever a
 * construction site, this one or a future one, does not catch, so a check
 * author who forgets to redact still cannot leak a secret through this
 * function.
 */
export function formatResults(results: CheckResult[], options: FormatOptions = {}): string {
  if (results.length === 0) return 'relay doctor: no checks ran'
  const nameWidth = Math.max(...results.map((result) => result.name.length)) + 2
  const indent = ' '.repeat(2 + STATUS_WIDTH + nameWidth)
  const under = (text: string) => text.split('\n').join(`\n${indent}`)
  const lines = results.map((result) => {
    const row = [`  ${SYMBOL[result.status].padEnd(STATUS_WIDTH)}${result.name.padEnd(nameWidth)}${under(result.detail)}`]
    if (result.remediation) row.push(`${indent}fix: ${under(result.remediation)}`)
    if (options.verbose && result.more) row.push(`${indent}${under(result.more)}`)
    return row.join('\n')
  })
  const count = (status: CheckResult['status']) => results.filter((result) => result.status === status).length
  const took = options.elapsedMs === undefined ? '' : ` in ${(options.elapsedMs / 1000).toFixed(1)}s`
  const summary = `${count('ok')} ok, ${count('degraded')} degraded, ${count('failed')} failed${took}`
  return scrubSecrets([`relay doctor (relay ${RELAY_VERSION})`, '', ...lines, '', summary].join('\n'))
}

/**
 * Runs one check and converts any unexpected throw into a failed result. A
 * bug inside a single check must never crash the whole run and discard the
 * checks that already completed, so this is the one place an exception is
 * allowed to stop meaning "the report is incomplete" and start meaning
 * "this check failed." Every registered check goes through this, including
 * ones registered after this file was written.
 *
 * A throw reaching here has not necessarily passed through any check's own
 * redaction: readOptionalSecret in src/doctor/checks/slack.ts, for example,
 * reads a secret outside a try block, so a SecretProvider failure other
 * than "not found" reaches this catch directly, with no chance to run
 * through redactToken first. scrubSecrets covers exactly that case, since
 * every value a SecretProvider has ever returned is registered with it by
 * construction (see src/secrets/scrubber.js). This is a backstop, not a
 * replacement for redacting where a check already does: formatResults
 * scrubs again over the whole rendered report, so a leak here is caught
 * twice, not zero times if this call were ever removed.
 */
async function runCheckSafely(name: string, run: () => CheckResult | Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run()
  } catch (error) {
    return {
      name,
      status: 'failed',
      detail: scrubSecrets((error as Error).message),
      remediation: "This is an internal Relay fault. Report it along with this run's full output.",
    }
  }
}

/**
 * Runs every check. Node and config run first, outside the registry: node
 * needs nothing to check, and config is what produces the CheckContext
 * every registered check receives, so it cannot itself be one of them. That
 * single config load is reused directly to build the CheckContext, which is
 * what removes the second load runDoctor used to perform just to reach the
 * database and Redis URLs; there is no longer a separate step, pseudo-check,
 * or branch for that reload, because there is nothing left for it to do.
 *
 * When config is invalid, every registered check is still reported, by
 * name, as degraded rather than attempted, so a broken config never reads
 * as a passing Slack or database check and no check goes unmentioned.
 */
export async function runDoctor(
  options: { configPath: string; policyPath: string; log?: Logger; recheck?: boolean },
  checks: Check[] = defaultChecks()
): Promise<{ results: CheckResult[]; exitCode: number; elapsedMs: number }> {
  const startedAt = Date.now()
  const results: CheckResult[] = [await runCheckSafely('node', () => checkNodeVersion(process.version))]

  let configResult: CheckResult
  let ctx: CheckContext | undefined
  try {
    const detailed = checkConfigDetailed(options.configPath, options.policyPath)
    configResult = detailed.result
    if (detailed.result.status === 'ok' && detailed.config && detailed.policy) {
      ctx = {
        config: detailed.config,
        policy: detailed.policy,
        secrets: readOncePerRun(createSecretProvider(detailed.config)),
        ...(options.log ? { log: options.log } : {}),
        ...(options.recheck ? { recheck: true } : {}),
      }
    }
  } catch (error) {
    configResult = {
      name: 'config',
      status: 'failed',
      // Scrubbed for the same reason runCheckSafely's catch is: this builds
      // detail straight from a raw exception message, and checkConfigDetailed
      // reads config that can name a secret, so an unexpected throw here has
      // had no chance to pass through any construction-site redaction.
      // formatResults scrubs the rendered report again, so a leak on this
      // path is caught twice rather than not at all if that call were removed.
      detail: scrubSecrets((error as Error).message),
      remediation: "This is an internal Relay fault. Report it along with this run's full output.",
    }
  }
  results.push(configResult)

  if (ctx) {
    const readyCtx = ctx
    // Side by side: the checks read different services and none needs another's result. Promise.all keeps registry order.
    results.push(...(await Promise.all(checks.map((check) => runCheckSafely(check.name, () => check.run(readyCtx))))))
  } else {
    for (const check of checks) {
      results.push({ name: check.name, status: 'degraded', detail: 'not attempted, because configuration is invalid' })
    }
  }

  const exitCode = results.some((result) => result.status === 'failed') ? 1 : 0
  return { results, exitCode, elapsedMs: Date.now() - startedAt }
}

/**
 * Checks now run at once, and several read the same keystore item (the
 * database URL, the Slack tokens). One read per item per run keeps them from
 * calling the keychain side by side for the same secret.
 */
export function readOncePerRun(secrets: SecretProvider): SecretProvider {
  const values = new Map<string, Promise<string>>()
  const present = new Map<string, Promise<boolean>>()
  const once = <T>(cache: Map<string, Promise<T>>, name: string, read: () => Promise<T>): Promise<T> => {
    const cached = cache.get(name)
    if (cached) return cached
    const fresh = read()
    cache.set(name, fresh)
    return fresh
  }
  return {
    kind: secrets.kind,
    get: (name) => once(values, name, () => secrets.get(name)),
    has: (name) => once(present, name, () => secrets.has(name)),
  }
}
