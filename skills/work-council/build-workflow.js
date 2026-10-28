export const meta = {
  name: 'work-council-build',
  description: 'Team build: Claude and Codex build their own parts of one approved plan in the checkout, review each other, and finish only when every check passes and both approve',
  phases: [
    { title: 'Build', detail: 'each model builds the parts the plan gave it' },
    { title: 'Review', detail: 'the other model reviews each part; its author fixes, up to 3 rounds' },
    { title: 'Sign-off', detail: 'every check passes, then both models approve the whole change' },
  ],
}

// args: { task, plan, parts, checks, baseSha } from the work-council skill.
//   task:    one line saying what the change is for.
//   plan:    the plan both models approved (rethink), as text.
//   parts:   1 to 6 of { id, owner: 'claude' | 'codex', files: [paths], brief }; no file in two
//            parts. One part means one model builds and the other reviews.
//   checks:  shell commands that must exit 0 when the work is done.
//   baseSha: the user's clean HEAD the build starts from; every diff is read against it.
//   codexNetwork: optional; true lets the Codex sandbox open network connections (e.g. to a
//            local Postgres for specs). The skill sets it from the repo's .work-council.json.
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
const CODEX_NETWORK = INPUT.codexNetwork === true
const OWNERS = ['claude', 'codex']
const PARTS = Array.isArray(INPUT.parts) ? INPUT.parts : []

if (!TASK || !PLAN) return { error: 'missing_task_or_plan' }
if (!CHECKS.length) return { error: 'missing_checks' }
if (!/^[0-9a-f]{7,40}$/.test(BASE_SHA)) return { error: 'missing_base_sha' }
// One spelling per file, so `./lib/a.js` and `lib/a.js` are the same owner key. A path that is
// absolute, leaves the checkout, names a directory or holds a glob has no single owner: null.
const canonPath = (raw) => {
  if (typeof raw !== 'string') return null
  const path = raw.trim()
  if (!path || path.startsWith('/') || path.endsWith('/') || /[*?[\]]/.test(path)) return null
  const segments = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    segments.push(seg)
  }
  return segments.length ? segments.join('/') : null
}
const goodPart = (p) => p && /^[a-z0-9-]+$/.test(p.id) && OWNERS.includes(p.owner) &&
  typeof p.brief === 'string' && p.brief.trim() &&
  Array.isArray(p.files) && p.files.length && p.files.every((f) => canonPath(f))
if (!PARTS.length || PARTS.length > 6 || !PARTS.every(goodPart)) return { error: 'bad_parts' }
if (new Set(PARTS.map((p) => p.id)).size !== PARTS.length) return { error: 'bad_parts' }
const ownerOf = new Map()
for (const p of PARTS) {
  for (const f of p.files.map(canonPath)) {
    if (ownerOf.has(f) && ownerOf.get(f) !== p.id) return { error: 'file_in_two_parts', file: f }
    ownerOf.set(f, p.id)
  }
}

// Fix rounds per review loop (rule 44): after the third, the disagreement goes to the user.
const ROUNDS = 3
const OTHER = { claude: 'codex', codex: 'claude' }
const CODEX_MODEL = 'gpt-6-astra'
// --ignore-user-config drops ~/.codex/config.toml, so network access has to be on the command.
const CODEX_NETWORK_FLAG = CODEX_NETWORK ? ' -c sandbox_workspace_write.network_access=true' : ''
// Paths go into shell commands; a single quote in a path must not break the quoting.
const shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`
const checksBlock = CHECKS.map((c, i) => `${i + 1}. ${c}`).join('\n')

const partOf = (p) => ({ id: p.id, owner: p.owner, files: [...new Set(p.files.map(canonPath))], brief: p.brief.trim() })
const parts = PARTS.map(partOf)
const fileList = (p) => p.files.map(shellQuote).join(' ')
const diffCommands = (p) =>
  `\`git diff ${BASE_SHA} -- ${fileList(p)}\` and \`git status --porcelain --untracked-files=all -- ${fileList(p)}\`` +
  ' (read every new file in full: git diff does not show untracked files)'
const teamBlock = parts.map((p) => `- ${p.id} (${p.owner}): ${p.files.join(', ')}`).join('\n')

