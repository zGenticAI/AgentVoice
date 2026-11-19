// The screen-share test through the service: /api/join's share_test, the control endpoints and their guards, the test
// page and its link on the public listener as a stranger, Recall's bot or a replaced connection would meet them, what the
// camera page does meanwhile, and that none of it reaches a meeting without the test or takes the service down. Recall and
// the meeting sessions are fakes; the listeners are real.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'
import { ROOT } from '../src/config.ts'
import { ensureLocalToken } from '../src/local-token.ts'
import type { SessionOptions } from '../src/pipeline/session.ts'
import type { BotPlan } from '../src/recall.ts'
import { type ServiceConfig, type ServiceSession, createServers } from '../src/server.ts'
import { loadShareTestPage, shareTestPageProblem } from '../src/sharetest/page.ts'
import { type ShareTestStatus, type TestLineOutcome, testLine } from '../src/sharetest/protocol.ts'
import { originOf } from '../src/sharetest/share-test.ts'

const PAGE_TOKEN = 'p'.repeat(48)
const ZOOM = 'https://us06web.zoom.us/j/123456789?pwd=abc'
const PUBLIC = 'https://assistant.example.com'
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await wait(10)
}
// A Unix socket's path is short, so the folders are made in /tmp.
function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join('/tmp', 'av-st-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

let secrets = 0

/** Stands in for a MeetingSession: 'ready' with its secret on each connection, and the share test's three members. */
class FakeSession implements ServiceSession {
  readonly transcript = { recent: () => '' }
  readonly over: Promise<void>
  readonly rejoin = `rejoin-secret-${++secrets}-${'s'.repeat(24)}`
  private resolveOver!: () => void
  ws!: WebSocket
  ended = false
  leftMeeting = false
  spoke = false
  consentDone = true
  readonly said: string[] = []
  sayOutcome: () => Promise<TestLineOutcome> = async () => 'played'
  leaves = 0
  leaveAsAsked?: () => void = () => {
    this.leaves++
    this.leftMeeting = true
    this.end()
  }
  constructor(
    ws: WebSocket,
    readonly opts: SessionOptions,
  ) {
    this.over = new Promise(resolve => (this.resolveOver = resolve))
    this.wire(ws)
  }
  private wire(ws: WebSocket) {
    this.ws = ws
    ws.send(JSON.stringify({ type: 'ready', sampleRate: 16000, rejoin: this.rejoin }))
    ws.on('message', () => void (this.spoke = true))
  }
  get botId() {
    return this.opts.botId
  }
  addToBrief() {
    return { ok: true }
  }
  async postChat() {
    return true
  }
  whyNotAnswered() {
    return { ok: true, lines: [] }
  }
  resumes(secret: string) {
    if (this.ended || this.leftMeeting) return false
    return secret ? secret === this.rejoin : !this.spoke
  }
  attach(ws: WebSocket) {
    const old = this.ws
    this.wire(ws)
    if (old.readyState !== WebSocket.CLOSED) old.terminate()
  }
  end() {
    if (this.ended) return
    this.ended = true
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(4000, 'over')
    this.resolveOver()
  }
  async reachedTimeLimit() {}
  sayTestLine(text: string) {
    this.said.push(text)
    return this.sayOutcome()
  }
}

interface Fakes {
  /** Recall's answer to a share POST (200 unless set), or a throw. */
  start?: (url: string) => Promise<number> | number
  stop?: () => Promise<number> | number
}

async function start(t: TestContext, overrides: Partial<ServiceConfig> = {}, fakes: Fakes = {}) {
  const dataDir = tempDir(t)
  const localToken = ensureLocalToken(dataDir)
  const control = path.join(dataDir, 'control.sock')
  const plans: BotPlan[] = []
  const left: string[] = []
  const started: FakeSession[] = []
  /** Every share call Recall got, in order. */
  const recall: { call: 'start' | 'stop'; botId: string; url?: string }[] = []
  const service = createServers(
    {
      port: 0,
      host: '127.0.0.1',
      controlSocket: control,
      publicUrl: PUBLIC,
      agentPageToken: PAGE_TOKEN,
      localToken,
      dataDir,
      maxMeetings: 5,
      maxMeetingMinutes: 180,
      shareTestTiming: { helloWaitMs: 400, lingerMs: 300, sayWaitMs: 300 },
      ...overrides,
    },
    {
      createBot: async plan => {
        plans.push(plan)
        return { id: `bot-${plans.length}` }
      },
      leaveCall: async botId => void left.push(botId),
      startSession: (ws, opts) => {
        const session = new FakeSession(ws, opts)
        started.push(session)
        return session
      },
      // Not async: a fake that throws, throws as the call is made.
      screenshare: {
        start: (botId, url) => {
          recall.push({ call: 'start', botId, url })
          return Promise.resolve(fakes.start ? fakes.start(url) : 200)
        },
        stop: botId => {
          recall.push({ call: 'stop', botId })
          return Promise.resolve(fakes.stop ? fakes.stop() : 204)
        },
      },
    },
  )
  await service.listen()
  t.after(() => service.close())
  const publicPort = (service.publicServer.address() as AddressInfo).port
  const auth = { authorization: `Bearer ${localToken}` }
  const keyOf = (n: number) => new URL(plans[n].pageUrl).searchParams.get('key')!
  /** The token in the nth share's page address. */
  const tokenOf = (n: number) => new URL(recall.filter(r => r.call === 'start')[n].url!).searchParams.get('t')!
  return { service, publicPort, control, dataDir, localToken, auth, plans, left, started, recall, keyOf, tokenOf }
}
type Started = Awaited<ReturnType<typeof start>>

function request(
  target: number | string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const where = typeof target === 'number' ? { host: '127.0.0.1', port: target } : { socketPath: target }
    const req = http.request({ ...where, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: { host: 'localhost', ...opts.headers } }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const json = { 'content-type': 'application/json' }
const join = (s: Started, body: object = { meetingUrl: ZOOM, share_test: true }) =>
  request(s.control, { method: 'POST', path: '/api/join', headers: { ...json, ...s.auth }, body: JSON.stringify(body) })
const act = async (s: Started, action: string, bot = 'bot-1', headers: Record<string, string> = s.auth) => {
  const res = await request(s.control, { method: 'POST', path: '/api/share-test/action', headers: { ...json, ...headers }, body: JSON.stringify({ bot_id: bot, action, step: 'S2' }) })
  return { ...res, result: res.status === 200 ? JSON.parse(res.body) : null }
}
const statusOf = async (s: Started, bot = 'bot-1'): Promise<ShareTestStatus> => {
  const res = await request(s.control, { path: `/api/share-test/status?bot=${bot}`, headers: s.auth })
  assert.equal(res.status, 200, res.body)
  return JSON.parse(res.body)
}

/** Opens a websocket: 'open' (with the socket and what it was sent), or the HTTP status it was refused with. */
function upgrade(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ outcome: 'open' | number | 'error'; ws: WebSocket; got: any[]; code: () => Promise<number> }>(resolve => {
    const ws = new WebSocket(url, { headers })
    const got: any[] = []
    ws.on('message', (data, isBinary) => void (isBinary || got.push(JSON.parse(data.toString()))))
    const code = () => new Promise<number>(r => (ws.readyState === WebSocket.CLOSED ? r(-1) : ws.once('close', c => r(c))))
    const done = (outcome: 'open' | number | 'error') => resolve({ outcome, ws, got, code })
    ws.on('open', () => done('open'))
    ws.on('unexpected-response', (_req, res) => {
      done(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('error', () => done('error'))
  })
}

const linkUrl = (s: Started, token: string) => `ws://127.0.0.1:${s.publicPort}/share-test-link?t=${encodeURIComponent(token)}`
const pagePath = (token: string) => `/share-test?t=${encodeURIComponent(token)}`
const ORIGIN = { origin: PUBLIC }
const HELLO = { type: 'hello', viewport: { width: 1280, height: 720 }, dpr: 1, visibility: 'visible', chromeMajor: 126 }

/** The camera page of the nth meeting on /audio, as the bot page opens it. */
function cameraPage(s: Started, n: number, more: Record<string, string> = {}) {
  const params = new URLSearchParams({ key: s.keyOf(n), token: PAGE_TOKEN, n: '0', ...more })
  return upgrade(`ws://127.0.0.1:${s.publicPort}/audio?${params}`)
}

/** A meeting joined with the test, its camera page connected, and a share on: its first link open and hello said. */
async function sharing(s: Started) {
  assert.equal((await join(s)).status, 200)
  const camera = await cameraPage(s, 0)
  assert.equal(camera.outcome, 'open')
  await until(() => s.started.length > 0)
  const shared = await act(s, 'share')
  assert.equal(shared.status, 200)
  const link = await upgrade(linkUrl(s, s.tokenOf(0)), ORIGIN)
  assert.equal(link.outcome, 'open')
  link.ws.send(JSON.stringify(HELLO))
  for (let i = 0; i < 100 && (await statusOf(s)).state !== 'live'; i++) await wait(10)
  return { camera, link }
}

// --- /api/join: only it can ask, and only with true or false -----------------------------------------------------

test('/api/join takes share_test as true or false only, says so in its answer, and the service advertises it', async t => {
  const s = await start(t)
  for (const bad of ['yes', 1, {}, 'true']) {
    const refused = await join(s, { meetingUrl: ZOOM, share_test: bad })
    assert.equal(refused.status, 400, String(bad))
    assert.equal(refused.body, 'share_test has to be true or false.')
  }
  assert.equal(s.plans.length, 0)
  const on = await join(s)
  assert.equal(on.status, 200)
  assert.equal(JSON.parse(on.body).share_test, true)
  for (const off of [false, null, undefined]) {
    const plain = await join(s, { meetingUrl: ZOOM, share_test: off })
    assert.equal(plain.status, 200)
    assert.deepEqual(Object.keys(JSON.parse(plain.body)).sort(), ['bot_id', 'brief', 'brief_note', 'platform', 'speaker_probe', 'tip'], 'the answer is what it always was')
    assert.equal((await request(s.control, { path: `/api/share-test/status?bot=${JSON.parse(plain.body).bot_id}`, headers: s.auth })).status, 404)
  }
  // The bot is asked for exactly the same, with the test or without it: the share starts mid-call.
  assert.deepEqual(Object.keys(s.plans[0]).sort(), ['meetingUrl', 'pageUrl'])
  assert.deepEqual(Object.keys(s.plans[1]).sort(), ['meetingUrl', 'pageUrl'])
  const health = JSON.parse((await request(s.control, { path: '/health' })).body)
  assert.ok(health.features.includes('share_test'))
})

test("join_meeting from the channel can't turn the share test on, whatever it sends", async t => {
  const s = await start(t)
  const ws = new WebSocket('ws://localhost/bridge', { headers: s.auth, createConnection: () => net.connect(s.control) })
  const acks: any[] = []
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'ack') acks.push(msg)
  })
  await new Promise(r => ws.once('open', r))
  ws.send(JSON.stringify({ type: 'join_meeting', request_id: 'j1', meeting_url: ZOOM, share_test: true }))
  await until(() => acks.length > 0)
  assert.equal(acks[0].ok, true)
  assert.equal(s.plans.length, 1)
  assert.equal((await request(s.control, { path: '/api/share-test/status?bot=bot-1', headers: s.auth })).status, 404)
  assert.equal((await act(s, 'share')).status, 404)
  assert.equal(s.recall.length, 0)
  ws.close()
})

// --- The control endpoints: the same guards as /api/join -----------------------------------------------------------

test('the control endpoints need the local token, refuse a web page, and are not on the public port', async t => {
  const s = await start(t)
  assert.equal((await join(s)).status, 200)
  const statusPath = '/api/share-test/status?bot=bot-1'
  assert.equal((await request(s.control, { path: statusPath })).status, 401)
  assert.equal((await request(s.control, { path: statusPath, headers: { authorization: `Bearer ${'x'.repeat(64)}` } })).status, 401)
  assert.equal((await request(s.control, { path: statusPath, headers: { ...s.auth, origin: 'http://localhost' } })).status, 403)
  assert.equal((await act(s, 'share', 'bot-1', {})).status, 401)
  assert.equal((await act(s, 'share', 'bot-1', { ...s.auth, origin: 'https://evil.example' })).status, 403)
  const plain = await request(s.control, { method: 'POST', path: '/api/share-test/action', headers: { ...s.auth, 'content-type': 'text/plain' }, body: '{"bot_id":"bot-1","action":"share"}' })
  assert.equal(plain.status, 415)
  assert.equal(s.recall.length, 0, 'nothing was shared')
  // The public port has none of it, even with the token.
  assert.equal((await request(s.publicPort, { path: statusPath, headers: s.auth })).status, 404)
  assert.equal((await request(s.publicPort, { method: 'POST', path: '/api/share-test/action', headers: { ...json, ...s.auth }, body: '{}' })).status, 404)
  // An unknown action or bot.
  assert.equal((await act(s, 'reload')).status, 400)
  assert.equal((await act(s, 'share', 'bot-9')).status, 404)
  assert.equal((await request(s.control, { path: '/api/share-test/status?bot=bot-9', headers: s.auth })).status, 404)
  assert.equal((await statusOf(s)).state, 'off')
})

// --- The public routes: only while a share is on, with its token ---------------------------------------------------

test('the test page and its link are not found without a live share, with a wrong token, after the stop, and once the meeting ends', async t => {
  const s = await start(t)
  // No meeting at all, then one without a share.
  assert.equal((await request(s.publicPort, { path: pagePath('x'.repeat(43)) })).status, 404)
  assert.equal((await upgrade(linkUrl(s, 'x'.repeat(43)))).outcome, 404)
  assert.equal((await join(s)).status, 200)
  assert.equal((await request(s.publicPort, { path: '/share-test' })).status, 404)
  assert.equal((await act(s, 'share')).result.status, 200)
  const token = s.tokenOf(0)
  assert.match(token, /^[\w-]{43}$/, '32 random bytes')
  assert.equal(s.recall[0].url, `${PUBLIC}/share-test?t=${token}`)

  const page = await request(s.publicPort, { path: pagePath(token) })
  assert.equal(page.status, 200)
  assert.equal(page.body, fs.readFileSync(path.join(ROOT, 'public', 'share-test.html'), 'utf8'))
  assert.match(String(page.headers['content-type']), /^text\/html/)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  const csp = String(page.headers['content-security-policy'])
  assert.match(csp, /^default-src 'none'; script-src 'sha256-[\w+/=]+'; style-src 'sha256-[\w+/=]+'; connect-src wss:\/\/assistant\.example\.com\/share-test-link;/)
  assert.doesNotMatch(csp, /unsafe-inline|'self'|\*/)

  for (const wrong of ['', 'x'.repeat(43), token.slice(1), `${token}x`]) {
    assert.equal((await request(s.publicPort, { path: pagePath(wrong) })).status, 404, wrong)
    assert.equal((await upgrade(linkUrl(s, wrong))).outcome, 404, wrong)
  }
  const link = await upgrade(linkUrl(s, token), ORIGIN)
  assert.equal(link.outcome, 'open')
  await until(() => link.got.length > 0)
  assert.deepEqual(link.got[0], { type: 'session', epoch: 1 })

  // Stopped: the token opens nothing more. The open link is left a while for the browser to close, then closed.
  assert.equal((await act(s, 'unshare')).result.status, 204)
  assert.deepEqual(s.recall.map(r => r.call), ['start', 'stop'])
  assert.equal((await request(s.publicPort, { path: pagePath(token) })).status, 404)
  assert.equal((await upgrade(linkUrl(s, token))).outcome, 404)
  assert.equal(await link.code(), 4000)
  const view = (await statusOf(s)).shares[0]
  assert.equal(view.link_closed_by, 'service')
  assert.equal(view.stop_status, 204)

  // A new share, then the meeting ends: its token dies with it.
  assert.equal((await act(s, 'share')).result.epoch, 2)
  const second = s.tokenOf(1)
  assert.equal((await request(s.publicPort, { path: pagePath(second) })).status, 200)
  const live = await upgrade(linkUrl(s, second), ORIGIN)
  assert.equal(live.outcome, 'open')
  assert.equal((await act(s, 'leave')).status, 200)
  await until(() => s.left.length > 0)
  assert.equal(await live.code(), 4000)
  assert.equal((await request(s.publicPort, { path: pagePath(second) })).status, 404)
  assert.equal((await upgrade(linkUrl(s, second))).outcome, 404)
})

test('one connection per share: the newest wins, the one before it is closed (4001), and frames go to the newest', async t => {
  const s = await start(t)
  const { link: first } = await sharing(s)
  const second = await upgrade(linkUrl(s, s.tokenOf(0)), ORIGIN)
  assert.equal(second.outcome, 'open')
  assert.equal(await first.code(), 4001)
  const flipped = await act(s, 'flip')
  assert.deepEqual(flipped.result, { action: 'flip', frame: 1, sent: true })
  await until(() => second.got.some(m => m.type === 'frame'))
  assert.deepEqual(second.got.find(m => m.type === 'frame'), { type: 'frame', frame: 1 })
  assert.equal(first.got.some(m => m.type === 'frame'), false)
  second.ws.send(JSON.stringify({ type: 'shown', frame: 1 }))
  // A frame never sent, and a shown already counted, change nothing.
  second.ws.send(JSON.stringify({ type: 'shown', frame: 7 }))
  let view = (await statusOf(s)).shares[0]
  for (let i = 0; i < 100 && view.frames[0]?.shown_at === null; i++) view = (await statusOf(s)).shares[0]
  assert.equal(view.links, 2)
  assert.equal(view.frames.length, 1)
  assert.ok(view.frames[0].shown_at! >= view.frames[0].sent_at)
  second.ws.close()
})

test('a link that sends more than 4 KiB, binary, not JSON, or more than 20 messages a second is closed, and the service stays up', async t => {
  const s = await start(t)
  await sharing(s)
  const token = s.tokenOf(0)
  const cases: [string, (ws: WebSocket) => void, number][] = [
    ['too big', ws => ws.send(JSON.stringify({ type: 'metrics', pad: 'x'.repeat(5000) })), 1009],
    ['binary', ws => ws.send(Buffer.from([1, 2, 3])), 1008],
    ['not JSON', ws => ws.send('hello?'), 1008],
    ['an array', ws => ws.send('[1,2]'), 1008],
    ['too many', ws => {
      for (let i = 0; i < 30; i++) ws.send(JSON.stringify({ type: 'metrics', fps: 15, worstTimerLateMs: 1, visibility: 'visible' }))
    }, 1008],
  ]
  for (const [what, send, code] of cases) {
    const link = await upgrade(linkUrl(s, token), ORIGIN)
    assert.equal(link.outcome, 'open', what)
    send(link.ws)
    assert.equal(await link.code(), code, what)
  }
  // A message that is JSON but not one the page sends is ignored, not closed on.
  const fine = await upgrade(linkUrl(s, token), ORIGIN)
  fine.ws.send(JSON.stringify({ type: 'something-else' }))
  fine.ws.send(JSON.stringify({ type: 'metrics', fps: 14.9, worstTimerLateMs: 3, visibility: 'visible' }))
  let view = (await statusOf(s)).shares[0]
  for (let i = 0; i < 100 && !view.metrics.some(m => m.fps === 14.9); i++) view = (await statusOf(s)).shares[0]
  assert.ok(view.metrics.some(m => m.fps === 14.9 && m.worst_timer_late_ms === 3))
  assert.equal(fine.ws.readyState, WebSocket.OPEN)
  assert.equal((await request(s.publicPort, { path: '/health' })).status, 200)
  fine.ws.close()
})

test("the link's Origin is kept as its scheme and host only, for the report, and never logged; nor is the token or the page's address", async t => {
  const logged: string[] = []
  for (const method of ['log', 'warn', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  const s = await start(t)
  assert.equal((await join(s)).status, 200)
  assert.equal((await cameraPage(s, 0)).outcome, 'open')
  await act(s, 'share')
  const token = s.tokenOf(0)
  const link = await upgrade(linkUrl(s, token), { origin: 'https://assistant.example.com/some/path?q=secret' })
  link.ws.send(JSON.stringify(HELLO))
  let view = (await statusOf(s)).shares[0]
  for (let i = 0; i < 100 && view.hello_at === null; i++) view = (await statusOf(s)).shares[0]
  assert.equal(view.origin, 'https://assistant.example.com')
  assert.equal(view.origin_is_page, true)
  assert.deepEqual(view.hello, { width: 1280, height: 720, dpr: 1, visibility: 'visible', chrome_major: 126 })
  // A replace, linked from somewhere else.
  await act(s, 'share')
  const other = await upgrade(linkUrl(s, s.tokenOf(1)), { origin: 'https://elsewhere.example:8443' })
  assert.equal(other.outcome, 'open')
  view = (await statusOf(s)).shares[1]
  for (let i = 0; i < 100 && view.origin === null; i++) view = (await statusOf(s)).shares[1]
  assert.equal(view.origin, 'https://elsewhere.example:8443')
  assert.equal(view.origin_is_page, false)
  await act(s, 'unshare')
  await act(s, 'leave')
  t.mock.restoreAll()
  const all = logged.join('\n')
  assert.match(all, /\[share-test\] bot bot-1: S2 share 1: Recall answered 200 in \d+ ms/)
  assert.match(all, /\[share-test\] bot bot-1: share 1's page said hello \d+ ms after it was asked for/)
  for (const never of [token, s.tokenOf(1), 'assistant.example.com', 'elsewhere.example', '/share-test', 'secret']) assert.ok(!all.includes(never), never)
  // The Origin is cut to its scheme and host, and to 200 characters.
  assert.equal(originOf(undefined), '')
  assert.equal(originOf('null'), 'null')
  assert.equal(originOf(`https://${'a'.repeat(300)}.example/x`).length, 200)
  assert.equal(originOf('https://h.example:1/p?q#f'), 'https://h.example:1')
})

test('replacing a share: the old token opens the page until the new page says hello, and only while the grace lasts', async t => {
  const s = await start(t)
  const { link: old } = await sharing(s)
  const replaced = await act(s, 'share')
  assert.deepEqual({ ...replaced.result, ms: 0 }, { action: 'share', epoch: 2, status: 200, ms: 0, replacing: true })
  assert.deepEqual(s.recall.map(r => r.call), ['start', 'start'], 'no stop before the second share')
  const [first, second] = [s.tokenOf(0), s.tokenOf(1)]
  assert.equal((await request(s.publicPort, { path: pagePath(first) })).status, 200, 'the old page may still load until the new one says hello')
  assert.equal((await statusOf(s)).current, 2)
  const newer = await upgrade(linkUrl(s, second), ORIGIN)
  newer.ws.send(JSON.stringify(HELLO))
  for (let i = 0; i < 100 && (await request(s.publicPort, { path: pagePath(first) })).status !== 404; i++) await wait(10)
  assert.equal((await request(s.publicPort, { path: pagePath(first) })).status, 404)
  assert.equal((await request(s.publicPort, { path: pagePath(second) })).status, 200)
  // The old page's link is left for the browser to close, then closed by the service.
  assert.equal(await old.code(), 4000)
  // Without a hello, the old token dies once the grace is over (400 ms here).
  await act(s, 'share')
  const third = s.tokenOf(2)
  assert.equal((await request(s.publicPort, { path: pagePath(second) })).status, 200)
  await wait(500)
  assert.equal((await request(s.publicPort, { path: pagePath(second) })).status, 404)
  assert.equal((await request(s.publicPort, { path: pagePath(third) })).status, 200)
  // A replace that Recall refuses leaves the share that was on.
  let posts = 0
  const s2 = await start(t, {}, { start: () => (posts++ ? 400 : 200) })
  await sharing(s2)
  const refused = await act(s2, 'share')
  assert.equal(refused.result.status, 400)
  const st = await statusOf(s2)
  assert.equal(st.current, 1)
  assert.equal(st.state, 'live')
  assert.equal((await request(s2.publicPort, { path: pagePath(s2.tokenOf(0)) })).status, 200)
  assert.equal((await request(s2.publicPort, { path: pagePath(s2.tokenOf(1)) })).status, 404)
  newer.ws.close()
})

// --- The camera page, and the actions ------------------------------------------------------------------------------

test('the status counts each time the camera page connects, drops and is refused, and changes nothing about how that goes', async t => {
  const s = await start(t, { reconnectMs: 5000 })
  assert.equal((await join(s)).status, 200)
  let st = await statusOf(s)
  assert.equal(st.meeting, 'waiting')
  assert.equal(st.consent_done, null)
  const first = await cameraPage(s, 0)
  assert.equal(first.outcome, 'open')
  await until(() => first.got.length > 0)
  const rejoin = first.got[0].rejoin
  first.ws.send(Buffer.from([0, 0]))
  await until(() => s.started[0]?.spoke === true)
  st = await statusOf(s)
  assert.equal(st.meeting, 'live')
  assert.equal(st.consent_done, true)
  assert.deepEqual([st.camera.attaches.length, st.camera.drops.length, st.camera.refused.length], [1, 0, 0])
  // A page loaded again has no secret: refused, as always.
  assert.equal((await cameraPage(s, 0, { n: '1' })).outcome, 409)
  first.ws.close()
  for (let i = 0; i < 100 && (await statusOf(s)).meeting !== 'away'; i++) await wait(10)
  const back = await cameraPage(s, 0, { n: '2', rejoin })
  assert.equal(back.outcome, 'open')
  st = await statusOf(s)
  assert.equal(st.meeting, 'live')
  assert.deepEqual([st.camera.attaches.length, st.camera.drops.length, st.camera.refused.length], [2, 1, 1])
  back.ws.close()
})

test('say speaks the line for the state of the share through the session, flip needs a link, and leave takes the normal path', async t => {
  const s = await start(t)
  assert.equal((await join(s)).status, 200)
  assert.equal((await act(s, 'say')).result.said, 'not_now', 'no session yet')
  const camera = await cameraPage(s, 0)
  await until(() => s.started.length > 0)
  const session = s.started[0]
  assert.equal((await act(s, 'say')).result.said, 'played')
  assert.equal((await act(s, 'flip')).result.sent, false, 'no share on')
  await act(s, 'share')
  assert.equal((await act(s, 'say')).result.said, 'played')
  assert.deepEqual(session.said, [testLine('Alex', false), testLine('Alex', true)])
  assert.match(session.said[1], /^This is Alex\. I'm testing my voice while my screen is shared\.$/)
  // A line that never finishes is given up on after sayWaitMs; one that throws is 'failed'.
  session.sayOutcome = () => new Promise(() => {})
  assert.equal((await act(s, 'say')).result.said, 'timeout')
  session.sayOutcome = () => {
    throw new Error('no voice')
  }
  assert.equal((await act(s, 'say')).result.said, 'failed')
  assert.equal((await act(s, 'leave')).result.leaving, true)
  assert.equal(session.leaves, 1)
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal((await act(s, 'say')).status, 404, 'the meeting is gone once its bot is out')
  camera.ws.close()
})

test('a session without its own leave, or one whose leave throws, has its bot asked to leave all the same', async t => {
  for (const kind of ['none', 'throws'] as const) {
    const s = await start(t)
    assert.equal((await join(s)).status, 200)
    await cameraPage(s, 0)
    await until(() => s.started.length > 0)
    s.started[0].leaveAsAsked =
      kind === 'none'
        ? undefined
        : () => {
            throw new Error('broken')
          }
    assert.equal((await act(s, 'leave')).status, 200, kind)
    await until(() => s.left.length > 0)
    assert.deepEqual(s.left, ['bot-1'], kind)
  }
})

test('actions run one at a time per meeting: a stop asked during a share waits for it', async t => {
  let release!: () => void
  const s = await start(t, {}, { start: () => new Promise<number>(r => (release = () => r(200))) })
  assert.equal((await join(s)).status, 200)
  const sharing = act(s, 'share')
  await until(() => s.recall.length === 1)
  const stopping = act(s, 'unshare')
  await wait(50)
  assert.deepEqual(s.recall.map(r => r.call), ['start'], 'the stop waits')
  assert.equal((await statusOf(s)).state, 'starting')
  release()
  assert.equal((await sharing).result.status, 200)
  assert.equal((await stopping).result.status, 204)
  assert.deepEqual(s.recall.map(r => r.call), ['start', 'stop'])
  assert.equal((await statusOf(s)).state, 'off')
})

test('nothing a share-test handler throws stops the service: a Recall call that throws, or never answers, is a status', async t => {
  const crashes: unknown[] = []
  const onCrash = (err: unknown) => void crashes.push(err)
  process.on('uncaughtException', onCrash)
  process.on('unhandledRejection', onCrash)
  t.after(() => {
    process.off('uncaughtException', onCrash)
    process.off('unhandledRejection', onCrash)
  })
  t.mock.method(console, 'log', () => {})
  const s = await start(t, {}, {
    start: () => {
      throw new Error('Recall exploded')
    },
    stop: () => Promise.reject(new TypeError('fetch failed')),
  })
  assert.equal((await join(s)).status, 200)
  assert.deepEqual({ ...(await act(s, 'share')).result, ms: 0 }, { action: 'share', epoch: 1, status: 0, ms: 0, replacing: false })
  assert.equal((await statusOf(s)).state, 'off', 'a share that failed is not on')
  assert.equal((await act(s, 'unshare')).result.status, 0)
  // A link for a share that failed is not found.
  assert.equal((await upgrade(linkUrl(s, s.tokenOf(0)))).outcome, 404)
  // Upgrades reset at once, and odd targets.
  for (const target of [`/share-test-link?t=${s.tokenOf(0)}`, '/share-test-link', '//%5B/share-test-link']) {
    await new Promise<void>(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: s.publicPort })
      socket.on('error', () => {})
      socket.on('close', () => resolve())
      socket.on('connect', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
        socket.resetAndDestroy()
      })
    })
  }
  await wait(100)
  assert.equal((await request(s.publicPort, { path: '/health' })).status, 200)
  assert.equal((await request(s.control, { path: '/health' })).status, 200)
  assert.deepEqual(crashes, [])
})

test('stopping the service closes the share-test links, and lets none in', async t => {
  const s = await start(t, { stopWaitMs: 200 })
  const { link } = await sharing(s)
  await s.service.stop()
  assert.equal(await link.code(), 4000)
  assert.equal((await upgrade(linkUrl(s, s.tokenOf(0)))).outcome, 404)
  assert.equal((await act(s, 'share')).status, 404, 'its bot is out, and the meeting gone')
})

// --- A meeting without the test is what it always was --------------------------------------------------------------

test('a meeting joined without the share test is unchanged: the same bot, routes, log and camera page', async t => {
  const logged: string[] = []
  t.mock.method(console, 'log', (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  const s = await start(t)
  assert.equal((await join(s, { meetingUrl: ZOOM })).status, 200)
  assert.deepEqual(s.plans[0], { meetingUrl: ZOOM, pageUrl: `${PUBLIC}/agent?key=${s.keyOf(0)}&token=${PAGE_TOKEN}` })
  const camera = await cameraPage(s, 0)
  assert.equal(camera.outcome, 'open')
  await until(() => s.started.length > 0)
  for (const action of ['share', 'say', 'leave']) assert.equal((await act(s, action)).status, 404)
  assert.equal((await request(s.publicPort, { path: '/share-test' })).status, 404)
  assert.equal((await upgrade(`ws://127.0.0.1:${s.publicPort}/share-test-link`)).outcome, 404)
  assert.equal(s.recall.length, 0)
  assert.equal(s.started[0].said.length, 0)
  assert.equal(s.started[0].leaves, 0)
  t.mock.restoreAll()
  assert.ok(logged.includes('[join] bot bot-1 is joining a Zoom meeting'), logged.join('\n'))
  assert.ok(!logged.some(line => line.includes('[share-test]')))
  camera.ws.close()
})

// --- The page ------------------------------------------------------------------------------------------------------

test('the test page is silent, leaves the camera page alone, and has only its own inline script and style', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'share-test.html'), 'utf8')
  assert.equal(shareTestPageProblem(html), '')
  const loaded = loadShareTestPage()
  assert.equal(loaded.problem, '')
  assert.match(loaded.scriptHash, /^'sha256-[\w+/=]{44}'$/)
  for (const never of [/<audio/i, /<video/i, /AudioContext/, /getUserMedia/, /mediaDevices/, /agent\.js/, /\/audio\b/, /location\.reload/]) {
    assert.doesNotMatch(html, never)
  }
  assert.match(html, /<title>Screen-share test<\/title>/)
  for (const px of [12, 14, 16, 18, 20, 24, 28, 32, 40, 48]) assert.match(html, new RegExp(`<span class="size">${px} px</span><span class="px${px}">`))
  // What makes a page unfit is caught.
  for (const [bad, why] of [
    ['<script>new AudioContext()</script><style></style>', /AudioContext/],
    ['<audio src="x"></audio><script></script><style></style>', /audio, video/],
    ['<script>navigator.mediaDevices.getUserMedia({})</script><style></style>', /microphone/],
    ['<script src="/x.js"></script><style></style>', /one inline script/],
    ['<script></script><style></style><p style="color:red">x</p>', /no style or event attributes/],
    ['<script>location.reload()</script><style></style>', /reload/],
  ] as const) {
    assert.match(shareTestPageProblem(bad), why, bad)
  }
})

test('a test page that cannot be used refuses joins with the test, and nothing else', async t => {
  const s = await start(t, { shareTestPage: { html: '', scriptHash: '', styleHash: '', problem: "public/share-test.html can't be read (ENOENT)." } })
  const refused = await join(s)
  assert.equal(refused.status, 400)
  assert.equal(refused.body, "public/share-test.html can't be read (ENOENT).")
  assert.equal((await join(s, { meetingUrl: ZOOM })).status, 200)
})

// --- npm run join --share-test itself ------------------------------------------------------------------------------

function runJoin(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/cli/join.ts'), ...args], {
      env: { ...process.env, CONTROL_SOCKET: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', c => (out += c))
    child.stderr.on('data', c => (err += c))
    // No terminal: the first question finds the input closed.
    child.stdin.end()
    child.on('close', code => resolve({ code, out, err }))
  })
}

