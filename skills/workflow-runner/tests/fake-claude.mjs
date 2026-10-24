#!/usr/bin/env node
// Stands in for `claude -p` in tests. Logs each call to $FAKE_CLAUDE_LOG and answers by schema shape.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

if (process.env.FAKE_CLOSE_STDIN === '1') process.exit(1)
const args = process.argv.slice(2)
const prompt = readFileSync(0, 'utf8')
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] }
const schema = flag('--json-schema') ? JSON.parse(flag('--json-schema')) : null
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt: prompt.slice(0, 200) }) + '\n')

const reply = (fields) => process.stdout.write(JSON.stringify({ is_error: false, result: '', ...fields }))
if (prompt.includes('FAIL_EXIT')) process.exit(1)
if (prompt.includes('FAIL_ERROR')) { process.stdout.write(JSON.stringify({ is_error: true, result: 'Not logged in' })); process.exit(0) }
if (prompt.includes('WRITE_FILE')) writeFileSync('made-by-agent.txt', 'x\n')
if (prompt.includes('IGNORE_TERM')) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  reply({ result: 'premature success' })
} else if (prompt.includes('DESCENDANT')) {
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'] })
  descendant.unref()
  reply({ result: 'premature success' })
  process.exit(0)
} else {
const props = schema?.properties ?? {}
if (props.codexExit) reply({ structured_output: { codexExit: 0, answer: 'codex answer' } })
else if (props.rankings) {
  const labels = [...prompt.matchAll(/### Response ([A-Z])/g)].map((m) => m[1])
  reply({ structured_output: { rankings: labels.map((label, i) => ({ label, rank: i + 1, reason: 'ok' })) } })
} else if (schema) reply({ structured_output: { ok: true } })
else reply({ result: `text from ${flag('--model') ?? 'default'}` })

}
