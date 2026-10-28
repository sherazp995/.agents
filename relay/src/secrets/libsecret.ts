/**
 * The Linux equivalent of `KeychainSecretProvider`: reads secrets from the
 * freedesktop Secret Service through `secret-tool`, which is what
 * GNOME Keyring, KWallet and every other libsecret-backed store expose.
 *
 * WHY THIS EXISTS RATHER THAN AN ENVIRONMENT VARIABLE. FR-SLA-6 requires
 * Slack tokens live in an OS keystore and never in an environment dump, and
 * `src/secrets/index.ts` deliberately makes `EnvSecretProvider` unreachable
 * from configuration for that reason. Supporting Linux by relaxing that rule
 * would trade a security property for a platform, so this keeps the property
 * and adds the platform: same guarantee, different keystore.
 *
 * The argument shape mirrors the Keychain provider on purpose. Both pass the
 * secret's NAME on the command line and receive the VALUE on stdout, because
 * process arguments are readable by any user on the machine through the
 * process table. Neither provider has a write method, so no code path in
 * either class can put a secret value on a command line.
 *
 * NOT VERIFIED ON A REAL LINUX MACHINE. This was written and tested on
 * macOS, with the same injected-`execFile` seam the Keychain provider uses,
 * so its logic is covered to the same standard as that one. What is NOT
 * covered is whether `secret-tool`'s real output framing matches on a live
 * desktop. Stated here rather than implied, because this project's own
 * discipline is that running the real artifact is what proves it.
 */

import { execFile } from 'node:child_process'

import { SecretNotFoundError } from './provider.js'
import type { SecretProvider } from './provider.js'
import { registerSecretValue } from './scrubber.js'

/** Resolved from PATH rather than pinned absolutely: distributions place it in /usr/bin and /bin inconsistently, unlike macOS's /usr/bin/security. */
export const SECRET_TOOL_BINARY = 'secret-tool'

/**
 * The attribute pair a secret is stored under. `secret-tool` has no notion
 * of a "service" the way `security -s` does, so a convention is required and
 * this is it: one attribute named `service`, whose value is the secret name.
 *
 * Stored with:
 *   secret-tool store --label="Relay: relay-slack-bot-token" service relay-slack-bot-token
 */
export const SECRET_TOOL_ATTRIBUTE = 'service'

type ExecFileFn = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>

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

export class LibSecretProvider implements SecretProvider {
  readonly kind: 'libsecret' = 'libsecret'
  readonly #execFile: ExecFileFn

  constructor(execFileFn: ExecFileFn = defaultExecFile) {
    this.#execFile = execFileFn
  }

  async get(name: string): Promise<string> {
    try {
      const { stdout } = await this.#execFile(SECRET_TOOL_BINARY, ['lookup', SECRET_TOOL_ATTRIBUTE, name])
      // `secret-tool lookup` prints the value with NO trailing newline, unlike
      // `security -w`. Trimming only a trailing newline rather than all
      // whitespace, so a secret that legitimately ends in a space survives.
      const value = stdout.replace(/\r?\n$/, '')
      // An absent secret is an EMPTY STDOUT AND A ZERO EXIT, not an error, so
      // this is the case that would otherwise return "" and be treated as a
      // real token by everything downstream.
      if (value === '') throw new SecretNotFoundError(name)
      // Same choke point as the Keychain provider: registering here is what
      // makes scrubbing the default rather than each caller's job.
      registerSecretValue(value)
      return value
    } catch (error) {
      if (error instanceof SecretNotFoundError) throw error
      // A MISSING BINARY IS NOT AN ABSENT SECRET. Collapsing ENOENT into
      // SecretNotFoundError told the operator their token was not stored,
      // when the real problem was that libsecret is not installed. They
      // would then re-store the secret, watch it still fail, and have no
      // path to the actual cause.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `${SECRET_TOOL_BINARY} is not installed, so Relay cannot read secrets from the Secret Service. This is a ` +
            'missing dependency, not a missing secret. Install libsecret-tools (Debian/Ubuntu) or libsecret ' +
            '(Fedora/Arch), or set secrets.provider to a keystore this machine has.',
        )
      }
      // Never fold stdout or stderr into the error: either could echo prompt
      // or item text that should not be repeated in a log.
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
