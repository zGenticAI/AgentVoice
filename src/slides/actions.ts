// What npm run slides does: prepare, check, list and delete, each returning the lines to print and an exit code, so the
// tests can run them without a terminal. None needs a key or the network. Nothing printed here goes to the service's
// log: it is the owner's own terminal, so slide titles and file names may appear in it.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PrepareError, prepareDeck } from './convert.ts'
import { DeckError, DeckStore, TEMP_PREFIX, UNFINISHED_MAX_AGE_MS, scriptKey, scriptMark, sweepUnfinished } from './deck.ts'
import { type Kind, linkKind, refusal } from './detect.ts'
import { DECK_ID, type Manifest, WARNINGS } from './manifest.ts'
import {
  type Checked, MAX_SCRIPT_FILE_BYTES, type Problem, checkScript, mergeScript, parseScript, shellArg, skeleton, structureProblems, unclear,
} from './script.ts'
import { type SheetSlide, contactSheet, writeSheet } from './sheet.ts'

export interface Outcome {
  lines: string[]
  code: number
}

/** Where a file is, as the owner should read it: from the folder they ran the command in, when it is inside it. */
export function shown(file: string, cwd: string): string {
  const rel = path.relative(cwd, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file
}

/** The script beside a PDF: deck.pdf has deck.script.md. */
export const scriptFor = (pdf: string) => path.join(path.dirname(pdf), `${path.basename(pdf).replace(/\.pdf$/i, '')}.script.md`)

/** "page 4, line 23: " */
export function where(p: Problem): string {
  const parts = [p.page ? `page ${p.page}` : '', p.line ? `line ${p.line}` : ''].filter(Boolean)
  return parts.length ? `${parts.join(', ')}: ` : ''
}

/**
 * A script file's text, or why it can't be read: named <something>.script.md, a regular file, at most 1 MiB. Check
 * reads the file it is given itself, so a file of any other name is refused unread: its lines are never quoted.
 */
function readScript(file: string): string {
  if (!/\.script\.md$/i.test(path.basename(file))) throw new PrepareError(`${path.basename(file)} is not a script: check takes the <deck>.script.md file prepare wrote.`)
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) throw new PrepareError(`${path.basename(file)} was not found.`)
  if (!stat.isFile()) throw new PrepareError(`${path.basename(file)} is not a plain file${stat.isSymbolicLink() ? ' (it is a symbolic link)' : ''}.`)
  if (stat.size > MAX_SCRIPT_FILE_BYTES) throw new PrepareError(`${path.basename(file)} is over ${MAX_SCRIPT_FILE_BYTES} bytes.`)
  return fs.readFileSync(file, 'utf8')
}

