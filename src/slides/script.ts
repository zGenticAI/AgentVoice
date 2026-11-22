// The presentation script: the owner's file beside the PDF (<deck>.script.md), the only source of what the assistant
// says over the slides, word for word. One section per slide, by PDF page number:
//
//   ---
//   deck: q4-roadmap-k7m2qa
//   title: Q4 roadmap
//   minutes: 15
//   ---
//
//   ## 3 · What ships
//   hold: 3s
//
//   There's a lot on this slide, so I'll pick out the three things that matter most.
//
// Keys go directly under the heading, and a blank line separates them from the spoken text, so a line such as
// "Note: ..." under a heading is an unknown key (an error), never spoken and never dropped. HTML comments are for the
// owner: they are stripped first, and the canonical text (what npm run join and the channel will send) never has one.
// Here: the parser, its errors and warnings, the check against the prepared deck, the time estimate, the canonical
// text, the skeleton prepare writes, and the update merge, which never changes a written paragraph.
import { SentenceSplitter } from '../brain/text.ts'
import { WORDS } from '../commands.ts'
import { MS_PER_CHAR, spokenLength } from '../pipeline/playback.ts'
import { DECK_ID, MAX_PAGES, type Manifest, type ManifestSlide, WARNINGS } from './manifest.ts'

/** The whole script's canonical text: about 45 minutes of narration. */
export const MAX_SCRIPT_CHARS = 40_000
/** One section's spoken text, and one sentence. */
export const MAX_SECTION_CHARS = 4_000
export const MAX_SENTENCE_CHARS = 400
/** The script file itself, comments included: larger is refused unread. */
export const MAX_SCRIPT_FILE_BYTES = 1024 * 1024
export const MAX_HOLD_S = 30
export const MAX_PAUSE_S = 60
export const MAX_MINUTES = 240
const MAX_HEADING = 120

// The pacing the presenter will add around each slide: the lead after a slide appears before it is talked about, and
// the room's quiet before the next one. Only for the estimate; real timing is known only in a meeting.
export const LEAD_MS = 700
export const QUIET_MS = 1_200
/** Sections longer or shorter than these get a warning. */
export const LONG_SECTION_MS = 120_000
export const SHORT_SECTION_MS = 4_000

export interface Section {
  /** The PDF page number: the only key a slide has. */
  page: number
  /** The title in the heading, for the owner. The slide's own title comes from the deck. */
  heading: string
  /** The heading's line in the file. */
  line: number
  hold: number | null
  pause: number | null
  onRequest: boolean
  exclude: boolean
  check: 'yes' | 'changed' | null
  /** The spoken text: each paragraph on one line, emphasis and links taken out. */
  paragraphs: string[]
  /** The paragraphs' sentences, as the service will say them, one at a time. */
  sentences: string[]
  /** The body is TODO. */
  todo: boolean
}

export interface Script {
  deck: string
  title: string | null
  minutes: number | null
  sections: Section[]
}

export interface Problem {
  message: string
  line?: number
  page?: number
  /** One of the deck's own warnings about the slide (small text, no text and the like), which the sheet shows apart. */
  fromDeck?: boolean
}

export interface Parsed {
  /** Null when the front matter or a heading can't be read at all. */
  script: Script | null
  errors: Problem[]
  warnings: Problem[]
}

/** A line of the file with its comments taken out, and its number in the file. */
interface Line {
  text: string
  n: number
}

/**
 * The file's lines without HTML comments. A line that held only comments (and spaces) goes entirely, so a comment
 * between a heading and its keys never opens a gap that would turn a key into spoken text.
 */
function stripComments(source: string, errors: Problem[]): Line[] {
  const out: Line[] = []
  let inComment = 0
  source.split('\n').forEach((raw, i) => {
    let text = ''
    let had = false
    let at = 0
    for (;;) {
      if (inComment) {
        const end = raw.indexOf('-->', at)
        had = true
        if (end < 0) break
        at = end + 3
        inComment = 0
      } else {
        const start = raw.indexOf('<!--', at)
        if (start < 0) {
          text += raw.slice(at)
          break
        }
        text += raw.slice(at, start)
        at = start + 4
        inComment = i + 1
        had = true
      }
    }
    if (!(had && !text.trim())) out.push({ text, n: i + 1 })
  })
  if (inComment) errors.push({ line: inComment, message: 'a comment (<!--) is never closed with -->' })
  return out
}

/** The file normalised: no byte order mark, \n line ends, NFC. */
const normalise = (source: string) => source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC')

/** A front matter or key line: "name: value", without a trailing "# comment". */
function keyValue(text: string): { key: string; value: string; written: string } | null {
  const m = /^([A-Za-z][A-Za-z-]*):(.*)$/.exec(text.trim())
  if (!m) return null
  return { key: m[1].toLowerCase(), value: m[2].replace(/(^|\s)#.*$/, '').trim(), written: m[1] }
}

const HEADING = /^##[ \t]+(\d{1,4})(?:[ \t]*[·:–-][ \t]*(.*?))?[ \t]*$/
const KEYS = ['hold', 'pause', 'on-request', 'exclude', 'check'] as const

/** Seconds, as "3s", "3 s" or "3", from 0 to max. */
function seconds(value: string, max: number): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*s?$/i.exec(value)
  if (!m) return null
  const s = Number(m[1])
  return s >= 0 && s <= max ? s : null
}

const yesNo = (value: string) => (/^(yes|true)$/i.test(value) ? true : /^(no|false)$/i.test(value) ? false : null)

/** What a line of spoken text must not be, and why: lists, tables and the like are not speech. */
function notSpeech(text: string): string {
  const t = text.trim()
  if (/^([-*+]|\d{1,3}[.)])\s+/.test(t)) return 'a list is not speech: write it as sentences'
  if (t.startsWith('|')) return 'a table is not speech: say what matters in sentences'
  if (t.startsWith('>')) return 'a quote block is not speech: write it as a sentence'
  if (t.startsWith('```') || t.startsWith('~~~')) return 'code is not speech'
  if (t.startsWith('#')) return 'a heading must be "## <page> · <title>", with the PDF page number'
  if (/^([-*_])(\s*\1){2,}$/.test(t)) return 'a rule (---) is not speech'
  const key = keyValue(t)
  if (key && (KEYS as readonly string[]).includes(key.key)) return `"${key.key}:" looks like a key, but it is in the spoken text: keys go directly under the heading`
  return ''
}

/** A paragraph as it is spoken: one line, links as their words, no emphasis. Or why it can't be. */
function spoken(lines: string[]): { text: string; problem: string } {
  let text = lines.map(l => l.trim()).join(' ')
  if (/!\[[^\]]*\]\([^)]*\)/.test(text)) return { text, problem: 'an image is not speech' }
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  if (/\b(?:https?:\/\/|www\.|mailto:)\S+/i.test(text)) return { text, problem: 'a URL is not speech: say it in words, or leave it out' }
  if (/<\/?[a-zA-Z][^>]*>|<!|-->/.test(text)) return { text, problem: 'HTML is not speech (comments are fine: <!-- like this -->)' }
  text = text
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return { text, problem: '' }
}

