import { describe, expect, it } from 'vitest'
import { generateReaderKey, open, readerKeyFromPrivate, seal, sealContext } from '../../src/worker-env/seal.js'

describe('sealing env values per laptop key', () => {
  const context = sealContext('ws', { host: 'zubair', folder: '~/code/app', name: 'TOKEN' })

  it('opens only with the key it was sealed for, and the sealed text does not hold the value', () => {
    const zubair = generateReaderKey()
    const hassan = generateReaderKey()
    const sealed = seal('secret-token-value', zubair.publicKey, context)
    expect(sealed).not.toContain('secret-token-value')
    expect(open(sealed, zubair.privateKey, context)).toBe('secret-token-value')
    expect(() => open(sealed, hassan.privateKey, context)).toThrow('does not open')
  })

  it('does not open when moved onto another entry', () => {
    const key = generateReaderKey()
    const sealed = seal('secret-token-value', key.publicKey, context)
    expect(() => open(sealed, key.privateKey, sealContext('ws', { host: 'zubair', folder: '~/code/app', name: 'OTHER' }))).toThrow('does not open')
  })

  it('refuses a tampered or malformed sealed value with the same safe message', () => {
    const key = generateReaderKey()
    const parts = seal('secret-token-value', key.publicKey, context).split('.')
    const tampered = [...parts.slice(0, 4), Buffer.from('other').toString('base64url')].join('.')
    expect(() => open(tampered, key.privateKey, context)).toThrow('does not open')
    expect(() => open([...parts.slice(0, 3), 'AA', parts[4]].join('.'), key.privateKey, context)).toThrow('does not open')
    expect(() => open(['v1', 'x', 'y', 'z', 'w'].join('.'), key.privateKey, context)).toThrow('does not open')
    expect(() => open(`${parts.join('.')}.extra`, key.privateKey, context)).toThrow('not a sealed env value')
  })

  it('rebuilds the same key, fingerprint included, from the private half kept in the keystore', () => {
    const key = generateReaderKey()
    expect(readerKeyFromPrivate(key.privateKey)).toEqual(key)
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})
