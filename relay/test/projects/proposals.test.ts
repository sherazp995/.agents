import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OUTSIDE_A_TURN, runTeamPropose } from '../../src/cli/team.js'
import { TEAM_PROPOSAL_PATH, teamProposalRoute } from '../../src/autonomous/team-proposal-route.js'
import { acquireLease, intakeMention, releaseLease } from '../../src/autonomous/store.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { HookBridgeServer } from '../../src/engine/hook-bridge.js'
import { createPersona, editPersona, type LibraryContext } from '../../src/projects/persona-library.js'
import {
  approveProposal,
  existingPersonaIds,
  failRunningProposals,
  getProposal,
  markProposalReady,
  recordProposalCard,
  rejectProposal,
  startProposal,
  teamFingerprint,
  type ProposedRow,
  type StartProposal,
  type TeamProposer,
} from '../../src/projects/proposals.js'
import { addMember, createProject, getProject, listMembers, updateMember, updateProject } from '../../src/projects/store.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

let pool: Pool

beforeAll(async () => {
  const databaseUrl = await getTestDatabaseUrl()
  if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
  pool = createPool(databaseUrl)
  await applyMigrations(pool, 'src/db/migrations')
})

afterAll(async () => {
  await closePool(pool)
})

async function inTx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function workspace() {
  const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
  const dir = join(mkdtempSync(join(tmpdir(), 'relay-proposals-')), 'personas')
  const ctx: LibraryContext = { pool, workspaceId, actor: 'prn_owner', dir, route: 'POST /test' }
  return { workspaceId, dir, ctx }
}

const newProject = (workspaceId: string, channel: string, name = 'Web') =>
  inTx((client) => createProject(client, workspaceId, { name, slackChannel: channel, folder: '/tmp', repos: ['web'] }))

