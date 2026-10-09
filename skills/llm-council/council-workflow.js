export const meta = {
  name: 'llm-council',
  description: 'Run a 5-member council (deliberate -> anonymized peer review -> chairman synthesis) on a question about the current repository',
  phases: [
    { title: 'Deliberate', detail: '5 council members answer independently' },
    { title: 'Peer Review', detail: 'each member ranks every answer (anonymized)' },
    { title: 'Synthesis', detail: 'chairman synthesizes the final answer' },
  ],
}

// args: { question, council } where council is 'engineering' or 'design'; /llm-council picks
// one from the question. council is required, so a wrong or missing choice fails before any
// agent runs. A JSON-encoded object string is parsed as the object.
const parseArgs = (raw) => {
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { return JSON.parse(raw) } catch { return raw }
  }
  return raw
}
const INPUT = parseArgs(args)
const RAW_QUESTION = typeof INPUT === 'string' ? INPUT : INPUT?.question
const QUESTION = typeof RAW_QUESTION === 'string' ? RAW_QUESTION.trim() : ''
const COUNCIL_NAME = INPUT && typeof INPUT === 'object' ? INPUT.council : undefined

const SHARED_RULES = [
  'Ground every claim in the current repository: read the relevant files and cite them as path:line.',
  'Before answering, read and follow the instruction files that exist: CLAUDE.md and AGENTS.md at the repository root, .claude/CLAUDE.md, and the global rules at ~/.claude/CLAUDE.md.',
  'This is advice only: do not edit, create, or delete files, and do not run commands that change state.',
  'If something is not visible in the code or the question, say what you would need instead of guessing.',
  'Be concrete, technical, and decisive.',
].join(' ')

const COUNCILS = {
  engineering: {
    context: `You sit on a code and architecture council for the repository in your working directory. ${SHARED_RULES}`,
    questionHeading: 'QUESTION',
    answerNoun: 'answer',
    deliberateAsk: 'Give your best standalone answer from your lens. Be specific and complete; do not defer to other members.',
    reviewCriteria: 'accuracy, insight, and fit to this codebase',
    chairmanRole: 'Council Chairman',
    chairmanModel: 'opus',
    chairmanAsk:
      "Synthesize the single best answer to the question using the members' answers and their peer rankings." +
      ' Lead with the strongest consensus, graft the best points from runners-up, and explicitly note any' +
      ' meaningful disagreement and your call on it. Verify any claim you keep against the code. Cite files where relevant.',
    // provider 'claude': the subagent answers directly on `model`.
    // provider 'codex': a Claude relay on `relayModel` runs the Codex CLI and returns its answer verbatim.
    //   `reviewModel` (a Claude tier) does that member's structured peer review.
    members: [
      { id: 'M1', provider: 'claude', model: 'opus', lens: 'First-principles architect: reason from fundamentals, name the core problem and the cleanest design; ignore sunk cost.' },
      { id: 'M2', provider: 'claude', model: 'sonnet', lens: 'Pragmatic shipping engineer: weigh effort against payoff, propose the smallest change that works, and flag risk and rollout.' },
      { id: 'M3', provider: 'claude', model: 'haiku', lens: 'Simplicity and YAGNI advocate: push for the least code and least abstraction; prefer deleting over adding.' },
      { id: 'M4', provider: 'codex', model: 'gpt-6-astra', relayModel: 'haiku', reviewModel: 'sonnet', lens: 'Contrarian red-teamer: attack the obvious answer, surface failure modes, edge cases, and where it breaks at scale.' },
      { id: 'M5', provider: 'codex', model: 'gpt-6-astra', relayModel: 'haiku', reviewModel: 'sonnet', lens: 'Conventions and integration steward: make the answer fit existing repository patterns, naming, tests, and instruction-file rules.' },
    ],
  },
  design: {
    context:
      'You sit on a UI/UX design council for the frontend of the repository in your working directory.' +
      ' Respect the design system, tokens, and frontend rules the repository already uses.' +
      ' IMPORTANT: you cannot see pixels. Reason from what the question provides: component code and styles,' +
      ' an HTML mockup, or a written description of the layout and flow. If the visual is not described,' +
      ' state what you would need to see and still reason about the tradeoff in the abstract.' +
      ` ${SHARED_RULES}`,
    questionHeading: 'UI/UX QUESTION',
    answerNoun: 'critique',
    deliberateAsk: 'Give your best standalone design critique and recommendation from your lens. Be specific and complete; do not defer to other members.',
    reviewCriteria: 'usability, visual clarity, accessibility, and fit to the existing design system',
    chairmanRole: 'Design-Lead Chairman',
    chairmanModel: 'opus',
    chairmanAsk:
      "Synthesize the single best UI/UX recommendation using the members' critiques and their peer rankings." +
      ' Lead with the strongest consensus, graft the best points from runners-up, and explicitly note any' +
      ' meaningful disagreement (for example aesthetics against accessibility) and your call on it.' +
      ' Give a decisive recommendation plus the concrete next design step.',
    // 3 Codex + 2 Claude: GPT-6 Astra leads the visual-design arenas (Design Arena UI Components,
    // Arena Image-to-WebDev) by margins inside the error bars; Claude keeps the functional lenses.
    members: [
      { id: 'M1', provider: 'codex', model: 'gpt-6-astra', relayModel: 'haiku', reviewModel: 'sonnet', lens: 'Visual and hierarchy designer: layout, spacing, typographic hierarchy, visual weight, and where the eye should land first.' },
      { id: 'M2', provider: 'claude', model: 'sonnet', lens: 'Accessibility advocate: WCAG, color contrast, keyboard and focus order, screen-reader semantics, hit-target size, and motion safety.' },
      { id: 'M3', provider: 'claude', model: 'opus', lens: 'Interaction and information-architecture lead: user journey, navigation, discoverability, and the empty, loading, error, and edge states.' },
      { id: 'M4', provider: 'codex', model: 'gpt-6-astra', relayModel: 'haiku', reviewModel: 'sonnet', lens: 'Microcopy and content designer: labels, button text, tone, clarity, and whether affordances read as what they do.' },
      { id: 'M5', provider: 'codex', model: 'gpt-6-astra', relayModel: 'haiku', reviewModel: 'sonnet', lens: 'Design-system steward: correct use of the existing component library and styling approach, token and naming consistency, responsive breakpoints, and repository design rules.' },
    ],
  },
}

