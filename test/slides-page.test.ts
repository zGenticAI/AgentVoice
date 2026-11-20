// The slides page (public/slides.js) under Node: a fake socket the test speaks for the service on, a clock the test
// moves, a stand-in for the two images and the frames, and Node's own Blob and object URLs. Slides assemble from their
// pieces, are acknowledged only once swapped in, wait while their image is on its way, and are kept only while in the
// window. Without its link the page blanks to "paused" after 12 s and "ended" when it gives up, with no slide left.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLANK_AFTER_MS, GIVE_UP_MS, SILENCE_MS, type SlidesView, createSlides, retryDelay,
} from '../public/slides.js'
import { chunkFrame } from '../src/slides/share.ts'
import { FakeClock, fakeSockets } from './fixtures/page-link.ts'

/** What the page showed, in order: frames, swaps and clears, and which URL each swap showed. */
class FakeView implements SlidesView {
  readonly shown: string[] = []
  readonly frames: string[] = []
  loading: string | null = null
  front: string | null = null
  /** URLs whose decode fails. */
  bad = new Set<string>()
  async load(url: string) {
    if (this.bad.has(url)) throw new Error('decode failed')
    this.loading = url
  }
  swap() {
    this.front = this.loading
    this.shown.push(`swap ${this.front}`)
  }
  frame(kind: 'starting' | 'paused' | 'ended') {
    this.frames.push(kind)
    this.shown.push(`frame ${kind}`)
  }
  clear() {
    this.front = null
    this.shown.push('clear')
  }
  diag() {
    return { w: 1280, h: 720, dpr: 1, visibility: 'visible', ua_major: 130 }
  }
}

const IMAGES = [Buffer.alloc(100_000, 1), Buffer.alloc(30, 2), Buffer.alloc(70_000, 3), Buffer.alloc(40, 4)]
const settle = () => new Promise(r => setImmediate(r))

function page() {
  const clock = new FakeClock()
  const sockets = fakeSockets()
  const view = new FakeView()
  const urls = new Map<string, Blob>()
  const revoked: string[] = []
  let made = 0
  const slides = createSlides('wss://assistant.example.com/slides-link?s=S&t=T', view, {
    WebSocket: sockets.WebSocket as any,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 1,
    createObjectURL: blob => {
      const u = `blob:${++made}`
      urls.set(u, blob)
      return u
    },
    revokeObjectURL: u => void revoked.push(u),
  })
  const sock = () => sockets.last
  /** The service accepts the link and sends the deck. */
  const deck = (count = IMAGES.length, rev = 'r1') => {
    sock().readyState = 1
    sock().say({ type: 'deck', v: 1, count, rev })
  }
  const pieces = (i: number, image = IMAGES[i]) => {
    for (let o = 0; o < image.length; o += 64 * 1024) {
      const b = chunkFrame(i, image, o)
      sock().onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) })
    }
  }
  const sent = () => sock().sent.map(m => JSON.parse(String(m)))
  const live = () => [...urls.keys()].filter(u => !revoked.includes(u))
  return { clock, sockets, view, urls, revoked, slides, sock, deck, pieces, sent, live }
}

test('on the deck message the page says hello with what it holds, and its numbers once', () => {
  const p = page()
  assert.deepEqual(p.view.frames, ['starting'])
  assert.equal(p.sock().url, 'wss://assistant.example.com/slides-link?s=S&t=T')
  p.deck()
  assert.deepEqual(p.sent(), [
    { type: 'hello', v: 1, rev: 'r1', have: '00' },
    { type: 'diag', w: 1280, h: 720, dpr: 1, visibility: 'visible', ua_major: 130 },
  ])
})

test('a slide assembles from its pieces, is swapped in, then acknowledged; again, it is acknowledged at once', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 0, seq: 5, keep: [0, 1] })
  // Not here yet: the starting frame stays, and nothing is acknowledged.
  await settle()
  assert.equal(p.sent().filter(m => m.type === 'shown').length, 0)
  p.pieces(0)
  await settle()
  assert.deepEqual(p.view.shown, ['frame starting', 'swap blob:1'])
  assert.deepEqual(p.sent().at(-1), { type: 'shown', i: 0, seq: 5 })
  const blob = p.urls.get('blob:1')!
  assert.equal(blob.type, 'image/webp')
  assert.ok(Buffer.from(await blob.arrayBuffer()).equals(IMAGES[0]))
  p.sock().say({ type: 'show', i: 0, seq: 6, keep: [0] })
  await settle()
  assert.deepEqual(p.sent().at(-1), { type: 'shown', i: 0, seq: 6 })
  assert.equal(p.view.shown.length, 2, 'no swap for the slide on screen')
})

