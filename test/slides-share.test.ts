// A meeting's slide share through the service's real public listener: the routes while nothing is live (not found, as
// any other path), the page and its link with a live share's id and token, the upgrade checks in order, what goes to
// the page (the window only, in paced pieces), acks and timeouts, restarts as DELETE then POST, stuck, contested and
// camera-suspect stops, the limiter, and that nothing it does, with Recall or a socket failing at any step, reaches
// uncaughtException or unhandledRejection. Recall is a fake; the listeners and sockets are real.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'
import { ensureLocalToken } from '../src/local-token.ts'
import { STOP_SCREENSHARE } from '../src/recall.ts'
import { type ServiceConfig, type ServiceSession, createServers } from '../src/server.ts'
import { loadSlidesPage, slidesPageProblem } from '../src/slides/page.ts'
import {
  CHUNK_BYTES, CHUNK_HEADER_BYTES, LINK_CLOSE, type ShareControl, type ShareTiming, SlideShares, chunkFrame, readHave,
} from '../src/slides/share.ts'
import { identity } from '../src/identity.ts'
import { createSlides } from '../public/slides.js'

const PUBLIC = 'https://assistant.example.com'
const ORIGIN = { origin: PUBLIC }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await wait(10)
}

/** Distinct images: each byte says which slide it is, so a test can tell what arrived. */
const IMAGES = [70_000, 3_000, 140_000, 5_000, 9_000].map((size, i) => Buffer.alloc(size, i + 1))

/** Fast timings for the tests, unless one says otherwise. */
const FAST: Partial<ShareTiming> = { loadMs: 1500, ackMs: 300, postGapMs: 0, sendKbps: 200_000, deleteBackoffMs: [20, 40], upgradeGapMs: 0, cameraSuspectMs: 500 }

interface Recall {
  calls: { call: 'start' | 'stop'; url?: string; body?: unknown }[]
  start: (url: string) => Promise<number>
  stop: () => Promise<number>
}

/** A fake Recall: 200 to every POST and 204 to every DELETE, unless a test says otherwise. */
function fakeRecall(answers: { start?: (n: number) => Promise<number> | number; stop?: (n: number) => Promise<number> | number } = {}): Recall {
  const calls: Recall['calls'] = []
  let posts = 0
  let deletes = 0
  return {
    calls,
    start: url => {
      calls.push({ call: 'start', url })
      return Promise.resolve().then(() => (answers.start ? answers.start(posts++) : 200))
    },
    stop: () => {
      // Only the share: what recall.stopScreenshare sends.
      calls.push({ call: 'stop', body: STOP_SCREENSHARE })
      return Promise.resolve().then(() => (answers.stop ? answers.stop(deletes++) : 204))
    },
  }
}

async function service(t: TestContext, overrides: Partial<ServiceConfig> = {}) {
  const dataDir = fs.mkdtempSync(path.join('/tmp', 'av-sl-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const svc = createServers(
    {
      port: 0,
      host: '127.0.0.1',
      controlSocket: path.join(dataDir, 'control.sock'),
      publicUrl: PUBLIC,
      agentPageToken: 'p'.repeat(48),
      localToken: ensureLocalToken(dataDir),
      dataDir,
      maxMeetings: 5,
      maxMeetingMinutes: 180,
      slidesTiming: FAST,
      ...overrides,
    },
    {
      createBot: async () => ({ id: 'bot-1' }),
      leaveCall: async () => {},
      startSession: () => {
        throw new Error('no sessions here')
      },
    },
  )
  await svc.listen()
  t.after(() => svc.close())
  const port = (svc.publicServer.address() as AddressInfo).port
  return { svc, port }
}
type Svc = Awaited<ReturnType<typeof service>>

function get(port: number, p: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: 'localhost', ...headers } }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** What the page's side of a link saw: JSON messages and binary pieces, and how it closed. */
interface Page {
  outcome: 'open' | number | 'error'
  ws: WebSocket
  got: any[]
  pieces: Buffer[]
  closed: Promise<number>
}

