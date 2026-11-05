import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// CI config: runs only the test files that need no Postgres, Redis or macOS.
// Each test file declares its own needs; this config reads them from the file text.
const root = fileURLToPath(new URL('.', import.meta.url))

const NEEDS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: 'imports support/database', pattern: /from\s+['"][^'"]*support\/database(\.js)?['"]/ },
  { reason: 'reads RELAY_TEST_DATABASE_URL', pattern: /RELAY_TEST_DATABASE_URL/ },
  { reason: 'reads RELAY_TEST_REDIS_URL', pattern: /RELAY_TEST_REDIS_URL/ },
  { reason: 'marked relay-test-needs (macOS tools or the real local services)', pattern: /^\/\/ relay-test-needs: \S+/m },
]

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return testFiles(path)
    return entry.name.endsWith('.test.ts') ? [relative(root, path)] : []
  })
}

const selected: string[] = []
const excluded: Array<{ file: string; reason: string }> = []
for (const file of testFiles(join(root, 'test')).sort()) {
  const text = readFileSync(join(root, file), 'utf8')
  const need = NEEDS.find(({ pattern }) => pattern.test(text))
  if (need) excluded.push({ file, reason: need.reason })
  else selected.push(file)
}

console.log(`relay test:ci: ${selected.length} selected, ${excluded.length} excluded`)
for (const { file, reason } of excluded) console.log(`  excluded ${file}: ${reason}`)

export default defineConfig({
  // include paths are relative to this folder, so pin vitest's root to it.
  root,
  test: {
    environment: 'node',
    include: selected,
    reporters: ['default'],
  },
})
