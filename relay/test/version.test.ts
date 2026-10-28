import { describe, expect, it } from 'vitest'
import { RELAY_VERSION } from '../src/version.js'

describe('RELAY_VERSION', () => {
  it('is a semver string', () => {
    expect(RELAY_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
