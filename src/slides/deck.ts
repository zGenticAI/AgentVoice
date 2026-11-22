// Prepared decks on disk (data/decks/<id>/: manifest.json, NNN.webp, sheet.html), and the one strict loader every
// reader uses: npm run slides, and later the voice service and the channel. A deck that fails it is never used, so
// prepare checks its own output with it before it keeps a deck. No path is ever built from anything but a valid id.
// Decks are deleted DECK_RETENTION_DAYS after they were last used (30 unless set), by the service's hourly sweep.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { refuseInsidePackage } from '../home.ts'
import {
  DECK_ID, MAX_DECK_BYTES, MAX_IMAGE_BYTES, MAX_MANIFEST_BYTES, MAX_PAGES, type Manifest, SLIDE_HEIGHT, SLIDE_WIDTH, manifestProblem,
} from './manifest.ts'

/** The decks folder in a data folder. */
export const decksDir = (dataDir: string) => path.join(dataDir, 'decks')
export const MANIFEST = 'manifest.json'
export const SHEET = 'sheet.html'
/**
 * An unfinished prepare, which holds a copy of the PDF: removed when it ends; by the next prepare and by delete --all
 * once it is UNFINISHED_MAX_AGE_MS old, should prepare have been killed; and by the service's sweep after an hour.
 */
export const TEMP_PREFIX = '.tmp-'
const TEMP_MAX_AGE_MS = 3_600_000
/**
 * A prepare running now is never this old: its folder's time is set as it starts and as it ends, and it is stopped
 * after 3 minutes (PREPARE_TIMEOUT_MS). The margin is for a slow disk.
 */
export const UNFINISHED_MAX_AGE_MS = 10 * 60_000

/** A deck the loader refused, and why, in words for the owner. Never a path. */
export class DeckError extends Error {
  constructor(
    message: string,
    readonly code: 'bad-id' | 'missing' | 'invalid',
  ) {
    super(message)
    this.name = 'DeckError'
  }
}

export interface LoadedDeck {
  manifest: Manifest
  /** The deck's folder. */
  dir: string
  /** The images read, by page number: those asked for, all checked against their hashes. */
  images: Map<number, Buffer>
  /** When it was last used: its manifest's modification time. */
  usedAt: Date
}

/** Creates the decks folder if needed, readable by this user only. Installed from npm, never inside the package's folder. */
export function prepareDecksDir(dir: string): void {
  refuseInsidePackage(dir, 'ALEX_DATA_DIR')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700) // mode applies only when the folder is created
}

/** Width and height from a WebP's first chunk (VP8, VP8L or VP8X), or null when it isn't a WebP. */
export function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = bytes.toString('latin1', 12, 16)
  if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return null
}

/** Why an image is not a slide prepare made, or ''. */
export function imageProblem(bytes: Buffer): string {
  if (bytes.length > MAX_IMAGE_BYTES) return `is over ${MAX_IMAGE_BYTES} bytes`
  const size = webpSize(bytes)
  if (!size) return 'is not a WebP image'
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return 'is not a whole WebP image'
  if (size.width !== SLIDE_WIDTH || size.height !== SLIDE_HEIGHT) return `is ${size.width}x${size.height}, not ${SLIDE_WIDTH}x${SLIDE_HEIGHT}`
  return ''
}

export const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex')

/** The key for scripts' marks, in the decks folder: made by the first prepare, and never in a deck. */
export const SCRIPT_KEY = '.script-key'

/**
 * The key a deck's script mark is made with, or null when there is none yet (and `create` is not set). Keyed, so a
 * manifest alone says nothing of where your files are.
 */
