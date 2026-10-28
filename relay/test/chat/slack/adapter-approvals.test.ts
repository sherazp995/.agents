/**
 * Task 4 (P0.4): proves the full production path from a Slack Block Kit
 * payload to a resolved row in Postgres, per the team lead's explicit
 * instruction: "A test that calls store.resolve() directly and asserts the
 * row changed proves nothing about whether a Slack button can reach it."
 *
 * Every test here builds a real SlackAdapter, wires its
 * resolveApprovalInteraction option to src/approvals/store.ts's real
 * resolveApproval bound to a real pool, drives the adapter's REAL
 * dispatchAction/dispatchView listeners (registered by SlackAdapter.start()
 * itself, exactly as a live Bolt connection would call them) with a
 * realistic Block Kit payload, and then reads the row back independently
 * with getApproval/findActiveSessionGrant to confirm what actually landed
 * in the database, not merely what the adapter's own in-memory return value
 * claimed.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../../src/db/pool.js'
import { applyMigrations } from '../../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../../src/sessions/store.js'
import { createRun } from '../../../src/runs/store.js'
import { getTestDatabaseUrl } from '../../support/database.js'
import { SlackAdapter } from '../../../src/chat/slack/adapter.js'
import type {
  SlackAdapterCreateOptions,
  SlackApiClient,
  SlackAuthIdentity,
  SlackBlockActionEnvelope,
  SlackBoltApp,
  SlackEventEnvelope,
  SlackEventListener,
  SlackActionListener,
  SlackOpenModalArgs,
  SlackPostMessageArgs,
  SlackUpdateMessageArgs,
  SlackUploadFileArgs,
  SlackViewListener,
  SlackViewSubmissionEnvelope,
  SlackViewSubmissionResponse,
} from '../../../src/chat/slack/adapter.js'
import type { SecretProvider } from '../../../src/secrets/provider.js'
import {
  APPROVAL_ACTION_IDS,
  CONFIRMATION_TOKEN,
  CONFIRM_MODAL_ACTION_ID,
  CONFIRM_MODAL_BLOCK_ID,
  CONFIRM_MODAL_CALLBACK_ID,
  EDIT_MODAL_ACTION_ID,
  EDIT_MODAL_BLOCK_ID,
  EDIT_MODAL_CALLBACK_ID,
} from '../../../src/approvals/blockkit.js'
import {
  registerApprovalTestCapability,
  unregisterApprovalTestCapability,
} from '../../support/approval-test-capability.js'
import {
  createApproval,
  findActiveSessionGrant,
  getApproval,
  resolveApproval,
} from '../../../src/approvals/store.js'

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
              'SlackAdapter approval production-path tests must fail, not silently skip, when it is absent.',
          )
        })
      })

function assertTestDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run SlackAdapter approval production-path tests against database "${databaseName}": ` +
        'RELAY_TEST_DATABASE_URL must point at a database whose name ends in _test.',
    )
  }
}

// ---------------------------------------------------------------------------
// Minimal local stubs for the Slack SDK boundary. Deliberately independent
// of test/chat/slack/adapter.test.ts's own (richer) stubs, mirroring how
// test/orchestrator.test.ts already keeps its own copy rather than
// importing another test file's fixtures; this file only needs the pieces
// that matter for the production-path proof, not rate-limit simulation.
// ---------------------------------------------------------------------------

class StubBoltApp implements SlackBoltApp {
  readonly #listenersByType = new Map<string, SlackEventListener[]>()
  readonly #listenersByActionId = new Map<string, SlackActionListener>()
  readonly #listenersByCallbackId = new Map<string, SlackViewListener>()

  event(eventType: string, listener: SlackEventListener): void {
    const list = this.#listenersByType.get(eventType) ?? []
    list.push(listener)
    this.#listenersByType.set(eventType, list)
  }

  action(actionId: string, listener: SlackActionListener): void {
    this.#listenersByActionId.set(actionId, listener)
  }

  command(): void {}

  view(callbackId: string, listener: SlackViewListener): void {
    this.#listenersByCallbackId.set(callbackId, listener)
  }

  async start(): Promise<unknown> {
    return undefined
  }

  async stop(): Promise<void> {}

  async dispatch(eventType: string, envelope: SlackEventEnvelope): Promise<void> {
    const list = this.#listenersByType.get(eventType) ?? []
    for (const listener of list) await listener(envelope)
  }

  /** Drives the REAL listener SlackAdapter.start() registered for `actionId`, exactly as a live Socket Mode block_actions delivery would call it. */
  async dispatchAction(actionId: string, envelope: SlackBlockActionEnvelope): Promise<void> {
    const listener = this.#listenersByActionId.get(actionId)
    if (!listener) throw new Error(`StubBoltApp: no action listener registered for "${actionId}"`)
    await listener(envelope)
  }

  /** Drives the REAL listener SlackAdapter.start() registered for `callbackId` (a modal view_submission). */
  async dispatchView(callbackId: string, envelope: SlackViewSubmissionEnvelope): Promise<SlackViewSubmissionResponse> {
    const listener = this.#listenersByCallbackId.get(callbackId)
    if (!listener) throw new Error(`StubBoltApp: no view listener registered for "${callbackId}"`)
    return listener(envelope)
  }
}