function link(port: number, query: string, headers: Record<string, string> = ORIGIN): Promise<Page> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/slides-link?${query}`, { headers })
    const got: any[] = []
    const pieces: Buffer[] = []
    const closed = new Promise<number>(r => ws.on('close', code => r(code)))
    ws.on('message', (data, isBinary) => {
      if (isBinary) pieces.push(Buffer.from(data as Buffer))
      else got.push(JSON.parse(data.toString()))
    })
    const done = (outcome: Page['outcome']) => resolve({ outcome, ws, got, pieces, closed })
    ws.on('open', () => done('open'))
    ws.on('unexpected-response', (_req, res) => {
      done(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('error', () => done('error'))
  })
}

/** The id and token of the nth POST's page address, as a query for the link. */
function shareQuery(recall: Recall, n: number): string {
  const url = new URL(recall.calls.filter(c => c.call === 'start')[n].url!)
  return new URLSearchParams({ s: url.searchParams.get('s')!, t: url.searchParams.get('t')! }).toString()
}

/** The images a page got, reassembled from its pieces, by index. */
function assembled(pieces: Buffer[]): Map<number, Buffer> {
  const out = new Map<number, Buffer>()
  for (const p of pieces) {
    assert.equal(p.toString('latin1', 0, 4), 'AVSL')
    const i = p.readUInt16BE(6)
    const total = p.readUInt32BE(8)
    const offset = p.readUInt32BE(12)
    const body = p.subarray(CHUNK_HEADER_BYTES)
    assert.ok(body.length <= CHUNK_BYTES)
    const buf = out.get(i) ?? Buffer.alloc(total)
    body.copy(buf, offset)
    out.set(i, buf)
  }
  return out
}

/** Acts as the page: says hello on the deck message, and acknowledges each show (unless told not to). */
function actAsPage(page: Page, opts: { ack?: boolean; have?: string } = {}) {
  let rev = ''
  const handle = (msg: any) => {
    if (msg.type === 'deck') {
      rev = msg.rev
      page.ws.send(JSON.stringify({ type: 'hello', v: 1, rev, have: opts.have ?? '' }))
      page.ws.send(JSON.stringify({ type: 'diag', w: 1280, h: 720, dpr: 1, visibility: 'visible', ua_major: 130 }))
    }
    if (msg.type === 'show' && opts.ack !== false) page.ws.send(JSON.stringify({ type: 'shown', i: msg.i, seq: msg.seq }))
  }
  for (const msg of page.got) handle(msg)
  page.ws.on('message', (data, isBinary) => void (isBinary || handle(JSON.parse(data.toString()))))
}

/** A share started with slide `at`, its page linked and acting as the page: the share's control, its Recall and page. */
async function live(s: Svc, at = 0, opts: { recall?: Recall; ack?: boolean; also?: number[] } = {}) {
  const recall = opts.recall ?? fakeRecall()
  const control = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, start: recall.start, stop: recall.stop })
  const started = control.start(at, opts.also)
  await until(() => recall.calls.some(c => c.call === 'start'))
  const page = await link(s.port, shareQuery(recall, 0))
  assert.equal(page.outcome, 'open')
  actAsPage(page, { ack: opts.ack })
  return { control, recall, page, started }
}

function captureLogs(t: TestContext): string[] {
  const lines: string[] = []
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level]
    console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
    t.after(() => (console[level] = original))
  }
  return lines
}

// --- The routes while nothing is live ------------------------------------------------------------------------------

test('with no share live, /slides, /slides.js and /slides-link answer exactly as an unknown path does', async t => {
  const s = await service(t)
  const unknown = await get(s.port, '/nothing-here')
  for (const p of ['/slides', '/slides.js', '/slides?s=x&t=y', '/slides-link?s=x&t=y']) {
    const res = await get(s.port, p)
    assert.equal(res.status, 404, p)
    assert.equal(res.body, unknown.body)
    assert.deepEqual({ ...res.headers, date: '' }, { ...unknown.headers, date: '' }, p)
  }
  for (const headers of [ORIGIN, {}]) {
    const refused = await link(s.port, 's=x&t=y', headers)
    assert.equal(refused.outcome, 404, 'like any unknown path')
  }
  // A share made but not started opens nothing either.
  s.svc.slides.create({ botId: 'bot-1', images: IMAGES, start: async () => 200, stop: async () => 204 })
  assert.equal((await get(s.port, '/slides.js')).status, 404)
})

test('a live share opens the page with its id and token only, with its policy, and its script; neither once it stops', async t => {
  const s = await service(t)
  const { control, recall, started } = await live(s)
  assert.equal(await started, 'loaded')
  const query = shareQuery(recall, 0)
  const page = await get(s.port, `/slides?${query}`)
  assert.equal(page.status, 200)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  assert.equal(
    page.headers['content-security-policy'],
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; connect-src wss://assistant.example.com/slides-link; base-uri 'none'; form-action 'none'",
  )
  assert.match(page.body, /Alex, Sam's AI assistant, is about to present/)
  assert.doesNotMatch(page.body, /\{\{/)
  const script = await get(s.port, '/slides.js')
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type']!, /javascript/)
  const params = new URLSearchParams(query)
  for (const bad of [`s=${params.get('s')}&t=wrong`, `s=wrong&t=${params.get('t')}`, `s=${params.get('s')}`, '']) {
    assert.equal((await get(s.port, `/slides?${bad}`)).status, 404, bad)
  }
  await control.stop()
  for (const p of [`/slides?${query}`, '/slides.js']) assert.equal((await get(s.port, p)).status, 404, p)
})

test('the link: the Origin first (a filter), then the token, then one a second; the page origin and token let it in', async t => {
  const s = await service(t, { slidesTiming: { ...FAST, upgradeGapMs: 1000 } })
  const recall = fakeRecall()
  const control = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, start: recall.start, stop: recall.stop })
  void control.start(0)
  await until(() => recall.calls.length > 0)
  const query = new URLSearchParams(shareQuery(recall, 0))
  const good = query.toString()
  assert.equal((await link(s.port, good, {})).outcome, 403, 'no Origin: not a browser page')
  assert.equal((await link(s.port, good, { origin: 'https://evil.example' })).outcome, 403)
  assert.equal((await link(s.port, `s=${query.get('s')}&t=${'x'.repeat(43)}`)).outcome, 403)
  assert.equal((await link(s.port, `s=${'y'.repeat(22)}&t=${query.get('t')}`)).outcome, 403)
  const first = await link(s.port, good)
  assert.equal(first.outcome, 'open')
  assert.equal((await link(s.port, good)).outcome, 429, 'one a second')
  await until(() => first.got.length > 0)
  assert.equal(first.got[0].type, 'deck')
  assert.equal(first.got[0].count, IMAGES.length)
  control.close()
  assert.equal(await first.closed, LINK_CLOSE.over)
})

test('the upgrade checks run in the design order: stopping (503) after the token, revoked (403) after that', async t => {
  let stopping = false
  const shares = new SlideShares({ publicUrl: PUBLIC, page: loadSlidesPage(identity), stopping: () => stopping, timing: FAST })
  const server = http.createServer((_req, res) => res.end())
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, 'http://x')
    const refuse = (sock: typeof socket, status: number, reason: string) => sock.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Length: ${reason.length}\r\n\r\n${reason}`)
    if (!shares.upgrade(req, socket, head, url, { handOver: () => {}, refuse })) refuse(socket, 404, 'not found')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  t.after(() => (shares.closeAll(), server.close()))
  const port = (server.address() as AddressInfo).port
  const recall = fakeRecall()
  const control = shares.create({ botId: 'bot-1', images: IMAGES, start: recall.start, stop: recall.stop })
  void control.start(0)
  await until(() => recall.calls.length > 0)
  const query = shareQuery(recall, 0)
  stopping = true
  assert.equal((await link(port, query, { origin: 'https://evil.example' })).outcome, 403, 'the Origin before stopping')
  assert.equal((await link(port, query.replace(/t=[^&]+/, 't=nope'))).outcome, 403, 'the token before stopping')
  assert.equal((await link(port, query)).outcome, 503)
  stopping = false
  // A second share is live; the first one's token is revoked.
  await control.stop()
  void control.start(0)
  await until(() => recall.calls.filter(c => c.call === 'start').length === 2)
  assert.equal((await link(port, query)).outcome, 403, 'revoked')
  assert.equal((await link(port, shareQuery(recall, 1))).outcome, 'open')
})

