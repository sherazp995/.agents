/**
 * The Slack card for a team proposal asked for in a project's channel (the
 * teams UI plan, step 8, decision 1 option A).
 *
 * Posting: once a Slack proposal settles, `postProposalCard` posts it into
 * its thread through the outbox, once per proposal (the row lock and the
 * stored card dispatch id make a second call a no-op). A ready proposal gets
 * its roster and reasons, an "Open in page" link, and Approve and Reject only
 * when it writes no new personas: new persona text is read in full in the
 * page first. A failed proposal gets its reason. Every proposed text is
 * escaped (& < >) so it cannot mention a channel or fake a link.
 *
 * Clicking: the button value is only the proposal id; the channel and the
 * message come from Slack's authenticated envelope and must be the card
 * stored on the proposal. Only a Slack user mapped to an owner of this
 * workspace counts. Approving goes through `approveProposal`, the same code
 * as the page, which takes the proposal from ready to approved once.
 */

import type { Pool } from 'pg'
import type { IntakeOutbox } from '../../autonomous/store.js'
import type { Logger } from '../../obs/logger.js'
import { approveProposal, failRunningProposals, getProposal, hasNewPersonas, recordProposalCard, rejectProposal, type Proposal, type ProposedRow, type SupersededCard } from '../../projects/proposals.js'
import { StoreConflict } from '../../projects/store.js'
import { isOwner } from '../../tenancy/roles.js'
import type { SlackBlockActionEnvelope } from './types.js'

export const TEAM_PROPOSAL_ACTION_IDS = { approve: 'team_proposal_approve', reject: 'team_proposal_reject' } as const
export type TeamProposalDecision = keyof typeof TEAM_PROPOSAL_ACTION_IDS

/** Slack rejects a section over 3000 characters. */
const SECTION_LIMIT = 3000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Slack mrkdwn's three control characters, escaped as Slack asks, so text cannot form `<!channel>`, `<@U..>` or `<url|label>`. */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** A name shown in a Markdown block edit: letters, digits, spaces and a little punctuation only, so it cannot form a link or a mention. */
function plainName(text: string): string {
  return text.replace(/[^\p{L}\p{N} .'_-]/gu, '').trim().slice(0, 80) || 'the owner'
}

function fit(text: string): string {
  return text.length > SECTION_LIMIT ? `${text.slice(0, SECTION_LIMIT - 20)}\n…(truncated)` : text
}

export function proposalPageUrl(uiPort: number, proposal: Pick<Proposal, 'id' | 'projectId'>): string {
  return `http://127.0.0.1:${uiPort}/projects/${proposal.projectId}/proposals/${proposal.id}`
}

const KIND_LABEL: Record<ProposedRow['kind'], string> = { add: 'Add', change: 'Change', keep: 'Keep', remove: 'Remove' }

/** One roster line; every proposed text is escaped. */
export function renderRow(row: ProposedRow, personaNames: ReadonlyMap<string, string>): string {
  const persona = row.persona.kind === 'new' ? `new persona: ${row.persona.name}` : (personaNames.get(row.persona.personaId) ?? 'a persona from the library')
  const lead = row.isLead ? ', lead' : ''
  const reason = row.reason === '' ? '' : `\n${row.reason}`
  return `*${KIND_LABEL[row.kind]}* ${escapeMrkdwn(row.name)} (${escapeMrkdwn(row.role)}${lead}), ${escapeMrkdwn(persona)}${escapeMrkdwn(reason)}`
}

export type ProposalCard = { readonly text: string; readonly blocks: Record<string, unknown>[] }

/** The card for a ready proposal. */
export function renderProposalCard(proposal: Proposal, params: { projectName: string; uiPort: number; personaNames: ReadonlyMap<string, string> }): ProposalCard {
  const link = `<${proposalPageUrl(params.uiPort, proposal)}|Open in page>`
  const title = `Relay proposes a team for *${escapeMrkdwn(params.projectName)}* (${proposal.rows.length} ${proposal.rows.length === 1 ? 'row' : 'rows'}).`
  const blocks: Record<string, unknown>[] = [{ type: 'section', text: { type: 'mrkdwn', text: fit(title) } }]
  for (const row of proposal.rows) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fit(renderRow(row, params.personaNames)) } })
  const newPersonas = hasNewPersonas(proposal.rows)
  const footer = newPersonas
    ? `This proposal writes new personas, so review their full text and approve it in the page: ${link}`
    : `Only the owner can approve. Approving applies every row above. ${link}`
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] })
  if (!newPersonas) {
    blocks.push({
      type: 'actions',
      block_id: `team_proposal_${proposal.id}`,
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: TEAM_PROPOSAL_ACTION_IDS.approve, value: proposal.id },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: TEAM_PROPOSAL_ACTION_IDS.reject, value: proposal.id },
      ],
    })
  }
  return { text: `Relay proposes a team for ${escapeMrkdwn(params.projectName)}. ${newPersonas ? 'Review and approve it in the page.' : 'Only the owner can approve.'}`, blocks }
}