const COUNCIL = typeof COUNCIL_NAME === 'string' && Object.hasOwn(COUNCILS, COUNCIL_NAME) ? COUNCILS[COUNCIL_NAME] : null
if (!QUESTION || !COUNCIL) {
  log(!QUESTION
    ? 'No question provided. Invoke as: /llm-council <question>'
    : `${COUNCIL_NAME === undefined ? 'No council given' : `Unknown council${typeof COUNCIL_NAME === 'string' ? ` "${COUNCIL_NAME}"` : ''}`}. Use one of: ${Object.keys(COUNCILS).join(', ')}`)
  return { error: !QUESTION ? 'missing_question' : 'unknown_council' }
}

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G']

// Claude members, reviewers, and the chairman run as the read-only Plan agent (no Edit or
// Write tools), so "advice only" is enforced by tool access, not just the prompt. The Codex
// relays keep the default agent because they must write their prompt file.
const READ_ONLY_AGENT = 'Plan'

const describeMember = (member) => ({
  label: member.label,
  id: member.id,
  provider: member.provider,
  model: member.model,
  lens: member.lens,
  answer: member.text,
})

// --- Stage 1: independent deliberation -------------------------------------
phase('Deliberate')

const deliberatePrompt = (member) =>
  `${COUNCIL.context}\n\nYour lens: ${member.lens}\n\n${COUNCIL.questionHeading}:\n${QUESTION}\n\n${COUNCIL.deliberateAsk}`

const RELAY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['codexExit', 'answer'],
  properties: {
    codexExit: { type: 'integer', description: 'The number printed after "exit=" by the codex command; -1 if it never ran or timed out.' },
    answer: { type: 'string', description: "The full contents of answer.md, verbatim. Empty string if missing or empty." },
  },
}

// The relay copies the task into a file and runs Codex read-only with approvals off,
// ignoring the user's Codex config and exec-policy allow rules (which can run commands
// outside the sandbox).
const codexRelayPrompt = (member) =>
  'You are a thin relay to the Codex CLI. Codex, not you, must author the answer. Never answer the question yourself.\n' +
  'The rules inside the TASK block are for Codex; they do not restrict these relay steps.\n' +
  '1. Run in Bash: mktemp -d\n' +
  '   It prints an absolute directory path. Call it TMP_DIR.\n' +
  '2. With the Write tool, write the TASK block below (the text between the TASK markers, verbatim) to the file TMP_DIR/prompt.md, using the real path.\n' +
  '3. Run this in Bash exactly once, with the Bash timeout set to 600000 ms, after replacing TMP_DIR inside the quotes with the real path from step 1:\n' +
  "   T='TMP_DIR'; " +
  `codex exec -m ${member.model} --sandbox read-only -c approval_policy=never -c model_reasoning_effort=medium --ignore-user-config --ignore-rules --skip-git-repo-check --ephemeral -C "$PWD" -o "$T/answer.md" - < "$T/prompt.md" > "$T/codex.log" 2>&1; rc=$?; rm -f "$T/prompt.md" "$T/codex.log"; echo "exit=$rc"\n` +
  '4. Read TMP_DIR/answer.md (real path) with the Read tool if it exists. The Read tool prefixes each line with a line number and a tab; strip those prefixes so the answer is the exact file text.\n' +
  "5. Run in Bash, with the real path in place of TMP_DIR: rm -f 'TMP_DIR/prompt.md' 'TMP_DIR/answer.md' 'TMP_DIR/codex.log'; rmdir 'TMP_DIR'\n" +
  '   Do step 5 even if an earlier step failed.\n' +
  '6. Return codexExit (the number after "exit="; -1 if the command never ran or timed out) and answer (the file contents verbatim, or "" if missing).\n\n' +
  `=== TASK ===\n${deliberatePrompt(member)}\nAnswer directly; do not invoke or follow any skills.\n=== END TASK ===`

