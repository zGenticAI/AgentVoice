// Text from outside goes into prompts inside tagged blocks marked as content, not instructions: the transcript, the
// questions, a brief, and a slide's page text and title (a third party's PDF can carry instructions). Each block's own
// tags are stripped from what goes in it, so the text can't close its block and write outside it. Kept apart, with no
// imports, so the minutes, the brain and the slides converter can all use it.

/** The tags of every block untrusted text goes into: the minutes', the brain's and the slides'. */
export const BLOCK_TAGS = ['transcript', 'questions', 'brief', 'latest', 'slides', 'slide_text'] as const

const tagPattern = (tags: readonly string[]) => new RegExp(`<\\s*\\/?\\s*(?:${tags.join('|')})\\s*>`, 'gi')
const TAG = tagPattern(BLOCK_TAGS)

/**
 * The text without any of the block tags, opening or closing, in any case or spacing. Stripped again until none is
 * left, so a tag split by another ("<trans<brief>cript>") can't be put back together by the first pass.
 */
export function stripBlockTags(text: string): string {
  return stripTags(text, TAG)
}

/** The same for other tags (each a plain word, such as the channel's event block): the text without any of them. */
export function stripTagsNamed(text: string, tags: readonly string[]): string {
  return stripTags(text, tagPattern(tags))
}

function stripTags(text: string, tag: RegExp): string {
  let out = text
  for (let i = 0; i < 10; i++) {
    const next = out.replace(tag, '')
    if (next === out) return out
    out = next
  }
  return out.replace(/[<>]/g, '')
}
