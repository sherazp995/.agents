import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IntakeOutbox } from '../../../src/autonomous/store.js'
import type { ChatAction } from '../../../src/chat/contract.js'
import type { SlackBlockActionEnvelope } from '../../../src/chat/slack/adapter.js'
import {
  failCutOffProposals,
  handleProposalClick,
  postProposalCard,
  renderProposalCard,
  SUPERSEDED_CARD_TEXT,
  supersededCardCloser,
  TEAM_PROPOSAL_ACTION_IDS,
  type TeamProposalDecision,
} from '../../../src/chat/slack/team-proposal-card.js'
import { applyMigrations } from '../../../src/db/migrate.js'
import { closePool, createPool } from '../../../src/db/pool.js'
import { createPersona } from '../../../src/projects/persona-library.js'
import {
  approveProposal,
  existingPersonaIds,
  getProposal,
  markProposalFailed,
  markProposalReady,
  startProposal,
  teamFingerprint,
  type Proposal,
  type ProposedRow,
} from '../../../src/projects/proposals.js'
import { addMember, createProject, listMembers } from '../../../src/projects/store.js'
import { provisionPrincipal } from '../../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../../support/database.js'

const PERSONA = '11111111-1111-4111-8111-111111111111'

function proposal(rows: ProposedRow[]): Proposal {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    status: 'ready',
    source: 'slack',
    requestedBy: 'prn',
    slackChannel: 'C1',
    slackThread: '1.1',
    cardMessageTs: null,
    rows,
    fingerprint: 'f',
    applied: null,
    error: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date(),
  }
}

const hostile: ProposedRow = {
  kind: 'add',
  name: '<!channel> Eve',
  role: 'dev & ops',
  isLead: false,
  persona: { kind: 'existing', personaId: PERSONA },
  reason: 'see <http://x|y> and <@U123>',
}

describe('renderProposalCard', () => {
  const params = { projectName: '<!here> Web', uiPort: 7766, personaNames: new Map([[PERSONA, 'Dev <b>']]) }

  it('escapes every proposed text, so it cannot mention a channel or fake a link', () => {
    const card = renderProposalCard(proposal([hostile]), params)
    const all = JSON.stringify(card)
    for (const raw of ['<!channel>', '<!here>', '<http://x|y>', '<@U123>', '<b>']) expect(all).not.toContain(raw)
    expect(all).toContain('&lt;!channel&gt; Eve')
    expect(all).toContain('&lt;http://x|y&gt;')
    expect(all).toContain('dev &amp; ops')
    // Relay's own link stays a link, to the proposal's page.
    expect(all).toContain('<http://127.0.0.1:7766/projects/33333333-3333-4333-8333-333333333333/proposals/22222222-2222-4222-8222-222222222222|Open in page>')
  })

  it('offers Approve and Reject, carrying only the proposal id, when it reuses personas', () => {
    const actions = renderProposalCard(proposal([hostile]), params).blocks.find((block) => block.type === 'actions') as { elements: { action_id: string; value: string }[] } | undefined
    expect(actions?.elements.map((element) => [element.action_id, element.value])).toEqual([
      [TEAM_PROPOSAL_ACTION_IDS.approve, '22222222-2222-4222-8222-222222222222'],
      [TEAM_PROPOSAL_ACTION_IDS.reject, '22222222-2222-4222-8222-222222222222'],
    ])
  })

  it('hides Approve and sends the owner to the page when it writes a new persona', () => {
    const card = renderProposalCard(proposal([{ ...hostile, persona: { kind: 'new', name: 'Reviewer', text: '# Review' } }]), params)
    expect(card.blocks.some((block) => block.type === 'actions')).toBe(false)
    expect(JSON.stringify(card)).toContain('new persona: Reviewer')
    expect(JSON.stringify(card)).toContain('approve it in the page')
  })
})

