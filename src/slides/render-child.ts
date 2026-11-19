// The converter: renders each page of an untrusted PDF into a 1280x720 WebP, and reads its text, title, page label
// and sticky notes. It runs as a child process of npm run slides -- prepare (src/slides/convert.ts), with an
// environment that holds no API keys, so it must never import env.ts or config.ts, even through another module:
// importing env.ts loads .env, and every key with it (test/import-graph.test.ts checks). That is not a sandbox: code
// running here could still read .env from disk (docs/security.md says so).
//
// It takes one argument, a JSON job {input, out, exclude, timeoutMs}, and writes JSON lines to stdout: 'open', a 'page' for each
// page rendered, then 'done', or a 'refused' line that says why it stopped. It never echoes pdf.js's messages, which
// can quote the file: it turns the two that matter into warnings, and only counts the rest.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  MAX_DECK_BYTES, MAX_IMAGE_BYTES, MAX_PAGES, MAX_PAGE_TEXT, MAX_TITLE, SLIDE_HEIGHT, SLIDE_WIDTH, type WarningCode, slideFile,
} from './manifest.ts'
import type { ChildMessage, Job } from './child-protocol.ts'
import { type Run, type TextItem, cleanText, hasSmallText, oneLine, separator, titleOf } from './page-text.ts'

/**
 * Best effort only, and for drawing a page: a synchronous image decode blocks this timer, and opening the document and
 * reading a page's text have no budget here. The parent's kill and the CPU-time limit are the hard bounds.
 */
const PAGE_BUDGET_MS = 10_000
/** Above this, the child stops after the page it is on. It can't bound a single page. */
const MAX_RSS = 2.5 * 1024 ** 3
/** pdf.js leaves out an image larger than this, with a warning that becomes a manifest warning. */
const MAX_IMAGE_PIXELS = 50e6
const QUALITIES = [90, 80, 70]

/** An error's class name, which never quotes the file, or 'Error'. */
const errorName = (err: unknown) => {
  const name = (err as Error)?.name
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error'
}

const send = (message: ChildMessage) =>
  new Promise<void>(resolve => process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve()))

