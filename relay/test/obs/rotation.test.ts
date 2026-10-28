import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRotatingLogDestination } from '../../src/obs/rotation.js'

const LIVE_NAME = 'relay.log'

function makeTempLogPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-log-rotation-'))
  return { dir, file: join(dir, LIVE_NAME) }
}

function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${line}\n`, (err: Error | null | undefined) => (err ? reject(err) : resolve()))
  })
}

function endStream(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(resolve)
  })
}

/**
 * Resolves once `count` occurrences of `event` have fired, rather than
 * sleeping a fixed delay: rotation and eviction both happen asynchronously
 * inside the library, so a fixed sleep would either be flaky under load or
 * padded so long the suite gets slow. A timeout still guards against a
 * broken guard never firing at all.
 */
function waitForEvent(stream: NodeJS.WritableStream, event: string, count: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = 0
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${count} '${event}' event(s); saw ${seen}`))
    }, timeoutMs)
    stream.on(event, () => {
      seen += 1
      if (seen >= count) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

function rotatedLogFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name !== LIVE_NAME && !name.endsWith('.history'))
}

describe('log rotation (FR-OBS-1)', () => {
  const dirsToClean: string[] = []

  afterEach(() => {
    while (dirsToClean.length > 0) {
      const dir = dirsToClean.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rotates once the active file exceeds its size cap, instead of growing without bound', async () => {
    const { dir, file } = makeTempLogPath()
    dirsToClean.push(dir)
    const stream = createRotatingLogDestination(file, { maxSizeBytes: 200, maxFiles: 10 })

    const rotated = waitForEvent(stream, 'rotated', 1)
    for (let i = 0; i < 40; i++) await writeLine(stream, `line ${i} ${'x'.repeat(10)}`)
    await rotated
    await endStream(stream)

    expect(rotatedLogFiles(dir).length).toBeGreaterThanOrEqual(1)
    // The live file is checked after every write and rotated as soon as it
    // crosses the cap, so it can never run away to an unbounded size.
    expect(statSync(file).size).toBeLessThan(200 * 2)
  })

  it('caps the number of retained rotated files, bounding disk use', async () => {
    const { dir, file } = makeTempLogPath()
    dirsToClean.push(dir)
    const maxFiles = 3
    const stream = createRotatingLogDestination(file, { maxSizeBytes: 100, maxFiles })

    // Proves the cap actively evicts rather than merely never having been
    // exceeded by coincidence: enough data is written to force well past
    // `maxFiles` rotations before the assertion runs.
    const evicted = waitForEvent(stream, 'removed', 3)
    for (let i = 0; i < 200; i++) await writeLine(stream, `line ${i} ${'x'.repeat(10)}`)
    await evicted
    await endStream(stream)

    expect(rotatedLogFiles(dir).length).toBeLessThanOrEqual(maxFiles)
  })

  it('keeps a rotated file at restrictive permissions', async () => {
    const { dir, file } = makeTempLogPath()
    dirsToClean.push(dir)
    const stream = createRotatingLogDestination(file, { maxSizeBytes: 200, maxFiles: 10 })

    const rotated = waitForEvent(stream, 'rotated', 1)
    for (let i = 0; i < 40; i++) await writeLine(stream, `line ${i} ${'x'.repeat(10)}`)
    await rotated
    await endStream(stream)

    const rotatedFiles = rotatedLogFiles(dir)
    expect(rotatedFiles.length).toBeGreaterThanOrEqual(1)
    for (const name of rotatedFiles) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600)
    }
  })

  it('restricts the rotation history file too, not only the log files themselves', async () => {
    const { dir, file } = makeTempLogPath()
    dirsToClean.push(dir)
    const stream = createRotatingLogDestination(file, { maxSizeBytes: 100, maxFiles: 2 })

    const evicted = waitForEvent(stream, 'removed', 1)
    for (let i = 0; i < 100; i++) await writeLine(stream, `line ${i} ${'x'.repeat(10)}`)
    await evicted
    await endStream(stream)

    expect(statSync(`${file}.history`).mode & 0o777).toBe(0o600)
  })

  it('restricts a pre-existing, more permissive live file once it is opened', async () => {
    const { dir, file } = makeTempLogPath()
    dirsToClean.push(dir)
    writeFileSync(file, '', { mode: 0o644 })
    expect(statSync(file).mode & 0o777).toBe(0o644)

    const stream = createRotatingLogDestination(file, { maxSizeBytes: 10_000, maxFiles: 5 })
    await writeLine(stream, 'first line')
    await endStream(stream)

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('does not lose a line written while rotation is happening', async () => {
    const { dir, file } = makeTempLogPath()
    dirsToClean.push(dir)
    // maxFiles is generous enough that nothing is evicted during this run,
    // so a missing line can only mean rotation dropped it in flight, not
    // that retention intentionally discarded it (that is the separate,
    // expected behaviour the maxFiles test above already covers).
    const stream = createRotatingLogDestination(file, { maxSizeBytes: 150, maxFiles: 1000 })

    const lines = Array.from({ length: 300 }, (_, i) => `line-${i}-${'z'.repeat(15)}`)
    for (const line of lines) await writeLine(stream, line)
    await endStream(stream)

    const files = readdirSync(dir).filter((name) => !name.endsWith('.history'))
    // Confirms rotation actually happened during this run; otherwise the
    // loop below would trivially pass against a single untouched file.
    expect(files.length).toBeGreaterThan(1)
    const combined = files.map((name) => readFileSync(join(dir, name), 'utf8')).join('')
    for (const line of lines) {
      expect(combined).toContain(line)
    }
  })
})
