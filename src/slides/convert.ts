// npm run slides -- prepare: the parent's side of turning a PDF into a prepared deck. It checks the file (a regular
// file, at most 100 MiB, a PDF by its first bytes), copies it into a temporary folder in data/decks, and has the
// converter child (render-child.ts) render it there. The child gets an environment made from scratch, PATH, HOME and
// its own TMPDIR, so none of the keys this process loaded from .env are in it; its stdin is closed, its stdout is
// JSON lines, and its stderr is kept from the terminal. Its whole process group is killed after 3 minutes, or when
// this process is stopped by a signal. Should this process die without a word (SIGKILL, a crash), the child still
// stops: the kernel ends it on a CPU-time limit (this process's own, when that is lower), and it ends itself once its
// parent is gone or its time is up. The result is checked with the same loader the service uses, then moved into place.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS_MISSING, WORDS } from '../commands.ts'
import { insidePackage } from '../home.ts'
import {
  DeckError, DeckStore, MANIFEST, TEMP_PREFIX, UNFINISHED_MAX_AGE_MS, prepareDecksDir, scriptKey, scriptMark, sha256, sweepUnfinished,
} from './deck.ts'
import { type Kind, folderKind, linkKind, refusal, sniff } from './detect.ts'
import {
  DECK_ID, MAX_DECK_BYTES, MAX_INPUT_BYTES, MAX_LABEL, MAX_PAGES, MAX_PAGE_TEXT, MAX_TITLE, type Manifest, type ManifestSlide, WARNINGS,
  type WarningCode, slideFile,
} from './manifest.ts'
import { cleanText, oneLine } from './page-text.ts'
import type { ChildMessage, Job } from './child-protocol.ts'

/** Why prepare refused, in words for the owner: never a path beyond the file's own name. */
export class PrepareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrepareError'
  }
}

export { CANVAS_MISSING }
export const PASSWORD_REFUSAL = 'This PDF is password-protected: export it again without a password.'
/** The hard limit on one prepare: the child's whole process group is killed then. */
export const PREPARE_TIMEOUT_MS = 180_000
const CHILD = fileURLToPath(new URL('./render-child.ts', import.meta.url))
// What the parent reads of the child's output, at most: its lines carry page text (4,000 characters a page).
const MAX_STDOUT = 32 * 1024 * 1024
const MAX_LINE = 1024 * 1024

/** The child's environment: nothing from this process's but PATH and HOME, so no API key is in it. */
export function childEnv(env: NodeJS.ProcessEnv, tmp: string): NodeJS.ProcessEnv {
  return { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? tmp, TMPDIR: tmp }
}

/** The id's slug: the label ASCII-folded, a-z, 0-9 and hyphens, at most 24 characters. */
export function slugOf(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return slug || 'deck'
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** A new id for a deck: the slug and 6 random base32 letters, not taken in the folder. */
export function newDeckId(slug: string, taken: (id: string) => boolean): string {
  for (;;) {
    const id = `${slug}-${[...crypto.randomBytes(6)].map(b => BASE32[b & 31]).join('')}`
    if (DECK_ID.test(id) && !taken(id)) return id
  }
}

/**
 * The PDF's bytes, or a PrepareError that says what the file is and how to make a PDF of it. Detection is by the
 * bytes, never the name; a link, a folder, a symbolic link or a file over 100 MiB is refused before it is read.
 */
export function readInput(file: string): Buffer {
  const name = path.basename(file)
  const link = linkKind(file)
  if (link) throw new PrepareError(refusal(link as Exclude<Kind, 'pdf'>, file.length > 80 ? `${file.slice(0, 77)}...` : file))
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) throw new PrepareError(`${name} was not found.`)
  if (stat.isSymbolicLink()) throw new PrepareError(`${name} is a symbolic link: give the PDF itself.`)
  if (stat.isDirectory()) throw new PrepareError(refusal(folderKind(fs.readdirSync(file)) as Exclude<Kind, 'pdf'>, name))
  if (!stat.isFile()) throw new PrepareError(`${name} is not a file.`)
  if (stat.size > MAX_INPUT_BYTES) throw new PrepareError(`${name} is over 100 MiB. Export it again with smaller images, or split it.`)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size > MAX_INPUT_BYTES) throw new PrepareError(`${name} is over 100 MiB, or not a file.`)
    bytes = fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  if (!bytes.length) throw new PrepareError(`${name} is empty.`)
  const kind = sniff(bytes)
  if (kind !== 'pdf') throw new PrepareError(refusal(kind, name))
  return bytes
}

