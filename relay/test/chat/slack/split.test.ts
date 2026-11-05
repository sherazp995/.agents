import { describe, expect, it } from 'vitest'
import { splitForSlack } from '../../../src/chat/slack/split.js'

describe('splitForSlack', () => {
  const small = { maxChars: 20, maxBytes: 40 }

  it('keeps a report that fits as one part, at the limit too', () => {
    expect(splitForSlack('short')).toEqual(['short'])
    expect(splitForSlack('a'.repeat(20), small)).toEqual(['a'.repeat(20)])
  })

  it('cuts between paragraphs, packing as many as fit, in order', () => {
    expect(splitForSlack('one two\n\nthree four\n\nfive six seven eight', small)).toEqual(['one two\n\nthree four', 'five six seven eight'])
  })

  it('cuts between lines when one paragraph is too long, and inside a line only when the line alone is', () => {
    expect(splitForSlack('first line\nsecond line\nthird', small)).toEqual(['first line', 'second line\nthird'])
    expect(splitForSlack('x'.repeat(45), small)).toEqual(['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(5)])
  })

  it('holds the byte limit for multibyte text, never splitting a character', () => {
    const parts = splitForSlack('é'.repeat(30), { maxChars: 100, maxBytes: 20 })
    expect(parts).toEqual(['é'.repeat(10), 'é'.repeat(10), 'é'.repeat(10)])
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(20)
  })

  it("splits a report over Slack's own limits into parts that each fit, losing nothing", () => {
    const paragraph = 'word '.repeat(1000).trim()
    const report = Array.from({ length: 12 }, () => paragraph).join('\n\n')
    const parts = splitForSlack(report)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(12_000)
    expect(parts.join('\n\n')).toBe(report)
  })
})
