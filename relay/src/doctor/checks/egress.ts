/**
 * FR-DATA-14: `relay doctor` verifies the running configuration matches the
 * generated egress inventory. This check is a thin reporting layer over
 * src/data/egress.ts, which owns the inventory itself, the source scan, and
 * the comparison; nothing here re-derives that logic, the job here is only
 * to run it and render its findings truthfully.
 *
 * SEVERITY, stated plainly because it is the whole point of the gate:
 *   - 'undeclared' evidence (a fetch host or a spawned binary with no owning
 *     inventory entry) and 'inconsistent' entries (a wiredInThisBuild flag
 *     that disagrees with what the scan actually found, in either
 *     direction) are FAILURES. Both mean the inventory does not currently
 *     describe the truth.
 *   - 'unresolved' spawn targets are DEGRADED, not failed: this scanner is a
 *     heuristic text scan (see src/data/egress.ts's own header comment), so
 *     an unresolved call site means "not statically confirmed", not "known
 *     to be a problem". A resolved, known-local finding is reported with
 *     its explanation and does not degrade the result at all.
 *   - 'confirmed' and 'declared_inactive' are the expected, healthy shape.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EGRESS_INVENTORY,
  compareEgressToSource,
  scanSourceForEgressEvidence,
} from '../../data/egress.js'
import type { EgressDestination, EgressFinding } from '../../data/egress.js'
import { registerBuiltinCapabilities } from '../../capabilities/wiring.js'
import { listCapabilities } from '../../capabilities/registry.js'
import type { CheckResult } from '../checks.js'
import { registerCheck } from '../registry.js'
import type { Check } from '../registry.js'

/** Every currently registered capability that declares CapabilityDefinition.destinationOf, the one structural signal available for the dynamic approved_action_target category. Calls registerBuiltinCapabilities() first, matching src/doctor/checks/capabilities.ts's own precedent, so this check is accurate whether or not anything else in this process already registered them. */
function capabilitiesWithDestination(): readonly string[] {
  registerBuiltinCapabilities()
  return listCapabilities()
    .filter((definition) => definition.destinationOf !== undefined)
    .map((definition) => definition.name)
}

/**
 * Removes every occurrence of the operator's home directory from a piece of
 * text before it can reach a CheckResult (FR-SEC-1), matching
 * src/doctor/checks/profiles.ts's own redactHome: a scanned file path can
 * legitimately start with the operator's home directory when `relay doctor`
 * is pointed at a source tree outside the repository, and this report is
 * exactly what an operator pastes into an issue or a chat.
 */
function redactHome(text: string, home: string): string {
  if (home.length === 0) return text
  return text.split(home).join('~')
}

function formatFinding(finding: EgressFinding): string {
  switch (finding.kind) {
    case 'confirmed':
      return `confirmed: ${finding.destination} (${finding.evidence})`
    case 'declared_inactive':
      return `declared, not active: ${finding.destination} (${finding.note})`
    case 'inconsistent':
      return `INCONSISTENT: ${finding.destination} - ${finding.detail}`
    case 'undeclared':
      return `UNDECLARED ${finding.via} target "${finding.target}" at ${finding.file}:${finding.line}`
    case 'unresolved':
      return finding.note !== undefined
        ? `unresolved spawn target "${finding.identifier}" at ${finding.file}:${finding.line} (${finding.note})`
        : `unresolved spawn target "${finding.identifier}" at ${finding.file}:${finding.line} (no known explanation; a human should confirm this is not a hidden destination)`
  }
}

const REMEDIATION =
  'Add the missing destination to EGRESS_INVENTORY in src/data/egress.ts with its category, reason, and hosts or ' +
  'vendorBinary, per FR-DATA-2 and FR-DATA-14, or fix the code path that reaches an undeclared destination.'

