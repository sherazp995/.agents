export const meta = {
  name: 'doing-substantial-work-build',
  description: 'Build plan cards with builder agents, recheck each pass/fail command independently, prove it in the real product, then review and fix until general-review passes',
  whenToUse: 'Steps 3 to 6 of the doing-substantial-work skill, launched from the chat session',
  phases: [
    { title: 'Build', detail: 'one builder agent per card, then an independent recheck of its command' },
    { title: 'Prove', detail: 'run the real product on the core path' },
    { title: 'Review', detail: 'general-review by a fresh lead, a fixer for introduced findings, up to 3 review rounds' },
  ],
}

// args: { repo, plan, intent?, cards: [{ id, title, files?, command, after?, agentType?, model? }],
//         sequential?, proof?, review?, maxAttempts? }
// Cards run in dependency waves: every card whose `after` cards have passed builds at once, so
// cards in one wave must not share files. `sequential: true` (or `parallel: false`) runs one card
// at a time in list order and stops at the first failure.
// proof: { instructions, agentType? } runs after every card passes; omit to skip.
// review: false skips the review loop (only when the user asked to skip it).
//
// Model and effort per stage (cost follows risk):
//   builder  card.model, else the session's model | checker haiku, low
//   proof    sonnet, medium                       | review lead the session's model, high
//   fixer    the session's model

const BUILD_RESULT = {
  type: 'object',
  properties: {
    files_changed: { type: 'array', items: { type: 'string' } },
    command: { type: 'string' },
    exit_code: { type: 'integer' },
    output_tail: { type: 'string', description: 'last 20 lines of the command output' },
    not_done: { type: 'string', description: 'card work that is still missing or blocked; empty when the card is complete. Never put notes here.' },
    notes: { type: 'string', description: 'decisions, caveats and changes outside the card worth reporting; empty if none' },
  },
  required: ['files_changed', 'command', 'exit_code', 'output_tail', 'not_done'],
}

const CHECK_RESULT = {
  type: 'object',
  properties: {
    exit_code: { type: 'integer' },
    output_tail: { type: 'string' },
  },
  required: ['exit_code', 'output_tail'],
}

const PROOF_RESULT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
    observed: { type: 'string', description: 'what happened on the core path, in plain words' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'absolute paths of logs, screenshots, videos' },
  },
  required: ['status', 'observed', 'evidence'],
}

const REVIEW_RESULT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'CHANGES REQUIRED', 'BLOCKED', 'INCOMPLETE'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] },
          origin: { type: 'string', enum: ['introduced', 'pre-existing'] },
          location: { type: 'string', description: 'file:line' },
          summary: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['id', 'severity', 'origin', 'location', 'summary', 'fix'],
      },
      description: 'every finding still open after this round',
    },
  },
  required: ['verdict', 'findings'],
}

const FIX_RESULT = {
  type: 'object',
  properties: {
    files_changed: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' }, description: 'finding ids fixed' },
    not_done: { type: 'string', description: 'findings not fixed and why; empty if none' },
  },
  required: ['files_changed', 'fixed', 'not_done'],
}

if (!args || !args.repo || !Array.isArray(args.cards) || args.cards.length === 0) {
  return { error: 'missing_args', expected: '{ repo, plan, cards: [{ id, title, command }] }' }
}

const maxAttempts = args.maxAttempts || 2
const MAX_REVIEW_ROUNDS = 3
const FIXABLE = ['blocker', 'high', 'medium']

function builderPrompt(card, previous, waveSize) {
  return [
    `You are building one card of a plan in the repository at ${args.repo}. Work only inside it.`,
    `Plan:\n${args.plan || '(not supplied)'}`,
    `Your card: ${card.id}: ${card.title}`,
    card.files ? `Files in scope: ${card.files.join(', ')}` : '',
    `The card is done only when this command exits 0: ${card.command}`,
    'Follow the repository instructions and the writing-specs skill for tests. Run tests narrowly.',
    'Do not commit, push, or change files outside the card unless the command cannot pass otherwise; report any such change.',
    waveSize > 1 ? `${waveSize - 1} other builders are editing other cards in this working tree right now. A failure in a file outside your card is theirs: do not edit it; report it in notes.` : '',
    previous ? `An earlier attempt failed. Its recheck output:\n${previous}\nFind the cause before changing code again.` : '',
    'Finish by running the command and reporting its real exit code and output.',
  ].filter(Boolean).join('\n\n')
}

