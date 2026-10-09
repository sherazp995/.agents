export const meta = {
  name: 'work-council-build',
  description: 'Best-of-two build: Claude and Codex each implement the approved plan in their own worktree, then checks and judges pick one',
  phases: [
    { title: 'Build', detail: 'two builders implement the plan in separate worktrees' },
    { title: 'Judge', detail: 'checks decide first; two judges compare passing candidates' },
  ],
}

// args: { task, plan, checks, baseSha } from the work-council skill.
//   task:    one line saying what the change is for.
//   plan:    the approved plan text (cards with their pass/fail commands).
//   checks:  shell commands that must exit 0 when the work is done.
//   baseSha: the commit both worktrees must start from (the user's clean HEAD).
// A JSON-encoded object string is parsed as the object.
const parseArgs = (raw) => {
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { return JSON.parse(raw) } catch { return raw }
  }
  return raw
}
const INPUT = parseArgs(args) ?? {}
const TASK = typeof INPUT.task === 'string' ? INPUT.task.trim() : ''
const PLAN = typeof INPUT.plan === 'string' ? INPUT.plan.trim() : ''
const CHECKS = Array.isArray(INPUT.checks)
  ? INPUT.checks.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
  : []
const BASE_SHA = typeof INPUT.baseSha === 'string' ? INPUT.baseSha.trim() : ''

if (!TASK || !PLAN) return { error: 'missing_task_or_plan' }
if (!CHECKS.length) return { error: 'missing_checks' }
if (!/^[0-9a-f]{7,40}$/.test(BASE_SHA)) return { error: 'missing_base_sha' }

const CODEX_MODEL = 'gpt-6-astra'

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseMatched', 'staged', 'worktreePath', 'checks', 'notes'],
  properties: {
    codexExit: { type: 'integer', description: 'Codex builders only: the number printed after "exit=", or -1 if Codex never ran or timed out.' },
    baseMatched: { type: 'boolean', description: 'True when `git rev-parse HEAD` printed the expected base commit before any change.' },
    staged: { type: 'boolean', description: 'True when, after `git add -A`, `git diff --cached --quiet` exits 1 (there are staged changes).' },
    worktreePath: { type: 'string', description: 'Output of `git rev-parse --show-toplevel`.' },
    checks: {
      type: 'array',
      description: 'One entry per check command, in the order given.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'exitCode', 'tail'],
        properties: {
          command: { type: 'string', description: 'The check command exactly as given, character for character.' },
          exitCode: { type: 'integer' },
          tail: { type: 'string', description: 'Last 20 lines of output.' },
        },
      },
    },
    notes: { type: 'string', description: 'Anything unfinished, assumed, or deviating from the plan. Empty string if none.' },
  },
}

const checksBlock = CHECKS.map((c, i) => `${i + 1}. ${c}`).join('\n')

const workBrief =
  `TASK: ${TASK}\n\nAPPROVED PLAN:\n${PLAN}\n\n` +
  'Rules: implement exactly this plan in the current directory. Follow the repository instruction files' +
  ' (CLAUDE.md, AGENTS.md) and existing patterns. Keep the change as small as the plan allows.' +
  ' Add or update focused tests for new behaviour. Do not touch files the plan does not need.' +
  ` Work is done only when every one of these commands exits 0:\n${checksBlock}`

// The steps every builder runs around the work, so both candidates are measured the same way.
const preflight =
  'Before changing anything, run `git rev-parse HEAD` in Bash. If it does not print ' +
  `${BASE_SHA} (a prefix match is fine), stop: report baseMatched false, staged false, and no checks.`
const wrapUp =
  `When finished, run each check command once from the worktree root, in order, exactly as written here and without adding pipes, so the exit code you record is the command's own. Record the command, its exit code, and the last 20 lines of output:\n${checksBlock}\n` +
  'Then stage everything with `git add -A`, even if a check fails. Do not commit: the caller reads the staged diff.' +
  ' Report staged (`git diff --cached --quiet` exits 1 when there are staged changes) and worktreePath (`git rev-parse --show-toplevel`).'