test('npm run join --share-test asks the service first, says what will happen, and sends nothing without an answer', { timeout: 30_000 }, async t => {
  const s = await start(t)
  const quiet = await runJoin([ZOOM, '--share-test'], { ALEX_DATA_DIR: s.dataDir })
  assert.equal(quiet.code, 130, quiet.err)
  assert.match(quiet.err, /The screen-share test checks the one thing the slides feature depends on/)
  assert.match(quiet.err, /In Zoom, "Who can share\?" must be "All participants"/)
  assert.match(quiet.err, /Press Enter to send Alex in, or Ctrl-C to stop\./)
  assert.equal(quiet.out, '', 'no report: nothing was sent')
  assert.equal(s.plans.length, 0)
  for (const never of [s.localToken, '123456789', 'pwd=abc']) assert.ok(!quiet.err.includes(never), never)
  const misused = await runJoin([ZOOM, '--keep'], { ALEX_DATA_DIR: s.dataDir })
  assert.equal(misused.code, 1)
  assert.match(misused.err, /^--keep goes with --share-test\.\nUsage: npm run join -- /)
  await s.service.close()
  const down = await runJoin([ZOOM, '--share-test'], { ALEX_DATA_DIR: s.dataDir })
  assert.equal(down.code, 1)
  assert.match(down.err, /The voice service is not running/)
})
