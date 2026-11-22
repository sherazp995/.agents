/**
 * Answers sudo's password prompt for one shell job (README, "Shell from
 * Slack"). A private 0700 folder holds:
 *   - `sudo`: runs the real sudo with `-A`, so it asks $SUDO_ASKPASS instead of a terminal;
 *   - `askpass`: runs Node on `helper.mjs` (askpass-helper.ts) with sudo's prompt;
 *   - `helper.mjs`, and the Unix socket the helper asks.
 * Each helper connection carries a random token; a valid one calls `answer`,
 * whose password goes back down that connection and is not kept anywhere.
 *
 * This module takes no logger on purpose: nothing here may write a password.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HELPER_SOURCE } from './askpass-helper.js'
import type { AskpassHandle, PasswordAnswerer } from './types.js'

const DEFAULT_REAL_SUDO = '/usr/bin/sudo'
/** Short, because macOS caps a Unix socket path at 104 bytes. */
const FOLDER_PREFIX = 'rsh-'
/** A request line is a token and a prompt; anything longer is not one. */
const MAX_REQUEST_BYTES = 16_384
const SOCKET_ENV = 'RELAY_ASKPASS_SOCKET'
const TOKEN_ENV = 'RELAY_ASKPASS_TOKEN'

/** Quotes a value as one single-quoted word for /bin/sh. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o700 })
  await chmod(path, 0o700)
}

type StartAskpassOptions = {
  readonly answer: PasswordAnswerer
  readonly nodeBin?: string
  readonly realSudo?: string
}

export async function startAskpass(options: StartAskpassOptions): Promise<AskpassHandle> {
  const folder = await mkdtemp(join(tmpdir(), FOLDER_PREFIX))
  await chmod(folder, 0o700)
  const socketPath = join(folder, 's')
  const helperPath = join(folder, 'helper.mjs')
  const askpassPath = join(folder, 'askpass')
  const token = randomBytes(32).toString('hex')

  try {
    await writeFile(helperPath, HELPER_SOURCE, { mode: 0o600 })
    await writeExecutable(join(folder, 'sudo'), `#!/bin/sh\nexec ${shellQuote(options.realSudo ?? DEFAULT_REAL_SUDO)} -A "$@"\n`)
    // The socket and token are also set here, so the helper finds them even if sudo hands it a trimmed environment.
    await writeExecutable(
      askpassPath,
      `#!/bin/sh\n${SOCKET_ENV}=${shellQuote(socketPath)} ${TOKEN_ENV}=${shellQuote(token)} exec ${shellQuote(options.nodeBin ?? process.execPath)} ${shellQuote(helperPath)} "$@"\n`,
    )
    const server = await listen(folder, socketPath, token, options.answer)
    return {
      sudo: { binDir: folder, env: { SUDO_ASKPASS: askpassPath, [SOCKET_ENV]: socketPath, [TOKEN_ENV]: token } },
      close: server.close,
    }
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
}

function tokenMatches(expected: Buffer, given: unknown): boolean {
  if (typeof given !== 'string') return false
  const givenBytes = Buffer.from(given)
  return givenBytes.length === expected.length && timingSafeEqual(givenBytes, expected)
}

/** The prompt from a request line carrying the right token, or undefined for anything else. */
function readRequest(line: string, expectedToken: Buffer): string | undefined {
  let request: unknown
  try {
    request = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof request !== 'object' || request === null) return undefined
  const { token, prompt } = request as { token?: unknown; prompt?: unknown }
  if (!tokenMatches(expectedToken, token) || typeof prompt !== 'string') return undefined
  return prompt
}

async function listen(folder: string, socketPath: string, token: string, answer: PasswordAnswerer): Promise<{ close: () => Promise<void> }> {
  const expectedToken = Buffer.from(token)
  const closing = new AbortController()
  const connections = new Set<Socket>()

  const serve = (socket: Socket): void => {
    connections.add(socket)
    const request = new AbortController()
    const onClosing = (): void => request.abort('askpass closed')
    closing.signal.addEventListener('abort', onClosing, { once: true })
    socket.on('close', () => {
      connections.delete(socket)
      closing.signal.removeEventListener('abort', onClosing)
      request.abort('helper went away')
    })
    socket.on('error', () => socket.destroy())

    let received = ''
    let asked = false
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (asked) return
      received += chunk
      const newline = received.indexOf('\n')
      if (newline === -1) {
        if (received.length > MAX_REQUEST_BYTES) socket.destroy()
        return
      }
      asked = true
      const prompt = readRequest(received.slice(0, newline), expectedToken)
      received = ''
      if (prompt === undefined) {
        socket.destroy()
        return
      }
      answer({ prompt }, request.signal).then(
        (password) => reply(socket, password),
        () => reply(socket, undefined),
      )
    })
  }

  const server = createServer(serve)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // A socket error after listening must not crash the daemon; close() is the way out.
  server.on('error', () => undefined)

  let closed: Promise<void> | undefined
  const close = (): Promise<void> => {
    closed ??= (async () => {
      closing.abort('askpass closed')
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of connections) socket.destroy()
      await stopped
      await rm(folder, { recursive: true, force: true })
    })()
    return closed
  }
  return { close }
}

function reply(socket: Socket, password: string | undefined): void {
  if (socket.destroyed) return
  socket.end(`${JSON.stringify(password === undefined ? { cancel: true } : { password })}\n`)
}