export interface PrepareOptions {
  /** The PDF. */
  input: string
  /** data/decks. */
  decksDir: string
  /** Page numbers never to render: they leave nothing behind but a count. */
  exclude?: readonly number[]
  /** The deck's label, and its id's slug: the file's name unless given. */
  label?: string
  /** The script this deck is for: only its keyed mark is kept (Manifest.script). */
  scriptFile?: string
  now?: Date
  /** Tests only: another child, and a shorter limit. */
  childScript?: string
  timeoutMs?: number
}

export interface Prepared {
  manifest: Manifest
  /** The deck's folder. */
  dir: string
  /** Sticky notes by page (Marp's speaker notes), for the skeleton script only: never kept in the deck. */
  notes: Map<number, string>
  /** pdf.js warnings that were not about a skipped or undecodable image: only counted. */
  otherWarnings: number
}

/** What the child said, read strictly: anything else ends the prepare. */
function parseMessage(line: string): ChildMessage | null {
  let m: unknown
  try {
    m = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof m !== 'object' || m === null) return null
  const msg = m as Record<string, unknown>
  const whole = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e6
  switch (msg.type) {
    case 'open':
      return whole(msg.pages) ? (msg as ChildMessage) : null
    case 'done':
      return whole(msg.other) ? (msg as ChildMessage) : null
    case 'refused':
      return typeof msg.reason === 'string' ? (msg as ChildMessage) : null
    case 'page':
      if (!whole(msg.n) || !whole(msg.other) || typeof msg.title !== 'string' || typeof msg.text !== 'string' || typeof msg.notes !== 'string') return null
      if (msg.pageLabel !== null && typeof msg.pageLabel !== 'string') return null
      if (!Array.isArray(msg.warnings) || !msg.warnings.every(w => typeof w === 'string' && Object.hasOwn(WARNINGS, w))) return null
      return msg as ChildMessage
    default:
      return null
  }
}

/** An error's class name from the child, never anything else it might say. */
const safeName = (name: unknown) => (typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error')

/** The owner's words for a deck whose images come to more than the loader takes (MAX_DECK_BYTES in all). */
export function deckTooBig(name: string, page: number): string {
  return `${name}'s slide images come to more than ${MAX_DECK_BYTES / 1024 / 1024} MiB (it stopped at page ${page}). Export it again with lighter images, split it, or leave some pages out with --exclude.`
}

/** The page at which slides' images first come to more than MAX_DECK_BYTES, or null. */
export function pageOverDeckLimit(slides: readonly { n: number; bytes: number }[]): number | null {
  let total = 0
  for (const slide of slides) {
    total += slide.bytes
    if (total > MAX_DECK_BYTES) return slide.n
  }
  return null
}

/** The owner's words for why the child stopped. */
function refusedMessage(msg: Extract<ChildMessage, { type: 'refused' }>, name: string): string {
  const page = msg.page ?? 0
  switch (msg.reason) {
    case 'no-canvas':
      return CANVAS_MISSING
    case 'password':
      return PASSWORD_REFUSAL
    case 'too-many-pages':
      return `${name} has ${msg.pages} pages: at most ${MAX_PAGES} can be prepared. Split it, or export only the slides you need.`
    case 'exclude-range':
      return `--exclude ${page}: ${name} has only ${msg.pages} page${msg.pages === 1 ? '' : 's'}.`
    case 'all-excluded':
      return '--exclude leaves no pages to prepare.'
    case 'page-failed':
      return `Page ${page} could not be drawn (${safeName(msg.name)}). Export the PDF again, or leave that page out with --exclude ${page}.`
    case 'page-slow':
      return `Page ${page} took too long to render. Export the PDF again, or leave that page out with --exclude ${page}.`
    case 'page-too-big':
      return `Page ${page} can't be saved under 2 MiB, even at a lower quality. Simplify it, or leave it out with --exclude ${page}.`
    case 'memory':
      return `${name} needs too much memory to render (it stopped after page ${page}). Export it again with smaller images, or split it.`
    case 'deck-too-big':
      return deckTooBig(name, page)
    default:
      return `${name} could not be read as a PDF (${safeName(msg.name)}). Export it again, or save it as a PDF from another viewer.`
  }
}

// The signals that stop this process in order, as they stop the service (server.ts), and SIGQUIT. Closing the terminal
// sends SIGHUP to this process but not to the child, which is in a session of its own: without a handler this process
// would die and leave the child running with no limit, and the copy of the PDF behind.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const

/**
 * The command that starts the child: node, under a CPU-time limit the kernel enforces even while the child is stuck
 * in one long step, and after this process is gone. Generous, as it counts every thread's time. A lower limit this
 * process has already (a shell profile, systemd's LimitCPU) can't be raised, and bounds the child all the same, so a
 * refused ulimit never stops it. With no /bin/sh or /usr/bin/env (a minimal container image) node is started directly,
 * bounded by the kill and its own timers. `exists` is for the tests.
 */
export function childCommand(script: string, job: Job, timeoutMs: number, exists: (file: string) => boolean = fs.existsSync): [string, string[]] {
  const node = [process.execPath, '--max-old-space-size=1536', '--import', import.meta.resolve('tsx'), script, JSON.stringify(job)]
  if (process.platform === 'win32' || !exists('/bin/sh') || !exists('/usr/bin/env')) return [node[0], node.slice(1)]
  const cpuSeconds = Math.max(1, Math.ceil((2 * timeoutMs) / 1000))
  // env -i: the shell adds variables of its own (PWD), and the child gets childEnv's three only.
  return ['/bin/sh', ['-c', `ulimit -t ${cpuSeconds} 2>/dev/null; exec /usr/bin/env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" "$0" "$@"`, ...node]]
}

/** An error's code, never its message (which can name a path). */
const codeOf = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error'
}

