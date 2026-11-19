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
import { MS_PER_CHAR, spokenLength } from '../pipeline/playback.ts'
import { DECK_ID, MAX_PAGES, type Manifest, WARNINGS } from './manifest.ts'

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
  // such line is named: a file that only looks like a script (YAML, notes) gives one line number, not its lines.
  let unknown = false
  for (i++; i < lines.length && lines[i].text.trim() !== '---'; i++) {
    const { text, n } = lines[i]
    if (unknown || !text.trim() || text.trim().startsWith('#')) continue
    const kv = keyValue(text)
    if (!kv || !['deck', 'title', 'minutes'].includes(kv.key)) {
      errors.push({ line: n, message: 'this is not a front matter key: they are deck, title and minutes' })
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
      if (problem) errors.push({ line: p.line, page: raw.page, message: problem })
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
    }
    sections.push(section)
  }
  const script: Script = { deck, title, minutes, sections }
  if (sections.length && !sections.some(s => !s.exclude && !s.onRequest)) errors.push({ message: 'nothing to present: every section is excluded or on request' })
  const length = canonicalText(script).length
  if (length > MAX_SCRIPT_CHARS) errors.push({ message: `the script is ${length} characters without its comments: at most ${MAX_SCRIPT_CHARS} (about 45 minutes)` })
  return { script, errors, warnings }
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
     meeting never see them. Your Claude Code session does, if it reads this file.
     Keys go directly under a heading, then a blank line before the spoken text:
       hold: 3s          extra seconds on the slide before speaking, for reading (0 to 30)
       pause: 5s         silence after the last sentence (0 to 60); a question there can be answered without the name
       on-request: yes   a backup slide: shown only when someone asks for it
       exclude: yes      never shown, and never sent to the meeting
       check: yes        drafted, not yet read by you: delete the line once you have
     Then run, from where you ran prepare: npm run slides -- check ${inComment(shellArg(scriptPath))} -->`
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
  /** Pages whose slide changed (or can't be compared): check: changed. */
  changed: number[]
  /** New pages: skeleton sections. */
  added: number[]
  /** Pages no longer in the deck: exclude: yes. */
  gone: number[]
}

/**
 * Updates an existing script for a newly prepared deck, never touching a written paragraph: the deck line gets the new
 * id; a section whose slide's text changed (by the old deck's text hash; every section, when the old deck is gone)
 * gets "check: changed", which refuses check until the owner has read it; a page no longer in the deck gets
 * "exclude: yes"; a new page gets a skeleton section. Only lines are added (and a "check: yes" becomes "check:
 * changed"); call it only when structureProblems() found none.
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
  replace.set(shape.deckLine, lines[shape.deckLine].replace(/^(\s*deck:\s*)\S*/i, `$1${manifest.id}`))

  const slides = new Map(manifest.slides.map(s => [s.n, s]))
  const old = new Map(oldManifest?.slides.map(s => [s.n, s]) ?? [])
  const merged: Merged = { text: '', changed: [], added: [], gone: [] }
  const sections = shape.sections
  sections.forEach((section, i) => {
    const next = sections[i + 1]?.headingLine ?? lines.length
    const keyEnd = (section.keys.at(-1)?.index ?? section.headingLine) + 1
    const has = (key: string) => section.keys.find(k => k.key === key)
    if (has('exclude') && yesNo(has('exclude')?.value ?? '') === true) return
    const slide = slides.get(section.page)
    if (!slide) {
      const why = section.page > manifest.pages ? `Page ${section.page} is not in the deck any more` : `Page ${section.page} was left out when the deck was prepared`
      insert(keyEnd, ['exclude: yes', `<!-- ${why}, so this section is excluded. -->`])
      merged.gone.push(section.page)
      return
    }
    const was = old.get(section.page)
    if (was && was.textHash === slide.textHash) return
    const why = !oldManifest
      ? 'The deck this script was written for is gone, so prepare can\'t tell whether this slide changed'
      : 'This slide changed since this section was written'
    const check = has('check')
    if (check?.value !== 'changed') {
      if (check) replace.set(check.index, lines[check.index].replace(/^(\s*check:\s*)\S+/i, '$1changed'))
      insert(keyEnd, [...(check ? [] : ['check: changed']), `<!-- ${why}: read it against the slide, then delete "check: changed". -->`])
    }
    const now = slide.text ? `<!-- On the slide now: "${inComment(slide.text)}" -->` : '<!-- On the slide now: no text (an image only). -->'
    insert(next, next === lines.length ? ['', now] : [now, ''])
    merged.changed.push(section.page)
  })
  const known = new Set(sections.map(s => s.page))
  for (const slide of manifest.slides) {
    if (known.has(slide.n)) continue
    const after = sections.find(s => s.page > slide.n)
    const add = skeletonSection(slide, notes.get(slide.n))
    if (after) insert(after.headingLine, [...add, ''])
    else insert(lines.length, ['', ...add])
    merged.added.push(slide.n)
  }
  const out: string[] = []
  for (let i = 0; i <= lines.length; i++) {
    out.push(...(before.get(i) ?? []))
    if (i < lines.length) out.push(replace.get(i) ?? lines[i])
  }
  merged.text = `${out.join('\n')}${trailing ? '\n' : ''}`
  return merged
}
