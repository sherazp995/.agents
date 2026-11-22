/**
 * The source of the askpass helper that sudo runs (`sudo -A` calls
 * $SUDO_ASKPASS with its prompt as the only argument). askpass.ts writes it
 * as `helper.mjs` into its private folder at job start, so it needs no build
 * step, exec bit or asset copy. Plain JavaScript using node: builtins only.
 *
 * It connects to the job's Unix socket, sends one JSON line
 * `{ token, prompt }`, and reads one JSON line back: `{ password }` is
 * printed with a newline for sudo and exits 0; `{ cancel: true }`, a closed
 * socket or any error exits 1 without printing, which makes sudo fail.
 */
export const HELPER_SOURCE = `import { createConnection } from 'node:net'

const socketPath = process.env.RELAY_ASKPASS_SOCKET
const token = process.env.RELAY_ASKPASS_TOKEN
const prompt = process.argv[2] ?? ''
let finished = false
const fail = () => {
  if (finished) return
  finished = true
  process.exit(1)
}
if (!socketPath || !token) fail()

let received = ''
const socket = createConnection(socketPath)
socket.setEncoding('utf8')
socket.on('connect', () => socket.write(JSON.stringify({ token, prompt }) + '\\n'))
socket.on('data', (chunk) => {
  received += chunk
  const newline = received.indexOf('\\n')
  if (newline === -1) return
  let reply
  try {
    reply = JSON.parse(received.slice(0, newline))
  } catch {
    fail()
    return
  }
  received = ''
  if (finished || reply === null || typeof reply.password !== 'string') {
    fail()
    return
  }
  finished = true
  socket.destroy()
  process.stdout.write(reply.password + '\\n', () => process.exit(0))
})
socket.on('error', fail)
socket.on('close', fail)
`
