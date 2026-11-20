// The slides a join brings: the presentation script, as npm run join and the channel send it (its canonical text, with
// no comment), parsed again, checked against its prepared deck, and the meeting's slides and their images read. The
// voice service does it before any bot is created, so a join it refuses costs nothing; npm run join does the same on
// your own computer first, so most mistakes are named before anything is sent.
//
// Only the slides the script shows are read: an excluded page's image never leaves the decks folder. Nothing here is
// logged: the messages go to the owner, and name the fix.
import fs from 'node:fs'
import path from 'node:path'
import { DeckError, DeckStore } from './deck.ts'
import { DECK_ID, type Manifest } from './manifest.ts'
import { type PresenterSlide, presenterSlides } from './presenter.ts'
import { MAX_SCRIPT_FILE_BYTES, type Script, canonicalText, checkScript, parseScript, problemsText } from './script.ts'

/** A join's slides refused, and why, in words for the owner. Never a path. */
export class SlidesRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlidesRefused'
  }
}

/** A meeting's slides, from the join until its bot is out of the call: in memory only. */
export interface MeetingDeck {
  /** The parsed script: the text it came as is dropped. */
  script: Script
  manifest: Manifest
  /** The slides the meeting shows, in page order, and their images in the same order. */
  slides: PresenterSlide[]
  images: Buffer[]
  /** The page to start from (--from), if given. */
  from?: number
  /** What the owner calls it: the script's title, else the deck's label. */
  name: string
  /** The slides presented in order, and the estimate of their narration (ms). */
  narrated: number
  totalMs: number
}

export interface DeckPlace {
  /** The decks folder (data/decks). */
  decksDir: string
  /** DECK_RETENTION_DAYS, for the message about a deck that is gone. */
  retentionDays: number
  now?: Date
}

const CHECK_IT = 'npm run slides -- check <your script> lists everything'

/**
 * The slides a join brings, checked and read: {script: <canonical text>, from?: <page>}. Throws SlidesRefused with the
 * fix, never anything else. The text must have no comment: the CLI and the channel strip them, so one that has them was
 * not sent by either, and is refused rather than quietly stripped.
 */
export function meetingDeck(given: unknown, place: DeckPlace): MeetingDeck {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw new SlidesRefused('slides has to be {script, from}: the script as npm run join or the channel sends it.')
  }
  const { script: text, from } = given as Record<string, unknown>
  if (typeof text !== 'string' || !text.trim()) {
    throw new SlidesRefused(from === undefined || from === null ? 'slides has no script.' : 'slides_from goes with slides: give the script too.')
  }
  if (Buffer.byteLength(text) > MAX_SCRIPT_FILE_BYTES) throw new SlidesRefused(`The script is over ${MAX_SCRIPT_FILE_BYTES} bytes.`)
  if (text.includes('<!--')) {
    throw new SlidesRefused(
      'The script still has comments in it. npm run join and the channel send it without them, so that your notes never reach ' +
        'the voice service: send it one of those ways.',
    )
  }
  let page: number | undefined
  if (from !== undefined && from !== null) {
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 1 || from > 100) throw new SlidesRefused('--from takes a slide number from 1 to 100.')
    page = from
  }
  const parsed = parseScript(text)
  if (!parsed.script || parsed.errors.length) throw new SlidesRefused(`The script can't be used: ${problemsText(parsed.errors)}. ${CHECK_IT}.`)
  const script = parsed.script
  if (!DECK_ID.test(script.deck)) throw new SlidesRefused(`The script's deck: line is not a deck id. ${CHECK_IT}.`)

  // Only the slides the script shows are read: an excluded page's image never leaves the decks folder.
  const shown = script.sections.filter(s => !s.exclude && !s.todo).map(s => s.page)
  const store = new DeckStore(place.decksDir)
  let manifest: Manifest
  let images: Map<number, Buffer>
  try {
    ;({ manifest, images } = store.load(script.deck, { images: shown }))
  } catch (err) {
    if (err instanceof DeckError && err.code === 'missing') {
      throw new SlidesRefused(
        `The prepared deck ${script.deck} is gone (a deck is deleted ${place.retentionDays} days after it was last used, or by slides delete). ` +
          'Run npm run slides -- prepare <your PDF> again: your script is kept, and updated for the new deck.',
      )
    }
    if (err instanceof DeckError) throw new SlidesRefused(err.message)
    const code = (err as NodeJS.ErrnoException)?.code
    throw new SlidesRefused(`The prepared deck ${script.deck} can't be read (${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'an error'}).`)
  }
  // Figures are not compared: that is check's, for the deck's own script. Only what refuses a script matters here.
  const checked = checkScript(parsed, manifest, { figures: false })
  if (checked.errors.length) throw new SlidesRefused(`The script can't be used with its deck: ${problemsText(checked.errors)}. ${CHECK_IT}.`)
  const slides = presenterSlides(script, manifest)
  const missing = slides.find(s => !images.has(s.page))
  if (missing) throw new SlidesRefused(`The prepared deck ${script.deck} has no image for slide ${missing.page}.`)
  if (page !== undefined) {
    const at = slides.find(s => s.page === page)
    if (!at || at.onRequest) {
      throw new SlidesRefused(`Slide ${page} is not one the script presents in order (it is excluded, on request, or has no section): start from another.`)
    }
  }
  // A join is a use of the deck: the retention sweep keeps it. A deck that can't be marked is still presented.
  try {
    store.touch(script.deck, place.now)
  } catch {
    // Only the retention date is lost.
  }
  return {
    script,
    manifest,
    slides,
    images: slides.map(s => images.get(s.page)!),
    ...(page !== undefined ? { from: page } : {}),
    name: script.title ?? manifest.label,
    narrated: checked.narrated,
    totalMs: checked.totalMs,
  }
}

/** The script a join sends, read and checked on your own computer: its canonical text, or why it can't go. */
export type JoinScript = { ok: true; text: string; deck: MeetingDeck; warnings: number } | { ok: false; problem: string }

/**
 * For npm run join --slides: reads the script file (a <deck>.script.md, at most 1 MiB), checks it and its deck as the
 * service will, and gives the canonical text to send, with no comment in it. The file is never quoted back.
 */
export function joinScript(file: string, from: number | undefined, place: DeckPlace): JoinScript {
  const name = path.basename(file)
  if (!/\.script\.md$/i.test(name)) return { ok: false, problem: `${name} is not a script: --slides takes the <deck>.script.md file prepare wrote.` }
  let raw: string
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { ok: false, problem: `${name} is not a plain file.` }
    if (stat.size > MAX_SCRIPT_FILE_BYTES) return { ok: false, problem: `${name} is over ${MAX_SCRIPT_FILE_BYTES} bytes.` }
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, problem: `Could not read the script ${name}: ${(err as NodeJS.ErrnoException).code ?? 'an error'}.` }
  }
  // Its own errors first, comments and all: an excluded section marked check: changed is one, and its canonical text
  // would no longer say so.
  const parsed = parseScript(raw)
  if (!parsed.script || parsed.errors.length) return { ok: false, problem: `${name} can't be used: ${problemsText(parsed.errors)}. ${CHECK_IT}.` }
  const text = canonicalText(parsed.script)
  try {
    const deck = meetingDeck({ script: text, from }, place)
    const warnings = checkScript(parsed, deck.manifest, { figures: false }).warnings.length
    return { ok: true, text, deck, warnings }
  } catch (err) {
    if (err instanceof SlidesRefused) return { ok: false, problem: err.message }
    throw err
  }
}
