// Runs build-workflow.js with a mocked agent(). Run: node --test 'skills/doing-substantial-work/tests/*.test.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadScript } from '../../workflow-runner/run-workflow.mjs'

const script = loadScript(readFileSync(fileURLToPath(new URL('../build-workflow.js', import.meta.url)), 'utf8'))

const CARDS = [{ id: 'c1', title: 'a', command: 'true' }, { id: 'c2', title: 'b', command: 'true' }]
// Fake git tree ids: 40 hex chars, since the workflow rejects anything that is not a sha.
const T = (n) => String(n).padStart(40, '0')
const BUILT = { files_changed: ['a.js'], command: 'true', exit_code: 0, output_tail: '', not_done: '', notes: '' }
const PASSED = { exit_code: 0, output_tail: 'ok' }
const FINDING = { id: 'I-1', severity: 'high', origin: 'introduced', location: 'a.js:1', summary: 'bug', fix: 'fix it' }
const ALL_LENSES = ['senior', 'structural', 'simplicity', 'diff-only']
const PASS = { verdict: 'PASS', findings: [], lenses_run: ALL_LENSES }

// reply(label) answers by label prefix; anything not overridden builds and checks cleanly.
const run = async (args, reply = () => undefined) => {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ ...opts, prompt })
    const value = reply(opts.label)
    if (value !== undefined) return value
    if (opts.label.startsWith('build')) return BUILT
    if (opts.label === 'snapshot') return { exit_code: 0, dir: '/s', tree: T(0), status: '' }
    if (opts.label.startsWith('diff-only')) return { written: true, candidates: 0 }
    if (opts.label.startsWith('diff#')) return { exit_code: 0, tree: T(opts.label.slice(5)), files: ['a.js'], net_files: ['a.js'] }
    if (opts.label.startsWith('fix')) return { files_changed: ['a.js'], fixed: ['I-1'], not_done: '' }
    if (opts.label.startsWith('prove')) return { status: 'passed', observed: 'ok', evidence: [] }
    if (opts.label.startsWith('review')) return PASS
    return PASSED
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const result = await script(args, agent, parallel, null, () => {}, () => {}, null, null)
  return { result, calls, labels: calls.map((c) => c.label) }
}

test('sequential cards stop at the first card that fails its recheck', async () => {
  const { result, labels } = await run({ repo: '/r', cards: CARDS, sequential: true, review: false }, (l) => (l.startsWith('check:c1') ? { exit_code: 1, output_tail: 'boom' } : undefined))
  assert.equal(result.status, 'needs-attention')
  assert.deepEqual(result.skipped, ['c2'])
  assert.deepEqual(labels, ['build:c1#1', 'check:c1#1', 'build:c1#2', 'check:c1#2'])
})

test('dependency waves: independent cards build together, dependents wait and are skipped when a dependency fails', async () => {
  const cards = [
    { id: 'a', title: 'a', command: 'true' },
    { id: 'b', title: 'b', command: 'true' },
    { id: 'c', title: 'c', command: 'true', after: ['a'] },
    { id: 'd', title: 'd', command: 'true', after: ['b'] },
  ]
  const { result, labels } = await run({ repo: '/r', cards, review: false }, (l) => (l.startsWith('check:b') ? { exit_code: 1, output_tail: 'boom' } : undefined))
  assert.deepEqual(labels.slice(0, 2).sort(), ['build:a#1', 'build:b#1'])
  assert.ok(labels.indexOf('build:c#1') > labels.indexOf('check:a#1'))
  assert.ok(!labels.includes('build:d#1'))
  assert.deepEqual(result.skipped, ['d'])
  assert.equal(result.cards.find((c) => c.id === 'c').status, 'passed')
})

test('a dependency cycle is rejected before any agent starts', async () => {
  const cards = [{ id: 'a', title: 'a', command: 'true', after: ['b'] }, { id: 'b', title: 'b', command: 'true', after: ['a'] }, { id: 'c', title: 'c', command: 'true' }]
  const { result, labels } = await run({ repo: '/r', cards, review: false })
  assert.deepEqual(result, { error: 'dependency_cycle', cards: ['a', 'b'] })
  assert.deepEqual(labels, [])
})