// --- What goes to the page ---------------------------------------------------------------------------------------

test('a start: the page gets the deck, then only the slide and its neighbours, in pieces, and the ack loads it', async t => {
  const s = await service(t)
  const { control, recall, page, started } = await live(s, 2)
  assert.equal(await started, 'loaded')
  assert.equal(control.state, 'loaded')
  const url = new URL(recall.calls[0].url!)
  assert.equal(`${url.origin}${url.pathname}`, `${PUBLIC}/slides`)
  assert.deepEqual([...url.searchParams.keys()], ['s', 't'])
  assert.equal(Buffer.from(url.searchParams.get('s')!, 'base64url').length, 16)
  assert.equal(Buffer.from(url.searchParams.get('t')!, 'base64url').length, 32)
  assert.deepEqual(page.got.map(m => m.type).filter(k => k !== 'hb'), ['deck', 'show'])
  assert.deepEqual(page.got[1], { type: 'show', i: 2, seq: page.got[1].seq, keep: [2, 1, 3] })
  await until(() => assembled(page.pieces).size === 3)
  const got = assembled(page.pieces)
  assert.deepEqual([...got.keys()], [2, 1, 3], 'the slide first, then its neighbours: never the rest')
  for (const [i, image] of got) assert.ok(image.equals(IMAGES[i]), `slide ${i}`)
  assert.ok(page.pieces.filter(p => p.readUInt16BE(6) === 2).length >= 3, '140 KB goes in 64 KiB pieces')
  // A show with the neighbours the presenter names: only what the page lacks.
  const shown = control.show(4, [3, 0])
  assert.equal(await shown, 'shown')
  await until(() => assembled(page.pieces).has(4) && assembled(page.pieces).has(0))
  assert.equal(page.pieces.filter(p => p.readUInt16BE(6) === 3).length, 1, 'slide 3 was not sent again')
  control.close()
})

