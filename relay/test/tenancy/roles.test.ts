import { describe, expect, it } from 'vitest'
import { isOwner, parseRole } from '../../src/tenancy/roles.js'

describe('isOwner', () => {
  it('counts owner and the legacy operator role as owner', () => {
    expect(isOwner(['owner'])).toBe(true)
    expect(isOwner(['operator'])).toBe(true)
    expect(isOwner(['member', 'owner'])).toBe(true)
  })

  it('fails closed on member, unknown and empty role lists', () => {
    expect(isOwner(['member'])).toBe(false)
    expect(isOwner(['admin'])).toBe(false)
    expect(isOwner([])).toBe(false)
  })
})

describe('parseRole', () => {
  it('accepts owner and member, trimmed', () => {
    expect(parseRole('owner')).toBe('owner')
    expect(parseRole(' member ')).toBe('member')
  })

  it('refuses any other role, including the legacy operator', () => {
    expect(() => parseRole('operator')).toThrow('unknown role "operator": use owner or member')
    expect(() => parseRole('admin')).toThrow('unknown role')
    expect(() => parseRole('')).toThrow('unknown role')
  })
})
