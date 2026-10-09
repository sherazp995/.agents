#!/usr/bin/env node
// Stands in for `claude -p` in tests. Logs each call to $FAKE_CLAUDE_LOG and answers by schema shape.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const prompt = readFileSync(0, 'utf8')
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] }
const schema = flag('--json-schema') ? JSON.parse(flag('--json-schema')) : null
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt: prompt.slice(0, 200) }) + '\n')

const reply = (fields) => process.stdout.write(JSON.stringify({ is_error: false, result: '', ...fields }))
if (prompt.includes('FAIL_EXIT')) process.exit(1)
if (prompt.includes('FAIL_ERROR')) { process.stdout.write(JSON.stringify({ is_error: true, result: 'Not logged in' })); process.exit(0) }
if (prompt.includes('WRITE_FILE')) writeFileSync('made-by-agent.txt', 'x\n')
const props = schema?.properties ?? {}
if (props.codexExit) reply({ structured_output: { codexExit: 0, answer: 'codex answer' } })
else if (props.rankings) {
  const labels = [...prompt.matchAll(/### Response ([A-Z])/g)].map((m) => m[1])
  reply({ structured_output: { rankings: labels.map((label, i) => ({ label, rank: i + 1, reason: 'ok' })) } })
} else if (schema) reply({ structured_output: { ok: true } })
else reply({ result: `text from ${flag('--model') ?? 'default'}` })