class StubSlackApiClient implements SlackApiClient {
  readonly updated: SlackUpdateMessageArgs[] = []
  readonly openedModals: SlackOpenModalArgs[] = []
  #seq = 0

  constructor(private readonly identity: SlackAuthIdentity) {}

  async authTest(): Promise<SlackAuthIdentity> {
    return this.identity
  }

  async postMessage(_args: SlackPostMessageArgs): Promise<{ ts: string }> {
    this.#seq += 1
    return { ts: `${this.#seq}.000001` }
  }

  async updateMessage(args: SlackUpdateMessageArgs): Promise<{ ts: string }> {
    this.updated.push(args)
    return { ts: args.ts }
  }

  async uploadFile(): Promise<void> {}

  async openModal(args: SlackOpenModalArgs): Promise<void> {
    this.openedModals.push(args)
  }

  async addReaction(): Promise<void> {}
}

function fakeSecrets(): SecretProvider {
  return {
    kind: 'env',
    async get(name: string) {
      return `fake-${name}`
    },
    async has() {
      return true
    },
  }
}

describeDb('SlackAdapter approval interactions drive real Postgres', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    assertTestDatabase(databaseUrl)
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
    registerApprovalTestCapability()
  })

  afterAll(async () => {
    unregisterApprovalTestCapability()
    await closePool(pool)
  })

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
    const approverPlatformUserId = `U_approver_${randomUUID()}`
    const approverPrincipalId = await provisionPrincipal(
      pool,
      workspaceId,
      'test',
      approverPlatformUserId,
      'Approver',
      options.approverRoles ?? ['operator'],
    )
    const session = await findOrCreateSession(pool, {
      workspaceId,
      principalId: requesterPrincipalId,
      adapter: 'test',
      threadRef: `thread-${randomUUID()}`,
    })
    const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId: requesterPrincipalId })
    return { workspaceId, sessionId: session.id, runId: run.id, requesterPrincipalId, approverPrincipalId, approverPlatformUserId }
  }

  type Fixtures = Awaited<ReturnType<typeof createFixtures>>

  function approvalParams(fixtures: Fixtures, overrides: Partial<Parameters<typeof createApproval>[1]> = {}) {
    return {
      workspaceId: fixtures.workspaceId,
      runId: fixtures.runId,
      sessionId: fixtures.sessionId,
      requesterPrincipalId: fixtures.requesterPrincipalId,
      capability: 'shell.exec',
      description: 'Delete old export files',
      target: 'rm -rf ~/Downloads/old-exports',
      tier: 'irreversible' as const,
      escalationReason: 'irreversible-tier action always requires approval',
      requiredRoles: ['operator'],
      timeoutMs: 60_000,
      ...overrides,
    }
  }

  /**
   * Builds a real SlackAdapter whose resolveApprovalInteraction is wired to
   * the real resolveApproval, bound to this test's pool and workspace: the
   * exact seam Task 3's future policy wiring will eventually fill in for
   * real, exercised here directly against Postgres.
   */
  async function buildAdapter(workspaceId: string, resolvePrincipalIdMap: Record<string, string>) {
    const boltApp = new StubBoltApp()
    const apiClient = new StubSlackApiClient({ botUserId: 'UBOTFAKE', platformTeamId: 'TFAKE' })
    const createOptions: SlackAdapterCreateOptions = {
      boltApp,
      apiClient,
      resolveWorkspaceId: async () => workspaceId,
      resolvePrincipalId: async (platformUserId) => resolvePrincipalIdMap[platformUserId] ?? null,
      resolveApprovalInteraction: async (request) =>
        resolveApproval(pool, {
          workspaceId,
          approvalId: request.approvalId,
          option: request.option,
          // Passed straight through, including null: fix round 1 widened
          // resolveApproval's own resolverPrincipalId to accept it directly
          // (an unmapped Slack user), rather than a caller having to invent
          // a sentinel string, which used to violate approval_events' own
          // foreign key the moment it tried to audit the rejection.
          resolverPrincipalId: request.resolverPrincipalId,
          ...(request.typedConfirmation !== undefined ? { typedConfirmation: request.typedConfirmation } : {}),
          ...(request.editedArguments !== undefined ? { editedArguments: request.editedArguments } : {}),
        }),
    }
    const adapter = await SlackAdapter.create(fakeSecrets(), createOptions)
    await adapter.start(async () => {})
    return { adapter, boltApp, apiClient }
  }

  function buttonEnvelope(
    actionId: string,
    value: Record<string, unknown>,
    platformUserId: string,
    channel: string,
    messageTs: string,
  ): SlackBlockActionEnvelope {
    return {
      actions: [{ action_id: actionId, type: 'button', value: JSON.stringify(value) }],
      user: { id: platformUserId },
      channel: { id: channel },
      message: { ts: messageTs },
      trigger_id: 'trigger_1',
    }
  }

  it('clicking Approve resolves the real approval row in Postgres and updates the Slack card', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, approvalParams(fixtures, { requiresTypedConfirmation: false }))
    const { boltApp, apiClient } = await buildAdapter(fixtures.workspaceId, {
      [fixtures.approverPlatformUserId]: fixtures.approverPrincipalId,
    })

    await boltApp.dispatchAction(
      APPROVAL_ACTION_IDS.approve,
      buttonEnvelope(
        APPROVAL_ACTION_IDS.approve,
        { approvalId: approval.id, requiresTypedConfirmation: false },
        fixtures.approverPlatformUserId,
        'C1',
        '1700000000.000100',
      ),
    )

    // Independent read: this is the proof the click reached Postgres, not
    // merely that the adapter's own in-process return value said so.
    const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
    expect(stored?.status).toBe('approved')
    expect(stored?.selectedOption).toBe('approve')
    expect(stored?.resolvedByPrincipalId).toBe(fixtures.approverPrincipalId)

    expect(apiClient.updated).toHaveLength(1)
    expect(apiClient.updated[0]?.text).toContain('Approved')
  })

  it('an unauthorised principal clicking Approve is rejected: the row stays pending in Postgres and the card is untouched', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, approvalParams(fixtures, { requiresTypedConfirmation: false }))
    const bystanderPlatformUserId = `U_bystander_${randomUUID()}`
    const bystanderPrincipalId = await provisionPrincipal(
      pool,
      fixtures.workspaceId,
      'test',
      bystanderPlatformUserId,
      'Bystander',
      ['member'],
    )
    const { boltApp, apiClient } = await buildAdapter(fixtures.workspaceId, {
      [bystanderPlatformUserId]: bystanderPrincipalId,
    })

    await boltApp.dispatchAction(
      APPROVAL_ACTION_IDS.approve,
      buttonEnvelope(
        APPROVAL_ACTION_IDS.approve,
        { approvalId: approval.id, requiresTypedConfirmation: false },
        bystanderPlatformUserId,
        'C1',
        '1700000000.000100',
      ),
    )

    const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
    expect(stored?.status).toBe('pending')
    expect(apiClient.updated).toHaveLength(0)
  })

  it(
    'typed confirmation round trip through real Slack payloads: opens a modal, a wrong token leaves the row pending, ' +
      'the correct token approves it in Postgres',
    async () => {
      const fixtures = await createFixtures()
      const approval = await createApproval(pool, approvalParams(fixtures, { requiresTypedConfirmation: true }))
      const { boltApp, apiClient } = await buildAdapter(fixtures.workspaceId, {
        [fixtures.approverPlatformUserId]: fixtures.approverPrincipalId,
      })

      await boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.approve,
        buttonEnvelope(
          APPROVAL_ACTION_IDS.approve,
          { approvalId: approval.id, requiresTypedConfirmation: true },
          fixtures.approverPlatformUserId,
          'C1',
          '1700000000.000100',
        ),
      )
      expect(apiClient.openedModals).toHaveLength(1)
      expect((await getApproval(pool, fixtures.workspaceId, approval.id))?.status).toBe('pending')

      const wrongResponse = await boltApp.dispatchView(CONFIRM_MODAL_CALLBACK_ID, {
        view: {
          callback_id: CONFIRM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: approval.id, channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [CONFIRM_MODAL_BLOCK_ID]: { [CONFIRM_MODAL_ACTION_ID]: { value: 'nope' } } } },
        },
        user: { id: fixtures.approverPlatformUserId },
      })
      expect(wrongResponse?.response_action).toBe('errors')
      expect((await getApproval(pool, fixtures.workspaceId, approval.id))?.status).toBe('pending')

      await boltApp.dispatchView(CONFIRM_MODAL_CALLBACK_ID, {
        view: {
          callback_id: CONFIRM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({ approvalId: approval.id, channel: 'C1', messageTs: '1700000000.000100' }),
          state: { values: { [CONFIRM_MODAL_BLOCK_ID]: { [CONFIRM_MODAL_ACTION_ID]: { value: CONFIRMATION_TOKEN } } } },
        },
        user: { id: fixtures.approverPlatformUserId },
      })
      const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
      expect(stored?.status).toBe('approved')
    },
  )

  it('edit-and-approve modal submission stores the edited arguments in Postgres', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, approvalParams(fixtures, { requiresTypedConfirmation: false }))
    const { boltApp } = await buildAdapter(fixtures.workspaceId, {
      [fixtures.approverPlatformUserId]: fixtures.approverPrincipalId,
    })

    await boltApp.dispatchAction(
      APPROVAL_ACTION_IDS.editAndApprove,
      buttonEnvelope(APPROVAL_ACTION_IDS.editAndApprove, { approvalId: approval.id }, fixtures.approverPlatformUserId, 'C1', '1700000000.000100'),
    )

    await boltApp.dispatchView(EDIT_MODAL_CALLBACK_ID, {
      view: {
        callback_id: EDIT_MODAL_CALLBACK_ID,
        private_metadata: JSON.stringify({ approvalId: approval.id, channel: 'C1', messageTs: '1700000000.000100' }),
        state: {
          values: {
            [EDIT_MODAL_BLOCK_ID]: {
              [EDIT_MODAL_ACTION_ID]: { value: JSON.stringify({ command: 'rm -rf only-2024-exports' }) },
            },
          },
        },
      },
      user: { id: fixtures.approverPlatformUserId },
    })

    const stored = await getApproval(pool, fixtures.workspaceId, approval.id)
    expect(stored?.status).toBe('approved')
    expect(stored?.selectedOption).toBe('edit_and_approve')
    expect(stored?.editedArguments).toEqual({ command: 'rm -rf only-2024-exports' })
  })

  it('approve-all-of-this-type-for-this-session grants a session-scoped approval, observed via findActiveSessionGrant', async () => {
    const fixtures = await createFixtures()
    const approval = await createApproval(pool, approvalParams(fixtures, { requiresTypedConfirmation: false }))
    const { boltApp } = await buildAdapter(fixtures.workspaceId, {
      [fixtures.approverPlatformUserId]: fixtures.approverPrincipalId,
    })

    await boltApp.dispatchAction(
      APPROVAL_ACTION_IDS.approveAllSession,
      buttonEnvelope(
        APPROVAL_ACTION_IDS.approveAllSession,
        { approvalId: approval.id },
        fixtures.approverPlatformUserId,
        'C1',
        '1700000000.000100',
      ),
    )

    const grant = await findActiveSessionGrant(pool, fixtures.workspaceId, fixtures.sessionId, 'shell.exec')
    expect(grant).not.toBeNull()
    expect(grant?.grantedByPrincipalId).toBe(fixtures.approverPrincipalId)
  })

  it('three concurrent approvals, clicked through three concurrent Slack payloads, resolve to the correct three actions in Postgres', async () => {
    const fixtures = await createFixtures()
    const [toApprove, toDeny, toEdit] = await Promise.all([
      createApproval(pool, approvalParams(fixtures, { requiresTypedConfirmation: false, capability: 'fs.write' })),
      createApproval(pool, approvalParams(fixtures, { requiresTypedConfirmation: false, capability: 'api.call' })),
      // Must be the registered test capability ('shell.exec', the
      // approvalParams default): edit_and_approve validates the edited
      // input against a real inputSchema, so this is the one of the three
      // that needs it registered.
      createApproval(pool, approvalParams(fixtures, { requiresTypedConfirmation: false })),
    ])
    const { boltApp } = await buildAdapter(fixtures.workspaceId, {
      [fixtures.approverPlatformUserId]: fixtures.approverPrincipalId,
    })

    await Promise.all([
      boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.approve,
        buttonEnvelope(
          APPROVAL_ACTION_IDS.approve,
          { approvalId: toApprove.id, requiresTypedConfirmation: false },
          fixtures.approverPlatformUserId,
          'C1',
          '1700000001.000100',
        ),
      ),
      boltApp.dispatchAction(
        APPROVAL_ACTION_IDS.deny,
        buttonEnvelope(APPROVAL_ACTION_IDS.deny, { approvalId: toDeny.id }, fixtures.approverPlatformUserId, 'C1', '1700000002.000100'),
      ),
      (async () => {
        await boltApp.dispatchAction(
          APPROVAL_ACTION_IDS.editAndApprove,
          buttonEnvelope(APPROVAL_ACTION_IDS.editAndApprove, { approvalId: toEdit.id }, fixtures.approverPlatformUserId, 'C1', '1700000003.000100'),
        )
        await boltApp.dispatchView(EDIT_MODAL_CALLBACK_ID, {
          view: {
            callback_id: EDIT_MODAL_CALLBACK_ID,
            private_metadata: JSON.stringify({ approvalId: toEdit.id, channel: 'C1', messageTs: '1700000003.000100' }),
            state: {
              values: {
                [EDIT_MODAL_BLOCK_ID]: { [EDIT_MODAL_ACTION_ID]: { value: JSON.stringify({ command: 'revised' }) } },
              },
            },
          },
          user: { id: fixtures.approverPlatformUserId },
        })
      })(),
    ])

    expect((await getApproval(pool, fixtures.workspaceId, toApprove.id))?.status).toBe('approved')
    expect((await getApproval(pool, fixtures.workspaceId, toDeny.id))?.status).toBe('denied')
    const edited = await getApproval(pool, fixtures.workspaceId, toEdit.id)
    expect(edited?.status).toBe('approved')
    expect(edited?.selectedOption).toBe('edit_and_approve')
    expect(edited?.editedArguments).toEqual({ command: 'revised' })
  })
})