const build = (card, attempt, previous, waveSize = 1) => agent(builderPrompt(card, previous, waveSize), {
  label: `build:${card.id}#${attempt}`, phase: 'Build', schema: BUILD_RESULT, agentType: card.agentType, model: card.model,
})

// The builder never grades its own work: a separate, cheap agent reruns the command.
const check = (card, label) => agent(
  `In ${args.repo}, run exactly this command and report its exit code and the last 20 lines of output. Do not edit any file.\n\n${card.command}`,
  { label, phase: 'Build', schema: CHECK_RESULT, model: 'haiku', effort: 'low' },
)

// Rechecks a card from its first build; `firstBuild` is the builder's result for attempt 1.
async function finishCard(card, firstBuild) {
  let built = firstBuild
  let previous = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) built = await build(card, attempt, previous)
    if (!built) return { id: card.id, status: 'failed', attempts: attempt, note: 'builder agent died' }
    const checked = await check(card, `check:${card.id}#${attempt}`)
    if (checked && checked.exit_code === 0) {
      const result = { id: card.id, attempts: attempt, files_changed: built.files_changed, not_done: built.not_done, notes: built.notes || '', output_tail: checked.output_tail }
      // A builder that left work undone has not finished the card, whatever the command says.
      return { ...result, status: built.not_done && built.not_done.trim() ? 'incomplete' : 'passed' }
    }
    previous = checked ? checked.output_tail : built.output_tail
    log(`${card.id}: attempt ${attempt} failed the recheck`)
  }
  return { id: card.id, status: 'failed', attempts: maxAttempts, output_tail: previous }
}

phase('Build')
const sequential = args.sequential === true || args.parallel === false
const ids = new Set(args.cards.map((c) => c.id))
const unknown = args.cards.flatMap((c) => (c.after || []).filter((id) => !ids.has(id)).map((id) => `${c.id} after ${id}`))
if (unknown.length) return { error: 'unknown_dependency', unknown }
const resolved = new Set()
for (let grew = true; grew;) {
  grew = false
  for (const c of args.cards) {
    if (!resolved.has(c.id) && (c.after || []).every((id) => resolved.has(id))) { resolved.add(c.id); grew = true }
  }
}
const cyclic = args.cards.filter((c) => !resolved.has(c.id)).map((c) => c.id)
if (cyclic.length) return { error: 'dependency_cycle', cards: cyclic }

const cards = []
const passed = new Set()
let pending = [...args.cards]
while (pending.length) {
  const ready = pending.filter((c) => (c.after || []).every((id) => passed.has(id)))
  const wave = sequential ? ready.slice(0, 1) : ready
  if (wave.length === 0) break // the rest wait on a card that failed (or on a cycle)
  // Builders share one working tree, so the whole wave builds before any recheck runs:
  // a recheck never sees another builder's half-finished edits.
  const firstBuilds = await parallel(wave.map((card) => () => build(card, 1, null, wave.length)))
  for (const [i, card] of wave.entries()) {
    const result = await finishCard(card, firstBuilds[i])
    cards.push(result)
    if (result.status === 'passed') passed.add(card.id)
  }
  pending = pending.filter((c) => !wave.includes(c))
  if (sequential && cards.at(-1).status !== 'passed') {
    log(`Stopping: ${cards.at(-1).id} did not pass, later cards depend on it`)
    break
  }
}
if (pending.length) log(`Not built, waiting on a card that did not pass: ${pending.map((c) => c.id).join(', ')}`)
const skipped = pending.map((c) => c.id)
// A later card or a retry can break a card that already passed, so recheck them all once more.
if (skipped.length === 0 && cards.length > 1 && cards.every((c) => c.status === 'passed')) {
  for (const card of args.cards) {
    const again = await check(card, `final-check:${card.id}`)
    if (!again || again.exit_code !== 0) {
      const result = cards.find((c) => c.id === card.id)
      Object.assign(result, { status: 'regressed', output_tail: again ? again.output_tail : 'checker agent died' })
      log(`${card.id}: passed earlier but fails now`)
    }
  }
}
const allPassed = skipped.length === 0 && cards.every((c) => c.status === 'passed')