/** Writes a script: a new one readable by you only, an existing one replaced at once, keeping its mode. */
function writeScript(file: string, text: string, existing: boolean): void {
  if (!existing) {
    fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' })
    return
  }
  const mode = fs.statSync(file).mode & 0o777
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(temp, text, { mode, flag: 'wx' })
    fs.chmodSync(temp, mode)
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const pages = (list: readonly number[]) => `${list.length === 1 ? 'page' : 'pages'} ${list.join(', ')}`
const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

/** Pages as ranges: "page 4", "pages 1-3, 6". */
export function ranges(list: readonly number[]): string {
  const sorted = [...new Set(list)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`)
    i = j
  }
  return `${sorted.length === 1 ? 'page' : 'pages'} ${parts.join(', ')}`
}

/** One line about a checked script. */
function summary(checked: Checked): string {
  const aside = [
    checked.todo ? `${checked.todo} to write` : '',
    checked.onRequest ? `${checked.onRequest} on request` : '',
    checked.excluded ? `${checked.excluded} excluded` : '',
  ].filter(Boolean)
  // The unit always, so seconds of narration never sit beside a bare number of minutes.
  const of = checked.script?.minutes ? ` of your ${checked.script.minutes} min` : ''
  const estimate = checked.totalMs || !checked.todo ? `, about ${minutes(checked.totalMs)}${of}` : ''
  return `${plural(checked.narrated, 'slide')} to present${aside.length ? ` (${aside.join(', ')})` : ''}${estimate}`
}

/**
 * The deck's own warnings (small text, bars and the like), one line per kind with its pages: a footer or a 4:3 deck
 * would otherwise give a line per slide, and bury the warnings that matter.
 */
function deckWarningLines(byPage: readonly { page: number; message: string }[]): string[] {
  const kinds = new Map<string, number[]>()
  for (const w of byPage) kinds.set(w.message, [...(kinds.get(w.message) ?? []), w.page])
  return [...kinds].map(([message, list]) => `${ranges(list)}: ${message}`)
}

/** What the sheet shows for each slide, from a checked script. */
export function sheetSlides(checked: Checked, manifest: Manifest): Map<number, SheetSlide> {
  const out = new Map<number, SheetSlide>()
  const sections = new Map(checked.script?.sections.map(s => [s.page, s]) ?? [])
  for (const slide of manifest.slides) {
    const section = sections.get(slide.n)
    const problems = [...checked.errors.map(e => ({ ...e, error: true })), ...checked.warnings]
      .filter(p => p.page === slide.n && !p.fromDeck)
      .map(p => `${'error' in p ? 'Error' : 'Warning'}: ${p.message}.`)
    const seconds = checked.estimates.get(slide.n)
    let status = 'No section in the script: not shown.'
    if (section?.exclude) status = 'Excluded in the script: never shown.'
    else if (section?.todo) status = 'To write (TODO): not narrated yet.'
    else if (section?.onRequest) status = `On request: shown only when someone asks for it${seconds ? `, about ${Math.round(seconds / 1000)} s` : ''}.`
    else if (section) status = `Narrated${seconds ? `, about ${Math.round(seconds / 1000)} s` : ''}${section.hold ? `, after ${section.hold} s to read it` : ''}${section.pause ? `, then ${section.pause} s of silence` : ''}.`
    out.set(slide.n, { status, narration: section && !section.exclude && !section.todo ? section.paragraphs : [], problems })
  }
  return out
}

/** Writes the sheet for a deck, with the script's view of it when there is one. */
function refreshSheet(store: DeckStore, manifest: Manifest, checked: Checked | null, scriptName: string): void {
  const dir = store.folder(manifest.id)
  const html = contactSheet({
    manifest,
    ...(checked
      ? {
          slides: sheetSlides(checked, manifest),
          summary: `${summary(checked)}; ${plural(checked.errors.length, 'error')}, ${plural(checked.warnings.length, 'warning')}.`,
          scriptName,
          title: checked.script?.title ?? undefined,
        }
      : {}),
  })
  writeSheet(store.dir, dir, html)
}

export interface PrepareInput {
  /** The PDF as given (found from cwd), or a link, which is refused. */
  input: string
  exclude: readonly number[]
  label?: string
  decksDir: string
  /** The assistant's name, for the script's note. */
  name: string
  cwd: string
  /** Tests only. */
  childScript?: string
  timeoutMs?: number
}

/** npm run slides -- prepare: the deck, then the script beside the PDF (new, or updated), then the contact sheet. */
export async function runPrepare(given: PrepareInput): Promise<Outcome> {
  // A link is refused before it is made into a path: resolved, it would only be "not found".
  const link = linkKind(given.input)
  if (link) return { lines: [refusal(link as Exclude<Kind, 'pdf'>, given.input.length > 80 ? `${given.input.slice(0, 77)}...` : given.input)], code: 1 }
  const input = { ...given, input: path.resolve(given.cwd, given.input) }
  const lines: string[] = []
  const store = new DeckStore(input.decksDir)
  const scriptFile = scriptFor(input.input)
  const scriptName = path.basename(scriptFile)
  const pdfName = path.basename(input.input)
  // An existing script is checked first: one whose structure can't be followed is never rewritten, and nothing is rendered.
  let existing: string | null = null
  try {
    if (fs.lstatSync(scriptFile, { throwIfNoEntry: false })) existing = readScript(scriptFile)
  } catch (err) {
    // Only a file that is there, but can't be used, is worth moving aside. Anything else is said by its code: Node's own
    // message names the whole path, and the advice wouldn't fit.
    if (err instanceof PrepareError) return { lines: [`${err.message} It is beside the PDF, where prepare writes the script: move it aside, then prepare again.`], code: 1 }
    return { lines: [scriptUnreadable(err, pdfName, scriptName)], code: 1 }
  }
  if (existing !== null) {
    const problems = structureProblems(existing)
    if (problems.length) {
      return {
        lines: [`${scriptName} can't be updated until these are fixed (or move it aside, and prepare writes a new one):`, ...problems.map(p => `  ${where(p)}${p.message}`)],
        code: 1,
      }
    }
  }

  // Prepare writes the script beside the PDF: a folder it can't write to (a read-only share, say) is found out before
  // anything is rendered, not after.
  const unwritable = folderUnwritable(path.dirname(scriptFile))
  if (unwritable) {
    return {
      lines: [`Prepare writes the script beside the PDF, and that folder can't be written to (${unwritable}). Copy the PDF${existing === null ? '' : ` (and ${scriptName})`} to a folder you can write to, then prepare it there.`],
      code: 1,
    }
  }

  let prepared
  try {
    prepared = await prepareDeck({
      input: input.input, decksDir: input.decksDir, exclude: input.exclude, label: input.label, scriptFile, childScript: input.childScript, timeoutMs: input.timeoutMs,
    })
  } catch (err) {
    if (err instanceof PrepareError) return { lines: [err.message], code: 1 }
    throw err
  }
  const { manifest } = prepared
  const excluded = manifest.excluded ? ` (${manifest.excluded} excluded)` : ''
  lines.push(`Prepared ${manifest.id}: ${plural(manifest.slides.length, 'page')} rendered${excluded} from ${path.basename(input.input)}.`)

  let text = existing ?? ''
  let wrote = false
  let oldId = ''
  try {
    if (existing === null) {
      text = skeleton(manifest, { name: input.name, scriptPath: shown(scriptFile, input.cwd), notes: prepared.notes })
      writeScript(scriptFile, text, false)
      wrote = true
      lines.push(`Script: ${shown(scriptFile, input.cwd)} (new): ${plural(manifest.slides.length, 'section')} to write (TODO).`)
    } else {
      oldId = parseScript(existing).script?.deck ?? ''
      let old: Manifest | null = null
      try {
        if (DECK_ID.test(oldId)) old = store.load(oldId).manifest
      } catch {
        old = null
      }
      const merged = mergeScript(existing, old, manifest, prepared.notes)
      writeScript(scriptFile, merged.text, true)
      text = merged.text
      wrote = true
      const moves = merged.moved
      const what = [
        moves.length && merged.renumbered ? `${pages(moves.map(m => m.from))} moved to ${moves.map(m => m.to).join(', ')} (headings renumbered)` : '',
        moves.length && !merged.renumbered ? `${moves.map(m => `page ${m.from} is now page ${m.to}`).join(', ')} (check: changed: move each section to its page)` : '',
        merged.changed.length ? `${pages(merged.changed)} changed (check: changed)` : '',
        merged.back.length ? `${pages(merged.back)} back in the deck (check: changed)` : '',
        merged.added.length ? `${pages(merged.added)} new (TODO)` : '',
        merged.gone.length ? `${pages(merged.gone)} no longer in the deck (exclude: yes)` : '',
      ].filter(Boolean)
      lines.push(`Script: ${shown(scriptFile, input.cwd)} (updated for the new deck): ${what.length ? what.join('; ') : 'no slide changed'}. Your written paragraphs are unchanged.`)
      if (merged.scrubbed.length) {
        const one = merged.scrubbed.length === 1
        lines.push(`  ${pages(merged.scrubbed)} left out: prepare's notes of ${one ? 'its' : 'their'} slide text are gone from the script, but your heading${one ? '' : 's'} and paragraphs for ${one ? 'it' : 'them'} are kept. Delete them if they must not appear anywhere.`)
      }
      if (merged.excludedRendered.length) {
        const list = merged.excludedRendered
        lines.push(`  ${pages(list)} ${list.length === 1 ? 'is' : 'are'} rendered, though ${list.length === 1 ? 'its section says' : 'their sections say'} exclude: yes. If ${list.length === 1 ? 'its' : 'their'} text must not be kept at all, prepare with --exclude ${list.join(',')}.`)
      }
      if (!old && DECK_ID.test(oldId)) lines.push(`  The deck it was written for (${oldId}) is gone, so every section is marked check: changed.`)
      if (old && oldId !== manifest.id) {
        store.delete(oldId)
        lines.push(`  Deleted the deck it was written for (${oldId}).`)
      }
    }
  } catch (err) {
    // Late, and rare (a full disk, a race): what was found is still said, and the sheet still written.
    const code = codeOf(err)
    lines.push(
      existing === null
        ? `Could not write ${scriptName} (${code}), so there is no script yet: copy the PDF to a folder you can write to, and prepare it there.`
        : `Could not write ${scriptName} (${code}): it is unchanged, and still uses deck ${oldId || '(none)'}. Prepare again from a folder you can write to, so the changed and new pages are marked.`,
    )
  }

  // One line per kind, in WARNINGS' order: "page 3 is not 16:9...", or "pages 1-6: the slide is not 16:9...".
  for (const code of Object.keys(WARNINGS) as (keyof typeof WARNINGS)[]) {
    const with_ = manifest.slides.filter(s => s.warnings.includes(code)).map(s => s.n)
    if (with_.length === 1) lines.push(`  page ${with_[0]} ${WARNINGS[code]}.`)
    else if (with_.length) lines.push(`  ${ranges(with_)}: the slide ${WARNINGS[code]}.`)
  }
  if (prepared.otherWarnings) lines.push(`  The PDF reader noted ${plural(prepared.otherWarnings, 'other problem')} while rendering (not shown: they can quote the file).`)
  // The sheet shows the script's view of the new deck: the one written, or for a new script that could not be, the
  // skeleton's. An old script that could not be updated is for another deck, so the sheet shows the slides only.
  const checked = wrote || existing === null ? checkScript(parseScript(text), manifest) : null
  refreshSheet(store, manifest, checked, scriptName)
  lines.push(`Contact sheet: ${shown(path.join(store.folder(manifest.id), 'sheet.html'), input.cwd)}`)
  if (!wrote) return { lines, code: 1 }
  lines.push('Next: write the sections (or ask your Claude Code session to draft them), then')
  lines.push(`  npm run slides -- check ${shellArg(shown(scriptFile, input.cwd))}`)
  return { lines, code: 0 }
}