/** Sentences as the service will say them: each paragraph's lines are already joined, so a wrapped line never splits one. */
export function sentencesOf(paragraphs: readonly string[]): string[] {
  const out: string[] = []
  for (const paragraph of paragraphs) {
    const splitter = new SentenceSplitter()
    out.push(...splitter.push(paragraph), ...splitter.flush())
  }
  return out
}

interface Outline {
  deck: string | null
  /** The deck line's index (0-based) in the file. */
  deckLine: number
  frontEnd: number
  sections: {
    page: number
    heading: string
    /** 0-based indexes into the file's lines. */
    headingLine: number
    /** The key lines under the heading: key, value, index. */
    keys: { key: string; value: string; written: string; index: number }[]
    /** The lines after the key block, up to the next heading. */
    body: Line[]
  }[]
}

// The problems that leave a script's structure unclear: an update merge would put its lines in the wrong places.
const STRUCTURAL = new WeakSet<Problem>()
const structural = (problem: Problem) => (STRUCTURAL.add(problem), problem)

/** The script's structure: front matter and sections. */
function outline(source: string, errors: Problem[]): Outline | null {
  const commentErrors: Problem[] = []
  const lines = stripComments(normalise(source), commentErrors)
  for (const e of commentErrors) errors.push(structural(e))
  let i = 0
  while (i < lines.length && !lines[i].text.trim()) i++
  if (lines[i]?.text.trim() !== '---') {
    errors.push(structural({ line: lines[i]?.n ?? 1, message: 'the script must start with its front matter: a "---" line, "deck: <id>", and another "---" line' }))
    return null
  }
  const result: Outline = { deck: null, deckLine: -1, frontEnd: -1, sections: [] }
  const seen = new Set<string>()
  // Check reads whatever file it is given, so nothing of a line that is not a key is ever quoted, and only the first
  // such line is named: a file that only looks like a script (YAML, notes) gives one line number, not its lines. The
  // keys after it are still read: an "author:" above the deck line must not hide the deck line.
  let unknown = false
  for (i++; i < lines.length && lines[i].text.trim() !== '---'; i++) {
    const { text, n } = lines[i]
    if (!text.trim() || text.trim().startsWith('#')) continue
    const kv = keyValue(text)
    if (!kv || !['deck', 'title', 'minutes'].includes(kv.key)) {
      if (!unknown) errors.push({ line: n, message: 'this is not a front matter key: they are deck, title and minutes' })
      unknown = true
      continue
    }
    if (seen.has(kv.key)) errors.push({ line: n, message: `${kv.key} is given twice` })
    seen.add(kv.key)
    if (kv.key === 'deck') {
      result.deck = kv.value
      result.deckLine = n - 1
    }
  }
  if (i >= lines.length) {
    errors.push(structural({ line: lines.at(-1)?.n ?? 1, message: 'the front matter is never closed with a "---" line' }))
    return null
  }
  result.frontEnd = lines[i].n - 1
  if (result.deck === null) errors.push(structural({ line: 1, message: 'the front matter has no "deck:" line: prepare writes it' }))

  let current: Outline['sections'][number] | null = null
  let inKeys = false
  for (i++; i < lines.length; i++) {
    const { text, n } = lines[i]
    const heading = HEADING.exec(text)
    if (heading) {
      const page = Number(heading[1])
      const before = result.sections.at(-1)
      if (page < 1 || page > MAX_PAGES) errors.push({ line: n, message: `page ${page} can't be in a deck: pages run from 1 to ${MAX_PAGES}` })
      else if (before && page === before.page) errors.push(structural({ line: n, page, message: 'this page has two sections' }))
      else if (before && page < before.page) errors.push(structural({ line: n, page, message: `sections must be in page order: this comes after page ${before.page}` }))
      current = { page, heading: (heading[2] ?? '').trim(), headingLine: n - 1, keys: [], body: [] }
      result.sections.push(current)
      inKeys = true
      continue
    }
    if (!current) {
      if (text.trim()) errors.push({ line: n, message: 'text before the first section is never spoken: put it in a section, or in a comment' })
      continue
    }
    if (inKeys && text.trim()) {
      const kv = keyValue(text)
      if (kv) {
        current.keys.push({ ...kv, index: n - 1 })
        continue
      }
      if (!text.trim().startsWith('#')) errors.push({ line: n, page: current.page, message: 'put a blank line between the heading (and its keys) and the spoken text' })
    }
    inKeys = false
    current.body.push({ text, n })
  }
  if (result.sections.length > MAX_PAGES) errors.push({ line: result.sections[MAX_PAGES].headingLine + 1, message: `a script has at most ${MAX_PAGES} sections` })
  if (!result.sections.length) errors.push({ line: result.frontEnd + 2, message: 'the script has no sections: one "## <page> · <title>" per slide' })
  return result
}