export function scriptKey(dir: string, create = false): Buffer | null {
  const file = path.join(dir, SCRIPT_KEY)
  if (create && !fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
    } catch (err) {
      // Another prepare made it first.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size !== 64 || !private_(stat)) return null
    const key = fs.readFileSync(fd, 'utf8')
    return /^[0-9a-f]{64}$/.test(key) ? Buffer.from(key, 'hex') : null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Which script a deck belongs to: a hash, keyed, of the script's real folder and its name. Check uses it to tell the
 * deck's own script from any other file that names the deck.
 */
export function scriptMark(key: Buffer, scriptFile: string): string {
  let where: string
  try {
    where = path.join(fs.realpathSync(path.dirname(scriptFile)), path.basename(scriptFile))
  } catch {
    where = path.resolve(scriptFile)
  }
  return crypto.createHmac('sha256', key).update(where).digest('hex')
}

const uid = () => process.getuid?.()

/** Whether an entry is this user's, with no group or other access. */
function private_(stat: fs.Stats): boolean {
  const me = uid()
  return (me === undefined || stat.uid === me) && (stat.mode & 0o077) === 0
}

/** A file's bytes, read without following a symbolic link, and refused past `max`. */
function readFile(file: string, max: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > max) throw new DeckError('a file in it is too large or not a file', 'invalid')
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The prepared decks in one folder, resolved once: the folder may be reached through a symbolic link (macOS's /var is
 * one), but nothing inside it may be one.
 */
export class DeckStore {
  private real: string | null = null

  constructor(readonly dir: string) {}

  /** The folder's real path, resolved the first time it exists. */
  private realDir(): string {
    this.real ??= fs.realpathSync(this.dir)
    return this.real
  }

  /** The folder of a deck, after checking the id: the only way a deck's path is ever made. */
  folder(id: string): string {
    if (typeof id !== 'string' || !DECK_ID.test(id)) throw new DeckError(`"${String(id).slice(0, 40)}" is not a deck id`, 'bad-id')
    return path.join(this.dir, id)
  }

  /**
   * Loads and checks a deck strictly: the id; no symbolic link inside the decks folder; every entry a regular file or
   * folder of this user's with no group or other access; only the files the manifest names, and sheet.html; the
   * manifest's schema; each image at most 2 MiB, a 1280x720 WebP, with the manifest's hash; at most 100 slides and
   * 40 MiB in all. `images` says which slides to read into memory (by page number), or 'all'; the others are checked
   * by size only.
   */
  load(id: string, opts: { images?: 'all' | readonly number[] } = {}): LoadedDeck {
    const folder = this.folder(id)
    if (!fs.existsSync(this.dir)) throw new DeckError(`The prepared deck ${id} is gone.`, 'missing')
    let real: string
    try {
      real = fs.realpathSync(folder)
    } catch {
      throw new DeckError(`The prepared deck ${id} is gone.`, 'missing')
    }
    if (real !== path.join(this.realDir(), id)) throw new DeckError(`The prepared deck ${id} is a symbolic link, so it isn't used.`, 'invalid')
    const invalid = (why: string) => new DeckError(`The prepared deck ${id} can't be used: ${why}.`, 'invalid')
    const folderStat = fs.lstatSync(folder)
    if (!folderStat.isDirectory() || !private_(folderStat)) throw invalid('its folder must be yours and readable by you only (0700)')

    const names = fs.readdirSync(folder)
    for (const name of names) {
      const stat = fs.lstatSync(path.join(folder, name))
      if (!stat.isFile()) throw invalid(`${name} is not a plain file`)
      if (!private_(stat)) throw invalid(`${name} must be yours and readable by you only (0600)`)
    }
    if (!names.includes(MANIFEST)) throw invalid('it has no manifest')
    let manifest: unknown
    try {
      manifest = JSON.parse(readFile(path.join(folder, MANIFEST), MAX_MANIFEST_BYTES).toString('utf8'))
    } catch (err) {
      throw err instanceof DeckError ? invalid('its manifest is too large') : invalid('its manifest is not valid JSON')
    }
    const problem = manifestProblem(manifest, id)
    if (problem) throw invalid(problem)
    const deck = manifest as Manifest
    deck.script ??= null
    const files = new Set(deck.slides.map(s => s.file))
    const extra = names.find(name => name !== MANIFEST && name !== SHEET && !files.has(name))
    if (extra) throw invalid(`${extra} is not one of its files`)
    if (deck.slides.length > MAX_PAGES) throw invalid(`it has more than ${MAX_PAGES} slides`)
    let total = 0
    const wanted = opts.images === 'all' ? null : new Set(opts.images ?? [])
    const images = new Map<number, Buffer>()
    for (const slide of deck.slides) {
      if (!names.includes(slide.file)) throw invalid(`${slide.file} is missing`)
      if (sha256(slide.text) !== slide.textHash) throw invalid(`slide ${slide.n}'s text does not match its hash`)
      total += slide.bytes
      if (total > MAX_DECK_BYTES) throw invalid(`its images come to more than ${MAX_DECK_BYTES} bytes`)
      const file = path.join(folder, slide.file)
      if (wanted && !wanted.has(slide.n)) {
        if (fs.lstatSync(file).size !== slide.bytes) throw invalid(`${slide.file} is not the size its manifest says`)
        continue
      }
      let bytes: Buffer
      try {
        bytes = readFile(file, MAX_IMAGE_BYTES)
      } catch {
        throw invalid(`${slide.file} is over ${MAX_IMAGE_BYTES} bytes`)
      }
      if (bytes.length !== slide.bytes) throw invalid(`${slide.file} is not the size its manifest says`)
      const bad = imageProblem(bytes)
      if (bad) throw invalid(`${slide.file} ${bad}`)
      if (sha256(bytes) !== slide.sha256) throw invalid(`${slide.file} does not match its hash`)
      images.set(slide.n, bytes)
    }
    return { manifest: deck, dir: folder, images, usedAt: fs.statSync(path.join(folder, MANIFEST)).mtime }
  }

  /** Marks a deck as used now (its manifest's time, a metadata-only write), so the retention sweep keeps it. */
  touch(id: string, now = new Date()): void {
    fs.utimesSync(path.join(this.folder(id), MANIFEST), now, now)
  }

  /** The ids of the decks here, valid or not, sorted. Unfinished prepares and anything else are left out. */
  ids(): string[] {
    if (!fs.existsSync(this.dir)) return []
    return fs.readdirSync(this.dir).filter(name => DECK_ID.test(name)).sort()
  }

  /** Deletes a deck's folder, or only the link if it is a symbolic link. Whether there was one. */
  delete(id: string): boolean {
    const folder = this.folder(id)
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false })
    if (!stat) return false
    if (stat.isDirectory()) fs.rmSync(folder, { recursive: true, force: true })
    else fs.rmSync(folder, { force: true })
    return true
  }
}