const claudeBuilderPrompt =
  `You are one of two independent builders. Another builder is solving the same task in a different worktree; do your own best work.\n\n${preflight}\n\n${workBrief}\n\n${wrapUp}`

// The relay runs Codex with write access inside the relay's own worktree, approvals off, and
// the user's Codex config and exec-policy allow rules ignored, then measures and stages the
// result the same way the Claude builder does. The relay never edits code itself.
const codexBuilderPrompt =
  'You are a thin relay to the Codex CLI. Codex, not you, must write the code. Never edit project files yourself.\n' +
  'The rules inside the TASK block are for Codex; they do not restrict these relay steps.\n' +
  `0. ${preflight}\n` +
  '1. Run in Bash: pwd && mktemp -d\n' +
  '   The first line is the worktree root; call it WT_DIR. The second is a temporary directory outside the repository; call it TMP_DIR.\n' +
  '2. With the Write tool, write the TASK block below (the text between the TASK markers, verbatim) to TMP_DIR/prompt.md, using the real path.\n' +
  // Literal paths, not $PWD: the permission check refuses the command when it contains $PWD.
  '3. Run this in Bash exactly once, with the Bash timeout set to 600000 ms, after replacing WT_DIR and TMP_DIR inside the quotes with the real paths.' +
  " If a path contains a single quote, write each one as '\\'' so the quoting stays intact:\n" +
  "   W='WT_DIR'; T='TMP_DIR'; " +
  `codex exec -m ${CODEX_MODEL} --sandbox workspace-write -c approval_policy=never --ignore-user-config --ignore-rules --ephemeral -C "$W" -o "$T/answer.md" - < "$T/prompt.md" > "$T/codex.log" 2>&1; rc=$?; tail -20 "$T/codex.log"; echo "exit=$rc"\n` +
  "4. Run in Bash, with the real path: rm -rf 'TMP_DIR'. Do this even if step 3 failed.\n" +
  '5. If the exit code is not 0, report codexExit, staged false, no checks, and the log tail as notes. Stop.\n' +
  `6. Otherwise: ${wrapUp}\n` +
  '   Put any summary Codex printed at the end of its log into notes.\n\n' +
  `=== TASK ===\n${workBrief}\nDo not commit. Do not invoke or follow any skills.\n=== END TASK ===`

const BUILDERS = [
  { id: 'claude', prompt: claudeBuilderPrompt, opts: { agentType: 'general-purpose' } },
  { id: 'codex', prompt: codexBuilderPrompt, opts: { model: 'haiku', effort: 'low' } },
]

// A candidate counts only when it started from the base and staged a change. Builders never
// commit: a commit hook (e.g. one unpushed commit per branch) may forbid it.
const usable = (c) => Boolean(c && c.baseMatched && c.staged && c.worktreePath)
// Builders report checks in the given order, each naming its command exactly, so a repeated
// or substituted command never counts as a pass. Exact match: whitespace can be shell syntax.
const passedAll = (c) =>
  Array.isArray(c.checks) && c.checks.length === CHECKS.length &&
  c.checks.every((r, i) => r.command === CHECKS[i] && r.exitCode === 0)

phase('Build')
// parallel() turns a thrown agent into null, so name every slot by its builder.
const built = (await parallel(BUILDERS.map((b) => () =>
  agent(b.prompt, { label: `builder:${b.id}`, phase: 'Build', isolation: 'worktree', schema: CANDIDATE_SCHEMA, ...b.opts }),
))).map((result, i) => ({ builder: BUILDERS[i].id, ...(result ?? {}) }))

const candidates = built.filter(usable).map((c) => ({ ...c, passedAllChecks: passedAll(c) }))
const missing = built
  .filter((c) => !usable(c))
  .map((c) => ({
    builder: c.builder,
    reason: c.baseMatched === undefined ? 'builder failed'
      : c.baseMatched === false ? 'worktree did not start from baseSha'
      : c.codexExit !== undefined && c.codexExit !== 0 ? `codex exited ${c.codexExit}`
      : 'nothing staged',
    notes: c.notes ?? '',
  }))
