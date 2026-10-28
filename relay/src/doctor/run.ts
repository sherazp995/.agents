import type { Logger } from '../obs/logger.js'
import { createSecretProvider } from '../secrets/index.js'
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
// Same pattern again: adds the 'profiles' check, FR-PRF-6a.
import './checks/profiles.js'
// Same pattern again: adds the 'egress' check, FR-DATA-14.
import './checks/egress.js'
// Same pattern again: adds the 'sandbox' check, FR-SH-7. It runs the real
// self-test against the real sandbox-exec, so this is the line that makes
// `relay doctor` able to say confinement holds on THIS machine.
import './checks/sandbox.js'
// Same pattern again: adds the 'audit' check, FR-AUD-2.
import './checks/audit.js'
// Same pattern again: adds the 'supervisor' check. A daemon that exits on
// purpose needs something to restart it, and for two days nothing did.
import './checks/supervisor.js'
// Adds 'autonomous-setup' and 'autonomous-codex-hook': they report 'ok, off' unless autonomous mode is on.
import './checks/autonomous.js'
import { defaultChecks } from './registry.js'
import type { Check, CheckContext } from './registry.js'

const SYMBOL: Record<CheckResult['status'], string> = {
  ok: 'ok',
  degraded: 'degraded',
  failed: 'FAILED',
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
export function formatResults(results: CheckResult[]): string {
  if (results.length === 0) return 'relay doctor: no checks ran'
  const lines = results.map((result) => {
    const base = `[${SYMBOL[result.status]}] ${result.name}: ${result.detail}`
    return result.remediation ? `${base}\n         fix: ${result.remediation}` : base
  })
  return scrubSecrets([`relay doctor (relay ${RELAY_VERSION})`, ...lines].join('\n'))
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
  options: { configPath: string; policyPath: string; log?: Logger },
  checks: Check[] = defaultChecks()
): Promise<{ results: CheckResult[]; exitCode: number }> {
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
        secrets: createSecretProvider(detailed.config),
        ...(options.log ? { log: options.log } : {}),
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
    for (const check of checks) {
      results.push(await runCheckSafely(check.name, () => check.run(readyCtx)))
    }
  } else {
    for (const check of checks) {
      results.push({ name: check.name, status: 'degraded', detail: 'not attempted, because configuration is invalid' })
    }
  }

  const exitCode = results.some((result) => result.status === 'failed') ? 1 : 0
  return { results, exitCode }
}
