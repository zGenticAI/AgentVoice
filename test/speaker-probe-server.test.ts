// The speaker probe through the service: the two keys (SPEAKER_PROBE, and a join that asks for it), Recall's events
// connection on /recall/ as a stranger, Recall, a web page or a replaced connection would meet it, what reaches the
// meeting's probe, and what the log never holds. Recall and the meeting sessions are fakes; the listeners are real.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'
import { joinArgs } from '../src/cli/join-args.ts'
import { ROOT } from '../src/config.ts'
import { ensureLocalToken } from '../src/local-token.ts'
import type { SessionOptions } from '../src/pipeline/session.ts'
import type { BotPlan } from '../src/recall.ts'
import { type ServiceConfig, type ServiceSession, createServers } from '../src/server.ts'
import { RecallEvents } from '../src/speakers/connection.ts'
import { PROBE_OFF, type SpeakerProbe } from '../src/speakers/probe.ts'

const PAGE_TOKEN = 'p'.repeat(48)
const ZOOM = 'https://us06web.zoom.us/j/123456789?pwd=abc'
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await wait(10)
}
// A Unix socket's path is short, so the folders are made in /tmp.
function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join('/tmp', 'av-sp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Stands in for a MeetingSession: keeps the probe it was started with. */
class FakeSession implements ServiceSession {
  readonly transcript = { recent: () => '' }
  readonly over: Promise<void>
  private resolveOver!: () => void
  ended = false
  leftMeeting = false
  constructor(
    readonly opts: SessionOptions,
    readonly probe: SpeakerProbe | undefined,
  ) {
    this.over = new Promise(resolve => (this.resolveOver = resolve))
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
  resumes() {
    return false
  }
  attach() {}
  async reachedTimeLimit() {}
  end() {
    if (this.ended) return
    this.ended = true
    this.resolveOver()
  }
}

async function start(t: TestContext, overrides: Partial<ServiceConfig> = {}, leaveCall: () => Promise<void> = async () => {}) {
  const dataDir = tempDir(t)
  const localToken = ensureLocalToken(dataDir)
  const control = path.join(dataDir, 'control.sock')
  const started: FakeSession[] = []
  const plans: BotPlan[] = []
  const service = createServers(
    { port: 0, host: '127.0.0.1', controlSocket: control, publicUrl: 'https://assistant.example.com', agentPageToken: PAGE_TOKEN, localToken, dataDir, maxMeetings: 5, maxMeetingMinutes: 180, ...overrides },
    {
      createBot: async plan => {
        plans.push(plan)
        return { id: `bot-${plans.length}` }
      },
      leaveCall,
      startSession: (_ws, opts, { speakerProbe }) => {
        const s = new FakeSession(opts, speakerProbe)
        started.push(s)
        return s
      },
    },
  )
  await service.listen()
  // First the connections a test left open (one that failed, say), so the service can close.
  t.after(() => {
    for (const ws of links) ws.terminate()
    links.clear()
  })
  t.after(() => service.close())
  const publicPort = (service.publicServer.address() as AddressInfo).port
  const keyOf = (n: number) => new URL(plans[n].pageUrl).searchParams.get('key')!
  /** The key and events token Recall was given for the nth bot. */
  const eventsOf = (n: number) => {
    const url = new URL(plans[n].eventsUrl!)
    return { key: url.searchParams.get('key')!, token: url.searchParams.get('token')! }
  }
  return { service, control, dataDir, localToken, publicPort, started, plans, keyOf, eventsOf }
}
type Started = Awaited<ReturnType<typeof start>>

function request(socketPath: string, opts: { method?: string; path: string; body?: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ socketPath, method: opts.method ?? 'GET', path: opts.path, headers: { host: 'localhost', ...opts.headers } }, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}
const join = (s: Started, body: object) =>
  request(s.control, { method: 'POST', path: '/api/join', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${s.localToken}` } })
const health = async (s: Started) => JSON.parse((await request(s.control, { path: '/health' })).body)

// Every events connection a test opens.
const links = new Set<WebSocket>()

/** Recall's events connection, as Recall opens it through the tunnel: 'open' with its socket, or the status it got. */
function recallLink(port: number, target: string, opts: WebSocket.ClientOptions = {}) {
  return new Promise<{ outcome: 'open' | number | 'error'; ws: WebSocket; closed: Promise<{ code: number; reason: string }> }>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, opts)
    links.add(ws)
    const closed = new Promise<{ code: number; reason: string }>(r => ws.once('close', (code, reason) => r({ code, reason: String(reason) })))
    ws.on('open', () => resolve({ outcome: 'open', ws, closed }))
    ws.on('unexpected-response', (_req, res) => {
      resolve({ outcome: res.statusCode ?? 0, ws, closed })
      ws.terminate()
    })
    ws.on('error', () => resolve({ outcome: 'error', ws, closed }))
  })
}
/** How a connection closed, or 'still open' after ms: a test fails rather than waits for ever. */
const closedWithin = (link: { closed: Promise<{ code: number; reason: string }> }, ms = 3000) =>
  Promise.race([link.closed, wait(ms).then(() => 'still open' as const)])
const recallPath = (key: string, token?: string) => `/recall/?${new URLSearchParams(token === undefined ? { key } : { key, token })}`

/** A participant event as Recall sends it. */
function participantEvent(kind: string, pid: number, name: string | null, o: { botId?: string; absolute?: string } = {}) {
  return JSON.stringify({
    event: `participant_events.${kind}`,
    data: {
      data: {
        participant: { id: pid, name, is_host: false, platform: 'desktop', extra_data: { zoom: { conf_user_id: 'conf-id-distinct' } }, email: null },
        timestamp: { absolute: o.absolute ?? new Date().toISOString(), relative: 3 },
        data: null,
      },
      realtime_endpoint: { id: 're', metadata: {} },
      participant_events: { id: 'pe', metadata: {} },
      recording: { id: 'rec', metadata: {} },
      bot: { id: o.botId ?? 'bot-1', metadata: {} },
    },
  })
}

/** Opens the nth meeting's bot page, so its session starts with the meeting's probe. */
async function openPage(s: Started, n: number) {
  const count = s.started.length
  const params = new URLSearchParams({ key: s.keyOf(n), token: PAGE_TOKEN, n: '1' })
  const ws = new WebSocket(`ws://127.0.0.1:${s.publicPort}/audio?${params}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`refused: ${res.statusCode}`)))
  })
  await until(() => s.started.length > count)
  return s.started.at(-1)!
}

let stems = 0
/** What a probe measured, as its file says. */
function measured(probe: SpeakerProbe) {
  const stem = `server-test-${process.pid}-${++stems}`
  const file = probe.write({ stem, startedAt: new Date(), endedAt: new Date(), ending: 'ended' })
  assert.ok(file)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.rmSync(file)
  return data
}

// --- The two keys --------------------------------------------------------------------------------------------------

test('with SPEAKER_PROBE off, /recall/ is not found, a join asking for the probe is refused with why and starts no bot, and the control /health says it is off', async t => {
  const s = await start(t)
  assert.equal((await health(s)).speaker_probe, false)
  const refused = await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  assert.equal(refused.status, 400)
  assert.ok(refused.body.startsWith('SPEAKER_PROBE is not set in .env'), refused.body)
  assert.equal(refused.body, PROBE_OFF)
  assert.equal(s.plans.length, 0)
  const ok = await join(s, { meetingUrl: ZOOM, speaker_probe: false })
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).speaker_probe, false)
  assert.deepEqual(Object.keys(s.plans[0]).sort(), ['meetingUrl', 'pageUrl'])
  for (const target of [recallPath(s.keyOf(0), 'x'.repeat(43)), '/recall/', '/recall']) {
    assert.equal((await recallLink(s.publicPort, target)).outcome, 404, target)
  }
})