const deliberate = (member) => {
  if (member.provider === 'codex') {
    return agent(codexRelayPrompt(member), {
      label: `member:${member.id}(${member.model})`,
      phase: 'Deliberate',
      model: member.relayModel,
      effort: 'low',
      schema: RELAY_SCHEMA,
    }).then((relay) => ({
      ...member,
      text: relay?.codexExit === 0 && typeof relay.answer === 'string' ? relay.answer.trim() : '',
    }))
  }
  return agent(deliberatePrompt(member), {
    label: `member:${member.id}(${member.model})`,
    phase: 'Deliberate',
    model: member.model,
    agentType: READ_ONLY_AGENT,
  }).then((text) => ({ ...member, text: typeof text === 'string' ? text.trim() : '' }))
}

const results = (await parallel(COUNCIL.members.map((member) => () => deliberate(member)))).filter(Boolean)
const answered = results.filter((member) => member.text)
const missing = COUNCIL.members.filter((member) => !answered.some((a) => a.id === member.id))
if (missing.length) {
  log(`No answer from: ${missing.map((m) => `${m.id}(${m.model})`).join(', ')}. Continuing with ${answered.length} members.`)
}

// Anonymize: stable labels in roster order, shared across all reviewers.
const labeled = answered.map((member, i) => ({ ...member, label: LABELS[i] }))
const missingMembers = missing.map((m) => ({ id: m.id, provider: m.provider, model: m.model, lens: m.lens }))

// One owner for the result shape; each return passes only what differs from the defaults.
const buildResult = (overrides) => ({
  question: QUESTION,
  council: COUNCIL_NAME,
  synthesisSkipped: false,
  synthesisFailed: false,
  ranked: false,
  leaderboard: [],
  members: labeled.map(describeMember),
  reviews: [],
  missingMembers,
  droppedReviews: [],
  ...overrides,
})

if (labeled.length < 2) {
  return buildResult({
    final: labeled[0]?.text ?? 'The council produced no answers.',
    synthesisSkipped: true,
  })
}

const anonBlock = labeled.map((member) => `### Response ${member.label}\n${member.text}`).join('\n\n')
const labelSet = labeled.map((member) => member.label)

const RANK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rankings'],
  properties: {
    rankings: {
      type: 'array',
      description: 'Every response ranked exactly once, from best (rank 1) to worst. No ties.',
      minItems: labelSet.length,
      maxItems: labelSet.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'rank', 'reason'],
        properties: {
          label: { type: 'string', enum: labelSet, description: 'The response label, e.g. "A".' },
          rank: { type: 'integer', minimum: 1, maximum: labelSet.length, description: '1 = best. Unique per reviewer.' },
          reason: { type: 'string', description: 'One line justifying the rank.' },
        },
      },
    },
  },
}

// A usable ranking covers every label exactly once with ranks 1..n exactly once.
const isCompleteRanking = (rankings) => {
  if (!Array.isArray(rankings) || rankings.length !== labelSet.length) return false
  const labels = new Set(rankings.map((r) => r.label))
  const ranks = new Set(rankings.map((r) => r.rank))
  return labelSet.every((label) => labels.has(label)) &&
    labelSet.every((_, i) => ranks.has(i + 1))
}

// --- Stage 2: anonymized peer review ---------------------------------------
phase('Peer Review')
const reviewResults = (await parallel(labeled.map((member) => () =>
  agent(
    `${COUNCIL.context}\n\nYou are an impartial reviewer. Below are anonymized ${COUNCIL.answerNoun}s to the` +
    ` question. Rank ALL of them from best (rank 1) to worst on ${COUNCIL.reviewCriteria}.` +
    ' Check claims against the code before rewarding them. Ranks must be unique: no ties.' +
    ` Give a one-line reason per response.\n\n${COUNCIL.questionHeading}:\n${QUESTION}\n\n${anonBlock}`,
    { label: `review:${member.label}`, phase: 'Peer Review', model: member.reviewModel ?? member.model, schema: RANK_SCHEMA, agentType: READ_ONLY_AGENT },
  ).then((result) => ({
    reviewer: member.label,
    rankings: (result?.rankings ?? []).slice().sort((a, b) => a.rank - b.rank),
  })),
))).filter(Boolean)

