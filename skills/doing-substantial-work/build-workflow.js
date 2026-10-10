export const meta = {
  name: 'doing-substantial-work-build',
  description: 'Build plan cards with builder agents, recheck each pass/fail command independently, prove it in the real product, then review and fix until general-review passes',
  whenToUse: 'Steps 3 to 6 of the doing-substantial-work skill, launched from the chat session',
  phases: [
    { title: 'Build', detail: 'one builder agent per card, then an independent recheck of its command' },
    { title: 'Prove', detail: 'run the real product on the core path' },
    { title: 'Review', detail: 'general-review of the real diff by a fresh lead and a sibling diff-only agent, a fixer for introduced findings, rounds by tier' },
  ],
}

// args: { repo, plan, intent?, cards: [{ id, title, files?, command, after?, agentType?, model? }],
//         sequential?, proof?, review?, risky?, tier?, base?, maxAttempts? }
// Cards run in dependency waves: every card whose `after` cards have passed builds at once, so
// cards in one wave must not share files. `sequential: true` (or `parallel: false`) runs one card
// at a time in list order and stops at the first failure.
// proof: { instructions, agentType? } runs after every card passes; omit to skip.
// review: false skips the review loop (only when the user asked to skip it).
// risky: true when the plan names an escalation category (schema, auth, payments, open design).
// tier: 'small' | 'normal' | 'risky' overrides the review tier picked from the real diff (see TIERS).
//
// Model and effort per stage (cost follows risk):
//   builder  card.model, else the session's model | checker, snapshot, diff  haiku, low
//   proof    sonnet, medium                       | review lead the session's model, high
//   fixer    the session's model                  | diff-only lens          sonnet, low

const LENSES = ['senior', 'structural', 'simplicity', 'diff-only', 'codex']

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
    lenses_run: { type: 'array', items: { type: 'string', enum: LENSES }, description: 'lenses that actually ran this round; diff-only only when its candidates were read and re-proven' },
  },
  required: ['verdict', 'findings', 'lenses_run'],
}

const SNAPSHOT_RESULT = {
  type: 'object',
  properties: {
    exit_code: { type: 'integer' },
    dir: { type: 'string', description: 'the dir= line' },
    tree: { type: 'string', description: 'the tree= line' },
    status: { type: 'string', description: 'the git status --porcelain lines' },
  },
  required: ['exit_code', 'dir', 'tree', 'status'],
}

const DIFF_RESULT = {
  type: 'object',
  properties: {
    exit_code: { type: 'integer' },
    tree: { type: 'string', description: 'the tree= line' },
    files: { type: 'array', items: { type: 'string' }, description: 'the file names printed between the tree= line and the net= line' },
    net_files: { type: 'array', items: { type: 'string' }, description: 'the file names printed after the net= line' },
  },
  required: ['exit_code', 'tree', 'files', 'net_files'],
}

