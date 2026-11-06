import { describe, expect, it } from 'vitest'
import { createAutonomousGuard, remoteWrites, type GuardDeps, type ShellWriteAnswer } from '../../src/autonomous/guard.js'
import type { AutonomousTask } from '../../src/autonomous/store.js'
import type { Assignment } from '../../src/teams/types.js'
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

  it('denies relay ui however it is wrapped, without asking, even when approvals would pass', async () => {
    const { guard, requested } = guardWith({ kind: 'approved' })
    for (const command of ['relay ui', '/usr/local/bin/relay ui --no-open', 'env FOO=1 relay ui', 'echo x && relay ui', 'sh -c "relay ui"', 'relay --verbose ui']) {
      expect(await guard.decide(bash(command), CONTEXT)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('relay ui') })
    }
    // Other relay commands and the word "ui" elsewhere still run.
    expect(await guard.decide(bash('relay live say --text ui'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(await guard.decide(bash('ls ui && relay notify hi'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(requested).toEqual([])
  })

  it('lets relay team propose run without asking: it is not a remote write, and only the owner approves the proposal', async () => {
    const { guard, requested } = guardWith({ kind: 'pending' })
    for (const command of ['relay team propose', '/usr/local/bin/relay team propose']) {
      expect(await guard.decide(bash(command), CONTEXT)).toMatchObject({ decision: 'allow' })
    }
    expect(await guard.decide(bash('relay ui team'), CONTEXT)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('relay ui') })
    expect(requested).toEqual([])
  })

  it('holds a push for approval, then lets the approved command run', async () => {
    const pending = guardWith({ kind: 'pending' })
    expect(await pending.guard.decide(bash('git push origin x'), CONTEXT)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('approval') })
    expect(pending.requested).toEqual([{ command: 'git push origin x', cwd: '/repo' }])

    expect(await guardWith({ kind: 'approved' }).guard.decide(bash('git push origin x'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(await guardWith({ kind: 'refused', reason: 'no' }).guard.decide(bash('git push origin x'), CONTEXT)).toEqual({ decision: 'deny', reason: 'no' })
  })

  it('refuses a remote write run with anything else before asking, and still refuses what it cannot parse', async () => {
    const { guard, requested } = guardWith({ kind: 'approved' })
    for (const command of ['git add . && git push', 'git push && gh pr create --title x', 'echo origin | xargs git push', 'sh -c "git push && echo done"', 'echo $(git push)', '(git push)']) {
      expect(await guard.decide(bash(command), CONTEXT)).toEqual({ decision: 'deny', reason: expect.stringContaining('run each remote write as its own command') })
    }
    expect(await guard.decide(bash('git push "unterminated'), CONTEXT)).toEqual({ decision: 'deny', reason: expect.stringContaining('could not parse') })
    expect(requested).toEqual([])
    expect(await guard.decide(bash('pnpm test && git status | cat'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(await guard.decide(bash('git push -u origin feature-x 2>&1'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(requested).toEqual([{ command: 'git push -u origin feature-x 2>&1', cwd: '/repo' }])
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

describe('the guard for a team member', () => {
  const ASSIGNMENT = { id: 'a1', workspaceId: 'w1', taskId: 't1', state: 'running', leaseGeneration: 5 } as Assignment
  // The token carries the assignment's generation, not the lead's lease generation (2).
  const MEMBER = { ...CONTEXT, leaseGeneration: 5, assignment: { id: 'a1', leaseGeneration: 5 } }

  function memberGuard(answer: ShellWriteAnswer = { kind: 'approved' }, assignment: Assignment | undefined = ASSIGNMENT) {
    return guardWith(answer, { loadAssignment: async (id) => (id === assignment?.id ? assignment : undefined) })
  }

  it('allows ordinary work and ask-lead while the lead holds a different lease generation', async () => {
    const { guard } = memberGuard()
    for (const command of ['pnpm test', 'git commit -m x', 'relay team ask-lead --text "which?"', 'echo relay notify-me']) {
      expect(await guard.decide(bash(command), MEMBER)).toMatchObject({ decision: 'allow' })
    }
    expect(await guard.decide(bash('', 'Edit'), MEMBER)).toMatchObject({ decision: 'allow' })
  })

  it('refuses MCP tools, the Slack and setup commands, and the lead\'s team commands, however wrapped', async () => {
    const { guard, requested } = memberGuard()
    expect(await guard.decide(bash('', 'mcp__slack__post'), MEMBER)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('MCP') })
    const refused = [
      'relay live say --text hi',
      'relay notify done',
      '/usr/local/bin/relay upload f.png',
      'relay ui',
      'relay team propose',
      'relay team assign --member Theo',
      'relay team merge --assignment a1',
      'env X=1 relay team start --title x',
      'pnpm test && sh -c "relay notify hi"',
      'relay "$(echo notify)" hi',
    ]
    for (const command of refused) {
      expect(await guard.decide(bash(command), MEMBER)).toMatchObject({ decision: 'deny' })
    }
    expect(requested).toEqual([])
  })

  it('refuses every remote write outright, without an approval card', async () => {
    const { guard, requested } = memberGuard({ kind: 'approved' })
    for (const command of ['git push origin x', 'gh pr create --title x', 'gh api repos/o/r/issues -f title=x']) {
      expect(await guard.decide(bash(command), MEMBER)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('never push') })
    }
    expect(requested).toEqual([])
  })

  it('denies a stale member generation, an assignment not running, another task\'s assignment, and a guard without the loader', async () => {
    expect(await memberGuard().guard.decide(bash('ls'), { ...MEMBER, assignment: { id: 'a1', leaseGeneration: 4 } })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('superseded') })
    expect(await memberGuard(undefined, { ...ASSIGNMENT, state: 'waiting' }).guard.decide(bash('ls'), MEMBER)).toMatchObject({ decision: 'deny' })
    expect(await memberGuard(undefined, { ...ASSIGNMENT, taskId: 't2' }).guard.decide(bash('ls'), MEMBER)).toMatchObject({ decision: 'deny' })
    expect(await memberGuard().guard.decide(bash('ls'), { ...MEMBER, assignment: { id: 'gone', leaseGeneration: 5 } })).toMatchObject({ decision: 'deny' })
    expect(await guardWith({ kind: 'approved' }).guard.decide(bash('ls'), MEMBER)).toMatchObject({ decision: 'deny' })
    // The kill switch and a stopped task still apply to members.
    expect(await guardWith({ kind: 'approved' }, { isKillSwitchEngaged: async () => true, loadAssignment: async () => ASSIGNMENT }).guard.decide(bash('ls'), MEMBER)).toMatchObject({ decision: 'deny' })
    expect(await guardWith({ kind: 'approved' }, { loadTask: async () => ({ ...TASK, cancelRequestedAt: new Date() }), loadAssignment: async () => ASSIGNMENT }).guard.decide(bash('ls'), MEMBER)).toMatchObject({ decision: 'deny' })
  })

  it('leaves the lead as before: MCP tools and relay notify run, a push asks for the card', async () => {
    const { guard, requested } = memberGuard({ kind: 'pending' })
    expect(await guard.decide(bash('', 'mcp__slack__post'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(await guard.decide(bash('relay notify hi'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(await guard.decide(bash('relay team assign --member Theo'), CONTEXT)).toMatchObject({ decision: 'allow' })
    expect(await guard.decide(bash('git push origin x'), CONTEXT)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('approval') })
    expect(requested).toHaveLength(1)
  })
})

describe('the guard for a reminder\'s read-only task', () => {
  const READ_ONLY = { ...TASK, readOnly: true } as AutonomousTask
  const readOnlyGuard = (answer: ShellWriteAnswer = { kind: 'approved' }) => guardWith(answer, { loadTask: async (id) => (id === TASK.id ? READ_ONLY : undefined) })

  it('allows reading tools and plain reading commands', async () => {
    const { guard } = readOnlyGuard()
    for (const toolName of ['Read', 'Grep', 'Glob', 'Skill', 'Task', 'WebFetch']) {
      expect(await guard.decide(bash('', toolName), CONTEXT)).toMatchObject({ decision: 'allow' })
    }
    for (const command of ['gh pr list --author @me', 'git log --oneline -5', 'agents-hub search cohabit']) {
      expect(await guard.decide(bash(command), CONTEXT)).toMatchObject({ decision: 'allow' })
    }
  })

  it('refuses editing and MCP tools, which a normal task may call', async () => {
    const { guard } = readOnlyGuard()
    for (const toolName of ['Edit', 'Write', 'NotebookEdit', 'mcp__slack__send_message']) {
      expect(await guard.decide(bash('', toolName), CONTEXT)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('read access only') })
    }
    const { guard: normal } = guardWith({ kind: 'pending' })
    expect(await normal.decide(bash('', 'Edit'), CONTEXT)).toMatchObject({ decision: 'allow' })
  })

  it('refuses remote writes and every relay command without posting an approval card, even when approvals would pass', async () => {
    const { guard, requested } = readOnlyGuard({ kind: 'approved' })
    for (const command of ['git push origin main', 'gh pr create --title x', "sh -c 'gh issue comment 3 --body hi'", 'relay notify hi', 'relay team start', '/usr/local/bin/relay live say --text x']) {
      expect(await guard.decide(bash(command), CONTEXT)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('read access only') })
    }
    expect(requested).toEqual([])
  })
})
