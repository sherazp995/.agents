/**
 * "Start from template": the starter personas (made only when the library
 * has none of that name) and a roster of a lead, two developers, a reviewer
 * and QA using them. Each step is its own audited save; the first failure
 * stops the run, and the result says what was made.
 */

import { auditedChange } from '../ui/audit.js'
import { createPersona, type LibraryContext } from './persona-library.js'
import { addMember, listPersonas } from './store.js'

type StarterPersona = { readonly name: string; readonly text: string }

export const STARTER_PERSONAS: Readonly<Record<'lead' | 'developer' | 'reviewer' | 'qa', StarterPersona>> = {
  lead: {
    name: 'Lead',
    text: `# Lead

You lead this project's team. You read the request, split it into tasks, give each task to a member, and merge their work into the request branch.

- When a member is stuck, decide for them from evidence in the repo; ask the user only for product calls or when there is no evidence.
- You are the only member who talks in the Slack thread: post the task list, short progress and the final report.
- Commit locally. Never push or open a PR unless the user asked for it in the thread.
`,
  },
  developer: {
    name: 'Developer',
    text: `# Developer

You build the task the lead gives you, in your own worktree, and commit it locally.

- Follow the repo's own instructions and tests; prove the change with the narrowest tests.
- When something is unclear or blocked, ask the lead instead of guessing.
- Never push.
`,
  },
  reviewer: {
    name: 'Reviewer',
    text: `# Reviewer

You review the request branch once the lead merges into it: correctness, regressions, security, and missing tests.

- Report findings with file and line, severity, and the fix; send them to the lead.
- Do not rewrite the work yourself.
`,
  },
  qa: {
    name: 'QA',
    text: `# QA

You check the request branch works for a user: run it, follow the main path and the edge cases, and report what fails with steps to reproduce.

- Send results to the lead.
`,
  },
}

const STARTER_ROSTER: readonly { readonly persona: keyof typeof STARTER_PERSONAS; readonly name: string; readonly role: string; readonly isLead: boolean }[] = [
  { persona: 'lead', name: 'Lead', role: 'lead', isLead: true },
  { persona: 'developer', name: 'Developer 1', role: 'developer', isLead: false },
  { persona: 'developer', name: 'Developer 2', role: 'developer', isLead: false },
  { persona: 'reviewer', name: 'Reviewer', role: 'reviewer', isLead: false },
  { persona: 'qa', name: 'QA', role: 'qa', isLead: false },
]

export type StarterResult = {
  readonly personasMade: readonly string[]
  readonly membersMade: readonly string[]
  /** Set when a step failed; everything listed above was made before it. */
  readonly error?: string
}

export async function applyStarterTeam(ctx: LibraryContext, projectId: string): Promise<StarterResult> {
  const personasMade: string[] = []
  const membersMade: string[] = []
  try {
    const byName = new Map((await listPersonas(ctx.pool, ctx.workspaceId)).map((persona) => [persona.name.toLowerCase(), persona.id]))
    const personaIds = new Map<string, string>()
    for (const key of Object.keys(STARTER_PERSONAS) as (keyof typeof STARTER_PERSONAS)[]) {
      const starter = STARTER_PERSONAS[key]
      const existing = byName.get(starter.name.toLowerCase())
      if (existing !== undefined) {
        personaIds.set(key, existing)
        continue
      }
      personaIds.set(key, await createPersona(ctx, starter.name, starter.text))
      personasMade.push(starter.name)
    }
    for (const member of STARTER_ROSTER) {
      const personaId = personaIds.get(member.persona)
      if (personaId === undefined) throw new Error(`no persona for ${member.persona}`)
      await auditedChange(ctx.pool, ctx.workspaceId, ctx.actor, { route: ctx.route, outcome: 'member added from template', detail: { projectId, name: member.name } }, (client) =>
        // Template members run on Claude with its default model until the owner changes them on the hub.
        addMember(client, ctx.workspaceId, projectId, { name: member.name, role: member.role, personaId, isLead: member.isLead, client: 'claude', model: null }),
      )
      membersMade.push(member.name)
    }
    return { personasMade, membersMade }
  } catch (error) {
    return { personasMade, membersMade, error: error instanceof Error ? error.message : String(error) }
  }
}