describe('the team proposal bridge route', () => {
  let bridge: HookBridgeServer | undefined

  afterEach(async () => {
    await bridge?.stop()
    bridge = undefined
  })

  function fakeProposer() {
    const calls: { workspaceId: string; request: StartProposal }[] = []
    const proposer: TeamProposer = {
      async propose(workspaceId, request) {
        calls.push({ workspaceId, request })
        return 'p-1'
      },
      async stop() {},
    }
    return { proposer, calls }
  }

  async function setup(options: { requesterRoles?: string[]; channel?: string } = {}) {
    const { workspaceId } = await workspace()
    const owner = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Owner', options.requesterRoles ?? ['owner'])
    const other = await newProject(workspaceId, 'C_OTHER', 'Other')
    const web = await newProject(workspaceId, 'C_WEB', 'Web')
    const channel = options.channel ?? 'C_WEB'
    const ts = `${Date.now()}.0001`
    const result = await intakeMention(pool, {
      workspaceId,
      principalId: owner,
      adapter: 'slack',
      threadRef: `${channel}:${ts}`,
      event: { id: `${channel}:${randomUUID()}`, principalId: owner, text: 'propose a team', ref: { channel, message: ts }, fileIds: [], receivedAt: new Date().toISOString() },
      replyRef: { channel, thread: ts },
      files: [],
    })
    if (result.kind !== 'created') throw new Error('expected a new task')
    const lease = await acquireLease(pool, result.task.id, 'test', 60_000)
    if (!lease) throw new Error('expected a lease')
    const { proposer, calls } = fakeProposer()
    bridge = new HookBridgeServer({
      decide: async () => ({ decision: 'allow', reason: 'ok' }),
      routes: { [TEAM_PROPOSAL_PATH]: teamProposalRoute({ pool, workspaceId, teamProposer: proposer }) },
    })
    await bridge.start()
    const context = { workspaceId, taskId: result.task.id, runId: randomUUID(), leaseGeneration: lease.generation }
    return { workspaceId, owner, web, other, lease, calls, context, ts, bridge }
  }

  async function ask(server: HookBridgeServer, token: string) {
    const response = await fetch(new URL(TEAM_PROPOSAL_PATH, server.url), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })
    return { status: response.status, body: (await response.json()) as { ok: boolean; message: string } }
  }

  it("proposes for the turn's own channel's project, asked by its owner", async () => {
    const { workspaceId, owner, web, calls, context, ts, bridge: server } = await setup()
    const answer = await ask(server, server.issueToken(context))
    expect(answer).toMatchObject({ status: 202, body: { ok: true, message: expect.stringContaining('Web') } })
    expect(calls).toEqual([{ workspaceId, request: { projectId: web, requestedBy: owner, source: 'slack', slackChannel: 'C_WEB', slackThread: ts } }])
  })

  it('is what relay team propose calls, with the turn\'s environment; outside a turn it says where it works', async () => {
    const { calls, context, bridge: server } = await setup()
    const env = { RELAY_HOOK_URL: server.url, RELAY_HOOK_TOKEN: server.issueToken(context) }
    expect(await runTeamPropose(env)).toMatchObject({ exitCode: 0, message: expect.stringContaining('Relay is proposing a team for Web') })
    expect(await runTeamPropose({ ...env, RELAY_HOOK_TOKEN: server.token })).toMatchObject({ exitCode: 1, message: 'This only works from a live Relay turn.' })
    expect(await runTeamPropose({})).toEqual({ exitCode: 1, message: OUTSIDE_A_TURN })
    expect(await runTeamPropose({ ...env, RELAY_HOOK_URL: 'http://example.com/pre-tool-use' })).toEqual({ exitCode: 1, message: OUTSIDE_A_TURN })
    expect(calls).toHaveLength(1)
  })

  it('refuses the instance token and a probe token', async () => {
    const { calls, bridge: server } = await setup()
    expect((await ask(server, server.token)).status).toBe(403)
    const probe = server.issueToken({ workspaceId: 'probe', taskId: 'probe', runId: 'probe', leaseGeneration: 0 })
    expect(await ask(server, probe)).toMatchObject({ status: 403, body: { ok: false } })
    expect(calls).toEqual([])
  })

  it("refuses a team member's token, even while the lead's lease is live", async () => {
    const { calls, context, bridge: server } = await setup()
    const member = server.issueToken({ ...context, assignment: { id: randomUUID(), leaseGeneration: 1 } })
    expect(await ask(server, member)).toMatchObject({ status: 403, body: { ok: false, message: 'Team members cannot ask for a team proposal.' } })
    expect(calls).toEqual([])
  })

  it('refuses a finished turn and a stopped task', async () => {
    const { calls, context, lease, bridge: server } = await setup()
    const token = server.issueToken(context)
    await releaseLease(pool, lease)
    expect(await ask(server, token)).toMatchObject({ status: 403, body: { message: expect.stringContaining('finished') } })
    const stale = server.issueToken({ ...context, leaseGeneration: context.leaseGeneration - 1 })
    expect((await ask(server, stale)).status).toBe(403)
    await pool.query('UPDATE autonomous_tasks SET cancel_requested_at = now() WHERE id = $1', [context.taskId])
    expect(await ask(server, token)).toMatchObject({ status: 403, body: { message: expect.stringContaining('stopped') } })
    expect(calls).toEqual([])
  })

  it('refuses a requester who is not an owner, and a channel that is not a project', async () => {
    const member = await setup({ requesterRoles: ['member'] })
    expect(await ask(member.bridge, member.bridge.issueToken(member.context))).toMatchObject({ status: 403, body: { message: expect.stringContaining('Only the owner') } })
    expect(member.calls).toEqual([])
    await member.bridge.stop()

    const elsewhere = await setup({ channel: 'C_RANDOM' })
    bridge = elsewhere.bridge
    expect(await ask(elsewhere.bridge, elsewhere.bridge.issueToken(elsewhere.context))).toMatchObject({ status: 409, body: { message: expect.stringContaining("not a project's channel") } })
    expect(elsewhere.calls).toEqual([])
  })
})