/** Parses a script: its sections, their sentences, and everything wrong with it on its own (checkScript adds the deck). */
export function parseScript(source: string): Parsed {
  const errors: Problem[] = []
  const warnings: Problem[] = []
  if (Buffer.byteLength(source) > MAX_SCRIPT_FILE_BYTES) {
    return { script: null, errors: [{ message: `the file is over ${MAX_SCRIPT_FILE_BYTES} bytes` }], warnings }
  }
  const shape = outline(source, errors)
  if (!shape) return { script: null, errors, warnings }

  // The front matter's values, now the structure is known.
  const front = stripComments(normalise(source), [])
  let title: string | null = null
  let minutes: number | null = null
  let deckLine = 1
  for (const { text, n } of front) {
    if (n - 1 >= shape.frontEnd) break
    const kv = keyValue(text)
    if (!kv || text.trim().startsWith('#')) continue
    if (kv.key === 'deck') deckLine = n
    if (kv.key === 'title') {
      if (kv.value.length > MAX_HEADING || /[\p{Cc}\p{Cf}]/u.test(kv.value)) errors.push({ line: n, message: `title: must be one line of at most ${MAX_HEADING} characters` })
      // Comments are stripped by joining what is around them, so "<!<!-- x -->--" leaves a marker: the canonical text
      // must never hold one, or the service would refuse it.
      else if (/<!--|-->/.test(kv.value)) errors.push({ line: n, message: 'title: a comment must be whole: <!-- like this -->' })
      else title = kv.value || null
    }
    if (kv.key === 'minutes') {
      const m = /^\d+$/.test(kv.value) ? Number(kv.value) : NaN
      if (!(m >= 1 && m <= MAX_MINUTES)) errors.push({ line: n, message: `minutes: must be a whole number of minutes, 1 to ${MAX_MINUTES}` })
      else minutes = m
    }
  }
  const deck = shape.deck ?? ''
  if (shape.deck !== null && !DECK_ID.test(deck)) {
    errors.push({ line: deckLine, message: 'deck: is not a deck id: it is the id prepare wrote, such as q4-roadmap-k7m2qa' })
  }

  const sections: Section[] = []
  for (const raw of shape.sections) {
    const at = { line: raw.headingLine + 1, page: raw.page }
    const section: Section = {
      page: raw.page, heading: raw.heading, line: raw.headingLine + 1,
      hold: null, pause: null, onRequest: false, exclude: false, check: null, paragraphs: [], sentences: [], todo: false,
    }
    if (raw.heading.length > MAX_HEADING || /[\p{Cc}\p{Cf}]/u.test(raw.heading)) errors.push({ ...at, message: `the heading's title is over ${MAX_HEADING} characters` })
    else if (/<!--|-->/.test(raw.heading)) errors.push({ ...at, message: "the heading's title has a broken comment: a comment must be whole, <!-- like this -->" })
    const given = new Set<string>()
    for (const { key, value, written, index } of raw.keys) {
      const where = { line: index + 1, page: raw.page }
      if (!(KEYS as readonly string[]).includes(key)) {
        errors.push({ ...where, message: `"${written}:" is not a key, so it is never spoken: keys are ${KEYS.join(', ')}. Spoken text goes after a blank line` })
        continue
      }
      if (given.has(key)) errors.push({ ...where, message: `${key} is given twice` })
      given.add(key)
      if (key === 'hold' || key === 'pause') {
        const max = key === 'hold' ? MAX_HOLD_S : MAX_PAUSE_S
        const s = seconds(value, max)
        if (s === null) errors.push({ ...where, message: `${key}: takes seconds from 0 to ${max}, such as "${key}: 3s"` })
        else section[key] = s
      } else if (key === 'on-request' || key === 'exclude') {
        const yes = yesNo(value)
        if (yes === null) errors.push({ ...where, message: `${key}: takes yes or no` })
        else if (key === 'exclude') section.exclude = yes
        else section.onRequest = yes
      } else if (key === 'check') {
        if (value === 'yes' || value === 'changed') section.check = value
        else errors.push({ ...where, message: 'check: is "yes" (drafted, not yet read) or "changed" (the slide changed): delete the line once you have read the section' })
      }
    }
    if (section.exclude && section.onRequest) errors.push({ ...at, message: 'a section can be on-request or excluded, not both' })

    // Paragraphs: runs of lines between blank lines.
    let lines: string[] = []
    let first = 0
    const paragraphs: { lines: string[]; line: number }[] = []
    for (const { text, n } of [...raw.body, { text: '', n: 0 }]) {
      if (text.trim()) {
        if (!lines.length) first = n
        lines.push(text)
      } else if (lines.length) {
        paragraphs.push({ lines, line: first })
        lines = []
      }
    }
    for (const p of paragraphs) {
      const bad = p.lines.map(notSpeech).find(Boolean)
      if (bad) {
        errors.push({ line: p.line, page: raw.page, message: bad })
        continue
      }
      const { text, problem } = spoken(p.lines)
      // The canonical text holds the paragraph as spoken, so it must read back the same: taking out emphasis, code and
      // links can leave a list marker, a key, a URL or a comment where the file had none. Such a paragraph is refused,
      // never rewritten, so the narration stays the owner's word for word.
      const again = problem || !text ? null : spoken([text])
      const unstable = again ? notSpeech(text) || again.problem || (again.text !== text ? 'marks inside emphasis or code are not speech' : '') : ''
      if (problem || unstable) errors.push({ line: p.line, page: raw.page, message: problem || unstable })
      else if (text) section.paragraphs.push(text)
    }
    section.todo = section.paragraphs.some(p => /\bTODO\b/.test(p))
    section.sentences = sentencesOf(section.paragraphs)
    const length = section.paragraphs.join(' ').length
    if (length > MAX_SECTION_CHARS) errors.push({ ...at, message: `the section's text is ${length} characters: at most ${MAX_SECTION_CHARS}` })
    for (const s of section.sentences) {
      if (s.length > MAX_SENTENCE_CHARS) errors.push({ ...at, message: `a sentence is ${s.length} characters: at most ${MAX_SENTENCE_CHARS}, so it can be said and resumed` })
    }
    if (!section.exclude) {
      if (section.todo) errors.push({ ...at, message: 'TODO: write the narration, or add "exclude: yes"' })
      else if (!section.paragraphs.length && section.hold === null) errors.push({ ...at, message: 'nothing to say: write the narration, add "hold: Ns" for a silent slide, or add "exclude: yes"' })
      if (section.check === 'changed') errors.push({ ...at, message: 'the slide changed after this was written: read it against the slide, then delete "check: changed"' })
      if (section.check === 'yes') warnings.push({ ...at, message: 'drafted, not yet checked by you: read it, then delete "check: yes"' })
      const hazards = sayAs(section.paragraphs.join(' '))
      if (hazards.length) warnings.push({ ...at, message: `say-as: ${hazards.map(h => `"${h}"`).join(', ')}: write figures, signs and abbreviations as they are spoken ("twelve dollars")` })
      // The heading is said too, after a question: "Back to <heading>.".
      const spoken = sayAs(section.heading)
      if (spoken.length) {
        warnings.push({
          ...at,
          message: `say-as in the heading, which is said as "Back to ${section.heading.replace(/[\s.!?…:;,]+$/u, '')}.": ${spoken.map(h => `"${h}"`).join(', ')}: write it as it is spoken`,
        })
      }
    } else if (section.check === 'changed') {
      // An exclude is a choice about one slide. When the merge finds another slide under it, or its own slide
      // elsewhere, the owner must look, or the excluded section would hide a slide nobody chose to hide.
      errors.push({ ...at, message: 'the slide on this page changed after the section was excluded: read its comments, then delete "check: changed"' })
    }
    sections.push(section)
  }
  const script: Script = { deck, title, minutes, sections }
  if (sections.length && !sections.some(s => !s.exclude && !s.onRequest)) errors.push({ message: 'nothing to present: every section is excluded or on request' })
  const length = canonicalText(script).length
  if (length > MAX_SCRIPT_CHARS) errors.push({ message: `the script is ${length} characters without its comments: at most ${MAX_SCRIPT_CHARS} (about 45 minutes)` })
  return { script, errors, warnings }
}

/**
 * A script's errors in one line, for a join that refuses it: the first few, each with where it is ("page 4, line 23:"),
 * and how many more. npm run slides -- check lists them all.
 */
export function problemsText(problems: readonly Problem[], max = 3): string {
  const at = (p: Problem) => {
    const parts = [p.page ? `page ${p.page}` : '', p.line ? `line ${p.line}` : ''].filter(Boolean)
    return parts.length ? `${parts.join(', ')}: ` : ''
  }
  const shown = problems.slice(0, max).map(p => `${at(p)}${p.message}`)
  const more = problems.length - shown.length
  return `${shown.join('; ')}${more > 0 ? ` (and ${more} more)` : ''}`
}

/** What the voice may read wrongly: currency and percent signs, figures, and all-capital abbreviations. */
export function sayAs(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/[$€£]\s?\d[\d,.]*|\d[\d,.]*\s?%|\d[\d,.]*|[$%€£]/g)) found.add(m[0].replace(/[.,]$/, '').trim())
  for (const m of text.matchAll(/\b[A-Z]{2,5}\b/g)) if (m[0] !== 'TODO') found.add(m[0])
  return [...found].slice(0, 8)
}

/** The figures in a text, as plain digits ("1,000" is 1000), for comparing narration with the slide. */
export function figures(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/,/g, '').replace(/\.0+$/, ''))
  return out
}

