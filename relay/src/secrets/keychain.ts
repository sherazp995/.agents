import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { SecretNotFoundError } from './provider.js'
import type { SecretProvider } from './provider.js'
import { registerSecretValue } from './scrubber.js'

const SECURITY_BINARY_PATH = '/usr/bin/security'

export type ExecFileFn = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>

/**
 * How a Keychain item is read: which program, with which arguments. CLI
 * entrypoints read through `/usr/bin/security`, which is not on relay's
 * items' access list, so macOS asks the operator first. The daemon reads
 * through `relay-secrets` (native/relay-secrets), the one program on that
 * list, which answers only its parent daemon.
 */
export type KeychainReader = { readonly file: string; readonly args: (name: string) => readonly string[] }

export const SECURITY_READER: KeychainReader = {
  file: SECURITY_BINARY_PATH,
  args: (name) => ['find-generic-password', '-s', name, '-w'],
}

/** Where `relay install-service` builds the helper, and where it finds the daemon's pid file (`../run`). */
export function relaySecretsHelperPath(relayHome: string): string {
  return join(relayHome, 'bin', 'relay-secrets')
}

export function daemonPidFilePath(relayHome: string): string {
  return join(relayHome, 'run', 'relay-daemon.pid')
}

export function relaySecretsReader(relayHome: string): KeychainReader {
  return { file: relaySecretsHelperPath(relayHome), args: (name) => ['get', name] }
}

/** The approval receipt HMAC key (src/approvals/receipt.ts), read by the daemon only. */
export const APPROVAL_RECEIPT_KEY_SECRET = 'relay-approval-receipt-key'
/** The `relay_app` connection URL that `database.url: keystore:relay-database-url` names after `relay secrets migrate`. */
export const DATABASE_URL_SECRET = 'relay-database-url'
/** The URL config held before migration, kept so the operator still has it; nothing in relay reads it. */
export const DATABASE_ADMIN_URL_SECRET = 'relay-database-admin-url'

/**
 * Runs a file with an argument array, never a shell string, so nothing in
 * `args` is ever shell-interpreted or assembled into a command line. Wraps
 * `execFile` in a plain Promise rather than `util.promisify` so tests can
 * inject a fake without relying on `child_process`'s own promisify
 * customisation.
 */
function defaultExecFile(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args as string[], (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Reads secrets from the macOS Keychain through a KeychainReader, by default
 * `/usr/bin/security find-generic-password -s <name> -w`. The argument
 * vector carries only the service name and flags, since process arguments
 * are visible to any user on the machine through the process table; the
 * secret value comes back solely through stdout. There is no write/set
 * method on SecretProvider, so no code path in this class can ever place a
 * value on a command line.
 */
export class KeychainSecretProvider implements SecretProvider {
  readonly kind: 'keychain' = 'keychain'
  readonly #execFile: ExecFileFn
  readonly #reader: KeychainReader

  constructor(execFileFn: ExecFileFn = defaultExecFile, options: { readonly reader?: KeychainReader } = {}) {
    this.#execFile = execFileFn
    this.#reader = options.reader ?? SECURITY_READER
  }

  async get(name: string): Promise<string> {
    try {
      const { stdout } = await this.#execFile(this.#reader.file, this.#reader.args(name))
      // Trim the trailing newline security prints after the value; the
      // helper prints none, and a stored value never ends in one.
      const value = stdout.replace(/\r?\n$/, '')
      // Registers the value with the process-wide scrubber (src/secrets/scrubber.js)
      // before returning it, so any output built later, even one that skips
      // redacting at its own construction site, still gets this value scrubbed
      // at the output boundary. This is the single choke point every Keychain
      // secret passes through, so registering here is what makes that
      // protection the default rather than something each caller opts into.
      registerSecretValue(value)
      return value
    } catch {
      // A non-zero exit, or the binary being unreachable at all, both mean
      // the caller cannot get the secret. Never fold stdout or stderr into
      // the error: either could echo Keychain prompt or item text we do
      // not want repeated in a log or an error message.
      throw new SecretNotFoundError(name)
    }
  }

  async has(name: string): Promise<boolean> {
    try {
      await this.get(name)
      return true
    } catch (error) {
      if (error instanceof SecretNotFoundError) return false
      throw error
    }
  }
}

export type KeychainItemStatus = 'missing' | 'relay-only' | 'shared'

/**
 * Whether an item exists and whether its access list holds only the helper,
 * from `relay-secrets status`. It prints no secret and needs no daemon
 * parent; "shared" also covers an item a rebuilt helper can no longer read
 * silently. That its probe read raises no dialog is unverified
 * (native/relay-secrets). Any other answer is an
 * error, never a guess.
 */
export async function keychainItemStatus(
  name: string,
  helperPath: string,
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<KeychainItemStatus> {
  const { stdout } = await execFileFn(helperPath, ['status', name])
  const status = stdout.trim()
  if (status === 'missing' || status === 'relay-only' || status === 'shared') return status
  throw new Error(`relay-secrets status ${name} answered something other than missing, relay-only or shared`)
}
