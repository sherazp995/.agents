// Runs build-workflow.js with mocked workflow hooks. Run: node tests/build-workflow.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const source = readFileSync(fileURLToPath(new URL('../build-workflow.js', import.meta.url)), 'utf8')
const body = source.replace('export const meta =', 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const script = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)

const ARGS = { task: 'add sum()', plan: '1. add sum', checks: ['npm test', 'npm run lint'], baseSha: 'abc1234' }

const candidate = (builder, overrides = {}) => ({
  baseMatched: true,
  staged: true,
  worktreePath: builder === 'claude' ? '/tmp/wt-1' : '/tmp/wt-2',
  checks: [{ command: 'npm test', exitCode: 0, tail: '' }, { command: 'npm run lint', exitCode: 0, tail: '' }],
  notes: '',
  ...overrides,
})

// responses: { 'builder:claude': value, 'builder:codex': value, 'judge:J1(opus)': value, ... }
const run = async (responses, args = ARGS) => {
  const calls = []
  const logs = []
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts })
    const value = responses[opts.label]
    return typeof value === 'function' ? value() : value ?? null
  }
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const result = await script(args, agent, parallel, () => {}, (m) => logs.push(m))
  return { result, calls, logs }
}

test('rejects missing inputs before spawning agents', async () => {
  for (const [args, error] of [
    [{ ...ARGS, task: '' }, 'missing_task_or_plan'],
    [{ ...ARGS, checks: [] }, 'missing_checks'],
    [{ ...ARGS, baseSha: 'HEAD' }, 'missing_base_sha'],
    [null, 'missing_task_or_plan'],
  ]) {
    const { result, calls } = await run({}, args)
    assert.equal(result.error, error)
    assert.equal(calls.length, 0)
  }
})

test('parses a JSON-encoded args string', async () => {
  const { result } = await run({ 'builder:claude': candidate('claude') }, JSON.stringify(ARGS))
  assert.equal(result.winner.builder, 'claude')
})

test('both builders run in worktrees from the same base', async () => {
  const { calls } = await run({})
  const builders = calls.filter((c) => c.opts.label.startsWith('builder:'))
  assert.equal(builders.length, 2)
  for (const b of builders) {
    assert.equal(b.opts.isolation, 'worktree')
    assert.match(b.prompt, /abc1234/)
  }
})

test('the Codex relay command uses literal paths, not $PWD', async () => {
  const { calls } = await run({})
  const relay = calls.find((c) => c.opts.label === 'builder:codex')
  assert.doesNotMatch(relay.prompt, /\$PWD/)
  assert.match(relay.prompt, /-C "\$W"/)
  assert.ok(relay.prompt.includes(`write each one as '\\''`), 'paths with a single quote must be escaped')
})

test('no usable candidate returns no winner with reasons', async () => {
  const { result } = await run({
    'builder:claude': null,
    'builder:codex': candidate('codex', { codexExit: 127, staged: false }),
  })
  assert.equal(result.winner, null)
  assert.deepEqual(result.missing.map((m) => m.reason), ['builder failed', 'codex exited 127'])
})

test('a builder on the wrong base is not usable', async () => {
  const { result } = await run({
    'builder:claude': candidate('claude', { baseMatched: false, staged: false }),
    'builder:codex': candidate('codex'),
  })
  assert.equal(result.winner.builder, 'codex')
  assert.equal(result.decidedBy, 'only-candidate')
  assert.equal(result.missing[0].reason, 'worktree did not start from baseSha')
})

test('a builder that staged nothing is not usable', async () => {
  const { result } = await run({
    'builder:claude': candidate('claude', { staged: false }),
    'builder:codex': candidate('codex'),
  })
  assert.equal(result.winner.builder, 'codex')
  assert.equal(result.missing[0].reason, 'nothing staged')
})

