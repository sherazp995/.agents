import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Account } from '../../src/autonomous/accounts.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { processGroupAlive } from '../../src/process/gated-spawn.js'
import { createPersona } from '../../src/projects/persona-library.js'
import { getProposal, teamFingerprint, type Proposal, type SupersededCard } from '../../src/projects/proposals.js'
import { addMember, createProject } from '../../src/projects/store.js'
import { createTeamProposer, NO_CREDIT_MESSAGE, PROPOSAL_ANSWER_SCHEMA, type TeamProposerDeps } from '../../src/projects/team-proposer.js'
import { registerSecretValue, resetSecretScrubberForTests } from '../../src/secrets/scrubber.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as TeamProposerDeps['log']

/**
 * A fake claude: records its arguments, environment, stdin and pid, then
 * fails as out of credit when its login dir says "broke", or runs the
 * test's answer.sh.
 */
const FAKE_CLI = `#!/bin/sh
dir=$(dirname "$0")
echo $$ > "$dir/pid.txt"
printf '%s\\n' "$@" > "$dir/args.txt"
env > "$dir/env.txt"
cat > "$dir/stdin.txt"
case "$CLAUDE_CONFIG_DIR" in *broke*) echo "Credit balance is too low" >&2; exit 1;; esac
exec /bin/sh "$dir/answer.sh"
`

const claudeAccount = (key: string, configDir: string | null): Account => ({ key, client: 'claude', configDir, env: configDir === null ? {} : { CLAUDE_CONFIG_DIR: configDir } })