test('a show for a slide still on its way keeps the slide on screen, and acknowledges once it is shown', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 1, seq: 1, keep: [1, 2] })
  p.pieces(1)
  p.pieces(2)
  await settle()
  p.sock().say({ type: 'show', i: 3, seq: 2, keep: [3, 2] })
  await settle()
  assert.equal(p.view.front, 'blob:1', 'slide 2 of 4 stays up meanwhile')
  assert.deepEqual(p.sent().filter(m => m.type === 'shown'), [{ type: 'shown', i: 1, seq: 1 }])
  p.pieces(3)
  await settle()
  assert.deepEqual(p.sent().filter(m => m.type === 'shown').at(-1), { type: 'shown', i: 3, seq: 2 })
})

test('only the window and the slide on screen are kept: the rest are revoked', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 0, seq: 1, keep: [0, 1] })
  p.pieces(0)
  p.pieces(1)
  await settle()
  p.sock().say({ type: 'show', i: 2, seq: 2, keep: [2, 3] })
  await settle()
  assert.deepEqual(p.revoked, ['blob:2'], 'slide 1 is still on screen until slide 2 is up')
  p.pieces(2)
  p.pieces(3)
  await settle()
  p.sock().say({ type: 'show', i: 3, seq: 3, keep: [3] })
  await settle()
  assert.deepEqual(p.revoked.sort(), ['blob:1', 'blob:2', 'blob:3'])
  assert.deepEqual(p.live(), ['blob:4'])
})

test('pieces out of order, out of bounds or malformed are dropped, and a slide outside the window is not kept', async () => {
  const p = page()
  p.deck(2)
  p.sock().say({ type: 'show', i: 0, seq: 1, keep: [0] })
  const b = chunkFrame(0, IMAGES[0], 64 * 1024)
  p.sock().onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) })
  const far = chunkFrame(5, Buffer.alloc(10), 0)
  p.sock().onmessage?.({ data: far.buffer.slice(far.byteOffset, far.byteOffset + far.length) })
  p.sock().onmessage?.({ data: new ArrayBuffer(8) })
  p.sock().onmessage?.({ data: new TextEncoder().encode('XXXX'.padEnd(20, 'x')).buffer })
  p.pieces(1)
  await settle()
  assert.equal(p.urls.size, 0)
  p.sock().say({ type: 'show', i: 7, seq: 2, keep: [7] })
  await settle()
  assert.equal(p.sent().filter(m => m.type === 'shown').length, 0)
})

test('a slide that cannot be decoded is reported as bad, and dropped', async () => {
  const p = page()
  p.deck()
  p.view.bad.add('blob:1')
  p.sock().say({ type: 'show', i: 1, seq: 1, keep: [1] })
  p.pieces(1)
  await settle()
  assert.deepEqual(p.sent().at(-1), { type: 'bad', i: 1 })
  assert.deepEqual(p.revoked, ['blob:1'])
})

test('a frame from the service: no slide shown; ended drops every slide; each is acknowledged', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 1, seq: 1, keep: [1] })
  p.pieces(1)
  await settle()
  p.sock().say({ type: 'frame', kind: 'paused', seq: 2 })
  assert.deepEqual(p.sent().at(-1), { type: 'framed', seq: 2 })
  assert.equal(p.view.frames.at(-1), 'paused')
  // The slide comes back with a show, from what it holds.
  p.sock().say({ type: 'show', i: 1, seq: 3, keep: [1] })
  await settle()
  assert.deepEqual(p.sent().at(-1), { type: 'shown', i: 1, seq: 3 })
  p.sock().say({ type: 'frame', kind: 'ended', seq: 4 })
  assert.deepEqual(p.live(), [])
  assert.equal(p.view.front, null)
})

