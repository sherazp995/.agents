import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KeychainSecretProvider,
  keychainItemStatus,
  relaySecretsHelperPath,
  relaySecretsReader,
} from '../../src/secrets/keychain.js'
import { SecretNotFoundError } from '../../src/secrets/provider.js'
import { resetSecretScrubberForTests, scrubSecrets } from '../../src/secrets/scrubber.js'

const SENTINEL = 'SUPERSECRET_VALUE_DO_NOT_LEAK'
const SECURITY_BINARY_PATH = '/usr/bin/security'

/**
 * A skipped test proves nothing, the same rule that cost real defects in
 * the previous milestone, so a missing /usr/bin/security fails these tests
 * outright rather than skipping them.
 */
function assertSecurityBinaryAvailable(): void {
  if (!existsSync(SECURITY_BINARY_PATH)) {
    throw new Error(
      `${SECURITY_BINARY_PATH} is required for this test and was not found on this machine. ` +
        'Failing rather than skipping, since a skipped test proves nothing.',
    )
  }
}

describe('KeychainSecretProvider', () => {
  afterEach(() => {
    resetSecretScrubberForTests()
  })

  it('has kind "keychain"', () => {
    expect(new KeychainSecretProvider().kind).toBe('keychain')
  })

  it('rejects a missing item with SecretNotFoundError naming the item', async () => {
    assertSecurityBinaryAvailable()
    const provider = new KeychainSecretProvider()
    const missingName = `relay-test-missing-${randomUUID()}`

    await expect(provider.get(missingName)).rejects.toBeInstanceOf(SecretNotFoundError)
    try {
      await provider.get(missingName)
      throw new Error('expected get to reject')
    } catch (error) {
      expect((error as Error).message).toContain(missingName)
    }
  })

  it('has returns false for a missing item without throwing', async () => {
    assertSecurityBinaryAvailable()
    const provider = new KeychainSecretProvider()
    const missingName = `relay-test-missing-${randomUUID()}`

    await expect(provider.has(missingName)).resolves.toBe(false)
  })

  it('never passes a secret value as a command-line argument on read, and has no write path at all', async () => {
    const executions: Array<{ file: string; args: readonly string[] }> = []
    const fakeExecFile = async (file: string, args: readonly string[]) => {
      executions.push({ file, args })
      // The value legitimately returns via stdout, never an argument.
      return { stdout: `${SENTINEL}\n`, stderr: '' }
    }
    const provider = new KeychainSecretProvider(fakeExecFile)

    const value = await provider.get('relay-slack-bot-token')
    expect(value).toBe(SENTINEL)

    expect(executions).toHaveLength(1)
    const execution = executions[0]
    expect(execution).toBeDefined()
    expect(execution?.file).toBe('/usr/bin/security')
    expect(execution?.args).toEqual(['find-generic-password', '-s', 'relay-slack-bot-token', '-w'])
    expect(execution?.args).not.toContain(SENTINEL)

    // SecretProvider has no set/write method, so there is no code path
    // that could ever place a value on a command line.
    expect((provider as unknown as { set?: unknown }).set).toBeUndefined()
  })

  /**
   * FR-SEC-1 backstop (src/secrets/scrubber.ts): `get` is the single choke
   * point every Keychain-sourced secret value passes through, so
   * registering the value there is what makes scrubbing the default
   * instead of something every future caller has to opt into. This proves
   * the registration actually happens: scrubSecrets could not redact this
   * value at all unless `get` had registered it.
   */
  it('registers the value it returns with the secret scrubber, so a future output boundary can redact it', async () => {
    const fakeExecFile = async () => ({ stdout: `${SENTINEL}\n`, stderr: '' })
    const provider = new KeychainSecretProvider(fakeExecFile)

    await provider.get('relay-slack-bot-token')

    expect(scrubSecrets(`leaked in some unrelated error: ${SENTINEL}`)).not.toContain(SENTINEL)
  })

  it('reads through relay-secrets when given its reader, with only the item name on argv', async () => {
    const executions: Array<{ file: string; args: readonly string[] }> = []
    const provider = new KeychainSecretProvider(
      async (file, args) => {
        executions.push({ file, args })
        return { stdout: SENTINEL, stderr: '' }
      },
      { reader: relaySecretsReader('/Users/op/.relay') },
    )

    await expect(provider.get('relay-database-url')).resolves.toBe(SENTINEL)
    expect(executions).toEqual([{ file: '/Users/op/.relay/bin/relay-secrets', args: ['get', 'relay-database-url'] }])
  })

  it('a refused helper call reads as a missing secret, never as its stderr', async () => {
    const provider = new KeychainSecretProvider(
      async () => {
        throw Object.assign(new Error('relay-secrets: refused, the caller is not the relay daemon'), { code: 77 })
      },
      { reader: relaySecretsReader('/r') },
    )

    await expect(provider.get('relay-approval-receipt-key')).rejects.toBeInstanceOf(SecretNotFoundError)
  })
})

describe('keychainItemStatus', () => {
  it('asks the helper, and accepts only its three answers', async () => {
    const calls: Array<readonly string[]> = []
    const answer = (stdout: string) => async (_file: string, args: readonly string[]) => {
      calls.push(args)
      return { stdout, stderr: '' }
    }

    await expect(keychainItemStatus('relay-x', relaySecretsHelperPath('/r'), answer('relay-only\n'))).resolves.toBe('relay-only')
    await expect(keychainItemStatus('relay-x', '/r/bin/relay-secrets', answer('missing\n'))).resolves.toBe('missing')
    await expect(keychainItemStatus('relay-x', '/r/bin/relay-secrets', answer('maybe\n'))).rejects.toThrow(/relay-x/)
    expect(calls[0]).toEqual(['status', 'relay-x'])
  })
})
