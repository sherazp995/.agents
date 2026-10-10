// Tests run-workflow.mjs against a fake `claude`. Run: node --test tests/run-workflow.test.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const fakeClaude = here('./fake-claude.mjs')
const runner = here('../run-workflow.mjs')
const councilScript = here('../../llm-council/council-workflow.js')
const secondOpinionScript = here('../second-opinion.js')
const buildScript = here('../../doing-substantial-work/build-workflow.js')

process.env.WORKFLOW_RUNNER_CLAUDE = fakeClaude
const { allowedScript, createRuntime, loadScript } = await import(runner)

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const setup = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wf-runner-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  const logFile = join(dir, '..', `${dir.split('/').pop()}.calls.jsonl`)
  process.env.FAKE_CLAUDE_LOG = logFile
  t.after(() => rmSync(logFile, { force: true }))
  const logs = []
  const rt = createRuntime({ repoRoot: dir, runId: 'wf_test1234-001', log: (m) => logs.push(m) })
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  return { dir, rt, calls, logs }
}
const flag = (call, name) => call.args[call.args.indexOf(name) + 1]

test('a Plan agent runs read-only and returns the structured output', async (t) => {
  const { rt, calls } = setup(t)
  const out = await rt.agent('judge', { agentType: 'Plan', model: 'opus', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } })
  assert.deepEqual(out, { ok: true })
  const [call] = calls()
  assert.equal(flag(call, '--permission-mode'), 'plan')
  assert.equal(flag(call, '--model'), 'opus')
  assert.ok(call.args.includes('--json-schema'))
})

test('a default agent runs in auto mode and returns its text', async (t) => {
  const { rt, calls } = setup(t)
  assert.equal(await rt.agent('relay', { model: 'haiku', effort: 'low' }), 'text from haiku')
  const [call] = calls()
  assert.equal(flag(call, '--permission-mode'), 'auto')
  assert.equal(flag(call, '--effort'), 'low')
})

test('a failed or erroring agent returns null', async (t) => {
  const { rt, logs } = setup(t)
  assert.equal(await rt.agent('FAIL_EXIT'), null)
  assert.equal(await rt.agent('FAIL_ERROR'), null)
  assert.ok(logs.some((l) => l.includes('Not logged in')))
})

test('a worktree agent gets its own worktree, removed when it changed nothing', async (t) => {
  const { dir, rt, calls } = setup(t)
  await rt.agent('builder', { isolation: 'worktree' })
  const [call] = calls()
  assert.equal(call.cwd, join(dir, '.claude', 'worktrees', 'wf_test1234-001-1'))
  assert.equal(flag(call, '--permission-mode'), 'bypassPermissions')
  assert.equal(existsSync(call.cwd), false)
  assert.equal(git(dir, 'branch', '--list', 'worktree-*'), '')
})

test('a worktree agent that changed files keeps its worktree and branch', async (t) => {
  const { dir, rt } = setup(t)
  await rt.agent('WRITE_FILE', { isolation: 'worktree' })
  const path = join(dir, '.claude', 'worktrees', 'wf_test1234-001-1')
  assert.equal(existsSync(join(path, 'made-by-agent.txt')), true)
  assert.match(git(dir, 'branch', '--list', 'worktree-*'), /worktree-wf_test1234-001-1/)
})

test('parallel and pipeline turn a thrown task into null', async (t) => {
  const { rt } = setup(t)
  assert.deepEqual(await rt.parallel([() => 1, () => { throw new Error('x') }, async () => 3]), [1, null, 3])
  const out = await rt.pipeline([1, 2], (v) => { if (v === 2) throw new Error('x'); return v * 10 }, (v, item, i) => `${v}-${item}-${i}`)
  assert.deepEqual(out, ['10-1-0', null])
})

test('runs the llm-council workflow unchanged end to end', async (t) => {
  const { dir, rt, calls } = setup(t)
  const script = loadScript(readFileSync(councilScript, 'utf8'))
  const result = await script({ council: 'engineering', question: 'Is this fine?' }, rt.agent, rt.parallel, rt.pipeline, rt.phase, rt.log, rt.budget, rt.workflow)
  assert.equal(result.members.length, 5)
  assert.deepEqual(result.missingMembers, [])
  assert.deepEqual(result.droppedReviews, [])
  assert.equal(result.ranked, true)
  assert.equal(result.synthesisFailed, false)
  assert.equal(calls().length, 11)
  assert.ok(calls().every((c) => c.cwd === dir))
})

const runCli = (dir, args) => {
  try {
    return { status: 0, stdout: execFileSync('node', [runner, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '' }
  }
}

test('the CLI runs a council and prints the run id and result as JSON', (t) => {
  const { dir } = setup(t)
  const { status, stdout } = runCli(dir, [councilScript, '--args', '{"council":"engineering","question":"q"}'])
  assert.equal(status, 0)
  const out = JSON.parse(stdout)
  assert.match(out.runId, /^wf_[0-9a-f]{8}-\d{3}$/)
  assert.equal(out.result.members.length, 5)
})

test('the CLI refuses any script other than the two council workflows', (t) => {
  const { dir, calls } = setup(t)
  const script = join(dir, 'other.js')
  writeFileSync(script, "export const meta = { name: 't', description: 't' }\nreturn await agent('hi')\n")
  assert.equal(runCli(dir, [script]).status, 2)
  assert.equal(calls().length, 0)
})

test('a symlink to an approved workflow resolves to the approved file itself, other paths to null', (t) => {
  const { dir } = setup(t)
  const alias = join(dir, 'alias.js')
  symlinkSync(councilScript, alias)
  assert.equal(allowedScript(alias), realpathSync(councilScript))
  assert.equal(allowedScript(buildScript), realpathSync(buildScript))
  assert.equal(allowedScript(join(dir, 'a.txt')), null)
  assert.equal(allowedScript(join(dir, 'missing.js')), null)
})

test('second-opinion runs one read-only Claude agent and returns its text', (t) => {
  const { dir, calls } = setup(t)
  const { status, stdout } = runCli(dir, [secondOpinionScript, '--args', '{"prompt":"Review this plan."}'])
  assert.equal(status, 0)
  assert.deepEqual(JSON.parse(stdout).result, { text: 'text from default' })
  const [call] = calls()
  assert.equal(flag(call, '--permission-mode'), 'plan')
  assert.equal(call.prompt, 'Review this plan.')
})

test('second-opinion rejects a missing prompt without starting an agent', (t) => {
  const { dir, calls } = setup(t)
  const { status, stdout } = runCli(dir, [secondOpinionScript, '--args', '{}'])
  assert.equal(status, 0)
  assert.deepEqual(JSON.parse(stdout).result, { error: 'missing_prompt' })
  assert.equal(calls().length, 0)
})
