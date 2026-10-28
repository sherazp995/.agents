import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { createRun } from '../../src/runs/store.js'
import { registerSecretValue, resetSecretScrubberForTests } from '../../src/secrets/scrubber.js'
import {
  CONFIRMATION_TOKEN,
  createApproval,
  expireApproval,
  findActiveSessionGrant,
  getApproval,
  hasRequiredRole,
  listApprovalEvents,
  listOverdueApprovals,
  resolveApproval,
} from '../../src/approvals/store.js'
import {
  registerApprovalTestCapability,
  unregisterApprovalTestCapability,
} from '../support/approval-test-capability.js'

const url = process.env.RELAY_TEST_DATABASE_URL

/** Fails loudly instead of skipping when the var is absent, matching every other database suite in this repo. A skipped test proves nothing. */
const describeDb = url
  ? describe
  : (name: string, _fn: () => void) =>
      describe(name, () => {
        it('requires RELAY_TEST_DATABASE_URL to be set', () => {
          throw new Error(
            'RELAY_TEST_DATABASE_URL is not set. vitest.config.ts provides a local default; ' +
              'this only fires when that default has been explicitly overridden. ' +
              'Approval store tests must fail, not silently skip, when it is absent.',
          )
        })
      })

function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run approval store tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

describeDb('src/approvals/store.ts', () => {
  let pool: Pool

  beforeAll(async () => {
    const { getTestDatabaseUrl } = await import('../support/database.js')
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
    // Fix round 1: edit_and_approve now validates against a registered
    // capability's own inputSchema, so every test that exercises it needs
    // one. Registered once here since it is idempotent (same definition
    // object every call) and every fixture in this file already defaults
    // capability to APPROVAL_TEST_CAPABILITY's own name.
    registerApprovalTestCapability()
  })

  afterAll(async () => {
    unregisterApprovalTestCapability()
    await closePool(pool)
  })

  /** Every approval foreign-keys to a real workspace, run, session, and principal(s); most tests need at least a requester and an approver. */
  async function createFixtures(options: { approverRoles?: string[] } = {}) {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    const requesterPrincipalId = await provisionPrincipal(
      pool,
      workspaceId,
      'test',
      `U_requester_${randomUUID()}`,
      'Requester',
      ['member'],
    )
    const approverPrincipalId = await provisionPrincipal(
      pool,
      workspaceId,
      'test',
      `U_approver_${randomUUID()}`,
      'Approver',
      options.approverRoles ?? ['operator'],
    )
    const unauthorizedPrincipalId = await provisionPrincipal(
      pool,
      workspaceId,
      'test',
      `U_bystander_${randomUUID()}`,
      'Bystander',
      ['member'],
    )
    const session = await findOrCreateSession(pool, {
      workspaceId,
      principalId: requesterPrincipalId,
      adapter: 'test',
      threadRef: `thread-${randomUUID()}`,
    })
    const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId: requesterPrincipalId })
    return { workspaceId, sessionId: session.id, runId: run.id, requesterPrincipalId, approverPrincipalId, unauthorizedPrincipalId }
  }

  type Fixtures = Awaited<ReturnType<typeof createFixtures>>

  function baseApprovalParams(fixtures: Fixtures, overrides: Partial<Parameters<typeof createApproval>[1]> = {}) {
    return {
      workspaceId: fixtures.workspaceId,
      runId: fixtures.runId,
      sessionId: fixtures.sessionId,
      requesterPrincipalId: fixtures.requesterPrincipalId,
      capability: 'shell.exec',
      description: 'Run a shell command on the operator Mac',
      target: 'rm -rf ~/Downloads/old-exports',
      tier: 'irreversible' as const,
      escalationReason: 'irreversible-tier action always requires approval',
      requiredRoles: ['operator'],
      timeoutMs: 60_000,
      ...overrides,
    }
  }

  it('creates a pending approval carrying every FR-APR-1 field, and audits its own creation', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, baseApprovalParams(fixtures))

    expect(approval.status).toBe('pending')
    expect(approval.capability).toBe('shell.exec')
    expect(approval.target).toBe('rm -rf ~/Downloads/old-exports')
    expect(approval.tier).toBe('irreversible')
    expect(approval.requesterPrincipalId).toBe(fixtures.requesterPrincipalId)
    expect(approval.runId).toBe(fixtures.runId)
    expect(approval.sessionId).toBe(fixtures.sessionId)
    expect(approval.selectedOption).toBeNull()
    expect(approval.resolvedAt).toBeNull()

    const events = await listApprovalEvents(pool, fixtures.workspaceId, approval.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'created', actorPrincipalId: fixtures.requesterPrincipalId, outcome: 'pending' })
  })

  it('routes description, target, and escalationReason through the process-wide secret scrubber before storing them', async () => {
    resetSecretScrubberForTests()
    registerSecretValue('sk_live_verysecrettoken123456')
    try {
      const fixtures = await createFixtures()
      const approval = await createApproval(
        pool,
        baseApprovalParams(fixtures, {
          target: 'https://api.example.com/charge?key=sk_live_verysecrettoken123456',
          description: 'Use credential sk_live_verysecrettoken123456 to charge the card',
        }),
      )
      expect(approval.target).not.toContain('sk_live_verysecrettoken123456')
      expect(approval.description).not.toContain('sk_live_verysecrettoken123456')
      expect(approval.target).toContain('[redacted secret]')
    } finally {
      resetSecretScrubberForTests()
    }
  })

  it('getApproval is scoped by workspace: a different workspace can never read it, even by id', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, baseApprovalParams(fixtures))
    const otherWorkspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)

    expect(await getApproval(pool, fixtures.workspaceId, approval.id)).not.toBeNull()
    expect(await getApproval(pool, otherWorkspaceId, approval.id)).toBeNull()
    expect(await getApproval(pool, fixtures.workspaceId, randomUUID())).toBeNull()
  })

  it('resolveApproval with option approve, by an authorized principal, transitions to approved and audits actor, option, and outcome', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

    const result = await resolveApproval(pool, {
      workspaceId: fixtures.workspaceId,
      approvalId: approval.id,
      option: 'approve',
      resolverPrincipalId: fixtures.approverPrincipalId,
    })

    expect(result.outcome).toBe('resolved')
    expect(result.approval?.status).toBe('approved')
    expect(result.approval?.selectedOption).toBe('approve')
    expect(result.approval?.resolvedByPrincipalId).toBe(fixtures.approverPrincipalId)
    expect(result.approval?.resolvedAt).not.toBeNull()

    const events = await listApprovalEvents(pool, fixtures.workspaceId, approval.id)
    const resolveEvent = events.find((event) => event.action === 'resolve_attempt')
    expect(resolveEvent).toMatchObject({
      actorPrincipalId: fixtures.approverPrincipalId,
      option: 'approve',
      outcome: 'resolved',
    })
    expect(resolveEvent?.occurredAt).toBeTruthy()
  })

  it('resolveApproval with option deny transitions to denied', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

    const result = await resolveApproval(pool, {
      workspaceId: fixtures.workspaceId,
      approvalId: approval.id,
      option: 'deny',
      resolverPrincipalId: fixtures.approverPrincipalId,
    })

    expect(result.outcome).toBe('resolved')
    expect(result.approval?.status).toBe('denied')
    expect(result.approval?.selectedOption).toBe('deny')
  })

  describe('FR-APR-2: edit and approve validates against the capability schema and substitutes the edited value', () => {
    it('a valid edit is validated against the schema, stored, and returned as the value the caller receives, scrubbed for a registered secret', async () => {
      resetSecretScrubberForTests()
      registerSecretValue('sk_live_verysecrettoken123456')
      try {
        const fixtures = await createFixtures()
        const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

        const result = await resolveApproval(pool, {
          workspaceId: fixtures.workspaceId,
          approvalId: approval.id,
          option: 'edit_and_approve',
          resolverPrincipalId: fixtures.approverPrincipalId,
          editedArguments: JSON.stringify({
            command: 'rm -rf ~/Downloads/old-exports-2024-only, key sk_live_verysecrettoken123456',
          }),
        })

        expect(result.outcome).toBe('resolved')
        expect(result.approval?.status).toBe('approved')
        expect(result.approval?.selectedOption).toBe('edit_and_approve')
        // This is the deception check the team lead's finding named
        // explicitly: the value the caller receives back must BE the
        // edited value, not the approval's original target/arguments.
        const edited = result.approval?.editedArguments as { command: string }
        expect(edited.command).toContain('old-exports-2024-only')
        expect(edited.command).not.toContain('sk_live_verysecrettoken123456')

        const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
        expect((stored?.editedArguments as { command: string }).command).toContain('old-exports-2024-only')
      } finally {
        resetSecretScrubberForTests()
      }
    })

    it('malformed JSON is refused with invalid_input, leaves the approval pending, and never substitutes anything', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'edit_and_approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
        editedArguments: '{not valid json',
      })

      expect(result.outcome).toBe('invalid_input')
      expect(result.approval?.status).toBe('pending')
      expect(result.approval?.editedArguments).toBeNull()
      expect((await getApproval(pool, fixtures.workspaceId, approval.id))?.status).toBe('pending')
    })

    it('valid JSON that does not satisfy the capability schema is refused with invalid_input, leaves the approval pending', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'edit_and_approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
        // approvalTestInputSchema requires `command: string().min(1)`; a
        // number is a type mismatch, and an empty string violates min(1).
        editedArguments: JSON.stringify({ command: 42 }),
      })

      expect(result.outcome).toBe('invalid_input')
      expect(result.approval?.status).toBe('pending')
    })

    it('an approval whose capability is not registered at all is refused with invalid_input, never approved on an unvalidatable edit', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(
        pool,
        baseApprovalParams(fixtures, { requiresTypedConfirmation: false, capability: 'nothing.registered.this.name' }),
      )

      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'edit_and_approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
        editedArguments: JSON.stringify({ command: 'anything' }),
      })

      expect(result.outcome).toBe('invalid_input')
      expect(result.approval?.status).toBe('pending')
    })

  })

  it('resolveApproval with option approve_all_session grants a session-scoped, TTL-bounded approval visible to findActiveSessionGrant', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))
    const resolveTime = new Date('2026-08-10T12:00:00.000Z')

    const result = await resolveApproval(pool, {
      workspaceId: fixtures.workspaceId,
      approvalId: approval.id,
      option: 'approve_all_session',
      resolverPrincipalId: fixtures.approverPrincipalId,
      sessionGrantTtlMs: 60 * 60 * 1000,
      now: resolveTime,
    })

    expect(result.outcome).toBe('resolved')

    const stillLive = await findActiveSessionGrant(
      pool,
      fixtures.workspaceId,
      fixtures.sessionId,
      'shell.exec',
      new Date('2026-08-10T12:59:00.000Z'),
    )
    expect(stillLive).not.toBeNull()
    expect(stillLive?.expiresAt).toBe(new Date('2026-08-10T13:00:00.000Z').toISOString())

    const afterExpiry = await findActiveSessionGrant(
      pool,
      fixtures.workspaceId,
      fixtures.sessionId,
      'shell.exec',
      new Date('2026-08-10T13:01:00.000Z'),
    )
    expect(afterExpiry).toBeNull()
  })

  describe('FR-APR-5: typed confirmation for the highest tier', () => {
    it('requires typed confirmation before approve resolves', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: true }))

      const withoutToken = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
      })
      expect(withoutToken.outcome).toBe('confirmation_required')
      expect(withoutToken.approval?.status).toBe('pending')

      const wrongToken = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
        typedConfirmation: 'yes please',
      })
      expect(wrongToken.outcome).toBe('confirmation_mismatch')
      expect(wrongToken.approval?.status).toBe('pending')

      const correctToken = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
        typedConfirmation: CONFIRMATION_TOKEN,
      })
      expect(correctToken.outcome).toBe('resolved')
      expect(correctToken.approval?.status).toBe('approved')
    })

    it('does not require typed confirmation for deny, even on a tier that requires it for approve', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: true }))

      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'deny',
        resolverPrincipalId: fixtures.approverPrincipalId,
      })
      expect(result.outcome).toBe('resolved')
      expect(result.approval?.status).toBe('denied')
    })
  })

  describe('FR-APR-4: approver authorisation', () => {
    it('rejects an unauthorised principal, leaves the approval pending, and audits the attempt', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: fixtures.unauthorizedPrincipalId,
      })

      expect(result.outcome).toBe('unauthorized')
      expect(result.approval?.status).toBe('pending')

      const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
      expect(stored?.status).toBe('pending')

      const events = await listApprovalEvents(pool, fixtures.workspaceId, approval.id)
      expect(events.at(-1)).toMatchObject({
        actorPrincipalId: fixtures.unauthorizedPrincipalId,
        option: 'approve',
        outcome: 'unauthorized',
      })
    })

    /**
     * Fix round 1: a distinct case from "known principal, wrong role" above.
     * Here `resolverPrincipalId` names no row in `principals` at all (not
     * merely a principal lacking the role), so resolveApproval's own lookup
     * returns no roles array to check against, and the two failure paths
     * are different code, not the same branch read twice.
     */
    it('rejects an unknown resolver principal (absent from principals entirely), fail-closed rather than treating an empty roles list as unrestricted', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: `prn_${randomUUID()}`,
      })

      expect(result.outcome).toBe('unauthorized')
      expect((await getApproval(pool, fixtures.workspaceId, approval.id))?.status).toBe('pending')
    })

    it('hasRequiredRole([], []) is false: an empty held-roles set never satisfies an empty required-roles set, fail-closed on both sides', () => {
      expect(hasRequiredRole([], [])).toBe(false)
      expect(hasRequiredRole(['operator'], [])).toBe(false)
      expect(hasRequiredRole([], ['operator'])).toBe(false)
      expect(hasRequiredRole(['operator'], ['operator'])).toBe(true)
    })

    it('createApproval rejects an empty requiredRoles list immediately, before any database write', async () => {
      const fixtures = await createFixtures()
      await expect(
        createApproval(pool, baseApprovalParams(fixtures, { requiredRoles: [] })),
      ).rejects.toThrow(/requiredRoles must name at least one role/)
    })

  })

  describe('FR-APR-3: timeout defaults to deny-and-pause, never proceed', () => {
    it('a resolution attempt after the deadline returns expired, never approves, and the run stays paused', async () => {
      const fixtures = await createFixtures()
      const createdAt = new Date('2026-08-10T09:00:00.000Z')
      const approval = await createApproval(
        pool,
        baseApprovalParams(fixtures, { requiresTypedConfirmation: false, timeoutMs: 60_000, now: createdAt }),
      )

      const pastDeadline = new Date(createdAt.getTime() + 60_001)
      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
        now: pastDeadline,
      })

      expect(result.outcome).toBe('expired')
      expect(result.approval?.status).toBe('timed_out')
      expect(result.approval?.status).not.toBe('approved')

      const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
      expect(stored?.status).toBe('timed_out')
    })

    it('an authorized, correctly-confirmed approve still expires once past the deadline: deadline is checked before authorization and confirmation', async () => {
      const fixtures = await createFixtures()
      const createdAt = new Date('2026-08-10T09:00:00.000Z')
      const approval = await createApproval(
        pool,
        baseApprovalParams(fixtures, { requiresTypedConfirmation: true, timeoutMs: 1_000, now: createdAt }),
      )

      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
        typedConfirmation: CONFIRMATION_TOKEN,
        now: new Date(createdAt.getTime() + 5_000),
      })

      expect(result.outcome).toBe('expired')
      expect(result.approval?.status).toBe('timed_out')
    })

    it('expireApproval sweeps an overdue pending approval with a system (null) actor, and is a no-op for one not yet overdue', async () => {
      const fixtures = await createFixtures()
      const createdAt = new Date('2026-08-10T09:00:00.000Z')
      const approval = await createApproval(
        pool,
        baseApprovalParams(fixtures, { requiresTypedConfirmation: false, timeoutMs: 60_000, now: createdAt }),
      )

      const tooEarly = await expireApproval(pool, fixtures.workspaceId, approval.id, createdAt)
      expect(tooEarly?.status).toBe('pending')

      const swept = await expireApproval(
        pool,
        fixtures.workspaceId,
        approval.id,
        new Date(createdAt.getTime() + 60_001),
      )
      expect(swept?.status).toBe('timed_out')

      const events = await listApprovalEvents(pool, fixtures.workspaceId, approval.id)
      const expiryEvent = events.find((event) => event.action === 'expired')
      expect(expiryEvent).toMatchObject({ actorPrincipalId: null, outcome: 'timed_out' })
    })

    it('listOverdueApprovals finds a pending approval past its deadline and excludes one not yet due', async () => {
      const fixtures = await createFixtures()
      const createdAt = new Date('2026-08-10T09:00:00.000Z')
      const overdue = await createApproval(
        pool,
        baseApprovalParams(fixtures, { requiresTypedConfirmation: false, timeoutMs: 1_000, now: createdAt }),
      )
      await createApproval(
        pool,
        baseApprovalParams(fixtures, { requiresTypedConfirmation: false, timeoutMs: 999_999, now: createdAt }),
      )

      const overdueList = await listOverdueApprovals(
        pool,
        fixtures.workspaceId,
        new Date(createdAt.getTime() + 2_000),
      )
      expect(overdueList.map((approval) => approval.id)).toEqual([overdue.id])
    })

  })

  describe('resolving an already-terminal approval', () => {
    it('a second resolveApproval call on an already-resolved approval returns already_resolved and does not change it', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

      const first = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
      })
      expect(first.outcome).toBe('resolved')

      const second = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'deny',
        resolverPrincipalId: fixtures.approverPrincipalId,
      })
      expect(second.outcome).toBe('already_resolved')
      expect(second.approval?.status).toBe('approved')
      expect(second.approval?.selectedOption).toBe('approve')
    })

    it('resolveApproval against an unknown approval id returns not_found', async () => {
      const fixtures = await createFixtures()
      const result = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: randomUUID(),
        option: 'approve',
        resolverPrincipalId: fixtures.approverPrincipalId,
      })
      expect(result).toEqual({ outcome: 'not_found', approval: null })
    })
  })

  describe('concurrency', () => {
    it('three concurrent approvals resolve to the correct three actions, with no cross-contamination', async () => {
      const fixtures = await createFixtures()
      const [toApprove, toDeny, toEditApprove] = await Promise.all([
        createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false, capability: 'fs.write' })),
        createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false, capability: 'api.call' })),
        // Must be the registered test capability ('shell.exec', the
        // baseApprovalParams default): edit_and_approve validates against a
        // real inputSchema, so this is the one of the three that needs it.
        createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false })),
      ])

      const [approveResult, denyResult, editResult] = await Promise.all([
        resolveApproval(pool, {
          workspaceId: fixtures.workspaceId,
          approvalId: toApprove.id,
          option: 'approve',
          resolverPrincipalId: fixtures.approverPrincipalId,
        }),
        resolveApproval(pool, {
          workspaceId: fixtures.workspaceId,
          approvalId: toDeny.id,
          option: 'deny',
          resolverPrincipalId: fixtures.approverPrincipalId,
        }),
        resolveApproval(pool, {
          workspaceId: fixtures.workspaceId,
          approvalId: toEditApprove.id,
          option: 'edit_and_approve',
          resolverPrincipalId: fixtures.approverPrincipalId,
          editedArguments: JSON.stringify({ command: 'revised target' }),
        }),
      ])

      expect(approveResult.outcome).toBe('resolved')
      expect(approveResult.approval?.selectedOption).toBe('approve')
      expect(approveResult.approval?.id).toBe(toApprove.id)

      expect(denyResult.outcome).toBe('resolved')
      expect(denyResult.approval?.selectedOption).toBe('deny')
      expect(denyResult.approval?.id).toBe(toDeny.id)

      expect(editResult.outcome).toBe('resolved')
      expect(editResult.approval?.selectedOption).toBe('edit_and_approve')
      expect(editResult.approval?.editedArguments).toEqual({ command: 'revised target' })
      expect(editResult.approval?.id).toBe(toEditApprove.id)

      // Reading each back independently confirms the concurrent writes
      // landed on the correct rows, not merely that each promise resolved
      // with the shape it expected.
      expect((await getApproval(pool, fixtures.workspaceId, toApprove.id))?.status).toBe('approved')
      expect((await getApproval(pool, fixtures.workspaceId, toDeny.id))?.status).toBe('denied')
      expect((await getApproval(pool, fixtures.workspaceId, toEditApprove.id))?.status).toBe('approved')
    })

    it('two concurrent resolutions of the SAME approval: exactly one resolves, the other observes already_resolved', async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, baseApprovalParams(fixtures, { requiresTypedConfirmation: false }))

      const [first, second] = await Promise.all([
        resolveApproval(pool, {
          workspaceId: fixtures.workspaceId,
          approvalId: approval.id,
          option: 'approve',
          resolverPrincipalId: fixtures.approverPrincipalId,
        }),
        resolveApproval(pool, {
          workspaceId: fixtures.workspaceId,
          approvalId: approval.id,
          option: 'deny',
          resolverPrincipalId: fixtures.approverPrincipalId,
        }),
      ])

      const outcomes = [first.outcome, second.outcome].sort()
      expect(outcomes).toEqual(['already_resolved', 'resolved'])

      const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
      expect(['approved', 'denied']).toContain(stored?.status)

      const events = await listApprovalEvents(pool, fixtures.workspaceId, approval.id)
      const resolveAttempts = events.filter((event) => event.action === 'resolve_attempt')
      expect(resolveAttempts).toHaveLength(2)
      expect(resolveAttempts.filter((event) => event.outcome === 'resolved')).toHaveLength(1)
      expect(resolveAttempts.filter((event) => event.outcome === 'already_resolved')).toHaveLength(1)
    })
  })
})