describe('the team proposal runner', () => {
  let pool: Pool
  const proposers: { stop(): Promise<void> }[] = []

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterEach(async () => {
    await Promise.all(proposers.splice(0).map((proposer) => proposer.stop()))
    resetSecretScrubberForTests()
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

  /** A workspace with a project whose team has one lead, a fake CLI and a proposer that reports when a proposal settles. */
  async function setup(options: { answer?: string; answerScript?: string; accounts?: Account[]; budgetMs?: number; maxOutputBytes?: number } = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-proposer-')))
    const personasDir = join(dir, 'personas')
    const bin = join(dir, 'claude')
    writeFileSync(bin, FAKE_CLI)
    chmodSync(bin, 0o755)
    if (options.answer !== undefined) {
      writeFileSync(join(dir, 'answer.json'), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: options.answer, session_id: 's1' }))
    }
    writeFileSync(join(dir, 'answer.sh'), options.answerScript ?? 'cat "$(dirname "$0")/answer.json"\n')

    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const projectId = await inTx((client) => createProject(client, workspaceId, { name: 'Web', slackChannel: 'C1', folder: dir, repos: ['web'] }))
    const personaId = await createPersona({ pool, workspaceId, actor: 'prn_owner', dir: personasDir, route: 'POST /test' }, 'Lead', '# Lead')
    const memberId = await inTx((client) => addMember(client, workspaceId, projectId, { name: 'Ada', role: 'lead', personaId, isLead: true }))

    const superseded: SupersededCard[] = []
    let resolveSettled: (proposal: Proposal) => void = () => undefined
    const settled = new Promise<Proposal>((resolve) => {
      resolveSettled = resolve
    })
    const proposer = createTeamProposer({
      pool,
      log: silentLog,
      personasDir,
      repos: (names) => names.map((name) => ({ name, path: dir, offLimits: ['.env', 'secrets'] })),
      accounts: async () => options.accounts ?? [claudeAccount('claude', null)],
      claudeBin: bin,
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, RELAY_SECRET_X: 'brokered', RELAY_HOOK_TOKEN: 'hook-token' },
      ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      onSettled: (proposal) => resolveSettled(proposal),
      onSuperseded: (_workspaceId, cards) => void superseded.push(...cards),
    })
    proposers.push(proposer)
    const propose = () => proposer.propose(workspaceId, { projectId, requestedBy: 'prn_owner', source: 'page' })
    return { dir, personasDir, workspaceId, projectId, personaId, memberId, proposer, propose, settled, superseded }
  }

  const goodRows = (memberId: string, personaId: string) => [
    { kind: 'keep', memberId, name: 'Ada', role: 'lead', isLead: true, persona: { kind: 'existing', personaId }, reason: 'Already leads.' },
    { kind: 'add', name: 'Tess', role: 'tester', isLead: false, persona: { kind: 'new', name: 'Tester', text: '# Tester\nWrite vitest tests.' }, reason: 'The repo has vitest tests.' },
  ]

  async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
    const until = Date.now() + ms
    while (!check()) {
      if (Date.now() > until) throw new Error('timed out waiting')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('runs claude with exactly the read-only arguments, the off-limits denies, no bypass and no brokered secrets, and a fenced good answer becomes ready with its fingerprint', async () => {
    const env = await setup()
    const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify({ rows: goodRows(env.memberId, env.personaId) })}\n\`\`\``
    writeFileSync(join(env.dir, 'answer.json'), JSON.stringify({ type: 'result', is_error: false, session_id: 's1', result: fenced }))

    const id = await env.propose()
    expect((await getProposal(pool, env.workspaceId, id))?.status).toBe('running')
    const proposal = await env.settled

    expect(proposal.status).toBe('ready')
    expect(proposal.rows.map((row) => [row.kind, row.name, row.isLead])).toEqual([
      ['keep', 'Ada', true],
      ['add', 'Tess', false],
    ])
    expect(proposal.fingerprint).toBe(await teamFingerprint(pool, env.workspaceId, env.projectId, env.personasDir, [env.personaId]))

    const args = readFileSync(join(env.dir, 'args.txt'), 'utf8').trimEnd().split('\n')
    const settings = {
      disableAllHooks: true,
      permissions: { deny: [`Read(/${env.dir}/.env)`, `Read(/${env.dir}/.env/**)`, `Read(/${env.dir}/secrets)`, `Read(/${env.dir}/secrets/**)`] },
    }
    expect(args).toEqual(['-p', '--output-format', 'json', '--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--setting-sources', 'user', '--strict-mcp-config', '--settings', JSON.stringify(settings), '--json-schema', JSON.stringify(PROPOSAL_ANSWER_SCHEMA)])
    expect(args.join(' ')).not.toMatch(/bypass|dangerously|skip-permissions/i)
    expect(settings.permissions.deny[0]).toMatch(/^Read\(\/\/.+\/\.env\)$/)

    const childEnv = readFileSync(join(env.dir, 'env.txt'), 'utf8')
    expect(childEnv).not.toContain('RELAY_SECRET_X')
    expect(childEnv).not.toContain('RELAY_HOOK_TOKEN')
    const prompt = readFileSync(join(env.dir, 'stdin.txt'), 'utf8')
    expect(prompt).toContain(`web: ${env.dir}`)
    expect(prompt).toContain(`memberId ${env.memberId}`)
    expect(prompt).toContain(`personaId ${env.personaId}: Lead`)
  })

  it.each([
    ['bad JSON', () => 'I think you need a tester.', 'not JSON'],
    ['too many rows', (memberId: string, personaId: string) => JSON.stringify({ rows: Array.from({ length: 13 }, (_, index) => ({ ...goodRows(memberId, personaId)[1], name: `M${index}`, isLead: index === 0 })) }), 'rows'],
    ['two leads', (memberId: string, personaId: string) => JSON.stringify({ rows: goodRows(memberId, personaId).map((row) => ({ ...row, isLead: true })) }), 'exactly one lead'],
  ])('fails a proposal whose answer has %s, with the reason', async (_label, answer, reason) => {
    const env = await setup({ answer: '' })
    writeFileSync(join(env.dir, 'answer.json'), JSON.stringify({ type: 'result', is_error: false, session_id: 's1', result: answer(env.memberId, env.personaId) }))
    await env.propose()
    const proposal = await env.settled
    expect(proposal.status).toBe('failed')
    expect(proposal.error).toContain(reason)
  })

  it('fails an oversized answer once the output cap is passed', async () => {
    const env = await setup({ answer: 'x'.repeat(20_000), maxOutputBytes: 2048 })
    await env.propose()
    const proposal = await env.settled
    expect(proposal.status).toBe('failed')
    expect(proposal.error).toContain('larger than 2 KB')
  })

  it('fails a run slower than the budget', async () => {
    const env = await setup({ answerScript: 'sleep 30\n', budgetMs: 400 })
    const started = Date.now()
    await env.propose()
    const proposal = await env.settled
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    expect(proposal.status).toBe('failed')
    expect(proposal.error).toContain('took longer than')
  })

  it('scrubs a registered secret from a ready proposal', async () => {
    const secret = 'sk-live-0123456789abcdef'
    registerSecretValue(secret)
    const env = await setup({ answer: '' })
    const rows = goodRows(env.memberId, env.personaId).map((row) => ({ ...row, reason: `Saw ${secret} in .env.example` }))
    writeFileSync(join(env.dir, 'answer.json'), JSON.stringify({ type: 'result', is_error: false, session_id: 's1', result: JSON.stringify({ rows }) }))
    const id = await env.propose()
    await env.settled
    const stored = await getProposal(pool, env.workspaceId, id)
    expect(stored?.status).toBe('ready')
    expect(JSON.stringify(stored?.rows)).not.toContain(secret)
    expect(stored?.rows[0]?.reason).toContain('[redacted secret]')
  })

  it('skips a login out of credit to the next claude login, ignores codex logins, and fails when every login is out', async () => {
    const accounts: Account[] = [claudeAccount('claude', '/logins/broke'), { key: 'codex', client: 'codex', configDir: null, env: {} }, claudeAccount('second', '/logins/good')]
    const env = await setup({ answer: '', accounts })
    writeFileSync(join(env.dir, 'answer.json'), JSON.stringify({ type: 'result', is_error: false, session_id: 's1', result: JSON.stringify({ rows: goodRows(env.memberId, env.personaId) }) }))
    await env.propose()
    expect((await env.settled).status).toBe('ready')
    expect(readFileSync(join(env.dir, 'env.txt'), 'utf8')).toContain('CLAUDE_CONFIG_DIR=/logins/good')

    const broke = await setup({ answer: '', accounts: [claudeAccount('a', '/logins/broke-a'), claudeAccount('b', '/logins/broke-b')] })
    await broke.propose()
    const proposal = await broke.settled
    expect(proposal.status).toBe('failed')
    expect(proposal.error).toBe(NO_CREDIT_MESSAGE)
  })

  it('hands the cards of the ready proposals a new one supersedes to onSuperseded', async () => {
    const env = await setup({ answer: JSON.stringify({ rows: goodRows('', '') }) })
    const first = await env.propose()
    await env.settled
    await pool.query("UPDATE team_proposals SET status = 'ready', slack_channel = 'C_TEAM', slack_thread = '1.1', card_dispatch_id = 'dispatch-1' WHERE id = $1", [first])
    await env.propose()
    expect(env.superseded).toEqual([{ proposalId: first, channel: 'C_TEAM', dispatchId: 'dispatch-1' }])
  })

  it('refuses a second proposal for the project while one runs, and stop() kills the running process group', async () => {
    const env = await setup({ answerScript: 'sleep 30\n' })
    const id = await env.propose()
    await waitFor(() => existsSync(join(env.dir, 'stdin.txt')))
    await expect(env.propose()).rejects.toThrow('already proposing')

    const pgid = Number(readFileSync(join(env.dir, 'pid.txt'), 'utf8').trim())
    expect(processGroupAlive(pgid)).toBe(true)
    const started = Date.now()
    await env.proposer.stop()
    expect(Date.now() - started).toBeLessThan(5000)
    await waitFor(() => !processGroupAlive(pgid))
    const stored = await getProposal(pool, env.workspaceId, id)
    expect(stored?.status).toBe('failed')
    expect(stored?.error).toContain('stopped while proposing')
  })
})