const header = `TASK: ${TASK}\n\nAPPROVED PLAN (both models approved it):\n${PLAN}\n\nPARTS AND OWNERS:\n${teamBlock}`

const builderBrief = (p, extra = '') =>
  `${header}\n\nYOUR PART: ${p.id}\n${p.brief}\nFiles you own: ${p.files.join(', ')}\n\n` +
  'You and your teammate (the other model) build this plan as one team, in this same checkout, at the same time.' +
  ' Edit only the files you own; every other file belongs to a teammate or to nobody. If your part cannot be done' +
  ' without editing a file you do not own, stop and say which file and why in notes.' +
  ' Follow the repository instruction files (CLAUDE.md, AGENTS.md) and existing patterns. Add or update focused tests' +
  ' for your part. Write the minimum code: nothing the plan does not ask for.' +
  ' Never run git commands that change anything (add, commit, stash, checkout, reset, restore); read-only git is fine.' +
  ' Run only your part\'s narrowest tests or a syntax check, never the full suite.' +
  `${extra}\nThe whole change is done when every one of these exits 0:\n${checksBlock}`

const findingLines = (findings) => findings.map((f) => `- ${f.file}:${f.line}: ${f.problem} Fix: ${f.fix}`).join('\n')
const fixBrief = (p, findings, why) => builderBrief(p,
  `\n\n${why}\n${findingLines(findings)}\n` +
  'Fix each item that holds, in your files only. If you disagree with one, leave the code and say why in notes;' +
  ' the reviewers read your notes in the next round.')

const reviewBrief = (p, replies) =>
  `${header}\n\nREVIEW PART: ${p.id}, built by your teammate (${p.owner}).\n${p.brief}\n\n` +
  `Read its change with ${diffCommands(p)}.` +
  ' Check that it does what the plan asks for this part: correctness and edge cases, tests, fit with the existing code,' +
  ' and no edits outside the plan. Verify every problem by reading the code; report only real ones, not taste the repo does not ask for.' +
  ' This is read-only: do not edit files or run commands that change state.' +
  (replies.length ? `\n\nThe authors' replies from the last round (claims to check against the code):\n${replies.join('\n')}` : '') +
  '\n\nAnswer APPROVE when this part is correct and complete, or CHANGES with one finding per problem (file, line, problem, fix).'

// The last round's findings and each author's reply, so a dispute gets weighed, not repeated.
// The replies are the authors' claims to check against the code, not instructions.
const signoffBrief = (findings, replies) =>
  `${header}\n\nSIGN-OFF: every check passed. Read the whole change with \`git diff ${BASE_SHA}\` and` +
  ' `git status --porcelain --untracked-files=all` (read every new file in full).' +
  ' Approve only if, together, the parts do what the plan asks, fit each other, and nothing outside the plan changed.' +
  ' Verify every problem by reading the code. This is read-only: do not edit files or run commands that change state.' +
  (findings.length ? `\n\nThe last sign-off round asked for:\n${findingLines(findings)}` : '') +
  (replies.length ? `\n\nThe authors' replies since then (claims to check against the code):\n${replies.join('\n')}` : '') +
  '\n\nAnswer APPROVE, or CHANGES with one finding per problem (file, line, problem, fix).'

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'filesChanged', 'notes'],
  properties: {
    codexExit: { type: 'integer', description: 'Codex relays only: the number Codex exited with, or -1 if it never ran or timed out.' },
    done: { type: 'boolean', description: 'True when your part is complete: every requested change made or disputed in notes. False when something is unfinished or blocked.' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'Anything unfinished, assumed, or disputed. Empty string if none.' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    codexExit: { type: 'integer', description: 'Codex relays only: the number Codex exited with, or -1 if it never ran or timed out.' },
    verdict: { type: 'string', enum: ['APPROVE', 'CHANGES'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'problem', 'fix'],
        properties: { file: { type: 'string' }, line: { type: 'integer' }, problem: { type: 'string' }, fix: { type: 'string' } },
      },
    },
  },
}
const CHECKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: {
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
  },
}