test('sequential mode still builds a dependency before the card that needs it', async () => {
  const cards = [{ id: 'b', title: 'b', command: 'true', after: ['a'] }, { id: 'a', title: 'a', command: 'true' }]
  const { labels } = await run({ repo: '/r', cards, sequential: true, review: false })
  assert.ok(labels.indexOf('build:a#1') < labels.indexOf('build:b#1'))
})

test('a card broken by a later card is caught by the final recheck and blocks the proof', async () => {
  const { result, labels } = await run(
    { repo: '/r', cards: CARDS, review: false, proof: { instructions: 'run it' } },
    (l) => (l === 'final-check:c1' ? { exit_code: 1, output_tail: 'broken by c2' } : undefined),
  )
  assert.equal(result.cards.find((c) => c.id === 'c1').status, 'regressed')
  assert.ok(!labels.includes('prove'))
  assert.equal(result.status, 'needs-attention')
})

test('builders sharing a wave are told not to touch the other cards', async () => {
  const { calls } = await run({ repo: '/r', cards: CARDS, review: false })
  const builds = calls.filter((c) => c.label.startsWith('build'))
  assert.ok(builds.every((c) => c.prompt.includes('1 other builders are editing other cards')))
  const solo = await run({ repo: '/r', cards: [CARDS[0]], review: false })
  assert.ok(!solo.calls[0].prompt.includes('other builders'))
})

test('a base commit replaces the start snapshot, and an unsafe base is rejected', async () => {
  const { calls } = await run({ repo: '/r', cards: [CARDS[0]], base: 'HEAD~1' })
  const snap = calls.find((c) => c.label === 'snapshot')
  assert.match(snap.prompt, /git rev-parse --verify 'HEAD~1\^\{tree\}'/)
  assert.doesNotMatch(snap.prompt, /git add -A/)
  const bad = await run({ repo: '/r', cards: [CARDS[0]], base: "x'; rm -rf ~" })
  assert.deepEqual(bad.result, { error: 'bad_base', base: "x'; rm -rf ~" })
  assert.deepEqual(bad.labels, [])
})

test('shell fields reported with a name= prefix are cleaned before use', async () => {
  const sha = 'a'.repeat(40)
  const { calls, result } = await run(
    { repo: '/r', cards: [CARDS[0]] },
    (l) => {
      if (l === 'snapshot') return { exit_code: 0, dir: 'dir=/tmp/tmp.X', tree: `tree=${sha}`, status: '' }
      if (l.startsWith('diff#')) return { exit_code: 0, tree: `tree=${'b'.repeat(40)}`, files: ['a.js'], net_files: ['a.js'] }
      return undefined
    },
  )
  const diff = calls.find((c) => c.label === 'diff#1')
  assert.match(diff.prompt, /\/tmp\/tmp\.X\/index-1/)
  assert.match(diff.prompt, new RegExp(`git diff ${sha} `))
  assert.doesNotMatch(diff.prompt, /dir=|tree=a/)
  assert.notEqual(result.review && result.review.note, 'could not diff the working tree')
})

test('a snapshot whose tree is not a sha fails before any build', async () => {
  const { result, labels } = await run({ repo: '/r', cards: [CARDS[0]] },
    (l) => (l === 'snapshot' ? { exit_code: 0, dir: '/tmp/x', tree: 'No tree printed', status: '' } : undefined))
  assert.equal(result.error, 'snapshot_failed')
  assert.deepEqual(labels, ['snapshot'])
})

test('every agent is told to run git from inside the repo, never with git -C', async () => {
  const { calls } = await run({ repo: '/r', cards: CARDS, proof: { instructions: 'run it' } })
  assert.ok(calls.length > 5)
  for (const c of calls) assert.match(c.prompt, /never `git -C`/, c.label)
})

