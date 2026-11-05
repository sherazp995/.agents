/**
 * The proposal runner (the teams UI plan, step 6): one read-only Claude run
 * in the project's folder that suggests a team, checked and stored as a
 * proposal the owner reviews (src/projects/proposals.ts).
 *
 * The run is locked down by its arguments, which `buildProposerArgs` builds
 * and a test pins: read tools only (`--tools Read,Grep,Glob`), plan mode,
 * user settings only (no project settings), no MCP servers, every hook off,
 * and a `Read` deny rule for every off-limits path of every project repo.
 * Its environment drops Relay's brokered secrets and the hook token. No
 * bypass flag is ever passed.
 *
 * Claude Code's Read rules use gitignore patterns; `//path` is an absolute
 * path from the filesystem root (a single leading `/` would anchor at the
 * settings source instead), so each off-limits entry is denied as
 * `Read(//<repo>/<entry>)` and `Read(//<repo>/<entry>/**)`. Claude applies
 * Read rules to Grep and Glob too.
 *
 * Logins are tried in pool order within one budget; a login out of credit
 * or not signed in is skipped. The output is capped while it is read.
 *
 * The daemon calls `failRunningProposals` (proposals.ts) for its workspace
 * at start, before it builds this runner, since no run survives a restart,
 * and calls `stop()` on shutdown.
 */

import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { classifyBlocked, readAccountPool, type Account } from '../autonomous/accounts.js'
import { loadRepoRegistryIfPresent } from '../config/load.js'
import { CLAUDE_BINARY, engineChildEnv, parseFinalResult } from '../live/direct-session.js'
import type { Logger } from '../obs/logger.js'
import { spawnGated, type GatedProcess, type GatedSpawnOptions, type GatedSpawnResult } from '../process/gated-spawn.js'
import {
  checkProposalRows,
  existingPersonaIds,
  getProposal,
  markProposalFailed,
  markProposalReady,
  MAX_PERSONA_TEXT_BYTES,
  MAX_PROPOSED_MEMBERS,
  startProposal,
  teamFingerprint,
  type Proposal,
  type ProposedRow,
  type StartProposal,
  type SupersededCard,
  type TeamProposer,
} from './proposals.js'
import { getProject, listMembers, listPersonas, StoreConflict, type Persona, type Project, type TeamMember } from './store.js'

export const DEFAULT_PROPOSAL_BUDGET_MS = 10 * 60 * 1000
/** Twelve members with 8 KB personas, escaped in Claude's JSON envelope, fit well under this. */
export const DEFAULT_PROPOSAL_OUTPUT_CAP = 512 * 1024

export const NO_CREDIT_MESSAGE = 'No Claude login has credit right now; propose again later.'
const STOPPED_MESSAGE = 'Relay stopped while proposing; propose again.'

export type ProposerRepo = { readonly name: string; readonly path: string; readonly offLimits: readonly string[] }

export type TeamProposerDeps = {
  readonly pool: Pool
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>
  readonly personasDir: string
  /** The project's repo names to their registry entries; a name not registered is left out. */
  readonly repos: (names: readonly string[]) => readonly ProposerRepo[]
  /** The account pool; only `claude` logins are used. Defaults to ~/.agents/accounts.toml. */
  readonly accounts?: () => Promise<readonly Account[]>
  readonly claudeBin?: string
  readonly spawn?: (options: GatedSpawnOptions) => GatedProcess
  /** Epoch ms. */
  readonly now?: () => number
  /** One budget across every login tried. */
  readonly budgetMs?: number
  readonly maxOutputBytes?: number
  readonly baseEnv?: NodeJS.ProcessEnv
  /** Called once the proposal is ready or failed, e.g. to post the Slack card. */
  readonly onSettled?: (proposal: Proposal) => void | Promise<void>
  /** Called after a new proposal superseded older ones that had Slack cards, to close those cards. */
  readonly onSuperseded?: (workspaceId: string, cards: readonly SupersededCard[]) => void | Promise<void>
}