/** How long a section will take, in ms: its speech at the playback estimate, plus the presenter's pacing. */
export function sectionMs(section: Section): number {
  const speech = spokenLength(section.paragraphs.join(' ')) * MS_PER_CHAR
  return speech + LEAD_MS + (section.hold ?? 0) * 1000 + (section.pause ?? 0) * 1000 + QUIET_MS
}

export interface Checked extends Parsed {
  /** The narrated sections (in order, not on request, not excluded, written), and their estimate. */
  narrated: number
  onRequest: number
  excluded: number
  /** Sections still TODO: not written yet, so neither narrated nor estimated. */
  todo: number
  totalMs: number
  /** Each section's estimate, by page. */
  estimates: Map<number, number>
}

/**
 * The script checked against its deck: sections for pages the deck doesn't have, pages without a section, figures the
 * slide doesn't show, the estimate, and the deck's own warnings for the slides that will be shown. figures: false
 * leaves the figures out, for a file that is not the deck's own script: naming the ones a slide lacks would let any
 * file test guesses about what is on it.
 */
export function checkScript(parsed: Parsed, manifest: Manifest | null, opts: { figures?: boolean } = {}): Checked {
  const errors = [...parsed.errors]
  const warnings = [...parsed.warnings]
  const result: Checked = { script: parsed.script, errors, warnings, narrated: 0, onRequest: 0, excluded: 0, todo: 0, totalMs: 0, estimates: new Map() }
  const script = parsed.script
  if (!script) return result
  const slides = new Map(manifest?.slides.map(s => [s.n, s]) ?? [])
  const sectioned = new Set<number>()
  for (const section of script.sections) {
    const at = { line: section.line, page: section.page }
    sectioned.add(section.page)
    const slide = slides.get(section.page)
    if (manifest && !slide) {
      const why = section.page > manifest.pages
        ? `not in the deck: it has ${manifest.pages} page${manifest.pages === 1 ? '' : 's'}`
        : 'left out when the deck was prepared (--exclude)'
      if (section.exclude) warnings.push({ ...at, message: `${why}; its section is excluded, so it is ignored` })
      else errors.push({ ...at, message: `${why}: add "exclude: yes", or prepare the deck again with it` })
      continue
    }
    if (section.exclude) {
      result.excluded++
      continue
    }
    // Not written yet: its TODO error says so, and the word TODO is no narration to time or check.
    if (section.todo) {
      result.todo++
      if (slide) for (const code of slide.warnings) warnings.push({ page: section.page, message: `the slide ${WARNINGS[code]}`, fromDeck: true })
      continue
    }
    const ms = sectionMs(section)
    result.estimates.set(section.page, ms)
    if (section.onRequest) result.onRequest++
    else {
      result.narrated++
      result.totalMs += ms
    }
    if (!slide) continue
    const onSlide = figures(slide.text)
    const missing = opts.figures === false ? [] : [...figures(section.paragraphs.join(' '))].filter(f => !onSlide.has(f))
    if (missing.length) warnings.push({ ...at, message: `${missing.slice(0, 5).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the slide: check the figures` })
    if (ms > LONG_SECTION_MS) warnings.push({ ...at, message: `about ${Math.round(ms / 1000)} s on one slide: consider splitting it` })
    const speech = ms - LEAD_MS - QUIET_MS - (section.pause ?? 0) * 1000
    if (speech < SHORT_SECTION_MS && slide.text && section.hold === null && !section.onRequest) {
      warnings.push({ ...at, message: 'on screen for only a few seconds: add "hold: 3s" so people can read it' })
    }
    for (const code of slide.warnings) warnings.push({ page: section.page, message: `the slide ${WARNINGS[code]}`, fromDeck: true })
  }
  if (manifest) {
    for (const slide of manifest.slides) {
      if (!sectioned.has(slide.n)) warnings.push({ page: slide.n, message: "no section, so it won't be shown" })
    }
  }
  if (script.minutes && result.totalMs > script.minutes * 60_000 * 0.7) {
    warnings.push({ message: `the narration takes about ${Math.round(result.totalMs / 60_000)} min, over 70% of your ${script.minutes} min: leave time for questions` })
  }
  return result
}

/**
 * What the CLI and the channel send in place of the file: front matter, headings, keys and paragraphs, with every
 * comment gone. Excluded sections keep only their page number and the key. Parsing it again gives the same script.
 */
export function canonicalText(script: Script): string {
  const out = ['---', `deck: ${script.deck}`]
  if (script.title) out.push(`title: ${script.title}`)
  if (script.minutes) out.push(`minutes: ${script.minutes}`)
  out.push('---')
  for (const s of script.sections) {
    out.push('')
    if (s.exclude) {
      out.push(`## ${s.page}`, 'exclude: yes')
      continue
    }
    out.push(s.heading ? `## ${s.page} · ${s.heading}` : `## ${s.page}`)
    if (s.hold !== null) out.push(`hold: ${s.hold}s`)
    if (s.pause !== null) out.push(`pause: ${s.pause}s`)
    if (s.onRequest) out.push('on-request: yes')
    if (s.check) out.push(`check: ${s.check}`)
    for (const p of s.paragraphs) out.push('', p)
  }
  return `${out.join('\n')}\n`
}

/** Text safe inside an HTML comment: it can't end the comment or start another. */
function inComment(text: string): string {
  let out = text.replace(/\n+/g, ' / ')
  while (/--|<!-|-->/.test(out)) out = out.replace(/--/g, '- -').replace(/<!-/g, '<! -')
  return out
}

/** One line for a heading: the slide's title, or nothing. */
const headingTitle = (title: string) => title.replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_HEADING)

/** A new section for a page: a heading, check: yes, TODO, and the slide's text, label and notes as comments. */
export function skeletonSection(slide: Manifest['slides'][number], notes = ''): string[] {
  const title = headingTitle(slide.title)
  const lines = [title ? `## ${slide.n} · ${title}` : `## ${slide.n}`, 'check: yes', '', 'TODO']
  lines.push(slide.text ? `<!-- On the slide: "${inComment(slide.text)}" -->` : '<!-- On the slide: no text (an image only). -->')
  if (slide.pageLabel && slide.pageLabel !== String(slide.n)) lines.push(`<!-- Page label: "${inComment(slide.pageLabel)}" (a hint only: the heading uses the page number) -->`)
  if (notes) lines.push(`<!-- Your notes: "${inComment(notes)}" -->`)
  return lines
}