test('the pieces are paced: at 2 Mbit/s a 140 KB slide takes about half a second, not one burst', async t => {
  const s = await service(t, { slidesTiming: { ...FAST, sendKbps: 2000, loadMs: 5000 } })
  const { control, page, started } = await live(s, 2, { also: [] })
  const t0 = Date.now()
  assert.equal(await started, 'loaded')
  await until(() => assembled(page.pieces).has(2) && page.pieces.length >= 3, 500)
  const ms = Date.now() - t0
  assert.ok(ms >= 400, `${ms} ms`)
  control.close()
})

test("a page's hello says what it has: only the rest of the window is sent", async t => {
  const s = await service(t)
  const recall = fakeRecall()
  const control = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, start: recall.start, stop: recall.stop })
  const started = control.start(2)
  await until(() => recall.calls.length > 0)
  const page = await link(s.port, shareQuery(recall, 0))
  await until(() => page.got.length > 0)
  // It holds slides 1 and 2 of this deck: bits 1 and 2.
  actAsPage(page, { have: '06' })
  assert.equal(await started, 'loaded')
  await until(() => assembled(page.pieces).has(3))
  assert.deepEqual([...assembled(page.pieces).keys()], [3])
  assert.deepEqual([...readHave('06', 5)], [1, 2])
  assert.deepEqual([...readHave('ff', 3)], [0, 1, 2])
  assert.deepEqual([...readHave('zz', 5)], [])
  control.close()
})

test('a show resolves on its ack, or times out; the first miss restarts the share as DELETE then a fresh POST; three stop it', async t => {
  const s = await service(t)
  const { control, recall, page, started } = await live(s, 0)
  assert.equal(await started, 'loaded')
  const stuck: string[] = []
  control.on('stuck', () => void stuck.push('stuck'))
  // The page stops acknowledging.
  page.ws.removeAllListeners('message')
  assert.equal(await control.show(1), 'timeout')
  await until(() => recall.calls.filter(c => c.call === 'start').length === 2)
  assert.deepEqual(recall.calls.map(c => c.call), ['start', 'stop', 'start'], 'DELETE, then a fresh POST: never a second POST over a live share')
  assert.notEqual(shareQuery(recall, 1), shareQuery(recall, 0), 'a new id and token')
  assert.equal(await page.closed, LINK_CLOSE.over, 'the old page is told it is over')
  assert.equal(await control.show(1), 'timeout')
  assert.equal(await control.show(2), 'timeout')
  await until(() => stuck.length > 0)
  assert.deepEqual(stuck, ['stuck'])
  assert.equal(control.state, 'off')
  assert.equal(recall.calls.at(-1)!.call, 'stop')
  assert.deepEqual(recall.calls.at(-1)!.body, { screenshare: true })
})

