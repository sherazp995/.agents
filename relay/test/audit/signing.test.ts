import { describe, expect, it } from 'vitest'

import { chainEntry, verifyChain } from '../../src/audit/chain.js'
import { AUDIT_SIGNING_KEY_SECRET, describeIntegrity, signHead, verifyHead } from '../../src/audit/signing.js'
import { SecretNotFoundError } from '../../src/secrets/provider.js'
import type { SecretProvider } from '../../src/secrets/provider.js'

/**
 * The signed head is the half of FR-AUD-2 that survives an attacker with
 * write access to the database, so the test that matters most is the one
 * proving a recomputed chain fails its signature even though the chain
 * itself verifies.
 */

function secrets(value: string | undefined): SecretProvider {
  return {
    kind: 'keychain',
    async get(name: string) {
      if (value === undefined) throw new SecretNotFoundError(name)
      return value
    },
    async has() {
      return value !== undefined
    },
  }
}

describe('signing a chain head', () => {
  it('signs, and the signature verifies', async () => {
    const signed = await signHead(42, 'abc123', '2026-08-13T12:00:00.000Z', secrets('the-key'))

    expect(signed.outcome).toBe('signed')
    if (signed.outcome !== 'signed') return
    expect(await verifyHead(signed.head, secrets('the-key'))).toEqual({ valid: true })
  })

  it('REPORTS being unsigned rather than generating a key on the operator\'s behalf', async () => {
    // Silently creating and storing a key is the kind of convenience that
    // turns tamper evidence into decoration: nobody would know the guarantee
    // had been weakened.
    const result = await signHead(1, 'abc', '2026-08-13T12:00:00.000Z', secrets(undefined))

    expect(result.outcome).toBe('unsigned')
    if (result.outcome !== 'unsigned') return
    expect(result.reason).toContain(AUDIT_SIGNING_KEY_SECRET)
    expect(result.reason).toContain('recomputes the rest')
  })

  it('fails verification against a DIFFERENT key', async () => {
    const signed = await signHead(1, 'abc', '2026-08-13T12:00:00.000Z', secrets('key-one'))
    if (signed.outcome !== 'signed') return

    const result = await verifyHead(signed.head, secrets('key-two'))

    expect(result.valid).toBe(false)
  })

  it('fails verification when the HEAD is altered', async () => {
    const signed = await signHead(1, 'abc', '2026-08-13T12:00:00.000Z', secrets('the-key'))
    if (signed.outcome !== 'signed') return

    const tampered = { ...signed.head, hash: 'def456' }

    expect((await verifyHead(tampered, secrets('the-key'))).valid).toBe(false)
  })

  it('does not throw on a malformed signature', async () => {
    const result = await verifyHead(
      { sequence: 1, hash: 'abc', signedAt: '2026-08-13T12:00:00.000Z', signature: 'not-hex-at-all-zz' },
      secrets('the-key'),
    )

    expect(result.valid).toBe(false)
  })

  it('says plainly when the key is gone, since an uncheckable head is not a passing one', async () => {
    const result = await verifyHead(
      { sequence: 1, hash: 'abc', signedAt: '2026-08-13T12:00:00.000Z', signature: 'aa' },
      secrets(undefined),
    )

    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.reason).toContain('cannot be checked')
  })
})

describe('THE CASE THE SIGNATURE EXISTS FOR', () => {
  it('catches a fully recomputed chain, which the chain itself cannot', async () => {
    const at = '2026-08-13T12:00:00.000Z'
    const original = [
      chainEntry({ runId: 'r', kind: 'a', actor: 'relay', detail: { i: 1 }, at }, undefined),
    ]
    original.push(chainEntry({ runId: 'r', kind: 'b', actor: 'relay', detail: { i: 2 }, at }, original[0]))

    const head = await signHead(2, (original[1] as { hash: string }).hash, at, secrets('the-key'))
    if (head.outcome !== 'signed') return

    // The attacker alters an entry and recomputes everything after it.
    const rebuilt = [chainEntry({ runId: 'r', kind: 'a', actor: 'relay', detail: { i: 'tampered' }, at }, undefined)]
    rebuilt.push(chainEntry({ runId: 'r', kind: 'b', actor: 'relay', detail: { i: 2 }, at }, rebuilt[0]))

    // The chain is perfectly happy, exactly as FR-AUD-2 warns.
    expect(verifyChain(rebuilt).intact).toBe(true)

    // The signature over the OLD head is what gives it away.
    const rebuiltHead = { ...head.head, hash: (rebuilt[1] as { hash: string }).hash }
    const verification = await verifyHead(rebuiltHead, secrets('the-key'))

    expect(verification.valid).toBe(false)
    if (verification.valid) return
    expect(verification.reason).toContain('recomputed its hashes')
  })
})

describe('integrity is reported as two facts, not one boolean', () => {
  it('tells "intact but unsigned" apart from "signed but broken"', () => {
    // Only one of those is an incident, and collapsing them loses that.
    const unsigned = describeIntegrity({ intact: true, entries: 10 }, undefined)
    expect(unsigned.chainIntact).toBe(true)
    expect(unsigned.headSigned).toBe(false)
    expect(unsigned.headDetail).toContain('only against an entry altered in isolation')

    const broken = describeIntegrity({ intact: false, reason: 'entry 3 was altered' }, { valid: true })
    expect(broken.chainIntact).toBe(false)
    expect(broken.chainDetail).toContain('altered')
    expect(broken.headSigned).toBe(true)
  })
})