const DIFF_ONLY_RESULT = {
  type: 'object',
  properties: {
    written: { type: 'boolean', description: 'true once the candidates file exists' },
    candidates: { type: 'integer' },
  },
  required: ['written', 'candidates'],
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
const FIXABLE = ['blocker', 'high', 'medium']
// small: 3 files or fewer and not risky; its 2 rounds are one fix and one recheck of the fix diff.
// Codex is never required: general-review runs it only when installed. Keep in step with the
// "Review tiers" table in general-review SKILL.md.
const TIERS = {
  small: { lenses: ['senior', 'diff-only'], rounds: 2 },
  normal: { lenses: ['senior', 'structural', 'simplicity', 'diff-only'], rounds: 3 },
  risky: { lenses: ['senior', 'structural', 'simplicity', 'diff-only'], rounds: 3 },
}
if (args.tier && !TIERS[args.tier]) return { error: 'unknown_tier', expected: Object.keys(TIERS) }

function builderPrompt(card, previous, waveSize, slot) {
  return [
    `You are building one card of a plan in the repository at ${args.repo}. Work only inside it.`,
    `Plan:\n${args.plan || '(not supplied)'}`,
    `Your card: ${card.id}: ${card.title}`,
    card.files ? `Files in scope: ${card.files.join(', ')}` : '',
    `The card is done only when this command exits 0: ${card.command}`,
    'Follow the repository instructions and the writing-specs skill for tests. Run tests narrowly.',
    'Do not commit, push, or change files outside the card unless the command cannot pass otherwise; report any such change.',
    waveSize > 1 ? `${waveSize - 1} other builders are editing other cards in this working tree right now. A failure in a file outside your card is theirs: do not edit it; report it in notes.` : '',
    waveSize > 1 ? `If the tests use a database, use your own test database, never the shared one: for example run them with TEST_ENV_NUMBER=${slot + 1} (create that database first if it is missing).` : '',
    previous ? `An earlier attempt failed. Its recheck output:\n${previous}\nFind the cause before changing code again.` : '',
    'Finish by running the command and reporting its real exit code and output.',
  ].filter(Boolean).join('\n\n')
}

// Every agent runs git from inside the repo. git-guard denies `git -C` with the rewritten command,
// but each denied call still costs a retry, so say it up front.
const GIT_RULE = `Run git as \`cd '${args.repo}' && git ...\`, never \`git -C\` (a hook denies it).`
const spawn = (prompt, opts) => agent(`${prompt}\n\n${GIT_RULE}`, opts)

const build = (card, attempt, previous, waveSize = 1, slot = 0) => spawn(builderPrompt(card, previous, waveSize, slot), {
  label: `build:${card.id}#${attempt}`, phase: 'Build', schema: BUILD_RESULT, agentType: card.agentType, model: card.model,
})

// The builder never grades its own work: a separate, cheap agent reruns the command.
const check = (card, label) => spawn(
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

// The review judges the real diff against this snapshot of the working tree (tracked and untracked
// files, through a throwaway index), never the files builders say they changed.
const treeCommand = (index) => `cd '${args.repo}' && set -e; idx="${index}"; cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || true; `
  + 'GIT_INDEX_FILE="$idx" git add -A; to=$(GIT_INDEX_FILE="$idx" git write-tree); echo "tree=$to"'
// A model transcribes the shell output, so its fields are cleaned and checked here, never trusted:
// "tree=<sha>" becomes the bare sha, and a tree that is not a sha or a dir that is not an absolute
// path counts as a failed command.
function cleanShell(r) {
  if (!r) return r
  const strip = (v) => (typeof v === 'string' ? v.trim().replace(/^\w+=/, '').trim() : v)
  const out = { ...r, tree: strip(r.tree), dir: strip(r.dir) }
  const badTree = out.tree !== undefined && !/^[0-9a-f]{40,64}$/.test(out.tree)
  const badDir = out.dir !== undefined && !/^\/[\w./-]+$/.test(out.dir)
  return badTree || badDir ? { ...out, exit_code: out.exit_code || 1 } : out
}
const runShell = async (command, label, schema) => cleanShell(await spawn(
  `Run exactly this shell command with bash and report its exit code and the fields it prints. Report each field's value only, without its "name=" prefix. Do not edit any file and run nothing else.\n\n${command}`,
  { label, phase: label === 'snapshot' ? 'Build' : 'Review', schema, model: 'haiku', effort: 'low' },
))
// `base` (a commit) reviews everything since that commit instead, e.g. work already in the tree.
if (args.base !== undefined && !/^[\w./~^-]+$/.test(args.base)) return { error: 'bad_base', base: args.base }
if (!/^\/[^'\n]+$/.test(args.repo)) return { error: 'bad_repo', repo: args.repo }
let snapshot = null
if (args.review !== false) {
  const start = args.base
    ? `cd '${args.repo}' && echo "tree=$(git rev-parse --verify '${args.base}^{tree}')"`
    : treeCommand('$dir/index')
  snapshot = await runShell(
    `dir=$(mktemp -d) && echo "dir=$dir" && ${start} && git status --porcelain`,
    'snapshot', SNAPSHOT_RESULT,
  )
  if (!snapshot || snapshot.exit_code !== 0 || !snapshot.tree || !snapshot.dir) return { error: 'snapshot_failed', snapshot }
}

const cards = []
const passed = new Set()
let pending = [...args.cards]
while (pending.length) {
  const ready = pending.filter((c) => (c.after || []).every((id) => passed.has(id)))
  const wave = sequential ? ready.slice(0, 1) : ready
  if (wave.length === 0) break // the rest wait on a card that failed (or on a cycle)
  // Builders share one working tree, so the whole wave builds before any recheck runs:
  // a recheck never sees another builder's half-finished edits.
  const firstBuilds = await parallel(wave.map((card, slot) => () => build(card, 1, null, wave.length, slot)))
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

const prove = (label) => spawn(
  `Prove the change works in the real product, repository ${args.repo}.\n\n${args.proof.instructions}\n\n`
    + 'Run it on the core path, keep the evidence as files, and stop every server you started. Do not edit source files.',
  { label, phase: 'Prove', schema: PROOF_RESULT, agentType: args.proof.agentType, model: 'sonnet', effort: 'medium' },
)

let proof = null
if (allPassed && args.proof) {
  phase('Prove')
  proof = await prove('prove')
}
const proofPassed = () => !args.proof || Boolean(proof && proof.status === 'passed')
const proven = allPassed && proofPassed()

// Writes the diff from tree `from` to the working tree now into `path` and lists its files, then
// lists the net change since the snapshot (net=): the files to stage. --no-renames keeps a rename's
// old path, so staging it stages the deletion too; a path that is in neither the working tree nor
// the index (already removed with git mv or git rm) is dropped, since `git add` would reject it.
const diffSince = (from, path, round) => runShell(
  `${treeCommand(`${snapshot.dir}/index-${round}`)}; git diff ${from} "$to" > '${path}'; git diff --name-only ${from} "$to"; `
    + `echo net=; git diff --name-only --no-renames ${snapshot.tree} "$to" | while IFS= read -r f; do `
    + `if [ -e "$f" ] || git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then echo "$f"; fi; done`,
  `diff#${round}`, DIFF_RESULT,
)

function diffOnlyPrompt(diffPath, outPath) {
  const lens = '~/.agents/skills/general-review/references/lenses/diff-only.md'
  return [
    `Read ${lens} and follow it exactly, with {DIFF} = ${diffPath} and {OUT} = ${outPath}. Open no other file in the repository.`,
    `Write your list to ${outPath}.tmp, then move it to ${outPath} in one step (mv), so a reader never sees half of it.`,
  ].join('\n\n')
}

function reviewPrompt({ tier, round, diffPath, files, candidatesPath, earlier }) {
  const lenses = TIERS[tier].lenses
  const scope = round === 1
    ? `Target: the change in the diff file ${diffPath} (files: ${files.join(', ')}). It is the real diff of this build against a snapshot taken before it started; other uncommitted changes in the checkout are not part of it.`
    : `Target: only the fix diff in ${diffPath} (files: ${files.join(', ') || 'none'}), plus the earlier findings below. Do not review the rest of the change again.`
  return [
    `You are the REVIEW LEAD for one general-review single review of uncommitted work in ${args.repo}. You did not write or discuss this change; judge it fresh.`,
    'Read ~/.agents/skills/general-review/SKILL.md sections 1 to 6 and every file they link, and run them yourself.'
      + ' Skip the "Modes and ledger" and "Who reviews" coordinator steps: write no ledger record and start no agent of any kind.',
    `Review tier: ${tier}. Run these lenses: ${lenses.join(', ')}${tier === 'small' ? ' (skip the structural, simplicity and Codex lenses, as the small tier in the SKILL.md tier table says)' : ', and the Codex lens when codex is installed'}.`,
    tier === 'risky' ? 'This change is in an escalation category (schema, data, auth, permissions, payments or an open design): check those paths hardest.' : '',
    `The diff-only lens is already running as a separate agent. Its candidates will appear in ${candidatesPath}; when you reach the merge step, wait for that file (check every 30 seconds, up to 15 minutes, the limit in single-lead.md) and re-prove every candidate with full context. If it never appears, leave diff-only out of lenses_run.`,
    'Read only: do not edit files, add tests to the checkout, commit, push, or post anything.',
    scope,
    `Intent (requirements only):\n${args.intent || args.plan || '(not supplied)'}`,
    earlier ? `Earlier round findings; a fixer has since worked on the introduced blocker, high and medium ones (recheck each; list only those still open):\n${JSON.stringify(earlier, null, 2)}` : '',
    'Return the verdict by the Unified Review Protocol, every finding still open (introduced and pre-existing), and lenses_run: the lenses that really ran.',
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

const blocking = (findings) => findings.filter((f) => f.origin === 'introduced' && FIXABLE.includes(f.severity))

// Each round: diff the working tree against the previous tree (round 1: the snapshot), then the lead
// and the diff-only agent review that diff side by side. A fixer fixes introduced blocker, high and
// medium findings, every card command and (when files changed) the proof rerun, and the next round
// reviews only the fix diff. Passing is computed from the findings, the lenses run and the proof;
// a PASS verdict string is never trusted, though an INCOMPLETE one always blocks.
async function reviewLoop() {
  const rounds = []
  let from = snapshot.tree
  let earlier = null
  let tier = args.tier
  let last = { verdict: 'INCOMPLETE', findings: [], lenses_run: [] }
  // The net change since the snapshot, as of the last diff: the files the session stages for the
  // step 8 commit. Not the union of rounds: a file a fixer removed again would make `git add` fail.
  let files = []
  const result = (note, extra = {}) => ({ passed: !note, tier, verdict: last.verdict, rounds, findings: last.findings, lenses_run: last.lenses_run, files, ...(note ? { note } : {}), ...extra })
  for (let round = 1; ; round++) {
    const diffPath = `${snapshot.dir}/round-${round}.diff`
    const diff = await diffSince(from, diffPath, round)
    if (!diff || diff.exit_code !== 0 || !diff.tree || !Array.isArray(diff.net_files)) return result('could not diff the working tree')
    files = diff.net_files
    if (round === 1) {
      if (diff.files.length === 0) return result('the build changed no files')
      tier = tier || (args.risky ? 'risky' : diff.files.length <= 3 ? 'small' : 'normal')
    } else if (diff.files.length > 0 && args.proof) {
      proof = await prove(`prove#fix${round - 1}`)
      if (!proofPassed()) return result(`the proof fails after fix ${round - 1}`)
    }
    const candidatesPath = `${snapshot.dir}/round-${round}.diff-only.md`
    const [review, diffOnly] = await parallel([
      () => spawn(reviewPrompt({ tier, round, diffPath, files: diff.files, candidatesPath, earlier }), { label: `review#${round}`, phase: 'Review', schema: REVIEW_RESULT, effort: 'high' }),
      () => spawn(diffOnlyPrompt(diffPath, candidatesPath), { label: `diff-only#${round}`, phase: 'Review', schema: DIFF_ONLY_RESULT, model: 'sonnet', effort: 'low' }),
    ])
    if (!review) return result('review lead died')
    // The lead cannot have re-proven candidates that were never written.
    const lensesRun = (review.lenses_run || []).filter((l) => l !== 'diff-only' || (diffOnly && diffOnly.written))
    last = { verdict: review.verdict, findings: review.findings, lenses_run: lensesRun }
    const fixable = blocking(review.findings)
    const missing = TIERS[tier].lenses.filter((l) => !lensesRun.includes(l))
    rounds.push({ round, verdict: review.verdict, open: review.findings.length, fixable: fixable.length, missing_lenses: missing })
    // A claimed PASS never passes on its own, but a lead that reports it could not finish always blocks.
    if (review.verdict === 'INCOMPLETE') return result('review incomplete')
    if (fixable.length === 0) {
      return result(missing.length ? `required lenses did not run: ${missing.join(', ')}` : null)
    }
    if (round >= TIERS[tier].rounds) return result(`${fixable.length} introduced findings still open after ${round} review rounds`)
    const fix = await spawn(fixPrompt(fixable), { label: `fix#${round}`, phase: 'Review', schema: FIX_RESULT })
    if (!fix) return result('fix agent died')
    for (const card of args.cards) {
      const checked = await check(card, `recheck:${card.id}#fix${round}`)
      if (!checked || checked.exit_code !== 0) {
        return result(`after fix ${round}, ${card.id} fails its command`, { output_tail: checked ? checked.output_tail : null })
      }
    }
    from = diff.tree
    earlier = review.findings
  }
}

let review = null
if (proven && args.review !== false) {
  phase('Review')
  review = await reviewLoop()
}

// done: computed from the review findings, lenses and proof; ready-for-review: the user skipped the review loop.
let status = 'needs-attention'
if (proven && review && review.passed) status = 'done'
else if (proven && args.review === false) status = 'ready-for-review'
return {
  status,
  cards,
  skipped,
  proof: proof || (args.proof ? { status: allPassed ? 'blocked' : 'not-run' } : null),
  review,
}
