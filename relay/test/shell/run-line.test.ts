import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runLine } from '../../src/shell/run-line.js'
import type { RunLineOptions } from '../../src/shell/types.js'

// A real login zsh, as Relay runs it on the owner's Mac.
const SHELL = '/bin/zsh'

let folder: string

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'run-line-test-')))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

function run(command: string, extra: Partial<RunLineOptions> = {}) {
  return runLine({ command, cwd: folder, shell: SHELL, env: process.env, timeoutMs: 10_000, ...extra })
}

/** A sleep duration no other process on this machine is likely running, so ps can find exactly ours. */
function uniqueSleep(base: number): string {
  return `${base}.${process.pid}${Math.floor(Math.random() * 1000)}`
}

function sleepRunning(duration: string): boolean {
  const listing = execFileSync('/bin/ps', ['-axo', 'command']).toString()
  return listing.split('\n').some((line) => line.trim() === `sleep ${duration}`)
}

async function waitUntilGone(duration: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!sleepRunning(duration)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

describe('runLine', () => {
  it('reports the folder a cd ended in, resolved like pwd -P', async () => {
    const result = await run('cd /tmp')

    expect(result.outcome).toEqual({ kind: 'exited', code: 0 })
    expect(result.folderAfter).toBe(realpathSync('/tmp'))
  })

  it.each([
    ['cd /tmp; false', 1],
    ['cd /tmp; exit 3', 3],
    ['cd /tmp; exec true', 0],
    ['if then', 1],
  ])('keeps the old folder when `%s` does not finish with exit 0 in the script', async (command, code) => {
    const result = await run(command)

    expect(result.outcome).toEqual({ kind: 'exited', code })
    expect(result.folderAfter).toBe(folder)
  })

  it('puts the sudo folder ahead of the login profile PATH and adds its env', async () => {
    writeFileSync(join(folder, 'sudo'), '#!/bin/sh\n')
    chmodSync(join(folder, 'sudo'), 0o700)

    const result = await run('command -v sudo; echo "$RELAY_TEST_MARK"', { sudo: { binDir: folder, env: { RELAY_TEST_MARK: 'set' } } })

    expect(result.output.head).toBe(`${join(folder, 'sudo')}\nset\n`)
  })

  it('captures stderr too', async () => {
    const result = await run('echo oops >&2')

    expect(result.output.head).toBe('oops\n')
  })

  it('kills a line at its time limit, with its child', async () => {
    const duration = uniqueSleep(30)
    const started = Date.now()

    const result = await run(`sleep ${duration}; echo never`, { timeoutMs: 300, graceMs: 500 })

    const elapsed = Date.now() - started
    expect(result.outcome).toEqual({ kind: 'killed', why: 'timeout', reason: 'time limit' })
    expect(elapsed).toBeGreaterThanOrEqual(300)
    expect(elapsed).toBeLessThan(5_000)
    expect(await waitUntilGone(duration)).toBe(true)
  })

  it('cancels a running line with the abort reason', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort('stop pressed'), 200)

    const result = await run(`sleep ${uniqueSleep(30)}`, { signal: controller.signal })

    expect(result.outcome).toEqual({ kind: 'killed', why: 'cancelled', reason: 'stop pressed' })
  })

  it('runs nothing when already aborted', async () => {
    const controller = new AbortController()
    controller.abort('kill switch')

    const result = await run('touch ran', { signal: controller.signal })

    expect(result.outcome).toEqual({ kind: 'killed', why: 'cancelled', reason: 'kill switch' })
    expect(existsSync(join(folder, 'ran'))).toBe(false)
  })

  it('does not wait for a backgrounded child that holds the output open', async () => {
    const duration = uniqueSleep(100)
    const started = Date.now()
    try {
      const result = await run(`sleep ${duration} & echo started`)

      expect(result.outcome).toEqual({ kind: 'exited', code: 0 })
      expect(result.output.head).toBe('started\n')
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      execFileSync('/usr/bin/pkill', ['-f', `^sleep ${duration}$`])
    }
  })

  it('reports a signal it did not send', async () => {
    const result = await run('kill -TERM $$')

    expect(result.outcome).toEqual({ kind: 'signal', signal: 'SIGTERM' })
  })

  it('reports a shell that cannot start', async () => {
    const result = await run('true', { shell: join(folder, 'missing-shell') })

    expect(result.outcome.kind).toBe('spawn_failed')
    expect(result.folderAfter).toBe(folder)
  })

  it('keeps the head and tail of big output and counts what was left out', async () => {
    const result = await run("printf HEAD; head -c 20000 /dev/zero | tr '\\0' x; printf TAIL")

    expect(result.outcome).toEqual({ kind: 'exited', code: 0 })
    expect(result.output.head).toBe(`HEAD${'x'.repeat(5996)}`)
    expect(result.output.tail).toBe(`${'x'.repeat(3996)}TAIL`)
    expect(result.output.omittedBytes).toBe(20008 - 10000)
  })

  it('never splits a multibyte character at either cut', async () => {
    const result = await run(`printf '${'é'.repeat(9)}'`, { headBytes: 5, tailBytes: 5 })

    expect(result.output).toEqual({ head: 'éé', tail: 'éé', omittedBytes: 10 })
  })
})
