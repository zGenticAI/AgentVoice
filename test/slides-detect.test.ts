// What prepare does with each kind of file (src/slides/detect.ts, and readInput in src/slides/convert.ts): detection
// by the first bytes, never the name, and the exact line for each format it refuses. Nothing here renders.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrepareError, readInput } from '../src/slides/convert.ts'
import { REFUSALS, folderKind, linkKind, refusal, sniff, zipEntries } from '../src/slides/detect.ts'
import { makePdf } from './fixtures/slides/make-pdf.ts'
import { makeZip } from './fixtures/slides/make-zip.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-slides-detect-'))
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }))

const CONTENT_TYPES = '<?xml version="1.0"?><Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'
const MACRO_TYPES = CONTENT_TYPES.replace('presentationml.presentation.main', 'ms-powerpoint.presentation.macroEnabled.main')
const FILES = {
  pptx: makeZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, deflate: true }, { name: 'ppt/presentation.xml', data: '<p/>', deflate: true }]),
  pptmByTypes: makeZip([{ name: '[Content_Types].xml', data: MACRO_TYPES, deflate: true }, { name: 'ppt/presentation.xml', data: '<p/>' }]),
  pptmByCode: makeZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES }, { name: 'ppt/presentation.xml', data: '<p/>' }, { name: 'ppt/vbaProject.bin', data: 'x' }]),
  odp: makeZip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.presentation' }, { name: 'content.xml', data: '<x/>', deflate: true }]),
  odt: makeZip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml', data: '<x/>' }]),
  key: makeZip([{ name: 'Index/Document.iwa', data: 'x' }, { name: 'Data/image.png', data: 'x' }]),
  docx: makeZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES }, { name: 'word/document.xml', data: '<w/>' }]),
  zip: makeZip([{ name: 'notes.txt', data: 'hello' }]),
  ole2: Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]),
  png: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]),
  jpeg: Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(64)]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(64)]),
  gif: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
  marp: Buffer.from('---\nmarp: true\n---\n\n# Q4 roadmap\n'),
  markdown: Buffer.from('# Q4 roadmap\n\n- one\n'),
  html: Buffer.from('<!DOCTYPE html>\n<html><body><section>Slide</section></body></html>'),
  text: Buffer.from('Just some notes about the deck.\n'),
}

test('a PDF is known by %PDF- in its first 1,024 bytes, whatever it is called', () => {
  assert.equal(sniff(makePdf([{}])), 'pdf')
  assert.equal(sniff(Buffer.concat([Buffer.alloc(1000, 0x20), makePdf([{}])])), 'pdf', 'after junk a reader accepts')
  assert.equal(sniff(Buffer.concat([Buffer.alloc(1100, 0x20), Buffer.from('%PDF-1.4')])), 'other', 'too far in')
})

test('ZIP-based files by what they hold: PowerPoint (with or without macros), OpenDocument, Keynote, or other', () => {
  assert.equal(sniff(FILES.pptx), 'pptx')
  assert.equal(sniff(FILES.pptmByTypes), 'pptm', 'its content types declare macros')
  assert.equal(sniff(FILES.pptmByCode), 'pptm', 'it holds macro code')
  assert.equal(sniff(FILES.odp), 'odp')
  assert.equal(sniff(FILES.odt), 'other', 'an OpenDocument text is not a presentation')
  assert.equal(sniff(FILES.key), 'key')
  assert.equal(sniff(FILES.docx), 'other', 'a Word file is not a presentation')
  assert.equal(sniff(FILES.zip), 'other')
  assert.deepEqual(zipEntries(FILES.key)?.map(e => e.name), ['Index/Document.iwa', 'Data/image.png'])
  assert.equal(zipEntries(Buffer.from('PK\x03\x04 truncated', 'latin1')), null)
})

test('the old binary format, images, and Markdown or HTML decks', () => {
  assert.equal(sniff(FILES.ole2), 'ppt')
  for (const image of ['png', 'jpeg', 'webp', 'gif'] as const) assert.equal(sniff(FILES[image]), 'images', image)
  for (const web of ['marp', 'markdown', 'html'] as const) assert.equal(sniff(FILES[web]), 'web', web)
  assert.equal(sniff(FILES.text), 'other')
})

test('links and folders: a Google Slides link, another link, a Keynote package, a folder of images', () => {
  assert.equal(linkKind('https://docs.google.com/presentation/d/abc123/edit'), 'google')
  assert.equal(linkKind('https://example.com/deck.pdf'), 'link')
  assert.equal(linkKind('deck.pdf'), null)
  assert.equal(linkKind('./https-notes.pdf'), null)
  assert.equal(folderKind(['Index.zip', 'Data', 'Metadata']), 'key')
  assert.equal(folderKind(['1.png', '2.png']), 'folder')
})