describe('the proposal card in Slack', () => {
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

  /** Records what was queued; a post gets a fresh dispatch id, like the real outbox. */
  function fakeOutbox() {
    const sent: ChatAction[] = []
    const outbox: IntakeOutbox = {
      async enqueue(action: ChatAction, _workspaceId: string, _executor?: PoolClient) {
        sent.push(action)
        return action.kind === 'post' || action.kind === 'post_approval_card' ? randomUUID() : ''
      },
    }
    return { outbox, sent }
  }

  async function setup(rows: (persona: string) => ProposedRow[] = (persona) => [{ kind: 'add', name: 'Cy', role: 'developer', isLead: false, persona: { kind: 'existing', personaId: persona }, reason: 'more hands' }]) {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const dir = join(mkdtempSync(join(tmpdir(), 'relay-card-')), 'personas')
    const ownerSlack = `U_${randomUUID()}`
    const memberSlack = `U_${randomUUID()}`
    await provisionPrincipal(pool, workspaceId, 'slack', ownerSlack, 'Olive <@U1>', ['owner'])
    await provisionPrincipal(pool, workspaceId, 'slack', memberSlack, 'Max', ['member'])
    const client = await pool.connect()
    let projectId: string
    try {
      await client.query('BEGIN')
      projectId = await createProject(client, workspaceId, { name: 'Web', slackChannel: 'C_TEAM', folder: '/tmp', repos: [] })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const ctx = { pool, workspaceId, actor: 'prn_owner', dir, route: 'POST /test' }
    const lead = await createPersona(ctx, 'Lead', '# Lead')
    const add = (name: string, isLead: boolean) => inTx((c) => addMember(c, workspaceId, projectId, { name, role: 'x', personaId: lead, isLead }))
    await add('Ada', true)
    const proposed = rows(lead)
    const { id } = await inTx((c) => startProposal(c, workspaceId, { projectId, requestedBy: 'prn_owner', source: 'slack', slackChannel: 'C_TEAM', slackThread: '9.9' }))
    expect(await markProposalReady(pool, workspaceId, id, proposed, await teamFingerprint(pool, workspaceId, projectId, dir, existingPersonaIds(proposed)))).toBe(true)
    const { outbox, sent } = fakeOutbox()
    return { workspaceId, dir, projectId, id, ownerSlack, memberSlack, outbox, sent, lead }
  }

  async function inTx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } finally {
      client.release()
    }
  }

  /** What the outbox does once Slack answered the post: maps the card's dispatch id to the real message. */
  async function delivered(workspaceId: string, proposalId: string, messageTs: string): Promise<void> {
    const { rows } = await pool.query<{ card_dispatch_id: string }>('SELECT card_dispatch_id FROM team_proposals WHERE id = $1', [proposalId])
    await pool.query('INSERT INTO outbound_dispatch_refs (dispatch_id, workspace_id, ref, resolved_at) VALUES ($1, $2, $3, now())', [
      rows[0]?.card_dispatch_id,
      workspaceId,
      { channel: 'C_TEAM', thread: '9.9', message: messageTs },
    ])
  }

  const envelope = (user: string, proposalId: string, decision: TeamProposalDecision, at: { channel?: string; ts?: string } = {}): SlackBlockActionEnvelope => ({
    actions: [{ action_id: TEAM_PROPOSAL_ACTION_IDS[decision], type: 'button', value: proposalId }],
    user: { id: user },
    channel: { id: at.channel ?? 'C_TEAM' },
    message: { ts: at.ts ?? '5.5' },
  })

  it('closes a superseded card by editing it to plain text, which drops its buttons', async () => {
    const { outbox, sent } = fakeOutbox()
    await supersededCardCloser({ outbox })('ws', [{ proposalId: 'p1', channel: 'C_TEAM', dispatchId: 'dispatch-1' }])
    expect(sent).toEqual([{ kind: 'edit', ref: { channel: 'C_TEAM', message: 'dispatch-1' }, text: SUPERSEDED_CARD_TEXT, markdown: true }])
  })

  it('posts a ready proposal once, into its thread, and records the card', async () => {
    const s = await setup()
    const deps = { pool, workspaceId: s.workspaceId, outbox: s.outbox, uiPort: 7766 }
    expect(await postProposalCard(deps, s.id)).toBe(true)
    expect(await postProposalCard(deps, s.id)).toBe(false)
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toMatchObject({ kind: 'post_approval_card', ref: { channel: 'C_TEAM', thread: '9.9' } })
    const { rows } = await pool.query<{ card_dispatch_id: string | null }>('SELECT card_dispatch_id FROM team_proposals WHERE id = $1', [s.id])
    expect(rows[0]?.card_dispatch_id).toEqual(expect.any(String))
  })

  it('at startup fails a Slack proposal a restart cut off and tells its thread', async () => {
    const s = await setup()
    const cutOff = await inTx(async (c) => {
      await c.query("UPDATE team_proposals SET status = 'superseded' WHERE id = $1", [s.id])
      return (await startProposal(c, s.workspaceId, { projectId: s.projectId, requestedBy: 'prn_owner', source: 'slack', slackChannel: 'C_TEAM', slackThread: '9.9' })).id
    })
    await failCutOffProposals({ pool, workspaceId: s.workspaceId, outbox: s.outbox, uiPort: 7766 })
    expect((await getProposal(pool, s.workspaceId, cutOff))?.status).toBe('failed')
    expect(s.sent).toEqual([expect.objectContaining({ kind: 'post', ref: { channel: 'C_TEAM', thread: '9.9' }, text: expect.stringContaining('Relay restarted while proposing') })])
  })

  it('posts a failed proposal\'s reason, escaped, and nothing for a page proposal', async () => {
    const s = await setup()
    const failed = await inTx(async (c) => {
      await c.query("UPDATE team_proposals SET status = 'superseded' WHERE id = $1", [s.id])
      return (await startProposal(c, s.workspaceId, { projectId: s.projectId, requestedBy: 'prn_owner', source: 'slack', slackChannel: 'C_TEAM', slackThread: '9.9' })).id
    })
    await markProposalFailed(pool, s.workspaceId, failed, 'every login is out of credit <!channel>')
    const deps = { pool, workspaceId: s.workspaceId, outbox: s.outbox, uiPort: 7766 }
    expect(await postProposalCard(deps, failed)).toBe(true)
    expect(s.sent[0]).toMatchObject({ kind: 'post', text: expect.stringContaining('out of credit &lt;!channel&gt;') })
    const page = await inTx(async (c) => {
      await c.query("UPDATE team_proposals SET status = 'superseded' WHERE id = $1", [failed])
      return (await startProposal(c, s.workspaceId, { projectId: s.projectId, requestedBy: 'prn_owner', source: 'page' })).id
    })
    await markProposalFailed(pool, s.workspaceId, page, 'x')
    expect(await postProposalCard(deps, page)).toBe(false)
    expect(s.sent).toHaveLength(1)
  })

  it('counts a click only from an owner on the stored card, once, also against a page approve at the same time', async () => {
    const s = await setup()
    await postProposalCard({ pool, workspaceId: s.workspaceId, outbox: s.outbox, uiPort: 7766 }, s.id)
    await delivered(s.workspaceId, s.id, '5.5')
    const deps = { pool, workspaceId: s.workspaceId, personasDir: s.dir, outbox: s.outbox }

    expect(await handleProposalClick(deps, envelope(s.memberSlack, s.id, 'approve'), 'approve')).toBe('not-owner')
    expect(await handleProposalClick(deps, envelope(s.ownerSlack, s.id, 'approve', { ts: '6.6' }), 'approve')).toBe('not-this-card')
    expect(await handleProposalClick(deps, envelope(s.ownerSlack, s.id, 'approve', { channel: 'C_ELSE' }), 'approve')).toBe('not-this-card')
    expect((await getProposal(pool, s.workspaceId, s.id))?.status).toBe('ready')

    const page = approveProposal({ pool, workspaceId: s.workspaceId, proposalId: s.id, actor: 'prn_page', rows: (await getProposal(pool, s.workspaceId, s.id))?.rows ?? [], personasDir: s.dir, route: 'POST /page' })
    const clicks = await Promise.all([
      handleProposalClick(deps, envelope(s.ownerSlack, s.id, 'approve'), 'approve'),
      handleProposalClick(deps, envelope(s.ownerSlack, s.id, 'approve'), 'approve'),
      page.then(
        () => 'page',
        () => 'page refused',
      ),
    ])
    expect(clicks.filter((outcome) => outcome === 'applied' || outcome === 'page')).toHaveLength(1)
    expect((await listMembers(pool, s.workspaceId, s.projectId)).map((member) => member.name)).toEqual(['Ada', 'Cy'])
    expect((await getProposal(pool, s.workspaceId, s.id))?.cardMessageTs).toBe('5.5')
    // Only the winner edits the card; a losing click leaves it alone.
    const edits = s.sent.filter((action) => action.kind === 'edit')
    if (clicks.includes('applied')) expect(edits).toEqual([expect.objectContaining({ text: 'Team proposal applied by Olive U1.' })])
    else expect(edits).toEqual([])
    expect(await handleProposalClick(deps, envelope(s.ownerSlack, s.id, 'reject'), 'reject')).toBe('refused')
    expect((await getProposal(pool, s.workspaceId, s.id))?.status).toBe('approved')
  })

  it('rejects from the card and refuses Approve on a card for new personas', async () => {
    const s = await setup()
    await postProposalCard({ pool, workspaceId: s.workspaceId, outbox: s.outbox, uiPort: 7766 }, s.id)
    await delivered(s.workspaceId, s.id, '5.5')
    const deps = { pool, workspaceId: s.workspaceId, personasDir: s.dir, outbox: s.outbox }
    expect(await handleProposalClick(deps, envelope(s.ownerSlack, s.id, 'reject'), 'reject')).toBe('rejected')
    expect((await getProposal(pool, s.workspaceId, s.id))?.status).toBe('rejected')

    const n = await setup(() => [{ kind: 'add', name: 'Rex', role: 'reviewer', isLead: false, persona: { kind: 'new', name: 'Reviewer', text: '# Review' }, reason: '' }])
    await postProposalCard({ pool, workspaceId: n.workspaceId, outbox: n.outbox, uiPort: 7766 }, n.id)
    await delivered(n.workspaceId, n.id, '5.5')
    // A forged click on a card that never had the button.
    expect(await handleProposalClick({ ...deps, workspaceId: n.workspaceId, personasDir: n.dir, outbox: n.outbox }, envelope(n.ownerSlack, n.id, 'approve'), 'approve')).toBe('refused')
    expect((await getProposal(pool, n.workspaceId, n.id))?.status).toBe('ready')
    expect((await listMembers(pool, n.workspaceId, n.projectId)).map((member) => member.name)).toEqual(['Ada'])
  })
})