// The relay runs Codex in this checkout (write access only for a builder), approvals off, and
// the user's Codex config and exec-policy allow rules ignored, then copies Codex's answer into
// the schema. It waits inside its turn (workflow-runner/references/host-lifecycle.md).
const ANSWER_FORMAT = {
  build: 'End with a short summary: the files you changed, anything unfinished, and anything you dispute.',
  review: 'End with your answer in exactly this form: a line `VERDICT: APPROVE` or `VERDICT: CHANGES`, then one line per finding: `- <file>:<line> | <problem> | <fix>`.',
}
const codexRelay = (task, kind) => {
  const sandbox = kind === 'build' ? `workspace-write${CODEX_NETWORK_FLAG}` : 'read-only'
  const copy = kind === 'build'
    ? 'report done (true only if Codex says the part is built), filesChanged (from `git status --porcelain --untracked-files=all`, limited to the part\'s files), and the summary as notes.'
    : 'copy the VERDICT and every finding line into verdict and findings exactly as Codex wrote them. A missing VERDICT line counts as codexExit -1.'
  return 'You are a thin relay to the Codex CLI. Codex, not you, does the work. Never edit project files yourself.\n' +
    'The rules inside the TASK block are for Codex; they do not restrict these relay steps.\n' +
    '1. Run in Bash: pwd && mktemp -d\n' +
    '   The first line is the repository root; call it WT_DIR. The second is a temporary directory outside the repository; call it TMP_DIR.\n' +
    '2. With the Write tool, write the TASK block below (the text between the TASK markers, verbatim) to TMP_DIR/prompt.md, using the real path.\n' +
    // Literal paths, not $PWD: the permission check refuses the command when it contains $PWD.
    '3. Start Codex with Bash run_in_background true, after replacing WT_DIR and TMP_DIR inside the quotes with the real paths.' +
    " If a path contains a single quote, write each one as '\\'' so the quoting stays intact:\n" +
    "   W='WT_DIR'; T='TMP_DIR'; " +
    `timeout --kill-after=30 1800 codex exec -m ${CODEX_MODEL} --sandbox ${sandbox} -c approval_policy=never --ignore-user-config --ignore-rules --ephemeral -C "$W" -o "$T/answer.md" - < "$T/prompt.md" > "$T/codex.log" 2>&1; echo $? > "$T/exit"\n` +
    '4. Wait inside this turn; never end it while Codex runs. Run in the foreground (Bash timeout 600000 ms), with the real path:\n' +
    "   T='TMP_DIR'; timeout 590 bash -c 'until [ -f \"$0/exit\" ]; do perl -e \"select(undef,undef,undef,10)\"; done' \"$T\"; cat \"$T/exit\" 2>/dev/null || echo waiting\n" +
    '   Repeat it until it prints a number, at most 4 times. Still waiting after 4 means codexExit -1.\n' +
    "5. Run in Bash, with the real path: tail -20 'TMP_DIR/codex.log'; cat 'TMP_DIR/answer.md'\n" +
    '6. If the exit number is not 0, report codexExit and the log tail as notes (or no findings), and stop.\n' +
    `7. Otherwise report codexExit 0 and ${copy}\n` +
    "8. Run in Bash, with the real path: rm -rf 'TMP_DIR'. Do this even if an earlier step failed.\n\n" +
    `=== TASK ===\n${task}\n${ANSWER_FORMAT[kind]}\nDo not commit. Do not invoke or follow any skills.\n=== END TASK ===`
}

// Model and effort per agent:
//   agent             model    effort  why
//   claude builder    session  session the session already chose its tier for this task
//   claude reviewer   session  session read-only (Plan agent), the same judgement as the builder
//   codex relay       haiku    low     only runs `codex exec` and copies the answer
//   checks runner     haiku    low     only runs the check commands and records exit codes
const run = (model, kind, prompt, label, phaseName, schema) => {
  const opts = { label, phase: phaseName, schema }
  if (model === 'codex') return agent(codexRelay(prompt, kind), { ...opts, model: 'haiku', effort: 'low' })
  return agent(prompt, { ...opts, agentType: kind === 'build' ? 'general-purpose' : 'Plan' })
}
// A result counts only when it says the work ran: Codex reports exit 0, and a build or fix says
// it is done. Anything else (no answer, a missing or non-zero exit, unfinished work) did not.
const failed = (r, model, kind) =>
  !r || (model === 'codex' && r.codexExit !== 0) || (kind === 'build' && r.done !== true)