test('builders stage their work and never commit; judges read the staged diff', async () => {
  const { calls } = await run({
    'builder:claude': candidate('claude'),
    'builder:codex': candidate('codex'),
    'judge:J1(opus)': { winner: 'X', reasons: 'r', graft: [] },
    'judge:J2(sonnet)': { winner: 'X', reasons: 'r', graft: [] },
  })
  for (const b of calls.filter((c) => c.opts.label.startsWith('builder:'))) {
    assert.match(b.prompt, /git add -A/)
    assert.doesNotMatch(b.prompt, /git commit/)
  }
  const judge = calls.find((c) => c.opts.label.startsWith('judge:'))
  assert.match(judge.prompt, /cd '\/tmp\/wt-1' && git diff --cached abc1234/)
})

test('judge diff commands quote worktree paths that contain a single quote', async () => {
  const { calls } = await run({
    'builder:claude': candidate('claude', { worktreePath: "/tmp/O'Brien/wt-1" }),
    'builder:codex': candidate('codex'),
    'judge:J1(opus)': { winner: 'X', reasons: 'r', graft: [] },
    'judge:J2(sonnet)': { winner: 'X', reasons: 'r', graft: [] },
  })
  const judge = calls.find((c) => c.opts.label.startsWith('judge:'))
  assert.ok(judge.prompt.includes(`cd '/tmp/O'\\''Brien/wt-1' && git diff --cached abc1234`))
})

test('passing every check beats failing one, without judges', async () => {
  const failing = [{ command: 'npm test', exitCode: 1, tail: 'boom' }, { command: 'npm run lint', exitCode: 0, tail: '' }]
  const { result, calls } = await run({
    'builder:claude': candidate('claude', { checks: failing }),
    'builder:codex': candidate('codex'),
  })
  assert.equal(result.winner.builder, 'codex')
  assert.equal(result.decidedBy, 'checks')
  assert.equal(calls.filter((c) => c.opts.label.startsWith('judge:')).length, 0)
})

test('a missing check result counts as not passing', async () => {
  const { result } = await run({
    'builder:claude': candidate('claude', { checks: [{ command: 'npm test', exitCode: 0, tail: '' }] }),
    'builder:codex': candidate('codex'),
  })
  assert.equal(result.winner.builder, 'codex')
  assert.equal(result.decidedBy, 'checks')
})

test('agreeing judges decide and their grafts are kept', async () => {
  const { result, calls } = await run({
    'builder:claude': candidate('claude'),
    'builder:codex': candidate('codex'),
    'judge:J1(opus)': { winner: 'Y', reasons: 'r', graft: ['use early return'] },
    'judge:J2(sonnet)': { winner: 'Y', reasons: 'r', graft: [] },
  })
  assert.equal(result.winner.builder, 'codex')
  assert.equal(result.decidedBy, 'judges')
  assert.deepEqual(result.graft, ['use early return'])
  const judges = calls.filter((c) => c.opts.label.startsWith('judge:'))
  assert.equal(judges.length, 2)
  for (const j of judges) {
    assert.equal(j.opts.agentType, 'Plan')
    assert.doesNotMatch(j.prompt, /claude|codex/i, 'judges must not learn which model built which')
  }
})

test('split judges call a third judge who decides', async () => {
  const { result, logs } = await run({
    'builder:claude': candidate('claude'),
    'builder:codex': candidate('codex'),
    'judge:J1(opus)': { winner: 'X', reasons: 'r', graft: [] },
    'judge:J2(sonnet)': { winner: 'Y', reasons: 'r', graft: ['g'] },
    'judge:J3(opus)': { winner: 'Y', reasons: 'r', graft: ['h'] },
  })
  assert.equal(result.winner.builder, 'codex')
  assert.equal(result.decidedBy, 'judges')
  assert.deepEqual(result.graft, ['g', 'h'])
  assert.ok(logs.some((l) => l.includes('third judge')))
})

test('no judge majority falls back to X and says so', async () => {
  const { result } = await run({
    'builder:claude': candidate('claude'),
    'builder:codex': candidate('codex'),
    'judge:J1(opus)': null,
    'judge:J2(sonnet)': null,
    'judge:J3(opus)': null,
  })
  assert.equal(result.winner.label, 'X')
  assert.equal(result.decidedBy, 'fallback')
})

