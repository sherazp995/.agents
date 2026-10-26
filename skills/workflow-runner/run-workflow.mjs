#!/usr/bin/env node
// Runs a Claude Code Workflow script (llm-council, work-council, doing-substantial-work) outside Claude Code, e.g. from Codex.
//
//   node run-workflow.mjs <script.js> [--args <json or @file>] [--out <file>]
//
// It provides the same hooks the Workflow tool gives a script: args, agent, parallel, pipeline,
// phase, log and budget. Each agent() call runs `claude -p` in the current repository:
//   agentType 'Plan'      -> --permission-mode plan (read-only)
//   isolation 'worktree'  -> its own git worktree, --permission-mode bypassPermissions
//   anything else         -> --permission-mode auto
// Progress goes to stderr; stdout gets one JSON object: { runId, result }.
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLAUDE = process.env.WORKFLOW_RUNNER_CLAUDE || 'claude'
const AGENT_TIMEOUT_MS = Number(process.env.WORKFLOW_RUNNER_TIMEOUT_MS || 30 * 60 * 1000)
const TERMINATION_GRACE_MS = 1000
const MAX_CONCURRENT = Math.max(1, Math.min(16, cpus().length - 2))
const MAX_AGENTS = 1000

const fail = (message) => {
  process.stderr.write(`run-workflow: ${message}\n`)
  process.exit(2)
}

// Codex lets this file run outside its sandbox, so it runs only the workflows shipped beside it,
// never an arbitrary script.
const ALLOWED_SCRIPTS = [
  '../llm-council/council-workflow.js',
  '../work-council/build-workflow.js',
  '../doing-substantial-work/build-workflow.js',
  './second-opinion.js',
]
  .map((rel) => realpathSync(fileURLToPath(new URL(rel, import.meta.url))))

// The canonical approved path the given path resolves to, or null.
export const allowedScript = (path) => {
  let real = ''
  try { real = realpathSync(path) } catch { return null }
  return ALLOWED_SCRIPTS.find((allowed) => allowed === real) ?? null
}

const parseCli = (argv) => {
  const [scriptPath, ...rest] = argv
  if (!scriptPath || scriptPath.startsWith('--')) fail('usage: run-workflow.mjs <script.js> [--args <json or @file>] [--out <file>]')
  const opts = { scriptPath: resolve(scriptPath), args: undefined, out: null }
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]]
    if (value === undefined) fail(`${flag} needs a value`)
    if (flag === '--args') opts.args = JSON.parse(value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value)
    else if (flag === '--out') opts.out = resolve(value)
    else fail(`unknown option ${flag}`)
  }
  const allowed = allowedScript(opts.scriptPath)
  if (!allowed) fail(`only these workflows can run: ${ALLOWED_SCRIPTS.join(', ')}`)
  // From here on only the approved canonical path is read, never the supplied one, so a symlink
  // swapped after this check cannot change what runs.
  opts.scriptPath = allowed
  return opts
}

// A hung git throws after 60 s instead of holding the run open.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' }).trim()