/** The repo lookup from the registry file (config/repos.yaml), read at each run. */
export function repoLookupFromRegistry(reposPath: string): (names: readonly string[]) => ProposerRepo[] {
  return (names) => {
    const registered = loadRepoRegistryIfPresent(reposPath).repos
    return names.flatMap((name) => {
      const repo = registered.find((entry) => entry.name === name)
      return repo === undefined ? [] : [{ name: repo.name, path: repo.path, offLimits: repo.off_limits }]
    })
  }
}

/** `Read` deny rules for every off-limits path, as absolute (`//`) gitignore patterns, also under its real path when that differs. */
export function offLimitsDenyRules(repos: readonly ProposerRepo[]): string[] {
  const rules = new Set<string>()
  for (const repo of repos) {
    for (const entry of repo.offLimits) {
      const path = join(repo.path, entry)
      const real = realPath(path)
      for (const candidate of real === path ? [path] : [path, real]) {
        rules.add(`Read(/${candidate})`)
        rules.add(`Read(/${candidate}/**)`)
      }
    }
  }
  return [...rules]
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The answer's shape, given to Claude as `--json-schema` so its result is
 * that JSON and never prose around it (a free-form answer was sometimes not
 * JSON at all). checkProposalRows still checks every limit and id.
 */
export const PROPOSAL_ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'name', 'role', 'isLead', 'persona', 'reason'],
        properties: {
          kind: { enum: ['add', 'change', 'keep', 'remove'] },
          memberId: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
          isLead: { type: 'boolean' },
          persona: {
            oneOf: [
              { type: 'object', additionalProperties: false, required: ['kind', 'personaId'], properties: { kind: { const: 'existing' }, personaId: { type: 'string' } } },
              { type: 'object', additionalProperties: false, required: ['kind', 'name', 'text'], properties: { kind: { const: 'new' }, name: { type: 'string' }, text: { type: 'string' } } },
            ],
          },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

/** Exactly the read-only argument set; the prompt goes on stdin. */
export function buildProposerArgs(repos: readonly ProposerRepo[]): string[] {
  const settings = { disableAllHooks: true, permissions: { deny: offLimitsDenyRules(repos) } }
  return [
    '-p',
    '--output-format',
    'json',
    '--tools',
    'Read,Grep,Glob',
    '--permission-mode',
    'plan',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--settings',
    JSON.stringify(settings),
    '--json-schema',
    JSON.stringify(PROPOSAL_ANSWER_SCHEMA),
  ]
}

/** The operator's environment minus Relay's secrets and hook address, on the chosen login. */
export function buildProposerEnv(account: Account, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = engineChildEnv(base)
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME
  delete env.RELAY_HOOK_TOKEN
  delete env.RELAY_HOOK_URL
  return { ...env, ...account.env }
}

export function buildProposerPrompt(input: { project: Project; repos: readonly ProposerRepo[]; members: readonly TeamMember[]; personas: readonly Persona[] }): string {
  const { project, repos, members, personas } = input
  const repoLines = project.repos.map((name) => {
    const repo = repos.find((candidate) => candidate.name === name)
    return repo === undefined ? `- ${name} (not in the repo registry)` : `- ${name}: ${repo.path}`
  })
  const memberLines = members.map((member) => `- memberId ${member.id}: ${member.name}, role "${member.role}"${member.isLead ? ', lead' : ''}, persona ${member.personaId} (${member.personaName})`)
  const personaLines = personas.map((persona) => `- personaId ${persona.id}: ${persona.name}`)
  return [
    `You are proposing an agent team for the project "${project.name}". Read its code; do not change anything.`,
    `Project folder (your working directory): ${project.folder}`,
    'Repositories:',
    ...(repoLines.length > 0 ? repoLines : ['- (none listed; read the project folder)']),
    '',
    'Look at each repository\'s languages, frameworks, size and tests, and fit the roles to that stack.',
    '',
    'Today\'s team:',
    ...(memberLines.length > 0 ? memberLines : ['- (empty)']),
    '',
    'Persona library (reuse one when it fits, instead of writing a new one):',
    ...(personaLines.length > 0 ? personaLines : ['- (empty)']),
    '',
    'Answer with JSON only, no other text, in this shape:',
    '{ "rows": [ { "kind": "add" | "change" | "keep" | "remove", "memberId": "<only for change, keep and remove: an id from today\'s team>",',
    '  "name": "<member name>", "role": "<short role>", "isLead": true | false,',
    '  "persona": { "kind": "existing", "personaId": "<an id from the library>" } | { "kind": "new", "name": "<persona name>", "text": "<the persona\'s instructions, markdown>" },',
    '  "reason": "<one line: why>" } ] }',
    'Rules:',
    `- At most ${MAX_PROPOSED_MEMBERS} rows; exactly one row that is not a remove has "isLead": true.`,
    '- Give every member of today\'s team one row: keep, change or remove. New members are add rows, with no memberId.',
    `- Give each new member a short personal first name, like a colleague's (for example Maya or Theo), never a role or persona name such as "Lead", "QA Engineer" or "Code Reviewer". The role goes in "role". Do not use these names: ${AVOIDED_NAMES.join(', ')}.`,
    `- A new persona's text is at most ${MAX_PERSONA_TEXT_BYTES} bytes. Names and roles are at most 120 characters, reasons at most 300.`,
    '- Never copy secrets, keys, tokens or passwords into the answer.',
  ].join('\n')
}

/** Names the owner does not want on a team; the prompt asks Claude to avoid them. */
export const AVOIDED_NAMES = ['Mycroft'] as const

/** Words that make a name a job title rather than a person's name. */
const ROLE_WORDS = /\b(lead|leader|developer|engineer|reviewer|qa|tester|designer|manager|architect|analyst|devops|sre|specialist|owner)\b/i

/** Why an added member's name is a role or persona name rather than a person's name, or undefined when it is fine. */
function roleLikeName(row: ProposedRow, personas: readonly Persona[]): string | undefined {
  if (row.kind !== 'add') return undefined
  const name = row.name.trim().toLowerCase()
  const { persona } = row
  const personaName = persona.kind === 'new' ? persona.name : personas.find((candidate) => candidate.id === persona.personaId)?.name
  if (name === row.role.trim().toLowerCase() || name === personaName?.trim().toLowerCase() || ROLE_WORDS.test(row.name)) return row.name
  return undefined
}

/** The JSON in Claude's answer: the whole text, a fenced block, or the outermost braces. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(trimmed)
  const candidates = [trimmed, fenced?.[1], trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim() === '') continue
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Try the next reading.
    }
  }
  throw new StoreConflict('Claude\'s answer was not JSON; propose again.')
}

/** Checks the answer against the schema and today's team; throws a readable StoreConflict. */
export function checkAnswer(answer: unknown, members: readonly TeamMember[], personas: readonly Persona[]): ProposedRow[] {
  const rows = checkProposalRows((answer as { rows?: unknown } | null)?.rows).map((row) => keepOnlyWhenUnchanged(row, members))
  const leads = rows.filter((row) => row.kind !== 'remove' && row.isLead).length
  if (leads !== 1) throw new StoreConflict(`The proposal must have exactly one lead; it had ${leads}.`)
  const memberIds = new Set(members.map((member) => member.id))
  const unknownMember = rows.find((row) => row.memberId !== undefined && !memberIds.has(row.memberId))
  if (unknownMember !== undefined) throw new StoreConflict(`The proposal names a member who is not on the team (${unknownMember.name}).`)
  // Without a row, a member cannot be unticked or moved off the lead, so the proposal could never be approved as meant.
  const named = new Set(rows.flatMap((row) => (row.memberId === undefined ? [] : [row.memberId])))
  const left = members.find((member) => !named.has(member.id))
  if (left !== undefined) throw new StoreConflict(`The proposal left out ${left.name}; every member needs a keep, change or remove row.`)
  const personaIds = new Set(personas.map((persona) => persona.id))
  const unknownPersona = existingPersonaIds(rows).find((id) => !personaIds.has(id))
  if (unknownPersona !== undefined) throw new StoreConflict('The proposal names a persona that is not in the library.')
  const titled = rows.map((row) => roleLikeName(row, personas)).find((name) => name !== undefined)
  if (titled !== undefined) throw new StoreConflict(`The proposal named a new member "${titled}", a role or persona name rather than a person's name; propose again.`)
  return rows
}

/** A "keep" that differs from today's member (lead, name, role or persona) is a change, so it is shown and applied as one. */
function keepOnlyWhenUnchanged(row: ProposedRow, members: readonly TeamMember[]): ProposedRow {
  if (row.kind !== 'keep') return row
  const member = members.find((candidate) => candidate.id === row.memberId)
  if (member === undefined) return row
  const samePersona = row.persona.kind === 'existing' && row.persona.personaId === member.personaId
  const same = row.isLead === member.isLead && row.name === member.name && row.role === member.role && samePersona
  return same ? row : { ...row, kind: 'change' }
}

type Attempt = { kind: 'answer'; text: string } | { kind: 'blocked' } | { kind: 'failed'; reason: string }

export function createTeamProposer(deps: TeamProposerDeps): TeamProposer {
  const now = deps.now ?? Date.now
  const spawn = deps.spawn ?? spawnGated
  const budgetMs = deps.budgetMs ?? DEFAULT_PROPOSAL_BUDGET_MS
  const accounts = deps.accounts ?? (() => readAccountPool())
  const inFlight = new Map<string, { controller: AbortController; done: Promise<void> }>()
  let stopping = false

  const settle = async (workspaceId: string, proposalId: string, outcome: { rows: ProposedRow[]; fingerprint: string } | { error: string }): Promise<void> => {
    const changed = 'error' in outcome
      ? await markProposalFailed(deps.pool, workspaceId, proposalId, outcome.error)
      : await markProposalReady(deps.pool, workspaceId, proposalId, outcome.rows, outcome.fingerprint)
    if (!changed) {
      deps.log.warn({ proposalId }, 'team proposal was no longer running when its run ended')
      return
    }
    const proposal = await getProposal(deps.pool, workspaceId, proposalId)
    if (proposal !== undefined && deps.onSettled !== undefined) await deps.onSettled(proposal)
  }

  const attempt = async (account: Account, cwd: string, args: readonly string[], prompt: string, timeoutMs: number, signal: AbortSignal): Promise<Attempt> => {
    let result: GatedSpawnResult
    try {
      const child = spawn({
        bin: deps.claudeBin ?? CLAUDE_BINARY,
        args,
        cwd,
        env: buildProposerEnv(account, deps.baseEnv),
        timeoutMs,
        signal,
        input: prompt,
        maxOutputBytes: deps.maxOutputBytes ?? DEFAULT_PROPOSAL_OUTPUT_CAP,
      })
      child.endInput()
      result = await child.done
    } catch (error) {
      return { kind: 'failed', reason: `Relay could not start Claude: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (result.spawnErrorCode === 'ENOENT') return { kind: 'failed', reason: 'The claude CLI was not found on this machine.' }
    if (signal.aborted) return { kind: 'failed', reason: STOPPED_MESSAGE }
    if (result.outputCapped === true) return { kind: 'failed', reason: `Claude's answer was larger than ${Math.round((deps.maxOutputBytes ?? DEFAULT_PROPOSAL_OUTPUT_CAP) / 1024)} KB; propose again.` }
    if (result.timedOut) return { kind: 'failed', reason: `Proposing took longer than ${Math.round(budgetMs / 60_000)} minutes and was stopped; propose again.` }
    const final = parseFinalResult(result.stdout)
    if (result.code === 0 && final?.text !== undefined && final.isError !== true) return { kind: 'answer', text: final.text }
    const detail = final?.text ?? (final?.errors ?? []).join('; ')
    if (classifyBlocked({ exitCode: result.code, stderr: `${result.stderr}\n${detail}` }) !== null) return { kind: 'blocked' }
    const said = (detail || result.stderr).trim().slice(0, 300)
    return { kind: 'failed', reason: `Claude exited ${result.code ?? 'abnormally'} without a proposal${said === '' ? '' : `: ${said}`}` }
  }

  const run = async (workspaceId: string, proposalId: string, projectId: string, signal: AbortSignal): Promise<void> => {
    const deadline = now() + budgetMs
    try {
      const project = await getProject(deps.pool, workspaceId, projectId)
      if (project === undefined) throw new StoreConflict('That project no longer exists.')
      const repos = deps.repos(project.repos)
      const members = await listMembers(deps.pool, workspaceId, projectId)
      const personas = await listPersonas(deps.pool, workspaceId)
      const args = buildProposerArgs(repos)
      const prompt = buildProposerPrompt({ project, repos, members, personas })
      const logins = (await accounts()).filter((account) => account.client === 'claude')
      for (const account of logins) {
        const left = deadline - now()
        if (left <= 0) return await settle(workspaceId, proposalId, { error: `Proposing took longer than ${Math.round(budgetMs / 60_000)} minutes and was stopped; propose again.` })
        const outcome = await attempt(account, project.folder, args, prompt, left, signal)
        if (outcome.kind === 'blocked') {
          deps.log.info({ proposalId, account: account.key }, 'team proposal login has no credit or is signed out; trying the next')
          continue
        }
        if (outcome.kind === 'failed') return await settle(workspaceId, proposalId, { error: outcome.reason })
        const rows = checkAnswer(extractJson(outcome.text), members, personas)
        const fingerprint = await teamFingerprint(deps.pool, workspaceId, projectId, deps.personasDir, existingPersonaIds(rows))
        return await settle(workspaceId, proposalId, { rows, fingerprint })
      }
      await settle(workspaceId, proposalId, { error: NO_CREDIT_MESSAGE })
    } catch (error) {
      const reason = error instanceof StoreConflict ? error.message : `Proposing failed: ${error instanceof Error ? error.message : String(error)}`
      if (!(error instanceof StoreConflict)) deps.log.error({ err: error, proposalId }, 'team proposal run failed')
      await settle(workspaceId, proposalId, { error: reason.slice(0, 1000) }).catch((settleError: unknown) => deps.log.error({ err: settleError, proposalId }, 'could not record a failed team proposal'))
    }
  }

  return {
    async propose(workspaceId: string, request: StartProposal): Promise<string> {
      if (stopping) throw new StoreConflict('Relay is shutting down; propose again once it is back.')
      const client = await deps.pool.connect()
      let proposalId: string
      let supersededCards: SupersededCard[]
      try {
        await client.query('BEGIN')
        ;({ id: proposalId, supersededCards } = await startProposal(client, workspaceId, request))
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
      const controller = new AbortController()
      const done = run(workspaceId, proposalId, request.projectId, controller.signal)
        .catch((error: unknown) => deps.log.error({ err: error, proposalId }, 'team proposal run failed'))
        .finally(() => inFlight.delete(proposalId))
      inFlight.set(proposalId, { controller, done })
      if (supersededCards.length > 0 && deps.onSuperseded) {
        await Promise.resolve(deps.onSuperseded(workspaceId, supersededCards)).catch((error: unknown) =>
          deps.log.warn({ err: error, proposalId }, 'could not close the superseded team proposal cards'),
        )
      }
      return proposalId
    },

    async stop(): Promise<void> {
      stopping = true
      const runs = [...inFlight.values()]
      for (const entry of runs) entry.controller.abort()
      await Promise.all(runs.map((entry) => entry.done))
    },
  }
}