test('a repo path that could break out of shell quoting is rejected before any agent starts', async () => {
  const { result, labels } = await run({ repo: "/r'; rm -rf ~", cards: [CARDS[0]] })
  assert.equal(result.error, 'bad_repo')
  assert.deepEqual(labels, [])
})

test('an unknown dependency is rejected before any agent starts', async () => {
  const { result, labels } = await run({ repo: '/r', cards: [{ id: 'a', title: 'a', command: 'true', after: ['zz'] }], review: false })
  assert.equal(result.error, 'unknown_dependency')
  assert.deepEqual(labels, [])
})

test('parallel cards all finish building before any recheck runs', async () => {
  const events = []
  const slowBuild = () => new Promise((done) => setTimeout(() => { events.push('c2 built'); done(BUILT) }, 20))
  const { result, labels } = await run({ repo: '/r', cards: CARDS, parallel: true, review: false }, (l) => {
    if (l.startsWith('check')) events.push(l)
    return l === 'build:c2#1' ? slowBuild() : undefined
  })
  assert.equal(result.status, 'ready-for-review')
  assert.deepEqual(labels.slice(0, 2), ['build:c1#1', 'build:c2#1'])
  assert.deepEqual(events, ['c2 built', 'check:c1#1', 'check:c2#1'])
})

test('builder notes alone keep the card passed', async () => {
  const { result } = await run(
    { repo: '/r', cards: [{ id: 'c1', title: 't', command: 'true' }], review: false },
    (l) => (l.startsWith('build') ? { ...BUILT, notes: 'kept J3 as a tie-breaker' } : undefined),
  )
  assert.equal(result.cards[0].status, 'passed')
  assert.equal(result.cards[0].notes, 'kept J3 as a tie-breaker')
})

test('a builder that reports not_done leaves the card incomplete and stops before proof', async () => {
  const { result, labels } = await run(
    { repo: '/r', cards: [CARDS[0]], proof: { instructions: 'x' } },
    (l) => (l.startsWith('build') ? { ...BUILT, not_done: 'migration blocked' } : undefined),
  )
  assert.equal(result.cards[0].status, 'incomplete')
  assert.equal(result.status, 'needs-attention')
  assert.ok(!labels.includes('prove') && !labels.some((l) => l.startsWith('review')))
})

