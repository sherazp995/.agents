import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
import { admitInvocation, settleInvocation } from '../../src/autonomous/invocations.js'
import { acquireLease, loadTask, requestCancel } from '../../src/autonomous/store.js'
import {
  createAutonomousGuard,
  currentInvocationLookup,
  ignoredReadOnlyMcpEntries,
  type GuardDeps,
} from '../../src/autonomous/guard.js'
import type { InvocationContext, McpCallRequest, McpOperationAnswer, McpOperations } from '../../src/autonomous/mcp-protocol.js'
import type { Policy } from '../../src/config/schema.js'
import { HookBridgeServer } from '../../src/engine/hook-bridge.js'
import type { HookDecisionRequest } from '../../src/engine/hook-bridge.js'
import { getTestDatabaseUrl } from '../support/database.js'

const CAPS = { runCapUsd: 100, sessionCapUsd: 100, principalDayCapUsd: 100 }

describe('autonomous guard', () => {
  let pool: Pool
  let relayHome: string

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
    relayHome = await mkdtemp(join(tmpdir(), 'relay-guard-'))
  })

  afterAll(async () => {
    await closePool(pool)
    await rm(relayHome, { recursive: true, force: true })
  })

  type Fixture = {
    context: InvocationContext
    worktree: string
    qaCheckout: string
    elsewhere: string
    killSwitch: { engaged: boolean }
    operations: McpOperations & { calls: McpCallRequest[]; answer: McpOperationAnswer }
    deps: GuardDeps
  }

  /** A task with a leased worker invocation, a worktree, one registered QA checkout and an unregistered folder. */
  async function fixture(policy: Policy['remote_writes'] = undefined): Promise<Fixture> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'P', ['member'])
    const session = await findOrCreateSession(pool, { workspaceId, principalId, adapter: 'slack', threadRef: `C:${randomUUID()}` })
    const run = await createRun(pool, { workspaceId, sessionId: session.id, principalId })
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO autonomous_tasks (workspace_id, session_id, requester_principal_id) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, session.id, principalId],
    )
    const taskId = rows[0]?.id ?? ''
    const lease = await acquireLease(pool, taskId, 'test', 60_000)
    const admission = await admitInvocation(pool, {
      workspaceId,
      taskId,
      accountKey: 'claude',
      purpose: 'worker',
      runId: run.id,
      sessionId: session.id,
      principalId,
      fallbackUsd: 1,
      nestedAllowanceUsd: 0,
      caps: CAPS,
    })
    if (!lease || !admission.admitted) throw new Error('fixture setup failed')
    const worktree = join(relayHome, 'tasks', taskId, 'worktree')
    const qaCheckout = join(relayHome, 'tasks', taskId, 'qa', 'snapshot-1')
    const elsewhere = await mkdtemp(join(tmpdir(), 'relay-guard-elsewhere-'))
    await mkdir(worktree, { recursive: true })
    await mkdir(join(qaCheckout, 'sub'), { recursive: true })
    const killSwitch = { engaged: false }
    const operations = {
      calls: [] as McpCallRequest[],
      answer: { kind: 'pending', operationId: 'op-1' } as McpOperationAnswer,
      async requestMcpOperation(_context: InvocationContext, call: McpCallRequest) {
        operations.calls.push(call)
        return operations.answer
      },
      async recordOperationOutcome() {},
    }
    const deps: GuardDeps = {
      loadTask: (id) => loadTask(pool, id),
      isInvocationCurrent: currentInvocationLookup(pool),
      isKillSwitchEngaged: async () => killSwitch.engaged,
      operations,
      remoteWrites: () => policy,
      qaCheckouts: async () => [qaCheckout],
      defaultBranch: async () => 'main',
      relayHome,
    }
    return {
      context: { workspaceId, taskId, invocationId: admission.invocationId, leaseGeneration: lease.generation },
      worktree,
      qaCheckout,
      elsewhere,
      killSwitch,
      operations,
      deps,
    }
  }

  function bash(command: string, cwd: string, workdir?: string): HookDecisionRequest {
    return {
      toolUseId: 't1',
      toolName: 'Bash',
      sessionId: 's1',
      cwd,
      toolInput: { command, ...(workdir !== undefined ? { workdir } : {}) },
    }
  }

  describe('the checks every call passes first', () => {
    it('allows a plain command for the current invocation', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      expect(await guard.decide(bash('ls -la && git status', f.worktree), f.context)).toMatchObject({ decision: 'allow' })
    })

    it('denies a malformed request, a request without a per-invocation token and a non-Bash tool', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      expect(await guard.decide({ toolName: 'Bash' } as HookDecisionRequest, f.context)).toMatchObject({ decision: 'deny' })
      expect(await guard.decide(bash('ls', f.worktree), undefined)).toMatchObject({ decision: 'deny' })
      expect(await guard.decide({ ...bash('ls', f.worktree), toolName: 'Write' }, f.context)).toMatchObject({ decision: 'deny' })
      expect(await guard.decide({ ...bash('ls', f.worktree), toolInput: {} }, f.context)).toMatchObject({ decision: 'deny' })
    })

    it('denies while the kill switch is engaged', async () => {
      const f = await fixture()
      f.killSwitch.engaged = true
      const guard = createAutonomousGuard(f.deps)
      expect(await guard.decide(bash('ls', f.worktree), f.context)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('kill switch') })
      expect(await guard.decideMcpCall({ server: 's', tool: 't', args: {} }, f.context)).toMatchObject({ decision: 'deny' })
    })

    it("denies a cancelled task's next Bash call", async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      await requestCancel(pool, f.context.taskId)
      expect(await guard.decide(bash('ls', f.worktree), f.context)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('stopped') })
    })

    it('denies a stale lease generation and a settled invocation', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      expect(await guard.decide(bash('ls', f.worktree), { ...f.context, leaseGeneration: f.context.leaseGeneration - 1 })).toMatchObject({
        decision: 'deny',
        reason: expect.stringContaining('superseded'),
      })
      await settleInvocation(pool, f.context.invocationId, 0.5, CAPS)
      expect(await guard.decide(bash('ls', f.worktree), f.context)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('no longer') })
    })

    it('denies a token for another workspace', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      expect(await guard.decide(bash('ls', f.worktree), { ...f.context, workspaceId: randomUUID() })).toMatchObject({ decision: 'deny' })
    })

    it('denies through the bridge when the database fails inside decide', async () => {
      const f = await fixture()
      const broken = createPool(await getTestDatabaseUrl())
      await closePool(broken)
      const guard = createAutonomousGuard({ ...f.deps, loadTask: (id) => loadTask(broken, id) })
      await expect(guard.decide(bash('ls', f.worktree), f.context)).rejects.toThrow()
      const bridge = new HookBridgeServer({ decide: guard.decide })
      await bridge.start()
      try {
        const token = bridge.issueToken(f.context)
        const response = await fetch(bridge.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(bash('ls', f.worktree)),
        })
        expect(await response.json()).toMatchObject({ decision: 'deny' })
      } finally {
        await bridge.stop()
      }
    })
  })

  describe('git commands', () => {
    it('denies a merge in the task worktree', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      expect(await guard.decide(bash('git merge feature', f.worktree), f.context)).toMatchObject({ decision: 'deny' })
      expect(await guard.decide(bash('git merge --no-commit --no-ff origin/main', f.worktree), f.context)).toMatchObject({ decision: 'deny' })
    })

    it('allows `git merge --no-commit --no-ff` in the registered QA checkout, however the directory is named', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      const merge = 'git merge --no-commit --no-ff origin/main'
      expect(await guard.decide(bash(merge, f.qaCheckout), f.context)).toMatchObject({ decision: 'allow' })
      expect(await guard.decide(bash(merge, f.worktree, f.qaCheckout), f.context)).toMatchObject({ decision: 'allow' })
      expect(await guard.decide(bash(`cd ${f.qaCheckout} && ${merge}`, f.worktree), f.context)).toMatchObject({ decision: 'allow' })
      expect(await guard.decide(bash(`git -C '${f.qaCheckout}/sub' merge --no-ff --no-commit x`, f.worktree), f.context)).toMatchObject({
        decision: 'allow',
      })
      expect(await guard.decide(bash(`git -C ${f.qaCheckout} -C sub merge --no-commit --no-ff x`, f.worktree), f.context)).toMatchObject({
        decision: 'allow',
      })
    })

    it('denies the same merge in an unregistered folder or where the target cannot be resolved', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      const merge = 'git merge --no-commit --no-ff origin/main'
      const denied = [
        bash(merge, f.elsewhere),
        bash(`git -C ${f.elsewhere} merge --no-commit --no-ff x`, f.qaCheckout),
        bash(`cd ${f.qaCheckout}; ${merge}`, f.worktree),
        bash(`cd ${f.qaCheckout} || ${merge}`, f.worktree),
        bash(`cd "$QA" && ${merge}`, f.worktree),
        bash(`git -C qa merge --no-commit --no-ff x`, 'relative/cwd'),
        bash(`git -C ${f.qaCheckout}/missing merge --no-commit --no-ff x`, f.worktree),
        bash(`git merge --no-commit --no-ff -s ours x`, f.qaCheckout),
        bash(`git merge --no-commit x`, f.qaCheckout),
        bash(`git merge --no-commit --no-ff $BRANCH`, f.qaCheckout),
        bash(`sh -c "git -C ${f.qaCheckout} merge --no-commit --no-ff x"`, f.worktree),
        bash(`GIT_DIR=${f.worktree}/.git ${merge}`, f.qaCheckout),
        bash(`git --git-dir=${f.worktree}/.git merge --no-commit --no-ff x`, f.qaCheckout),
        bash(`(cd ${f.qaCheckout} && ${merge})`, f.worktree),
      ]
      for (const request of denied) {
        expect(await guard.decide(request, f.context), JSON.stringify(request.toolInput)).toMatchObject({ decision: 'deny' })
      }
    })

    it('ignores a registered checkout outside this task’s qa folder', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard({ ...f.deps, qaCheckouts: async () => [f.elsewhere, f.worktree] })
      expect(await guard.decide(bash('git merge --no-commit --no-ff x', f.elsewhere), f.context)).toMatchObject({ decision: 'deny' })
      expect(await guard.decide(bash('git merge --no-commit --no-ff x', f.worktree), f.context)).toMatchObject({ decision: 'deny' })
    })

    it('finds git however it is quoted, chained, wrapped or nested', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      const denied = [
        'git push origin main',
        'git push origin relay/x:main',
        'git push --force origin relay/x',
        'npm test && git reset --hard HEAD~1',
        'echo $(git push origin main)',
        'echo "`git rebase main`"',
        "bash -lc 'git clean -fdx'",
        'eval "git reset --hard"',
        'ls | xargs git merge',
        '/usr/bin/git merge x',
        'git push origin $BRANCH',
        "git -c alias.x='!git merge' x",
        "git -c core.sshCommand='sh -c evil' fetch",
        'git -c core.pager=evil log',
        'git -c CREDENTIAL.helper=evil fetch',
        'git -c diff.foo.textconv=evil diff',
        'git --config-env=core.fsmonitor=EVIL status',
        'git log --oneline | xargs git log git merge x',
        'xargs git status git push origin main',
        'git --frobnicate status',
        'echo "unterminated',
      ]
      for (const command of denied) {
        expect(await guard.decide(bash(command, f.worktree), f.context), command).toMatchObject({ decision: 'deny' })
      }
      const allowed = [
        'git push origin relay/x',
        'git log --oneline -5 && git diff main...HEAD',
        'git commit -m "undo the git merge from yesterday"',
        'git merge-base main HEAD',
        'git -C sub status 2>&1 | head',
        "git -c user.name='Relay' -c color.ui=never -c advice.detachedHead=false commit -m wip",
        'rg -n "git push" src',
        'gh pr view 12 --json title',
      ]
      for (const command of allowed) {
        expect(await guard.decide(bash(command, f.worktree), f.context), command).toMatchObject({ decision: 'allow' })
      }
    })
  })

  describe('MCP calls', () => {
    it('allows a read-only server/tool and a proxy-enforced server without an operation', async () => {
      const f = await fixture({
        read_only_mcp_tools: ['github/get_pull_request', 'search_docs'],
        proxy_enforced_mcp_servers: ['playwright'],
        allowed_api_paths: [],
      })
      const guard = createAutonomousGuard(f.deps)
      for (const call of [
        { server: 'github', tool: 'get_pull_request', args: { number: 1 } },
        { server: 'playwright', tool: 'browser_click', args: {} },
      ]) {
        expect(await guard.decideMcpCall(call, f.context)).toEqual({ decision: 'allow' })
      }
      expect(f.operations.calls).toHaveLength(0)
    })

    it('ignores a bare tool entry, so that tool still needs an operation, and reports it', async () => {
      const policy = { read_only_mcp_tools: ['search_docs', 'docs/get'], proxy_enforced_mcp_servers: [], allowed_api_paths: [] }
      const f = await fixture(policy)
      const guard = createAutonomousGuard(f.deps)
      expect(await guard.decideMcpCall({ server: 'docs', tool: 'search_docs', args: {} }, f.context)).toMatchObject({ decision: 'pending' })
      expect(ignoredReadOnlyMcpEntries(policy)).toEqual(['search_docs'])
    })

    it('creates no operation once the bridge deadline has answered', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      const controller = new AbortController()
      controller.abort()
      expect(await guard.decideMcpCall({ server: 'github', tool: 'create_comment', args: {} }, f.context, controller.signal)).toMatchObject({
        decision: 'deny',
      })
      expect(f.operations.calls).toHaveLength(0)
    })

    it('maps a write to pending, an approved one to execute, and a refusal to deny', async () => {
      const f = await fixture({ read_only_mcp_tools: ['other/get_pull_request'], proxy_enforced_mcp_servers: [], allowed_api_paths: [] })
      const guard = createAutonomousGuard(f.deps)
      const call = { server: 'github', tool: 'get_pull_request', args: { number: 1 } }
      expect(await guard.decideMcpCall(call, f.context)).toEqual({
        decision: 'pending',
        operationId: 'op-1',
        message: "operation op-1 needs the requester's approval in the thread; continue other work",
      })
      f.operations.answer = { kind: 'execute', operationId: 'op-1', args: { number: 1 } }
      expect(await guard.decideMcpCall(call, f.context)).toEqual({ decision: 'execute', operationId: 'op-1', args: { number: 1 } })
      f.operations.answer = { kind: 'refused', reason: 'body holds a credential' }
      expect(await guard.decideMcpCall(call, f.context)).toEqual({ decision: 'deny', reason: 'body holds a credential' })
      expect(f.operations.calls).toEqual([call, call, call])
    })

    it('denies a malformed call, a call without a token and a stale invocation before asking for an operation', async () => {
      const f = await fixture()
      const guard = createAutonomousGuard(f.deps)
      expect(await guard.decideMcpCall({ server: '', tool: 't', args: {} }, f.context)).toMatchObject({ decision: 'deny' })
      expect(await guard.decideMcpCall({ server: 's', tool: 't', args: {} }, undefined)).toMatchObject({ decision: 'deny' })
      expect(await guard.decideMcpCall({ server: 's', tool: 't', args: {} }, { ...f.context, leaseGeneration: 0 })).toMatchObject({ decision: 'deny' })
      expect(f.operations.calls).toHaveLength(0)
    })
  })
})