test('the newest link wins (4001), and more than two take-overs within a minute is contested: stopped, and no more shares', async t => {
  const s = await service(t)
  const { control, recall, page, started } = await live(s, 0)
  assert.equal(await started, 'loaded')
  const events: string[] = []
  control.on('contested', () => void events.push('contested'))
  const query = shareQuery(recall, 0)
  const second = await link(s.port, query)
  assert.equal(second.outcome, 'open')
  assert.equal(await page.closed, LINK_CLOSE.replaced)
  const third = await link(s.port, query)
  assert.equal(await second.closed, LINK_CLOSE.replaced)
  assert.equal(third.outcome, 'open')
  const fourth = await link(s.port, query)
  assert.equal(fourth.outcome, 'open')
  await until(() => events.length > 0)
  assert.deepEqual(events, ['contested'])
  assert.equal(recall.calls.at(-1)!.call, 'stop')
  assert.equal(await control.start(0), 'disabled')
  assert.equal(recall.calls.filter(c => c.call === 'start').length, 1)
})

/** The bot's page: the real public/slides.js, over real sockets that send the public Origin, as the bot's browser does. */
function botPage(port: number, query: string) {
  const sockets: WebSocket[] = []
  class Socket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: ORIGIN })
      this.on('error', () => {})
      sockets.push(this)
    }
  }
  const frames: string[] = []
  const shown: string[] = []
  let made = 0
  let loading = ''
  const view = {
    async load(u: string) {
      loading = u
    },
    swap() {
      shown.push(loading)
    },
    frame(kind: string) {
      frames.push(kind)
    },
    clear() {},
    diag: () => ({ w: 1280, h: 720, dpr: 1, visibility: 'visible', ua_major: 130 }),
  }
  const page = createSlides(`ws://127.0.0.1:${port}/slides-link?${query}`, view, {
    WebSocket: Socket as any,
    createObjectURL: () => `blob:${++made}`,
    revokeObjectURL: () => {},
  })
  return { page, frames, shown, sockets }
}

test("someone else who takes the link once is cut off: the bot's page links again and takes it back, and it is logged", async t => {
  const logs = captureLogs(t)
  const s = await service(t, { slidesTiming: { ...FAST, ackMs: 2000, upgradeGapMs: 300 } })
  const recall = fakeRecall()
  const control = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, start: recall.start, stop: recall.stop })
  const events: string[] = []
  for (const e of ['contested', 'stuck', 'failed'] as const) control.on(e, () => void events.push(e))
  const started = control.start(0)
  await until(() => recall.calls.length > 0)
  const query = shareQuery(recall, 0)
  const bot = botPage(s.port, query)
  t.after(() => bot.page.close())
  assert.equal(await started, 'loaded')
  await wait(350)
  // Whoever else holds the address links once, after the gap, and acknowledges what it is told to show.
  const holder = await link(s.port, query)
  assert.equal(holder.outcome, 'open')
  actAsPage(holder)
  assert.equal(await holder.closed, LINK_CLOSE.replaced, 'the bot page took its link back')
  for (const i of [1, 2, 3, 4]) assert.equal(await control.show(i), 'shown', `slide ${i}`)
  assert.equal(bot.shown.length, 5, 'the bot page showed each slide, the first included')
  assert.ok(!bot.frames.includes('ended'), JSON.stringify(bot.frames))
  assert.ok(bot.sockets.length >= 2)
  assert.deepEqual([...assembled(holder.pieces).keys()].filter(i => i > 1), [], 'the holder got the window it linked in, and nothing later')
  assert.deepEqual(events, [])
  assert.equal(control.state, 'loaded')
  assert.deepEqual(recall.calls.map(c => c.call), ['start'])
  const text = logs.join('\n')
  assert.match(text, /share 1's link was taken over by a newer one \(1 in 60 s\)/)
  assert.match(text, /share 1's link was taken over by a newer one \(2 in 60 s\)/)
  assert.doesNotMatch(text, /assistant\.example\.com|origin/i)
  control.close()
})