/** A path as a shell takes it: quoted only if it has to be. */
export const shellArg = (p: string) => (/^[\w./~-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`)

/** The note at the top of a new script. scriptPath: the script as the check command names it (prepare's Next: line). */
export function scriptHelp(name: string, scriptPath: string): string {
  return `<!-- One section per slide, by PDF page number. ${name} says only the paragraphs, word for word. Write
     figures as they are spoken ("twelve dollars", not "$12").
     Comments like this one are for you: they are stripped before the script is sent, so the voice service and the
     meeting never see them. Your coding session (Claude Code, Codex or OpenCode) does, if it reads this file.
     Keys go directly under a heading, then a blank line before the spoken text:
       hold: 3s          extra seconds on the slide before speaking, for reading (0 to 30)
       pause: 5s         silence after the last sentence (0 to 60); a question there can be answered without the name
       on-request: yes   a backup slide: shown only when someone asks for it
       exclude: yes      never shown, and never sent to the meeting
       check: yes        drafted, not yet read by you: delete the line once you have
     Then run, from where you ran prepare: ${WORDS.run('slides', `check ${inComment(shellArg(scriptPath))}`)} -->`
}

/**
 * The script prepare writes beside a PDF that has none: one section per rendered page, each TODO. scriptPath: the
 * script as the check command must name it from where prepare ran, which may be outside the PDF's folder.
 */
export function skeleton(manifest: Manifest, opts: { name: string; scriptPath: string; notes?: ReadonlyMap<number, string> }): string {
  const first = manifest.slides.find(s => s.title)?.title
  // No "#" in the title: in the front matter it would start a comment.
  const title = headingTitle((first ?? manifest.label).replace(/#/g, ' '))
  const out = [
    '---',
    `deck: ${manifest.id}      # written by prepare: don't change it`,
    ...(title ? [`title: ${title}`] : []),
    '# minutes: 15       # how long you have: check compares its estimate with it',
    '---',
    '',
    scriptHelp(opts.name, opts.scriptPath),
  ]
  for (const slide of manifest.slides) out.push('', ...skeletonSection(slide, opts.notes?.get(slide.n)))
  return `${out.join('\n')}\n`
}

/**
 * What stops prepare from updating a script: no front matter or deck line, an unclosed comment, or sections out of
 * order. Other problems (a TODO, an unknown key) don't: check reports them after.
 */
export function structureProblems(source: string): Problem[] {
  const errors: Problem[] = []
  outline(source, errors)
  return errors.filter(e => STRUCTURAL.has(e))
}

/** Whether a parsed script has one of the problems that leave its structure unclear (structureProblems' kind). */
export const unclear = (parsed: Parsed) => parsed.errors.some(e => STRUCTURAL.has(e))

export interface Merged {
  text: string
  /** Pages whose slide changed (or can't be compared), by the slide's page in the new deck: check: changed. */
  changed: number[]
  /** New pages: skeleton sections. */
  added: number[]
  /** Sections whose slide is not in the deck any more, or is left out now, by their page before the merge: exclude: yes. */
  gone: number[]
  /** Slides that moved to another page, with their sections, excluded ones too: from the old page to the new one. */
  moved: { from: number; to: number }[]
  /** Whether the sections' headings were renumbered. When not (a reorder), each section that moved is marked check: changed. */
  renumbered: boolean
  /** Sections with no slide in the new deck, renumbered to keep the sections in page order: from the old number to the new. */
  retired: { from: number; to: number }[]
  /** New pages with no section yet, when not renumbered: a section that must move, or is excluded, still has their number. */
  unsectioned: number[]
  /** Pages left out with --exclude before, back in the deck, whose sections the merge had excluded: check: changed. */
  back: number[]
  /** Pages left out with --exclude whose section lost prepare's own notes of the slide's text. */
  scrubbed: number[]
  /** Pages rendered though their section says exclude: yes: their text is in the deck. */
  excludedRendered: number[]
}

/** prepare's own one-line comments that quote a slide: the skeleton's, and the merge's. */
const QUOTES_SLIDE = /^\s*<!-- (?:On the slide(?: now)?|On page \d+ now, with no section yet|Page label|Your notes): .*-->\s*$/

/** The comment the merge writes right after the "exclude: yes" it gives a section whose page was left out with --exclude. */
const leftOutComment = (page: number) => `<!-- Page ${page} was left out when the deck was prepared, so this section is excluded. -->`
const LEFT_OUT = /^<!-- Page (\d+) was left out when the deck was prepared, so this section is excluded\. -->$/

/**
 * The comment the merge writes in a section whose slide is not in the deck any more: right after the "exclude: yes" it
 * adds (own), or under the owner's. `was` is the section's page before the merge, `page` after it, and `pages` the
 * new deck's page count.
 */
function goneComment(was: number, page: number, pages: number, own: boolean): string {
  const why = page !== was
    ? `Was page ${was}: that slide is not in the deck any more`
    : page > pages
      ? `Page ${page} is not in the deck any more`
      : `The slide on page ${page} is not in the deck any more`
  return `<!-- ${why}${own ? ', so this section is excluded' : ''}. -->`
}

/** Any comment goneComment writes, whatever its page: such a section's slide was deleted, so it never comes back. */
const GONE = /^<!-- (?:Page \d+ is not in the deck any more|Was page \d+: that slide is not in the deck any more|The slide on page \d+ is not in the deck any more)(?:, so this section is excluded)?\. -->$/
const WAS_GONE = /^<!-- Was page \d+: that slide is not in the deck any more/

/**
 * What the merge says in a section with no slide whose number is a page of the deck, when the headings stay: another
 * section must move there, or that page needs one, so the owner must clear the number.
 */
const takenComment = (page: number) => `<!-- Page ${page} is another slide now: delete this section, or move it to the end and number it after the last slide. -->`

/** What the merge says in a section whose slide moved when the headings stay. */
const moveComment = (page: number) => `<!-- This slide is now page ${page}: move this section there and renumber its heading, then delete "check: changed". -->`
const MOVE = /^<!-- This slide is now page (\d+): move this section there and renumber its heading, then delete "check: changed"\. -->$/

/** What an "on-request: yes" becomes in a section the merge excludes: the two keys can't go together. */
const ON_REQUEST_KEPT = '<!-- on-request: yes (put it back if the page returns) -->'

/**
 * The old deck's slides found again in the new one, from the old page to the new: by the text, when it is not empty and
 * comes once in each deck, or else by the picture, when it comes once in each. An unchanged page renders to the same
 * bytes, so that is how a slide with no text, or the same text as another, is found.
 */
function findAgain(oldDeck: Manifest | null, deck: Manifest): Map<number, number> {
  const found = new Map<number, number>()
  const claimed = new Set<number>()
  for (const key of [(s: ManifestSlide) => (s.text ? s.textHash : ''), (s: ManifestSlide) => s.sha256]) {
    const index = (slides: readonly ManifestSlide[]) => {
      const out = new Map<string, number[]>()
      for (const s of slides) if (key(s)) out.set(key(s), [...(out.get(key(s)) ?? []), s.n])
      return out
    }
    const before = index(oldDeck?.slides ?? [])
    const after = index(deck.slides)
    for (const s of oldDeck?.slides ?? []) {
      const there = before.get(key(s))
      const here = after.get(key(s))
      if (found.has(s.n) || there?.length !== 1 || here?.length !== 1 || claimed.has(here[0])) continue
      found.set(s.n, here[0])
      claimed.add(here[0])
    }
  }
  return found
}

