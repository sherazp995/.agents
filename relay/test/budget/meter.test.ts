import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { createRun } from '../../src/runs/store.js'
import { getApproval, resolveApproval } from '../../src/approvals/store.js'
import {
  applyBudgetApprovalResolution,
  budgetCapabilityName,
  getPrincipalDaySpend,
  getRunExemption,
  getRunSpend,
  getSessionSpend,
  raiseRunCap,
  recordSpend,
  requestBudgetAuthorization,
  utcDayBounds,
} from '../../src/budget/meter.js'
import type { BudgetCaps } from '../../src/budget/meter.js'
import { getTestDatabaseUrl } from '../support/database.js'

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
              'Budget meter tests must fail, not silently skip, when it is absent.',
          )
        })
      })

function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run budget meter tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

/** Generous, effectively-unlimited caps for the scopes a test does not care about, so a test asserting one scope's behaviour never accidentally trips another. */
const LARGE = 1_000_000
function caps(overrides: Partial<BudgetCaps> = {}): BudgetCaps {
  return { runCapUsd: LARGE, sessionCapUsd: LARGE, principalDayCapUsd: LARGE, ...overrides }
}

describeDb('src/budget/meter.ts', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  /** Every ledger row foreign-keys to a real workspace, run, session, and principal; most tests need at least one of each. */
  async function createFixtures() {
    const workspaceId = await resolveWorkspaceId(pool, 'test', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'test', `U_${randomUUID()}`, 'Test Principal', [
      'operator',
    ])
    const session = await findOrCreateSession(pool, {
      workspaceId,
      principalId,
      adapter: 'test',
      threadRef: `thread-${randomUUID()}`,
    })
    const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId })
    return { workspaceId, sessionId: session.id, runId: run.id, principalId }
  }

  /** A second run in the SAME session and by the SAME principal, so session-scope and principal-day-scope tests can prove they aggregate ACROSS runs, not merely within one. */
  async function createSiblingRun(fixtures: Awaited<ReturnType<typeof createFixtures>>) {
    const run = await createRun(pool, {
      workspaceId: fixtures.workspaceId,
      sessionId: fixtures.sessionId,
      principalId: fixtures.principalId,
    })
    return run.id
  }

  describe('utcDayBounds', () => {
    it('gives the [midnight, next midnight) UTC window for a timestamp in the middle of the day', () => {
      const { start, end } = utcDayBounds(new Date('2026-08-10T14:30:00.000Z'))
      expect(start.toISOString()).toBe('2026-08-10T00:00:00.000Z')
      expect(end.toISOString()).toBe('2026-08-11T00:00:00.000Z')
    })

    it('a timestamp at exactly UTC midnight belongs to the day that is starting, not the one that just ended', () => {
      const { start, end } = utcDayBounds(new Date('2026-08-10T00:00:00.000Z'))
      expect(start.toISOString()).toBe('2026-08-10T00:00:00.000Z')
      expect(end.toISOString()).toBe('2026-08-11T00:00:00.000Z')
    })

    it('a timestamp one millisecond before UTC midnight belongs to the day that is ending, not the next one', () => {
      const { start, end } = utcDayBounds(new Date('2026-08-10T23:59:59.999Z'))
      expect(start.toISOString()).toBe('2026-08-10T00:00:00.000Z')
      expect(end.toISOString()).toBe('2026-08-11T00:00:00.000Z')
    })
  })

  describe('recordSpend: basic accounting', () => {
    it('records a spend and reports it under all three scopes when nothing is exceeded', async () => {
      const fixtures = await createFixtures()
      const result = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 1.5,
        caps: caps(),
      })

      expect(result.exceeded).toEqual([])
      expect(result.runSpentUsd).toBe(1.5)
      expect(result.sessionSpentUsd).toBe(1.5)
      expect(result.principalDaySpentUsd).toBe(1.5)
    })

    it('accumulates across multiple spend events for the same run', async () => {
      const fixtures = await createFixtures()
      await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 0.75,
        caps: caps(),
      })
      const second = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 0.25,
        caps: caps(),
      })

      expect(second.runSpentUsd).toBe(1)
      expect(await getRunSpend(pool, fixtures.workspaceId, fixtures.runId)).toBe(1)
    })

    it('getRunSpend, getSessionSpend, and getPrincipalDaySpend all return 0 for an id with no recorded spend', async () => {
      const fixtures = await createFixtures()
      expect(await getRunSpend(pool, fixtures.workspaceId, fixtures.runId)).toBe(0)
      expect(await getSessionSpend(pool, fixtures.workspaceId, fixtures.sessionId)).toBe(0)
      expect(await getPrincipalDaySpend(pool, fixtures.workspaceId, fixtures.principalId)).toBe(0)
    })
  })

  describe('each of the three scopes is independently enforced', () => {
    it('a tiny run cap flags only the run scope, even though session and principal-day caps are generous', async () => {
      const fixtures = await createFixtures()
      const result = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 10,
        caps: caps({ runCapUsd: 1 }),
      })

      expect(result.exceeded).toEqual([{ scope: 'run', capUsd: 1, spentUsd: 10 }])
    })

    it('a tiny session cap flags only the session scope, aggregating across two different runs in that session', async () => {
      const fixtures = await createFixtures()
      const secondRunId = await createSiblingRun(fixtures)

      await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 6,
        caps: caps({ sessionCapUsd: 10 }),
      })
      const result = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: secondRunId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 6,
        caps: caps({ sessionCapUsd: 10 }),
      })

      // The second run's OWN spend (6) is well under its own generous run
      // cap, so only the session scope (6 + 6 = 12 > 10) is exceeded.
      expect(result.exceeded).toEqual([{ scope: 'session', capUsd: 10, spentUsd: 12 }])
    })

    it('a tiny principal-day cap flags only the principal_day scope, aggregating across two different sessions for the same principal on the same day', async () => {
      const fixtures = await createFixtures()
      const otherSession = await findOrCreateSession(pool, {
        workspaceId: fixtures.workspaceId,
        principalId: fixtures.principalId,
        adapter: 'test',
        threadRef: `thread-${randomUUID()}`,
      })
      const otherRun = await createRun(pool, {
        workspaceId: fixtures.workspaceId,
        sessionId: otherSession.id,
        principalId: fixtures.principalId,
      })
      const now = new Date('2026-08-10T09:00:00.000Z')

      await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 6,
        caps: caps({ principalDayCapUsd: 10 }),
        now,
      })
      const result = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: otherRun.id,
        sessionId: otherSession.id,
        principalId: fixtures.principalId,
        amountUsd: 6,
        caps: caps({ principalDayCapUsd: 10 }),
        now,
      })

      expect(result.exceeded).toEqual([{ scope: 'principal_day', capUsd: 10, spentUsd: 12 }])
    })

    it('all three scopes can be exceeded at once, and all three are reported', async () => {
      const fixtures = await createFixtures()
      const result = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 10,
        caps: { runCapUsd: 1, sessionCapUsd: 2, principalDayCapUsd: 3 },
      })

      expect(result.exceeded.map((e) => e.scope).sort()).toEqual(['principal_day', 'run', 'session'])
    })
  })

  describe('the day boundary is deliberate: spend on one UTC day does not count against another', () => {
    it('principal-day spend recorded yesterday does not count toward today\'s cap', async () => {
      const fixtures = await createFixtures()
      const yesterday = new Date('2026-08-09T12:00:00.000Z')
      const today = new Date('2026-08-10T12:00:00.000Z')

      await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 9,
        caps: caps({ principalDayCapUsd: 10 }),
        now: yesterday,
      })
      const todayResult = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 9,
        caps: caps({ principalDayCapUsd: 10 }),
        now: today,
      })

      // If yesterday's spend leaked into today's total this would be
      // 18 > 10 and flagged; it is not, because the two are different UTC
      // days.
      expect(todayResult.principalDaySpentUsd).toBe(9)
      expect(todayResult.exceeded).toEqual([])
      expect(await getPrincipalDaySpend(pool, fixtures.workspaceId, fixtures.principalId, yesterday)).toBe(9)
      expect(await getPrincipalDaySpend(pool, fixtures.workspaceId, fixtures.principalId, today)).toBe(9)
    })
  })

  describe('raiseRunCap: the run-scoped remedy for FR-ORC-7\'s "asks for authorisation"', () => {
    it('getRunExemption returns null before any raise has ever been recorded', async () => {
      const fixtures = await createFixtures()
      expect(await getRunExemption(pool, fixtures.workspaceId, fixtures.runId, 'run')).toBeNull()
    })

    it('raising the run cap lets further spend for that run pass where it would otherwise be flagged', async () => {
      const fixtures = await createFixtures()
      const first = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 10,
        caps: caps({ runCapUsd: 5 }),
      })
      expect(first.exceeded).toEqual([{ scope: 'run', capUsd: 5, spentUsd: 10 }])

      await raiseRunCap(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        scope: 'run',
        raisedToUsd: 50,
        grantedByPrincipalId: fixtures.principalId,
      })

      const second = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 10,
        caps: caps({ runCapUsd: 5 }),
      })
      // Total spend is now 20, under the raised ceiling of 50, and the
      // original policy cap (5) is never mutated: effectiveCap takes the
      // greater of the two.
      expect(second.exceeded).toEqual([])
      expect(second.runSpentUsd).toBe(20)
    })

    it('a raise is never permanent: the original caller-supplied cap is untouched, only this run\'s exemption changes', async () => {
      const fixtures = await createFixtures()
      await raiseRunCap(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        scope: 'run',
        raisedToUsd: 100,
        grantedByPrincipalId: fixtures.principalId,
      })

      // The SAME caps object, with the SAME runCapUsd: 5, is passed again;
      // nothing about raiseRunCap could have mutated it, since it is a
      // plain object this test itself constructs fresh each call.
      const result = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 6,
        caps: caps({ runCapUsd: 5 }),
      })
      // 6 > 5 (the original cap) but 6 < 100 (the raised ceiling), so
      // effectiveCap took the raised value; the literal number 5 the test
      // passed in was never changed by raiseRunCap, only shadowed for this
      // one run.
      expect(result.exceeded).toEqual([])
      expect(result.runSpentUsd).toBe(6)
    })

    it('a raise is never for a sibling: a second run in the same session and by the same principal does not inherit the exemption', async () => {
      const fixtures = await createFixtures()
      const siblingRunId = await createSiblingRun(fixtures)

      await raiseRunCap(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        scope: 'run',
        raisedToUsd: 1000,
        grantedByPrincipalId: fixtures.principalId,
      })

      const siblingResult = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: siblingRunId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 10,
        caps: caps({ runCapUsd: 5, sessionCapUsd: LARGE }),
      })

      expect(siblingResult.exceeded).toEqual([{ scope: 'run', capUsd: 5, spentUsd: 10 }])
      expect(await getRunExemption(pool, fixtures.workspaceId, siblingRunId, 'run')).toBeNull()
    })

    it('raising one scope does not raise the others for the same run: each scope has its own exemption', async () => {
      const fixtures = await createFixtures()
      await raiseRunCap(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        scope: 'run',
        raisedToUsd: 1000,
        grantedByPrincipalId: fixtures.principalId,
      })

      const result = await recordSpend(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        principalId: fixtures.principalId,
        amountUsd: 10,
        caps: caps({ runCapUsd: 5, sessionCapUsd: 5, principalDayCapUsd: 5 }),
      })

      // 'run' was raised to 1000 and is not exceeded; 'session' and
      // 'principal_day' were never raised and still use the original cap
      // of 5, so both are exceeded.
      expect(result.exceeded.map((e) => e.scope).sort()).toEqual(['principal_day', 'session'])
    })

    it('a second raise for the same run and scope replaces the previous ceiling rather than erroring or stacking', async () => {
      const fixtures = await createFixtures()
      await raiseRunCap(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        scope: 'run',
        raisedToUsd: 20,
        grantedByPrincipalId: fixtures.principalId,
      })
      await raiseRunCap(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        scope: 'run',
        raisedToUsd: 40,
        grantedByPrincipalId: fixtures.principalId,
      })

      expect(await getRunExemption(pool, fixtures.workspaceId, fixtures.runId, 'run')).toBe(40)
    })
  })

  describe('approvals integration: FR-ORC-7\'s "asks for authorisation" reuses the existing approvals store', () => {
    it('requestBudgetAuthorization creates a real, pending approval row carrying the exceeded scope\'s detail', async () => {
      const fixtures = await createFixtures()
      const approval = await requestBudgetAuthorization(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        requesterPrincipalId: fixtures.principalId,
        exceeded: { scope: 'run', capUsd: 5, spentUsd: 12.5 },
        suggestedCapUsd: 25,
        requiredRoles: ['operator'],
        timeoutMs: 60_000,
      })

      expect(approval.status).toBe('pending')
      expect(approval.capability).toBe(budgetCapabilityName('run'))
      expect(approval.tier).toBe('sensitive')
      expect(approval.description).toContain('12.50')
      expect(approval.target).toContain('25.00')

      // Independent read: this is the proof the approval genuinely landed
      // in Postgres through the real approvals store, not merely that the
      // function returned an object shaped like one.
      const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
      expect(stored?.status).toBe('pending')
    })

    it('approving the budget approval raises the run\'s cap for that scope; denying it does not', async () => {
      const fixtures = await createFixtures()
      const approverId = await provisionPrincipal(
        pool,
        fixtures.workspaceId,
        'test',
        `U_approver_${randomUUID()}`,
        'Approver',
        ['operator'],
      )

      const approval = await requestBudgetAuthorization(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        requesterPrincipalId: fixtures.principalId,
        exceeded: { scope: 'session', capUsd: 5, spentUsd: 12 },
        suggestedCapUsd: 30,
        requiredRoles: ['operator'],
        timeoutMs: 60_000,
      })

      const resolution = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: approval.id,
        option: 'approve',
        resolverPrincipalId: approverId,
      })
      expect(resolution.outcome).toBe('resolved')

      const { raised } = await applyBudgetApprovalResolution(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        scope: 'session',
        raisedToUsd: 30,
        resolution,
      })
      expect(raised).toBe(true)
      expect(await getRunExemption(pool, fixtures.workspaceId, fixtures.runId, 'session')).toBe(30)

      // A second approval, denied, must NOT raise anything.
      const secondApproval = await requestBudgetAuthorization(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        sessionId: fixtures.sessionId,
        requesterPrincipalId: fixtures.principalId,
        exceeded: { scope: 'run', capUsd: 5, spentUsd: 12 },
        suggestedCapUsd: 30,
        requiredRoles: ['operator'],
        timeoutMs: 60_000,
      })
      const denyResolution = await resolveApproval(pool, {
        workspaceId: fixtures.workspaceId,
        approvalId: secondApproval.id,
        option: 'deny',
        resolverPrincipalId: approverId,
      })
      const { raised: deniedRaised } = await applyBudgetApprovalResolution(pool, {
        workspaceId: fixtures.workspaceId,
        runId: fixtures.runId,
        scope: 'run',
        raisedToUsd: 30,
        resolution: denyResolution,
      })
      expect(deniedRaised).toBe(false)
      expect(await getRunExemption(pool, fixtures.workspaceId, fixtures.runId, 'run')).toBeNull()
    })
  })

  describe('concurrency: three concurrent spend events land correctly', () => {
    it('three concurrent recordSpend calls for the same run all get recorded, and the final total reflects all three', async () => {
      const fixtures = await createFixtures()
      await Promise.all([
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: fixtures.runId,
          sessionId: fixtures.sessionId,
          principalId: fixtures.principalId,
          amountUsd: 1,
          caps: caps(),
        }),
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: fixtures.runId,
          sessionId: fixtures.sessionId,
          principalId: fixtures.principalId,
          amountUsd: 2,
          caps: caps(),
        }),
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: fixtures.runId,
          sessionId: fixtures.sessionId,
          principalId: fixtures.principalId,
          amountUsd: 3,
          caps: caps(),
        }),
      ])

      expect(await getRunSpend(pool, fixtures.workspaceId, fixtures.runId)).toBe(6)
    })

    /**
     * Fix round 1, per the team lead's finding: a sequential test cannot
     * fail on a read-after-insert race, so this fires two GENUINELY
     * concurrent spends, each individually under the cap, together over
     * it. recordSpend never refuses a write outright (the spend already
     * happened by the time it is called; see recordSpend's own doc
     * comment), so the race, adapted to this module's actual semantics, is
     * whether exactly one of the two calls' own SUM read reflects BOTH
     * rows (and is therefore correctly flagged exceeded) or whether the
     * race lets both calls read only their own row and both wrongly report
     * `exceeded: []`. Two concurrent calls, correctly serialized, can only
     * ever produce one of two totals at the moment each one's SUM runs:
     * its own amount alone (not exceeded), or both amounts together
     * (exceeded), so "exactly one flagged, one not" is the deterministic
     * signature of the race being closed, and "neither flagged" is the
     * signature of the race being open.
     */
    it('two concurrent spends on the SAME run, each under the cap, together over it: exactly one is flagged exceeded', async () => {
      const fixtures = await createFixtures()
      const [first, second] = await Promise.all([
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: fixtures.runId,
          sessionId: fixtures.sessionId,
          principalId: fixtures.principalId,
          amountUsd: 6,
          caps: caps({ runCapUsd: 10 }),
        }),
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: fixtures.runId,
          sessionId: fixtures.sessionId,
          principalId: fixtures.principalId,
          amountUsd: 6,
          caps: caps({ runCapUsd: 10 }),
        }),
      ])

      const flaggedCount = [first, second].filter((r) => r.exceeded.some((e) => e.scope === 'run')).length
      expect(flaggedCount).toBe(1)
      expect(await getRunSpend(pool, fixtures.workspaceId, fixtures.runId)).toBe(12)
    })

    it('two concurrent spends on TWO DIFFERENT runs in the SAME session, each under the session cap, together over it: exactly one is flagged exceeded', async () => {
      const fixtures = await createFixtures()
      const secondRunId = await createSiblingRun(fixtures)

      const [first, second] = await Promise.all([
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: fixtures.runId,
          sessionId: fixtures.sessionId,
          principalId: fixtures.principalId,
          amountUsd: 6,
          caps: caps({ sessionCapUsd: 10 }),
        }),
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: secondRunId,
          sessionId: fixtures.sessionId,
          principalId: fixtures.principalId,
          amountUsd: 6,
          caps: caps({ sessionCapUsd: 10 }),
        }),
      ])

      const flaggedCount = [first, second].filter((r) => r.exceeded.some((e) => e.scope === 'session')).length
      expect(flaggedCount).toBe(1)
      expect(await getSessionSpend(pool, fixtures.workspaceId, fixtures.sessionId)).toBe(12)
    })

    it('two concurrent spends by the SAME principal in TWO DIFFERENT sessions on the same day, each under the principal-day cap, together over it: exactly one is flagged exceeded', async () => {
      const fixtures = await createFixtures()
      const otherSession = await findOrCreateSession(pool, {
        workspaceId: fixtures.workspaceId,
        principalId: fixtures.principalId,
        adapter: 'test',
        threadRef: `thread-${randomUUID()}`,
      })
      const otherRun = await createRun(pool, {
        workspaceId: fixtures.workspaceId,
        sessionId: otherSession.id,
        principalId: fixtures.principalId,
      })
      const now = new Date('2026-08-10T09:00:00.000Z')

      const [first, second] = await Promise.all([
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: fixtures.runId,
          sessionId: fixtures.sessionId,
          principalId: fixtures.principalId,
          amountUsd: 6,
          caps: caps({ principalDayCapUsd: 10 }),
          now,
        }),
        recordSpend(pool, {
          workspaceId: fixtures.workspaceId,
          runId: otherRun.id,
          sessionId: otherSession.id,
          principalId: fixtures.principalId,
          amountUsd: 6,
          caps: caps({ principalDayCapUsd: 10 }),
          now,
        }),
      ])

      const flaggedCount = [first, second].filter((r) => r.exceeded.some((e) => e.scope === 'principal_day')).length
      expect(flaggedCount).toBe(1)
      expect(await getPrincipalDaySpend(pool, fixtures.workspaceId, fixtures.principalId, now)).toBe(12)
    })
  })
})
