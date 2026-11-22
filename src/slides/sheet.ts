// The contact sheet, data/decks/<id>/sheet.html: every slide as the meeting will see it, at half size, with its title,
// what prepare noticed about it, and, once check has run, what the script does with it and the narration. A static
// page: no script, nothing loaded from anywhere but its own folder, every piece of text escaped. Open it in a browser.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WORDS } from '../commands.ts'
import { SHEET, TEMP_PREFIX } from './deck.ts'
import { type Manifest, WARNINGS } from './manifest.ts'

/** What the script does with one slide, for the sheet. */
export interface SheetSlide {
  /** "narrated, about 35 s", "on request", "excluded in the script", "no section: not shown". */
  status: string
  narration: string[]
  /** The script's errors and warnings for this page. */
  problems: string[]
}

export interface SheetInput {
  manifest: Manifest
  /** From check: by page number. Without it, the sheet shows the slides only. */
  slides?: ReadonlyMap<number, SheetSlide>
  /** One line about the whole script, from check. */
  summary?: string
  /** The script's name (its file name only, never its path). */
  scriptName?: string
  /** The script's title, if it has one: the deck's label otherwise. */
  title?: string
  now?: Date
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** The sheet's HTML. */
export function contactSheet(input: SheetInput): string {
  const { manifest } = input
  const heading = input.title || manifest.label
  const now = (input.now ?? new Date()).toISOString().slice(0, 16).replace('T', ' ')
  const cards = manifest.slides.map(slide => {
    const view = input.slides?.get(slide.n)
    const notes = [...slide.warnings.map(w => `The slide ${WARNINGS[w]}.`), ...(view?.problems ?? [])]
    const label = slide.pageLabel && slide.pageLabel !== String(slide.n) ? ` <span class="hint">(label “${escape(slide.pageLabel)}”)</span>` : ''
    return `<section class="slide">
<h2>Page ${slide.n}${slide.title ? ` · ${escape(slide.title)}` : ''}${label}</h2>
<img src="${slide.file}" width="640" height="360" alt="Page ${slide.n}">
${view ? `<p class="status">${escape(view.status)}</p>` : ''}
${notes.length ? `<ul class="notes">${notes.map(n => `<li>${escape(n)}</li>`).join('')}</ul>` : ''}
${view?.narration.length ? `<div class="narration">${view.narration.map(p => `<p>${escape(p)}</p>`).join('\n')}</div>` : ''}
</section>`
  })
  const excluded = manifest.excluded ? ` ${manifest.excluded} page${manifest.excluded === 1 ? ' was' : 's were'} left out when it was prepared.` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>Slides: ${escape(heading)}</title>
<style>
body { font: 15px/1.45 system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #fafafa; }
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { color: #555; margin: 0 0 20px; }
.slide { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 12px 16px; margin: 0 0 20px; max-width: 900px; }
.slide h2 { font-size: 16px; margin: 0 0 8px; }
.slide img { display: block; width: 640px; max-width: 100%; height: auto; border: 1px solid #ccc; background: #000; }
.hint { color: #777; font-weight: normal; }
.status { font-weight: 600; margin: 8px 0 4px; }
.notes { color: #8a4b00; margin: 4px 0; padding-left: 20px; }
.narration { border-left: 3px solid #6a8; padding-left: 12px; margin-top: 8px; }
.narration p { margin: 6px 0; }
</style>
</head>
<body>
<h1>${escape(heading)}</h1>
<p class="meta">Prepared deck ${escape(manifest.id)}: ${manifest.slides.length} slide${manifest.slides.length === 1 ? '' : 's'} from ${manifest.pages} page${manifest.pages === 1 ? '' : 's'}.${excluded}
Each slide is shown here at half the size the meeting gets (1280x720).
${input.summary ? `<br>${escape(input.scriptName ? `${input.scriptName}: ` : '')}${escape(input.summary)}` : `<br>Run ${escape(WORDS.run('slides', 'check'))} on its script to add the narration.`}
<br>Updated ${escape(now)} UTC.</p>
${cards.join('\n')}
</body>
</html>
`
}

/**
 * Writes the sheet into a deck's folder, by way of a temporary file in the decks folder (which the sweep removes if a
 * crash leaves it), so the deck's folder never holds a file the loader doesn't expect.
 */
export function writeSheet(decksDir: string, deckDir: string, html: string): void {
  const temp = path.join(decksDir, `${TEMP_PREFIX}sheet-${crypto.randomBytes(6).toString('hex')}.html`)
  try {
    fs.writeFileSync(temp, html, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, path.join(deckDir, SHEET))
  } finally {
    fs.rmSync(temp, { force: true })
  }
}