test("someone else who takes the link again each time it is cut off ends the share as contested: stopped, no more shares", async t => {
  captureLogs(t)
  const s = await service(t, { slidesTiming: { ...FAST, upgradeGapMs: 300 } })
  const recall = fakeRecall()
  const control = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, start: recall.start, stop: recall.stop })
  const events: string[] = []
  control.on('contested', () => void events.push('contested'))
  const started = control.start(0)
  await until(() => recall.calls.length > 0)
  const query = shareQuery(recall, 0)
  const bot = botPage(s.port, query)
  t.after(() => bot.page.close())
  assert.equal(await started, 'loaded')
  let holders = 0
  while (!events.length && holders < 6) {
    await wait(350)
    const holder = await link(s.port, query)
    if (holder.outcome !== 'open') break
    holders++
    actAsPage(holder)
    await Promise.race([holder.closed, until(() => events.length > 0)])
  }
  await until(() => events.length > 0)
  assert.deepEqual(events, ['contested'])
  assert.ok(holders <= 2, `${holders} links`)
  assert.equal(control.state, 'off')
  assert.deepEqual(recall.calls.map(c => c.call), ['start', 'stop'])
  assert.equal(await control.start(0), 'disabled')
  // The DELETE takes the bot's page out of the meeting; without its link the page blanks on its own timers.
})

test('stop(): the ended frame goes before the link closes, then the DELETE with exactly {"screenshare":true}; the token is dead', async t => {
  const s = await service(t)
  const { control, recall, page, started } = await live(s, 0)
  assert.equal(await started, 'loaded')
  const query = shareQuery(recall, 0)
  await control.stop()
  assert.equal(await page.closed, LINK_CLOSE.over)
  const frames = page.got.filter(m => m.type === 'frame')
  assert.deepEqual(frames.map(f => f.kind), ['ended'])
  assert.deepEqual(recall.calls.map(c => c.call), ['start', 'stop'])
  assert.equal(JSON.stringify(recall.calls[1].body), '{"screenshare":true}')
  assert.equal(control.state, 'off')
  // Nothing is live now, so the link is not found at all.
  assert.equal((await link(s.port, query)).outcome, 404)
})

test('a DELETE Recall does not take is tried again until it does; 404 counts as stopped', async t => {
  const s = await service(t)
  const recall = fakeRecall({ stop: n => (n < 2 ? 503 : 404) })
  const { control, started } = await live(s, 0, { recall })
  assert.equal(await started, 'loaded')
  await control.stop()
  assert.deepEqual(recall.calls.map(c => c.call), ['start', 'stop', 'stop', 'stop'])
})

test('close(): the page is blanked and its link closed, with no call to Recall (the bot is leaving)', async t => {
  const s = await service(t)
  const { control, recall, page, started } = await live(s, 0)
  assert.equal(await started, 'loaded')
  control.close()
  assert.equal(await page.closed, LINK_CLOSE.over)
  assert.deepEqual(page.got.filter(m => m.type === 'frame').map(f => f.kind), ['ended'])
  assert.deepEqual(recall.calls.map(c => c.call), ['start'])
  assert.equal(await control.start(0), 'disabled')
  assert.equal(await control.show(1), 'timeout')
})

test('a refused POST fails the start; one Recall could not take is tried once more, with the same address', async t => {
  const s = await service(t)
  const refused = fakeRecall({ start: () => 403 })
  const a = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, start: refused.start, stop: refused.stop })
  assert.equal(await a.start(0), 'failed')
  assert.equal(refused.calls.length, 1)
  assert.equal(a.state, 'off')
  const flaky = fakeRecall({
    start: n => {
      if (n === 0) throw Object.assign(new (class RecallError extends Error {})('busy'), { status: 503 })
      return 200
    },
  })
  const { control, started } = await live(s, 0, { recall: flaky })
  assert.equal(await started, 'loaded')
  const posts = flaky.calls.filter(c => c.call === 'start')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].url, posts[1].url, 'the retry is the same request')
  control.close()
})