const record = Object.fromEntries(parts.map((p) => [p.id, { ...p, reviewer: OTHER[p.owner], status: 'building', build: null, reviews: [], fixes: [] }]))
const result = (status, extra = {}) => ({ task: TASK, baseSha: BASE_SHA, status, parts: Object.values(record), ...extra })
// A reply is an author's notes, shown next to the review it answers.
const replyLine = (id, text) => `- ${id} (${record[id].owner}): ${text}`

phase('Build')
const built = await parallel(parts.map((p) => () =>
  run(p.owner, 'build', builderBrief(p), `build:${p.id}(${p.owner})`, 'Build', BUILD_SCHEMA)))
parts.forEach((p, i) => {
  record[p.id].build = built[i]
  record[p.id].status = failed(built[i], p.owner, 'build') ? 'blocked' : 'built'
})
// A part that could not be built stops the team: its work is never handed to the other model.
const blocked = parts.filter((p) => record[p.id].status === 'blocked')
if (blocked.length) {
  log(`Blocked: ${blocked.map((p) => `${p.id} (${p.owner})`).join(', ')}`)
  return result('blocked', { reason: 'a part could not be built' })
}

// Each finding goes to the part that owns its file; one outside every part has no author.
const route = (findings) => {
  const unowned = findings.filter((f) => !ownerOf.has(canonPath(f.file)))
  const targets = parts.map((part) => ({ part, findings: findings.filter((f) => ownerOf.get(canonPath(f.file)) === part.id) }))
    .filter((t) => t.findings.length)
  return { unowned, targets }
}
// Fixes run together, and only after every review of the round is in: nobody reads the checkout
// while a teammate is editing it. Returns each fixed part's notes, or null when a fix failed.
const fixParts = async (targets, why, tag, phaseName) => {
  const fixes = await parallel(targets.map(({ part, findings }) => () =>
    run(part.owner, 'build', fixBrief(part, findings, why), `fix:${part.id}:${tag}(${part.owner})`, phaseName, BUILD_SCHEMA)))
  fixes.forEach((f, i) => record[targets[i].part.id].fixes.push(f))
  if (!targets.every((t, i) => !failed(fixes[i], t.part.owner, 'build'))) return null
  return Object.fromEntries(targets.map((t, i) => [t.part.id, fixes[i].notes ?? '']))
}

phase('Review')
// Review runs in waves: every open part is reviewed, then the fixes run, then the open parts are
// reviewed again. A part stays open until its reviewer approves it after its last change.
let open = parts
// Per reviewed part, the replies of every author its last review sent findings to; at first, the build notes.
let replies = Object.fromEntries(parts.map((p) => [p.id, record[p.id].build.notes ? [replyLine(p.id, record[p.id].build.notes)] : []]))
for (let round = 0; open.length; round++) {
  const reviews = await parallel(open.map((p) => () => {
    const reviewer = record[p.id].reviewer
    return run(reviewer, 'review', reviewBrief(p, replies[p.id]), `review:${p.id}:${round + 1}(${reviewer})`, 'Review', REVIEW_SCHEMA)
  }))
  if (open.some((p, i) => failed(reviews[i], record[p.id].reviewer, 'review'))) {
    return result('blocked', { reason: 'a review did not run' })
  }
  // This round's review per part id; open changes below, so never look a review up by position.
  const reviewOf = Object.fromEntries(open.map((p, i) => [p.id, reviews[i]]))
  open.forEach((p) => {
    record[p.id].reviews.push(reviewOf[p.id])
    record[p.id].status = reviewOf[p.id].verdict === 'APPROVE' ? 'approved' : 'changes'
  })
  const asking = open.filter((p) => record[p.id].status === 'changes')
  if (!asking.length) break
  const findingsOf = (p) => reviewOf[p.id]?.findings ?? []
  const { unowned, targets } = route(asking.flatMap(findingsOf))
  if (unowned.length) return result('not_agreed', { reason: 'a review finding is in a file no part owns', unowned })
  if (round === ROUNDS) {
    for (const p of asking) record[p.id].status = 'not_agreed'
    return result('not_agreed', { reason: `no agreement on a part after ${ROUNDS} fix rounds` })
  }
  const got = await fixParts(targets, 'The team review asks for these changes in your files:', `${round + 1}`, 'Review')
  if (!got) return result('blocked', { reason: 'a fix did not run' })
  // A part is reviewed again when it asked for changes or its files just changed. Its reviewer
  // gets the replies of the authors its findings went to, or its own author's notes.
  open = parts.filter((p) => record[p.id].status === 'changes' || p.id in got)
  replies = Object.fromEntries(open.map((p) => {
    const answered = record[p.id].status === 'changes'
      ? [...new Set(route(findingsOf(p)).targets.map((t) => t.part.id))]
      : [p.id]
    return [p.id, answered.filter((id) => got[id]).map((id) => replyLine(id, got[id]))]
  }))
}

