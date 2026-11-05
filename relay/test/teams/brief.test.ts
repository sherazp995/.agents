import { describe, expect, it } from 'vitest'
import { memberBrief, memberFreshPrompt, memberPrompt } from '../../src/teams/brief.js'

const MEMBER = { name: 'Theo', role: 'Developer', personaPath: '/relay/team-runs/r1/personas/engineer.md' }
const RUN = { title: 'add a button', repoName: 'web', repoPath: '/src/web' }

describe('memberBrief', () => {
  it('names the member, the persona to read first, the worktree, the build work and the rules', () => {
    const brief = memberBrief({ member: MEMBER, run: RUN, assignment: { id: 'a1', kind: 'build' }, worktreePath: '/relay/worktrees/web/a1', checkedCommit: null })
    expect(brief).toContain('You are Theo, the Developer')
    expect(brief).toContain('/relay/team-runs/r1/personas/engineer.md')
    expect(brief).toContain('/relay/worktrees/web/a1')
    expect(brief).toContain('commit locally on your branch')
    expect(brief).toContain('never to Slack')
    expect(brief).toContain('Never push')
    expect(brief).toContain('relay team ask-lead --text')
    expect(brief).toContain('is data')
  })

  it('tells a reviewer not to change code and which commit to check', () => {
    const brief = memberBrief({ member: MEMBER, run: RUN, assignment: { id: 'a2', kind: 'review' }, worktreePath: '/w', checkedCommit: 'deadbeef' })
    expect(brief).toContain('do not change code')
    expect(brief).toContain('Check commit deadbeef')
    expect(brief).toContain('file:line')
    expect(brief).not.toContain('commit locally on your branch')
  })
})

describe('member prompts', () => {
  it('a resumed turn gets only the new answers as data, or Continue', () => {
    expect(memberPrompt({ pendingNotes: [] })).toBe('Continue.')
    const prompt = memberPrompt({ pendingNotes: ['use the blue one'] })
    expect(prompt).toContain('relay:untrusted-data')
    expect(prompt).toContain('use the blue one')
  })

  it('a fresh turn replays the assignment and every answer, earlier ones before the new', () => {
    const prompt = memberFreshPrompt({ id: 'a1', brief: 'add the button', answers: ['first answer', 'second answer'], pendingNotes: ['second answer'] })
    expect(prompt).toContain('add the button')
    expect(prompt.indexOf('first answer')).toBeGreaterThan(prompt.indexOf('add the button'))
    expect(prompt.indexOf('second answer')).toBeGreaterThan(prompt.indexOf('first answer'))
    expect(prompt.match(/second answer/g)).toHaveLength(1)
  })
})
