/**
 * Teams Relay proposes and an owner approves (the teams UI plan, steps 5, 7
 * and 8). A proposal is a list of rows checked against the team as it was
 * when proposed; nothing reaches the team until an owner approves, in the
 * page or on the proposal's own Slack card, through `approveProposal` here.
 *
 * An approval is one transaction: it locks the team (the same lock every
 * member write takes), recomputes the fingerprint and refuses when the team,
 * the project's folder or repos, or a persona's text changed; it moves the
 * proposal from ready to approved exactly once; it checks the result has one
 * lead; it applies removals and lead changes before additions (the one-lead
 * index is not deferrable); and it writes one audit entry. New persona files
 * are written around that commit by savePersonaFiles, and the applied
 * snapshot keeps their text so a file that failed can be recreated.
 */

import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { appendAuditEntryInTransaction } from '../audit/store.js'
import { scrubSecrets } from '../secrets/scrubber.js'
import { UI_AUDIT_KIND } from '../ui/audit.js'
import { newPersonaFileName, readPersona, savePersonaFiles, type FileOps, type PersonaFileFailure } from './persona-files.js'
import { ensureTeam, getProject, listMembers, StoreConflict, type TeamMember } from './store.js'

type Db = Pool | PoolClient

export const MAX_PROPOSED_MEMBERS = 12
export const MAX_PERSONA_TEXT_BYTES = 8 * 1024
const MAX_FIELD = 120
const MAX_REASON = 300

export const PROPOSAL_STATUSES = ['running', 'ready', 'failed', 'approved', 'rejected', 'superseded'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

const field = z.string().trim().min(1).max(MAX_FIELD)

const personaChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), personaId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('new'),
      name: field,
      text: z.string().trim().min(1).refine((text) => Buffer.byteLength(text, 'utf8') <= MAX_PERSONA_TEXT_BYTES, `persona text is over ${MAX_PERSONA_TEXT_BYTES} bytes`),
    })
    .strict(),
])

const proposedRow = z
  .object({
    kind: z.enum(['add', 'change', 'keep', 'remove']),
    /** The existing member a change, keep or remove is about; absent for add. */
    memberId: z.string().uuid().optional(),
    name: field,
    role: field,
    isLead: z.boolean(),
    persona: personaChoice,
    reason: z.string().trim().max(MAX_REASON).default(''),
  })
  .strict()
  .refine((row) => (row.kind === 'add') === (row.memberId === undefined), 'an add has no member id; a change, keep or remove names one')

export type ProposedRow = z.infer<typeof proposedRow>
export type PersonaChoice = z.infer<typeof personaChoice>

const proposedRows = z
  .array(proposedRow)
  .min(1)
  .max(MAX_PROPOSED_MEMBERS)
  .refine((rows) => {
    const memberIds = rows.flatMap((row) => (row.memberId === undefined ? [] : [row.memberId]))
    return new Set(memberIds).size === memberIds.length
  }, 'each existing member may appear in only one row')