export type ProposalCardDeps = {
  readonly pool: Pool
  readonly workspaceId: string
  readonly outbox: IntakeOutbox
  /** The setup page's port, for the "Open in page" link. */
  readonly uiPort: number
  readonly log?: Pick<Logger, 'warn' | 'error'>
}

/**
 * Posts a settled Slack proposal's card (ready) or its failure (failed)
 * into its thread, once: the proposal row is locked, and a proposal that
 * already has a card is left alone. Returns whether it posted.
 */
export async function postProposalCard(deps: ProposalCardDeps, proposalId: string): Promise<boolean> {
  const client = await deps.pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: locked } = await client.query<{ card_dispatch_id: string | null }>(
      'SELECT card_dispatch_id FROM team_proposals WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
      [deps.workspaceId, proposalId],
    )
    const proposal = await getProposal(client, deps.workspaceId, proposalId)
    const done = async (): Promise<false> => {
      await client.query('COMMIT')
      return false
    }
    if (locked[0] === undefined || locked[0].card_dispatch_id !== null || proposal === undefined) return await done()
    if (proposal.source !== 'slack' || proposal.slackChannel === null || proposal.slackThread === null) return await done()
    if (proposal.status !== 'ready' && proposal.status !== 'failed') return await done()

    const ref = { channel: proposal.slackChannel, thread: proposal.slackThread }
    let dispatchId: string
    if (proposal.status === 'failed') {
      const text = `Relay could not propose a team: ${escapeMrkdwn(proposal.error ?? 'no reason was recorded')} You can propose again here or in the setup page: <${proposalPageUrl(deps.uiPort, proposal)}|Open in page>`
      dispatchId = await deps.outbox.enqueue({ kind: 'post', ref, text }, deps.workspaceId, client)
    } else {
      const { rows: projects } = await client.query<{ name: string }>('SELECT name FROM projects WHERE workspace_id = $1 AND id = $2', [deps.workspaceId, proposal.projectId])
      const personaIds = proposal.rows.flatMap((row) => (row.persona.kind === 'existing' ? [row.persona.personaId] : []))
      const { rows: personas } = await client.query<{ id: string; name: string }>('SELECT id, name FROM personas WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [
        deps.workspaceId,
        personaIds,
      ])
      const card = renderProposalCard(proposal, {
        projectName: projects[0]?.name ?? 'this project',
        uiPort: deps.uiPort,
        personaNames: new Map(personas.map((persona) => [persona.id, persona.name])),
      })
      dispatchId = await deps.outbox.enqueue({ kind: 'post_approval_card', ref, text: card.text, blocks: card.blocks }, deps.workspaceId, client)
    }
    await recordProposalCard(client, deps.workspaceId, proposalId, { dispatchId })
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/**
 * For the proposer's `onSettled(proposal)`: posts the card of a settled
 * Slack proposal and logs, never throws, a failure to post.
 */
export function proposalCardPoster(deps: ProposalCardDeps): (proposal: Pick<Proposal, 'id' | 'source'>) => Promise<void> {
  return async (proposal) => {
    if (proposal.source !== 'slack') return
    try {
      await postProposalCard(deps, proposal.id)
    } catch (error) {
      deps.log?.error({ err: error, proposalId: proposal.id }, 'could not post the team proposal card')
    }
  }
}

/**
 * At daemon start: fails every proposal a restart cut off and posts each
 * Slack one's failure into its thread, so the asker hears back.
 */
export async function failCutOffProposals(deps: ProposalCardDeps): Promise<void> {
  const post = proposalCardPoster(deps)
  for (const proposal of await failRunningProposals(deps.pool, deps.workspaceId)) await post(proposal)
}

/**
 * For the proposer's `onSuperseded`: edits each superseded proposal's card
 * so its buttons go and it says a newer proposal replaced it.
 */
export function supersededCardCloser(deps: Pick<ProposalCardDeps, 'outbox' | 'log'>): (workspaceId: string, cards: readonly SupersededCard[]) => Promise<void> {
  return async (workspaceId, cards) => {
    for (const card of cards) {
      try {
        // A markdown edit replaces the card's blocks, so its buttons go too.
        await deps.outbox.enqueue({ kind: 'edit', ref: { channel: card.channel, message: card.dispatchId }, text: SUPERSEDED_CARD_TEXT, markdown: true }, workspaceId)
      } catch (error) {
        deps.log?.error({ err: error, proposalId: card.proposalId }, 'could not close a superseded team proposal card')
      }
    }
  }
}

export const SUPERSEDED_CARD_TEXT = 'A newer team proposal replaced this one; review that one instead.'

export type ProposalClickDeps = {
  readonly pool: Pool
  readonly workspaceId: string
  readonly personasDir: string
  readonly outbox: IntakeOutbox
  readonly log?: Pick<Logger, 'warn' | 'error'>
}

