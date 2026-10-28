import { afterEach, describe, expect, it } from 'vitest'
import * as scrubber from '../../src/secrets/scrubber.js'
import { registerSecretValue, resetSecretScrubberForTests, scrubSecrets } from '../../src/secrets/scrubber.js'

// Distinctive sentinel so a leak into scrubbed output is unmistakable and
// cannot be confused with ordinary test fixture text.
const SENTINEL = 'xoxb-SENTINEL-9931-LEAKCHECK'

describe('scrubSecrets / registerSecretValue', () => {
  afterEach(() => {
    resetSecretScrubberForTests()
  })

  it('replaces every occurrence of a registered value with the fixed placeholder', () => {
    registerSecretValue(SENTINEL)
    const text = `first failure: ${SENTINEL}. second failure: ${SENTINEL} again.`

    const scrubbed = scrubSecrets(text)

    expect(scrubbed).not.toContain(SENTINEL)
    expect(scrubbed.match(/\[redacted secret\]/g)).toHaveLength(2)
  })

  it('leaves text unchanged when nothing is registered', () => {
    const text = `nothing to see here, ${SENTINEL} was never registered`
    expect(scrubSecrets(text)).toBe(text)
  })

  it('ignores an empty string rather than registering it', () => {
    registerSecretValue('')
    const text = 'perfectly ordinary output with no secrets in it at all'
    expect(scrubSecrets(text)).toBe(text)
  })

  /**
   * MINIMUM_SECRET_LENGTH (8, see src/secrets/scrubber.ts) exists precisely
   * so a one- or two-character value cannot turn every incidental match in
   * normal output into a placeholder. This proves the floor actually holds:
   * a short value is never registered, so it is never scrubbed out of
   * unrelated text that happens to contain it.
   */
  it('ignores a value shorter than the minimum length, so a short value cannot blank out unrelated text', () => {
    registerSecretValue('ab')
    const text = 'the cabin had ab painted on the door twice: ab and ab'
    expect(scrubSecrets(text)).toBe(text)
  })

  it('registers a value at exactly the minimum length', () => {
    const eightChars = '12345678'
    registerSecretValue(eightChars)
    expect(scrubSecrets(`token: ${eightChars}`)).not.toContain(eightChars)
  })

  it('scrubs multiple distinct registered values independently in the same text', () => {
    const first = 'first-secret-value'
    const second = 'second-secret-value'
    registerSecretValue(first)
    registerSecretValue(second)
    const text = `bot token ${first} and app token ${second} both failed`

    const scrubbed = scrubSecrets(text)

    expect(scrubbed).not.toContain(first)
    expect(scrubbed).not.toContain(second)
  })

  it('registering the same value twice is harmless and still scrubs it exactly', () => {
    registerSecretValue(SENTINEL)
    registerSecretValue(SENTINEL)
    expect(scrubSecrets(`dup: ${SENTINEL}`)).not.toContain(SENTINEL)
  })

  it('resetSecretScrubberForTests forgets every previously registered value', () => {
    registerSecretValue(SENTINEL)
    resetSecretScrubberForTests()
    const text = `after reset: ${SENTINEL}`
    expect(scrubSecrets(text)).toBe(text)
  })

  it('exposes no way to read back a registered value: the module has no getter or iterator, only these three functions', () => {
    registerSecretValue(SENTINEL)
    expect(Object.keys(scrubber).sort()).toEqual(
      ['registerSecretValue', 'resetSecretScrubberForTests', 'scrubSecrets'].sort()
    )
  })
})
