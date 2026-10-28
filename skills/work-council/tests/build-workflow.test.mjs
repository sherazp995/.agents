// Runs build-workflow.js with mocked workflow hooks. Run: node tests/build-workflow.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const source = readFileSync(fileURLToPath(new URL('../build-workflow.js', import.meta.url)), 'utf8')
const body = source.replace('export const meta =', 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const script = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)

const ARGS = {
  task: 'add sum()',
  plan: '1. add sum 2. document it',
  parts: [
    { id: 'code', owner: 'claude', files: ['lib/sum.js', 'test/sum.test.js'], brief: 'add sum and its test' },
    { id: 'docs', owner: 'codex', files: ['README.md'], brief: 'document sum' },
  ],
  checks: ['npm test', 'npm run lint'],
  baseSha: 'abc1234',
}

const built = { done: true, filesChanged: [], notes: '' }
const codexBuilt = { ...built, codexExit: 0 }
const approve = { verdict: 'APPROVE', findings: [] }
const codexApprove = { ...approve, codexExit: 0 }
const changes = (file) => ({ verdict: 'CHANGES', findings: [{ file, line: 3, problem: 'off by one', fix: 'use <=' }] })
const passing = { checks: [{ command: 'npm test', exitCode: 0, tail: '' }, { command: 'npm run lint', exitCode: 0, tail: '' }] }
const failingLint = { checks: [{ command: 'npm test', exitCode: 0, tail: '' }, { command: 'npm run lint', exitCode: 1, tail: 'semi' }] }

// Every agent succeeds by default; a test overrides labels it cares about.
const happy = {
  'build:code(claude)': built,
  'build:docs(codex)': codexBuilt,
  'review:code:1(codex)': codexApprove,
  'review:docs:1(claude)': approve,
  'checks:1': passing,
  'signoff:1(claude)': approve,
  'signoff:1(codex)': codexApprove,
}

// responses: label -> value, an async function returning one, or an Error to throw.
// events records each agent's start and end, to check what overlaps.
const run = async (overrides = {}, args = ARGS) => {
  const responses = { ...happy, ...overrides }
  const calls = []
  const events = []
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts })
    events.push(`start:${opts.label}`)
    const given = responses[opts.label]
    const value = typeof given === 'function' ? await given() : given
    events.push(`end:${opts.label}`)
    if (value instanceof Error) throw value
    return value ?? (opts.label.startsWith('fix:') ? (opts.label.includes('(codex)') ? codexBuilt : built) : null)
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const result = await script(args, agent, parallel, () => {}, () => {})
  return { result, calls, events, labels: calls.map((c) => c.opts.label) }
}
const promptOf = (calls, label) => calls.find((c) => c.opts.label === label).prompt

test('rejects bad inputs before starting any agent', async () => {
  const twoOwners = [{ ...ARGS.parts[0] }, { ...ARGS.parts[1], files: ['lib/sum.js'] }]
  for (const [args, error] of [
    [{ ...ARGS, task: '' }, 'missing_task_or_plan'],
    [{ ...ARGS, checks: [] }, 'missing_checks'],
    [{ ...ARGS, baseSha: 'HEAD' }, 'missing_base_sha'],
    [{ ...ARGS, parts: [] }, 'bad_parts'],
    [{ ...ARGS, parts: [{ ...ARGS.parts[0], owner: 'gpt' }] }, 'bad_parts'],
    [{ ...ARGS, parts: [{ ...ARGS.parts[0], files: [] }] }, 'bad_parts'],
    [{ ...ARGS, parts: [ARGS.parts[0], { ...ARGS.parts[1], id: 'code' }] }, 'bad_parts'],
    [{ ...ARGS, parts: twoOwners }, 'file_in_two_parts'],
    [{ ...ARGS, parts: [ARGS.parts[0], { ...ARGS.parts[1], files: ['./lib/sum.js'] }] }, 'file_in_two_parts'],
    [{ ...ARGS, parts: [ARGS.parts[0], { ...ARGS.parts[1], files: ['lib//sum.js'] }] }, 'file_in_two_parts'],
    ...['../x.js', '/etc/hosts', 'lib/', 'lib/*.js', '.'].map((f) => [{ ...ARGS, parts: [{ ...ARGS.parts[0], files: [f] }] }, 'bad_parts']),
    [null, 'missing_task_or_plan'],
  ]) {
    const { result, calls } = await run({}, args)
    assert.equal(result.error, error)
    assert.equal(calls.length, 0)
  }
})

