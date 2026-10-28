/**
 * FR-AUD-2: tamper evidence for the audit log.
 *
 * The requirement is unusually specific about WHY a plain hash chain is not
 * enough, and the reason shapes everything here: "A bare hash chain does not
 * survive an attacker with local write access, who can alter an entry and
 * recompute every subsequent hash, so chain heads are periodically signed
 * with a key held in the Keychain."
 *
 * So there are two mechanisms doing two different jobs:
 *
 *   - THE CHAIN detects an entry altered in isolation. Cheap, computed on
 *     every write, and enough for the accident case: a partial restore, a
 *     botched migration, a row edited by hand.
 *   - THE SIGNED HEAD detects the recompute. An attacker who rewrites the
 *     chain still cannot produce a signature over the new head without the
 *     Keychain key, and the key is not in the database they just rewrote.
 *
 * WHAT THIS DOES NOT CLAIM. An attacker who can read the Keychain can sign
 * anything, and this makes no attempt to pretend otherwise. The threat it
 * genuinely covers is tampering with the DATABASE, which is a much easier
 * thing to reach than the Keychain, and it makes that tampering visible
 * rather than preventing it. Verification says which entry first fails and
 * whether a signed head still covers it, because "the log is broken
 * somewhere" is not something an operator can act on.
 *
 * CANONICALISATION IS THE SUBTLE PART. Two JSON encodings of the same entry
 * must hash identically or the chain reports tampering on a round trip
 * through the database, which would train an operator to ignore it. Keys are
 * sorted at every level and the encoding is fixed here rather than left to
 * `JSON.stringify`'s insertion order.
 */

import { createHash } from 'node:crypto'

/** The chain's first link. A fixed, recognisable value, so a truncated log cannot masquerade as a fresh one. */
export const GENESIS_HASH = '0'.repeat(64)

export type AuditEntryInput = {
  readonly runId: string | null
  readonly kind: string
  readonly actor: string
  /** Already redacted by the caller: FR-AUD-3 requires redaction on write, so nothing sensitive should reach here. */
  readonly detail: Record<string, unknown>
  readonly at: string
}

export type ChainedAuditEntry = AuditEntryInput & {
  readonly sequence: number
  readonly previousHash: string
  readonly hash: string
}

/**
 * A stable encoding of a value: object keys sorted at every level, arrays in
 * order, no incidental whitespace.
 *
 * Without this the hash depends on property insertion order, which survives
 * neither a database round trip nor a refactor of the object literal, and a
 * chain that reports tampering after an ordinary read is a chain nobody will
 * keep believing.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`)
  return `{${entries.join(',')}}`
}

/** The hash of one entry, over its own content AND its predecessor, which is what makes it a chain rather than a checksum. */
export function hashEntry(entry: AuditEntryInput, sequence: number, previousHash: string): string {
  const payload = canonicalise({
    sequence,
    previousHash,
    runId: entry.runId,
    kind: entry.kind,
    actor: entry.actor,
    at: entry.at,
    detail: entry.detail,
  })
  return createHash('sha256').update(payload).digest('hex')
}

/** Links a new entry onto a chain whose head is `previous`, or onto the genesis when there is none. */
export function chainEntry(entry: AuditEntryInput, previous: ChainedAuditEntry | undefined): ChainedAuditEntry {
  const sequence = previous === undefined ? 1 : previous.sequence + 1
  const previousHash = previous === undefined ? GENESIS_HASH : previous.hash
  return { ...entry, sequence, previousHash, hash: hashEntry(entry, sequence, previousHash) }
}

export type ChainVerification =
  | { readonly intact: true; readonly entries: number; readonly head: string }
  | {
      readonly intact: false
      /** The FIRST entry that does not verify. "Broken somewhere" is not actionable; "broken at sequence 412" is. */
      readonly firstBadSequence: number
      readonly reason: string
    }

/**
 * Walks the chain and reports the first break.
 *
 * Three distinct breaks are told apart, because they mean different things:
 * a gap in the sequence is a DELETION, a mismatched previousHash is a
 * REORDERING or an insertion, and a wrong hash is an ALTERED entry.
 */
export function verifyChain(entries: readonly ChainedAuditEntry[]): ChainVerification {
  let previous: ChainedAuditEntry | undefined

  for (const entry of entries) {
    const expectedSequence = previous === undefined ? 1 : previous.sequence + 1
    if (entry.sequence !== expectedSequence) {
      return {
        intact: false,
        firstBadSequence: entry.sequence,
        reason: `expected sequence ${expectedSequence} but found ${entry.sequence}: an entry has been deleted or the log has been reordered.`,
      }
    }

    const expectedPrevious = previous === undefined ? GENESIS_HASH : previous.hash
    if (entry.previousHash !== expectedPrevious) {
      return {
        intact: false,
        firstBadSequence: entry.sequence,
        reason: `entry ${entry.sequence} does not link to its predecessor: an entry has been inserted, removed, or reordered.`,
      }
    }

    const recomputed = hashEntry(entry, entry.sequence, entry.previousHash)
    if (recomputed !== entry.hash) {
      return {
        intact: false,
        firstBadSequence: entry.sequence,
        reason: `entry ${entry.sequence} does not match its own hash: its content has been altered since it was written.`,
      }
    }

    previous = entry
  }

  return { intact: true, entries: entries.length, head: previous?.hash ?? GENESIS_HASH }
}