async function main(): Promise<void> {
  const job = JSON.parse(process.argv[2] ?? '{}') as Job
  // Should the parent die without killing this process (SIGKILL, a crash), it ends itself: once the parent is gone, at
  // its time limit, or when its output has nowhere to go. All are late while a long step blocks, which is why the
  // parent also starts it under a CPU-time limit.
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) process.exit(1)
  }, 1000).unref()
  if (Number.isFinite(job.timeoutMs) && job.timeoutMs > 0) setTimeout(() => process.exit(1), job.timeoutMs).unref()
  process.stdout.on('error', () => process.exit(1))
  const require = createRequire(import.meta.url)
  let canvasModule: typeof import('@napi-rs/canvas')
  try {
    canvasModule = require('@napi-rs/canvas')
  } catch {
    await send({ type: 'refused', reason: 'no-canvas' })
    return
  }
  const { createCanvas } = canvasModule

  // pdf.js reports skipped and undecodable images only through console.warn: each warning is put down to the page
  // being read (pages are read one at a time), and only the two that matter are kept, as codes.
  let page = 0
  let pageWarnings = new Set<WarningCode>()
  let other = 0
  let outsidePages = 0
  console.warn = (...args: unknown[]) => {
    const message = String(args[0] ?? '')
    if (!page) outsidePages++
    else if (/Image exceeded maximum allowed size/.test(message)) pageWarnings.add('image-too-large')
    else if (/Unable to decode image/.test(message)) pageWarnings.add('image-not-drawn')
    else other++
  }
  console.log = console.info = console.debug = () => {}

  const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfjs = (await import(pdfjsPath)) as typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  // Plain folder paths, with the trailing slash: in Node, pdf.js reads these with fs, and a file:// URL fails.
  const root = path.join(path.dirname(pdfjsPath), '..', '..') + path.sep
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(job.input)),
      // No isEvalSupported: pdf.js 6 has no eval path at all (the font one behind CVE-2024-4367 went in 4.2.67).
      enableXfa: false,
      // Without wasmUrl a JPEG2000 or JBIG2 image (scans, often) is left blank, and ICC colour is off.
      standardFontDataUrl: `${root}standard_fonts${path.sep}`,
      cMapUrl: `${root}cmaps${path.sep}`,
      wasmUrl: `${root}wasm${path.sep}`,
      iccUrl: `${root}iccs${path.sep}`,
      disableAutoFetch: true,
      disableStream: true,
      maxImageSize: MAX_IMAGE_PIXELS,
      // 1, not 0: 0 would silence the warnings for skipped and undecodable images.
      verbosity: 1,
    }).promise
  } catch (err) {
    // Only on a password needed to open it: a PDF with only an owner password (no printing or copying) opens normally.
    if (errorName(err) === 'PasswordException') await send({ type: 'refused', reason: 'password' })
    else await send({ type: 'refused', reason: 'unreadable', name: errorName(err) })
    return
  }
  const pages = doc.numPages
  if (pages > MAX_PAGES) {
    await send({ type: 'refused', reason: 'too-many-pages', pages })
    return
  }
  const bad = job.exclude.find(n => n > pages)
  if (bad) {
    await send({ type: 'refused', reason: 'exclude-range', page: bad, pages })
    return
  }
  if (new Set(job.exclude).size >= pages) {
    await send({ type: 'refused', reason: 'all-excluded', pages })
    return
  }
  await send({ type: 'open', pages })
  const labels = await doc.getPageLabels().catch(() => null)
  // The images so far: a deck over the loader's limit stops here, not after every page is rendered. A test may lower
  // the limit, never raise it.
  let total = 0
  const lower = job.maxDeckBytes
  const maxDeckBytes = typeof lower === 'number' && Number.isInteger(lower) && lower >= 0 ? Math.min(lower, MAX_DECK_BYTES) : MAX_DECK_BYTES

  for (let n = 1; n <= pages; n++) {
    if (job.exclude.includes(n)) continue
    page = n
    pageWarnings = new Set()
    other = 0
    let pdfPage: Awaited<ReturnType<typeof doc.getPage>>
    let content: Awaited<ReturnType<typeof pdfPage.getTextContent>>
    let annotations: { subtype?: string; contentsObj?: { str?: string } }[]
    try {
      pdfPage = await doc.getPage(n)
      content = await pdfPage.getTextContent()
      annotations = await pdfPage.getAnnotations()
    } catch (err) {
      await send({ type: 'refused', reason: 'page-failed', page: n, name: errorName(err) })
      return
    }
    const natural = pdfPage.getViewport({ scale: 1 })
    const scale = Math.min(SLIDE_WIDTH / natural.width, SLIDE_HEIGHT / natural.height)
    const viewport = pdfPage.getViewport({ scale })
    const w = Math.max(1, Math.min(SLIDE_WIDTH, Math.round(viewport.width)))
    const h = Math.max(1, Math.min(SLIDE_HEIGHT, Math.round(viewport.height)))

    const items: TextItem[] = []
    let raw = ''
    // Items are runs of text: what goes between two is separator()'s, but never a second space.
    let last: Run | null = null
    for (const item of content.items) {
      if (!('str' in item)) continue
      const run: Run = { x: item.transform[4], y: item.transform[5], w: item.width, size: Math.hypot(item.transform[2], item.transform[3]), rtl: item.dir === 'rtl' }
      let sep: TextItem['sep'] = ''
      if (last && item.str && raw && !raw.endsWith('\n')) {
        sep = separator(last, run)
        if (sep === ' ' && (/\s$/.test(raw) || /^\s/.test(item.str))) sep = ''
      }
      raw += sep + item.str + (item.hasEOL ? '\n' : '')
      if (item.str) last = run
      // The title is read from these, with the same separators, so it reads as the page text does.
      items.push({ str: item.str, hasEOL: item.hasEOL, px: run.size * scale, sep })
    }
    const { text, cut } = cleanText(raw, MAX_PAGE_TEXT)
    const notes = annotations
      .filter(a => a.subtype === 'Text')
      .map(a => String(a.contentsObj?.str ?? ''))
      .join('\n\n')

    const pageCanvas = createCanvas(w, h)
    const ctx = pageCanvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    const task = pdfPage.render({
      canvas: pageCanvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
    })
    let late = false
    const timer = setTimeout(() => {
      late = true
      task.cancel()
    }, PAGE_BUDGET_MS)
    try {
      await task.promise
    } catch (err) {
      clearTimeout(timer)
      await send({ type: 'refused', reason: late ? 'page-slow' : 'page-failed', page: n, name: errorName(err) })
      return
    }
    clearTimeout(timer)

    // "Contain": the page fitted into 1280x720, the bars in the colour of the page's edge on their side.
    let slide = pageCanvas
    const sideBars = SLIDE_WIDTH - w > 2
    const topBars = SLIDE_HEIGHT - h > 2
    if (w !== SLIDE_WIDTH || h !== SLIDE_HEIGHT) {
      slide = createCanvas(SLIDE_WIDTH, SLIDE_HEIGHT)
      const out = slide.getContext('2d')
      out.fillStyle = edgeColour(ctx, w, h, sideBars || !topBars)
      out.fillRect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT)
      out.drawImage(pageCanvas, Math.round((SLIDE_WIDTH - w) / 2), Math.round((SLIDE_HEIGHT - h) / 2))
    }
    let webp: Buffer | null = null
    let quality = 0
    for (const q of QUALITIES) {
      const encoded = await slide.encode('webp', q)
      if (encoded.length <= MAX_IMAGE_BYTES) {
        webp = encoded
        quality = q
        break
      }
    }
    if (!webp) {
      await send({ type: 'refused', reason: 'page-too-big', page: n })
      return
    }
    total += webp.length
    if (total > maxDeckBytes) {
      await send({ type: 'refused', reason: 'deck-too-big', page: n })
      return
    }
    fs.writeFileSync(path.join(job.out, slideFile(n)), webp, { mode: 0o600, flag: 'wx' })

    const warnings: WarningCode[] = []
    if (hasSmallText(items)) warnings.push('small-text')
    if (!text) warnings.push('no-text')
    if (sideBars || topBars) warnings.push('letterboxed')
    if (natural.height > natural.width) warnings.push('portrait')
    for (const w of ['image-too-large', 'image-not-drawn'] as const) if (pageWarnings.has(w)) warnings.push(w)
    if (quality !== QUALITIES[0]) warnings.push('lower-quality')
    if (cut) warnings.push('text-cut')
    const label = labels?.[n - 1] ? oneLine(labels[n - 1], MAX_TITLE) : ''
    await send({
      type: 'page',
      n,
      title: titleOf(items),
      pageLabel: label || null,
      text,
      notes: cleanText(notes, MAX_PAGE_TEXT).text,
      warnings,
      other,
    })
    page = 0
    pdfPage.cleanup()
    if (process.memoryUsage().rss > MAX_RSS) {
      await send({ type: 'refused', reason: 'memory', page: n })
      return
    }
  }
  await send({ type: 'done', other: outsidePages })
}

/** The average colour of the page's left and right edges (for bars at the sides), or its top and bottom ones. */
function edgeColour(ctx: { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }, w: number, h: number, sides: boolean): string {
  const strips = sides ? [ctx.getImageData(0, 0, 1, h), ctx.getImageData(w - 1, 0, 1, h)] : [ctx.getImageData(0, 0, w, 1), ctx.getImageData(0, h - 1, w, 1)]
  const sum = [0, 0, 0]
  let count = 0
  for (const { data } of strips) {
    for (let i = 0; i < data.length; i += 4) {
      sum[0] += data[i]
      sum[1] += data[i + 1]
      sum[2] += data[i + 2]
      count++
    }
  }
  const [r, g, b] = sum.map(v => Math.round(v / Math.max(1, count)))
  return `rgb(${r}, ${g}, ${b})`
}

main().then(
  () => process.exit(0),
  async () => {
    await send({ type: 'refused', reason: 'unreadable', name: 'Error' })
    process.exit(1)
  },
)