test('parses a JSON-encoded args string', async () => {
  const { result } = await run({}, JSON.stringify(ARGS))
  assert.equal(result.status, 'agreed')
})

test('each model builds its own part in the checkout, and the other model reviews it', async () => {
  const { result, calls, labels } = await run()
  assert.equal(result.status, 'agreed')
  assert.deepEqual(labels.slice(0, 2), ['build:code(claude)', 'build:docs(codex)'])
  assert.ok(labels.includes('review:code:1(codex)') && labels.includes('review:docs:1(claude)'))
  for (const c of calls) assert.equal(c.opts.isolation, undefined, 'no worktrees')
  const claudeBuild = calls.find((c) => c.opts.label === 'build:code(claude)')
  assert.match(claudeBuild.prompt, /Files you own: lib\/sum\.js, test\/sum\.test\.js/)
  assert.match(claudeBuild.prompt, /Edit only the files you own/)
  assert.equal(calls.find((c) => c.opts.label === 'review:docs:1(claude)').opts.agentType, 'Plan')
})

test('one part: one model builds, the other reviews and signs off', async () => {
  const args = { ...ARGS, parts: [ARGS.parts[0]] }
  const { result, labels } = await run({}, args)
  assert.equal(result.status, 'agreed')
  assert.deepEqual(labels, ['build:code(claude)', 'review:code:1(codex)', 'checks:1', 'signoff:1(claude)', 'signoff:1(codex)'])
})

test('a blocked Codex part stops the team and is never handed to Claude', async () => {
  const { result, labels } = await run({ 'build:docs(codex)': { ...codexBuilt, codexExit: 1, done: false } })
  assert.equal(result.status, 'blocked')
  assert.deepEqual(labels, ['build:code(claude)', 'build:docs(codex)'])
  assert.equal(result.parts.find((p) => p.id === 'docs').status, 'blocked')
})

test('requested changes go back to the author, then the reviewer looks again with its notes', async () => {
  const { result, calls, labels } = await run({
    'review:code:1(codex)': { ...changes('lib/sum.js'), codexExit: 0 },
    'fix:code:1(claude)': { ...built, notes: 'kept the guard on purpose' },
    'review:code:2(codex)': codexApprove,
  })
  assert.equal(result.status, 'agreed')
  assert.ok(labels.indexOf('fix:code:1(claude)') < labels.indexOf('review:code:2(codex)'))
  assert.match(calls.find((c) => c.opts.label === 'fix:code:1(claude)').prompt, /lib\/sum\.js:3: off by one/)
  assert.match(calls.find((c) => c.opts.label === 'review:code:2(codex)').prompt, /kept the guard on purpose/)
})

test('the first reviewer reads the notes the builder left', async () => {
  const { calls } = await run({ 'build:code(claude)': { ...built, notes: 'assumed integers only' } })
  assert.match(promptOf(calls, 'review:code:1(codex)'), /assumed integers only/)
})

test('a review finding goes to the part that owns its file, and both parts are reviewed again', async () => {
  const { result, labels } = await run({
    'review:code:1(codex)': { ...changes('README.md'), codexExit: 0 },
    'review:code:2(codex)': codexApprove,
    'review:docs:2(claude)': approve,
  })
  assert.equal(result.status, 'agreed')
  assert.ok(labels.includes('fix:docs:1(codex)'))
  assert.ok(!labels.some((l) => l.startsWith('fix:code:')))
  assert.ok(labels.includes('review:code:2(codex)') && labels.includes('review:docs:2(claude)'))
})