test('a page that never shows the first slide: the share is stopped (DELETE), and the start says not_loading', async t => {
  const s = await service(t)
  const recall = fakeRecall()
  const logs = captureLogs(t)
  const control = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, start: recall.start, stop: recall.stop })
  assert.equal(await control.start(0), 'not_loading')
  assert.deepEqual(recall.calls.map(c => c.call), ['start', 'stop'])
  assert.ok(logs.some(l => /did not show its first slide .*it reached posted/.test(l)), logs.join('\n'))
})

test('our own limit: at least postGapMs between POSTs, and so many an hour', async t => {
  const s = await service(t, { slidesTiming: { ...FAST, postGapMs: 60_000 } })
  const { control, started } = await live(s, 0)
  assert.equal(await started, 'loaded')
  await control.stop()
  assert.equal(await control.start(0), 'rate_limited')
  const s2 = await service(t, { slidesTiming: { ...FAST, postsPerHour: 1 } })
  const second = await live(s2, 0)
  assert.equal(await second.started, 'loaded')
  await second.control.stop()
  assert.equal(await second.control.start(0), 'rate_limited')
})

test('the camera page dropping right after a share change is suspect: no more shares; later, nothing', async t => {
  const s = await service(t)
  const { control, started } = await live(s, 0)
  assert.equal(await started, 'loaded')
  const events: string[] = []
  control.on('camera_suspect', () => void events.push('camera_suspect'))
  control.cameraDropped()
  assert.deepEqual(events, ['camera_suspect'])
  await control.stop()
  assert.equal(await control.start(0), 'disabled')
  const s2 = await service(t)
  const later = await live(s2, 0)
  assert.equal(await later.started, 'loaded')
  const none: string[] = []
  later.control.on('camera_suspect', () => void none.push('x'))
  await wait(600)
  later.control.cameraDropped()
  assert.deepEqual(none, [])
  later.control.close()
})

test('the link takes small JSON only, at most 20 a second: anything else closes it', async t => {
  const s = await service(t)
  const { control, recall, started } = await live(s, 0)
  assert.equal(await started, 'loaded')
  const query = shareQuery(recall, 0)
  const big = await link(s.port, query)
  big.ws.send(JSON.stringify({ type: 'diag', pad: 'x'.repeat(2000) }))
  assert.equal(await big.closed, 1009)
  for (const bad of [Buffer.from([1, 2, 3]), 'not json', '[1]']) {
    const page = await link(s.port, query)
    page.ws.send(bad)
    assert.equal(await page.closed, LINK_CLOSE.refused, String(bad))
  }
  const chatty = await link(s.port, query)
  for (let i = 0; i < 25; i++) chatty.ws.send(JSON.stringify({ type: 'framed', seq: i }))
  assert.equal(await chatty.closed, LINK_CLOSE.refused)
  control.close()
})

test('no HTTP path ever serves slide bytes: the images go only over the link', async t => {
  const s = await service(t)
  const { control, recall, started } = await live(s, 0)
  assert.equal(await started, 'loaded')
  for (const p of [`/slides?${shareQuery(recall, 0)}`, '/slides.js', '/slides/001.webp', '/001.webp', '/slides-link']) {
    const res = await get(s.port, p)
    assert.ok(!res.body.includes(IMAGES[0].subarray(0, 64).toString('latin1')), p)
    assert.doesNotMatch(String(res.headers['content-type']), /image/, p)
  }
  control.close()
})