/** Checks rows (from a proposer's JSON or a review form) and scrubs every text field; throws a readable message. */
export function checkProposalRows(input: unknown): ProposedRow[] {
  const parsed = proposedRows.safeParse(input)
  if (!parsed.success) throw new StoreConflict(`The proposal is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'rows'}: ${issue.message}`).join('; ')}`)
  return parsed.data.map((row) => ({
    ...row,
    name: scrubSecrets(row.name),
    role: scrubSecrets(row.role),
    reason: scrubSecrets(row.reason),
    persona: row.persona.kind === 'new' ? { ...row.persona, name: scrubSecrets(row.persona.name), text: scrubSecrets(row.persona.text) } : row.persona,
  }))
}

export type Proposal = {
  readonly id: string
  readonly projectId: string
  readonly status: ProposalStatus
  readonly source: 'page' | 'slack'
  readonly requestedBy: string
  readonly slackChannel: string | null
  readonly slackThread: string | null
  readonly cardMessageTs: string | null
  readonly rows: readonly ProposedRow[]
  readonly fingerprint: string | null
  readonly applied: AppliedSnapshot | null
  readonly error: string | null
  readonly decidedBy: string | null
  readonly decidedAt: Date | null
  readonly decisionNote: string | null
  readonly createdAt: Date
}

export type AppliedSnapshot = { readonly rows: readonly ProposedRow[]; readonly newPersonas: readonly { personaId: string; name: string; fileName: string; text: string }[] }

type ProposalRow = {
  id: string
  project_id: string
  status: ProposalStatus
  source: 'page' | 'slack'
  requested_by: string
  slack_channel: string | null
  slack_thread: string | null
  card_message_ts: string | null
  rows: ProposedRow[] | null
  fingerprint: string | null
  applied: AppliedSnapshot | null
  error: string | null
  decided_by: string | null
  decided_at: Date | null
  decision_note: string | null
  created_at: Date
}

const SELECT = `SELECT id, project_id, status, source, requested_by, slack_channel, slack_thread, card_message_ts, rows, fingerprint, applied, error,
  decided_by, decided_at, decision_note, created_at FROM team_proposals`

function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    source: row.source,
    requestedBy: row.requested_by,
    slackChannel: row.slack_channel,
    slackThread: row.slack_thread,
    cardMessageTs: row.card_message_ts,
    rows: row.rows ?? [],
    fingerprint: row.fingerprint,
    applied: row.applied,
    error: row.error,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
  }
}

export async function getProposal(db: Db, workspaceId: string, proposalId: string): Promise<Proposal | undefined> {
  const { rows } = await db.query<ProposalRow>(`${SELECT} WHERE workspace_id = $1 AND id = $2`, [workspaceId, proposalId])
  const row = rows[0]
  return row === undefined ? undefined : toProposal(row)
}

/** The project's newest proposal, whatever its status. */
export async function latestProposal(db: Db, workspaceId: string, projectId: string): Promise<Proposal | undefined> {
  const { rows } = await db.query<ProposalRow>(`${SELECT} WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at DESC, id LIMIT 1`, [workspaceId, projectId])
  const row = rows[0]
  return row === undefined ? undefined : toProposal(row)
}

/** Per project: the status of its newest proposal, for the projects table. */
export async function latestProposalStatuses(db: Db, workspaceId: string): Promise<Map<string, ProposalStatus>> {
  const { rows } = await db.query<{ project_id: string; status: ProposalStatus }>(
    `SELECT DISTINCT ON (project_id) project_id, status FROM team_proposals WHERE workspace_id = $1 ORDER BY project_id, created_at DESC, id`,
    [workspaceId],
  )
  return new Map(rows.map((row) => [row.project_id, row.status]))
}

/**
 * Starts a proposal run (src/projects/team-proposer.ts): records it as
 * running, returns its id at once, and settles it to ready or failed when
 * the run ends. `stop` kills any run in flight (daemon shutdown).
 */
export type TeamProposer = {
  propose(workspaceId: string, request: StartProposal): Promise<string>
  stop(): Promise<void>
}

export type StartProposal = {
  readonly projectId: string
  readonly requestedBy: string
  readonly source: 'page' | 'slack'
  readonly slackChannel?: string
  readonly slackThread?: string
}

/** A Slack card whose proposal a newer one superseded; its buttons should be closed. */
export type SupersededCard = { readonly proposalId: string; readonly channel: string; readonly dispatchId: string }

/**
 * Records a running proposal and supersedes the project's older ready ones,
 * in the caller's transaction, returning the Slack cards those had. A second
 * running proposal for the project is refused by the database.
 */
export async function startProposal(client: PoolClient, workspaceId: string, input: StartProposal): Promise<{ id: string; supersededCards: SupersededCard[] }> {
  const { rows: superseded } = await client.query<{ id: string; slack_channel: string | null; card_dispatch_id: string | null }>(
    `UPDATE team_proposals SET status = 'superseded', updated_at = now() WHERE workspace_id = $1 AND project_id = $2 AND status = 'ready'
     RETURNING id, slack_channel, card_dispatch_id`,
    [workspaceId, input.projectId],
  )
  const supersededCards = superseded.flatMap((row) =>
    row.slack_channel !== null && row.card_dispatch_id !== null ? [{ proposalId: row.id, channel: row.slack_channel, dispatchId: row.card_dispatch_id }] : [],
  )
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO team_proposals (workspace_id, project_id, requested_by, source, slack_channel, slack_thread) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [workspaceId, input.projectId, input.requestedBy, input.source, input.slackChannel ?? null, input.slackThread ?? null],
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('startProposal: INSERT returned no id')
    return { id, supersededCards }
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new StoreConflict('Relay is already proposing a team for this project; wait for it to finish.')
    throw error
  }
}

/** A running proposal's result; false when it is no longer running (cancelled, failed at a restart). */
export async function markProposalReady(db: Db, workspaceId: string, proposalId: string, rows: readonly ProposedRow[], fingerprint: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE team_proposals SET status = 'ready', rows = $3, fingerprint = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'running'`,
    [workspaceId, proposalId, JSON.stringify(rows), fingerprint],
  )
  return (rowCount ?? 0) > 0
}