test('a review finding in a file no part owns goes to the user without a fix', async () => {
  const { result, labels } = await run({ 'review:code:1(codex)': { ...changes('config/routes.rb'), codexExit: 0 } })
  assert.equal(result.status, 'not_agreed')
  assert.equal(result.unowned[0].file, 'config/routes.rb')
  assert.ok(!labels.some((l) => l.startsWith('fix:')))
})

test('no fix starts while another part is still being reviewed', async () => {
  const slowApprove = () => new Promise((resolve) => setTimeout(() => resolve(codexApprove), 5))
  const { result, events } = await run({
    'review:code:1(codex)': slowApprove,
    'review:docs:1(claude)': changes('README.md'),
    'review:docs:2(claude)': approve,
  })
  assert.equal(result.status, 'agreed')
  assert.ok(events.indexOf('start:fix:docs:1(codex)') > events.indexOf('end:review:code:1(codex)'))
})

test('a fix that reports unfinished work blocks the run, in every fix step', async () => {
  const unfinished = { ...codexBuilt, done: false, notes: 'cannot edit README.md' }
  for (const overrides of [
    { 'review:docs:1(claude)': changes('README.md'), 'fix:docs:1(codex)': unfinished },
    { 'checks:1': failingLint, 'fix:docs:c1(codex)': unfinished },
    { 'signoff:1(claude)': changes('README.md'), 'fix:docs:s1(codex)': unfinished },
  ]) {
    assert.equal((await run(overrides)).result.status, 'blocked')
  }
})

test('a disputed finding with done true is not a block: the reviewer weighs the reply', async () => {
  const { result } = await run({
    'review:docs:1(claude)': changes('README.md'),
    'fix:docs:1(codex)': { ...codexBuilt, notes: 'the README already says this' },
    'review:docs:2(claude)': approve,
  })
  assert.equal(result.status, 'agreed')
})

test('a Codex answer without an exit code does not count, as a build, review or sign-off', async () => {
  for (const overrides of [
    { 'build:docs(codex)': built },
    { 'review:code:1(codex)': approve },
    { 'signoff:1(codex)': approve },
  ]) {
    assert.equal((await run(overrides)).result.status, 'blocked')
  }
})

test('no agreement after three fix rounds goes to the user, before any sign-off', async () => {
  const keepAsking = Object.fromEntries([1, 2, 3, 4].map((n) => [`review:code:${n}(codex)`, { ...changes('lib/sum.js'), codexExit: 0 }]))
  const { result, labels } = await run(keepAsking)
  assert.equal(result.status, 'not_agreed')
  assert.equal(labels.filter((l) => l.startsWith('fix:code:')).length, 3)
  assert.equal(result.parts.find((p) => p.id === 'code').reviews.length, 4)
  assert.ok(!labels.some((l) => l.startsWith('checks:')))
})

test('a review that throws blocks the run instead of passing silently', async () => {
  const { result } = await run({ 'review:docs:1(claude)': new Error('boom') })
  assert.equal(result.status, 'blocked')
})

