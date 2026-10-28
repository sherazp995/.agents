import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { closePool, createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { findOrCreateSession } from '../../src/sessions/store.js'
import { createRun } from '../../src/runs/store.js'
import { resolveApproval } from '../../src/approvals/store.js'
import type { ChatAction } from '../../src/chat/contract.js'
import { repoEntrySchema, type RepoEntry } from '../../src/repos/schema.js'
import { registerSecretValue } from '../../src/secrets/scrubber.js'
import { loadTask, requestCancel, type AutonomousTask } from '../../src/autonomous/store.js'
import type { RemoteWrite } from '../../src/autonomous/reply.js'
import { cancelTaskOperations, claimOperation, createMcpOperations, loadOperation, skipOperation } from '../../src/autonomous/operations.js'
import { recordVerification } from '../../src/autonomous/verifications.js'
import {
  apiPathAllowed,
  canonicalRepoUrl,
  executeApprovedOperation,
  offerOperationApproval,
  reconcileDispatching,
  requestRemoteWrite,
  tokenHostAllowed,
  type RemoteWriteDeps,
} from '../../src/autonomous/remote-write.js'
import { getTestDatabaseUrl } from '../support/database.js'

const KEY = new Uint8Array(Buffer.from('b'.repeat(64), 'hex'))
const TOKEN = `relaywrite_${'t'.repeat(30)}`

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim()
}

function commit(work: string, file: string, text: string): string {
  writeFileSync(join(work, file), text)
  sh(work, 'add', file)
  sh(work, 'commit', '-q', '-m', `edit ${file}`)
  return sh(work, 'rev-parse', 'HEAD')
}

