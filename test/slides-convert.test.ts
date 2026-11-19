// npm run slides -- prepare's conversion (src/slides/convert.ts and the real converter child, render-child.ts), on PDFs
// made at test time (test/fixtures/slides/make-pdf.ts): 16:9, 4:3 and portrait pages, text and titles, a page with no
// text, a JPEG2000 image, an image over the size limit, one that can't be decoded, Marp-style notes, repeating page
// labels, an OpenAction and links, the two kinds of password, too many pages, and --exclude. The parent's own side
// (the child's environment, the time limit, what it reads of the child) runs against a fake child.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { ROOT } from '../src/config.ts'
import {
  CANVAS_MISSING, PASSWORD_REFUSAL, PrepareError, type Prepared, childCommand, childEnv, newDeckId, pageOverDeckLimit, prepareDeck, slugOf,
} from '../src/slides/convert.ts'
import { DeckStore, webpSize } from '../src/slides/deck.ts'
import { DECK_ID } from '../src/slides/manifest.ts'
import { skeleton } from '../src/slides/script.ts'
import { makePdf } from './fixtures/slides/make-pdf.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-slides-convert-'))
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }))
const FAKE_CHILD = path.join(import.meta.dirname, 'fixtures/slides/fake-child.ts')
const JP2 = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/slides/red.jp2'))

let n = 0
/** A fresh folder with the PDF in it, and a decks folder beside it. */
function setup(pdf: Buffer, name = 'deck.pdf') {
  const dir = fs.mkdtempSync(path.join(DIR, `case-${++n}-`))
  const input = path.join(dir, name)
  fs.writeFileSync(input, pdf)
  return { dir, input, decksDir: path.join(dir, 'decks') }
}

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof PrepareError, String(err))
    return err.message
  }
  assert.fail('prepare should have refused')
}

/** The colour of a pixel of a slide image. */
async function pixel(webp: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const image = await loadImage(webp)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
  return [r, g, b]
}
const near = (a: readonly number[], b: readonly number[], within = 40) => a.every((v, i) => Math.abs(v - b[i]) <= within)