/**
 * Where the old deck's other pages are in the new one, in three passes. The slides found again that kept their order
 * mark out stretches of both decks. First, in each stretch, repeated slides that look the same (text and picture) are
 * matched in order. Next, the copies of a look still unmatched in both decks are matched in order, wherever they are:
 * such a slide moved, as findAgain finds one that is not repeated. Last, in each stretch, the old pages still unmatched
 * take the new pages still unmatched, in order, between the first pass's matches. So a slide edited where it was is
 * compared there, and a page left out with --exclude, whose slide prepare never saw, is placed where the slides around
 * it put it, never on a repeated slide that only moved. An old page is not placed when its stretch has no new page
 * left: its slide was deleted. Also the shift of the last slide that kept its order, for a section written ahead,
 * past the old deck's end.
 */
function placeOldPages(oldDeck: Manifest, deck: Manifest, found: ReadonlyMap<number, number>): { placed: Map<number, number>; shift: number } {
  // The longest run of found slides whose new pages rise with their old ones. A slide moved out of that run is still
  // found, by its text or picture, but marks out nothing.
  const pairs = [...found].sort((a, b) => a[0] - b[0])
  const length = pairs.map(() => 1)
  const before = pairs.map(() => -1)
  for (let i = 0; i < pairs.length; i++) {
    for (let j = 0; j < i; j++) {
      if (pairs[j][1] < pairs[i][1] && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        before[i] = j
      }
    }
  }
  const run: [number, number][] = []
  for (let i = length.indexOf(Math.max(0, ...length)); i >= 0; i = before[i]) run.unshift(pairs[i])
  const marks: [number, number][] = [[0, 0], ...run, [oldDeck.pages + 1, deck.pages + 1]]
  const taken = new Set(found.values())
  const placed = new Map<number, number>()
  const match = (from: number, to: number) => {
    placed.set(from, to)
    taken.add(to)
  }
  // A slide's text and picture together. A page left out has neither, so it is never matched by them.
  const looks = (manifest: Manifest) => new Map(manifest.slides.map(s => [s.n, `${s.textHash} ${s.sha256}`]))
  const oldLooks = looks(oldDeck)
  const newLooks = looks(deck)
  const stretches = marks.slice(1).map(([b, b2], k) => {
    const [a, a2] = marks[k]
    const olds: number[] = []
    const news: number[] = []
    for (let p = a + 1; p < b; p++) if (!found.has(p)) olds.push(p)
    for (let p = a2 + 1; p < b2; p++) if (!taken.has(p)) news.push(p)
    return { olds, news, anchors: [] as [number, number][] }
  })
  // 1. Repeated slides within a stretch: the longest run of them that keeps its order.
  for (const { olds, news, anchors } of stretches) {
    const same = (i: number, j: number) => oldLooks.has(olds[i]) && oldLooks.get(olds[i]) === newLooks.get(news[j])
    const runs = Array.from({ length: olds.length + 1 }, () => new Array<number>(news.length + 1).fill(0))
    for (let i = olds.length - 1; i >= 0; i--) {
      for (let j = news.length - 1; j >= 0; j--) runs[i][j] = same(i, j) ? runs[i + 1][j + 1] + 1 : Math.max(runs[i + 1][j], runs[i][j + 1])
    }
    for (let i = 0, j = 0; i < olds.length && j < news.length;) {
      if (same(i, j) && runs[i][j] === runs[i + 1][j + 1] + 1) {
        match(olds[i], news[j])
        anchors.push([i++, j++])
      } else if (runs[i + 1][j] >= runs[i][j + 1]) i++
      else j++
    }
  }
  // 2. The copies of a look still unmatched, in order across the decks: repeated slides that moved.
  const spare = new Map<string, number[]>()
  for (const [n, look] of newLooks) if (!taken.has(n)) spare.set(look, [...(spare.get(look) ?? []), n])
  for (const [n, look] of oldLooks) {
    const to = found.has(n) || placed.has(n) ? undefined : spare.get(look)?.shift()
    if (to !== undefined) match(n, to)
  }
  // 3. Between the first pass's matches, the other pages in order: a slide edited in place, or a page left out.
  for (const { olds, news, anchors } of stretches) {
    let i = 0
    let j = 0
    for (const [x, y] of [...anchors, [olds.length, news.length]]) {
      const o = olds.slice(i, x).filter(p => !placed.has(p))
      const n = news.slice(j, y).filter(p => !taken.has(p))
      for (let k = 0; k < Math.min(o.length, n.length); k++) match(o[k], n[k])
      i = x + 1
      j = y + 1
    }
  }
  const last = run.at(-1)
  return { placed, shift: last ? last[1] - last[0] : 0 }
}

/**
 * The sections' page numbers once they follow their slides, or null when that would put them out of order (a reorder,
 * or a slide deleted where no number is free). `to` is each section's page in the new deck, or null for none. A section
 * with none keeps its number if it still fits between its neighbours, or else takes the first one that does, past the
 * deck's last page: on a page of the deck, it would hide that page's slide.
 */
function followSlides(pages: readonly number[], to: readonly (number | null)[], pageCount: number): number[] | null {
  const out: number[] = []
  for (let i = 0; i < pages.length; i++) {
    const prev = out[i - 1] ?? 0
    const t = to[i]
    if (t !== null) {
      if (t <= prev) return null
      out.push(t)
      continue
    }
    const next = to.slice(i + 1).find(n => n !== null) ?? MAX_PAGES + 1
    const fits = (n: number) => n > prev && n < next && n <= MAX_PAGES && n > pageCount
    const n = fits(pages[i]) ? pages[i] : Math.max(prev + 1, pageCount + 1)
    if (!fits(n)) return null
    out.push(n)
  }
  return out
}

/**
 * Updates an existing script for a newly prepared deck, never touching a written paragraph:
 * - the deck line gets the new id, keeping a comment after it;
 * - each section's slide is found in the new deck: by its text or its picture, or else by its place among the slides
 *   that kept their order (a slide edited where it was stays between its neighbours). An excluded section is found the
 *   same way: the exclude goes with its slide. When the sections stay in page order that way (slides inserted or
 *   deleted before them), their headings are renumbered, and a section whose slide is gone takes a number past the
 *   deck's last page. Otherwise (a reorder, or a slide deleted where no number is free) the headings stay: a section
 *   whose slide moved gets "check: changed" and a comment saying where its slide is now, and a new page whose number
 *   such a section still has is quoted in that section and reported, as it can't have a section yet;
 * - a section whose slide changed, in its text or its picture (by the old deck's hashes; every section not excluded,
 *   when the old deck is gone) gets "check: changed", which refuses check until the owner has read it. An excluded
 *   one too: its exclude was for the slide before;
 * - a section whose slide is no longer in the deck gets "exclude: yes" (an "exclude: no" becomes yes, and an
 *   "on-request: yes" a comment), and a comment that says so. When the headings stay, it keeps its number, and a
 *   comment says when that number is another slide's now. A page left out with --exclude also loses prepare's own
 *   comments that quote it, and its heading's title when that is the slide's;
 * - a page the merge excluded because it was left out with --exclude, back in the deck where the slides around it put
 *   it, loses those two lines and gets "check: changed". A section whose slide was deleted never comes back: a new
 *   slide on its number gets a section of its own;
 * - a new page gets a skeleton section.
 * So lines are added, and the merge changes only its own: the deck line, check keys, a heading's number or slide
 * title, its exclude lines, and the comments prepare wrote. Call it only when structureProblems() found none.
 */