test('nothing a failing Recall or socket does reaches uncaughtException or unhandledRejection', async t => {
  const caught: unknown[] = []
  const onError = (err: unknown) => void caught.push(err)
  process.on('uncaughtException', onError)
  process.on('unhandledRejection', onError)
  t.after(() => {
    process.off('uncaughtException', onError)
    process.off('unhandledRejection', onError)
  })
  const logs = captureLogs(t)
  const s = await service(t)
  // Recall throws as the call is made, and rejects, on POST and DELETE.
  const throwing = {
    start: () => {
      throw new Error('sync throw')
    },
    stop: () => {
      throw new Error('sync throw')
    },
  }
  const a = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, ...throwing })
  assert.equal(await a.start(0), 'failed')
  const rejecting = { start: () => Promise.reject(new Error('rejected')), stop: () => Promise.reject(new Error('rejected')) }
  const b = s.svc.slides.create({ botId: 'bot-1', images: IMAGES, ...rejecting })
  assert.equal(await b.start(0), 'failed')
  // A DELETE that never works: stop() keeps trying until close(), and never throws.
  const recall = fakeRecall({ stop: () => Promise.reject(new Error('down')) })
  const { control, page, started } = await live(s, 0, { recall })
  assert.equal(await started, 'loaded')
  const stopping = control.stop()
  await wait(100)
  control.close()
  await stopping
  // A listener that throws, a socket that throws on send, and messages that fail.
  const c = await live(s, 0)
  assert.equal(await c.started, 'loaded')
  c.control.on('stuck', () => {
    throw new Error('listener')
  })
  c.page.ws.removeAllListeners('message')
  const ws = [...s.svc.slides.wss.clients].at(-1)!
  ws.send = () => {
    throw new Error('send failed')
  }
  for (let i = 0; i < 3; i++) await c.control.show(i % IMAGES.length)
  c.page.ws.send('not json')
  c.page.ws.terminate()
  await wait(200)
  c.control.close()
  assert.ok(page)
  assert.deepEqual(caught, [])
  // And the log holds no id, token, address or content.
  const text = logs.join('\n')
  assert.doesNotMatch(text, /assistant\.example\.com|[?&][st]=|base64|sync throw|rejected|send failed/)
})

test('the logs carry bot ids, share numbers, states, slide numbers and statuses only: never an id, token or address', async t => {
  const logs = captureLogs(t)
  const s = await service(t)
  const { control, recall, page, started } = await live(s, 1)
  assert.equal(await started, 'loaded')
  page.ws.removeAllListeners('message')
  await control.show(3)
  await control.stop()
  const text = logs.join('\n')
  for (const call of recall.calls.filter(c => c.url)) {
    const url = new URL(call.url!)
    for (const secret of [url.searchParams.get('s')!, url.searchParams.get('t')!, url.href]) assert.ok(!text.includes(secret))
  }
  assert.doesNotMatch(text, /https?:\/\//)
  assert.match(text, /\[slides\] bot bot-1: share 1: Recall answered 200/)
  assert.match(text, /\[slides\] bot bot-1: share 1's page: 1280x720, dpr 1, visible, browser 130/)
})

test('the shipped page passes its checks, and each forbidden thing is caught', () => {
  const page = loadSlidesPage(identity)
  assert.equal(page.problem, '')
  const html = fs.readFileSync(path.join(import.meta.dirname, '../public/slides.html'), 'utf8')
  const js = fs.readFileSync(path.join(import.meta.dirname, '../public/slides.js'), 'utf8')
  assert.equal(slidesPageProblem(html, js), '')
  for (const [bad, what] of [
    ['const a = new AudioContext()', /AudioContext/],
    ['navigator.mediaDevices.getUserMedia({audio: true})', /microphone/],
    ["import('/agent.js')", /camera page/],
    ["new WebSocket('/audio')", /camera page/],
    ['requestAnimationFrame(tick)', /animation/],
    ["localStorage.setItem('x', 1)", /storage/],
    ['location.reload()', /reload/],
    ["location.href = '/x'", /reload/],
  ] as const) {
    assert.match(slidesPageProblem(html, `${js}\n${bad}`), what, bad)
  }
  assert.match(slidesPageProblem(html.replace('<audio', '').replace('</body>', '<audio></audio></body>'), js), /audio, video/)
  assert.match(slidesPageProblem(html.replace(/(id="paused">[\s\S]*?)AI assistant/, '$1assistant'), js), /"paused" frame .* AI/)
  assert.match(slidesPageProblem(html.replace('<script type="module" src="/slides.js"></script>', '<script>1</script>'), js), /load \/slides\.js/)
})

test('pieces carry their slide, the image length and their offset', () => {
  const image = Buffer.alloc(CHUNK_BYTES + 10, 7)
  const first = chunkFrame(3, image, 0)
  const second = chunkFrame(3, image, CHUNK_BYTES)
  assert.equal(first.length, CHUNK_HEADER_BYTES + CHUNK_BYTES)
  assert.equal(second.length, CHUNK_HEADER_BYTES + 10)
  assert.deepEqual([...assembled([first, second]).keys()], [3])
  assert.ok(assembled([first, second]).get(3)!.equals(image))
})

// So the types stay in use.
export type { ShareControl, ServiceSession }
