// What kind of file someone gave prepare, by its first bytes, never by its name: a .pdf that is really a PowerPoint
// file gets the PowerPoint answer. Only a PDF is prepared; everything else is refused with how to export a PDF from
// it. Nothing here parses a document: a ZIP's file names are read from its directory, and PowerPoint's content types
// file is inflated (capped) only to see whether it declares macros.
import zlib from 'node:zlib'

export type Kind = 'pdf' | 'pptx' | 'pptm' | 'ppt' | 'odp' | 'key' | 'google' | 'link' | 'web' | 'images' | 'folder' | 'other'

/** For each kind that is refused: what it is, and how to make a PDF of it (docs/presenting.md has the same steps). */
export const REFUSALS: Record<Exclude<Kind, 'pdf'>, { what: string; fix: string }> = {
  pptx: { what: 'a PowerPoint file', fix: 'Export it as PDF: File > Export > PDF (or Save As > PDF), with hidden slides included.' },
  pptm: { what: 'a PowerPoint file with macros', fix: 'This file contains macros. Save it as a PDF and use that.' },
  ppt: { what: 'an old binary Office file', fix: 'Save it as .pptx or export a PDF.' },
  odp: { what: 'an OpenDocument file', fix: 'LibreOffice Impress: File > Export as PDF.' },
  key: { what: 'a Keynote file', fix: "Keynote: File > Export To > PDF (tick 'Include skipped slides')." },
  google: { what: 'a Google Slides link', fix: 'Google Slides: File > Download > PDF document.' },
  web: { what: 'a Markdown or web page deck', fix: 'Export it to PDF (`marp --pdf --pdf-notes`, `slidev export`, decktape).' },
  link: { what: 'a link, not a file', fix: 'Download the deck as a PDF, and give that file.' },
  images: { what: 'an image', fix: 'Put the images into one PDF.' },
  folder: { what: 'a folder', fix: 'Put the images into one PDF.' },
  other: { what: 'not a PDF', fix: 'Export your slides as a PDF and give that.' },
}

/** The refusal line for a kind: "<file> is a PowerPoint file. Export it as PDF: ...". */
export function refusal(kind: Exclude<Kind, 'pdf'>, name: string): string {
  const { what, fix } = REFUSALS[kind]
  return `${name} is ${what}. ${fix}`
}

/** A link rather than a file: Google Slides gets its own answer. */
export function linkKind(arg: string): Kind | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return null
  return /^https?:\/\/docs\.google\.com\/presentation\//i.test(arg) ? 'google' : 'link'
}

/** What a folder is: a Keynote package (its Index), or a folder of images. */
export function folderKind(names: readonly string[]): Kind {
  return names.includes('Index.zip') || names.includes('Index') ? 'key' : 'folder'
}

const PDF = Buffer.from('%PDF-')
const ZIP = Buffer.from('PK\x03\x04', 'latin1')
const ZIP_EMPTY = Buffer.from('PK\x05\x06', 'latin1')
const OLE2 = Buffer.from('d0cf11e0a1b11ae1', 'hex')
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const JPEG = Buffer.from('ffd8ff', 'hex')
const GIF = Buffer.from('GIF8')

/** The kind of a whole file, from its bytes. */
export function sniff(bytes: Buffer): Kind {
  // A PDF may have a little junk before its header, which readers accept: up to 1,024 bytes of it.
  if (bytes.subarray(0, 1024 + PDF.length).includes(PDF)) return 'pdf'
  if (bytes.subarray(0, 4).equals(ZIP) || bytes.subarray(0, 4).equals(ZIP_EMPTY)) return zipKind(bytes)
  if (bytes.subarray(0, 8).equals(OLE2)) return 'ppt'
  if (bytes.subarray(0, 8).equals(PNG) || bytes.subarray(0, 3).equals(JPEG) || bytes.subarray(0, 4).equals(GIF)) return 'images'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'images'
  if (looksLikeWebDeck(bytes)) return 'web'
  return 'other'
}

/** Markdown (front matter, or a heading) or HTML: the source of a Marp, Slidev or reveal.js deck. */
function looksLikeWebDeck(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 4096)
  if (head.includes(0)) return false
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart()
  return /^(?:---\s*\n|#{1,6}\s|<!doctype html|<html[\s>])/i.test(text) || /^marp:\s*true$/m.test(text)
}

/** A ZIP entry: its name, and where its data is. */
interface Entry {
  name: string
  method: number
  compressed: number
  local: number
}

/**
 * The entries of a ZIP, from its central directory, or null when it can't be read. Only names and offsets: nothing
 * is inflated here.
 */
export function zipEntries(bytes: Buffer): Entry[] | null {
  // The end of central directory record is in the last 22 bytes, or up to 64 KiB before them (its comment).
  const from = Math.max(0, bytes.length - 22 - 0xffff)
  let end = -1
  for (let i = bytes.length - 22; i >= from; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) return null
  const count = bytes.readUInt16LE(end + 10)
  let at = bytes.readUInt32LE(end + 16)
  const entries: Entry[] = []
  for (let i = 0; i < count && i < 20_000; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return null
    const method = bytes.readUInt16LE(at + 10)
    const compressed = bytes.readUInt32LE(at + 20)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extra = bytes.readUInt16LE(at + 30)
    const comment = bytes.readUInt16LE(at + 32)
    const local = bytes.readUInt32LE(at + 42)
    if (at + 46 + nameLength > bytes.length) return null
    entries.push({ name: bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'), method, compressed, local })
    at += 46 + nameLength + extra + comment
  }
  return entries
}

/** One entry's data, inflated to at most `max` bytes, or null. */
function entryData(bytes: Buffer, entry: Entry, max: number): Buffer | null {
  try {
    const at = entry.local
    if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== 0x04034b50) return null
    const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28)
    const data = bytes.subarray(start, start + entry.compressed)
    if (entry.method === 0) return data.subarray(0, max)
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: max })
    return null
  } catch {
    return null
  }
}

/** PowerPoint (and whether it has macros), OpenDocument, Keynote, or another ZIP. */
function zipKind(bytes: Buffer): Kind {
  const entries = zipEntries(bytes) ?? []
  const names = entries.map(e => e.name)
  if (names.some(n => /^Index\/[^/]+\.iwa$/.test(n) || n === 'Index.zip')) return 'key'
  const mimetype = entries.find(e => e.name === 'mimetype')
  if (mimetype) {
    const type = entryData(bytes, mimetype, 200)?.toString('latin1') ?? ''
    return /^application\/vnd\.oasis\.opendocument\.presentation/.test(type) ? 'odp' : 'other'
  }
  const types = entries.find(e => e.name === '[Content_Types].xml')
  if (types && names.some(n => n.startsWith('ppt/'))) {
    if (names.some(n => /(^|\/)vbaProject\.bin$/i.test(n))) return 'pptm'
    const xml = entryData(bytes, types, 1024 * 1024)?.toString('utf8') ?? ''
    return /macroEnabled/i.test(xml) ? 'pptm' : 'pptx'
  }
  return 'other'
}