test('with SPEAKER_PROBE on, only a join that asks for it gets the probe: its own events URL and token, and never through join_meeting', async t => {
  const logged: string[] = []
  t.mock.method(console, 'log', (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  const s = await start(t, { speakerProbe: true })
  assert.equal((await health(s)).speaker_probe, true)
  // Asked for in no other way.
  const plain = await join(s, { meetingUrl: ZOOM })
  assert.equal(JSON.parse(plain.body).speaker_probe, false)
  assert.deepEqual(Object.keys(s.plans[0]).sort(), ['meetingUrl', 'pageUrl'], 'no eventsUrl reaches Recall')
  const odd = await join(s, { meetingUrl: ZOOM, speaker_probe: 'yes' })
  assert.equal(odd.status, 400)
  assert.match(odd.body, /speaker_probe has to be true or false/)
  assert.equal(s.plans.length, 1)

  for (let i = 0; i < 2; i++) {
    const probed = await join(s, { meetingUrl: ZOOM, speaker_probe: true })
    assert.equal(probed.status, 200, probed.body)
    assert.equal(JSON.parse(probed.body).speaker_probe, true)
  }
  const [a, b] = [s.eventsOf(1), s.eventsOf(2)]
  assert.equal(a.key, s.keyOf(1), "the meeting's own key")
  assert.match(s.plans[1].eventsUrl!, /^wss:\/\/assistant\.example\.com\/recall\/\?key=[0-9a-f-]{36}&token=[\w-]{43}$/)
  assert.notEqual(a.token, b.token, 'a token of its own for each meeting')
  assert.notEqual(a.token, PAGE_TOKEN)

  // join_meeting, which the model calls, never turns it on.
  const ws = new WebSocket('ws://localhost/bridge', { headers: { authorization: `Bearer ${s.localToken}` }, createConnection: () => net.connect(s.control) })
  const got: any[] = []
  ws.on('message', raw => got.push(JSON.parse(raw.toString())))
  await new Promise(r => ws.once('open', r))
  t.after(() => ws.close())
  ws.send(JSON.stringify({ type: 'join_meeting', request_id: 'j1', meeting_url: ZOOM, speaker_probe: true }))
  await until(() => got.some(m => m.request_id === 'j1'))
  assert.equal(got.find(m => m.request_id === 'j1').ok, true)
  assert.deepEqual(Object.keys(s.plans[3]).sort(), ['meetingUrl', 'pageUrl'])
  t.mock.restoreAll()
  assert.deepEqual(
    logged.filter(l => l.startsWith('[join]')).map(l => l.replace(/bot-\d/, 'bot-N')),
    [
      '[join] bot bot-N is joining a Zoom meeting',
      '[join] bot bot-N is joining a Zoom meeting, with the speaker probe',
      '[join] bot bot-N is joining a Zoom meeting, with the speaker probe',
      '[join] bot bot-N is joining a Zoom meeting',
    ],
  )
})

// --- /recall/ ---------------------------------------------------------------------------------------------------

test("Recall's connection needs exactly /recall/, no Origin, a meeting this service started with the probe, and its own token; one a second, and the newest wins", async t => {
  const s = await start(t, { speakerProbe: true })
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  await join(s, { meetingUrl: ZOOM })
  const a = s.eventsOf(0)
  const b = s.eventsOf(1)
  const link = (target: string, opts?: WebSocket.ClientOptions) => recallLink(s.publicPort, target, opts)
  assert.equal((await link(`/recall?${new URLSearchParams(a)}`)).outcome, 404, 'without the slash')
  assert.equal((await link(recallPath(a.key, a.token), { headers: { origin: 'https://evil.example' } })).outcome, 403, 'a web page')
  assert.equal((await link(recallPath(a.key))).outcome, 403, 'no token')
  assert.equal((await link(recallPath(a.key, 'x'.repeat(43)))).outcome, 403, 'a wrong token')
  assert.equal((await link(recallPath(a.key, b.token))).outcome, 403, "another meeting's token")
  assert.equal((await link(recallPath('made-up', a.token))).outcome, 403, 'a key this service did not give out')
  assert.equal((await link(recallPath(s.keyOf(2), a.token))).outcome, 403, 'a meeting without the probe')
  assert.equal((await link(recallPath(a.key, PAGE_TOKEN))).outcome, 403, 'the page token opens nothing here')

  const first = await link(recallPath(a.key, a.token))
  assert.equal(first.outcome, 'open')
  assert.equal((await link(recallPath(a.key, a.token))).outcome, 429, 'a second within the second')
  await wait(1100)
  const second = await link(recallPath(a.key, a.token))
  assert.equal(second.outcome, 'open', 'the newest wins: Recall must always get back in')
  assert.notEqual(await closedWithin(first), 'still open')
  assert.equal(second.ws.readyState, WebSocket.OPEN)
  // Another meeting's connection is its own.
  assert.equal((await link(recallPath(b.key, b.token))).outcome, 'open')
})

test("a meeting's bot being asked to leave closes Recall's connection (1000) and refuses it after; the service stopping answers 503", async t => {
  // Recall can't be reached: the bot stays in its call, and its meeting is left, while it is asked again.
  const s = await start(t, { speakerProbe: true, pageWaitMs: 300, stopWaitMs: 50 }, () => Promise.reject(new TypeError('fetch failed')))
  t.mock.method(console, 'warn', () => {})
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  const a = s.eventsOf(0)
  const open = await recallLink(s.publicPort, recallPath(a.key, a.token))
  assert.equal(open.outcome, 'open')
  // Its page never connects: the bot is asked to leave.
  assert.deepEqual(await closedWithin(open), { code: 1000, reason: 'over' })
  await wait(1000)
  assert.equal((await recallLink(s.publicPort, recallPath(a.key, a.token))).outcome, 403)
  assert.equal((await health(s)).bot_meetings, 1, 'still being left')

  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  const b = s.eventsOf(1)
  const before = await recallLink(s.publicPort, recallPath(b.key, b.token))
  assert.equal(before.outcome, 'open')
  void s.service.stop()
  // Its bot can't be got out yet: its connection is cut all the same.
  assert.deepEqual(await closedWithin(before), { code: 1006, reason: '' })
  assert.equal((await recallLink(s.publicPort, recallPath(b.key, b.token))).outcome, 503)
  assert.equal((await recallLink(s.publicPort, recallPath(b.key, 'x'.repeat(43)))).outcome, 403, 'only after the token: a stranger learns nothing')
})

test('"please leave" (the probe discarded) cuts Recall\'s connection at once and lets it in no more; events reach the probe, the rest is counted and dropped', async t => {
  const s = await start(t, { speakerProbe: true })
  t.mock.method(console, 'warn', () => {})
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  const session = await openPage(s, 0)
  assert.ok(session.probe, "the session has its meeting's probe")
  const other = await openPage(s, 1)
  assert.notEqual(other.probe, session.probe)

  const a = s.eventsOf(0)
  const recall = await recallLink(s.publicPort, recallPath(a.key, a.token))
  assert.equal(recall.outcome, 'open')
  recall.ws.send(participantEvent('join', 1, 'Probe Alpha'))
  recall.ws.send(participantEvent('speech_on', 1, 'Probe Alpha'))
  recall.ws.send(participantEvent('speech_on', 1, 'Probe Alpha', { botId: 'bot-2' }))
  recall.ws.send(Buffer.from([1, 2, 3]))
  recall.ws.send('not json')
  recall.ws.send(JSON.stringify({ event: 'participant_events.webcam_on' }))
  recall.ws.send(participantEvent('webcam_on', 1, 'Probe Alpha'))
  await wait(100)
  assert.equal(recall.ws.readyState, WebSocket.OPEN, 'nothing it sends closes it')
  assert.equal(session.probe!.accepting, true)
  session.probe!.discard()
  assert.deepEqual(await closedWithin(recall), { code: 1006, reason: '' }, 'cut at once')
  await wait(1000)
  assert.equal((await recallLink(s.publicPort, recallPath(a.key, a.token))).outcome, 403)
  assert.equal(session.probe!.write({ stem: 'never', startedAt: new Date(), endedAt: new Date(), ending: 'ended' }), null)

  // The other meeting: what arrives is counted.
  const b = s.eventsOf(1)
  const rb = await recallLink(s.publicPort, recallPath(b.key, b.token))
  rb.ws.send(participantEvent('join', 7, 'Probe Bravo', { botId: 'bot-2' }))
  rb.ws.send(participantEvent('speech_on', 7, 'Probe Bravo', { botId: 'bot-2' }))
  rb.ws.send(participantEvent('speech_on', 7, 'Probe Bravo', { botId: 'bot-1' }))
  rb.ws.send(Buffer.from([1]))
  rb.ws.send('{"event":')
  rb.ws.send(participantEvent('microphone_on', 7, 'Probe Bravo', { botId: 'bot-2' }))
  await wait(100)
  const f = measured(other.probe!)
  assert.deepEqual(f.events, { join: 1, leave: 0, update: 0, speech_on: 1, speech_off: 0 })
  assert.deepEqual(
    Object.fromEntries(Object.entries(f.endpoint.dropped).filter(([, n]) => n)),
    { wrong_bot: 1, binary: 1, malformed: 1, unknown_event: 1 },
  )
  assert.equal(f.endpoint.connections, 1)
  assert.equal(f.participants.probe_labels, 1)
  assert.equal(typeof f.endpoint.first_event_after_page_ms, 'number')
})

test('a message over 64 KiB closes its connection (1009), and the service carries on', async t => {
  const s = await start(t, { speakerProbe: true })
  t.mock.method(console, 'warn', () => {})
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  const session = await openPage(s, 0)
  const a = s.eventsOf(0)
  const recall = await recallLink(s.publicPort, recallPath(a.key, a.token))
  recall.ws.send('x'.repeat(64 * 1024))
  await wait(50)
  assert.equal(recall.ws.readyState, WebSocket.OPEN, 'at the limit, still read (and dropped as malformed)')
  recall.ws.send('x'.repeat(70 * 1024))
  assert.equal(((await closedWithin(recall)) as { code: number }).code, 1009)
  assert.equal((await health(s)).ok, true)
  await wait(1000)
  const again = await recallLink(s.publicPort, recallPath(a.key, a.token))
  assert.equal(again.outcome, 'open')
  again.ws.send(participantEvent('speech_on', 1, 'Probe Alpha'))
  await wait(50)
  const f = measured(session.probe!)
  assert.equal(f.endpoint.dropped.too_big, 1)
  assert.equal(f.endpoint.dropped.malformed, 1)
  // Recall is told 1009; on this side the connection was cut.
  assert.equal(f.endpoint.closes['1006'], 1, JSON.stringify(f.endpoint.closes))
  assert.equal(f.events.speech_on, 1)
})

test("Recall's connection is pinged, and cut once it has been silent too long", async t => {
  const s = await start(t, { speakerProbe: true, recallPingMs: 40, recallSilenceMs: 200 })
  t.mock.method(console, 'warn', () => {})
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  const answers = await recallLink(s.publicPort, recallPath(s.eventsOf(0).key, s.eventsOf(0).token))
  let pings = 0
  answers.ws.on('ping', () => pings++)
  const silent = await recallLink(s.publicPort, recallPath(s.eventsOf(1).key, s.eventsOf(1).token), { autoPong: false })
  assert.deepEqual(await closedWithin(silent), { code: 1006, reason: '' }, 'cut off')
  assert.ok(pings >= 3, `${pings} pings`)
  // Past the answering one's own deadline too, and a ping after it: only its pongs keep it open.
  await wait(300)
  assert.equal(answers.ws.readyState, WebSocket.OPEN, 'one that answers stays')
  const closing = s.service.close()
  assert.deepEqual(await closedWithin(answers), { code: 1006, reason: '' }, "closing the service cuts Recall's connections")
  await closing
})

test('the log has the bot id and connection states only: never a name, the key, the token or the URL', async t => {
  const lines: string[] = []
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  for (const level of ['log', 'warn', 'error'] as const) t.mock.method(console, level, keep)
  const s = await start(t, { speakerProbe: true, pageWaitMs: 2500 })
  await join(s, { meetingUrl: ZOOM, speaker_probe: true })
  await openPage(s, 0)
  const a = s.eventsOf(0)
  const recall = await recallLink(s.publicPort, recallPath(a.key, a.token))
  recall.ws.send(participantEvent('join', 1, 'Probe Alpha'))
  recall.ws.send(participantEvent('join', 2, '+1 415 555 0100'))
  recall.ws.send('Probe Alpha says hello')
  await recallLink(s.publicPort, recallPath(a.key, a.token))
  await recallLink(s.publicPort, recallPath(a.key, 'wrong-token-value'))
  await recallLink(s.publicPort, recallPath('made-up-key', a.token), { headers: { origin: 'https://evil.example' } })
  recall.ws.send('x'.repeat(70 * 1024))
  assert.notEqual(await closedWithin(recall), 'still open')
  // And one for a key this service never gave out.
  await recallLink(s.publicPort, recallPath('made-up-key', a.token))
  s.started[0].end()
  await until(() => lines.some(l => l.includes('[leave]')))
  await wait(50)
  t.mock.restoreAll()
  assert.ok(lines.some(l => l === '[events] bot bot-1: Recall connected its participant events'), lines.join('\n'))
  assert.ok(lines.some(l => /^\[events\] refused \d+ connection\(s\)/.test(l)), lines.join('\n'))
  for (const line of lines) {
    for (const secret of ['Probe Alpha', '415', '0100', a.key, a.token, 'token=', '/recall/?', 'wrong-token-value', 'made-up-key', 'evil.example', 'conf-id-distinct']) {
      assert.ok(!line.includes(secret), `${secret} in: ${line}`)
    }
  }
})

// --- The events connection on its own --------------------------------------------------------------------------------

/** A websocket as RecallEvents uses it. */
class FakeSocket extends EventEmitter {
  readyState = 1
  pings = 0
  terminated = false
  closedWith: [number, string] | null = null
  ping() {
    this.pings++
  }
  terminate() {
    this.terminated = true
  }
  close(code: number, reason: string) {
    this.closedWith = [code, reason]
  }
}

/** Counts what reaches the probe. */
function spyProbe() {
  const got = { events: 0, dropped: [] as string[], connected: [] as boolean[], accepting: true }
  const probe = {
    get accepting() {
      return got.accepting
    },
    connected: (replaced: boolean) => void got.connected.push(replaced),
    closed: () => {},
    dropped: (reason: string) => void got.dropped.push(reason),
    pingTimeout: () => {},
    event: () => void got.events++,
    stopEvents: () => void (got.accepting = false),
  }
  return { got, probe: probe as unknown as SpeakerProbe }
}

test('what arrives on a connection that was replaced is ignored, not only that connection cut', t => {
  t.mock.method(console, 'log', () => {})
  const { got, probe } = spyProbe()
  const events = new RecallEvents({ botId: 'bot-1', token: 't', probe })
  const old = new FakeSocket()
  const newer = new FakeSocket()
  events.take(old as never)
  old.emit('message', Buffer.from(participantEvent('speech_on', 1, 'Probe Alpha')), false)
  assert.equal(got.events, 1)
  events.take(newer as never)
  assert.equal(old.terminated, true)
  assert.deepEqual(got.connected, [false, true])
  // Frames the old one had already read, arriving after it was replaced.
  old.emit('message', Buffer.from(participantEvent('speech_on', 1, 'Probe Alpha')), false)
  old.emit('message', Buffer.from([1]), true)
  assert.equal(got.events, 1)
  assert.deepEqual(got.dropped, [])
  newer.emit('message', Buffer.from(participantEvent('speech_off', 1, 'Probe Alpha')), false)
  assert.equal(got.events, 2)
  assert.equal(events.current, newer)
  // Its close does not take the newer one's place.
  old.emit('close', 1006)
  assert.equal(events.current, newer)
  events.stop()
  assert.deepEqual(newer.closedWith, [1000, 'over'])
  assert.equal(got.accepting, false)
  // Nothing after it is over, and a connection then is closed at once.
  newer.emit('message', Buffer.from(participantEvent('speech_on', 1, 'Probe Alpha')), false)
  assert.equal(got.events, 2)
  const late = new FakeSocket()
  events.take(late as never)
  assert.deepEqual(late.closedWith, [1000, 'over'])
})

test('past 100 messages in a second the rest are dropped and counted before they are read, and the connection stays', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 5_000_000 })
  t.mock.method(console, 'log', () => {})
  const { got, probe } = spyProbe()
  const events = new RecallEvents({ botId: 'bot-1', token: 't', probe })
  const ws = new FakeSocket()
  events.take(ws as never)
  const message = Buffer.from(participantEvent('speech_on', 1, 'Probe Alpha'))
  for (let i = 0; i < 130; i++) ws.emit('message', message, false)
  assert.equal(got.events, 100)
  assert.equal(got.dropped.length, 30)
  assert.ok(got.dropped.every(r => r === 'rate'))
  assert.equal(ws.terminated, false)
  assert.equal(ws.closedWith, null)
  t.mock.timers.tick(1000)
  ws.emit('message', message, false)
  assert.equal(got.events, 101, 'a new second')
})