/**
 * `inventory` defaults to the real EGRESS_INVENTORY and is only ever
 * overridden by a test: comparing a narrower, test-only inventory against
 * a narrower, test-only `rootDir` isolates the one behaviour under test
 * (an undeclared destination, an unresolved spawn target) from the
 * unrelated "declared but not found in THIS fixture" noise that scanning
 * anything other than the real `src` tree against the real, full inventory
 * would otherwise produce for every other declared destination.
 */
export type RecordedEgressAudit = {
  readonly builtAt: string
  readonly verified: readonly string[]
  readonly assumed: readonly string[]
  readonly findings: readonly EgressFinding[]
}

/**
 * The audit `scripts/copy-assets.mjs` records at build time, beside the
 * compiled output. Absent in a source checkout that has never been built,
 * which is fine: there the live scan runs instead.
 */
export function readRecordedEgressAudit(
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): RecordedEgressAudit | undefined {
  // dist/src/doctor/checks -> dist/egress-audit.json
  const auditPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'egress-audit.json')
  try {
    return JSON.parse(readFile(auditPath)) as RecordedEgressAudit
  } catch {
    return undefined
  }
}

export function checkEgress(
  rootDir = 'src',
  home: string = homedir(),
  inventory: readonly EgressDestination[] = EGRESS_INVENTORY,
): Check {
  return {
    name: 'egress',
    async run(): Promise<CheckResult> {
      // An installed package has no `src/`. Scanning nothing there concluded
      // every declared destination was unwired and reported FAILED, so a
      // healthy installation looked broken. The audit is recorded at build
      // time instead, and reported as what it is.
      if (!existsSync(rootDir)) {
        const recorded = readRecordedEgressAudit()
        if (recorded === undefined) {
          return {
            name: 'egress',
            status: 'degraded',
            detail:
              `No source tree at ${rootDir} and no recorded build-time audit, so FR-DATA-14's inventory could not ` +
              'be checked either way. This is a build that did not complete its own audit step, not a healthy state.',
            remediation: 'Rebuild with `pnpm build`, which records the audit, or run this from a source checkout.',
          }
        }
        const lines = [
          `Recorded at build time (${recorded.builtAt}), not re-verified here: an installed package carries no source to scan.`,
          `Verified: ${recorded.verified.join(' ')}`,
          `Assumed: ${recorded.assumed.join(' ')}`,
          ...recorded.findings.map(formatFinding),
        ]
        const recordedFailure = recorded.findings.some(
          (finding) => finding.kind === 'undeclared' || finding.kind === 'inconsistent',
        )
        return {
          name: 'egress',
          status: recordedFailure ? 'failed' : 'ok',
          detail: redactHome(lines.join('\n'), home),
          ...(recordedFailure ? { remediation: REMEDIATION } : {}),
        }
      }

      const evidence = scanSourceForEgressEvidence(rootDir)
      const comparison = compareEgressToSource(inventory, evidence, capabilitiesWithDestination())

      const hasFailure = comparison.findings.some((finding) => finding.kind === 'undeclared' || finding.kind === 'inconsistent')
      const hasDegradation = comparison.findings.some((finding) => finding.kind === 'unresolved' && finding.note === undefined)

      const lines = [
        `Verified: ${comparison.verified.join(' ')}`,
        `Assumed: ${comparison.assumed.join(' ')}`,
        ...comparison.findings.map(formatFinding),
      ]
      const detail = redactHome(lines.join('\n'), home)

      if (hasFailure) {
        return { name: 'egress', status: 'failed', detail, remediation: REMEDIATION }
      }
      if (hasDegradation) {
        return {
          name: 'egress',
          status: 'degraded',
          detail,
          remediation: 'Confirm each unresolved spawn target above is not a hidden destination, then add a note to KNOWN_UNRESOLVED_SPAWN_NOTES in src/data/egress.ts if it is a known-safe case.',
        }
      }
      return { name: 'egress', status: 'ok', detail }
    },
  }
}

registerCheck(checkEgress())
