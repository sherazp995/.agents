import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RelayConfig } from '../config/schema.js'
import { createSecretProvider } from './index.js'
import { daemonPidFilePath, type ExecFileFn, KeychainSecretProvider, relaySecretsHelperPath, relaySecretsReader } from './keychain.js'
import type { SecretProvider } from './provider.js'

export type DaemonSecretDependencies = {
  readonly execFile?: ExecFileFn
  readonly pathExists?: (path: string) => boolean
  readonly writePidFile?: (path: string, pid: number) => void
  readonly removePidFile?: (path: string, pid: number) => void
  /** Registers the pid file's removal for process exit; `process.once('exit', ...)` in production. */
  readonly onExit?: (handler: () => void) => void
  readonly pid?: number
}

/** `mode` applies only to a new file, so an existing one is chmodded too. */
export function writePidFile(path: string, pid: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${pid}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Removes the file only while it still names this process, so a newer daemon's file survives. */
export function removePidFile(path: string, pid: number): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(pid)) rmSync(path, { force: true })
  } catch {
    // Already gone.
  }
}

/**
 * The daemon's secret provider. On the Keychain it reads only through
 * `relay-secrets` (user decision 7), the one program on relay's items'
 * access list, which answers only the pid recorded here; so the pid file is
 * written before the first read, and a missing helper stops startup naming
 * it. CLI entrypoints keep `createSecretProvider`, which reads through
 * `/usr/bin/security` and so raises a keychain dialog for the operator.
 */
export function createDaemonSecretProvider(
  config: RelayConfig,
  relayHome: string,
  deps: DaemonSecretDependencies = {},
): SecretProvider {
  if (config.secrets.provider !== 'keychain') return createSecretProvider(config)
  const helperPath = relaySecretsHelperPath(relayHome)
  if (!(deps.pathExists ?? existsSync)(helperPath)) {
    throw new Error(`${helperPath} does not exist; run \`relay install-service\`, which builds it`)
  }
  // A pid file left behind would let whatever process later reuses that pid
  // read relay's secrets, so it goes when the daemon exits by any path.
  const pidFile = daemonPidFilePath(relayHome)
  const pid = deps.pid ?? process.pid
  ;(deps.writePidFile ?? writePidFile)(pidFile, pid)
  ;(deps.onExit ?? ((handler) => process.once('exit', handler)))(() => (deps.removePidFile ?? removePidFile)(pidFile, pid))
  return new KeychainSecretProvider(deps.execFile, { reader: relaySecretsReader(relayHome) })
}
