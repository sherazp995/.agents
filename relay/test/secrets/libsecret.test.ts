import { describe, expect, it, vi } from 'vitest'

import { LibSecretProvider, SECRET_TOOL_ATTRIBUTE, SECRET_TOOL_BINARY } from '../../src/secrets/libsecret.js'
import { SecretNotFoundError } from '../../src/secrets/provider.js'
import { scrubSecrets } from '../../src/secrets/scrubber.js'

/**
 * The Linux keystore provider. Its reason for existing is that supporting
 * Linux by allowing an environment variable would trade FR-SLA-6's "never in
 * an environment dump" for a platform; this keeps the guarantee and changes
 * the keystore.
 *
 * The case worth the most attention is an ABSENT secret. `secret-tool
 * lookup` exits ZERO with empty stdout when nothing matches, unlike
 * `security`, which exits non-zero. A provider that only checked the exit
 * code would return "" and every caller downstream would treat an empty
 * string as a valid token.
 */

function provider(execFileFn: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>) {
  return new LibSecretProvider(execFileFn)
}

describe('LibSecretProvider', () => {
  it('looks the secret up by the attribute convention, since secret-tool has no service concept', async () => {
    const seen: Array<[string, readonly string[]]> = []

    const value = await provider(async (file, args) => {
      seen.push([file, args])
      return { stdout: 'xoxb-the-token', stderr: '' }
    }).get('relay-slack-bot-token')

    expect(value).toBe('xoxb-the-token')
    expect(seen[0]?.[0]).toBe(SECRET_TOOL_BINARY)
    expect(seen[0]?.[1]).toEqual(['lookup', SECRET_TOOL_ATTRIBUTE, 'relay-slack-bot-token'])
  })

  it('TREATS EMPTY STDOUT AS ABSENT, because secret-tool exits zero when nothing matches', async () => {
    // The failure this prevents: returning "" as though it were a token, and
    // every caller downstream believing it.
    await expect(provider(async () => ({ stdout: '', stderr: '' })).get('missing')).rejects.toBeInstanceOf(SecretNotFoundError)
  })

  it('treats a non-zero exit as absent rather than leaking what the command said', async () => {
    // stderr could echo prompt or item text that should not reach a log.
    await expect(
      provider(async () => {
        throw new Error('secret-tool: no such secret collection at path /org/freedesktop/secrets/aliases/default')
      }).get('missing'),
    ).rejects.toBeInstanceOf(SecretNotFoundError)
  })

  it('distinguishes a MISSING BINARY from an absent secret', async () => {
    // Collapsing ENOENT into SecretNotFoundError told the operator their
    // token was not stored, when the real problem was that libsecret is not
    // installed. They would re-store the secret, watch it still fail, and
    // have no path to the actual cause.
    const missingBinary = Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' })
    const error = await provider(async () => {
      throw missingBinary
    })
      .get('name')
      .catch((thrown: unknown) => thrown)

    expect(error).not.toBeInstanceOf(SecretNotFoundError)
    expect(String(error)).toContain('not installed')
    expect(String(error)).toContain('missing dependency, not a missing secret')
  })

  it('never folds command output into the error message', async () => {
    const error = await provider(async () => {
      throw new Error('SENSITIVE-PROMPT-TEXT')
    })
      .get('name')
      .catch((thrown: unknown) => thrown)

    expect(String(error)).not.toContain('SENSITIVE-PROMPT-TEXT')
  })

  it('trims only a trailing newline, so a secret ending in a space survives', async () => {
    const value = await provider(async () => ({ stdout: 'token-with-trailing-space \n', stderr: '' })).get('name')

    expect(value).toBe('token-with-trailing-space ')
  })

  it('registers the value with the scrubber, so it cannot appear in later output', async () => {
    // Same choke point as the Keychain provider: registering here makes
    // scrubbing the default rather than each caller's job.
    await provider(async () => ({ stdout: 'super-secret-linux-value', stderr: '' })).get('name')

    expect(scrubSecrets('the token is super-secret-linux-value')).not.toContain('super-secret-linux-value')
  })

  it('has() answers without throwing', async () => {
    const present = provider(async () => ({ stdout: 'v', stderr: '' }))
    const absent = provider(async () => ({ stdout: '', stderr: '' }))

    expect(await present.has('a')).toBe(true)
    expect(await absent.has('a')).toBe(false)
  })

  it('passes the NAME on the command line and takes the VALUE from stdout, never the reverse', async () => {
    // Process arguments are readable by any user on the machine, so a value
    // must never appear in argv. There is no write method on the interface,
    // which is what makes this structural rather than a convention.
    const seen: string[] = []
    await provider(async (_file, args) => {
      seen.push(...args)
      return { stdout: 'the-value', stderr: '' }
    }).get('the-name')

    expect(seen).toContain('the-name')
    expect(seen).not.toContain('the-value')
  })
})

describe('createSecretProvider accepts only OS keystores', () => {
  it('never returns an environment-backed provider, per FR-SLA-6', async () => {
    const { createSecretProvider } = await import('../../src/secrets/index.js')

    expect(createSecretProvider({ secrets: { provider: 'keychain' } } as never).kind).toBe('keychain')
    expect(createSecretProvider({ secrets: { provider: 'libsecret' } } as never).kind).toBe('libsecret')
    expect(() => createSecretProvider({ secrets: { provider: 'env' } } as never)).toThrow()
  })
})
