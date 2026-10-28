/**
 * Approval receipts (user decision 7). resolveApproval signs each decision
 * with a key only the daemon can read (through `relay-secrets`), and every
 * consumer that acts on an autonomous approval (plan approval, the
 * remote-write executor, the MCP gateway) verifies it first. An approval row
 * set to approved by a plain SQL update has no valid receipt, and a denial's
 * receipt never verifies as an approval, because the decision is signed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Approval, ApprovalKind, ApprovalOption, ApprovalStatus } from './store.js'

export type ReceiptFields = {
  approvalId: string
  kind: ApprovalKind
  target: string
  operationDigest: string
  option: ApprovalOption
  status: ApprovalStatus
  resolverPrincipalId: string
  resolvedAt: string
}

function canonical(fields: ReceiptFields): string {
  return JSON.stringify([
    fields.approvalId,
    fields.kind,
    fields.target,
    fields.operationDigest,
    fields.option,
    fields.status,
    fields.resolverPrincipalId,
    fields.resolvedAt,
  ])
}

export function signApprovalReceipt(key: Uint8Array, fields: ReceiptFields): string {
  return createHmac('sha256', key).update(canonical(fields)).digest('hex')
}

/**
 * True only for an affirmative decision whose receipt matches the row as it
 * stands: option `approve`, status approved, and an HMAC over exactly those
 * values. `operationDigest` is the digest the caller is about to act on.
 */
export function verifyApprovalReceipt(key: Uint8Array, approval: Approval, operationDigest: string): boolean {
  if (approval.receipt === null) return false
  if (approval.status !== 'approved' || approval.selectedOption !== 'approve') return false
  if (approval.resolvedByPrincipalId === null || approval.resolvedAt === null) return false
  const expected = signApprovalReceipt(key, {
    approvalId: approval.id,
    kind: approval.kind,
    target: approval.target,
    operationDigest,
    option: 'approve',
    status: 'approved',
    resolverPrincipalId: approval.resolvedByPrincipalId,
    resolvedAt: approval.resolvedAt,
  })
  const given = Buffer.from(approval.receipt, 'hex')
  const wanted = Buffer.from(expected, 'hex')
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}
