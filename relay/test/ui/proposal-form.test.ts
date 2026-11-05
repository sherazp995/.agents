import { describe, expect, it } from 'vitest'
import { checkProposalRows, type Proposal, type ProposedRow } from '../../src/projects/proposals.js'
import { buildProposerPrompt, checkAnswer } from '../../src/projects/team-proposer.js'
import type { Persona, Project, TeamMember } from '../../src/projects/store.js'
import { rowsFromForm } from '../../src/ui/pages/proposals.js'

const persona = { kind: 'existing', personaId: '00000000-0000-4000-8000-000000000001' } as const
const keep: ProposedRow = { kind: 'keep', memberId: '00000000-0000-4000-8000-00000000000a', name: 'Ada', role: 'lead', isLead: true, persona, reason: '' }
const keepBob: ProposedRow = { kind: 'keep', memberId: '00000000-0000-4000-8000-00000000000b', name: 'Bob', role: 'developer', isLead: false, persona, reason: '' }
const add: ProposedRow = { kind: 'add', name: 'Cy', role: 'tester', isLead: false, persona, reason: '' }
const proposal = { rows: [keep, keepBob, add] } as unknown as Proposal

describe('the review form', () => {
  it('applies an edit to a kept member as a change, leaves an untouched one alone, and skips an unticked add', () => {
    const form = new URLSearchParams({ lead: '0', name_0: 'Ada', role_0: 'lead', name_1: 'Bob', role_1: 'backend developer', name_2: 'Cy', role_2: 'tester' })
    const rows = rowsFromForm(proposal, form)
    expect(rows.map((row) => [row.kind, row.role, row.included])).toEqual([
      ['keep', 'lead', false],
      ['change', 'backend developer', true],
      ['add', 'tester', false],
    ])
  })
})

describe('checking proposed rows', () => {
  it('refuses two rows for the same member', () => {
    expect(() => checkProposalRows([keep, { ...keep, kind: 'remove' }])).toThrow('only one row')
    expect(checkProposalRows([keep, keepBob, add])).toHaveLength(3)
  })
})

describe('reading a proposer answer', () => {
  it('turns a "keep" that differs from today\'s member into a change, so a lead handover can be approved', () => {
    const ada = { id: keep.memberId, name: 'Ada', role: 'lead', isLead: true, personaId: persona.personaId, personaName: 'Lead' } as unknown as TeamMember
    const library = [{ id: persona.personaId, name: 'Lead' }] as unknown as Persona[]
    const rows = checkAnswer({ rows: [{ ...keep, isLead: false }, { ...add, isLead: true }] }, [ada], library)
    expect(rows.map((row) => [row.kind, row.name, row.isLead])).toEqual([
      ['change', 'Ada', false],
      ['add', 'Cy', true],
    ])
    expect(checkAnswer({ rows: [keep] }, [ada], library)[0]?.kind).toBe('keep')
    // A member with no row could never be moved off the lead, so the answer is refused.
    expect(() => checkAnswer({ rows: [{ ...add, isLead: true }] }, [ada], library)).toThrow('left out Ada')
  })
})

describe('names Relay gives new members', () => {
  const library = [{ id: persona.personaId, name: 'Lead' }] as unknown as Persona[]
  const ada = { id: keep.memberId, name: 'Ada', role: 'lead', isLead: true, personaId: persona.personaId, personaName: 'Lead' } as unknown as TeamMember
  const answer = (name: string) => ({ rows: [keep, { ...add, name, role: 'Backend developer: Rails models' }] })

  it('refuses a role or persona name as a new member\'s name, and takes a person\'s name', () => {
    for (const name of ['Lead', 'QA Engineer', 'Code Reviewer', 'Rails Developer', 'QA']) {
      expect(() => checkAnswer(answer(name), [ada], library)).toThrow(`"${name}", a role or persona name`)
    }
    expect(checkAnswer(answer('Leah'), [ada], library)[1]?.name).toBe('Leah')
    expect(checkAnswer(answer('Dev'), [ada], library)[1]?.name).toBe('Dev')
    // The same name as the role, or as the persona (new or from the library), is refused even without a job word.
    expect(() => checkAnswer({ rows: [keep, { ...add, name: 'Sherlock', role: 'sherlock' }] }, [ada], library)).toThrow('"Sherlock"')
    const sherlock = { kind: 'new', name: 'Sherlock', text: '# Sherlock' } as const
    expect(() => checkAnswer({ rows: [keep, { ...add, name: 'Sherlock', role: 'investigator', persona: sherlock }] }, [ada], library)).toThrow('"Sherlock"')
    const withWatson = [...library, { id: '00000000-0000-4000-8000-000000000002', name: 'Watson' }] as unknown as Persona[]
    const watson = { kind: 'existing', personaId: '00000000-0000-4000-8000-000000000002' } as const
    expect(() => checkAnswer({ rows: [keep, { ...add, name: 'watson', role: 'assistant', persona: watson }] }, [ada], withWatson)).toThrow('"watson"')
  })

  it('asks for personal names and names the ones to avoid', () => {
    const prompt = buildProposerPrompt({ project: { name: 'Widget', folder: '/srv/w', repos: [] } as unknown as Project, repos: [], members: [], personas: [] })
    expect(prompt).toContain('short personal first name')
    expect(prompt).toContain('Do not use these names: Mycroft')
  })
})