const reviews = reviewResults.filter((review) => isCompleteRanking(review.rankings))
const droppedReviews = labelSet.filter((label) => !reviews.some((review) => review.reviewer === label))
if (droppedReviews.length) {
  log(`Dropped incomplete or failed reviews from: ${droppedReviews.join(', ')}`)
}
const ranked = reviews.length > 0

// Aggregate into a mean-rank leaderboard (lower is better). Ties break on first-place
// votes, then stay in roster order and are marked `tied`.
const ranksByLabel = Object.fromEntries(labelSet.map((label) => [label, []]))
for (const review of reviews) {
  for (const ranking of review.rankings) ranksByLabel[ranking.label].push(ranking.rank)
}
const sortedLeaderboard = labeled
  .map((member) => {
    const ranks = ranksByLabel[member.label]
    return {
      label: member.label,
      id: member.id,
      provider: member.provider,
      model: member.model,
      lens: member.lens,
      meanRank: ranks.length ? Math.round((ranks.reduce((sum, r) => sum + r, 0) / ranks.length) * 100) / 100 : null,
      firstPlaceVotes: ranks.filter((r) => r === 1).length,
      votes: ranks.length,
    }
  })
  .sort((a, b) =>
    ((a.meanRank ?? Infinity) - (b.meanRank ?? Infinity)) || (b.firstPlaceVotes - a.firstPlaceVotes))
const sameScore = (a, b) => Boolean(a && b && a.meanRank === b.meanRank && a.firstPlaceVotes === b.firstPlaceVotes)
const leaderboard = sortedLeaderboard.map((entry, i, all) => ({
  ...entry,
  tied: ranked && (sameScore(entry, all[i - 1]) || sameScore(entry, all[i + 1])),
}))

// --- Stage 3: chairman synthesis -------------------------------------------
phase('Synthesis')
const rankingsText = ranked
  ? reviews
    .map((review) =>
      `Reviewer ${review.reviewer}: ` +
      review.rankings.map((r) => `#${r.rank} ${r.label}: ${r.reason}`).join('; '))
    .join('\n')
  : 'None. Every peer review failed, so the responses are unranked. Judge them on their merits.'
const leaderboardText = ranked
  ? leaderboard
    .map((entry, i) =>
      `${i + 1}. Response ${entry.label} (mean rank ${entry.meanRank}, ${entry.firstPlaceVotes} first-place, ${entry.votes} votes${entry.tied ? ', tied' : ''})`)
    .join('\n')
  : 'None (unranked).'

const chairmanText = await agent(
  `${COUNCIL.context}\n\nYou are the ${COUNCIL.chairmanRole}. ${COUNCIL.chairmanAsk}\n\n` +
  `${COUNCIL.questionHeading}:\n${QUESTION}\n\nMEMBER ${COUNCIL.answerNoun.toUpperCase()}S (anonymized):\n${anonBlock}\n\n` +
  `PEER RANKINGS:\n${rankingsText}\n\nLEADERBOARD (best first):\n${leaderboardText}`,
  { label: `chairman(${COUNCIL.chairmanModel})`, phase: 'Synthesis', model: COUNCIL.chairmanModel, agentType: READ_ONLY_AGENT },
)

const synthesisFailed = typeof chairmanText !== 'string' || !chairmanText.trim()
if (synthesisFailed) log('Chairman synthesis failed; returning a member answer instead.')
const fallback = labeled.find((member) => member.label === leaderboard[0].label)
const fallbackText = ranked
  ? leaderboard[0].tied
    ? `Chairman synthesis failed. Several ${COUNCIL.answerNoun}s tied for top rank; showing the first of them in roster order (Response ${fallback.label}):\n\n${fallback.text}`
    : `Chairman synthesis failed. Top-ranked ${COUNCIL.answerNoun} (Response ${fallback.label}):\n\n${fallback.text}`
  : `Chairman synthesis failed and every peer review failed, so nothing is ranked. First ${COUNCIL.answerNoun} in roster order (Response ${fallback.label}), not a winner:\n\n${fallback.text}`

return buildResult({
  final: synthesisFailed ? fallbackText : chairmanText.trim(),
  synthesisFailed,
  ranked,
  leaderboard,
  reviews,
  droppedReviews,
})