export function mergeScript(source: string, oldManifest: Manifest | null, manifest: Manifest, notes: ReadonlyMap<number, string> = new Map()): Merged {
  const text = normalise(source)
  const trailing = text.endsWith('\n')
  const lines = (trailing ? text.slice(0, -1) : text).split('\n')
  const shape = outline(text, [])
  if (!shape || shape.deckLine < 0) throw new Error('the script has no front matter with a deck line')
  const before = new Map<number, string[]>()
  const insert = (at: number, add: string[]) => before.set(at, [...(before.get(at) ?? []), ...add])
  const replace = new Map<number, string>()
  const drop = new Set<number>()
  // The old value is all that keyValue() reads: everything up to a "# comment" (or an HTML comment), which stays.
  const deck = /^(\s*deck:)(.*?)((?:[ \t]+|(?<=:))#.*|[ \t]*<!--.*)?$/i.exec(lines[shape.deckLine])
  const rest = deck?.[3] ?? ''
  replace.set(shape.deckLine, deck ? `${deck[1]} ${manifest.id}${rest.startsWith('#') ? ' ' : ''}${rest}` : lines[shape.deckLine])

  const slides = new Map(manifest.slides.map(s => [s.n, s]))
  const old = new Map(oldManifest?.slides.map(s => [s.n, s]) ?? [])
  const sections = shape.sections
  const ends = sections.map((_, i) => sections[i + 1]?.headingLine ?? lines.length)
  /** The index of the first line of section i that is this comment, or -1. */
  const lineOf = (i: number, comment: RegExp) => {
    for (let n = sections[i].headingLine + 1; n < ends[i]; n++) if (comment.test(lines[n].trim())) return n
    return -1
  }
  const excluded = (i: number) => {
    const ex = sections[i].keys.find(k => k.key === 'exclude')
    return ex !== undefined && yesNo(ex.value) === true
  }
  // What a section is: shown (not excluded), excluded by the owner, or excluded by the merge, because its page was
  // left out with --exclude or because its slide was deleted. The merge's own comments say which.
  const kinds = sections.map((_, i) => (!excluded(i) ? 'shown' : lineOf(i, LEFT_OUT) >= 0 ? 'left-out' : lineOf(i, GONE) >= 0 ? 'gone' : 'excluded'))

  // The old deck's page each section is for: the one the merge's own comment names, for a page left out or a slide
  // that moved while the headings stayed (the owner may prepare again before moving it), or else its number.
  const oldPages = sections.map((section, i) => {
    if (kinds[i] === 'left-out') return Number(LEFT_OUT.exec(lines[lineOf(i, LEFT_OUT)].trim())?.[1])
    const at = lineOf(i, MOVE)
    const moved = at >= 0 ? Number(MOVE.exec(lines[at].trim())?.[1]) : 0
    return old.has(moved) ? moved : section.page
  })

  // Each section's page in the new deck (a slide, or a page left out again), or null for none.
  const found = findAgain(oldManifest, manifest)
  const { placed, shift } = oldManifest ? placeOldPages(oldManifest, manifest, found) : { placed: new Map<number, number>(), shift: 0 }
  // The new pages some old page is: no other section may take them.
  const reserved = new Set([...found.values(), ...placed.values()])
  const claimed = new Set<number>()
  const target: (number | null)[] = sections.map((section, i) => {
    const kind = kinds[i]
    // A deleted slide's section is for no slide, whatever its number is now.
    if (kind === 'gone') return null
    const p = oldPages[i]
    let t: number | null = null
    if (!oldManifest) t = p <= manifest.pages ? p : null
    else if (old.has(p)) t = kind === 'left-out' ? null : (found.get(p) ?? placed.get(p) ?? null)
    else if (p <= oldManifest.pages) t = placed.get(p) ?? null
    // Past the old deck's end: a section the owner wrote ahead follows the last slide that kept its order. An excluded
    // one there was retired by a merge: it is for no slide.
    else if (kind === 'shown' && p + shift <= manifest.pages && !reserved.has(p + shift)) t = p + shift
    if (t === null || claimed.has(t)) return null
    claimed.add(t)
    return t
  })
  // A slide neither found nor placed (its stretch had no new page left, as after a reorder) is compared on its own
  // page, when that page is no other old slide's.
  sections.forEach((_, i) => {
    const p = oldPages[i]
    if (target[i] !== null || !old.has(p) || kinds[i] === 'gone' || kinds[i] === 'left-out') return
    if (found.has(p) || placed.has(p) || p > manifest.pages || reserved.has(p) || claimed.has(p)) return
    target[i] = p
    claimed.add(p)
  })
  // The page number is prepare's own key, so renumbering is prepare's job, but only while the sections stay in page
  // order. A reorder is left to the owner.
  const numbers = followSlides(sections.map(s => s.page), target, manifest.pages)
  const renumber = numbers !== null
  const numberOf = (i: number) => (numbers ? numbers[i] : sections[i].page)
  // The new deck's slides some section is for, excluded or not.
  const covered = new Set(target.filter((t): t is number => t !== null && slides.has(t)))
  // A new slide no section is for, whose number a section still has: a section that must move, or one with no slide.
  // It can't have a section yet, and must never be hidden under an excluded one.
  const unsectioned = new Set(manifest.slides.filter(s => !covered.has(s.n) && sections.some((_, i) => numberOf(i) === s.n)).map(s => s.n))
  const merged: Merged = {
    text: '', changed: [], added: [], gone: [], moved: [], renumbered: Boolean(numbers?.some((n, i) => n !== sections[i].page)),
    retired: [], unsectioned: [], back: [], scrubbed: [], excludedRendered: [],
  }

  sections.forEach((section, i) => {
    const next = ends[i]
    const keyEnd = (section.keys.at(-1)?.index ?? section.headingLine) + 1
    const has = (key: string) => section.keys.find(k => k.key === key)
    const from = section.page
    const page = numberOf(i)
    const to = target[i]
    const kind = kinds[i]
    const slide = to === null ? undefined : slides.get(to)
    // The section's page is left out of the new deck.
    const leftOut = to !== null && !slide
    const ex = has('exclude')
    let heading = lines[section.headingLine]
    if (page !== from) heading = heading.replace(/^(##[ \t]+)\d+/, `$1${page}`)
    const comments: string[] = []
    let flag = false
    let quote: ManifestSlide | null = null
    // A new slide on this section's number that has no section: quoted here, and read before check passes.
    const here = unsectioned.has(page) ? (slides.get(page) ?? null) : null
    if (here) flag = true
    // Where the slide is now, when the headings stay. An earlier merge's word on it is written again for this deck,
    // or goes once the section is on its slide's page.
    const move = !renumber && to !== null && to !== page ? moveComment(to) : ''
    let moveKept = false
    for (let n = section.headingLine + 1; n < next; n++) {
      if (!MOVE.test(lines[n].trim())) continue
      if (lines[n].trim() === move && !moveKept) moveKept = true
      else drop.add(n)
    }
    // A section with no slide whose number is a page of the deck, shown or left out: when the headings stay, it is in
    // the way of the section that must move there, or of the one that page will get.
    const taken = !renumber && to === null && page <= manifest.pages ? takenComment(page) : ''
    const done = () => {
      replace.set(section.headingLine, heading)
      if (move) {
        flag = true
        merged.moved.push({ from, to: to as number })
      }
      if (flag) {
        const check = has('check')
        if (check?.value !== 'changed') {
          if (check) replace.set(check.index, lines[check.index].replace(/^(\s*check:\s*)\S+/i, '$1changed'))
          insert(keyEnd, [...(check ? [] : ['check: changed']), ...comments])
        }
      }
      if (move && !moveKept) insert(keyEnd, [move])
      if (taken && !lines.slice(section.headingLine + 1, next).some(l => l.trim() === taken)) insert(keyEnd, [taken])
      const quotes = [
        ...(quote ? [quote.text ? `<!-- On the slide now: "${inComment(quote.text)}" -->` : '<!-- On the slide now: no text (an image only). -->'] : []),
        ...(here ? [here.text ? `<!-- On page ${page} now, with no section yet: "${inComment(here.text)}" -->` : `<!-- On page ${page} now, with no section yet: no text (an image only). -->`] : []),
      ]
      if (quotes.length) insert(next, next === lines.length ? ['', ...quotes] : [...quotes, ''])
    }
    // A page left out with --exclude: prepare's own comments quoting it go, and its heading's title if it is the slide's.
    const scrub = () => {
      let any = false
      for (let n = section.headingLine + 1; n < next; n++) {
        if (QUOTES_SLIDE.test(lines[n])) {
          drop.add(n)
          any = true
        }
      }
      const was = old.get(oldPages[i])
      if (was && section.heading && section.heading === headingTitle(was.title)) {
        heading = heading.replace(/^(##[ \t]+\d+).*$/, '$1')
        any = true
      }
      if (any) merged.scrubbed.push(to ?? page)
    }
    // Whether the slide is the one the section was written (or excluded) for, and if not, why, in a comment.
    const compare = (what: 'written' | 'excluded') => {
      if (!slide || (what === 'excluded' && !oldManifest)) return
      const was = old.get(oldPages[i])
      const sameText = was?.textHash === slide.textHash
      // Image-only slides all share the text hash of '', and an unchanged page renders to the same bytes: so the
      // picture is compared too, and a re-export stays quiet.
      if (was && sameText && was.sha256 === slide.sha256) return
      const why = !oldManifest
        ? "The deck this script was written for is gone or can't be used, so prepare can't tell whether this slide changed"
        : !was
          ? `This slide was not in the deck this section was ${what} for`
          : sameText
            ? `This slide's picture changed since this section was ${what}, though its text did not`
            : `This slide changed since this section was ${what}`
      flag = true
      comments.push(`<!-- ${why}: ${what === 'written' ? 'read it against the slide' : 'make sure it should still be left out'}, then delete "check: changed". -->`)
      quote = slide
      merged.changed.push(to as number)
    }
    // Renumbered: the slide moved, or the section has no slide and keeps the sections in page order. The merge's own
    // exclude comments, and the one it adds for a gone slide, say why; anything else gets a comment here.
    if (renumber && page !== from) {
      if (slide && kind !== 'left-out') {
        merged.moved.push({ from, to: page })
        insert(keyEnd, [`<!-- Was page ${from}: the slide moved to page ${page}. -->`])
      } else {
        if (!slide) merged.retired.push({ from, to: page })
        if (slide || (leftOut && kind === 'excluded')) insert(keyEnd, [`<!-- Was page ${from}: renumbered to keep the sections in page order. -->`])
      }
    }

    if (kind === 'shown') {
      if (slide) {
        compare('written')
        return done()
      }
      // Its slide is gone, or left out now: excluded, with a comment that says which.
      const why = leftOut ? leftOutComment(to as number) : goneComment(from, page, manifest.pages, true)
      if (ex) {
        // "exclude: no" (or a value check refuses) becomes yes: a second exclude key would be an error.
        replace.set(ex.index, lines[ex.index].replace(/^(\s*exclude:)[ \t]*\S*/i, '$1 yes'))
        insert(ex.index + 1, [why])
      } else insert(keyEnd, ['exclude: yes', why])
      // A section can't be both on request and excluded: the key becomes a comment, which parses as nothing.
      const onRequest = has('on-request')
      if (onRequest && yesNo(onRequest.value) === true) replace.set(onRequest.index, ON_REQUEST_KEPT)
      if (leftOut) scrub()
      merged.gone.push(from)
      return done()
    }
    if (kind === 'left-out') {
      const at = lineOf(i, LEFT_OUT)
      if (slide) {
        // The merge's own exclude, for a page that is back: undone, and read again before it is shown.
        if (ex) drop.add(ex.index)
        drop.add(at)
        for (let n = section.headingLine + 1; n < next; n++) if (lines[n].trim() === ON_REQUEST_KEPT) replace.set(n, 'on-request: yes')
        flag = true
        comments.push(`<!-- Page ${to} is back in the deck: read it against the slide, then delete "check: changed". -->`)
        quote = slide
        merged.back.push(to as number)
        return done()
      }
      // Still left out, maybe on another page now; or no page is left for it, so its slide was deleted.
      const why = leftOut ? leftOutComment(to as number) : goneComment(from, page, manifest.pages, true)
      if (lines[at].trim() !== why) replace.set(at, why)
      if (leftOut) scrub()
      else merged.gone.push(from)
      return done()
    }
    // A deleted slide's section, excluded by the merge or by the owner: its comment says so. Once written, it changes
    // only when the heading is renumbered, and "Was page N" stays true however often that happens.
    const gone = (own: boolean) => {
      const at = lineOf(i, GONE)
      if (at < 0) {
        insert(keyEnd, [goneComment(from, page, manifest.pages, own)])
        merged.gone.push(from)
      } else if (page !== from && !WAS_GONE.test(lines[at].trim())) replace.set(at, goneComment(from, page, manifest.pages, own))
    }
    if (kind === 'gone') {
      gone(lines[lineOf(i, GONE)].includes(', so this section is excluded'))
      return done()
    }
    // Excluded by the owner: the exclude goes with its slide, and is read again when that slide changed.
    if (slide) {
      merged.excludedRendered.push(to as number)
      compare('excluded')
    } else if (leftOut) scrub()
    else gone(false)
    return done()
  })
  for (const slide of manifest.slides) {
    if (covered.has(slide.n)) continue
    if (unsectioned.has(slide.n)) {
      merged.unsectioned.push(slide.n)
      continue
    }
    const after = sections.findIndex((_, i) => numberOf(i) > slide.n)
    const add = skeletonSection(slide, notes.get(slide.n))
    if (after >= 0) insert(sections[after].headingLine, [...add, ''])
    else insert(lines.length, ['', ...add])
    merged.added.push(slide.n)
  }
  const out: string[] = []
  for (let i = 0; i <= lines.length; i++) {
    out.push(...(before.get(i) ?? []))
    if (i < lines.length && !drop.has(i)) out.push(replace.get(i) ?? lines[i])
  }
  merged.text = `${out.join('\n')}${trailing ? '\n' : ''}`
  return merged
}