/** Runs the child on the job, and gives its messages; kills its process group on the time limit, or when this process stops. */
function runChild(job: Job, root: string, tmp: string, script: string, timeoutMs: number): Promise<{ messages: ChildMessage[]; timedOut: boolean; code: number | null; signal: string | null; bad: boolean; notStarted: string }> {
  return new Promise(resolve => {
    const [command, args] = childCommand(script, job, timeoutMs)
    const child = spawn(command, args, {
      cwd: root,
      env: childEnv(process.env, tmp),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const messages: ChildMessage[] = []
    let timedOut = false
    let bad = false
    // Why it could not be started at all, as an error's code: nothing of the PDF was read then.
    let notStarted = ''
    let buffered = ''
    let total = 0
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutMs)
    const onSignal = (signal: NodeJS.Signals) => {
      killGroup()
      fs.rmSync(root, { recursive: true, force: true })
      process.exit(128 + (os.constants.signals[signal] ?? 15))
    }
    for (const s of STOP_SIGNALS) process.once(s, onSignal)
    process.once('exit', killGroup)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      total += chunk.length
      buffered += chunk
      if (total > MAX_STDOUT || buffered.length > MAX_LINE * 2) {
        bad = true
        killGroup()
        return
      }
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        const msg = line.length <= MAX_LINE ? parseMessage(line) : null
        if (msg) messages.push(msg)
        else {
          bad = true
          killGroup()
        }
      }
    })
    // Kept from the terminal: it could quote the file. Read and dropped, so the child never blocks on a full pipe.
    child.stderr.on('data', () => {})
    let finished = false
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const s of STOP_SIGNALS) process.removeListener(s, onSignal)
      process.removeListener('exit', killGroup)
      resolve({ messages, timedOut, code, signal, bad, notStarted })
    }
    child.on('close', finish)
    child.on('error', err => {
      bad = true
      if (child.pid === undefined) notStarted = codeOf(err)
      finish(null, null)
    })
  })
}