function remoteHead(bare: string, branch: string): string | undefined {
  const out = sh(bare, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`)
  return out === '' ? undefined : out
}

type Fixture = {
  dir: string
  remote: string
  evil: string
  work: string
  baseSha: string
  headSha: string
  repo: RepoEntry
  ghCalls: () => { args: string; stdin: string }[]
  respond: (name: string, text: string) => void
  deps: RemoteWriteDeps
  actions: ChatAction[]
}

/** A bare "remote", a worktree with one commit on relay/fix, a fake gh logging argv and stdin, and relay's home. */
function fixture(overrides: Partial<RemoteWriteDeps> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'relay-remote-write-'))
  const remote = join(dir, 'remote.git')
  const evil = join(dir, 'evil.git')
  sh(dir, 'init', '-q', '--bare', remote)
  sh(dir, 'init', '-q', '--bare', evil)
  const work = join(dir, 'work')
  sh(dir, 'clone', '-q', remote, work)
  const baseSha = commit(work, 'a.txt', 'one\n')
  sh(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  sh(work, 'checkout', '-q', '-b', 'relay/fix')
  const headSha = commit(work, 'a.txt', 'two\n')

  const bin = join(dir, 'bin')
  const calls = join(dir, 'gh-calls')
  const responses = join(dir, 'gh-responses')
  mkdirSync(bin)
  mkdirSync(calls)
  mkdirSync(responses)
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
n=$(ls "${calls}" | wc -l | tr -d ' ')-$$
printf '%s ' "$@" > "${calls}/$n.args"
cat > "${calls}/$n.stdin"
[ "$GH_TOKEN" = "${TOKEN}" ] && echo "token-for:$GH_HOST" >> "${calls}/$n.args"
f="${responses}/$1-$2"
if [ -f "$f" ]; then cat "$f"; else echo ok; fi
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)

  const repo = repoEntrySchema.parse({ name: 'web', path: work, remote, permitted_operations: ['read', 'write', 'publish'] })
  const actions: ChatAction[] = []
  const deps: RemoteWriteDeps = {
    outbox: {
      enqueue: async (action) => {
        actions.push(action)
        return randomUUID()
      },
    },
    receiptKey: KEY,
    approvalTimeoutMs: 60_000,
    relayHome: join(dir, 'relay-home'),
    loadRepo: (name) => (name === 'web' ? repo : undefined),
    allowedApiPaths: ['repos/acme/web/issues/*/labels'],
    readWriteToken: async () => TOKEN,
    ghBin: join(bin, 'gh'),
    allowLocalRemotes: true,
    ...overrides,
  }
  const ghCalls = () =>
    readdirSync(calls)
      .filter((name) => name.endsWith('.args'))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b))
      .map((name) => ({
        args: readFileSync(join(calls, name), 'utf8'),
        stdin: readFileSync(join(calls, name.replace('.args', '.stdin')), 'utf8'),
      }))
  const respond = (name: string, text: string) => writeFileSync(join(responses, name), text)
  respond('pr-create', 'https://github.com/acme/web/pull/7\n')
  respond('pr-view', JSON.stringify({ headRefOid: headSha }))
  return { dir, remote, evil, work, baseSha, headSha, repo, ghCalls, respond, deps, actions }
}

describe('remote-write executor', () => {
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

  type World = { task: AutonomousTask; runId: string; requester: string; workspaceId: string }

  async function world(f: Fixture): Promise<World> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const requester = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Requester', ['member'])
    const session = await findOrCreateSession(pool, { workspaceId, principalId: requester, adapter: 'slack', threadRef: `C1:${randomUUID()}` })
    const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId: requester })
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id, repo_name, task_type, worktree_path, phase)
       VALUES ($1, $2, $3, 'web', 'implement', $4, 'working') RETURNING id`,
      [workspaceId, session.id, requester, f.work],
    )
    const task = await loadTask(pool, rows[0]?.id ?? '')
    if (!task) throw new Error('no task')
    return { task, runId: run.id, requester, workspaceId }
  }

  async function verify(w: World, f: Fixture, overrides: { baseSha?: string; headSha?: string; passed?: boolean } = {}): Promise<void> {
    await recordVerification(pool, {
      workspaceId: w.workspaceId,
      taskId: w.task.id,
      repo: f.remote,
      baseSha: overrides.baseSha ?? f.baseSha,
      headSha: overrides.headSha ?? f.headSha,
      testsExit: 0,
      reviewRecord: '/tmp/review.md',
      reviewVerdict: 'PASS',
      visualQaVerdict: null,
      videoQaVerdict: null,
      passed: overrides.passed ?? true,
    })
  }

  function request(w: World, f: Fixture, write: RemoteWrite) {
    return requestRemoteWrite(pool, f.deps, { task: w.task, write, headSha: f.headSha, baseSha: f.baseSha, runId: w.runId })
  }

  async function approve(w: World, approvalId: string): Promise<void> {
    const result = await resolveApproval(pool, {
      workspaceId: w.workspaceId,
      approvalId,
      option: 'approve',
      resolverPrincipalId: w.requester,
      receiptKey: KEY,
    })
    expect(result.outcome).toBe('resolved')
  }

  async function requestedAndApproved(w: World, f: Fixture, write: RemoteWrite): Promise<string> {
    const requested = await request(w, f, write)
    if (requested.kind !== 'requested') throw new Error(`expected requested, got ${JSON.stringify(requested)}`)
    await approve(w, requested.approvalId)
    return requested.operationId
  }

  const cards = (f: Fixture) => f.actions.filter((action) => action.kind === 'post_approval_card')

  describe('push and PR need passing evidence for the exact snapshot', () => {
    it('creates no approval before verification, ignores stale evidence, and offers once the snapshot passes', async () => {
      const f = fixture()
      const w = await world(f)
      // Stale: a passing row for another head and for another base.
      await verify(w, f, { headSha: f.baseSha })
      await verify(w, f, { baseSha: f.headSha })

      for (const write of [{ kind: 'push', branch: 'relay/fix' }, { kind: 'pr_create', base: 'main', head: 'relay/fix', title: 'Fix', body: 'b' }] as const) {
        const first = await request(w, f, write)
        expect(first).toMatchObject({ kind: 'needs_verification', headSha: f.headSha, baseSha: f.baseSha, repo: f.remote })
        if (first.kind !== 'needs_verification') throw new Error('unreachable')
        expect(cards(f)).toHaveLength(0)
        expect((await loadOperation(pool, first.operationId))?.approvalId).toBeNull()
        expect((await offerOperationApproval(pool, f.deps, first.operationId, w.runId)).kind).toBe('needs_verification')
      }

      await verify(w, f)
      const again = await request(w, f, { kind: 'push', branch: 'relay/fix' })
      expect(again.kind).toBe('requested')
      expect(cards(f)).toHaveLength(1)
    })

    it('a failed verification leaves no approval and skips the operation with the gaps posted', async () => {
      const f = fixture()
      const w = await world(f)
      const first = await request(w, f, { kind: 'push', branch: 'relay/fix' })
      if (first.kind !== 'needs_verification') throw new Error('expected needs_verification')
      await verify(w, f, { passed: false })

      expect((await offerOperationApproval(pool, f.deps, first.operationId, w.runId)).kind).toBe('needs_verification')
      expect(await skipOperation(pool, f.deps, first.operationId, 'Verification failed: tests exited 1.')).toBe(true)

      expect((await loadOperation(pool, first.operationId))?.state).toBe('skipped')
      expect(cards(f)).toHaveLength(0)
      expect(f.actions.at(-1)).toMatchObject({ kind: 'post', text: expect.stringContaining('tests exited 1') })
    })

    it('refuses at execution when the passing row no longer matches the approved snapshot', async () => {
      const f = fixture()
      const w = await world(f)
      await verify(w, f)
      const operationId = await requestedAndApproved(w, f, { kind: 'push', branch: 'relay/fix' })
      await pool.query('UPDATE autonomous_verifications SET passed = false WHERE task_id = $1', [w.task.id])

      const result = await executeApprovedOperation(pool, f.deps, operationId)

      expect(result.kind).toBe('refused')
      expect(remoteHead(f.remote, 'relay/fix')).toBeUndefined()
      expect((await loadOperation(pool, operationId))?.state).toBe('failed')
    })
  })

  describe('push', () => {
    it('pushes the stored SHA once, not a newer HEAD, opens no PR, and runs from the stored row after a restart', async () => {
      const f = fixture()
      const w = await world(f)
      await verify(w, f)
      const operationId = await requestedAndApproved(w, f, { kind: 'push', branch: 'relay/fix' })
      // The worker keeps working after asking.
      const newer = commit(f.work, 'a.txt', 'three\n')

      // A fresh deps object stands in for a restarted daemon: nothing but the database carries over.
      const result = await executeApprovedOperation(pool, { ...f.deps }, operationId)

      expect(result.kind).toBe('succeeded')
      expect(remoteHead(f.remote, 'relay/fix')).toBe(f.headSha)
      expect(remoteHead(f.remote, 'relay/fix')).not.toBe(newer)
      expect(f.ghCalls()).toHaveLength(0)
      expect((await executeApprovedOperation(pool, f.deps, operationId)).kind).toBe('not_claimed')
      expect(f.actions.at(-1)).toMatchObject({ kind: 'post', text: expect.stringContaining('Done: push') })
    })

    it('ignores a hostile insteadOf, pushurl and pre-push hook in the worktree', async () => {
      const f = fixture()
      const w = await world(f)
      const marker = join(f.dir, 'hook-ran')
      sh(f.work, 'config', `url.${f.evil}.insteadOf`, f.remote)
      sh(f.work, 'config', 'remote.origin.pushurl', f.evil)
      const hooks = join(f.work, '.git', 'hooks')
      writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\ntouch ${marker}\n`)
      chmodSync(join(hooks, 'pre-push'), 0o755)
      sh(f.work, 'config', 'core.hooksPath', hooks)
      await verify(w, f)
      const operationId = await requestedAndApproved(w, f, { kind: 'push', branch: 'relay/fix' })

      expect((await executeApprovedOperation(pool, f.deps, operationId)).kind).toBe('succeeded')

      expect(remoteHead(f.remote, 'relay/fix')).toBe(f.headSha)
      expect(remoteHead(f.evil, 'relay/fix')).toBeUndefined()
      expect(existsSync(marker)).toBe(false)
    })

    it('runs none of the worktree repository config commands while fetching into the mirror', async () => {
      const f = fixture()
      const w = await world(f)
      const marker = (name: string) => join(f.dir, `ran-${name}`)
      sh(f.work, 'config', 'core.fsmonitor', `touch ${marker('fsmonitor')}`)
      sh(f.work, 'config', 'core.alternateRefsCommand', `touch ${marker('alternate-refs')}`)
      sh(f.work, 'config', 'uploadpack.packObjectsHook', `touch ${marker('pack-objects-hook')}`)
      await verify(w, f)
      const operationId = await requestedAndApproved(w, f, { kind: 'push', branch: 'relay/fix' })

      expect((await executeApprovedOperation(pool, f.deps, operationId)).kind).toBe('succeeded')
      expect(readdirSync(f.dir).filter((name) => name.startsWith('ran-'))).toEqual([])
    })

    it('refuses a push that touches an off-limits path or carries a dash-punctuated commit message', async () => {
      const f = fixture()
      const w = await world(f)
      const guarded = repoEntrySchema.parse({ ...f.repo, off_limits: ['secrets'] })
      mkdirSync(join(f.work, 'secrets'))
      const touched = commit(f.work, 'secrets/k.txt', 'x\n')
      await verify(w, f, { headSha: touched })
      const offLimits = await requestRemoteWrite(pool, { ...f.deps, loadRepo: () => guarded }, {
        task: w.task, write: { kind: 'push', branch: 'relay/fix' }, headSha: touched, baseSha: f.baseSha, runId: w.runId,
      })
      expect(offLimits).toMatchObject({ kind: 'refused', reason: expect.stringContaining('off limits') })

      writeFileSync(join(f.work, 'b.txt'), 'b\n')
      sh(f.work, 'add', 'b.txt')
      sh(f.work, 'commit', '-q', '-m', 'Add b - quickly')
      const dashed = sh(f.work, 'rev-parse', 'HEAD')
      await verify(w, f, { headSha: dashed })
      const dash = await requestRemoteWrite(pool, f.deps, { task: w.task, write: { kind: 'push', branch: 'relay/fix' }, headSha: dashed, baseSha: f.baseSha, runId: w.runId })
      expect(dash).toMatchObject({ kind: 'refused', reason: expect.stringContaining('rule 45') })
    })

    it('refuses a push to the default branch and a repository named by remote name only', async () => {
      const f = fixture()
      const w = await world(f)
      await verify(w, f)
      expect((await request(w, f, { kind: 'push', branch: 'main' })).kind).toBe('refused')

      const named = repoEntrySchema.parse({ ...f.repo, remote: 'origin' })
      expect(canonicalRepoUrl(named)).toMatchObject({ ok: false })
      // A local path is a test-only remote, and no remote may climb out with "..".
      expect(canonicalRepoUrl(f.repo)).toMatchObject({ ok: false })
      expect(canonicalRepoUrl(f.repo, { allowLocalPaths: true })).toEqual({ ok: true, url: f.remote })
      expect(canonicalRepoUrl(repoEntrySchema.parse({ ...f.repo, remote: `${f.dir}/../x.git` }), { allowLocalPaths: true })).toMatchObject({ ok: false })
      expect(canonicalRepoUrl(repoEntrySchema.parse({ ...f.repo, remote: 'https://github.com/acme/../evil' }))).toMatchObject({ ok: false })
      const byName = await requestRemoteWrite(pool, { ...f.deps, loadRepo: () => named }, {
        task: w.task,
        write: { kind: 'push', branch: 'relay/fix' },
        headSha: f.headSha,
        baseSha: f.baseSha,
        runId: w.runId,
      })
      expect(byName.kind).toBe('refused')
    })

    it('a crash after the push and before the outcome reconciles to succeeded with no second push', async () => {
      const f = fixture()
      const w = await world(f)
      await verify(w, f)
      const operationId = await requestedAndApproved(w, f, { kind: 'push', branch: 'relay/fix' })
      // The dispatch happened, then the daemon died before writing the outcome.
      await pool.query(`UPDATE autonomous_operations SET state = 'dispatching', claimed_at = now() WHERE id = $1`, [operationId])
      sh(f.work, 'push', '-q', f.remote, `${f.headSha}:refs/heads/relay/fix`)

      expect(await reconcileDispatching(pool, f.deps, w.workspaceId)).toEqual([{ operationId, state: 'succeeded' }])
      expect((await executeApprovedOperation(pool, f.deps, operationId)).kind).toBe('not_claimed')
      expect((await loadOperation(pool, operationId))?.state).toBe('succeeded')
    })
  })

  describe('PR create', () => {
    it('opens the PR when the remote head equals the stored SHA, without pushing, with the stored body on stdin', async () => {
      const f = fixture()
      const w = await world(f)
      await verify(w, f)
      sh(f.work, 'push', '-q', f.remote, `${f.headSha}:refs/heads/relay/fix`)
      const operationId = await requestedAndApproved(w, f, { kind: 'pr_create', base: 'main', head: 'relay/fix', title: 'Fix', body: 'What changed' })
      const before = sh(f.remote, 'for-each-ref')

      const result = await executeApprovedOperation(pool, f.deps, operationId)

      expect(result).toMatchObject({ kind: 'succeeded', result: { url: 'https://github.com/acme/web/pull/7' } })
      expect(sh(f.remote, 'for-each-ref')).toBe(before)
      const [create] = f.ghCalls()
      expect(create?.args).toContain('pr create --repo')
      expect(create?.args).toContain('--draft --base main --head relay/fix')
      // A local test remote is not a token host: gh runs, but without the token.
      expect(create?.args).not.toContain('token-for')
      expect(create?.stdin).toBe(`What changed\n\n<!-- relay-op:${operationId} -->`)
    })

    it('refuses and reports an absent head branch or one at another SHA', async () => {
      const f = fixture()
      const w = await world(f)
      await verify(w, f)
      const absent = await requestedAndApproved(w, f, { kind: 'pr_create', base: 'main', head: 'relay/fix', title: 'Fix', body: 'b' })
      expect(await executeApprovedOperation(pool, f.deps, absent)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not on the remote') })

      sh(f.work, 'push', '-q', f.remote, `${f.baseSha}:refs/heads/relay/fix`)
      const moved = await requestedAndApproved(w, f, { kind: 'pr_create', base: 'main', head: 'relay/fix', title: 'Fix', body: 'b' })
      expect(await executeApprovedOperation(pool, f.deps, moved)).toMatchObject({ kind: 'refused', reason: expect.stringContaining(f.baseSha) })

      expect(f.ghCalls()).toHaveLength(0)
    })

    it('reports a head that changed during creation from headRefOid', async () => {
      const f = fixture()
      const w = await world(f)
      await verify(w, f)
      sh(f.work, 'push', '-q', f.remote, `${f.headSha}:refs/heads/relay/fix`)
      f.respond('pr-view', JSON.stringify({ headRefOid: 'c'.repeat(40) }))
      const operationId = await requestedAndApproved(w, f, { kind: 'pr_create', base: 'main', head: 'relay/fix', title: 'Fix', body: 'b' })

      const result = await executeApprovedOperation(pool, f.deps, operationId)

      expect(result).toMatchObject({ kind: 'uncertain', result: { headMismatch: true, headRefOid: 'c'.repeat(40) } })
      expect((await loadOperation(pool, operationId))?.state).toBe('uncertain')
      expect(f.actions.at(-1)).toMatchObject({ kind: 'post', text: expect.stringContaining('changed during creation') })
    })
  })

  describe('bodies and API paths', () => {
    it('refuses a body holding a registered secret or an unregistered ghp_ token, storing nothing', async () => {
      const f = fixture()
      const w = await world(f)
      registerSecretValue('registered-secret-value-0123456789')

      for (const body of ['see registered-secret-value-0123456789', `token ghp_${'A'.repeat(36)}`]) {
        expect((await request(w, f, { kind: 'pr_comment', pr: 3, body })).kind).toBe('refused')
      }
      const { rows } = await pool.query('SELECT 1 FROM autonomous_operations WHERE task_id = $1', [w.task.id])
      expect(rows).toHaveLength(0)
    })

    it('a placeholder word on the line does not excuse a real token shape in a body', async () => {
      const f = fixture()
      const w = await world(f)
      expect((await request(w, f, { kind: 'pr_comment', pr: 3, body: `for example: ghp_${'C'.repeat(36)}` })).kind).toBe('refused')
    })

    it('sends the write token only to an allowed host, and refuses gh for any other', async () => {
      const f = fixture()
      const w = await world(f)
      const github = repoEntrySchema.parse({ ...f.repo, remote: 'https://github.com/acme/web.git' })
      const other = repoEntrySchema.parse({ ...f.repo, remote: 'https://gitlab.example.com/acme/web.git' })
      const deps = (repo: RepoEntry) => ({ ...f.deps, loadRepo: () => repo })
      const approved = async (repo: RepoEntry) => {
        const requested = await requestRemoteWrite(pool, deps(repo), { task: w.task, write: { kind: 'pr_comment', pr: 3, body: 'x' }, headSha: f.headSha, baseSha: f.baseSha, runId: w.runId })
        if (requested.kind !== 'requested') throw new Error('expected requested')
        await approve(w, requested.approvalId)
        return requested.operationId
      }

      expect((await executeApprovedOperation(pool, deps(github), await approved(github))).kind).toBe('succeeded')
      expect(f.ghCalls()[0]?.args).toContain('--repo github.com/acme/web ')
      expect(f.ghCalls()[0]?.args).toContain('token-for:github.com')
      expect((await executeApprovedOperation(pool, deps(other), await approved(other))).kind).toBe('failed')
      expect(f.ghCalls()).toHaveLength(1)
      expect(tokenHostAllowed('https://github.com/acme/web.git')).toBe(true)
      expect(tokenHostAllowed('https://github.com.evil.example/acme/web.git')).toBe(false)
      expect(tokenHostAllowed('https://x@github.com/acme/web.git')).toBe(false)
      expect(tokenHostAllowed('/srv/git/web.git')).toBe(false)
    })

    it('posts the stored bytes and refuses a payload changed after approval', async () => {
      const f = fixture()
      const w = await world(f)
      const kept = await requestedAndApproved(w, f, { kind: 'pr_comment', pr: 3, body: 'Findings: none' })
      expect((await executeApprovedOperation(pool, f.deps, kept)).kind).toBe('succeeded')
      expect(f.ghCalls()[0]?.stdin).toBe(`Findings: none\n\n<!-- relay-op:${kept} -->`)

      const edited = await requestedAndApproved(w, f, { kind: 'pr_comment', pr: 3, body: 'original' })
      await pool.query(`UPDATE autonomous_operations SET payload = jsonb_set(payload, '{body}', '"edited"') WHERE id = $1`, [edited])
      expect((await executeApprovedOperation(pool, f.deps, edited)).kind).toBe('refused')
      expect(f.ghCalls()).toHaveLength(1)
    })

    it('limits api_write to the policy paths, a * matching one segment', async () => {
      expect(apiPathAllowed('repos/acme/web/issues/12/labels', ['repos/acme/web/issues/*/labels'])).toBe(true)
      expect(apiPathAllowed('repos/acme/web/issues/12/x/labels', ['repos/acme/web/issues/*/labels'])).toBe(false)
      expect(apiPathAllowed('repos/acme/web/issues/../labels', ['repos/acme/web/issues/*/labels'])).toBe(false)

      const f = fixture()
      const w = await world(f)
      expect((await request(w, f, { kind: 'api_write', method: 'DELETE', path: 'repos/acme/web', body: null })).kind).toBe('refused')
      const operationId = await requestedAndApproved(w, f, { kind: 'api_write', method: 'POST', path: '/repos/acme/web/issues/4/labels', body: { labels: ['bug'] } })
      expect((await executeApprovedOperation(pool, f.deps, operationId)).kind).toBe('succeeded')
      expect(f.ghCalls()[0]).toEqual({
        args: 'api --hostname github.com --method POST repos/acme/web/issues/4/labels --input - token-for:github.com\n',
        stdin: '{"labels":["bug"]}',
      })
    })
  })

  describe('claims, crashes and Stop', () => {
    it('runs a concurrently consumed approval once', async () => {
      const f = fixture()
      const w = await world(f)
      const operationId = await requestedAndApproved(w, f, { kind: 'issue_comment', issue: 9, body: 'done' })

      const results = await Promise.all([1, 2, 3].map(() => executeApprovedOperation(pool, f.deps, operationId)))

      expect(results.filter((result) => result.kind === 'succeeded')).toHaveLength(1)
      expect(f.ghCalls().filter((call) => call.args.startsWith('issue comment'))).toHaveLength(1)
    })

    it('a Stop that lands after the checks still beats the claim', async () => {
      const f = fixture()
      const w = await world(f)
      const operationId = await requestedAndApproved(w, f, { kind: 'issue_comment', issue: 9, body: 'done' })
      await requestCancel(pool, w.task.id)

      expect(await claimOperation(pool, operationId)).toBeUndefined()
      expect((await loadOperation(pool, operationId))?.state).toBe('approved')
    })

    it('a hung tool ends uncertain at its timeout, process group killed, never stuck dispatching', async () => {
      const f = fixture()
      const w = await world(f)
      const hang = join(f.dir, 'bin', 'gh-hang')
      writeFileSync(hang, '#!/bin/sh\ncat >/dev/null\nsleep 30 &\nwait\n')
      chmodSync(hang, 0o755)
      const operationId = await requestedAndApproved(w, f, { kind: 'issue_comment', issue: 9, body: 'done' })
      const started = Date.now()

      const result = await executeApprovedOperation(pool, { ...f.deps, ghBin: hang, toolTimeoutMs: 300 }, operationId)

      expect(result.kind).toBe('uncertain')
      expect(Date.now() - started).toBeLessThan(5000)
      expect((await loadOperation(pool, operationId))?.state).toBe('uncertain')
    })

    it('grants the durable claim to exactly one of many racing claimers', async () => {
      const f = fixture()
      const w = await world(f)
      const operationId = await requestedAndApproved(w, f, { kind: 'issue_comment', issue: 9, body: 'done' })

      const claims = await Promise.all(Array.from({ length: 5 }, () => claimOperation(pool, operationId)))

      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
    })

    it('an unprovable comment becomes uncertain, is posted, and is not re-posted', async () => {
      const f = fixture()
      const w = await world(f)
      const lost = await requestedAndApproved(w, f, { kind: 'pr_comment', pr: 3, body: 'lost' })
      const found = await requestedAndApproved(w, f, { kind: 'pr_comment', pr: 4, body: 'found' })
      await pool.query(`UPDATE autonomous_operations SET state = 'dispatching', claimed_at = now() WHERE id = ANY ($1)`, [[lost, found]])
      f.respond('pr-view', JSON.stringify({ comments: [{ body: `found\n\n<!-- relay-op:${found} -->` }] }))

      const reconciled = await reconcileDispatching(pool, f.deps, w.workspaceId)

      expect(reconciled).toEqual(expect.arrayContaining([{ operationId: lost, state: 'uncertain' }, { operationId: found, state: 'succeeded' }]))
      expect(f.ghCalls().every((call) => call.args.startsWith('pr view'))).toBe(true)
      expect(f.actions.some((action) => action.kind === 'post' && action.text.includes('cannot prove'))).toBe(true)
    })

    it('Stop while an operation awaits approval cancels it, and a later click executes nothing', async () => {
      const f = fixture()
      const w = await world(f)
      const requested = await request(w, f, { kind: 'pr_comment', pr: 3, body: 'x' })
      if (requested.kind !== 'requested') throw new Error('expected requested')
      await requestCancel(pool, w.task.id)

      expect(await cancelTaskOperations(pool, f.deps, w.task.id)).toBe(1)
      const { rows: linked } = await pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [requested.approvalId])
      expect(linked[0]?.status).toBe('timed_out')
      const late = await resolveApproval(pool, { workspaceId: w.workspaceId, approvalId: requested.approvalId, option: 'approve', resolverPrincipalId: w.requester, receiptKey: KEY })
      expect(late.outcome).toBe('already_resolved')

      expect((await executeApprovedOperation(pool, f.deps, requested.operationId)).kind).toBe('not_claimed')
      expect((await loadOperation(pool, requested.operationId))?.state).toBe('cancelled')
      expect(f.ghCalls()).toHaveLength(0)
    })

    it('refuses an approval without a valid receipt', async () => {
      const f = fixture()
      const w = await world(f)
      const requested = await request(w, f, { kind: 'pr_comment', pr: 3, body: 'x' })
      if (requested.kind !== 'requested') throw new Error('expected requested')
      // Approved by a plain SQL update: no receipt.
      await pool.query(`UPDATE approvals SET status = 'approved', selected_option = 'approve' WHERE id = $1`, [requested.approvalId])
      await pool.query(`UPDATE autonomous_operations SET state = 'approved' WHERE id = $1`, [requested.operationId])

      expect((await executeApprovedOperation(pool, f.deps, requested.operationId)).kind).toBe('refused')
      expect(f.ghCalls()).toHaveLength(0)
    })
  })

  describe('mcp_write operations', () => {
    async function invocation(w: World): Promise<{ workspaceId: string; taskId: string; invocationId: string; leaseGeneration: number }> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO autonomous_invocations (workspace_id, task_id, account_key, purpose, run_id, session_id, principal_id, reserved_usd)
         VALUES ($1, $2, 'claude', 'worker', $3, $4, $5, 1) RETURNING id`,
        [w.workspaceId, w.task.id, w.runId, w.task.sessionId, w.requester],
      )
      return { workspaceId: w.workspaceId, taskId: w.task.id, invocationId: rows[0]?.id ?? '', leaseGeneration: w.task.leaseGeneration }
    }

    it('pends with one card, executes the stored args once after approval, and never again after a crash', async () => {
      const f = fixture()
      const w = await world(f)
      const context = await invocation(w)
      const operations = createMcpOperations(pool, f.deps)
      const call = { server: 'linear', tool: 'create_issue', args: { title: 'Bug' } }

      const first = await operations.requestMcpOperation(context, call)
      const repeat = await operations.requestMcpOperation(context, call)
      expect(first.kind).toBe('pending')
      expect(repeat).toEqual(first)
      expect(cards(f)).toHaveLength(1)

      const operationId = first.kind === 'pending' ? first.operationId : ''
      const operation = await loadOperation(pool, operationId)
      await approve(w, operation?.approvalId ?? '')
      expect(await operations.requestMcpOperation(context, call)).toEqual({ kind: 'execute', operationId, args: { title: 'Bug' } })
      expect((await operations.requestMcpOperation(context, call)).kind).toBe('refused')

      // The daemon dies before the gateway reports.
      expect(await reconcileDispatching(pool, f.deps, w.workspaceId)).toEqual([{ operationId, state: 'uncertain' }])
      await operations.recordOperationOutcome(context, operationId, { ok: true, result: {} })
      expect((await loadOperation(pool, operationId))?.state).toBe('uncertain')
      const after = await operations.requestMcpOperation(context, call)
      expect(after.kind).toBe('pending')
      expect(after).not.toEqual(first)
    })

    it('after the bridge deadline creates no operation or card, and leaves an approved call unclaimed', async () => {
      const f = fixture()
      const w = await world(f)
      const context = await invocation(w)
      const operations = createMcpOperations(pool, f.deps)
      const call = { server: 'linear', tool: 'create_issue', args: { title: 'Late' } }
      const expired = AbortSignal.abort()

      expect(await operations.requestMcpOperation(context, call, expired)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('deadline') })
      expect(cards(f)).toHaveLength(0)

      const pending = await operations.requestMcpOperation(context, call)
      const operationId = pending.kind === 'pending' ? pending.operationId : ''
      await approve(w, (await loadOperation(pool, operationId))?.approvalId ?? '')
      expect((await operations.requestMcpOperation(context, call, expired)).kind).toBe('refused')
      expect((await loadOperation(pool, operationId))?.state).toBe('approved')
      expect(await operations.requestMcpOperation(context, call)).toMatchObject({ kind: 'execute', operationId })
    })

    it('records the outcome of a dispatched call and refuses a secret in the arguments or a stale invocation', async () => {
      const f = fixture()
      const w = await world(f)
      const context = await invocation(w)
      const operations = createMcpOperations(pool, f.deps)
      const call = { server: 'linear', tool: 'comment', args: { body: 'ok' } }
      const pending = await operations.requestMcpOperation(context, call)
      const operationId = pending.kind === 'pending' ? pending.operationId : ''
      await approve(w, (await loadOperation(pool, operationId))?.approvalId ?? '')
      await operations.requestMcpOperation(context, call)

      // Only the invocation the call was handed to may settle it.
      await operations.recordOperationOutcome({ ...context, invocationId: randomUUID() }, operationId, { ok: false, result: {} })
      expect((await loadOperation(pool, operationId))?.state).toBe('dispatching')
      await operations.recordOperationOutcome(context, operationId, { ok: true, result: { id: 1 } })
      expect((await loadOperation(pool, operationId))?.state).toBe('succeeded')

      expect((await operations.requestMcpOperation(context, { ...call, args: { body: `ghp_${'B'.repeat(36)}` } })).kind).toBe('refused')
      expect((await operations.requestMcpOperation({ ...context, leaseGeneration: context.leaseGeneration + 1 }, call)).kind).toBe('refused')
    })
  })
})