/** What a sweep of the decks folder did, as sweepOldRecords says it for transcripts: counts and a code only. */
export interface DecksSwept {
  /** Decks deleted. */
  removed: number
  /** Unfinished prepares deleted. */
  unfinished: number
  failed: number
  code: string
}

/** An error's code for a count, never its message (which names the path). */
const codeOf = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error'
}

/** What a sweep of unfinished prepares did: counts and a code only. */
export interface UnfinishedSwept {
  removed: number
  /** Ones newer than the age given: a prepare may be running. */
  left: number
  failed: number
  code: string
}

/**
 * Deletes the unfinished prepares (TEMP_PREFIX folders, each with a copy of its PDF) older than `olderThanMs`, by the
 * folder's own time. Never throws.
 */
export function sweepUnfinished(dir: string, olderThanMs: number, now = Date.now()): UnfinishedSwept {
  const swept: UnfinishedSwept = { removed: 0, left: 0, failed: 0, code: '' }
  let names: string[]
  try {
    if (!fs.existsSync(dir)) return swept
    names = fs.readdirSync(dir).filter(name => name.startsWith(TEMP_PREFIX))
  } catch (err) {
    swept.failed++
    swept.code = codeOf(err)
    return swept
  }
  for (const name of names) {
    const folder = path.join(dir, name)
    try {
      const stat = fs.lstatSync(folder, { throwIfNoEntry: false })
      if (!stat) continue
      if (stat.mtimeMs >= now - olderThanMs) {
        swept.left++
        continue
      }
      fs.rmSync(folder, { recursive: stat.isDirectory(), force: true })
      swept.removed++
    } catch (err) {
      swept.failed++
      swept.code ||= codeOf(err)
    }
  }
  return swept
}

/**
 * Deletes the decks not used for `days` days (by their manifest's time, or the folder's when the manifest can't be
 * read), and unfinished prepares over an hour old (a prepare is killed after 3 minutes). Never throws.
 */
export function sweepOldDecks(dir: string, days: number, now = Date.now()): DecksSwept {
  const swept: DecksSwept = { removed: 0, unfinished: 0, failed: 0, code: '' }
  const failed = (err: unknown) => {
    swept.failed++
    swept.code ||= codeOf(err)
  }
  let names: string[]
  try {
    if (!fs.existsSync(dir)) return swept
    names = fs.readdirSync(dir)
  } catch (err) {
    failed(err)
    return swept
  }
  const unfinished = sweepUnfinished(dir, TEMP_MAX_AGE_MS, now)
  swept.unfinished = unfinished.removed
  swept.failed = unfinished.failed
  swept.code = unfinished.code
  const cutoff = now - days * 86_400_000
  for (const name of names) {
    const folder = path.join(dir, name)
    try {
      if (!DECK_ID.test(name)) continue
      const stat = fs.lstatSync(folder, { throwIfNoEntry: false })
      if (!stat) continue
      const manifest = stat.isDirectory() ? fs.lstatSync(path.join(folder, MANIFEST), { throwIfNoEntry: false }) : undefined
      if ((manifest ?? stat).mtimeMs < cutoff) {
        fs.rmSync(folder, { recursive: stat.isDirectory(), force: true })
        swept.removed++
      }
    } catch (err) {
      failed(err)
    }
  }
  return swept
}