test("a connection's errors are listened for before any frame: one too big is counted, never thrown, and logged by its code", t => {
  const lines: string[] = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', (...a: unknown[]) => void lines.push(a.map(String).join(' ')))
  const { got, probe } = spyProbe()
  const events = new RecallEvents({ botId: 'bot-1', token: 't', probe })
  const ws = new FakeSocket()
  events.take(ws as never)
  assert.equal(ws.listenerCount('error'), 1)
  const tooBig = Object.assign(new RangeError('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' })
  assert.doesNotThrow(() => ws.emit('error', tooBig))
  assert.deepEqual(got.dropped, ['too_big'])
  assert.deepEqual(lines, ["[events] bot bot-1: Recall's connection failed (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH)"])
})

// --- npm run join --speaker-probe ------------------------------------------------------------------------------------

test('the join CLI takes --speaker-probe, before or after the link, once, with no value', () => {
  assert.deepEqual(joinArgs([ZOOM, '--speaker-probe']), { meetingUrl: ZOOM, speakerProbe: true })
  assert.deepEqual(joinArgs(['--speaker-probe', ZOOM, '--brief', 'a.md']), { meetingUrl: ZOOM, speakerProbe: true, briefFile: 'a.md' })
  assert.deepEqual(joinArgs([ZOOM]), { meetingUrl: ZOOM })
  assert.deepEqual(joinArgs([ZOOM, '--speaker-probe=yes']), { problem: '--speaker-probe takes no value.' })
  assert.deepEqual(joinArgs([ZOOM, '--speaker-probe', '--speaker-probe']), { problem: 'Give --speaker-probe once.' })
  assert.deepEqual(joinArgs([ZOOM, '--speaker']), { problem: 'Unknown option --speaker.' })
})