if (missing.length) log(`No usable candidate from: ${missing.map((m) => `${m.builder} (${m.reason})`).join(', ')}`)

const result = (overrides) => ({
  task: TASK,
  baseSha: BASE_SHA,
  winner: null,
  runnerUp: null,
  decidedBy: 'none',
  graft: [],
  judges: [],
  missing,
  ...overrides,
})

if (!candidates.length) return result({})
if (candidates.length === 1) return result({ winner: candidates[0], decidedBy: 'only-candidate' })

// Checks decide before taste: a candidate that passes every check beats one that does not.
const [first, second] = candidates
if (first.passedAllChecks !== second.passedAllChecks) {
  const [winner, runnerUp] = first.passedAllChecks ? [first, second] : [second, first]
  return result({ winner, runnerUp, decidedBy: 'checks' })
}

phase('Judge')
// Anonymized as X and Y; judges never learn which model built which.
const labeled = [{ label: 'X', ...first }, { label: 'Y', ...second }]
// Paths go into a shell command; a single quote in a path must not break the quoting.
const shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`
const candidateBlock = labeled.map((c) =>
  `### Candidate ${c.label}\nDiff: run \`cd ${shellQuote(c.worktreePath)} && git diff --cached ${BASE_SHA}\`\n` +
  `Check results:\n${c.checks.map((r) => `- \`${r.command}\` exit ${r.exitCode}`).join('\n')}`,
).join('\n\n')
// Builder notes stay out of the judge prompt: free text can name the builder.

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'reasons', 'graft'],
  properties: {
    winner: { type: 'string', enum: ['X', 'Y'] },
    reasons: { type: 'string', description: 'Why the winner is better, citing file:line in the diffs.' },
    graft: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific, verified improvements from the losing candidate worth applying on top of the winner. Empty if none.',
    },
  },
}

const judgePrompt =
  'You judge two independent implementations of the same approved plan in this repository.' +
  ' Read both diffs fully with the commands given. Pick the one that best fulfils the plan, weighing in order:' +
  ' correctness (including edge cases the plan implies), test quality, simplicity and fit with existing code.' +
  ' Verify claims by reading the code. This is read-only: do not edit files or run' +
  ` commands that change state.\n\nTASK: ${TASK}\n\nAPPROVED PLAN:\n${PLAN}\n\n${candidateBlock}`

const JUDGES = [{ id: 'J1', model: 'opus' }, { id: 'J2', model: 'sonnet' }, { id: 'J3', model: 'opus' }]
const judge = (j) =>
  agent(judgePrompt, { label: `judge:${j.id}(${j.model})`, phase: 'Judge', model: j.model, agentType: 'Plan', schema: JUDGE_SCHEMA })
    .then((v) => (v && (v.winner === 'X' || v.winner === 'Y') ? { judge: j.id, model: j.model, ...v } : null))

const votes = (await parallel(JUDGES.slice(0, 2).map((j) => () => judge(j)))).filter(Boolean)
// Split or missing votes get a third judge so the outcome always has a majority or a stated fallback.
if (votes.length < 2 || votes[0].winner !== votes[1].winner) {
  log('Judges split or one failed; asking a third judge.')
  // Isolated like the parallel judges: a rejected third call must still reach the fallback.
  const third = await judge(JUDGES[2]).catch(() => null)
  if (third) votes.push(third)
}

// A judged winner needs at least two agreeing votes; anything less falls back to X.
const tally = { X: 0, Y: 0 }
for (const v of votes) tally[v.winner] += 1
const judgedLabel = ['X', 'Y'].find((label) => tally[label] >= 2)
if (!judgedLabel) {
  log('No judge majority; falling back to candidate X (roster order), not a judged winner.')
}
const winnerLabel = judgedLabel ?? 'X'
const winner = labeled.find((c) => c.label === winnerLabel)
const runnerUp = labeled.find((c) => c.label !== winnerLabel)
const graft = votes.filter((v) => v.winner === winnerLabel).flatMap((v) => v.graft)

return result({
  winner,
  runnerUp,
  decidedBy: judgedLabel ? 'judges' : 'fallback',
  graft,
  judges: votes,
})
