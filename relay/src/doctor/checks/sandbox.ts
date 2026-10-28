/**
 * FR-SH-7: "`relay doctor` confirms the profile applies, and a startup
 * self-test attempts a known-forbidden write and a known-forbidden
 * connection, refusing to start if either succeeds."
 *
 * This is the doctor half. It runs the REAL self-test against the real
 * `sandbox-exec`, rather than reporting that a sandbox module exists,
 * because the entire value of the requirement is that confinement is
 * verified on this machine rather than assumed from configuration.
 *
 * A platform without `sandbox-exec` is reported as `failed`, not `ok`.
 * Elsewhere in this doctor an absent optional dependency is fine, but this
 * one is different: coding runs are refused outright without it (FR-SH-7
 * fails closed), so reporting it as a healthy state would tell the operator
 * that something works when it cannot run at all.
 */

import { runSandboxSelfTest } from '../../sandbox/selftest.js'
import type { CheckResult } from '../checks.js'
import { registerCheck } from '../registry.js'
import type { Check } from '../registry.js'

export const checkSandbox: Check = {
  name: 'sandbox',
  async run(): Promise<CheckResult> {
    const outcome = await runSandboxSelfTest()

    if (outcome.outcome === 'passed') {
      return { name: 'sandbox', status: 'ok', detail: outcome.detail }
    }

    if (outcome.outcome === 'unavailable') {
      return {
        name: 'sandbox',
        status: 'failed',
        detail: outcome.reason,
        remediation:
          'Coding runs fail closed without OS-level confinement (FR-SH-7), so they will be refused on this machine. ' +
          'Browser and chat capabilities are unaffected.',
      }
    }

    return {
      name: 'sandbox',
      status: 'failed',
      detail: outcome.reason,
      remediation:
        'Confinement did not hold when tested. Do NOT run coding tasks until this passes: the guarantee that a run ' +
        'cannot write outside its worktree or reach an undeclared host rests entirely on it.',
    }
  },
}

registerCheck(checkSandbox)
