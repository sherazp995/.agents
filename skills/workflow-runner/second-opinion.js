export const meta = {
  name: 'second-opinion',
  description: 'Ask Claude for one read-only second opinion on a prompt (used when Codex hosts work-council or general-review)',
  phases: [{ title: 'Ask', detail: 'one read-only Claude agent answers the prompt' }],
}

// args: { prompt }. Returns { text } with Claude's answer, or { error } when there is no prompt
// or the agent failed. The agent runs read-only, so it can read the repository but not change it.
const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
if (!prompt) return { error: 'missing_prompt' }

phase('Ask')
const text = await agent(prompt, { label: 'second-opinion', phase: 'Ask', agentType: 'Plan' })
return typeof text === 'string' && text.trim() ? { text } : { error: 'no_answer' }