// One deck with a page of each kind, converted once for the tests below.
const requests: string[] = []
const server = http.createServer((req, res) => {
  requests.push(req.url ?? '')
  res.end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
const main = setup(
  makePdf(
    [
      {
        texts: [{ text: 'Q4 roadmap', size: 40 }, { text: 'What ships this quarter', size: 20 }, { text: 'Footnote in tiny type', size: 9 }],
        annots: [{ kind: 'link', uri: `http://127.0.0.1:${port}/link` }, { kind: 'launch', file: '/bin/sh' }],
      },
      { size: [720, 540], rects: [{ x: 0, y: 0, w: 720, h: 540, rgb: [0, 0, 1] }, { x: 2, y: 2, w: 716, h: 536, rgb: [1, 0, 0] }] },
      { size: [595, 842], texts: [{ text: 'A document page', size: 30 }] },
      { rects: [{ x: 100, y: 100, w: 300, h: 200, rgb: [0, 0.6, 0] }] },
      { images: [{ kind: 'jpx', data: JP2, width: 32, height: 32, at: [0, 0, 960, 540] }] },
      { images: [{ kind: 'huge', width: 10000, height: 6000, at: [0, 0, 960, 540] }], texts: [{ text: 'A huge photo', size: 30 }] },
      { images: [{ kind: 'broken', at: [0, 0, 960, 540] }], texts: [{ text: 'A broken image', size: 30 }] },
      { texts: [{ text: 'With notes', size: 30 }], annots: [{ kind: 'note', contents: 'Mention the pilot customers first.' }] },
      { texts: [{ text: 'Excludedpagetext never leaves the PDF', size: 30 }] },
    ],
    { pageLabels: ['1', '2', '2', '2', '3', '4', '5', '6', '7'], openActionJs: `this.submitForm("http://127.0.0.1:${port}/js")` },
  ),
  'Q4 Roadmap (final).pdf',
)
const prepared: Prepared = await prepareDeck({ input: main.input, decksDir: main.decksDir, exclude: [9], now: new Date('2026-11-19T10:02:11.500Z') })
server.close()
const slides = new Map(prepared.manifest.slides.map(s => [s.n, s]))
const image = (page: number) => fs.readFileSync(path.join(prepared.dir, slides.get(page)?.file ?? ''))

test('the deck: an id from the file name, every page but the excluded one, the manifest, and 0700 and 0600 modes', () => {
  const { manifest } = prepared
  assert.match(manifest.id, /^q4-roadmap-final-[a-z2-7]{6}$/)
  assert.ok(DECK_ID.test(manifest.id))
  assert.equal(manifest.label, 'Q4 Roadmap (final)')
  assert.equal(manifest.created, '2026-11-19T10:02:11Z')
  assert.equal(manifest.pages, 9)
  assert.equal(manifest.excluded, 1)
  assert.deepEqual(manifest.slides.map(s => s.n), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(prepared.dir, path.join(main.decksDir, manifest.id))
  assert.deepEqual(fs.readdirSync(prepared.dir).sort(), ['001.webp', '002.webp', '003.webp', '004.webp', '005.webp', '006.webp', '007.webp', '008.webp', 'manifest.json'])
  assert.equal(fs.statSync(main.decksDir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(prepared.dir).mode & 0o777, 0o700)
  for (const file of fs.readdirSync(prepared.dir)) assert.equal(fs.statSync(path.join(prepared.dir, file)).mode & 0o777, 0o600, file)
  assert.deepEqual(fs.readdirSync(main.decksDir), [manifest.id], 'the temporary folder is gone')
  // The same loader the service will use takes it.
  assert.equal(new DeckStore(main.decksDir).load(manifest.id, { images: 'all' }).images.size, 8)
})

test('every image is a 1280x720 WebP that we encoded', () => {
  for (const slide of prepared.manifest.slides) {
    const bytes = image(slide.n)
    assert.deepEqual(webpSize(bytes), { width: 1280, height: 720 }, `page ${slide.n}`)
    assert.equal(bytes.length, slide.bytes)
  }
})

test("text and titles: the first line of the largest text, small text warned about, and a page with no text", () => {
  const first = slides.get(1)
  assert.equal(first?.title, 'Q4 roadmap')
  assert.equal(first?.text, 'Q4 roadmap\nWhat ships this quarter\nFootnote in tiny type')
  assert.deepEqual(first?.warnings, ['small-text'])
  assert.deepEqual(slides.get(4)?.warnings, ['no-text'])
  assert.equal(slides.get(4)?.title, '')
  assert.equal(slides.get(4)?.text, '')
})

test('a 4:3 page is fitted into 1280x720 with 160 px bars in the colour of its edge', async () => {
  const bytes = image(2)
  assert.deepEqual(slides.get(2)?.warnings, ['no-text', 'letterboxed'])
  const blue = [0, 0, 255]
  const red = [255, 0, 0]
  assert.ok(near(await pixel(bytes, 20, 360), blue), 'left bar')
  assert.ok(near(await pixel(bytes, 150, 360), blue), 'left bar, just short of the page')
  assert.ok(near(await pixel(bytes, 175, 360), red), 'the page, just inside its blue edge')
  assert.ok(near(await pixel(bytes, 640, 360), red), 'the middle')
  assert.ok(near(await pixel(bytes, 1105, 360), red), 'the page, at its right side')
  assert.ok(near(await pixel(bytes, 1130, 360), blue), 'right bar')
})

test('a portrait page is letterboxed and said to look like a document', () => {
  assert.deepEqual(slides.get(3)?.warnings, ['letterboxed', 'portrait'])
})

test('a JPEG2000 image is drawn (pdf.js is given its wasm decoders), not left white', async () => {
  assert.deepEqual(slides.get(5)?.warnings, ['no-text'])
  assert.ok(near(await pixel(image(5), 640, 360), [255, 0, 0]), 'its centre is the image\'s red')
})

test('an image over the size limit, and one that cannot be decoded, become manifest warnings, never silent blanks', async () => {
  assert.deepEqual(slides.get(6)?.warnings, ['image-too-large'])
  assert.deepEqual(slides.get(7)?.warnings, ['image-not-drawn'])
  assert.ok(near(await pixel(image(6), 640, 600), [255, 255, 255]), 'the huge image was left out')
})

test('page labels are hints, never keys: they repeat, the pages do not', () => {
  assert.deepEqual(prepared.manifest.slides.map(s => s.pageLabel), ['1', '2', '2', '2', '3', '4', '5', '6'])
  const script = skeleton(prepared.manifest, { name: 'Alex', scriptName: 'x.script.md', notes: prepared.notes })
  assert.deepEqual([...script.matchAll(/^## (\d+)/gm)].map(m => Number(m[1])), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.match(script, /## 3 · A document page\ncheck: yes\n\nTODO\n<!-- On the slide: "A document page" -->\n<!-- Page label: "2" \(a hint only/)
  assert.doesNotMatch(script, /Page label: "1"/, 'a label that is the page number is not repeated')
})

test("a sticky note (Marp's speaker notes) goes into the skeleton only, never into the deck", () => {
  assert.deepEqual([...prepared.notes], [[8, 'Mention the pilot customers first.']])
  const script = skeleton(prepared.manifest, { name: 'Alex', scriptName: 'x.script.md', notes: prepared.notes })
  assert.match(script, /<!-- Your notes: "Mention the pilot customers first\." -->/)
  for (const file of fs.readdirSync(prepared.dir)) {
    assert.ok(!fs.readFileSync(path.join(prepared.dir, file)).includes('pilot customers'), file)
  }
})

test('an excluded page is never rendered and leaves no text behind', () => {
  assert.ok(!slides.has(9))
  for (const file of fs.readdirSync(prepared.dir)) assert.ok(!fs.readFileSync(path.join(prepared.dir, file)).includes('Excludedpagetext'), file)
})

test("the PDF's JavaScript, links and launch action do nothing: no request reached the local server", () => {
  assert.deepEqual(requests, [])
})

test('a PDF that needs a password to open is refused, with the exact line; one with only an owner password renders', async () => {
  const pages = [{ texts: [{ text: 'Confidential pricing', size: 40 }] }]
  const user = setup(makePdf(pages, { encrypt: { user: 'open-sesame', owner: 'owner-pass' } }))
  assert.equal(await refused(prepareDeck({ input: user.input, decksDir: user.decksDir })), PASSWORD_REFUSAL)
  assert.equal(PASSWORD_REFUSAL, 'This PDF is password-protected: export it again without a password.')
  assert.deepEqual(fs.readdirSync(user.decksDir), [], 'nothing is left behind')

  const owner = setup(makePdf(pages, { encrypt: { user: '', owner: 'owner-pass' } }))
  const deck = await prepareDeck({ input: owner.input, decksDir: owner.decksDir })
  assert.equal(deck.manifest.slides[0].text, 'Confidential pricing', 'it opens and its text is read')
  assert.deepEqual(webpSize(fs.readFileSync(path.join(deck.dir, '001.webp'))), { width: 1280, height: 720 })
})

test('more than 100 pages, an --exclude past the end, and a file that is not really a PDF are refused', async () => {
  const many = setup(makePdf(Array.from({ length: 101 }, () => ({}))))
  assert.equal(await refused(prepareDeck({ input: many.input, decksDir: many.decksDir })), 'deck.pdf has 101 pages: at most 100 can be prepared. Split it, or export only the slides you need.')
  const short = setup(makePdf([{}, {}]))
  assert.equal(await refused(prepareDeck({ input: short.input, decksDir: short.decksDir, exclude: [3] })), '--exclude 3: deck.pdf has only 2 pages.')
  assert.equal(await refused(prepareDeck({ input: short.input, decksDir: short.decksDir, exclude: [1, 2] })), '--exclude leaves no pages to prepare.')
  assert.match(await refused(prepareDeck({ input: short.input, decksDir: short.decksDir, exclude: [0] })), /--exclude takes page numbers from 1 to 100/)
  const junk = setup(Buffer.from('%PDF-1.4\nthis is not a PDF at all\n'))
  assert.match(await refused(prepareDeck({ input: junk.input, decksDir: junk.decksDir })), /^deck\.pdf could not be read as a PDF \([A-Za-z]+\)\. Export it again/)
  for (const c of [many, short, junk]) assert.deepEqual(fs.readdirSync(c.decksDir), [], 'no deck and no temporary folder')
})

/** Runs prepare with the fake child, doing what `plan` says, with HOME in a folder of its own. */
async function withFakeChild(plan: object, opts: { timeoutMs?: number } = {}) {
  const c = setup(makePdf([{}]))
  const home = fs.mkdtempSync(path.join(DIR, 'home-'))
  fs.writeFileSync(path.join(home, 'fake-child.json'), JSON.stringify(plan))
  const saved = { HOME: process.env.HOME, FAKE_SERVICE_API_KEY: process.env.FAKE_SERVICE_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  Object.assign(process.env, { HOME: home, FAKE_SERVICE_API_KEY: 'sk-test-not-a-real-key', ANTHROPIC_API_KEY: 'sk-test-not-a-real-key-either' })
  try {
    const message = await refused(prepareDeck({ input: c.input, decksDir: c.decksDir, childScript: FAKE_CHILD, timeoutMs: opts.timeoutMs ?? 20_000 }))
    return { message, home, decksDir: c.decksDir }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test("the child's environment is PATH, HOME and its own TMPDIR only: no API key, though this process has them", async () => {
  const { home, decksDir } = await withFakeChild({ env: true, exit: 1 })
  const env = JSON.parse(fs.readFileSync(path.join(home, 'child-env.json'), 'utf8')) as Record<string, string>
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR'])
  assert.ok(!Object.keys(env).some(k => /KEY|TOKEN|SECRET/.test(k)))
  assert.ok(!Object.values(env).some(v => v.includes('sk-test')))
  assert.ok(env.TMPDIR.startsWith(path.join(decksDir, '.tmp-')), 'a temporary folder of its own, removed after')
  assert.ok(!fs.existsSync(env.TMPDIR))
  assert.deepEqual(childEnv({ PATH: '/bin', HOME: '/h', RECALL_API_KEY: 'x', NODE_OPTIONS: '--require evil' }, '/t'), { PATH: '/bin', HOME: '/h', TMPDIR: '/t' })
})

test('a child that runs past the time limit is killed with its whole process group, and its folder removed', async () => {
  const started = Date.now()
  const { message, home, decksDir } = await withFakeChild({ hang: true }, { timeoutMs: 1500 })
  assert.match(message, /^deck\.pdf took more than 2 s to render, so it was stopped\./)
  assert.ok(Date.now() - started < 15_000)
  const pids = JSON.parse(fs.readFileSync(path.join(home, 'child-pids.json'), 'utf8')) as number[]
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(pids.map(alive), [false, false], 'the child and its grandchild')
  assert.deepEqual(fs.readdirSync(decksDir), [])
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('closing the terminal (SIGHUP) or SIGQUIT stops the prepare in order: the child and its group killed, the copy of the PDF removed', async () => {
  for (const [signal, code] of [['SIGHUP', 129], ['SIGQUIT', 131]] as const) {
    const c = setup(makePdf([{}]))
    const home = fs.mkdtempSync(path.join(DIR, 'home-'))
    fs.writeFileSync(path.join(home, 'fake-child.json'), JSON.stringify({ hang: true }))
    const parent = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'fixtures/slides/prepare-parent.ts'), c.input, c.decksDir, FAKE_CHILD], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      stdio: 'ignore',
    })
    const exited = new Promise<number | null>(resolve => parent.on('exit', (status, sig) => resolve(status ?? (sig ? -1 : null))))
    const pidsFile = path.join(home, 'child-pids.json')
    for (let i = 0; i < 200 && !fs.existsSync(pidsFile); i++) await new Promise(resolve => setTimeout(resolve, 100))
    const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as number[]
    try {
      parent.kill(signal)
      assert.equal(await exited, code, signal)
      for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 100))
      assert.deepEqual(pids.map(alive), [false, false], `${signal}: the child and its grandchild`)
      assert.deepEqual(fs.readdirSync(c.decksDir).filter(n => n.startsWith('.tmp-')), [], `${signal}: no copy of the PDF left`)
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }
})

test('the child starts under a CPU-time limit, twice the time limit, that holds once its parent is gone', () => {
  const [command, args] = childCommand('/x/child.ts', { input: '/i', out: '/o', exclude: [], timeoutMs: 180_000 }, 180_000)
  if (process.platform === 'win32') return
  assert.equal(command, '/bin/sh')
  assert.deepEqual(args.slice(0, 3), ['-c', 'ulimit -t 360 && exec /usr/bin/env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" "$0" "$@"', process.execPath])
  assert.equal(args.at(-2), '/x/child.ts')
  assert.deepEqual(JSON.parse(args.at(-1) ?? ''), { input: '/i', out: '/o', exclude: [], timeoutMs: 180_000 })
})

test('prepare first removes what a killed prepare left (once it is 10 minutes old), never one that may be running', async () => {
  const c = setup(makePdf([{}]))
  fs.mkdirSync(c.decksDir, { recursive: true, mode: 0o700 })
  for (const name of ['.tmp-old', '.tmp-new']) {
    fs.mkdirSync(path.join(c.decksDir, name))
    fs.writeFileSync(path.join(c.decksDir, name, 'input.pdf'), 'a copy of the PDF')
  }
  const old = new Date(Date.now() - 11 * 60_000)
  fs.utimesSync(path.join(c.decksDir, '.tmp-old'), old, old)
  await prepareDeck({ input: c.input, decksDir: c.decksDir })
  assert.deepEqual(fs.readdirSync(c.decksDir).filter(n => n.startsWith('.tmp-')), ['.tmp-new'])
})

test("the parent reads the child strictly: a refusal's words are its own, and anything malformed stops the prepare", async () => {
  assert.equal((await withFakeChild({ lines: ['{"type":"refused","reason":"no-canvas"}'] })).message, CANVAS_MISSING)
  assert.equal(CANVAS_MISSING, 'Slide rendering needs @napi-rs/canvas: run npm install (without --omit=optional).')
  assert.match((await withFakeChild({ lines: ['{"type":"refused","reason":"page-slow","page":4}'] })).message, /^Page 4 took too long to render\. .* --exclude 4\.$/)
  assert.match((await withFakeChild({ lines: ['{"type":"refused","reason":"page-too-big","page":2}'] })).message, /^Page 2 can't be saved under 2 MiB/)
  assert.equal((await withFakeChild({ lines: ['{"type":"refused","reason":"page-failed","page":3,"name":"FormatError"}'] })).message, 'Page 3 could not be drawn (FormatError). Export the PDF again, or leave that page out with --exclude 3.')
  assert.match((await withFakeChild({ lines: ['{"type":"refused","reason":"unreadable","name":"Secret file text"}'] })).message, /could not be read as a PDF \(Error\)/, "a name that isn't an error's name is not echoed")
  assert.match((await withFakeChild({ lines: ['not json at all'] })).message, /^The converter stopped unexpectedly/)
  assert.match((await withFakeChild({ lines: ['{"type":"open","pages":1}', '{"type":"done","other":0}'] })).message, /did not render every page/)
  assert.match((await withFakeChild({ lines: [], exit: 3 })).message, /^The converter stopped unexpectedly \(exit 3\)/)
})

test("a deck whose images come to more than 40 MiB stops at that page, in the owner's words, with no deck id", async () => {
  const refusal = (await withFakeChild({ lines: ['{"type":"open","pages":60}', '{"type":"refused","reason":"deck-too-big","page":52}'] })).message
  assert.equal(refusal, "deck.pdf's slide images come to more than 40 MiB (it stopped at page 52). Export it again with lighter images, split it, or leave some pages out with --exclude.")
  assert.ok(!refusal.includes('41943040'), 'in MiB, not bytes')
  // The parent's own count, for a child that did not stop: the page where the total first goes over.
  const mib = 1024 * 1024
  assert.equal(pageOverDeckLimit([{ n: 1, bytes: 20 * mib }, { n: 3, bytes: 20 * mib }]), null)
  assert.equal(pageOverDeckLimit([{ n: 1, bytes: 20 * mib }, { n: 3, bytes: 20 * mib }, { n: 4, bytes: 1 }]), 4)
})

test('ids: a slug of the label, ASCII-folded, at most 24 characters, then 6 base32 letters, never one taken', () => {
  assert.equal(slugOf('Q4 Roadmap (final)'), 'q4-roadmap-final')
  assert.equal(slugOf('Präsentation über Größe'), 'prasentation-uber-gro-e')
  assert.equal(slugOf('a very long deck name that goes on and on'), 'a-very-long-deck-name-th')
  assert.equal(slugOf('---'), 'deck')
  assert.equal(slugOf('日本語'), 'deck')
  const taken = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const id = newDeckId('q4', candidate => taken.has(candidate))
    assert.ok(DECK_ID.test(id) && !taken.has(id), id)
    taken.add(id)
  }
})
