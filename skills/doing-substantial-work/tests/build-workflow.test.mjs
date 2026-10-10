// Runs build-workflow.js with a mocked agent(). Run: node --test 'skills/doing-substantial-work/tests/*.test.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadScript } from '../../workflow-runner/run-workflow.mjs'

const script = loadScript(readFileSync(fileURLToPath(new URL('../build-workflow.js', import.meta.url)), 'utf8'))

const CARDS = [{ id: 'c1', title: 'a', command: 'true' }, { id: 'c2', title: 'b', command: 'true' }]
const BUILT = { files_changed: ['a.js'], command: 'true', exit_code: 0, output_tail: '', not_done: '', notes: '' }
const PASSED = { exit_code: 0, output_tail: 'ok' }
const FINDING = { id: 'I-1', severity: 'high', origin: 'introduced', location: 'a.js:1', summary: 'bug', fix: 'fix it' }

// reply(label) answers by label prefix; anything not overridden builds and checks cleanly.
const run = async (args, reply = () => undefined) => {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ ...opts, prompt })
    const value = reply(opts.label)
    if (value !== undefined) return value
    if (opts.label.startsWith('build')) return BUILT
    if (opts.label.startsWith('fix')) return { files_changed: ['a.js'], fixed: ['I-1'], not_done: '' }
    if (opts.label.startsWith('prove')) return { status: 'passed', observed: 'ok', evidence: [] }
    if (opts.label.startsWith('review')) return { verdict: 'PASS', findings: [] }
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

test('the review loop stops at PASS, with a model and effort set per stage', async () => {
  const { result, calls, labels } = await run({ repo: '/r', cards: [CARDS[0]], proof: { instructions: 'x' } })
  assert.equal(result.status, 'done')
  assert.deepEqual(labels, ['build:c1#1', 'check:c1#1', 'prove', 'review#1'])
  const opts = Object.fromEntries(calls.map((c) => [c.label, [c.model, c.effort]]))
  assert.deepEqual(opts['check:c1#1'], ['haiku', 'low'])
  assert.deepEqual(opts.prove, ['sonnet', 'medium'])
  assert.deepEqual(opts['review#1'], [undefined, 'high'])
})

test('the review loop fixes between rounds and gives up after 3 review rounds', async () => {
  const { result, labels } = await run(
    { repo: '/r', cards: [CARDS[0]] },
    (l) => (l.startsWith('review') ? { verdict: 'CHANGES REQUIRED', findings: [FINDING] } : undefined),
  )
  assert.equal(result.status, 'needs-attention')
  assert.equal(result.review.rounds.length, 3)
  assert.deepEqual(result.review.findings, [FINDING])
  assert.deepEqual(labels.filter((l) => /^(review|fix|recheck)/.test(l)),
    ['review#1', 'fix#1', 'recheck:c1#fix1', 'review#2', 'fix#2', 'recheck:c1#fix2', 'review#3'])
})
