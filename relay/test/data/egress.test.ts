import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  EGRESS_INVENTORY,
  compareEgressToSource,
  scanSourceForEgressEvidence,
} from '../../src/data/egress.js'
import type { EgressDestination, SourceEgressEvidence } from '../../src/data/egress.js'

function writeFixtureFile(dirPrefix: string, relativePath: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), dirPrefix))
  const path = join(dir, relativePath)
  writeFileSync(path, content, 'utf8')
  return dir
}

const EMPTY_EVIDENCE: SourceEgressEvidence = { scannedFiles: [], fetchHosts: [], spawnedBinaries: [], unresolvedSpawnTargets: [] }

describe('EGRESS_INVENTORY, FR-DATA-2 and FR-DATA-14', () => {
  it('enumerates Slack, the model provider, and the external code reviewer', () => {
    const names = EGRESS_INVENTORY.map((entry) => entry.name)
    expect(names.some((name) => name.includes('Slack'))).toBe(true)
    expect(names.some((name) => name.includes('Anthropic'))).toBe(true)
    expect(names.some((name) => name.includes('Codex'))).toBe(true)
  })

  it('declares the code reviewer as requiring operator acknowledgement, per FR-SET-10', () => {
    const codex = EGRESS_INVENTORY.find((entry) => entry.category === 'code_reviewer')
    expect(codex?.requiresOperatorAcknowledgement).toBe(true)
  })

  it('declares codex wired, Slack file intake, and the autonomous browser behind the egress proxy', () => {
    const codex = EGRESS_INVENTORY.find((entry) => entry.category === 'code_reviewer')
    expect(codex?.wiredInThisBuild).toBe(true)
    expect(codex?.knownGaps.join(' ')).not.toMatch(/not yet wired/i)
    expect(EGRESS_INVENTORY.find((entry) => entry.name === 'Slack')?.hosts).toContain('files.slack.com')
    const browser = EGRESS_INVENTORY.find((entry) => entry.category === 'autonomous_browser_read')
    expect(browser?.wiredBy).toBe('src/autonomous/egress-proxy.ts')
    expect(browser?.reason).toMatch(/only GET and HEAD/)
  })

  it('every entry names at least one reason, and every gap is stated rather than silent', () => {
    for (const entry of EGRESS_INVENTORY) {
      expect(entry.reason.length).toBeGreaterThan(0)
      // A dynamic entry (no fixed host, no vendor binary) MUST disclose that
      // it is dynamic in its own gaps, per this task's honesty requirement:
      // it must never look like a fixed destination this file quietly
      // forgot to fill in.
      if (entry.hosts.length === 0 && entry.vendorBinary === undefined) {
        expect(entry.knownGaps.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('scanSourceForEgressEvidence', () => {
  it('finds a literal fetch() URL and reports its host', () => {
    const dir = writeFixtureFile('relay-egress-scan-', 'x.ts', `const r = fetch('https://example.test/api', {})`)
    const evidence = scanSourceForEgressEvidence(dir)
    expect(evidence.fetchHosts).toEqual([{ host: 'example.test', file: expect.stringContaining('x.ts'), line: 1 }])
  })

  it('resolves a spawn() target from a same-file const', () => {
    const dir = writeFixtureFile(
      'relay-egress-scan-',
      'x.ts',
      `const BIN = 'somecli'\nfunction go() {\n  return spawn(BIN, [])\n}`,
    )
    const evidence = scanSourceForEgressEvidence(dir)
    expect(evidence.spawnedBinaries).toEqual([{ binary: 'somecli', file: expect.stringContaining('x.ts'), line: 3 }])
    expect(evidence.unresolvedSpawnTargets).toEqual([])
  })

  it('reports, rather than silently drops, a spawn target it cannot resolve to a literal', () => {
    const dir = writeFixtureFile('relay-egress-scan-', 'x.ts', `function go(bin) {\n  return execFile(bin, [])\n}`)
    const evidence = scanSourceForEgressEvidence(dir)
    expect(evidence.spawnedBinaries).toEqual([])
    expect(evidence.unresolvedSpawnTargets).toEqual([{ identifier: 'bin', file: expect.stringContaining('x.ts'), line: 2 }])
  })
})

describe('compareEgressToSource', () => {
  const declared: EgressDestination = {
    name: 'Example service',
    category: 'chat_platform',
    reason: 'a test fixture destination',
    hosts: ['example.test'],
    requiresOperatorAcknowledgement: false,
    wiredInThisBuild: true,
    knownGaps: [],
  }

  it('confirms a declared destination when matching evidence is found', () => {
    const evidence: SourceEgressEvidence = {
      scannedFiles: [],
      fetchHosts: [{ host: 'example.test', file: 'x.ts', line: 1 }],
      spawnedBinaries: [],
      unresolvedSpawnTargets: [],
    }
    const comparison = compareEgressToSource([declared], evidence, [])
    expect(comparison.findings).toContainEqual({
      kind: 'confirmed',
      destination: 'Example service',
      evidence: 'fetch to example.test at x.ts:1',
    })
  })

  it('reports an undeclared destination rather than ignoring it', () => {
    const evidence: SourceEgressEvidence = {
      scannedFiles: [],
      fetchHosts: [{ host: 'undeclared.example', file: 'x.ts', line: 5 }],
      spawnedBinaries: [],
      unresolvedSpawnTargets: [],
    }
    const comparison = compareEgressToSource([declared], evidence, [])
    expect(comparison.findings).toContainEqual({ kind: 'undeclared', via: 'fetch', target: 'undeclared.example', file: 'x.ts', line: 5 })
  })

  it('reports an undeclared spawned binary rather than ignoring it', () => {
    const evidence: SourceEgressEvidence = {
      scannedFiles: [],
      fetchHosts: [],
      spawnedBinaries: [{ binary: 'mystery-cli', file: 'x.ts', line: 9 }],
      unresolvedSpawnTargets: [],
    }
    const comparison = compareEgressToSource([declared], evidence, [])
    expect(comparison.findings).toContainEqual({ kind: 'undeclared', via: 'spawn', target: 'mystery-cli', file: 'x.ts', line: 9 })
  })

  it('flags a destination claimed wiredInThisBuild: true with no supporting evidence as inconsistent', () => {
    const comparison = compareEgressToSource([declared], EMPTY_EVIDENCE, [])
    expect(comparison.findings).toContainEqual({
      kind: 'inconsistent',
      destination: 'Example service',
      detail: 'wiredInThisBuild is true, but no matching fetch host or spawned binary was found under the scanned source',
    })
  })

  it('reports a declared-but-inactive destination as expected, not a problem, when its own flag says so', () => {
    const inactive: EgressDestination = { ...declared, wiredInThisBuild: false }
    const comparison = compareEgressToSource([inactive], EMPTY_EVIDENCE, [])
    expect(comparison.findings).toContainEqual({
      kind: 'declared_inactive',
      destination: 'Example service',
      note: 'no matching fetch host or spawned binary found under the scanned source, consistent with wiredInThisBuild: false',
    })
    expect(comparison.findings.some((finding) => finding.kind === 'inconsistent')).toBe(false)
  })

  it('does not treat a known local-only spawn binary (the macOS Keychain CLI) as an undeclared destination', () => {
    const evidence: SourceEgressEvidence = {
      scannedFiles: [],
      fetchHosts: [],
      spawnedBinaries: [{ binary: '/usr/bin/security', file: 'x.ts', line: 1 }],
      unresolvedSpawnTargets: [],
    }
    const comparison = compareEgressToSource([], evidence, [])
    expect(comparison.findings).toEqual([])
  })

  it('confirms the approved_action_target category structurally, from capabilities that declare destinationOf', () => {
    const dynamic: EgressDestination = {
      name: 'Approved action target',
      category: 'approved_action_target',
      reason: 'a test fixture',
      hosts: [],
      requiresOperatorAcknowledgement: false,
      wiredInThisBuild: true,
      knownGaps: ['dynamic'],
    }
    const comparison = compareEgressToSource([dynamic], EMPTY_EVIDENCE, ['browser'])
    expect(comparison.findings).toContainEqual({
      kind: 'confirmed',
      destination: 'Approved action target',
      evidence: 'capabilities declaring destinationOf: browser',
    })
  })

  it('flags approved_action_target as inconsistent when no capability declares destinationOf but it is claimed wired', () => {
    const dynamic: EgressDestination = {
      name: 'Approved action target',
      category: 'approved_action_target',
      reason: 'a test fixture',
      hosts: [],
      requiresOperatorAcknowledgement: false,
      wiredInThisBuild: true,
      knownGaps: ['dynamic'],
    }
    const comparison = compareEgressToSource([dynamic], EMPTY_EVIDENCE, [])
    expect(comparison.findings).toContainEqual({
      kind: 'inconsistent',
      destination: 'Approved action target',
      detail: 'wiredInThisBuild is true, but no registered capability currently declares destinationOf',
    })
  })

  it('states plainly what it verified versus what it assumed', () => {
    const comparison = compareEgressToSource(EGRESS_INVENTORY, EMPTY_EVIDENCE, [])
    expect(comparison.verified.length).toBeGreaterThan(0)
    expect(comparison.assumed.length).toBeGreaterThan(0)
    // Not generic filler: each list names something concrete this file
    // actually does or cannot do.
    expect(comparison.verified.join(' ')).toMatch(/fetch/i)
    expect(comparison.assumed.join(' ')).toMatch(/vendor/i)
  })
})

describe('launcher spawns and wiredBy evidence', () => {
  const codex: EgressDestination = {
    name: 'Codex',
    category: 'code_reviewer',
    reason: 'a test fixture',
    hosts: ['api.openai.com'],
    vendorBinary: 'codex',
    requiresOperatorAcknowledgement: true,
    wiredInThisBuild: true,
    knownGaps: [],
  }

  it('counts the start gate\'s /bin/sh spawn as the vendor CLIs it execs, not as an undeclared sh', () => {
    const evidence: SourceEgressEvidence = {
      ...EMPTY_EVIDENCE,
      spawnedBinaries: [{ binary: '/bin/sh', file: 'src/process/gated-spawn.ts', line: 90 }],
    }
    const comparison = compareEgressToSource([codex], evidence, [])
    expect(comparison.findings).toContainEqual({ kind: 'confirmed', destination: 'Codex', evidence: 'spawned codex at src/process/gated-spawn.ts:90' })
    expect(comparison.findings.filter((f) => f.kind === 'undeclared' || f.kind === 'inconsistent')).toEqual([
      { kind: 'undeclared', via: 'spawn', target: 'claude', file: 'src/process/gated-spawn.ts', line: 90 },
    ])
  })

  it('still reports /bin/sh as undeclared anywhere else', () => {
    const evidence: SourceEgressEvidence = { ...EMPTY_EVIDENCE, spawnedBinaries: [{ binary: '/bin/sh', file: 'src/other.ts', line: 3 }] }
    expect(compareEgressToSource([], evidence, []).findings).toEqual([
      { kind: 'undeclared', via: 'spawn', target: '/bin/sh', file: 'src/other.ts', line: 3 },
    ])
  })

  it('confirms a dynamic destination by its wiredBy file, and flags it when the file is gone', () => {
    const browser: EgressDestination = {
      name: 'Browser',
      category: 'autonomous_browser_read',
      reason: 'a test fixture',
      hosts: [],
      requiresOperatorAcknowledgement: false,
      wiredInThisBuild: true,
      wiredBy: 'src/autonomous/egress-proxy.ts',
      knownGaps: ['any host'],
    }
    const present = compareEgressToSource([browser], { ...EMPTY_EVIDENCE, scannedFiles: ['src/autonomous/egress-proxy.ts'] }, [])
    expect(present.findings).toEqual([
      { kind: 'confirmed', destination: 'Browser', evidence: 'src/autonomous/egress-proxy.ts is present under the scanned source' },
    ])
    expect(compareEgressToSource([browser], EMPTY_EVIDENCE, []).findings).toEqual([
      { kind: 'inconsistent', destination: 'Browser', detail: 'wiredInThisBuild is true, but src/autonomous/egress-proxy.ts is not under the scanned source' },
    ])
  })
})

describe('a real scan of this repository\'s own src/, as an integration proof', () => {
  it('finds Slack and the claude CLI, confirmed against the declared inventory', () => {
    const evidence = scanSourceForEgressEvidence('src')
    const comparison = compareEgressToSource(EGRESS_INVENTORY, evidence, ['browser'])

    const confirmedNames = comparison.findings.filter((f) => f.kind === 'confirmed').map((f) => (f as { destination: string }).destination)
    expect(confirmedNames).toContain('Slack')
    expect(confirmedNames.some((name) => name.includes('Anthropic'))).toBe(true)

    // No evidence in Relay's own source today should point at a
    // destination this inventory does not already declare.
    expect(comparison.findings.filter((f) => f.kind === 'undeclared')).toEqual([])
    expect(comparison.findings.filter((f) => f.kind === 'inconsistent')).toEqual([])
    expect(comparison.findings.filter((f) => f.kind === 'unresolved' && f.note === undefined)).toEqual([])
    expect(confirmedNames.some((name) => name.includes('Codex'))).toBe(true)
  })
})