let proof = null
if (allPassed && args.proof) {
  phase('Prove')
  proof = await agent(
    `Prove the change works in the real product, repository ${args.repo}.\n\n${args.proof.instructions}\n\n`
      + 'Run it on the core path, keep the evidence as files, and stop every server you started. Do not edit source files.',
    { label: 'prove', phase: 'Prove', schema: PROOF_RESULT, agentType: args.proof.agentType, model: 'sonnet', effort: 'medium' },
  )
}
const proven = allPassed && (!args.proof || (proof && proof.status === 'passed'))

const fixedFiles = []
const changedFiles = () => [...new Set([...cards.flatMap((c) => c.files_changed || []), ...fixedFiles])]

function reviewPrompt(earlier) {
  return [
    `You are the REVIEW LEAD for one general-review single review of uncommitted work in ${args.repo}. You did not write or discuss this change; judge it fresh.`,
    'Read ~/.agents/skills/general-review/SKILL.md sections 1 to 6 and every file they link, and run them yourself, including the Codex lens when codex is installed.'
      + ' Skip the "Modes and ledger" and "Who reviews" coordinator steps: write no ledger record and start no other review lead.',
    'Read only: do not edit files, add tests to the checkout, commit, push, or post anything.',
    `Target: the uncommitted changes in these files: ${changedFiles().join(', ') || '(see git status)'}. Other uncommitted changes in the checkout are not part of this change.`,
    `Intent (requirements only):\n${args.intent || args.plan || '(not supplied)'}`,
    earlier ? `Earlier round findings, now claimed fixed (recheck each; list only those still open):\n${JSON.stringify(earlier, null, 2)}` : '',
    'Return the verdict by the Unified Review Protocol and every finding still open, introduced and pre-existing.',
  ].filter(Boolean).join('\n\n')
}

function fixPrompt(findings) {
  return [
    `You are fixing review findings in the repository at ${args.repo}. Work only inside it.`,
    `Plan:\n${args.plan || '(not supplied)'}`,
    `Fix each of these introduced findings at its root cause, using its fix and verify notes:\n${JSON.stringify(findings, null, 2)}`,
    `Then run every card command and make each one exit 0:\n${args.cards.map((c) => `- ${c.id}: ${c.command}`).join('\n')}`,
    'Follow the repository instructions and the writing-specs skill for tests. Do not commit or push. Report any finding you did not fix and why.',
  ].join('\n\n')
}

// Fresh lead reviews; a fixer fixes introduced blocker, high and medium findings and every card
// command is rechecked; the next round reviews the fix. Stops at PASS or after 3 review rounds.
async function reviewLoop() {
  const rounds = []
  let earlier = null
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    const review = await agent(reviewPrompt(earlier), { label: `review#${round}`, phase: 'Review', schema: REVIEW_RESULT, effort: 'high' })
    if (!review) return { verdict: 'INCOMPLETE', rounds, findings: earlier || [], note: 'review lead died' }
    rounds.push({ round, verdict: review.verdict, open: review.findings.length })
    const fixable = review.findings.filter((f) => f.origin === 'introduced' && FIXABLE.includes(f.severity))
    const done = { verdict: review.verdict, rounds, findings: review.findings }
    if (review.verdict === 'PASS' || fixable.length === 0) return done
    if (round === MAX_REVIEW_ROUNDS) return { ...done, note: `still ${review.verdict} after ${MAX_REVIEW_ROUNDS} review rounds` }
    const fix = await agent(fixPrompt(fixable), { label: `fix#${round}`, phase: 'Review', schema: FIX_RESULT })
    if (!fix) return { ...done, note: 'fix agent died' }
    fixedFiles.push(...fix.files_changed)
    for (const card of args.cards) {
      const checked = await check(card, `recheck:${card.id}#fix${round}`)
      if (!checked || checked.exit_code !== 0) {
        return { ...done, note: `after fix ${round}, ${card.id} fails its command`, output_tail: checked ? checked.output_tail : null }
      }
    }
    earlier = fixable
  }
}

let review = null
if (proven && args.review !== false) {
  phase('Review')
  review = await reviewLoop()
}

// done: reviewed to PASS; ready-for-review: the user skipped the review loop.
let status = 'needs-attention'
if (proven && review && review.verdict === 'PASS') status = 'done'
else if (proven && args.review === false) status = 'ready-for-review'
return {
  status,
  cards,
  skipped,
  proof: proof || (args.proof ? { status: allPassed ? 'blocked' : 'not-run' } : null),
  review,
}
