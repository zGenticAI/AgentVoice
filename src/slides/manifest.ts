// A prepared deck's manifest, its limits, and the strict check every reader of it runs (src/slides/deck.ts). Pure, with
// no imports beyond the tag stripper: the converter child (render-child.ts) uses these limits too, and must never
// import env.ts or config.ts, which load .env and its keys (test/import-graph.test.ts).
import { stripBlockTags } from '../untrusted.ts'

/** Every slide image is exactly this size: what Recall shares a webpage at. */
export const SLIDE_WIDTH = 1280
export const SLIDE_HEIGHT = 720
/** The largest PDF prepare reads. */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024
/** The most pages a PDF may have, excluded pages included. */
export const MAX_PAGES = 100
/** The largest slide image: WebP q90, then q80, then q70, else the page is refused. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** All the images of one deck together. */
export const MAX_DECK_BYTES = 40 * 1024 * 1024
/** A page's text, kept for the assistant's answers about the slide on screen. */
export const MAX_PAGE_TEXT = 4000
/** A slide's title, its page label, and the deck's label. */
export const MAX_TITLE = 120
export const MAX_LABEL = 80
/** The manifest file itself. */
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
/** Text that renders smaller than this on the 1280x720 image gets a warning: it may be hard to read in a share. */
export const SMALL_TEXT_PX = 20

/** A deck's id: a slug of the file's name, then 6 random base32 letters. A local handle, not a secret. */
export const DECK_ID = /^[a-z0-9][a-z0-9-]{0,23}-[a-z2-7]{6}$/

/** What prepare noticed about a page, for the owner: printed, on the contact sheet, and as check's warnings. */
export const WARNINGS = {
  'small-text': `has text under ${SMALL_TEXT_PX} px, which may be hard to read in a small share window`,
  'no-text': 'has no text, so it can be answered about only from your script',
  letterboxed: 'is not 16:9, so it is shown with bars at its sides or above and below',
  portrait: 'is portrait: it looks like a document, not a slide',
  'image-too-large': 'has an image too large to draw (over 50 megapixels), which was left out',
  'image-not-drawn': 'has an image that could not be drawn',
  'lower-quality': 'is saved at a lower quality to keep its image under 2 MiB',
  'text-cut': `has more than ${MAX_PAGE_TEXT} characters of text: only the first ${MAX_PAGE_TEXT} are kept`,
} as const
export type WarningCode = keyof typeof WARNINGS

export interface ManifestSlide {
  /** The PDF page number: the only key a slide has. */
  n: number
  /** The first line of the page's largest text, or ''. */
  title: string
  /** The page's label in the PDF, a hint only: labels can repeat. */
  pageLabel: string | null
  /** The page's text, for answers about the slide on screen. Never spoken. */
  text: string
  /** NNN.webp */
  file: string
  bytes: number
  sha256: string
  /** sha256 of text: prepare compares it with the deck before to find the slides that changed. */
  textHash: string
  warnings: WarningCode[]
}

export interface Manifest {
  format: 1
  id: string
  label: string
  /** ISO time, to the second. */
  created: string
  /** Pages in the PDF, excluded ones included. */
  pages: number
  /** Pages left out with --exclude: only how many. */
  excluded: number
  slides: ManifestSlide[]
}

/** NNN.webp for page n. */
export const slideFile = (n: number) => `${String(n).padStart(3, '0')}.webp`

const HEX64 = /^[0-9a-f]{64}$/
const CREATED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
// Control and format characters: never in a title or a label, and in page text only as line breaks.
const CONTROL = /[\p{Cc}\p{Cf}]/u

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/** Exactly these keys, no more and no fewer. */
function keysAre(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(k => Object.hasOwn(value, k))
}

/** Text as prepare writes it: within its cap, NFC, no block tags, and no control characters (line breaks in page text). */
function cleanText(value: unknown, max: number, multiline: boolean): value is string {
  if (typeof value !== 'string' || value.length > max || value.normalize('NFC') !== value || stripBlockTags(value) !== value) return false
  return !CONTROL.test(multiline ? value.replaceAll('\n', '') : value)
}

/**
 * Why this is not a manifest for the deck `id`, or '' when it is. Strict: an unknown key, a wrong type or an
 * over-long field refuses the whole deck.
 */
export function manifestProblem(value: unknown, id: string): string {
  if (!isObject(value) || !keysAre(value, ['format', 'id', 'label', 'created', 'pages', 'excluded', 'slides'])) return 'its manifest has missing or unknown fields'
  if (value.format !== 1) return 'its manifest is of an unknown format'
  if (value.id !== id) return 'its manifest is for another deck'
  if (!cleanText(value.label, MAX_LABEL, false) || !value.label) return 'its label is not valid'
  if (typeof value.created !== 'string' || !CREATED.test(value.created) || Number.isNaN(Date.parse(value.created))) return 'its creation time is not valid'
  if (!isWhole(value.pages, 1, MAX_PAGES)) return `its page count is not 1 to ${MAX_PAGES}`
  if (!isWhole(value.excluded, 0, value.pages - 1)) return 'its count of excluded pages is not valid'
  const slides = value.slides
  if (!Array.isArray(slides) || slides.length < 1 || slides.length > MAX_PAGES) return `it has no slides, or more than ${MAX_PAGES}`
  if (slides.length + value.excluded !== value.pages) return 'its slides and excluded pages do not add up to its pages'
  let last = 0
  for (const slide of slides) {
    if (!isObject(slide) || !keysAre(slide, ['n', 'title', 'pageLabel', 'text', 'file', 'bytes', 'sha256', 'textHash', 'warnings'])) return 'a slide has missing or unknown fields'
    if (!isWhole(slide.n, last + 1, value.pages)) return 'its slides are not in page order'
    last = slide.n
    const at = `slide ${slide.n}`
    if (!cleanText(slide.title, MAX_TITLE, false)) return `${at}'s title is not valid`
    if (slide.pageLabel !== null && (!cleanText(slide.pageLabel, MAX_TITLE, false) || !slide.pageLabel)) return `${at}'s page label is not valid`
    if (!cleanText(slide.text, MAX_PAGE_TEXT, true)) return `${at}'s text is not valid`
    if (slide.file !== slideFile(slide.n)) return `${at}'s file name is not valid`
    if (!isWhole(slide.bytes, 1, MAX_IMAGE_BYTES)) return `${at}'s image is empty or over ${MAX_IMAGE_BYTES} bytes`
    if (typeof slide.sha256 !== 'string' || !HEX64.test(slide.sha256)) return `${at}'s image hash is not valid`
    if (typeof slide.textHash !== 'string' || !HEX64.test(slide.textHash)) return `${at}'s text hash is not valid`
    const warnings = slide.warnings
    if (!Array.isArray(warnings) || warnings.length > Object.keys(WARNINGS).length) return `${at}'s warnings are not valid`
    if (!warnings.every(w => typeof w === 'string' && Object.hasOwn(WARNINGS, w)) || new Set(warnings).size !== warnings.length) return `${at} has an unknown warning`
  }
  return ''
}
