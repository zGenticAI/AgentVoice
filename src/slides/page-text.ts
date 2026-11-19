// What prepare keeps of a page's text: cleaned the same way for the text, the title, the page label and sticky notes,
// and the two things read from the text items' sizes (the title, and text too small to read in a share). Pure, for the
// converter child (render-child.ts) and the tests.
import { MAX_TITLE, SMALL_TEXT_PX } from './manifest.ts'
import { stripBlockTags } from '../untrusted.ts'

/** Text as the deck keeps it: NFC, no control or format characters but line breaks, spaces collapsed, no block tags. */
export function cleanText(raw: string, max: number): { text: string; cut: boolean } {
  const text = stripBlockTags(
    raw
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]/gu, ' ')
      .replace(/[\p{Cc}\p{Cf}]/gu, c => (c === '\n' ? c : '')),
  )
    .split('\n')
    .map(line => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length <= max) return { text, cut: false }
  // Cut on a whole character: never half of a surrogate pair.
  const cut = text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd()
  return { text: cut, cut: true }
}

/** One line of text, for a title or a label. */
export const oneLine = (raw: string, max: number) => cleanText(raw.replace(/\n/g, ' '), max).text

export interface TextItem {
  str: string
  hasEOL: boolean
  /** Its height on the 1280x720 image. */
  px: number
  /** What the page text put before it: nothing, a space (a gap along the line), or a new line. */
  sep: '' | ' ' | '\n'
}

/** Digits alone, as in a page number or "1.": not a title, and not text too small to read. */
const pageNumber = (s: string) => /^[\d\s./-]{1,6}$/.test(s.trim())

/** Words or figures: not a bullet, a quote mark, an icon font's glyph or an emoji. */
const titleText = (s: string) => /[\p{L}\p{N}]/u.test(s) && !pageNumber(s)

/**
 * The first line of the page's largest words, joined the way the page text joins them, so the title reads as the
 * slide does. pdf.js gives the space between runs (a change of font, or a gap) as an item of its own, or as a gap:
 * both are kept.
 */
export function titleOf(items: readonly TextItem[]): string {
  const pool = items.filter(i => titleText(i.str))
  if (!pool.length) return ''
  const largest = Math.max(...pool.map(i => i.px))
  const big = (i: TextItem) => i.px >= largest * 0.9
  let title = ''
  for (const item of items) {
    if (!title) {
      if (big(item) && pool.includes(item)) title = item.str
    } else {
      if (item.sep === '\n') break
      title += item.sep
      // A run at the title's size joins it, spaces and signs included; anything else is a word apart.
      title += big(item) ? item.str : ' '
    }
    if (item.hasEOL && title.trim()) break
  }
  return oneLine(title, MAX_TITLE)
}

/**
 * Whether text on the page renders under the legible size. A page number in a footer (digits alone) doesn't count,
 * or nearly every slide of a numbered deck would warn.
 */
export function hasSmallText(items: readonly TextItem[]): boolean {
  return items.some(i => i.str.trim() && !pageNumber(i.str) && i.px < SMALL_TEXT_PX)
}
