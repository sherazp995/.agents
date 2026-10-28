import { describe, expect, it } from 'vitest'
import { DECISIONS } from '../../src/policy/schema.js'

describe('DECISIONS', () => {
  it('is exactly allow, deny, ask, per FR-POL-3', () => {
    expect(DECISIONS).toEqual(['allow', 'deny', 'ask'])
  })
})