test('split judges and a third judge that throws fall back to X', async () => {
  const { result, logs } = await run({
    'builder:claude': candidate('claude'),
    'builder:codex': candidate('codex'),
    'judge:J1(opus)': { winner: 'X', reasons: 'r', graft: [] },
    'judge:J2(sonnet)': { winner: 'Y', reasons: 'r', graft: [] },
    'judge:J3(opus)': () => { throw new Error('judge unavailable') },
  })
  assert.equal(result.winner.label, 'X')
  assert.equal(result.runnerUp.label, 'Y')
  assert.equal(result.decidedBy, 'fallback')
  assert.ok(logs.some((l) => l.startsWith('No judge majority')))
})

test('one silent judge, one vote, and a third judge that throws fall back to X', async () => {
  const { result, logs } = await run({
    'builder:claude': candidate('claude'),
    'builder:codex': candidate('codex'),
    'judge:J1(opus)': null,
    'judge:J2(sonnet)': { winner: 'Y', reasons: 'r', graft: ['g'] },
    'judge:J3(opus)': () => { throw new Error('judge unavailable') },
  })
  assert.equal(result.winner.label, 'X')
  assert.equal(result.decidedBy, 'fallback')
  assert.deepEqual(result.graft, [])
  assert.ok(logs.some((l) => l.startsWith('No judge majority')))
})

test('one silent judge and a third judge agreeing still decide', async () => {
  const { result } = await run({
    'builder:claude': candidate('claude'),
    'builder:codex': candidate('codex'),
    'judge:J1(opus)': null,
    'judge:J2(sonnet)': { winner: 'Y', reasons: 'r', graft: [] },
    'judge:J3(opus)': { winner: 'Y', reasons: 'r', graft: [] },
  })
  assert.equal(result.winner.label, 'Y')
  assert.equal(result.decidedBy, 'judges')
})

test('a builder that throws is reported, and the other still wins', async () => {
  const { result } = await run({
    'builder:claude': candidate('claude'),
    'builder:codex': () => { throw new Error('api died') },
  })
  assert.equal(result.winner.builder, 'claude')
  assert.deepEqual(result.missing.map((m) => [m.builder, m.reason]), [['codex', 'builder failed']])
})

test('a repeated or substituted check command does not count as passing', async () => {
  const duplicated = [{ command: 'npm test', exitCode: 0, tail: '' }, { command: 'npm test', exitCode: 0, tail: '' }]
  const { result } = await run({
    'builder:claude': candidate('claude', { checks: duplicated }),
    'builder:codex': candidate('codex'),
  })
  assert.equal(result.winner.builder, 'codex')
  assert.equal(result.decidedBy, 'checks')
})

test('a command that differs only in whitespace does not count as passing', async () => {
  const altered = [{ command: 'npm  test', exitCode: 0, tail: '' }, { command: 'npm run lint', exitCode: 0, tail: '' }]
  const { result } = await run({
    'builder:claude': candidate('claude', { checks: altered }),
    'builder:codex': candidate('codex'),
  })
  assert.equal(result.winner.builder, 'codex')
  assert.equal(result.decidedBy, 'checks')
})

test('builder notes never reach the judges', async () => {
  const { calls, result } = await run({
    'builder:claude': candidate('claude', { notes: 'Claude wrote this' }),
    'builder:codex': candidate('codex', { notes: 'Codex wrote this' }),
    'judge:J1(opus)': { winner: 'X', reasons: 'r', graft: [] },
    'judge:J2(sonnet)': { winner: 'X', reasons: 'r', graft: [] },
  })
  for (const j of calls.filter((c) => c.opts.label.startsWith('judge:'))) {
    assert.doesNotMatch(j.prompt, /wrote this/)
  }
  assert.equal(result.winner.notes, 'Claude wrote this')
})