export async function markProposalFailed(db: Db, workspaceId: string, proposalId: string, error: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE team_proposals SET status = 'failed', error = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'running'`,
    [workspaceId, proposalId, scrubSecrets(error).slice(0, 2000)],
  )
  return (rowCount ?? 0) > 0
}

/** At daemon start: no proposal run survives a restart, so every running one has failed. */
export async function failRunningProposals(db: Db, workspaceId: string): Promise<Pick<Proposal, 'id' | 'source'>[]> {
  const { rows } = await db.query<{ id: string; source: Proposal['source'] }>(
    `UPDATE team_proposals SET status = 'failed', error = 'Relay restarted while proposing; propose again.', updated_at = now() WHERE workspace_id = $1 AND status = 'running'
     RETURNING id, source`,
    [workspaceId],
  )
  return rows
}

/** Why a proposal that is no longer ready cannot be approved or rejected. */
function decidedMessage(status: string | undefined, verb: 'approved' | 'rejected'): string {
  return status === 'approved' || status === 'rejected' ? 'This proposal was already decided.' : `This proposal is ${status ?? 'gone'}; it can no longer be ${verb}.`
}

/** Records the Slack card a proposal was posted on, so only a click on that card counts. */
export async function recordProposalCard(db: Db, workspaceId: string, proposalId: string, card: { dispatchId: string; messageTs?: string }): Promise<void> {
  await db.query(
    `UPDATE team_proposals SET card_dispatch_id = $3, card_message_ts = COALESCE($4, card_message_ts), updated_at = now() WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, proposalId, card.dispatchId, card.messageTs ?? null],
  )
}

/**
 * The fingerprint of what a proposal is checked against: the project's
 * folder and repos, its members (with the client and model each runs on),
 * and the text of every persona those members use or the proposal names.
 * Persona text lives in files, so it is hashed from disk, not from the row.
 */