/** An error's code, never its message (Node's names the whole path). */
function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error'
}

/** Why a folder can't be written to, as the error's code, or '' when it can (or isn't there: prepare says so later). */
function folderUnwritable(dir: string): string {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return ''
  } catch (err) {
    const code = codeOf(err)
    return code === 'ENOENT' || code === 'ENOTDIR' ? '' : code
  }
}

/** Why the script beside the PDF couldn't be looked at, in words for the owner: by the error's code, never its path. */
function scriptUnreadable(err: unknown, pdfName: string, scriptName: string): string {
  const code = codeOf(err)
  switch (code) {
    case 'ENAMETOOLONG':
      return `${pdfName}'s name is too long to put a script beside it: give the PDF a shorter name, then prepare again.`
    case 'ENOENT':
    case 'ENOTDIR':
      return `${pdfName} was not found.`
    case 'EACCES':
    case 'EPERM':
      return `${scriptName} can't be read: make it, and its folder, readable by you, then prepare again.`
    default:
      return `${scriptName} can't be read (${code === 'error' ? 'an unexpected error' : code}).`
  }
}

export interface CheckInput {
  file: string
  decksDir: string
  retentionDays: number
  cwd: string
  now?: Date
}

/** npm run slides -- check: the script's errors and warnings, against its deck; the estimate; a fresh contact sheet. */
export function runCheck(input: CheckInput): Outcome {
  const store = new DeckStore(input.decksDir)
  let text: string
  try {
    text = readScript(input.file)
  } catch (err) {
    return { lines: [(err as Error).message], code: 1 }
  }
  const parsed = parseScript(text)
  let manifest: Manifest | null = null
  let own = false
  const deckErrors: Problem[] = []
  const id = parsed.script?.deck ?? ''
  if (parsed.script && DECK_ID.test(id)) {
    try {
      manifest = store.load(id, { images: 'all' }).manifest
      // Only the script prepare wrote for this deck is compared with its slides' figures, or changes the deck: any
      // other file could name the deck's id (list prints it) to test guesses about what is on a slide.
      const key = manifest.script ? scriptKey(input.decksDir) : null
      own = Boolean(key && manifest.script === scriptMark(key, input.file))
    } catch (err) {
      if (!(err instanceof DeckError)) throw err
      deckErrors.push({
        message: err.code === 'missing'
          ? `the prepared deck ${id} is gone (decks are deleted ${input.retentionDays} days after they were last used, or by slides delete). Run npm run slides -- prepare <your PDF> again: your script is kept, and updated for the new deck`
          : err.message.replace(/\.$/, ''),
      })
    }
  }
  // A script whose structure is unclear (two sections for a page, say) is not compared with the slides either.
  const compare = own && !unclear(parsed)
  const checked = checkScript({ ...parsed, errors: [...deckErrors, ...parsed.errors] }, manifest, { figures: compare })
  // In the file's order: by line, then the ones about a page with no line, then the whole script's.
  const order = (p: Problem) => p.line ?? (p.page ? 1e6 + p.page : 2e6)
  checked.errors.sort((a, b) => order(a) - order(b))
  checked.warnings.sort((a, b) => order(a) - order(b))
  const name = path.basename(input.file)
  const lines: string[] = []
  if (checked.script) lines.push(`${name}${manifest ? ` (deck ${manifest.id})` : ''}: ${summary(checked)}.`)
  if (checked.errors.length) {
    lines.push(`${plural(checked.errors.length, 'error')}: the script can't be used until ${checked.errors.length === 1 ? 'it is' : 'they are'} fixed.`)
    for (const e of checked.errors) lines.push(`  ${where(e)}${e.message}.`)
  }
  // The script's own warnings in the file's order, then the deck's, one line per kind.
  const warned = [
    ...checked.warnings.filter(w => !w.fromDeck).map(w => `${where(w)}${w.message}`),
    ...deckWarningLines(checked.warnings.filter(w => w.fromDeck && w.page).map(w => ({ page: w.page as number, message: w.message }))),
  ]
  if (warned.length) {
    lines.push(`${plural(warned.length, 'warning')}:`)
    for (const w of warned) lines.push(`  ${w}.`)
  }
  if (!checked.errors.length) lines.push('No errors. The estimate comes from the script\'s length: the real timing is known only in a meeting.')
  if (manifest && !own) {
    lines.push(`This is not the script prepare wrote for ${manifest.id}, so its figures were not compared with the slides, and the deck and its contact sheet were left as they were. Prepare the deck again from the PDF beside this script.`)
  } else if (manifest) {
    if (compare) refreshSheet(store, manifest, checked, name)
    store.touch(manifest.id, input.now)
    lines.push(`Contact sheet: ${shown(path.join(store.folder(manifest.id), 'sheet.html'), input.cwd)}`)
  }
  return { lines, code: checked.errors.length ? 1 : 0 }
}