test('a dropped link: the slide stays through a short blip, and the page comes back with what it holds', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 0, seq: 1, keep: [0, 1] })
  p.pieces(0)
  p.pieces(1)
  await settle()
  p.sock().drop()
  p.clock.tick(retryDelay(0, () => 1))
  assert.equal(p.sockets.made.length, 2)
  p.deck()
  assert.deepEqual(p.sent()[0], { type: 'hello', v: 1, rev: 'r1', have: '03' }, 'slides 1 and 2 held')
  assert.equal(p.view.front, 'blob:1')
  // A deck of another revision drops what the page held.
  p.sock().drop()
  p.clock.tick(retryDelay(0, () => 1))
  p.deck(IMAGES.length, 'r2')
  assert.deepEqual(p.sent()[0], { type: 'hello', v: 1, rev: 'r2', have: '00' })
  assert.deepEqual(p.live(), [])
})

test('with no link for 12 s the page shows "paused" and drops its slides; at 75 s it gives up and shows "ended"', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 2, seq: 1, keep: [2, 3] })
  p.pieces(2)
  p.pieces(3)
  await settle()
  assert.equal(p.view.front, 'blob:1')
  // The service goes quiet: no heartbeat. The page notices after SILENCE_MS, and keeps trying.
  p.clock.tick(SILENCE_MS)
  assert.ok(p.sockets.made[0].closed)
  p.clock.tick(BLANK_AFTER_MS - 1)
  assert.equal(p.view.front, 'blob:1', 'a blip under the grace keeps the slide')
  p.clock.tick(1)
  assert.equal(p.view.frames.at(-1), 'paused')
  assert.equal(p.view.front, null)
  assert.deepEqual(p.live(), [], 'no slide left at all')
  p.clock.tick(GIVE_UP_MS - BLANK_AFTER_MS)
  assert.equal(p.view.frames.at(-1), 'ended')
  const tries = p.sockets.made.length
  p.clock.tick(600_000)
  assert.equal(p.sockets.made.length, tries, 'it stopped trying')
  assert.equal(p.clock.pending, 0)
})

test('a link back within the grace cancels the blanking', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 0, seq: 1, keep: [0] })
  p.pieces(0)
  await settle()
  p.sock().drop()
  p.clock.tick(5000)
  p.deck()
  p.clock.tick(BLANK_AFTER_MS)
  assert.notEqual(p.view.frames.at(-1), 'paused')
  assert.equal(p.view.front, 'blob:1')
})

test('4000 (over) ends the page for good: ended, nothing kept, no more tries', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 0, seq: 1, keep: [0] })
  p.pieces(0)
  await settle()
  p.sock().drop(4000)
  assert.equal(p.view.frames.at(-1), 'ended')
  assert.deepEqual(p.live(), [])
  p.clock.tick(600_000)
  assert.equal(p.sockets.made.length, 1)
})

test('4001 (a newer link took its place) is not final: the page links again and takes its link back', async () => {
  const p = page()
  p.deck()
  p.sock().say({ type: 'show', i: 0, seq: 1, keep: [0] })
  p.pieces(0)
  await settle()
  p.sock().drop(4001)
  assert.notEqual(p.view.frames.at(-1), 'ended')
  p.clock.tick(retryDelay(0, () => 1))
  assert.equal(p.sockets.made.length, 2, 'it links again, with its usual wait')
  p.deck()
  assert.deepEqual(p.sent()[0], { type: 'hello', v: 1, rev: 'r1', have: '01' }, 'with the slide it holds')
  // The service's heartbeat goes on; the blanking the loss started does not come.
  for (let ms = 0; ms < BLANK_AFTER_MS + 2000; ms += 1000) {
    p.sock().say({ type: 'hb' })
    p.clock.tick(1000)
  }
  assert.equal(p.view.front, 'blob:1', 'the slide stays up: its link is back')
  assert.deepEqual(p.view.frames, ['starting'])
  assert.equal(p.sockets.made.length, 2)
})

test('a try that never gets the deck is given up on and tried again; the page sends nothing before the deck', () => {
  const p = page()
  p.clock.tick(5000)
  assert.ok(p.sockets.made[0].closed)
  assert.deepEqual(p.sockets.made[0].sent, [])
  p.clock.tick(retryDelay(0, () => 1))
  assert.equal(p.sockets.made.length, 2)
  p.slides.close()
  assert.equal(p.view.frames.at(-1), 'ended')
})