export async function teamFingerprint(db: Db, workspaceId: string, projectId: string, personasDir: string, extraPersonaIds: readonly string[] = []): Promise<string> {
  const project = await getProject(db, workspaceId, projectId)
  if (project === undefined) throw new StoreConflict('That project no longer exists.')
  const members = await listMembers(db, workspaceId, projectId)
  const personaIds = [...new Set([...members.map((member) => member.personaId), ...extraPersonaIds])].sort()
  const { rows } = await db.query<{ id: string; file_name: string }>('SELECT id, file_name FROM personas WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id', [
    workspaceId,
    personaIds,
  ])
  const personas = rows.map((row) => ({ id: row.id, text: sha256(readPersona(personasDir, row.file_name) ?? '<missing>') }))
  const shape = {
    folder: project.folder,
    repos: [...project.repos].sort(),
    members: members.map((member) => [member.id, member.name, member.role, member.isLead, member.personaId, member.client, member.model]).sort(),
    personas,
  }
  return sha256(JSON.stringify(shape))
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function existingPersonaIds(rows: readonly ProposedRow[]): string[] {
  return rows.flatMap((row) => (row.persona.kind === 'existing' ? [row.persona.personaId] : []))
}

export function hasNewPersonas(rows: readonly ProposedRow[]): boolean {
  return rows.some((row) => row.persona.kind === 'new')
}

/**
 * The team an approval would leave: today's members, minus ticked removals,
 * with ticked changes applied, plus ticked additions. Unticked rows leave
 * their member as is (an unticked add is simply not added).
 */
export function resultingRoster(current: readonly TeamMember[], ticked: readonly ProposedRow[]): { name: string; isLead: boolean }[] {
  const byId = new Map(current.map((member) => [member.id, { name: member.name, isLead: member.isLead }]))
  for (const row of ticked) {
    if (row.kind === 'remove' && row.memberId !== undefined) byId.delete(row.memberId)
    if (row.kind === 'change' && row.memberId !== undefined && byId.has(row.memberId)) byId.set(row.memberId, { name: row.name, isLead: row.isLead })
  }
  const added = ticked.filter((row) => row.kind === 'add').map((row) => ({ name: row.name, isLead: row.isLead }))
  return [...byId.values(), ...added]
}

export type ApproveInput = {
  readonly pool: Pool
  readonly workspaceId: string
  readonly proposalId: string
  /** The owner approving, already checked by the caller (page session or Slack click). */
  readonly actor: string
  /** The rows to apply: the review form's ticked and edited rows, or every row from a Slack card. */
  readonly rows: readonly ProposedRow[]
  readonly personasDir: string
  readonly route: string
  /** A Slack approval names the card it came from; it must be the card stored on the proposal. */
  readonly card?: { readonly channel: string; readonly messageTs: string }
  readonly fileOps?: FileOps
}

export type ApproveResult = { readonly applied: AppliedSnapshot; readonly filesNotSaved: readonly PersonaFileFailure[] }

/** Applies a ready proposal once; throws StoreConflict with a message the page or the card can show. */
export async function approveProposal(input: ApproveInput): Promise<ApproveResult> {
  const rows = checkProposalRows(input.rows)
  const newPersonas = rows.flatMap((row) => (row.persona.kind === 'new' ? [{ name: row.persona.name, text: row.persona.text, fileName: newPersonaFileName(row.persona.name) }] : []))
  const saved = await savePersonaFiles(
    input.personasDir,
    newPersonas.map((persona) => ({ fileName: persona.fileName, text: persona.text })),
    () => applyInTransaction(input, rows, newPersonas),
    input.fileOps,
  )
  return { applied: saved.result, filesNotSaved: saved.notSaved }
}

async function applyInTransaction(input: ApproveInput, rows: readonly ProposedRow[], newPersonas: readonly { name: string; text: string; fileName: string }[]): Promise<AppliedSnapshot> {
  const client = await input.pool.connect()
  try {
    await client.query('BEGIN')
    const proposal = await getProposal(client, input.workspaceId, input.proposalId)
    if (proposal === undefined) throw new StoreConflict('That proposal no longer exists.')
    // The team lock first: member writes take it too, so nothing changes the team under this check.
    await ensureTeam(client, input.workspaceId, proposal.projectId)
    const locked = await client.query<{ status: ProposalStatus }>('SELECT status FROM team_proposals WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [input.workspaceId, input.proposalId])
    const status = locked.rows[0]?.status
    if (status !== 'ready') throw new StoreConflict(decidedMessage(status, 'approved'))
    if (input.card !== undefined && (proposal.slackChannel !== input.card.channel || proposal.cardMessageTs !== input.card.messageTs)) {
      throw new StoreConflict('That button is not on this proposal\'s card.')
    }
    if (input.card !== undefined && hasNewPersonas(rows)) throw new StoreConflict('This proposal writes new personas; review and approve it in the setup page.')
    const personaIds = [...new Set([...existingPersonaIds(proposal.rows), ...existingPersonaIds(rows)])]
    if (personaIds.length > 0) await client.query('SELECT id FROM personas WHERE workspace_id = $1 AND id = ANY($2::uuid[]) FOR SHARE', [input.workspaceId, personaIds])
    const now = await teamFingerprint(client, input.workspaceId, proposal.projectId, input.personasDir, existingPersonaIds(proposal.rows))
    if (now !== proposal.fingerprint) throw new StoreConflict('The team changed since Relay proposed this; propose again.')

    const current = await listMembers(client, input.workspaceId, proposal.projectId)
    const currentIds = new Set(current.map((member) => member.id))
    for (const row of rows) {
      if (row.memberId !== undefined && !currentIds.has(row.memberId)) throw new StoreConflict(`${row.name} is no longer on this team; propose again.`)
    }
    const leads = resultingRoster(current, rows).filter((member) => member.isLead).length
    if (leads !== 1) throw new StoreConflict(leads === 0 ? 'The team would have no lead; tick one lead.' : 'The team would have more than one lead; keep exactly one.')

    const teamId = await ensureTeam(client, input.workspaceId, proposal.projectId)
    const created: { personaId: string; name: string; fileName: string; text: string }[] = []
    const personaFor = async (choice: PersonaChoice): Promise<string> => {
      if (choice.kind === 'existing') return choice.personaId
      const draft = newPersonas.find((persona) => persona.name === choice.name && persona.text === choice.text && !created.some((made) => made.fileName === persona.fileName))
      if (draft === undefined) throw new Error('approveProposal: a new persona has no staged file')
      const { rows: inserted } = await client.query<{ id: string }>('INSERT INTO personas (workspace_id, name, file_name, written_by_relay) VALUES ($1, $2, $3, true) RETURNING id', [
        input.workspaceId,
        draft.name,
        draft.fileName,
      ])
      const personaId = inserted[0]?.id
      if (personaId === undefined) throw new Error('approveProposal: persona INSERT returned no id')
      created.push({ personaId, ...draft })
      return personaId
    }

    // Removals and lead unsets first: the one-lead index is checked per statement.
    for (const row of rows.filter((candidate) => candidate.kind === 'remove')) {
      await client.query('DELETE FROM team_members WHERE workspace_id = $1 AND team_id = $2 AND id = $3', [input.workspaceId, teamId, row.memberId])
    }
    if (rows.some((row) => row.kind !== 'remove' && row.kind !== 'keep' && row.isLead)) {
      await client.query('UPDATE team_members SET is_lead = false WHERE workspace_id = $1 AND team_id = $2 AND is_lead', [input.workspaceId, teamId])
    }
    for (const row of rows.filter((candidate) => candidate.kind === 'change')) {
      await client.query('UPDATE team_members SET name = $4, role = $5, persona_id = $6, is_lead = $7 WHERE workspace_id = $1 AND team_id = $2 AND id = $3', [
        input.workspaceId,
        teamId,
        row.memberId,
        row.name,
        row.role,
        await personaFor(row.persona),
        row.isLead,
      ])
    }
    // A changed member keeps its own client and model (the UPDATE above leaves them); a new one runs on Claude with its default model.
    for (const row of rows.filter((candidate) => candidate.kind === 'add')) {
      await client.query("INSERT INTO team_members (workspace_id, team_id, persona_id, name, role, is_lead, client, model) VALUES ($1, $2, $3, $4, $5, $6, 'claude', NULL)", [
        input.workspaceId,
        teamId,
        await personaFor(row.persona),
        row.name,
        row.role,
        row.isLead,
      ])
    }

    const applied: AppliedSnapshot = { rows, newPersonas: created }
    await client.query(
      `UPDATE team_proposals SET status = 'approved', applied = $3, decided_by = $4, decided_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2`,
      [input.workspaceId, input.proposalId, JSON.stringify(applied), input.actor],
    )
    await appendAuditEntryInTransaction(client, input.workspaceId, {
      runId: null,
      kind: UI_AUDIT_KIND,
      actor: input.actor,
      detail: {
        route: input.route,
        outcome: 'team proposal approved',
        proposalId: input.proposalId,
        projectId: proposal.projectId,
        rows: rows.map((row) => ({ kind: row.kind, memberId: row.memberId ?? null, name: row.name, role: row.role, isLead: row.isLead })),
        newPersonas: created.map((persona) => ({ personaId: persona.personaId, fileName: persona.fileName })),
      },
      at: new Date().toISOString(),
    })
    await client.query('COMMIT')
    return applied
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Rejects a ready proposal once, with its audit entry; the team is not touched. */
export async function rejectProposal(
  pool: Pool,
  input: { workspaceId: string; proposalId: string; actor: string; route: string; note?: string; card?: { channel: string; messageTs: string } },
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const proposal = await getProposal(client, input.workspaceId, input.proposalId)
    if (proposal === undefined) throw new StoreConflict('That proposal no longer exists.')
    if (input.card !== undefined && (proposal.slackChannel !== input.card.channel || proposal.cardMessageTs !== input.card.messageTs)) {
      throw new StoreConflict('That button is not on this proposal\'s card.')
    }
    const { rowCount } = await client.query(
      `UPDATE team_proposals SET status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND status = 'ready'`,
      [input.workspaceId, input.proposalId, input.actor, input.note === undefined ? null : scrubSecrets(input.note).slice(0, 500)],
    )
    if ((rowCount ?? 0) === 0) {
      // Read again: an approve may have won since the proposal was loaded.
      const now = await getProposal(client, input.workspaceId, input.proposalId)
      throw new StoreConflict(decidedMessage(now?.status, 'rejected'))
    }
    await appendAuditEntryInTransaction(client, input.workspaceId, {
      runId: null,
      kind: UI_AUDIT_KIND,
      actor: input.actor,
      detail: { route: input.route, outcome: 'team proposal rejected', proposalId: input.proposalId, projectId: proposal.projectId },
      at: new Date().toISOString(),
    })
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