/** npm run slides -- list: each deck, its slides, and when it was last used and will be deleted. */
export function runList(input: { decksDir: string; retentionDays: number; cwd: string }): Outcome {
  const store = new DeckStore(input.decksDir)
  const ids = store.ids()
  const lines: string[] = []
  for (const id of ids) {
    try {
      const deck = store.load(id)
      const used = deck.usedAt
      const goes = new Date(used.getTime() + input.retentionDays * 86_400_000)
      lines.push(`${id}  "${deck.manifest.label}": ${plural(deck.manifest.slides.length, 'slide')}, prepared ${deck.manifest.created.slice(0, 10)}, last used ${used.toISOString().slice(0, 10)} (deleted after ${goes.toISOString().slice(0, 10)} unless used)`)
    } catch (err) {
      lines.push(`${id}  ${err instanceof DeckError ? err.message.replace(/^The prepared deck \S+ /, '') : "can't be used: it could not be read."}`)
    }
  }
  const unfinished = fs.existsSync(input.decksDir) ? fs.readdirSync(input.decksDir).filter(n => n.startsWith(TEMP_PREFIX)).length : 0
  if (!ids.length) lines.push(`No prepared decks in ${shown(input.decksDir, input.cwd)}.`)
  if (unfinished) {
    lines.push(`${plural(unfinished, 'unfinished prepare')} (${TEMP_PREFIX}*, with a copy of its PDF): the next prepare or delete --all removes ${unfinished === 1 ? 'it' : 'them'} once ${unfinished === 1 ? 'it is' : 'they are'} ${UNFINISHED_MAX_AGE_MS / 60_000} minutes old, and the voice service once an hour old.`)
  }
  return { lines, code: 0 }
}

