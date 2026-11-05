/**
 * Splits a report too long for one Slack message into parts that each fit:
 * at most MARKDOWN_BLOCK_MAX_CHARS characters (past that Slack drops the
 * Markdown block) and SLACK_MAX_MESSAGE_BYTES bytes (past that the adapter
 * rejects the post). It cuts between paragraphs, then between lines, and only
 * cuts inside a line that alone is too long. Nothing is dropped: joining the
 * parts with the separators they were cut at gives the text back.
 */

import { MARKDOWN_BLOCK_MAX_CHARS, SLACK_MAX_MESSAGE_BYTES } from './adapter.js'

export type PartLimits = { readonly maxChars: number; readonly maxBytes: number }

const SLACK_LIMITS: PartLimits = { maxChars: MARKDOWN_BLOCK_MAX_CHARS, maxBytes: SLACK_MAX_MESSAGE_BYTES }

export function splitForSlack(text: string, limits: PartLimits = SLACK_LIMITS): string[] {
  const fits = (part: string): boolean => part.length <= limits.maxChars && Buffer.byteLength(part, 'utf8') <= limits.maxBytes
  if (fits(text)) return [text]

  const parts: string[] = []
  let current = ''
  const add = (piece: string, separator: string): void => {
    const joined = current === '' ? piece : `${current}${separator}${piece}`
    if (fits(joined)) {
      current = joined
      return
    }
    if (current !== '') parts.push(current)
    current = piece
  }

  for (const paragraph of text.split('\n\n')) {
    if (fits(paragraph)) {
      add(paragraph, '\n\n')
      continue
    }
    for (const [index, line] of paragraph.split('\n').entries()) {
      const separator = index === 0 ? '\n\n' : '\n'
      if (fits(line)) {
        add(line, separator)
        continue
      }
      for (const [cutIndex, cut] of cutLine(line, fits).entries()) add(cut, cutIndex === 0 ? separator : '')
    }
  }
  if (current !== '') parts.push(current)
  return parts
}

/** Cuts one over-long line into pieces that fit, by code point so a character is never split. */
function cutLine(line: string, fits: (part: string) => boolean): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const char of line) {
    if (!fits(piece + char)) {
      pieces.push(piece)
      piece = ''
    }
    piece += char
  }
  if (piece !== '') pieces.push(piece)
  return pieces
}
