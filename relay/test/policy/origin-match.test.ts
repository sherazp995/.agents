import { describe, expect, it } from 'vitest'
import { matchesAnyOrigin, originMatches } from '../../src/policy/origin-match.js'

describe('originMatches', () => {
  it('matches an exact bare-domain pattern', () => {
    expect(originMatches('chase.com', 'chase.com')).toBe(true)
  })

  it('does not match a different domain', () => {
    expect(originMatches('coinbase.com', 'chase.com')).toBe(false)
  })

  it('does not match a bare-domain pattern against a subdomain', () => {
    expect(originMatches('pay.chase.com', 'chase.com')).toBe(false)
  })

  it('matches a subdomain against a wildcard pattern', () => {
    expect(originMatches('pay.chase.com', '*.chase.com')).toBe(true)
  })

  it('matches a nested subdomain against a wildcard pattern', () => {
    expect(originMatches('login.pay.chase.com', '*.chase.com')).toBe(true)
  })

  it('matches the bare parent domain against a wildcard pattern, so "*.chase.com" also blocks chase.com itself', () => {
    expect(originMatches('chase.com', '*.chase.com')).toBe(true)
  })

  it('does not match an unrelated domain that merely ends with the same suffix', () => {
    expect(originMatches('notchase.com', '*.chase.com')).toBe(false)
  })

  it('compares case-insensitively', () => {
    expect(originMatches('Chase.COM', 'chase.com')).toBe(true)
    expect(originMatches('pay.CHASE.com', '*.chase.com')).toBe(true)
  })
})

describe('matchesAnyOrigin', () => {
  it('returns true when any pattern in the list matches', () => {
    expect(matchesAnyOrigin('pay.chase.com', ['*.coinbase.com', '*.chase.com'])).toBe(true)
  })

  it('returns false when no pattern matches', () => {
    expect(matchesAnyOrigin('github.com', ['*.coinbase.com', '*.chase.com'])).toBe(false)
  })

  it('returns false for an empty pattern list', () => {
    expect(matchesAnyOrigin('github.com', [])).toBe(false)
  })
})