/** npm run slides -- delete: decks by id, or all of them. */
export function runDelete(input: { decksDir: string; ids: readonly string[]; all: boolean }): Outcome {
  const store = new DeckStore(input.decksDir)
  const ids = input.all ? store.ids() : input.ids
  const lines: string[] = []
  let code = 0
  for (const id of ids) {
    if (!DECK_ID.test(id)) {
      lines.push(`"${id.slice(0, 40)}" is not a deck id (npm run slides -- list shows them).`)
      code = 1
    } else if (store.delete(id)) lines.push(`Deleted ${id}.`)
    else {
      lines.push(`There is no deck ${id}.`)
      code = 1
    }
  }
  if (input.all) {
    // A prepare that was killed left a copy of its PDF: --all removes that too, but never one that may be running.
    const swept = sweepUnfinished(input.decksDir, UNFINISHED_MAX_AGE_MS)
    if (swept.removed) lines.push(`Deleted ${plural(swept.removed, 'unfinished prepare')}, with the copy of its PDF.`)
    if (swept.left) {
      lines.push(`${plural(swept.left, 'unfinished prepare')} from the last ${UNFINISHED_MAX_AGE_MS / 60_000} minutes ${swept.left === 1 ? 'was' : 'were'} left: if no prepare is running, run delete --all again later.`)
    }
    if (swept.failed) {
      lines.push(`Could not delete ${plural(swept.failed, 'unfinished prepare')} (${swept.code}).`)
      code = 1
    }
    if (!ids.length && !swept.removed && !swept.left && !swept.failed) lines.push('There were no decks to delete.')
  }
  return { lines, code }
}