describe('approving a proposal', () => {
  async function team() {
    const { workspaceId, dir, ctx } = await workspace()
    const projectId = await newProject(workspaceId, `C_${randomUUID()}`)
    const lead = await createPersona(ctx, 'Lead', '# Lead')
    const dev = await createPersona(ctx, 'Developer', '# Dev')
    const ada = await inTx((client) => addMember(client, workspaceId, projectId, { name: 'Ada', role: 'lead', personaId: lead, isLead: true }))
    const bob = await inTx((client) => addMember(client, workspaceId, projectId, { name: 'Bob', role: 'developer', personaId: dev, isLead: false }))
    return { workspaceId, dir, ctx, projectId, lead, dev, ada, bob }
  }

  async function ready(workspaceId: string, projectId: string, dir: string, rows: ProposedRow[], slack?: { channel: string; thread: string }): Promise<string> {
    const { id } = await inTx((client) =>
      startProposal(client, workspaceId, { projectId, requestedBy: 'prn_owner', ...(slack ? { source: 'slack', slackChannel: slack.channel, slackThread: slack.thread } : { source: 'page' }) }),
    )
    const fingerprint = await teamFingerprint(pool, workspaceId, projectId, dir, existingPersonaIds(rows))
    expect(await markProposalReady(pool, workspaceId, id, rows, fingerprint)).toBe(true)
    return id
  }

  const approve = (t: { workspaceId: string; dir: string }, proposalId: string, rows: readonly ProposedRow[], extra: { route?: string; card?: { channel: string; messageTs: string } } = {}) =>
    approveProposal({ pool, workspaceId: t.workspaceId, proposalId, actor: 'prn_owner', rows, personasDir: t.dir, route: extra.route ?? 'POST /test', ...(extra.card ? { card: extra.card } : {}) })

  const roster = async (workspaceId: string, projectId: string) => (await listMembers(pool, workspaceId, projectId)).map((member) => [member.name, member.role, member.isLead])

  const auditCount = async (workspaceId: string, proposalId: string) =>
    Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_entries WHERE workspace_id = $1 AND detail->>'proposalId' = $2", [workspaceId, proposalId])).rows[0]?.n)

  it('applies exactly the ticked and edited rows, removals and lead changes first, with one audit entry', async () => {
    const t = await team()
    const rows: ProposedRow[] = [
      { kind: 'remove', memberId: t.ada, name: 'Ada', role: 'lead', isLead: true, persona: { kind: 'existing', personaId: t.lead }, reason: 'leaving' },
      { kind: 'add', name: 'Cy', role: 'lead', isLead: true, persona: { kind: 'existing', personaId: t.lead }, reason: 'new lead' },
      { kind: 'change', memberId: t.bob, name: 'Bob', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: 'rename' },
      { kind: 'add', name: 'Dee', role: 'tester', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: 'tests' },
    ]
    const id = await ready(t.workspaceId, t.projectId, t.dir, rows)
    // Dee is unticked; Bob's row was edited in the form.
    const ticked = [rows[0], rows[1], { ...rows[2], name: 'Bea', role: 'senior developer' }].filter((row): row is ProposedRow => row !== undefined)
    const result = await approve(t, id, ticked)

    expect(result.filesNotSaved).toEqual([])
    expect(await roster(t.workspaceId, t.projectId)).toEqual([
      ['Cy', 'lead', true],
      ['Bea', 'senior developer', false],
    ])
    expect((await getProposal(pool, t.workspaceId, id))?.status).toBe('approved')
    expect(await auditCount(t.workspaceId, id)).toBe(1)
  })

  it('refuses when a member, a repo or a persona text changed since it was proposed', async () => {
    const rowsFor = (t: Awaited<ReturnType<typeof team>>): ProposedRow[] => [
      { kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' },
    ]
    const member = await team()
    const memberProposal = await ready(member.workspaceId, member.projectId, member.dir, rowsFor(member))
    await inTx((client) => addMember(client, member.workspaceId, member.projectId, { name: 'Hand', role: 'x', personaId: member.dev, isLead: false }))
    await expect(approve(member, memberProposal, rowsFor(member))).rejects.toThrow('The team changed')

    const repo = await team()
    const repoProposal = await ready(repo.workspaceId, repo.projectId, repo.dir, rowsFor(repo))
    const project = await getProject(pool, repo.workspaceId, repo.projectId)
    if (project === undefined) throw new Error('expected the project')
    await inTx((client) => updateProject(client, repo.workspaceId, repo.projectId, { ...project, repos: ['web', 'api'] }))
    await expect(approve(repo, repoProposal, rowsFor(repo))).rejects.toThrow('The team changed')

    const persona = await team()
    const personaProposal = await ready(persona.workspaceId, persona.projectId, persona.dir, rowsFor(persona))
    await editPersona(persona.ctx, persona.dev, 'Developer', '# Dev, edited')
    await expect(approve(persona, personaProposal, rowsFor(persona))).rejects.toThrow('The team changed')

    expect((await getProposal(pool, persona.workspaceId, personaProposal))?.status).toBe('ready')
  })

  it("goes stale when a member's client or model changes, and gives approved new members Claude while changed ones keep theirs", async () => {
    const rowsFor = (t: Awaited<ReturnType<typeof team>>): ProposedRow[] => [
      { kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' },
      { kind: 'change', memberId: t.bob, name: 'Bob', role: 'senior developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' },
    ]
    const bobInput = (t: Awaited<ReturnType<typeof team>>) => ({ name: 'Bob', role: 'developer', personaId: t.dev, isLead: false })
    const runsOn = async (t: Awaited<ReturnType<typeof team>>) => (await listMembers(pool, t.workspaceId, t.projectId)).map((member) => [member.name, member.client, member.model])

    for (const change of [{ client: 'codex' as const }, { model: 'opus' }]) {
      const stale = await team()
      const proposal = await ready(stale.workspaceId, stale.projectId, stale.dir, rowsFor(stale))
      await inTx((client) => updateMember(client, stale.workspaceId, stale.projectId, stale.bob, { ...bobInput(stale), ...change }))
      await expect(approve(stale, proposal, rowsFor(stale))).rejects.toThrow('The team changed')
    }

    const t = await team()
    await inTx((client) => updateMember(client, t.workspaceId, t.projectId, t.bob, { ...bobInput(t), client: 'codex', model: 'o4' }))
    const id = await ready(t.workspaceId, t.projectId, t.dir, rowsFor(t))
    await approve(t, id, rowsFor(t))
    expect(await runsOn(t)).toEqual([
      ['Ada', 'claude', null],
      ['Bob', 'codex', 'o4'],
      ['Cy', 'claude', null],
    ])
  })

  it('refuses a result with two leads or none', async () => {
    const t = await team()
    const twoLeads: ProposedRow[] = [{ kind: 'add', name: 'Cy', role: 'lead', isLead: true, persona: { kind: 'existing', personaId: t.lead }, reason: '' }]
    const noLead: ProposedRow[] = [{ kind: 'remove', memberId: t.ada, name: 'Ada', role: 'lead', isLead: true, persona: { kind: 'existing', personaId: t.lead }, reason: '' }]
    const id = await ready(t.workspaceId, t.projectId, t.dir, [...twoLeads, ...noLead])
    // Ada stays lead when only the add is ticked; nobody leads when only the removal is.
    await expect(approve(t, id, twoLeads)).rejects.toThrow('more than one lead')
    await expect(approve(t, id, noLead)).rejects.toThrow('no lead')
    expect(await roster(t.workspaceId, t.projectId)).toEqual([
      ['Ada', 'lead', true],
      ['Bob', 'developer', false],
    ])
    expect((await getProposal(pool, t.workspaceId, id))?.status).toBe('ready')
  })

  it('rolls the whole approval back when its audit entry fails', async () => {
    const t = await team()
    const route = `POST /audit-fails-${randomUUID()}`
    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_proposal_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.detail->>'route' LIKE 'POST /audit-fails-%' THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$`)
    await pool.query('DROP TRIGGER IF EXISTS test_fail_proposal_audit ON audit_entries')
    await pool.query('CREATE TRIGGER test_fail_proposal_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION test_fail_proposal_audit()')
    try {
      const rows: ProposedRow[] = [{ kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' }]
      const id = await ready(t.workspaceId, t.projectId, t.dir, rows)
      await expect(approve(t, id, rows, { route })).rejects.toThrow('audit refused')
      expect(await roster(t.workspaceId, t.projectId)).toEqual([
        ['Ada', 'lead', true],
        ['Bob', 'developer', false],
      ])
      expect((await getProposal(pool, t.workspaceId, id))?.status).toBe('ready')
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_fail_proposal_audit ON audit_entries')
      await pool.query('DROP FUNCTION IF EXISTS test_fail_proposal_audit()')
    }
  })

  it('waits for a hand edit on another connection, then refuses the stale base', async () => {
    const t = await team()
    const rows: ProposedRow[] = [{ kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' }]
    const id = await ready(t.workspaceId, t.projectId, t.dir, rows)
    const hand = await pool.connect()
    try {
      await hand.query('BEGIN')
      await addMember(hand, t.workspaceId, t.projectId, { name: 'Hand', role: 'x', personaId: t.dev, isLead: false })
      let settled = false
      const approval = approve(t, id, rows).finally(() => {
        settled = true
      })
      approval.catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(settled).toBe(false)
      await hand.query('COMMIT')
      await expect(approval).rejects.toThrow('The team changed')
    } finally {
      hand.release()
    }
    expect((await roster(t.workspaceId, t.projectId)).map(([name]) => name)).toEqual(['Ada', 'Bob', 'Hand'])
  })

  it('applies a page approve and a Slack approve at once exactly once', async () => {
    const t = await team()
    const rows: ProposedRow[] = [{ kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' }]
    const id = await ready(t.workspaceId, t.projectId, t.dir, rows, { channel: 'C_TEAM', thread: '1.1' })
    await recordProposalCard(pool, t.workspaceId, id, { dispatchId: randomUUID(), messageTs: '2.2' })
    const outcomes = await Promise.allSettled([approve(t, id, rows), approve(t, id, rows, { card: { channel: 'C_TEAM', messageTs: '2.2' } })])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const refused = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    expect(String(refused?.reason)).toContain('already decided')
    expect((await roster(t.workspaceId, t.projectId)).map(([name]) => name)).toEqual(['Ada', 'Bob', 'Cy'])
    expect(await auditCount(t.workspaceId, id)).toBe(1)
  })

  it('fails, at startup, a proposal still running from before a restart', async () => {
    const t = await team()
    const { id } = await inTx((client) => startProposal(client, t.workspaceId, { projectId: t.projectId, requestedBy: 'prn_owner', source: 'page' }))
    expect(await failRunningProposals(pool, t.workspaceId)).toEqual([{ id, source: 'page' }])
    const stored = await getProposal(pool, t.workspaceId, id)
    expect([stored?.status, stored?.error]).toEqual(['failed', 'Relay restarted while proposing; propose again.'])
  })

  it('names the status when a proposal that is no longer ready is rejected', async () => {
    const t = await team()
    const rows: ProposedRow[] = [{ kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' }]
    const older = await ready(t.workspaceId, t.projectId, t.dir, rows)
    await ready(t.workspaceId, t.projectId, t.dir, rows)
    await expect(rejectProposal(pool, { workspaceId: t.workspaceId, proposalId: older, actor: 'prn_owner', route: 'POST /test' })).rejects.toThrow('This proposal is superseded; it can no longer be rejected.')
  })

  it('hands the lead to a new member in one approval', async () => {
    const t = await team()
    const rows: ProposedRow[] = [
      { kind: 'change', memberId: t.ada, name: 'Ada', role: 'lead', isLead: false, persona: { kind: 'existing', personaId: t.lead }, reason: '' },
      { kind: 'add', name: 'Cy', role: 'lead', isLead: true, persona: { kind: 'existing', personaId: t.lead }, reason: '' },
    ]
    const id = await ready(t.workspaceId, t.projectId, t.dir, rows)
    await approve(t, id, rows)
    expect(await roster(t.workspaceId, t.projectId)).toEqual([
      ['Cy', 'lead', true],
      ['Ada', 'lead', false],
      ['Bob', 'developer', false],
    ])
  })

  it('names what decided a proposal when an approve wins the race with a reject', async () => {
    const t = await team()
    const rows: ProposedRow[] = [{ kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' }]
    const id = await ready(t.workspaceId, t.projectId, t.dir, rows)
    const other = await pool.connect()
    try {
      await other.query('BEGIN')
      await other.query("UPDATE team_proposals SET status = 'approved' WHERE id = $1", [id])
      const rejection = rejectProposal(pool, { workspaceId: t.workspaceId, proposalId: id, actor: 'prn_owner', route: 'POST /test' })
      rejection.catch(() => undefined)
      // The reject reads the proposal as ready, then its update waits for this transaction.
      await new Promise((resolve) => setTimeout(resolve, 300))
      await other.query('COMMIT')
      await expect(rejection).rejects.toThrow('This proposal was already decided.')
    } finally {
      other.release()
    }
  })

  it('refuses a Slack approve from any message but the stored card', async () => {
    const t = await team()
    const rows: ProposedRow[] = [{ kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' }]
    const id = await ready(t.workspaceId, t.projectId, t.dir, rows, { channel: 'C_TEAM', thread: '1.1' })
    await recordProposalCard(pool, t.workspaceId, id, { dispatchId: randomUUID(), messageTs: '2.2' })
    await expect(approve(t, id, rows, { card: { channel: 'C_TEAM', messageTs: '3.3' } })).rejects.toThrow("not on this proposal's card")
    await expect(approve(t, id, rows, { card: { channel: 'C_OTHER', messageTs: '2.2' } })).rejects.toThrow("not on this proposal's card")
    expect((await getProposal(pool, t.workspaceId, id))?.status).toBe('ready')
  })

  it('lets the database refuse a second running proposal, and supersedes an older ready one', async () => {
    const t = await team()
    const rows: ProposedRow[] = [{ kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: t.dev }, reason: '' }]
    const older = await ready(t.workspaceId, t.projectId, t.dir, rows, { channel: 'C_TEAM', thread: '1.1' })
    await recordProposalCard(pool, t.workspaceId, older, { dispatchId: 'dispatch-older' })
    const { id: running, supersededCards } = await inTx((client) => startProposal(client, t.workspaceId, { projectId: t.projectId, requestedBy: 'prn_owner', source: 'page' }))
    expect((await getProposal(pool, t.workspaceId, older))?.status).toBe('superseded')
    // The older card is handed back so its buttons can be closed.
    expect(supersededCards).toEqual([{ proposalId: older, channel: 'C_TEAM', dispatchId: 'dispatch-older' }])
    await expect(inTx((client) => startProposal(client, t.workspaceId, { projectId: t.projectId, requestedBy: 'prn_owner', source: 'page' }))).rejects.toThrow('already proposing')
    // The database itself holds the line, not only startProposal.
    await expect(pool.query("INSERT INTO team_proposals (workspace_id, project_id, requested_by, source) VALUES ($1, $2, 'x', 'page')", [t.workspaceId, t.projectId])).rejects.toMatchObject({ code: '23505' })
    expect((await getProposal(pool, t.workspaceId, running))?.status).toBe('running')
    await expect(approve(t, older, rows)).rejects.toThrow('superseded')
  })
})
