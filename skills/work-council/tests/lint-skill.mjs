// Checks the skill stays shareable: run with `node tests/lint-skill.mjs`; exits 1 on any problem.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = dirname(skillDir)
const problems = []

// Skills this one may use. Each must be a real folder in the same skills folder, not a
// symlink or its own git repository, so the parent repository ships it.
const ALLOWED_SIBLINGS = ['llm-council', 'general-review', 'writing-specs', 'workflow-runner']
// Names that would pull in something shipped separately.
const BANNED = [/fable/i, /ponytail/i, /superpowers:/i, /principal-[a-z]+-engineer/i, /~\/\.claude\/agents/]

const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
const own = files(skillDir).filter((f) => /\.(md|js|mjs|sh)$/.test(f) && !f.endsWith('lint-skill.mjs'))

const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
const front = skill.match(/^---\n([\s\S]*?)\n---\n/)
if (!front) problems.push('SKILL.md has no frontmatter')
else {
  if (!/^name: work-council$/m.test(front[1])) problems.push('frontmatter name must be work-council')
  if (!/^description: \S/m.test(front[1])) problems.push('frontmatter description missing')
}

for (const file of own) {
  const text = readFileSync(file, 'utf8')
  for (const re of BANNED) if (re.test(text)) problems.push(`${file}: mentions ${re}`)
  if (/\/Users\/[a-z]/.test(text)) problems.push(`${file}: hard-coded home path`)
  if (file.endsWith('.md')) {
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
      if (/^https?:/.test(target)) continue
      if (!existsSync(resolve(dirname(file), target))) problems.push(`${file}: broken link ${target}`)
    }
  }
}

for (const name of ALLOWED_SIBLINGS) {
  const dir = join(skillsDir, name)
  if (!existsSync(join(dir, 'SKILL.md'))) problems.push(`sibling skill missing: ${name}`)
  else if (lstatSync(dir).isSymbolicLink()) problems.push(`sibling skill is a symlink: ${name}`)
  else if (existsSync(join(dir, '.git'))) problems.push(`sibling skill is its own git repo: ${name}`)
}
if (!existsSync(join(skillsDir, 'llm-council', 'council-workflow.js'))) problems.push('llm-council/council-workflow.js missing')

// Backticked names that look like skills must be allowed siblings (or this skill).
const KNOWN_NON_SKILLS = new Set(['general-purpose', 'only-candidate', 'plan-critique', 'build-workflow', 'council-workflow'])
for (const [, name] of skill.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
  if (name === 'work-council' || ALLOWED_SIBLINGS.includes(name) || KNOWN_NON_SKILLS.has(name)) continue
  if (existsSync(join(skillsDir, name, 'SKILL.md'))) problems.push(`SKILL.md uses skill outside the allow list: ${name}`)
}

if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join('\n'))
  process.exit(1)
}
console.log(`OK ${own.length} files, siblings: ${ALLOWED_SIBLINGS.join(', ')}`)