test('failing checks go to every author, then the checks run again', async () => {
  const { result, calls, labels } = await run({ 'checks:1': failingLint, 'checks:2': passing, 'signoff:2(claude)': approve, 'signoff:2(codex)': codexApprove })
  assert.equal(result.status, 'agreed')
  assert.ok(labels.includes('fix:code:c1(claude)') && labels.includes('fix:docs:c1(codex)'))
  assert.match(calls.find((c) => c.opts.label === 'fix:code:c1(claude)').prompt, /npm run lint` exited 1/)
})

test('checks that keep failing end as checks_failed without a sign-off', async () => {
  const always = Object.fromEntries([1, 2, 3, 4].map((n) => [`checks:${n}`, failingLint]))
  const { result, labels } = await run(always)
  assert.equal(result.status, 'checks_failed')
  assert.ok(!labels.some((l) => l.startsWith('signoff:')))
})

test('a repeated, substituted or whitespace-changed check command does not count as passing', async () => {
  for (const checks of [
    [{ command: 'npm test', exitCode: 0, tail: '' }, { command: 'npm test', exitCode: 0, tail: '' }],
    [{ command: 'npm test', exitCode: 0, tail: '' }, { command: 'true', exitCode: 0, tail: '' }],
    [{ command: 'npm test', exitCode: 0, tail: '' }, { command: 'npm  run lint', exitCode: 0, tail: '' }],
    [{ command: 'npm test', exitCode: 0, tail: '' }],
  ]) {
    const always = Object.fromEntries([1, 2, 3, 4].map((n) => [`checks:${n}`, { checks }]))
    assert.equal((await run(always)).result.status, 'checks_failed')
  }
})

test('both models must approve the whole change; a sign-off finding goes to the part that owns its file', async () => {
  const { result, labels } = await run({
    'signoff:1(codex)': { ...changes('README.md'), codexExit: 0 },
    'checks:2': passing,
    'signoff:2(claude)': approve,
    'signoff:2(codex)': codexApprove,
  })
  assert.equal(result.status, 'agreed')
  assert.ok(labels.includes('fix:docs:s1(codex)'))
  assert.ok(!labels.some((l) => l.startsWith('fix:code:s')))
  assert.equal(result.signoffs.length, 2)
})

test('the next sign-off shows both models the last findings and the authors\' replies', async () => {
  const { calls } = await run({
    'signoff:1(codex)': { ...changes('README.md'), codexExit: 0 },
    'fix:docs:s1(codex)': { ...codexBuilt, notes: 'reworded the example instead' },
    'checks:2': passing,
    'signoff:2(claude)': approve,
    'signoff:2(codex)': codexApprove,
  })
  assert.doesNotMatch(promptOf(calls, 'signoff:1(claude)'), /replies since then/)
  for (const model of ['claude', 'codex']) {
    const prompt = promptOf(calls, `signoff:2(${model})`)
    assert.match(prompt, /README\.md:3: off by one/)
    assert.match(prompt, /docs \(codex\): reworded the example instead/)
  }
})

test('a reply reaches every later sign-off it answers, even when repeated or after a check fix', async () => {
  const dispute = { ...changes('README.md'), codexExit: 0 }
  const repeated = await run({
    'signoff:1(codex)': dispute, 'fix:docs:s1(codex)': { ...codexBuilt, notes: 'already documented' },
    'checks:2': passing, 'signoff:2(claude)': approve, 'signoff:2(codex)': dispute,
    'fix:docs:s2(codex)': { ...codexBuilt, notes: 'already documented' },
    'checks:3': passing, 'signoff:3(claude)': approve, 'signoff:3(codex)': codexApprove,
  })
  assert.equal(repeated.result.status, 'agreed')
  assert.match(promptOf(repeated.calls, 'signoff:3(codex)'), /already documented/)

  const afterCheckFix = await run({
    'signoff:1(codex)': dispute, 'fix:docs:s1(codex)': { ...codexBuilt, notes: 'kept it on purpose' },
    'checks:2': failingLint, 'checks:3': passing, 'signoff:3(claude)': approve, 'signoff:3(codex)': codexApprove,
  })
  assert.equal(afterCheckFix.result.status, 'agreed')
  assert.ok(afterCheckFix.labels.includes('fix:docs:c2(codex)'))
  for (const model of ['claude', 'codex']) assert.match(promptOf(afterCheckFix.calls, `signoff:3(${model})`), /kept it on purpose/)
})

test('a review finding answered by another part\'s author shows that reply to the reviewer who raised it', async () => {
  const { calls } = await run({
    'review:code:1(codex)': { ...changes('README.md'), codexExit: 0 },
    'fix:docs:1(codex)': { ...codexBuilt, notes: 'README is right as it is' },
    'review:code:2(codex)': codexApprove,
    'review:docs:2(claude)': approve,
  })
  for (const label of ['review:code:2(codex)', 'review:docs:2(claude)']) assert.match(promptOf(calls, label), /docs \(codex\): README is right as it is/)
})

test('replies stay with the right review when the parts under review change from round to round', async () => {
  const { result, calls } = await run({
    // Round 1: code approves, docs asks for a README change; only docs is reviewed in round 2.
    'review:docs:1(claude)': changes('README.md'),
    'fix:docs:1(codex)': { ...codexBuilt, notes: 'docs reply one' },
    // Round 2: docs asks for a change in code's file, which reopens code.
    'review:docs:2(claude)': changes('lib/sum.js'),
    'fix:code:2(claude)': { ...built, notes: 'code reply two' },
    'review:code:3(codex)': codexApprove,
    'review:docs:3(claude)': approve,
  })
  assert.equal(result.status, 'agreed')
  assert.match(promptOf(calls, 'review:docs:2(claude)'), /docs \(codex\): docs reply one/)
  assert.match(promptOf(calls, 'review:docs:3(claude)'), /code \(claude\): code reply two/)
  assert.match(promptOf(calls, 'review:code:3(codex)'), /code \(claude\): code reply two/)
})

test('a sign-off finding spelled with ./ still reaches the part that owns the file', async () => {
  const { result, labels } = await run({
    'signoff:1(claude)': changes('./README.md'),
    'checks:2': passing,
    'signoff:2(claude)': approve,
    'signoff:2(codex)': codexApprove,
  })
  assert.equal(result.status, 'agreed')
  assert.ok(labels.includes('fix:docs:s1(codex)'))
})

test('a sign-off finding in a file no part owns goes to the user', async () => {
  const { result } = await run({ 'signoff:1(claude)': changes('config/routes.rb') })
  assert.equal(result.status, 'not_agreed')
  assert.equal(result.unowned[0].file, 'config/routes.rb')
})

test('a Codex sign-off that failed to run blocks instead of counting as approval', async () => {
  const { result } = await run({ 'signoff:1(codex)': { ...codexApprove, codexExit: -1 } })
  assert.equal(result.status, 'blocked')
})

test('the Codex relay uses literal paths, waits in its turn, and is read-only when reviewing', async () => {
  const { calls } = await run()
  const build = calls.find((c) => c.opts.label === 'build:docs(codex)')
  const review = calls.find((c) => c.opts.label === 'review:code:1(codex)')
  for (const relay of [build, review]) {
    assert.doesNotMatch(relay.prompt, /\$PWD/)
    assert.match(relay.prompt, /-C "\$W"/)
    assert.ok(relay.prompt.includes(`write each one as '\\''`), 'paths with a single quote must be escaped')
    assert.match(relay.prompt, /never end it while Codex runs/)
    assert.equal(relay.opts.model, 'haiku')
  }
  assert.match(build.prompt, /--sandbox workspace-write/)
  assert.match(review.prompt, /--sandbox read-only/)
})

test('the Codex sandbox gets network access only for builders and only when the project opts in', async () => {
  const flag = '-c sandbox_workspace_write.network_access=true'
  const prompts = async (args) => (await run({}, args)).calls
  const relay = (calls, label) => calls.find((c) => c.opts.label === label).prompt
  assert.ok(!relay(await prompts(ARGS), 'build:docs(codex)').includes(flag))
  assert.ok(!relay(await prompts({ ...ARGS, codexNetwork: 'true' }), 'build:docs(codex)').includes(flag))
  const on = await prompts({ ...ARGS, codexNetwork: true })
  assert.ok(relay(on, 'build:docs(codex)').includes(flag))
  assert.ok(!relay(on, 'review:code:1(codex)').includes(flag))
})

test('diff commands quote file paths that contain a single quote', async () => {
  const args = { ...ARGS, parts: [{ ...ARGS.parts[0], files: ["lib/it's.js"] }, ARGS.parts[1]] }
  const { calls } = await run({}, args)
  assert.ok(calls.find((c) => c.opts.label === 'review:code:1(codex)').prompt.includes(`'lib/it'\\''s.js'`))
})
