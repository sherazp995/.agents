import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startAskpass } from '../../src/shell/askpass.js'
import { runLine } from '../../src/shell/run-line.js'
import type { AskpassHandle, PasswordAnswerer, PasswordRequest } from '../../src/shell/types.js'

// Stands in for /usr/bin/sudo: insists on -A, asks $SUDO_ASKPASS like sudo does, shows what it got, then runs the command.
const FAKE_SUDO = `#!/bin/sh
[ "$1" = "-A" ] || { echo "fake sudo: no -A" >&2; exit 2; }
shift
value=$("$SUDO_ASKPASS" "Password:") || { echo "fake sudo: askpass failed" >&2; exit 1; }
printf 'got:%s\\n' "$value"
exec "$@"
`

let fakeSudoFolder: string
let handle: AskpassHandle | undefined
let requests: PasswordRequest[]

beforeEach(() => {
  fakeSudoFolder = realpathSync(mkdtempSync(join(tmpdir(), 'askpass-test-')))
  writeFileSync(join(fakeSudoFolder, 'sudo'), FAKE_SUDO)
  chmodSync(join(fakeSudoFolder, 'sudo'), 0o700)
  requests = []
})

afterEach(async () => {
  await handle?.close()
  handle = undefined
  rmSync(fakeSudoFolder, { recursive: true, force: true })
})

async function start(answer: PasswordAnswerer): Promise<AskpassHandle> {
  handle = await startAskpass({
    realSudo: join(fakeSudoFolder, 'sudo'),
    answer: (request, signal) => {
      requests.push(request)
      return answer(request, signal)
    },
  })
  return handle
}

function runSudo(askpass: AskpassHandle, command: string) {
  return runLine({ command, cwd: fakeSudoFolder, shell: '/bin/zsh', env: process.env, timeoutMs: 10_000, sudo: askpass.sudo })
}

describe('startAskpass', () => {
  it('hands the answered password to sudo', async () => {
    const askpass = await start(async () => 's3cr3t')

    const result = await runSudo(askpass, 'sudo echo hi')

    expect(result.outcome).toEqual({ kind: 'exited', code: 0 })
    expect(result.output.head).toBe('got:s3cr3t\nhi\n')
    expect(requests).toEqual([{ prompt: 'Password:' }])
  })

  it('makes sudo fail when there is no answer', async () => {
    const askpass = await start(async () => undefined)

    const result = await runSudo(askpass, 'sudo echo hi')

    expect(result.outcome).toEqual({ kind: 'exited', code: 1 })
    expect(result.output.head).toBe('fake sudo: askpass failed\n')
  })

  it.each([['x'], [`it's "a b" $HOME \\n`]])('round trips the password %j exactly', async (password) => {
    const askpass = await start(async () => password)

    const result = await runSudo(askpass, 'sudo true')

    expect(result.output.head).toBe(`got:${password}\n`)
  })

  it('closes a connection with the wrong token without asking', async () => {
    const askpass = await start(async () => 's3cr3t')
    const socket = createConnection(askpass.sudo.env.RELAY_ASKPASS_SOCKET as string)
    let received = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (received += chunk))

    socket.write(`${JSON.stringify({ token: '0'.repeat(64), prompt: 'Password:' })}\n`)
    await new Promise((resolve) => socket.on('close', resolve))

    expect(received).toBe('')
    expect(requests).toEqual([])
  })

  it('close() fails a waiting helper, aborts its answer and removes the folder', async () => {
    let answerSignal: AbortSignal | undefined
    let asked: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => (asked = resolve))
    const askpass = await start((_request, signal) => {
      answerSignal = signal
      asked()
      return new Promise(() => undefined)
    })
    const helper = spawn(askpass.sudo.env.SUDO_ASKPASS as string, ['Password:'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let printed = ''
    helper.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()))
    const exitCode = new Promise((resolve) => helper.on('exit', resolve))
    await waiting

    await askpass.close()

    expect(await exitCode).toBe(1)
    expect(printed).toBe('')
    expect(answerSignal?.aborted).toBe(true)
    expect(existsSync(askpass.sudo.binDir)).toBe(false)
  })
})
