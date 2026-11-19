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
}

/** The first line of the page's largest text. */
export function titleOf(items: readonly TextItem[]): string {
  const sized = items.filter(i => i.str.trim())
  if (!sized.length) return ''
  const largest = Math.max(...sized.map(i => i.px))
  let title = ''
  for (const item of items) {
    if (item.str.trim() && item.px >= largest * 0.9) title += item.str
    else if (title.trim() && item.str.trim()) title += ' '
    if (item.hasEOL && title.trim()) break
  }
  return oneLine(title, MAX_TITLE)
}

/**
 * Whether text on the page renders under the legible size. A page number in a footer (digits alone) doesn't count,
 * or nearly every slide of a numbered deck would warn.
 */
export function hasSmallText(items: readonly TextItem[]): boolean {
  return items.some(i => i.str.trim() && !/^[\d\s./-]{1,6}$/.test(i.str.trim()) && i.px < SMALL_TEXT_PX)
}