/** Renders a PDF into a new prepared deck in decksDir, checked by the loader, or throws a PrepareError. */
export async function prepareDeck(opts: PrepareOptions): Promise<Prepared> {
  const name = path.basename(opts.input)
  const exclude = [...new Set(opts.exclude ?? [])].sort((a, b) => a - b)
  if (exclude.some(n => !Number.isInteger(n) || n < 1 || n > MAX_PAGES)) throw new PrepareError(`--exclude takes page numbers from 1 to ${MAX_PAGES}.`)
  const bytes = readInput(opts.input)
  const label = oneLine(opts.label ?? name.replace(/\.pdf$/i, ''), MAX_LABEL) || 'deck'
  const store = new DeckStore(opts.decksDir)
  // Installed from npm, never into the package's folder, which npm replaces on every upgrade (prepareDecksDir refuses
  // it too; this says it without the paths).
  if (insidePackage(opts.decksDir)) {
    throw new PrepareError(
      'The data folder is inside the installed package, which npm replaces on every upgrade: ALEX_DATA_DIR must point ' +
        'outside it, into your AgentVoice folder for example.',
    )
  }
  prepareDecksDir(opts.decksDir)
  // A prepare that was killed (SIGKILL, a crash) left its folder, with a copy of its PDF: gone once it can't be running.
  sweepUnfinished(opts.decksDir, UNFINISHED_MAX_AGE_MS)

  const root = fs.mkdtempSync(path.join(opts.decksDir, TEMP_PREFIX))
  try {
    fs.chmodSync(root, 0o700)
    const out = path.join(root, 'deck')
    const tmp = path.join(root, 'tmp')
    fs.mkdirSync(out, { mode: 0o700 })
    fs.mkdirSync(tmp, { mode: 0o700 })
    const input = path.join(root, 'input.pdf')
    fs.writeFileSync(input, bytes, { mode: 0o600, flag: 'wx' })

    const timeoutMs = opts.timeoutMs ?? PREPARE_TIMEOUT_MS
    const run = await runChild({ input, out, exclude, timeoutMs }, root, tmp, opts.childScript ?? CHILD, timeoutMs)
    if (run.timedOut) throw new PrepareError(`${name} took more than ${Math.round((opts.timeoutMs ?? PREPARE_TIMEOUT_MS) / 1000)} s to render, so it was stopped. Export it again with smaller images, or leave the slowest pages out with --exclude.`)
    const refused = run.messages.find(m => m.type === 'refused')
    if (refused?.type === 'refused') throw new PrepareError(refusedMessage(refused, name))
    const open = run.messages.find(m => m.type === 'open')
    const done = run.messages.find(m => m.type === 'done')
    // A child that could not start, or ended without a word and without a signal, never got to the PDF: the cause is
    // this computer, so the owner is not sent to export the PDF again.
    if (run.notStarted) throw new PrepareError(`The converter could not be started (${run.notStarted}), so ${name} was not read. Check that ${WORDS.reinstall} finished, then prepare again.`)
    if (!run.messages.length && run.signal === null && run.code !== 0) {
      throw new PrepareError(`The converter stopped before it opened ${name} (exit ${run.code}). Check that ${WORDS.reinstall} finished, then prepare again.`)
    }
    if (run.bad || run.code !== 0 || open?.type !== 'open' || done?.type !== 'done') {
      throw new PrepareError(`The converter stopped unexpectedly (${run.signal ?? `exit ${run.code}`}). Export the PDF again, or save it as a PDF from another viewer.`)
    }
    const pages = run.messages.filter(m => m.type === 'page')
    const expected = Array.from({ length: open.pages }, (_, i) => i + 1).filter(n => !exclude.includes(n))
    if (pages.length !== expected.length || pages.some((p, i) => p.n !== expected[i])) {
      throw new PrepareError('The converter did not render every page. Export the PDF again, or save it as a PDF from another viewer.')
    }

    const id = newDeckId(slugOf(label), candidate => fs.existsSync(path.join(opts.decksDir, candidate)))
    const notes = new Map<number, string>()
    const slides: ManifestSlide[] = pages.map(page => {
      const file = slideFile(page.n)
      const image = fs.readFileSync(path.join(out, file))
      const text = cleanText(page.text, MAX_PAGE_TEXT).text
      const note = cleanText(page.notes, MAX_PAGE_TEXT).text
      if (note) notes.set(page.n, note)
      return {
        n: page.n,
        title: oneLine(page.title, MAX_TITLE),
        pageLabel: page.pageLabel ? oneLine(page.pageLabel, MAX_TITLE) || null : null,
        text,
        file,
        bytes: image.length,
        sha256: sha256(image),
        textHash: sha256(text),
        warnings: [...new Set(page.warnings as WarningCode[])],
      }
    })
    // The child stops at the limit itself; this is for one that did not. The loader below would refuse it in words
    // that name a deck the owner never saw.
    const over = pageOverDeckLimit(slides)
    if (over !== null) throw new PrepareError(deckTooBig(name, over))
    const created = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const key = opts.scriptFile ? scriptKey(opts.decksDir, true) : null
    const script = key && opts.scriptFile ? scriptMark(key, opts.scriptFile) : null
    const manifest: Manifest = { format: 1, id, label, created, pages: open.pages, excluded: exclude.length, script, slides }
    fs.writeFileSync(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600, flag: 'wx' })
    const dir = path.join(opts.decksDir, id)
    fs.renameSync(out, dir)
    try {
      store.load(id, { images: 'all' })
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw new PrepareError(`The rendered deck failed its check, so it was not kept: ${err instanceof DeckError ? err.message : 'an unexpected error'}`)
    }
    return { manifest, dir, notes, otherWarnings: done.other + pages.reduce((sum, p) => sum + p.other, 0) }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