phase('Sign-off')
const checksPrompt =
  `Run each check command once from the repository root, in order, exactly as written here and without adding pipes, so the exit code you record is the command's own. Record the command, its exit code, and the last 20 lines of output:\n${checksBlock}\n` +
  'Do not edit files and do not try to fix anything.'
// Checks are reported in the given order, each naming its command exactly, so a repeated or
// substituted command never counts as a pass. Exact match: whitespace can be shell syntax.
const passedAll = (c) =>
  Boolean(c) && Array.isArray(c.checks) && c.checks.length === CHECKS.length &&
  c.checks.every((r, i) => r.command === CHECKS[i] && r.exitCode === 0)

const signoffs = []
let checks = null
let lastFindings = []
// The replies to lastFindings; check fixes in between never replace them.
let signoffReplies = []
for (let round = 0; ; round++) {
  checks = await agent(checksPrompt, { label: `checks:${round + 1}`, phase: 'Sign-off', model: 'haiku', effort: 'low', schema: CHECKS_SCHEMA })
  if (!checks) return result('blocked', { reason: 'the checks did not run', signoffs })
  if (!passedAll(checks)) {
    if (round === ROUNDS) return result('checks_failed', { checks: checks.checks, signoffs })
    const failing = checks.checks.filter((r) => r.exitCode !== 0)
      .map((r) => ({ file: '(check)', line: 0, problem: `\`${r.command}\` exited ${r.exitCode}:\n${r.tail}`, fix: 'make it pass if the cause is in your files; otherwise say so in notes' }))
    const why = failing.length ? 'These check commands fail on the whole change:' : 'The check results were incomplete or did not match the commands; rerun your part\'s tests:'
    if (!(await fixParts(parts.map((part) => ({ part, findings: failing })), why, `c${round + 1}`, 'Sign-off'))) {
      return result('blocked', { reason: 'a fix did not run', checks: checks.checks, signoffs })
    }
    continue
  }
  const brief = signoffBrief(lastFindings, signoffReplies)
  const votes = await parallel(OWNERS.map((model) => () =>
    run(model, 'review', brief, `signoff:${round + 1}(${model})`, 'Sign-off', REVIEW_SCHEMA)))
  const vote = Object.fromEntries(OWNERS.map((model, i) => [model, votes[i]]))
  signoffs.push(vote)
  if (OWNERS.some((model) => failed(vote[model], model, 'review'))) return result('blocked', { reason: 'a sign-off did not run', checks: checks.checks, signoffs })
  if (OWNERS.every((model) => vote[model].verdict === 'APPROVE')) return result('agreed', { checks: checks.checks, signoffs })
  if (round === ROUNDS) return result('not_agreed', { reason: `no joint sign-off after ${ROUNDS} fix rounds`, checks: checks.checks, signoffs })
  lastFindings = OWNERS.flatMap((model) => vote[model].findings ?? [])
  const { unowned, targets } = route(lastFindings)
  if (unowned.length) return result('not_agreed', { reason: 'a sign-off finding is in a file no part owns', unowned, checks: checks.checks, signoffs })
  const got = await fixParts(targets, 'The sign-off review of the whole change asks for these changes:', `s${round + 1}`, 'Sign-off')
  if (!got) return result('blocked', { reason: 'a fix did not run', checks: checks.checks, signoffs })
  signoffReplies = targets.filter((t) => got[t.part.id]).map((t) => replyLine(t.part.id, got[t.part.id]))
}