const reviewLabels = (labels) => labels.filter((l) => /^(diff#|review|fix|recheck|prove)/.test(l))

test('the review loop stops when nothing is open, with a model and effort set per stage', async () => {
  const { result, calls, labels } = await run({ repo: '/r', cards: [CARDS[0]], proof: { instructions: 'x' } })
  assert.equal(result.status, 'done')
  assert.deepEqual(labels, ['snapshot', 'build:c1#1', 'check:c1#1', 'prove', 'diff#1', 'review#1', 'diff-only#1'])
  const opts = Object.fromEntries(calls.map((c) => [c.label, [c.model, c.effort]]))
  assert.deepEqual(opts['check:c1#1'], ['haiku', 'low'])
  assert.deepEqual(opts.snapshot, ['haiku', 'low'])
  assert.deepEqual(opts.prove, ['sonnet', 'medium'])
  assert.deepEqual(opts['review#1'], [undefined, 'high'])
  assert.deepEqual(opts['diff-only#1'], ['sonnet', 'low'])
})

test('the diff-only lens runs as a sibling of the lead, which re-proves its candidates file', async () => {
  let inFlight = 0
  let overlap = false
  const { calls } = await run({ repo: '/r', cards: [CARDS[0]] }, (l) => {
    if (!/^(review|diff-only)/.test(l)) return undefined
    inFlight += 1
    if (inFlight === 2) overlap = true
    return new Promise((done) => setTimeout(() => { inFlight -= 1; done(l.startsWith('review') ? PASS : { written: true, candidates: 0 }) }, 5))
  })
  assert.ok(overlap, 'lead and diff-only agent run at the same time')
  const lead = calls.find((c) => c.label === 'review#1').prompt
  const blind = calls.find((c) => c.label === 'diff-only#1').prompt
  assert.match(lead, /start no agent of any kind/)
  assert.match(lead, /\/s\/round-1\.diff-only\.md/)
  assert.match(blind, /\{DIFF\} = \/s\/round-1\.diff/)
  assert.ok(!blind.includes('Intent'))
})

test('done is computed from findings, lenses and proof, never from the verdict string', async () => {
  const low = { ...FINDING, severity: 'low' }
  const cases = [
    [{ verdict: 'CHANGES REQUIRED', findings: [low], lenses_run: ALL_LENSES }, {}, 'done'],
    [{ verdict: 'PASS', findings: [FINDING], lenses_run: ALL_LENSES }, {}, 'needs-attention'],
    [{ verdict: 'PASS', findings: [], lenses_run: ['senior', 'diff-only'] }, { tier: 'normal' }, 'needs-attention'],
    [PASS, { diffOnly: null }, 'needs-attention'],
    [{ verdict: 'INCOMPLETE', findings: [], lenses_run: ALL_LENSES }, {}, 'needs-attention'],
  ]
  for (const [review, extra, expected] of cases) {
    const { result } = await run({ repo: '/r', cards: [CARDS[0]], tier: extra.tier }, (l) => {
      if (l.startsWith('review')) return review
      if (l.startsWith('diff-only') && 'diffOnly' in extra) return extra.diffOnly
      return undefined
    })
    assert.equal(result.status, expected, JSON.stringify({ review, extra }))
  }
  const { result } = await run({ repo: '/r', cards: [CARDS[0]], tier: 'normal' }, (l) => (l.startsWith('review') ? { ...PASS, lenses_run: ['senior', 'diff-only'] } : undefined))
  assert.match(result.review.note, /required lenses did not run: structural, simplicity/)
})

test('the proof reruns after a fix round that changed files, and a failing rerun stops the loop', async () => {
  let reviews = 0
  const reply = (fixFiles, proofAfterFix) => (l) => {
    if (l.startsWith('review')) return reviews++ % 2 === 0 ? { ...PASS, verdict: 'CHANGES REQUIRED', findings: [FINDING] } : PASS
    if (l === 'diff#2') return { exit_code: 0, tree: T(2), files: fixFiles, net_files: ['a.js'] }
    if (l === 'prove#fix1') return proofAfterFix
    return undefined
  }
  const changed = await run({ repo: '/r', cards: [CARDS[0]], tier: 'normal', proof: { instructions: 'x' } }, reply(['a.js'], { status: 'failed', observed: 'broke', evidence: [] }))
  assert.deepEqual(reviewLabels(changed.labels), ['prove', 'diff#1', 'review#1', 'fix#1', 'recheck:c1#fix1', 'diff#2', 'prove#fix1'])
  assert.equal(changed.result.status, 'needs-attention')
  assert.equal(changed.result.proof.status, 'failed')
  const unchanged = await run({ repo: '/r', cards: [CARDS[0]], tier: 'normal', proof: { instructions: 'x' } }, reply([], undefined))
  assert.ok(!unchanged.labels.includes('prove#fix1'))
  assert.equal(unchanged.result.status, 'done')
})

test('the review targets the real diff against the start snapshot, not builders\' reported files', async () => {
  const { calls, labels } = await run({ repo: '/r', cards: [CARDS[0]] }, (l) => (l === 'diff#1' ? { exit_code: 0, tree: T(1), files: ['real.js'], net_files: ['real.js'] } : undefined))
  assert.equal(labels[0], 'snapshot')
  assert.match(calls.find((c) => c.label === 'diff#1').prompt, new RegExp(`git diff ${T(0)} "\\$to" > '/s/round-1\\.diff'`))
  const lead = calls.find((c) => c.label === 'review#1').prompt
  assert.match(lead, /files: real\.js/)
  assert.ok(!lead.includes('a.js'))
  const failed = await run({ repo: '/r', cards: [CARDS[0]] }, (l) => (l === 'snapshot' ? { exit_code: 128, dir: '', tree: '', status: '' } : undefined))
  assert.equal(failed.result.error, 'snapshot_failed')
  assert.deepEqual(failed.labels, ['snapshot'])
})

test('review tiers: small gets one fix and a recheck, risky gets three rounds, later rounds see only the fix diff', async () => {
  const open = (l) => (l.startsWith('review') ? { ...PASS, verdict: 'CHANGES REQUIRED', findings: [FINDING] } : undefined)
  const small = await run({ repo: '/r', cards: [CARDS[0]] }, open)
  assert.equal(small.result.review.tier, 'small')
  assert.deepEqual(reviewLabels(small.labels), ['diff#1', 'review#1', 'fix#1', 'recheck:c1#fix1', 'diff#2', 'review#2'])
  assert.equal(small.result.review.rounds.length, 2)
  assert.match(small.calls.find((c) => c.label === 'review#1').prompt, /Run these lenses: senior, diff-only \(skip the structural, simplicity and Codex/)

  const normal = await run({ repo: '/r', cards: [CARDS[0]] }, (l) => (l === 'diff#1' ? { exit_code: 0, tree: T(1), files: ['a', 'b', 'c', 'd'], net_files: ['a', 'b', 'c', 'd'] } : open(l)))
  assert.equal(normal.result.review.tier, 'normal')

  const risky = await run({ repo: '/r', cards: [CARDS[0]], risky: true }, open)
  assert.equal(risky.result.status, 'needs-attention')
  assert.equal(risky.result.review.tier, 'risky')
  assert.equal(risky.result.review.rounds.length, 3)
  assert.deepEqual(risky.result.review.findings, [FINDING])
  assert.deepEqual(reviewLabels(risky.labels), ['diff#1', 'review#1', 'fix#1', 'recheck:c1#fix1', 'diff#2', 'review#2', 'fix#2', 'recheck:c1#fix2', 'diff#3', 'review#3'])
  assert.match(risky.calls.find((c) => c.label === 'diff#2').prompt, new RegExp(`git diff ${T(1)} "\\$to"`))
  assert.match(risky.calls.find((c) => c.label === 'review#2').prompt, /only the fix diff in \/s\/round-2\.diff/)
})

test('the review result lists the net change since the snapshot, for staging the commit', async () => {
  let reviews = 0
  const { result, calls } = await run({ repo: '/r', cards: [CARDS[0]] }, (l) => {
    if (l === 'diff#1') return { exit_code: 0, tree: T(1), files: ['a.js', 'b.js'], net_files: ['a.js', 'b.js'] }
    // The fixer reverted a.js, so the net change no longer holds it.
    if (l === 'diff#2') return { exit_code: 0, tree: T(2), files: ['a.js', 'a_test.js'], net_files: ['b.js', 'a_test.js'] }
    if (l.startsWith('review')) return reviews++ === 0 ? { ...PASS, verdict: 'CHANGES REQUIRED', findings: [FINDING] } : PASS
    return undefined
  })
  assert.equal(result.status, 'done')
  assert.deepEqual(result.review.files, ['b.js', 'a_test.js'])
  assert.match(calls.find((c) => c.label === 'diff#2').prompt, new RegExp(`git diff --name-only --no-renames ${T(0)} "\\$to"`))
})

test('parallel builders each get their own test database', async () => {
  const { calls } = await run({ repo: '/r', cards: CARDS, review: false })
  const builds = calls.filter((c) => c.label.startsWith('build'))
  assert.match(builds[0].prompt, /TEST_ENV_NUMBER=1/)
  assert.match(builds[1].prompt, /TEST_ENV_NUMBER=2/)
  const solo = await run({ repo: '/r', cards: [CARDS[0]], review: false })
  assert.ok(!solo.calls[0].prompt.includes('TEST_ENV_NUMBER'))
})
