import { describe, expect, it } from 'vitest'
import { createAutonomousGuard, remoteWrites, type GuardDeps, type ShellWriteAnswer } from '../../src/autonomous/guard.js'
import type { AutonomousTask } from '../../src/autonomous/store.js'
import type { HookDecisionRequest } from '../../src/engine/hook-bridge.js'

const TASK = { id: 't1', workspaceId: 'w1', leaseGeneration: 2, cancelRequestedAt: null } as AutonomousTask
const CONTEXT = { workspaceId: 'w1', taskId: 't1', runId: 'r1', leaseGeneration: 2 }

function bash(command: string, toolName = 'Bash'): HookDecisionRequest {
  return { toolUseId: 'u', toolName, sessionId: 's', cwd: '/repo', toolInput: { command } } as HookDecisionRequest
}

function guardWith(answer: ShellWriteAnswer, overrides: Partial<GuardDeps> = {}) {
  const requested: { command: string; cwd: string }[] = []
  const guard = createAutonomousGuard({
    loadTask: async (id) => (id === TASK.id ? TASK : undefined),
    isKillSwitchEngaged: async () => false,
    requestShellWrite: async (_context, write) => {
      requested.push(write)
      return answer
    },
    ...overrides,
  })
  return { guard, requested }
}

describe('remoteWrites', () => {
  it('names pushes and gh writes, however they are quoted, chained or nested', () => {
    expect(remoteWrites('git push origin main')).toEqual(['git push'])
    expect(remoteWrites('git -C /repo push')).toEqual(['git push'])
    expect(remoteWrites('npm test && "git" push')).toEqual(['git push'])
    expect(remoteWrites("sh -c 'git push --force'")).toEqual(['git push'])
    expect(remoteWrites('echo $(gh pr create --title x)')).toEqual(['gh pr create'])
    expect(remoteWrites('gh -R o/r issue comment 3 --body hi')).toEqual(['gh issue comment'])
    expect(remoteWrites('gh api repos/o/r/issues -f title=x')).toEqual(['gh api POST'])
    expect(remoteWrites('gh api -X DELETE repos/o/r/git/refs/heads/x')).toEqual(['gh api DELETE'])
    expect(remoteWrites('gh api -X GET repos/o/r/issues/1 --method=PATCH -f title=x')).toEqual(['gh api PATCH'])
    expect(remoteWrites('gh label clone o/src --repo o/dest --force')).toEqual(['gh label clone'])
  })

  it('lets reads and local git through', () => {
    for (const command of ['git status', 'git commit -m x', 'git fetch origin', 'gh pr view 3', 'gh pr checks', 'gh repo clone o/r', 'gh pr checkout 3', 'gh api repos/o/r/pulls', 'gh api -X GET search/issues -f q=x', 'gh auth status', 'ls -la']) {
      expect(remoteWrites(command)).toEqual([])
    }
  })

  it('treats a substituted git or gh subcommand as a write, and an unparsable command as an error', () => {
    expect(remoteWrites('git $SUB')).toEqual(['git with a substituted subcommand'])
    expect(remoteWrites('gh $(echo pr) create')).toEqual(['gh with a substituted command'])
    expect(remoteWrites('echo "unterminated')).toHaveProperty('error')
  })
})

describe('the guard', () => {
  it('allows a command with no remote write without asking', async () => {
    const { guard, requested } = guardWith({ kind: 'pending' })
    expect(await guard.decide(bash('pnpm test'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(await guard.decide(bash('', 'Edit'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(requested).toEqual([])
  })

  it('holds a push for approval, then lets the approved command run', async () => {
    const pending = guardWith({ kind: 'pending' })
    expect(await pending.guard.decide(bash('git push origin x'), CONTEXT)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('approval') })
    expect(pending.requested).toEqual([{ command: 'git push origin x', cwd: '/repo' }])

    expect(await guardWith({ kind: 'approved' }).guard.decide(bash('git push origin x'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(await guardWith({ kind: 'refused', reason: 'no' }).guard.decide(bash('git push origin x'), CONTEXT)).toEqual({ decision: 'deny', reason: 'no' })
  })

  it('denies without a token, on the kill switch, for a stopped task and for a stale lease', async () => {
    const { guard } = guardWith({ kind: 'approved' })
    expect(await guard.decide(bash('ls'), undefined)).toMatchObject({ decision: 'deny' })
    expect(await guard.decide(bash('ls'), { ...CONTEXT, leaseGeneration: 1 })).toMatchObject({ decision: 'deny' })
    expect(await guardWith({ kind: 'approved' }, { isKillSwitchEngaged: async () => true }).guard.decide(bash('ls'), CONTEXT)).toMatchObject({ decision: 'deny' })
    const stopped = guardWith({ kind: 'approved' }, { loadTask: async () => ({ ...TASK, cancelRequestedAt: new Date() }) })
    expect(await stopped.guard.decide(bash('ls'), CONTEXT)).toMatchObject({ decision: 'deny' })
  })
})
