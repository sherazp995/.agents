import { describe, expect, it } from 'vitest'

import { canonicalise, chainEntry, GENESIS_HASH, hashEntry, verifyChain } from '../../src/audit/chain.js'
import type { AuditEntryInput, ChainedAuditEntry } from '../../src/audit/chain.js'

/**
 * FR-AUD-2's own reasoning is what these test: the chain catches an entry
 * altered in isolation, and it CANNOT catch an attacker who recomputes the
 * rest, which is why the requirement also calls for signed heads. The test
 * that proves the second half is the one asserting the chain stays "intact"
 * after a full recompute, since a test suite that quietly implied otherwise
 * would be worse than none.
 */

function entry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    runId: 'run-1',
    kind: 'capability_invoked',
    actor: 'relay',
    detail: { capability: 'shell', outcome: 'ok' },
    at: '2026-08-13T12:00:00.000Z',
    ...overrides,
  }
}

function build(count: number): ChainedAuditEntry[] {
  const out: ChainedAuditEntry[] = []
  for (let index = 0; index < count; index += 1) {
    out.push(chainEntry(entry({ detail: { step: index } }), out[out.length - 1]))
  }
  return out
}

describe('canonicalisation, without which the chain reports false tampering', () => {
  it('encodes the same object identically whatever the key order', () => {
    // Hash over JSON.stringify's insertion order survives neither a database
    // round trip nor a refactor of the object literal, and a chain that
    // reports tampering after an ordinary read is one nobody keeps believing.
    expect(canonicalise({ b: 1, a: 2 })).toBe(canonicalise({ a: 2, b: 1 }))
  })

  it('sorts at EVERY level, not just the top', () => {
    expect(canonicalise({ outer: { z: 1, a: 2 } })).toBe(canonicalise({ outer: { a: 2, z: 1 } }))
  })

  it('keeps array order, which is meaningful', () => {
    expect(canonicalise([1, 2])).not.toBe(canonicalise([2, 1]))
  })

  it('produces the same hash for an entry that has been through a JSON round trip', () => {
    const original = entry()
    const roundTripped = JSON.parse(JSON.stringify(original)) as AuditEntryInput

    expect(hashEntry(roundTripped, 1, GENESIS_HASH)).toBe(hashEntry(original, 1, GENESIS_HASH))
  })
})

describe('the chain detects the accidental cases', () => {
  it('verifies an untouched chain', () => {
    const result = verifyChain(build(5))

    expect(result.intact).toBe(true)
    if (!result.intact) return
    expect(result.entries).toBe(5)
  })

  it('starts from a fixed genesis, so a truncated log cannot pass as a fresh one', () => {
    expect(build(1)[0]?.previousHash).toBe(GENESIS_HASH)
  })

  it('detects an ALTERED entry, and names the first one that fails', () => {
    const chain = build(5)
    chain[2] = { ...(chain[2] as ChainedAuditEntry), detail: { step: 'tampered' } }

    const result = verifyChain(chain)

    expect(result.intact).toBe(false)
    if (result.intact) return
    expect(result.firstBadSequence).toBe(3)
    expect(result.reason).toContain('altered')
  })

  it('detects a DELETED entry as a sequence gap', () => {
    const chain = build(5)
    chain.splice(2, 1)

    const result = verifyChain(chain)

    expect(result.intact).toBe(false)
    if (result.intact) return
    expect(result.reason).toContain('deleted')
  })

  it('detects REORDERING', () => {
    const chain = build(5)
    const [a, b] = [chain[1] as ChainedAuditEntry, chain[2] as ChainedAuditEntry]
    chain[1] = b
    chain[2] = a

    expect(verifyChain(chain).intact).toBe(false)
  })

  it('names WHICH entry failed, since "broken somewhere" is not actionable', () => {
    const chain = build(500)
    chain[411] = { ...(chain[411] as ChainedAuditEntry), actor: 'someone-else' }

    const result = verifyChain(chain)

    expect(result.intact).toBe(false)
    if (result.intact) return
    expect(result.firstBadSequence).toBe(412)
  })
})

describe('what the chain alone CANNOT do, which is why FR-AUD-2 also signs heads', () => {
  it('reports a fully recomputed chain as intact, because it is', () => {
    // This is the requirement's own stated reason for signed chain heads:
    // "a bare hash chain does not survive an attacker with local write
    // access, who can alter an entry and recompute every subsequent hash".
    // Asserting the opposite here would be a comforting lie.
    const chain = build(5)
    const tampered = chain.map((original, index) =>
      index === 2 ? { ...original, detail: { step: 'tampered' } } : original,
    )

    // Recompute the whole chain from the altered entry onward, as an
    // attacker with write access to the database would.
    const rebuilt: ChainedAuditEntry[] = []
    for (const item of tampered) {
      rebuilt.push(chainEntry({ runId: item.runId, kind: item.kind, actor: item.actor, detail: item.detail, at: item.at }, rebuilt[rebuilt.length - 1]))
    }

    expect(verifyChain(rebuilt).intact).toBe(true)

    // And the head has MOVED, which is what a signature over the old head
    // detects and what makes the second mechanism worth having.
    const untampered = verifyChain(chain)
    const after = verifyChain(rebuilt)
    expect(untampered.intact && after.intact && untampered.head !== after.head).toBe(true)
  })
})