function runCli(script: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, script), ...args], {
      env: { ...process.env, CONTROL_SOCKET: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', c => (out += c))
    child.stderr.on('data', c => (out += c))
    child.on('close', code => resolve({ code, out }))
  })
}

test('npm run join --speaker-probe asks for the probe, and is refused by a service where it is off or that has none; without it, nothing is asked', { timeout: 30_000 }, async t => {
  const on = await start(t, { speakerProbe: true })
  const ok = await runCli('src/cli/join.ts', [ZOOM, '--speaker-probe'], { ALEX_DATA_DIR: on.dataDir })
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /The speaker probe is on for this meeting: use it only in a test meeting whose participants have agreed/)
  assert.ok(on.plans[0].eventsUrl)

  const off = await start(t)
  const refused = await runCli('src/cli/join.ts', [ZOOM, '--speaker-probe'], { ALEX_DATA_DIR: off.dataDir })
  assert.equal(refused.code, 1)
  assert.ok(refused.out.includes(PROBE_OFF), refused.out)
  assert.equal(off.plans.length, 0)

  // An older service: no speaker_probe in its /health, and it would take the join and ignore the flag.
  const old = tempDir(t)
  fs.copyFileSync(path.join(on.dataDir, 'local-token'), path.join(old, 'local-token'))
  const asked: string[] = []
  const bodies: string[] = []
  const oldService = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`)
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      bodies.push(body)
      res.end(req.url === '/health' ? JSON.stringify({ ok: true, features: ['meeting_brief'] }) : JSON.stringify({ bot_id: 'b', tip: '' }))
    })
  })
  await new Promise<void>(r => oldService.listen(path.join(old, 'control.sock'), r))
  t.after(() => oldService.close())
  const older = await runCli('src/cli/join.ts', [ZOOM, '--speaker-probe'], { ALEX_DATA_DIR: old })
  assert.equal(older.code, 1, older.out)
  assert.match(older.out, /older than this command and has no speaker probe/)
  assert.deepEqual(asked, ['GET /health'], 'no bot asked for')
  // Without the flag the request is what it always was: no speaker_probe in it.
  assert.equal((await runCli('src/cli/join.ts', [ZOOM], { ALEX_DATA_DIR: old })).code, 0)
  assert.deepEqual(asked, ['GET /health', 'POST /api/join'])
  assert.deepEqual(Object.keys(JSON.parse(bodies.at(-1)!)), ['meetingUrl'])
})

test('npm run check says whether the speaker probe is on, and what it does when it is', { timeout: 30_000 }, async () => {
  const keys = { ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '', ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '' }
  const on = await runCli('src/cli/check.ts', [], { ...keys, SPEAKER_PROBE: '1' })
  assert.match(on.out, /^ {2}Speaker probe: on\. SPEAKER_PROBE is on: a meeting joined with npm run join -- "<link>" --speaker-probe .*test meetings whose participants have agreed/m)
  const off = await runCli('src/cli/check.ts', [], { ...keys, SPEAKER_PROBE: '' })
  assert.match(off.out, /^ {2}Speaker probe: off \(SPEAKER_PROBE, for test meetings only/m)
})