test("each refused format gets its exact line, after what the file is", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(REFUSALS).map(([kind, r]) => [kind, r.fix])),
    {
      pptx: 'Export it as PDF: File > Export > PDF (or Save As > PDF), with hidden slides included.',
      pptm: 'This file contains macros. Save it as a PDF and use that.',
      ppt: 'Save it as .pptx or export a PDF.',
      odp: 'LibreOffice Impress: File > Export as PDF.',
      key: "Keynote: File > Export To > PDF (tick 'Include skipped slides').",
      google: 'Google Slides: File > Download > PDF document.',
      link: 'Download the deck as a PDF, and give that file.',
      web: 'Export it to PDF (`marp --pdf --pdf-notes`, `slidev export`, decktape).',
      images: 'Put the images into one PDF.',
      folder: 'Put the images into one PDF.',
      other: 'Export your slides as a PDF and give that.',
    },
  )
  assert.equal(refusal('pptx', 'deck.pdf'), 'deck.pdf is a PowerPoint file. Export it as PDF: File > Export > PDF (or Save As > PDF), with hidden slides included.')
})

/** prepare's answer for a file with these bytes and this name. */
function answer(bytes: Buffer | null, name: string, make?: (file: string) => void): string {
  const file = path.join(fs.mkdtempSync(path.join(DIR, 'case-')), name)
  if (bytes) fs.writeFileSync(file, bytes)
  make?.(file)
  try {
    readInput(file)
  } catch (err) {
    assert.ok(err instanceof PrepareError, String(err))
    return err.message
  }
  return 'accepted'
}

test('prepare refuses by what a file is, not what it is called: a .pdf that is really a PowerPoint file says so', () => {
  assert.equal(answer(FILES.pptx, 'deck.pdf'), 'deck.pdf is a PowerPoint file. Export it as PDF: File > Export > PDF (or Save As > PDF), with hidden slides included.')
  assert.equal(answer(FILES.pptmByTypes, 'deck.pptm'), 'deck.pptm is a PowerPoint file with macros. This file contains macros. Save it as a PDF and use that.')
  assert.equal(answer(FILES.odp, 'deck.odp'), 'deck.odp is an OpenDocument file. LibreOffice Impress: File > Export as PDF.')
  assert.equal(answer(FILES.key, 'deck.key'), "deck.key is a Keynote file. Keynote: File > Export To > PDF (tick 'Include skipped slides').")
  assert.equal(answer(FILES.ole2, 'deck.ppt'), 'deck.ppt is an old binary Office file. Save it as .pptx or export a PDF.')
  assert.equal(answer(FILES.png, 'slide1.pdf'), 'slide1.pdf is an image. Put the images into one PDF.')
  assert.equal(answer(FILES.marp, 'deck.md'), 'deck.md is a Markdown or web page deck. Export it to PDF (`marp --pdf --pdf-notes`, `slidev export`, decktape).')
  assert.equal(answer(FILES.text, 'deck.pdf'), 'deck.pdf is not a PDF. Export your slides as a PDF and give that.')
  assert.equal(answer(makePdf([{}]), 'Deck.PPTX'), 'accepted', 'a PDF with any name is taken')
})

test('prepare refuses links, folders, symbolic links, empty files and files over 100 MiB before reading them', () => {
  assert.throws(() => readInput('https://docs.google.com/presentation/d/abc/edit'), { message: 'https://docs.google.com/presentation/d/abc/edit is a Google Slides link. Google Slides: File > Download > PDF document.' })
  assert.throws(() => readInput('https://example.com/deck.pdf'), { message: 'https://example.com/deck.pdf is a link, not a file. Download the deck as a PDF, and give that file.' })
  assert.equal(answer(null, 'slides', f => {
    fs.mkdirSync(f)
    fs.writeFileSync(path.join(f, '1.png'), FILES.png)
  }), 'slides is a folder. Put the images into one PDF.')
  assert.equal(answer(null, 'Deck.key', f => {
    fs.mkdirSync(f)
    fs.writeFileSync(path.join(f, 'Index.zip'), FILES.key)
  }), "Deck.key is a Keynote file. Keynote: File > Export To > PDF (tick 'Include skipped slides').")
  assert.equal(answer(null, 'link.pdf', f => fs.symlinkSync(path.join(DIR, 'elsewhere.pdf'), f)), 'link.pdf is a symbolic link: give the PDF itself.')
  assert.equal(answer(null, 'gone.pdf'), 'gone.pdf was not found.')
  assert.equal(answer(Buffer.alloc(0), 'empty.pdf'), 'empty.pdf is empty.')
  assert.equal(answer(null, 'huge.pdf', f => {
    fs.writeFileSync(f, '%PDF-1.4\n')
    fs.truncateSync(f, 100 * 1024 * 1024 + 1)
  }), 'huge.pdf is over 100 MiB. Export it again with smaller images, or split it.')
})