export type ProposalClickOutcome = 'ignored' | 'not-owner' | 'not-this-card' | 'applied' | 'rejected' | 'refused'

/**
 * One click on a card's Approve or Reject. Never throws: Bolt calls it, and
 * one bad click must not break the listener.
 */
export async function handleProposalClick(deps: ProposalClickDeps, envelope: SlackBlockActionEnvelope, decision: TeamProposalDecision): Promise<ProposalClickOutcome> {
  try {
    return await click(deps, envelope, decision)
  } catch (error) {
    deps.log?.error({ err: error, decision }, 'team proposal click failed')
    return 'ignored'
  }
}

async function click(deps: ProposalClickDeps, envelope: SlackBlockActionEnvelope, decision: TeamProposalDecision): Promise<ProposalClickOutcome> {
  const action = envelope.actions.find((candidate) => candidate.action_id === TEAM_PROPOSAL_ACTION_IDS[decision])
  const proposalId = action?.value ?? ''
  const channel = envelope.channel?.id
  const messageTs = envelope.message?.ts
  if (!UUID.test(proposalId) || channel === undefined || messageTs === undefined) return 'ignored'

  const proposal = await getProposal(deps.pool, deps.workspaceId, proposalId)
  if (proposal === undefined || proposal.slackChannel !== channel) return 'not-this-card'
  const card = await storedCard(deps, proposal, messageTs)
  if (card === undefined) return 'not-this-card'

  const { rows: principals } = await deps.pool.query<{ id: string; display_name: string; roles: string[] }>(
    "SELECT id, display_name, roles FROM principals WHERE workspace_id = $1 AND platform = 'slack' AND platform_user_id = $2",
    [deps.workspaceId, envelope.user.id],
  )
  const principal = principals[0]
  if (principal === undefined || !isOwner(principal.roles)) {
    await post(deps, proposal, 'Only the owner of this Relay can approve or reject a team proposal.')
    return 'not-owner'
  }

  const route = `slack ${TEAM_PROPOSAL_ACTION_IDS[decision]}`
  const name = plainName(principal.display_name)
  try {
    if (decision === 'approve') {
      await approveProposal({ pool: deps.pool, workspaceId: deps.workspaceId, proposalId, actor: principal.id, rows: proposal.rows, personasDir: deps.personasDir, route, card: { channel, messageTs } })
      await edit(deps, card.dispatchId, proposal, `Team proposal applied by ${name}.`)
      return 'applied'
    }
    await rejectProposal(deps.pool, { workspaceId: deps.workspaceId, proposalId, actor: principal.id, route, card: { channel, messageTs } })
    await edit(deps, card.dispatchId, proposal, `Team proposal rejected by ${name}.`)
    return 'rejected'
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error
    // A decided proposal keeps the card its decider wrote; anything else says why it cannot be applied.
    const now = await getProposal(deps.pool, deps.workspaceId, proposalId)
    if (now?.status !== 'approved' && now?.status !== 'rejected') await edit(deps, card.dispatchId, proposal, error.message)
    return 'refused'
  }
}

/**
 * The proposal's card, when the clicked message is it: the stored message
 * ts, or (the first click) the ts the outbox recorded for the card's
 * dispatch id, which is then stored on the proposal.
 */
async function storedCard(deps: ProposalClickDeps, proposal: Proposal, messageTs: string): Promise<{ dispatchId: string } | undefined> {
  const { rows } = await deps.pool.query<{ card_dispatch_id: string | null; posted: { message?: string; channel?: string } | null }>(
    `SELECT p.card_dispatch_id, r.ref AS posted FROM team_proposals p
     LEFT JOIN outbound_dispatch_refs r ON r.dispatch_id::text = p.card_dispatch_id AND r.workspace_id = p.workspace_id
     WHERE p.workspace_id = $1 AND p.id = $2`,
    [deps.workspaceId, proposal.id],
  )
  const dispatchId = rows[0]?.card_dispatch_id ?? null
  if (dispatchId === null) return undefined
  const stored = proposal.cardMessageTs ?? rows[0]?.posted?.message ?? null
  if (stored !== messageTs) return undefined
  if (proposal.cardMessageTs === null) await recordProposalCard(deps.pool, deps.workspaceId, proposal.id, { dispatchId, messageTs })
  return { dispatchId }
}

async function edit(deps: ProposalClickDeps, dispatchId: string, proposal: Proposal, text: string): Promise<void> {
  if (proposal.slackChannel === null) return
  // A markdown edit replaces the card's blocks, so its buttons go too.
  await deps.outbox.enqueue({ kind: 'edit', ref: { channel: proposal.slackChannel, message: dispatchId }, text, markdown: true }, deps.workspaceId)
}

async function post(deps: ProposalClickDeps, proposal: Proposal, text: string): Promise<void> {
  if (proposal.slackChannel === null || proposal.slackThread === null) return
  await deps.outbox.enqueue({ kind: 'post', ref: { channel: proposal.slackChannel, thread: proposal.slackThread }, text }, deps.workspaceId)
}