// One slot per running agent, so a 100-item parallel() still runs only MAX_CONCURRENT at once.
const makeLimiter = (limit) => {
  let active = 0
  const waiting = []
  return async (task) => {
    if (active >= limit) await new Promise((wake) => waiting.push(wake))
    active += 1
    try {
      return await task()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

// Each child leads its own process group, so cancellation reaches its descendants.
const activeChildren = new Set()
let interruptedBy = null
const forwardSignal = (signal) => {
  interruptedBy = signal
  process.exitCode = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal]
  for (const stop of activeChildren) stop(signal)
}
const onInterrupt = () => forwardSignal('SIGINT')
const onTerminate = () => forwardSignal('SIGTERM')
const onHangup = () => forwardSignal('SIGHUP')

const runClaude = (prompt, cliArgs, cwd, timeoutMs, graceMs) => new Promise((done) => {
  const child = spawn(CLAUDE, cliArgs, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let stoppedBy = null
  let settled = false
  let killTimer
  let inputError = null
  const signalGroup = (signal) => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch (error) {
      if (error.code !== 'ESRCH') stderr += `\nCould not send ${signal}: ${error.message}`
    }
  }
  const finish = (code, signal = null) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(killTimer)
    if (stoppedBy) signalGroup('SIGKILL')
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    activeChildren.delete(stop)
    if (activeChildren.size === 0) {
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      process.removeListener('SIGHUP', onHangup)
    }
    done({ code, signal, stdout, stderr, stoppedBy, inputError })
  }
  const stop = (reason) => {
    if (stoppedBy || settled) return
    stoppedBy = reason
    signalGroup(reason === 'timeout' ? 'SIGTERM' : reason)
    killTimer = setTimeout(() => {
      signalGroup('SIGKILL')
      // A descendant can retain inherited pipes even after the child exits.
      finish(null, 'SIGKILL')
    }, graceMs)
  }
  if (activeChildren.size === 0) {
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    process.on('SIGHUP', onHangup)
  }
  activeChildren.add(stop)
  const timer = setTimeout(() => stop('timeout'), timeoutMs)
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.on('error', (error) => { inputError = error.message })
  child.on('error', (error) => { stderr += String(error); finish(-1) })
  child.on('close', finish)
  child.stdin.end(prompt)
})

export const createRuntime = ({ repoRoot, runId, log = (m) => process.stderr.write(`${m}\n`), timeoutMs = AGENT_TIMEOUT_MS, graceMs = TERMINATION_GRACE_MS }) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(graceMs) || graceMs <= 0) {
    throw new Error('agent timeout and termination grace must be positive finite milliseconds')
  }
  const limit = makeLimiter(MAX_CONCURRENT)
  let agentCount = 0
  let worktreeCount = 0
  let currentPhase = ''

  const permissionMode = (opts) =>
    opts.agentType === 'Plan' ? 'plan' : opts.isolation === 'worktree' ? 'bypassPermissions' : 'auto'

  // Same layout the Workflow tool uses, so cleanup-worktrees.sh finds these too.
  const addWorktree = () => {
    worktreeCount += 1
    const name = `${runId}-${worktreeCount}`
    const path = join(repoRoot, '.claude', 'worktrees', name)
    mkdirSync(join(repoRoot, '.claude', 'worktrees'), { recursive: true })
    const base = git(repoRoot, 'rev-parse', 'HEAD')
    git(repoRoot, 'worktree', 'add', '-q', '-b', `worktree-${name}`, path, base)
    return { path, branch: `worktree-${name}`, base }
  }

  // An agent that changed nothing leaves nothing behind, as with the Workflow tool.
  const dropIfUnchanged = (wt) => {
    const clean = git(wt.path, 'status', '--porcelain') === '' && git(wt.path, 'rev-parse', 'HEAD') === wt.base
    if (!clean) return
    git(repoRoot, 'worktree', 'remove', '--force', wt.path)
    git(repoRoot, 'branch', '-D', wt.branch)
  }

  const agent = (prompt, opts = {}) => limit(async () => {
    if (interruptedBy) return null
    agentCount += 1
    if (agentCount > MAX_AGENTS) throw new Error(`more than ${MAX_AGENTS} agents in one run`)
    const label = opts.label ?? `agent-${agentCount}`
    const wt = opts.isolation === 'worktree' ? addWorktree() : null
    const cliArgs = ['-p', '--output-format', 'json', '--permission-mode', permissionMode(opts)]
    if (opts.agentType && !['Plan', 'general-purpose'].includes(opts.agentType)) cliArgs.push('--agent', opts.agentType)
    if (opts.model) cliArgs.push('--model', opts.model)
    if (opts.effort) cliArgs.push('--effort', opts.effort)
    if (opts.schema) cliArgs.push('--json-schema', JSON.stringify(opts.schema))
    log(`[${opts.phase ?? currentPhase}] ${label}: started`)
    try {
      const { code, signal, stdout, stderr, stoppedBy, inputError } = await runClaude(prompt, cliArgs, wt?.path ?? repoRoot, timeoutMs, graceMs)
      let reply = null
      try { reply = JSON.parse(stdout) } catch { reply = null }
      if (stoppedBy || inputError || code !== 0 || !reply || reply.is_error) {
        log(`[${opts.phase ?? currentPhase}] ${label}: failed (${stoppedBy === 'timeout' ? `timed out after ${timeoutMs}ms` : stoppedBy ? `interrupted by ${stoppedBy}` : signal ? `signal ${signal}` : `exit ${code}`}) ${String(inputError ?? reply?.result ?? stderr).slice(0, 300)}`)
        return null
      }
      log(`[${opts.phase ?? currentPhase}] ${label}: done`)
      if (opts.schema) return reply.structured_output ?? null
      return typeof reply.result === 'string' ? reply.result : null
    } finally {
      if (wt) {
        try { dropIfUnchanged(wt) } catch (error) { log(`${label}: could not check worktree ${wt.path}: ${error.message}`) }
      }
    }
  })

  // A failed thunk resolves to null; the call itself never rejects.
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)))

  // Each item runs through every stage on its own; a throwing stage drops that item to null.
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, index) => {
    try {
      let value = item
      for (const stage of stages) value = await stage(value, item, index)
      return value
    } catch {
      return null
    }
  }))

  const phase = (title) => { currentPhase = title; log(`== ${title}`) }
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  const workflow = () => { throw new Error('nested workflow() is not supported by run-workflow.mjs') }

  return { agent, parallel, pipeline, phase, log, budget, workflow }
}

export const loadScript = (source) => {
  const body = source.replace(/^export const meta =/m, 'const meta =')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  return new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', body)
}

export const newRunId = () => `wf_${randomBytes(4).toString('hex')}-${String(randomBytes(2).readUInt16BE() % 1000).padStart(3, '0')}`

const main = async () => {
  const opts = parseCli(process.argv.slice(2))
  let repoRoot
  try { repoRoot = git(process.cwd(), 'rev-parse', '--show-toplevel') } catch { repoRoot = process.cwd() }
  const runId = newRunId()
  const rt = createRuntime({ repoRoot, runId })
  rt.log(`Run ID: ${runId}`)
  const script = loadScript(readFileSync(opts.scriptPath, 'utf8'))
  const result = await script(opts.args, rt.agent, rt.parallel, rt.pipeline, rt.phase, rt.log, rt.budget, rt.workflow)
  const output = JSON.stringify({ runId, result }, null, 2)
  if (opts.out) writeFileSync(opts.out, `${output}\n`)
  process.stdout.write(`${output}\n`)
}

// Run main only when executed directly, not when a test imports this file.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`run-workflow: ${error.stack ?? error}\n`)
    process.exit(1)
  })
}
