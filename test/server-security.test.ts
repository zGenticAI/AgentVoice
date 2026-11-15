// The service's listeners, as a stranger on the internet, a web page in a browser on this computer, or
// another program here would meet them. Recall and the meeting sessions are fakes; the listeners are real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { ROOT, cap, retiredSettings } from '../src/config.ts'
import { ensureLocalToken, localTokenPath, prepareDataDir, readLocalToken } from '../src/local-token.ts'
import { MeetingSession, PAGE_CLOSE, PAGE_ERRORS, type SessionOptions } from '../src/pipeline/session.ts'
import { RecallError } from '../src/recall.ts'
import { PENDING_BOTS_FILE, type ServiceConfig, type ServiceSession, createServers, stopper } from '../src/server.ts'

const PAGE_TOKEN = 'p'.repeat(48)
const ZOOM = 'https://us06web.zoom.us/j/123456789?pwd=abc'

type Ctx = { after: (fn: () => unknown) => void }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await wait(10)
}

// A Unix socket's path is short (103 bytes on macOS, 107 on Linux), so the tests make their folders in /tmp,
// whatever TMPDIR says. mkdtemp makes each one readable by its owner only, as the data folder is.
const TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
function tempDir(t: Ctx, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(TMP, prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

let secrets = 0

/**
 * Stands in for a MeetingSession: says what it was started with, and when its time ran out. Like one, it sends 'ready'
 * with its secret on each connection, carries on while its page is away, takes the page back with attach (letting go of
 * a connection it replaces), and closes its page with 4000 as it ends.
 */
class FakeSession implements ServiceSession {
  readonly transcript = { recent: () => '' }
  readonly timeLimits: number[] = []
  readonly startedAt = Date.now()
  readonly rejoin = `rejoin-secret-${++secrets}-${'s'.repeat(24)}`
  readonly over: Promise<void>
  readonly attached: { got?: number }[] = []
  private resolveOver!: () => void
  ws!: WebSocket
  ended = false
  leftMeeting = false
  /** How many times its page's connection has closed while it was live. */
  drops = 0
  /** Whether a page has sent it anything: until then, as with a MeetingSession, a page without the secret may take over. */
  spoke = false
  constructor(
    ws: WebSocket,
    readonly opts: SessionOptions,
    readonly reconnectMs: number,
  ) {
    this.over = new Promise(resolve => (this.resolveOver = resolve))
    this.wire(ws)
  }
  private wire(ws: WebSocket) {
    this.ws = ws
    ws.send(JSON.stringify({ type: 'ready', sampleRate: 16000, rejoin: this.rejoin }))
    ws.on('message', () => {
      if (ws === this.ws) this.spoke = true
    })
    ws.on('close', () => {
      if (ws === this.ws && !this.ended) this.drops++
    })
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
  attach(ws: WebSocket, from: { got?: number }) {
    const old = this.ws
    this.attached.push(from)
    this.wire(ws)
    if (old.readyState !== WebSocket.CLOSED) old.terminate()
  }
  end() {
    if (this.ended) return
    this.ended = true
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(4000, 'over')
    this.resolveOver()
  }
  async reachedTimeLimit(minutes: number) {
    this.timeLimits.push(minutes)
    // Like a MeetingSession: one that is leaving already declines, and ends once its goodbye has played.
    if (!this.leftMeeting) this.end()
  }
}

/** What a test makes Recall do: by default it creates bot-1, bot-2, ... and every leave_call works. */
interface Fakes {
  createBot?: (n: number) => Promise<{ id: string }>
  leaveCall?: (botId: string) => Promise<void>
  /** Throws instead of starting the meeting's session, as a missing key or an unwritable data folder does. */
  startSessionFails?: Error
}

async function start(t: Ctx, overrides: Partial<ServiceConfig> = {}, fakes: Fakes = {}) {
  const dataDir = overrides.dataDir ?? tempDir(t, 'av-sec-')
  const localToken = ensureLocalToken(dataDir)
  const bots: { meetingUrl: string; pageUrl: string }[] = []
  // Every leave_call asked of Recall, in order, whether it worked or not.
  const left: string[] = []
  const started: FakeSession[] = []
  const control = overrides.controlSocket ?? path.join(dataDir, 'control.sock')
  const service = createServers(
    {
      port: 0,
      host: '127.0.0.1',
      controlSocket: control,
      publicUrl: 'https://assistant.example.com',
      agentPageToken: PAGE_TOKEN,
      localToken,
      dataDir,
      maxMeetings: 3,
      maxMeetingMinutes: 180,
      ...overrides,
    },
    {
      createBot: async plan => {
        bots.push(plan)
        return fakes.createBot ? fakes.createBot(bots.length) : { id: `bot-${bots.length}` }
      },
      leaveCall: async botId => {
        left.push(botId)
        await fakes.leaveCall?.(botId)
      },
      startSession: (ws, opts, { reconnectMs }) => {
        if (fakes.startSessionFails) throw fakes.startSessionFails
        const session = new FakeSession(ws, opts, reconnectMs)
        started.push(session)
        return session
      },
    },
  )
  await service.listen()
  t.after(() => service.close())
  const publicPort = (service.publicServer.address() as AddressInfo).port
  const auth = { authorization: `Bearer ${localToken}` }
  /** The meeting key in the bot page URL of the nth bot started. */
  const keyOf = (n: number) => new URL(bots[n].pageUrl).searchParams.get('key')!
  return { service, publicPort, control, dataDir, localToken, auth, bots, left, started, keyOf }
}

/** A TCP port on 127.0.0.1 (the public listener), or a Unix socket's path (the control listener). */
type Target = number | string

/** A plain HTTP request, with whatever headers a test gives (Host included). */
function request(
  target: Target,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const where = typeof target === 'number' ? { host: '127.0.0.1', port: target } : { socketPath: target }
    const req = http.request(
      {
        ...where,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { host: typeof target === 'number' ? `localhost:${target}` : 'localhost', ...opts.headers },
      },
      res => {
        let body = ''
        res.on('data', c => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, body, type: String(res.headers['content-type'] ?? '') }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

/** POST /api/join on the control socket, as npm run join does unless a test changes the headers. */
function joinRequest(target: Target, headers: Record<string, string>, body = JSON.stringify({ meetingUrl: ZOOM })) {
  return request(target, { method: 'POST', path: '/api/join', headers: { 'content-type': 'application/json', ...headers }, body })
}

/** Opens a websocket: 'open' (with the socket) or the HTTP status it was refused with. Through socketPath if given. */
function upgrade(
  url: string,
  headers: Record<string, string> = {},
  socketPath?: string,
): Promise<{ outcome: 'open' | number | 'error'; ws: WebSocket }> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers, ...(socketPath ? { createConnection: () => net.connect(socketPath) } : {}) })
    ws.on('open', () => resolve({ outcome: 'open', ws }))
    ws.on('unexpected-response', (_req, res) => {
      resolve({ outcome: res.statusCode ?? 0, ws })
      ws.terminate()
    })
    ws.on('error', () => resolve({ outcome: 'error', ws }))
  })
}

/** Links to /bridge on the control socket, as the channel does unless a test changes the headers. */
const bridgeLink = (control: string, headers: Record<string, string> = {}) => upgrade('ws://localhost/bridge', headers, control)

/** What the bot page adds to /audio: which try it is (n), and once it has had a 'ready', its secret and what it got. */
type Rejoin = { n?: number; rejoin?: string; got?: number | string }

const botAudio = (port: number, key: string, token = PAGE_TOKEN, more: Rejoin = {}) => {
  const params = new URLSearchParams({ key, token })
  for (const [name, value] of Object.entries(more)) if (value !== undefined) params.set(name, String(value))
  return `ws://127.0.0.1:${port}/audio?${params}`
}

/** Opens the bot page's audio for a meeting, as Recall's browser does through the tunnel. */
async function botPage(port: number, key: string, token = PAGE_TOKEN, more: Rejoin = {}) {
  return upgrade(botAudio(port, key, token, more))
}

/**
 * The bot page's audio, as public/agent.js opens it, keeping every message from the start: 'open' with its 'ready' (and
 * the secret in it), or the HTTP status it was refused with.
 */
function page(port: number, key: string, more: Rejoin = {}, opts: WebSocket.ClientOptions = {}) {
  return new Promise<{ outcome: 'open' | number | 'error'; ws: WebSocket; messages: any[]; ready: () => Promise<string>; code: () => Promise<number> }>(resolve => {
    const ws = new WebSocket(botAudio(port, key, PAGE_TOKEN, more), opts)
    const messages: any[] = []
    ws.on('message', (data, isBinary) => void (isBinary || messages.push(JSON.parse(data.toString()))))
    const ready = async () => {
      await until(() => messages.some(m => m.type === 'ready'))
      return messages.find(m => m.type === 'ready').rejoin as string
    }
    const code = () => new Promise<number>(r => ws.once('close', c => r(c)))
    const done = (outcome: 'open' | number | 'error') => resolve({ outcome, ws, messages, ready, code })
    ws.on('open', () => done('open'))
    ws.on('unexpected-response', (_req, res) => {
      done(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('error', () => done('error'))
  })
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise(resolve => (ws.readyState === WebSocket.CLOSED ? resolve() : ws.once('close', () => resolve())))
}

/** The bot page's audio for the nth meeting started, open, then closed again (its page went, and its session waits for it). */
async function pageComesAndGoes(s: Awaited<ReturnType<typeof start>>, n: number) {
  const page = await botPage(s.publicPort, s.keyOf(n))
  assert.equal(page.outcome, 'open')
  await until(() => s.started.length > 0)
  const session = s.started.at(-1)!
  const drops = session.drops
  page.ws.close()
  await closed(page.ws)
  await until(() => session.drops > drops)
}

/**
 * A websocket upgrade written by hand to a raw socket, so its request target can be anything. With reset, the
 * client resets the connection (RST) the moment it has sent it, or closes it on a Unix socket. Resolves with what
 * the server answered.
 */
function rawUpgrade(target: net.NetConnectOpts, requestTarget: string, opts: { reset?: boolean; headers?: string } = {}): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect(target)
    let got = ''
    // A server that never answers (its handler threw) must not hang the test.
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('data', c => (got += c))
    socket.on('error', () => {})
    socket.on('close', () => resolve(got))
    socket.on('connect', () => {
      socket.write(
        `GET ${requestTarget} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${opts.headers ?? ''}\r\n`,
      )
      // A Unix socket has no reset: closing at once makes the server's write fail (EPIPE) all the same.
      if (opts.reset) 'path' in target ? socket.destroy() : socket.resetAndDestroy()
    })
  })
}

// --- /api/join: no CSRF, only with the local token ---------------------------------------------------------

test('a cross-site text/plain POST to /api/join starts no bot (CSRF)', async t => {
  const s = await start(t)
  // What a form or fetch on any web page can send without asking first, were it ever to reach the socket.
  const forged = await request(s.control, {
    method: 'POST',
    path: '/api/join',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    body: JSON.stringify({ meetingUrl: ZOOM }),
  })
  assert.equal(forged.status, 403)
  // A web page is refused even if it somehow had the token and sent JSON.
  assert.equal((await joinRequest(s.control, { ...s.auth, origin: 'http://localhost' })).status, 403)
  // And JSON is required even with the token.
  const body = JSON.stringify({ meetingUrl: ZOOM })
  const plain = await request(s.control, { method: 'POST', path: '/api/join', headers: { ...s.auth, 'content-type': 'text/plain' }, body })
  assert.equal(plain.status, 415)
  assert.equal(s.bots.length, 0, 'no bot was started')
})

test('/api/join needs the local token, and starts a bot with it', async t => {
  const s = await start(t)
  assert.equal((await joinRequest(s.control, {})).status, 401)
  assert.equal((await joinRequest(s.control, { authorization: `Bearer ${'x'.repeat(64)}` })).status, 401)
  assert.equal((await joinRequest(s.control, { authorization: s.localToken })).status, 401, 'only as a bearer token')
  assert.equal(s.bots.length, 0)

  const ok = await joinRequest(s.control, s.auth)
  assert.equal(ok.status, 200)
  assert.deepEqual(Object.keys(JSON.parse(ok.body)).sort(), ['bot_id', 'brief', 'brief_note', 'platform', 'speaker_probe', 'tip'])
  assert.equal(s.bots.length, 1)
  assert.match(s.bots[0].pageUrl, /^https:\/\/assistant\.example\.com\/agent\?key=[0-9a-f-]{36}&token=p{48}$/)

  assert.equal((await joinRequest(s.control, s.auth, '{not json')).status, 400)
  assert.equal((await joinRequest(s.control, s.auth, JSON.stringify({ meetingUrl: 'https://evil.example/j/1' }))).status, 400)
  assert.equal((await joinRequest(s.control, s.auth, JSON.stringify({ meetingUrl: 'x'.repeat(120_000) }))).status, 413)
  assert.equal(s.bots.length, 1)
})

test('a session that cannot start shows fixed words on the bot page, never its error, which names files on this computer', async t => {
  const failure = new Error('DEEPGRAM_API_KEY is not set. Add it to /home/sam/agent-voice/.env')
  const s = await start(t, {}, { startSessionFails: failure })
  const errors: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const messages: unknown[] = []
  const ws = new WebSocket(botAudio(s.publicPort, s.keyOf(0)))
  ws.on('message', (data, isBinary) => void (isBinary || messages.push(JSON.parse(data.toString()))))
  const code = await new Promise(resolve => ws.on('close', resolve))
  t.mock.restoreAll()
  assert.deepEqual(messages, [{ type: 'error', message: PAGE_ERRORS.start }])
  assert.ok(errors.some(line => line.includes(failure.message)), 'the error itself is in the log')
  // The page is told not to try again, and nothing will start for the meeting, so its bot leaves at once.
  assert.equal(code, PAGE_CLOSE.cannotStart)
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal((await botPage(s.publicPort, s.keyOf(0))).outcome, 403)
})

test("the bot page's own failure shows fixed words too, never the error", () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'agent.html'), 'utf8')
  assert.doesNotMatch(page, /err(or)?\.message/, 'the page puts no error text on the camera')
  assert.match(page, /stateLine\.textContent = "error: can't start"/)
})

test("a join is refused, and no bot created, when PUBLIC_URL isn't an https address the bot can reach", async t => {
  for (const publicUrl of ['', 'http://assistant.example.com', 'https://localhost:8787', 'https://127.0.0.1:8787']) {
    const s = await start(t, { publicUrl })
    const refused = await joinRequest(s.control, s.auth)
    assert.equal(refused.status, 400, publicUrl)
    assert.match(refused.body, /^PUBLIC_URL /, publicUrl)
    assert.equal(s.bots.length, 0, publicUrl)
  }
})

test('the log names the bot and the platform of a meeting it joins, never the meeting link, which nothing deletes', async t => {
  const s = await start(t)
  const logged: string[] = []
  t.mock.method(console, 'log', (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  const meet = 'https://meet.google.com/abc-defg-hij'
  assert.equal((await joinRequest(s.control, s.auth, JSON.stringify({ meetingUrl: meet }))).status, 200)
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  t.mock.restoreAll()
  const joins = logged.filter(line => line.startsWith('[join]'))
  assert.equal(joins.length, 2, logged.join('\n'))
  assert.match(joins[0], /^\[join\] bot \S+ is joining a Google Meet meeting$/)
  assert.match(joins[1], /^\[join\] bot \S+ is joining a Zoom meeting$/)
  for (const line of logged) {
    assert.ok(!line.includes('abc-defg-hij') && !line.includes('123456789') && !line.includes('meet.google.com') && !line.includes('zoom.us'), line)
  }
  assert.equal(s.bots.length, 2)
})

// --- The control socket: only you can reach it, and nobody can take its place ----------------------------------

test('the control side is a Unix socket in the data folder that only you can use, and no TCP port', async t => {
  const s = await start(t)
  assert.equal(s.control, path.join(s.dataDir, 'control.sock'))
  const stat = fs.lstatSync(s.control)
  assert.ok(stat.isSocket())
  assert.equal(stat.mode & 0o777, 0o600)
  assert.equal(s.service.controlServer.address(), s.control, 'not a TCP port another user could take while the service is down')
  // As curl --unix-socket <socket> http://localhost/health asks.
  const health = await request(s.control, { path: '/health' })
  assert.equal(health.status, 200)
  // Closed: the socket goes with it.
  await s.service.close()
  assert.equal(fs.existsSync(s.control), false)
})

test('the service will not start on a control socket path that is something else, nor beside a running service; it replaces a stale one', async t => {
  const dir = tempDir(t, 'av-sock-')
  const file = path.join(dir, 'control.sock')
  fs.writeFileSync(file, 'not a socket')
  await assert.rejects(start(t, { dataDir: dir }), /control\.sock exists and is not a socket/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a socket', 'left as it was')
  fs.rmSync(file)

  // A stale socket, as a service killed without stopping leaves behind: nothing listens on it.
  const old = net.createServer()
  await new Promise<void>(resolve => old.listen(path.join(dir, 'old.sock'), resolve))
  fs.linkSync(path.join(dir, 'old.sock'), file)
  await new Promise(resolve => old.close(resolve))
  assert.ok(fs.lstatSync(file).isSocket())
  const s = await start(t, { dataDir: dir })
  assert.equal((await request(s.control, { path: '/health' })).status, 200)

  // A second service on the same socket is refused, and the first keeps it.
  await assert.rejects(start(t, { dataDir: dir }), /Another voice service is already running on .*control\.sock/)
  assert.equal((await request(s.control, { path: '/health' })).status, 200)
})

test('a control socket path the system cannot take, or in a folder others can open, fails at start and names CONTROL_SOCKET', async t => {
  const dir = tempDir(t, 'av-long-')
  const long = path.join(dir, `${'x'.repeat(120)}.sock`)
  await assert.rejects(start(t, { dataDir: dir, controlSocket: long }), /longer than this system allows .*Set CONTROL_SOCKET/s)
  const open = tempDir(t, 'av-open-')
  fs.chmodSync(open, 0o755)
  await assert.rejects(start(t, { dataDir: dir, controlSocket: path.join(open, 'control.sock') }), /only you can open.*CONTROL_SOCKET/s)
  assert.equal(fs.existsSync(path.join(open, 'control.sock')), false)
})

test('CONTROL_PORT is gone: the service says so once if .env still sets it', () => {
  assert.deepEqual(retiredSettings({ ALEX_MODEL: 'claude-sonnet-5-5' }), ['[config] ALEX_MODEL is now called AGENT_MODEL. It still works for now: rename it in .env.'])
  assert.deepEqual(retiredSettings({ ALEX_MODEL: 'x', AGENT_MODEL: 'y' }), [], 'AGENT_MODEL set: nothing to rename')
  assert.deepEqual(retiredSettings({}), [])
  const [warning, ...more] = retiredSettings({ CONTROL_PORT: '8788' })
  assert.equal(more.length, 0)
  assert.match(warning, /CONTROL_PORT does nothing now/)
  assert.match(warning, /control socket/)
  assert.match(warning, /Remove CONTROL_PORT from \.env/)
})

// --- /bridge: the channel only --------------------------------------------------------------------------------

test('/bridge links only with the local token, and never from a web page', async t => {
  const s = await start(t)
  assert.equal((await bridgeLink(s.control)).outcome, 401)
  assert.equal((await bridgeLink(s.control, { authorization: `Bearer ${'x'.repeat(64)}` })).outcome, 401)
  assert.equal((await bridgeLink(s.control, { ...s.auth, origin: 'https://evil.example' })).outcome, 403)
  assert.equal((await bridgeLink(s.control, { ...s.auth, origin: 'http://localhost' })).outcome, 403, 'not even a page from this computer')
  assert.equal(s.service.bridge.connected, false)

  const linked = await bridgeLink(s.control, s.auth)
  assert.equal(linked.outcome, 'open')
  await until(() => s.service.bridge.connected)
  const health = JSON.parse((await request(s.control, { path: '/health' })).body)
  assert.equal(health.session_linked, true)

  // The brief it saves is readable by the owner only.
  linked.ws.send(JSON.stringify({ type: 'set_brief', request_id: 'r1', markdown: '# Brief\nNot for disclosure: the price.' }))
  const brief = path.join(s.dataDir, 'brief.md')
  await until(() => fs.existsSync(brief))
  assert.equal(fs.statSync(brief).mode & 0o777, 0o600)
  linked.ws.close()
})

// --- What the public port serves ------------------------------------------------------------------------------

test('the public port serves the bot page the service was given when it was made, as it was then', async t => {
  const s = await start(t, { agentPage: '<p>Nova, an AI assistant</p>' })
  const page = await request(s.publicPort, { path: '/agent' })
  assert.deepEqual([page.status, page.body], [200, '<p>Nova, an AI assistant</p>'])
  assert.match(page.type, /^text\/html/)
  assert.equal((await request(s.publicPort, { path: '/agent.js' })).body, fs.readFileSync(path.join(ROOT, 'public', 'agent.js'), 'utf8'))
})

test('the public port serves only what the meeting bot needs', async t => {
  const s = await start(t)
  for (const p of ['/agent', '/agent.js', '/pcm-worklet.js']) assert.equal((await request(s.publicPort, { path: p })).status, 200, p)
  for (const p of ['/', '/talk.html']) assert.equal((await request(s.publicPort, { path: p })).status, 404, `nothing at ${p}`)
  // The bot page goes out with the assistant's name in it (Alex under npm test), HTML-escaped by src/pages.ts.
  const page = (await request(s.publicPort, { path: '/agent' })).body
  assert.match(page, /<body data-agent-name="Alex">/)
  assert.match(page, /<h1[^>]*>Alex<\/h1>/)
  assert.doesNotMatch(page, /\{\{name\}\}/)
  assert.equal((await joinRequest(s.publicPort, s.auth)).status, 404, 'no /api/join, even with the local token')
  assert.equal(s.bots.length, 0)
  assert.equal((await upgrade(`ws://127.0.0.1:${s.publicPort}/bridge`, s.auth)).outcome, 404, 'no /bridge')
  // Audio only for a meeting this service started, even from a page of the same site.
  const sameSite = { origin: `http://localhost:${s.publicPort}`, host: `localhost:${s.publicPort}` }
  assert.equal((await upgrade(`ws://127.0.0.1:${s.publicPort}/audio`, sameSite)).outcome, 403, 'no audio without the page token and a meeting key')
  assert.equal((await upgrade(botAudio(s.publicPort, 'local'), sameSite)).outcome, 403, 'nor with a key this service did not give out')
  assert.equal(s.started.length, 0)
  // Nothing behind a proxy that adds forwarding headers, or none, changes that.
  assert.equal((await request(s.publicPort, { path: '/', headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 404)
})

// --- Upgrades that can't be parsed, or are reset at once: the service stays up ----------------------------

const BAD_TARGETS = ['//%5B/audio', '//[', '//localhost:99999/audio']

test('an upgrade whose request target is not a URL is refused, and the service stays up', { timeout: 20_000 }, async t => {
  const s = await start(t)
  for (const target of BAD_TARGETS) {
    const pub = await rawUpgrade({ host: '127.0.0.1', port: s.publicPort }, target)
    assert.match(pub, /^HTTP\/1\.1 400 /, `public ${target}`)
    const control = await rawUpgrade({ path: s.control }, target, { headers: `authorization: Bearer ${s.localToken}\r\n` })
    assert.match(control, /^HTTP\/1\.1 400 /, `control ${target}`)
  }
  assert.equal((await request(s.publicPort, { path: '/health' })).status, 200)
  assert.equal((await request(s.control, { path: '/health' })).status, 200)
})

test('a client that resets the connection right after a refused upgrade does not take the service down', { timeout: 30_000 }, async t => {
  const s = await start(t)
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const pub = { host: '127.0.0.1', port: s.publicPort }
  const refused: [net.NetConnectOpts, string][] = [
    ...['/x', '/audio', `/audio?key=${s.keyOf(0)}&token=${'q'.repeat(48)}`, BAD_TARGETS[0]].map(p => [pub, p] as [net.NetConnectOpts, string]),
    ...['/x', '/bridge', BAD_TARGETS[0]].map(p => [{ path: s.control }, p] as [net.NetConnectOpts, string]),
  ]
  // A reset only kills the process when it lands before the refusal is written, so each is tried a few times.
  for (let i = 0; i < 15; i++) {
    await Promise.all(refused.map(([target, p]) => rawUpgrade(target, p, { reset: true })))
  }
  await wait(100)
  assert.equal((await request(s.publicPort, { path: '/health' })).status, 200)
  assert.equal((await request(s.control, { path: '/health' })).status, 200)
})

test('the public /health says only that the service is up; the control one says more', async t => {
  const s = await start(t)
  const pub = await request(s.publicPort, { path: '/health' })
  assert.equal(pub.status, 200)
  assert.equal(pub.body, '{"ok":true}', 'nothing about meetings or the session link')
  const control = JSON.parse((await request(s.control, { path: '/health' })).body)
  assert.deepEqual(control, { ok: true, session_linked: false, meetings: 0, bot_meetings: 0, max_meetings: 3, features: ['meeting_brief', 'why_not_answered'], speaker_probe: false })
})

test('a message over its limit closes the connection it came on: 1 MiB on /bridge, 64 KiB on /audio', async t => {
  const s = await start(t)
  // The close code, or 0 if the connection is still open after 3 s.
  const closeCode = (ws: WebSocket) =>
    new Promise<number>(resolve => {
      const timer = setTimeout(() => resolve(0), 3000)
      ws.once('close', code => (clearTimeout(timer), resolve(code)))
    })

  // The channel's largest message, a brief, is under 100 KB: one just under the limit is still read.
  const linked = await bridgeLink(s.control, s.auth)
  assert.equal(linked.outcome, 'open')
  const got: any[] = []
  linked.ws.on('message', raw => void got.push(JSON.parse(raw.toString())))
  const pad = 'x'.repeat(1024 * 1024 - 100)
  linked.ws.send(JSON.stringify({ type: 'get_transcript', request_id: 't1', pad }))
  await until(() => got.some(m => m.request_id === 't1'))
  assert.ok(got.some(m => m.type === 'transcript' && m.request_id === 't1'))
  const bridgeClosed = closeCode(linked.ws)
  linked.ws.send(JSON.stringify({ type: 'get_transcript', request_id: 't2', pad: `${pad}${'x'.repeat(200)}` }))
  assert.equal(await bridgeClosed, 1009, 'Message Too Big')
  assert.equal(got.some(m => m.request_id === 't2'), false)

  // The bot page sends 80 ms frames of 2,560 bytes. The fake session listens for no errors on its page, as a session
  // that could not start doesn't: the service itself must, or the refusal of a frame too big would take it down.
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const audio = await page(s.publicPort, s.keyOf(0), { n: 1 })
  assert.equal(audio.outcome, 'open')
  await audio.ready()
  audio.ws.send(Buffer.alloc(64 * 1024))
  await until(() => s.started[0]?.spoke)
  assert.equal(audio.ws.readyState, WebSocket.OPEN)
  const audioClosed = closeCode(audio.ws)
  audio.ws.send(Buffer.alloc(64 * 1024 + 1))
  assert.equal(await audioClosed, 1009)
  assert.equal((await request(s.control, { path: '/health' })).status, 200, 'the service carries on')
})

test('the control socket serves no pages and no audio: only /api/join, /bridge and /health', async t => {
  const s = await start(t)
  for (const p of ['/', '/talk.html', '/agent', '/agent.js', '/pcm-worklet.js']) {
    assert.equal((await request(s.control, { path: p })).status, 404, p)
  }
  // Not even the audio of a live meeting, with its key and the page token: bot pages connect through the public port only.
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const audio = `ws://localhost/audio?${new URLSearchParams({ key: s.keyOf(0), token: PAGE_TOKEN })}`
  assert.equal((await upgrade(audio, { origin: 'http://localhost' }, s.control)).outcome, 404)
  assert.equal((await upgrade(audio, {}, s.control)).outcome, 404)
  assert.equal(s.started.length, 0)
})

// --- Bot sessions: only for live meetings this service started -------------------------------------------------

test('a bot page needs the page token and the key of a live meeting this service started', async t => {
  const s = await start(t, { reconnectMs: 150 })
  assert.equal((await botPage(s.publicPort, 'made-up')).outcome, 403, 'a made-up key, with the right token')
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const key = s.keyOf(0)
  assert.equal((await botPage(s.publicPort, key, 'q'.repeat(48))).outcome, 403, 'the right key with the wrong token')
  assert.equal((await botPage(s.publicPort, key, '')).outcome, 403)
  assert.equal(s.started.length, 0)

  const first = await page(s.publicPort, key, { n: 1 })
  assert.equal(first.outcome, 'open')
  await until(() => s.started.length === 1)
  assert.deepEqual(s.started[0].opts, { meetingKey: key, botId: 'bot-1', platform: 'Zoom' })
  const rejoin = await first.ready()
  first.ws.send(Buffer.alloc(2560))
  await until(() => s.started[0].spoke)
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 2 })).outcome, 409, 'a second page for the same meeting at the same time')

  // The page that comes back for the meeting, with the secret from its 'ready', is let back in to the same session.
  first.ws.close()
  await closed(first.ws)
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 3 })).outcome, 409, 'not a page without it')
  const again = await botPage(s.publicPort, key, PAGE_TOKEN, { n: 4, rejoin, got: 0 })
  assert.equal(again.outcome, 'open')
  assert.deepEqual(s.started[0].attached, [{ got: 0 }])
  again.ws.close()
  await closed(again.ws)
  // Once the meeting is over (its page gone for longer than the window), its bot is asked to leave and its key opens nothing.
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal(s.started[0].ended, true, 'its session ended with the window')
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 5, rejoin, got: 0 })).outcome, 403)
  assert.equal(s.started.length, 1, 'one session for the meeting')
})

test('a meeting whose bot page never connects gives up its key and its bot leaves the call', async t => {
  const s = await start(t, { pageWaitMs: 100, maxMeetings: 1 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  assert.equal((await joinRequest(s.control, s.auth)).status, 400, 'its place is held while its page may still come')
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal((await botPage(s.publicPort, s.keyOf(0))).outcome, 403)
  assert.equal((await joinRequest(s.control, s.auth)).status, 200, 'and its place is free')
})

// --- A page that drops and comes back ----------------------------------------------------------------------------

test("once its page has sent anything, a page comes back to its session only with the secret from its 'ready': not without it, nor with another meeting's, live or away", async t => {
  const s = await start(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const [a, b] = [s.keyOf(0), s.keyOf(1)]
  const pageA = await page(s.publicPort, a, { n: 1 })
  const pageB = await page(s.publicPort, b, { n: 1 })
  const [secretA, secretB] = [await pageA.ready(), await pageB.ready()]
  assert.notEqual(secretA, secretB)
  assert.match(secretA, /^rejoin-secret-/)
  pageA.ws.send(Buffer.alloc(2560))
  await until(() => s.started[0].spoke)
  // Live: none of these takes the page's place.
  for (const more of [{ n: 2 }, { n: 2, rejoin: secretB, got: 0 }, { n: 2, rejoin: `${secretA}x`, got: 0 }, { n: 2, rejoin: '', got: 0 }]) {
    assert.equal((await botPage(s.publicPort, a, PAGE_TOKEN, more)).outcome, 409, JSON.stringify(more))
  }
  // Away: the same.
  pageA.ws.close()
  await until(() => s.started[0].drops === 1)
  for (const more of [{ n: 3 }, { n: 3, rejoin: secretB, got: 0 }, { n: 3, rejoin: secretA.slice(0, -1), got: 0 }]) {
    assert.equal((await botPage(s.publicPort, a, PAGE_TOKEN, more)).outcome, 409, JSON.stringify(more))
  }
  assert.equal(s.started.length, 2, 'no session was started for any of them')
  assert.deepEqual(s.started[0].attached, [])
  // Its own secret, and the bytes of voice it says it got, reach its session.
  const back = await page(s.publicPort, a, { n: 4, rejoin: secretA, got: 123_456 })
  assert.equal(back.outcome, 'open')
  assert.equal(await back.ready(), secretA, 'the same secret in every ready')
  assert.deepEqual(s.started[0].attached, [{ got: 123_456 }])
  assert.equal(s.started.length, 2)
  assert.deepEqual(s.left, [])
  const health = JSON.parse((await request(s.control, { path: '/health' })).body)
  assert.equal(health.meetings, 2)
})

test("a page whose first 'ready' was lost comes in without the secret while no page has sent anything, with a later try only", async t => {
  const s = await start(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const key = s.keyOf(0)
  const first = await page(s.publicPort, key, { n: 3 })
  await first.ready()
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 3 })).outcome, 409, 'the same try')
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 2 })).outcome, 409, 'an earlier try')
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, {})).outcome, 409, 'no try number')
  const second = await page(s.publicPort, key, { n: 4 })
  assert.equal(second.outcome, 'open', 'live')
  await closed(first.ws)
  assert.equal(await second.ready(), s.started[0].rejoin)
  second.ws.close()
  await until(() => s.started[0].drops === 1)
  const third = await page(s.publicPort, key, { n: 5, rejoin: '', got: 0 })
  assert.equal(third.outcome, 'open', 'away')
  third.ws.send(Buffer.alloc(2560))
  await until(() => s.started[0].spoke)
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 6 })).outcome, 409, 'not once a page has sent anything')
  assert.equal(s.started.length, 1)
  assert.deepEqual(s.started[0].attached, [{ got: undefined }, { got: 0 }])
  await wait(50)
  assert.deepEqual(s.left, [])
  assert.equal(third.ws.readyState, WebSocket.OPEN)
})

test('what a coming-back page says it got reaches its session as a count, or not at all', async t => {
  const s = await start(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const first = await page(s.publicPort, s.keyOf(0), { n: 1 })
  const rejoin = await first.ready()
  let n = 1
  for (const got of ['12', '-1', '1e3', 'x', '', '9'.repeat(16)]) {
    const next = await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: ++n, rejoin, got })
    assert.equal(next.outcome, 'open', got)
  }
  assert.deepEqual(s.started[0].attached.map(a => a.got), [12, undefined, undefined, undefined, undefined, undefined])
})

test('the page coming back while its old connection still looks live takes its place at once, and the old one is let go', async t => {
  const s = await start(t, { reconnectMs: 100 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const old = await page(s.publicPort, s.keyOf(0), { n: 1 })
  const rejoin = await old.ready()
  // The page has given up on its connection (it went silent), which still looks open from here.
  const back = await page(s.publicPort, s.keyOf(0), { n: 2, rejoin, got: 0 })
  assert.equal(back.outcome, 'open')
  await closed(old.ws)
  assert.deepEqual(s.started[0].attached, [{ got: 0 }])
  // The old connection's close changes nothing: the meeting is live, with no window running.
  await wait(250)
  assert.deepEqual(s.left, [])
  assert.equal(s.started[0].ended, false)
  assert.equal(back.ws.readyState, WebSocket.OPEN)
  back.ws.send(Buffer.alloc(2560))
  await until(() => s.started[0].spoke)
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 3 })).outcome, 409, 'still one page per meeting')
})

test('a try the page gave up on that arrives late is refused: each try must count up from the last one let in', async t => {
  const s = await start(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const first = await page(s.publicPort, s.keyOf(0), { n: 3 })
  const rejoin = await first.ready()
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 3, rejoin, got: 0 })).outcome, 409, 'live: the same try again')
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin, got: 0 })).outcome, 409, 'live: an earlier try')
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { rejoin, got: 0 })).outcome, 409, 'live: no try number')
  const later = await page(s.publicPort, s.keyOf(0), { n: 7, rejoin, got: 0 })
  assert.equal(later.outcome, 'open')
  later.ws.close()
  await until(() => s.started[0].drops === 1)
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 5, rejoin, got: 0 })).outcome, 409, 'away: an earlier try')
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 7, rejoin, got: 0 })).outcome, 409, 'away: the same try')
  assert.equal(first.ws.readyState, WebSocket.CLOSED)
  assert.deepEqual(s.started[0].attached, [{ got: 0 }], 'only the later try reached the session')
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 8, rejoin, got: 0 })).outcome, 'open')
})

test("the server sends {type:'hb'} and a ping every quarter of pageSilenceMs, and drops a page that has gone silent", { timeout: 10_000 }, async t => {
  const s = await start(t, { pageSilenceMs: 400, reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  let pings = 0
  // A page whose connection died on the way: it neither sends audio nor answers pings.
  const dead = await page(s.publicPort, s.keyOf(0), { n: 1 }, { autoPong: false })
  dead.ws.on('ping', () => pings++)
  const from = Date.now()
  const code = await dead.code()
  const after = Date.now() - from
  assert.ok(after >= 380 && after < 1000, `dropped after ${after} ms`)
  assert.equal(code, 1006, 'cut off, not closed: the page reconnects')
  const beats = dead.messages.filter(m => m.type === 'hb').length
  assert.ok(beats >= 2 && beats <= 4, `${beats} heartbeats`)
  assert.ok(pings >= 2, `${pings} pings`)
  await until(() => s.started[0].drops === 1)
  // A page that answers pings, but sends nothing (its microphone is quiet), is not dropped.
  const quiet = await page(s.publicPort, s.keyOf(0), { n: 2, rejoin: s.started[0].rejoin, got: 0 })
  await wait(1000)
  assert.equal(quiet.ws.readyState, WebSocket.OPEN)
  assert.ok(quiet.messages.filter(m => m.type === 'hb').length >= 7)
})

test('the heartbeat of a page is stopped when its connection closes, and when the server cuts it off', { timeout: 10_000 }, async t => {
  const created: unknown[] = []
  const cleared = new Set<unknown>()
  const setInterval = globalThis.setInterval
  const clearInterval = globalThis.clearInterval
  t.mock.method(globalThis, 'setInterval', (fn: () => void, ms: number) => {
    const handle = setInterval(fn, ms)
    if (ms === 100) created.push(handle)
    return handle
  })
  t.mock.method(globalThis, 'clearInterval', (handle: NodeJS.Timeout) => {
    cleared.add(handle)
    return clearInterval(handle)
  })
  const s = await start(t, { pageSilenceMs: 400, reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const first = await page(s.publicPort, s.keyOf(0), { n: 1 })
  const rejoin = await first.ready()
  first.ws.close()
  await until(() => s.started[0].drops === 1)
  assert.equal(created.length, 1)
  assert.ok(cleared.has(created[0]), 'stopped as the connection closed, not a silence later')
  const silent = await page(s.publicPort, s.keyOf(0), { n: 2, rejoin, got: 0 }, { autoPong: false })
  await silent.code()
  await until(() => s.started[0].drops === 2)
  t.mock.restoreAll()
  assert.equal(created.length, 2, 'one heartbeat for each connection')
  assert.ok(cleared.has(created[1]), 'stopped as the server cut it off')
})

test('a page that does not come back within the window: its session ends (with its minutes), the bot leaves, and its key opens nothing', async t => {
  const s = await start(t, { reconnectMs: 150 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const from = Date.now()
  await pageComesAndGoes(s, 0)
  assert.equal(s.service.sessions.size, 1, 'the session is still live while its page is away')
  await wait(50)
  assert.deepEqual(s.left, [], 'not before the window ends')
  await until(() => s.left.length > 0)
  assert.ok(Date.now() - from >= 150)
  assert.equal(s.started[0].ended, true)
  assert.deepEqual(s.left, ['bot-1'])
  await until(() => s.service.sessions.size === 0)
  assert.equal(s.service.sessions.size, 0, 'not live once it is over')
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin: s.started[0].rejoin, got: 0 })).outcome, 403)
})

test('a session that ends while its page is away (Recall says its bot left) frees its meeting at once, and lets no page in', async t => {
  const s = await start(t, { maxMeetings: 1, reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  await pageComesAndGoes(s, 0)
  s.started[0].end()
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'], 'without waiting for the window')
  await until(() => s.service.sessions.size === 0)
  assert.equal(s.service.sessions.size, 0, 'not live once it is over')
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin: s.started[0].rejoin, got: 0 })).outcome, 403)
  await wait(20)
  assert.equal((await joinRequest(s.control, s.auth)).status, 200, 'its place is free')
})

test('when the meeting session ends, its page is closed with 4000 (over), the bot leaves at once, and later pages get 403', async t => {
  const s = await start(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const live = await page(s.publicPort, s.keyOf(0), { n: 1 })
  const rejoin = await live.ready()
  const code = live.code()
  s.started[0].end()
  assert.equal(await code, PAGE_CLOSE.over)
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin, got: 0 })).outcome, 403)
  assert.equal((await botPage(s.publicPort, s.keyOf(0))).outcome, 403)
  await wait(50)
  assert.deepEqual(s.left, ['bot-1'], 'its close changed nothing more')
})

test('after "please leave" or a removal while the page is away, its secret no longer lets it in, and the bot leaves', async t => {
  const s = await start(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  await pageComesAndGoes(s, 0)
  const session = s.started[0]
  session.leftMeeting = true // "Alex, please leave", among the last words heard before the page dropped
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin: session.rejoin, got: 0 })).outcome, 409)
  session.end()
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 3, rejoin: session.rejoin, got: 0 })).outcome, 403)
})

test('stopping ends the sessions whose page is away too, so their meeting_ended still goes out, and lets no page back', async t => {
  const s = await start(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  await pageComesAndGoes(s, 0)
  const ended: number[] = []
  const exits: number[] = []
  const stop = stopper(s.service, {
    endSessions: async sessions => {
      for (const session of sessions) session.end()
      ended.push(sessions.length)
    },
    exit: code => void exits.push(code),
    exitDelayMs: 0,
  })
  stop('SIGTERM')
  await until(() => exits.length > 0)
  assert.deepEqual(ended, [1])
  assert.equal(s.started[0].ended, true)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin: s.started[0].rejoin, got: 0 })).outcome, 503)
})

test('a page dropping, coming back, going silent and being refused logs no meeting key, secret, token or URL', { timeout: 10_000 }, async t => {
  const logged: string[] = []
  for (const name of ['log', 'warn', 'error', 'info'] as const) {
    t.mock.method(console, name, (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  }
  const s = await start(t, { pageSilenceMs: 300, reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const key = s.keyOf(0)
  const first = await page(s.publicPort, key, { n: 1 })
  const rejoin = await first.ready()
  first.ws.send(Buffer.alloc(2560))
  await until(() => s.started[0].spoke)
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 2 })).outcome, 409)
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 1, rejoin, got: 0 })).outcome, 409)
  const back = await page(s.publicPort, key, { n: 2, rejoin, got: 640 }, { autoPong: false })
  assert.equal(back.outcome, 'open')
  await back.code()
  await until(() => s.started[0].drops >= 1)
  s.started[0].end()
  await until(() => s.left.length > 0)
  t.mock.restoreAll()
  assert.ok(logged.some(line => /page went silent/.test(line)), logged.join('\n'))
  assert.ok(logged.some(line => /came back/.test(line)), logged.join('\n'))
  for (const line of logged) {
    for (const secret of [key, rejoin, PAGE_TOKEN, 'ws://', '/audio?', 'got=']) assert.ok(!line.includes(secret), `${secret} in: ${line}`)
  }
})

// --- Through a real meeting session -------------------------------------------------------------------------------

/** Speech recognition for a real meeting session: it hears what the test says the meeting said. */
class FakeFlux extends EventEmitter {
  received = 0
  closed = false
  send() {
    this.received++
  }
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  said(text: string) {
    this.emit('turn', { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: text })
  }
}

/**
 * The listeners with real MeetingSessions behind them, as the service runs them, but with fake speech recognition,
 * a fake ElevenLabs (each line is `voiceMs` of audio, sent at once) and a fake Recall. What a session asks of Recall
 * itself goes in sessionLeft; when a session was told the time limit was reached goes in timeLimits.
 */
async function startReal(t: Ctx, overrides: Partial<ServiceConfig> = {}, voiceMs = 100) {
  const dataDir = tempDir(t, 'av-real-')
  const localToken = ensureLocalToken(dataDir)
  const bots: { pageUrl: string }[] = []
  const left: string[] = []
  const sessionLeft: string[] = []
  const timeLimits: number[] = []
  const fluxes: FakeFlux[] = []
  const sessions: MeetingSession[] = []
  const control = path.join(dataDir, 'control.sock')
  const service = createServers(
    {
      port: 0,
      host: '127.0.0.1',
      controlSocket: control,
      publicUrl: 'https://assistant.example.com',
      agentPageToken: PAGE_TOKEN,
      localToken,
      dataDir,
      maxMeetings: 3,
      maxMeetingMinutes: 180,
      ...overrides,
    },
    {
      createBot: async plan => {
        bots.push(plan)
        return { id: `bot-${bots.length}` }
      },
      leaveCall: async botId => void left.push(botId),
      startSession: (ws, opts, { bridge, brief, reconnectMs }) => {
        const flux = new FakeFlux()
        const session = new MeetingSession(ws, opts, {
          brain: { async *respond() {} } as any,
          bridge,
          brief,
          flux: () => flux as any,
          speak: async function* () {
            yield Buffer.alloc(voiceMs * 32)
          },
          recall: {
            sendChat: async () => {},
            leaveCall: async (botId: string) => void sessionLeft.push(botId),
            deleteMedia: async () => true,
            howBotEnded: async () => ({ kind: 'ended', sub_code: 'bot_received_leave_call' }) as const,
            botLeftCall: (_id: string, { signal }: { signal?: AbortSignal } = {}) =>
              new Promise<null>(resolve => signal?.addEventListener('abort', () => resolve(null))),
          },
          writeMinutes: async () => path.join(dataDir, 'minutes.md'),
          greetDelayMs: 60_000,
          sttFlushMs: 0,
          reconnectMs,
        })
        const reached = session.reachedTimeLimit.bind(session)
        session.reachedTimeLimit = minutes => (timeLimits.push(minutes), reached(minutes))
        fluxes.push(flux)
        sessions.push(session)
        t.after(() => {
          session.end()
          session.transcript.delete()
        })
        return session
      },
    },
  )
  await service.listen()
  t.after(() => service.close())
  const publicPort = (service.publicServer.address() as AddressInfo).port
  const auth = { authorization: `Bearer ${localToken}` }
  const keyOf = (n: number) => new URL(bots[n].pageUrl).searchParams.get('key')!
  return { publicPort, control, auth, left, sessionLeft, timeLimits, fluxes, sessions, keyOf }
}

test('through a real meeting session: a page without the secret takes over only while no page has sent anything, and only as a later try', async t => {
  const s = await startReal(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const key = s.keyOf(0)
  const first = await page(s.publicPort, key, { n: 1 })
  const rejoin = await first.ready()
  // Its 'ready' never reached the page, which sends nothing before one, and tries again without the secret.
  assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, { n: 1 })).outcome, 409, 'not the same try')
  const second = await page(s.publicPort, key, { n: 2 })
  assert.equal(second.outcome, 'open')
  await closed(first.ws)
  assert.equal(await second.ready(), rejoin, "the session's own secret")
  // Once the page has sent anything, only the secret lets a page in.
  second.ws.send(Buffer.alloc(2560))
  await until(() => s.fluxes[0].received === 1)
  for (const more of [{ n: 3 }, { n: 3, rejoin: '', got: 0 }]) {
    assert.equal((await botPage(s.publicPort, key, PAGE_TOKEN, more)).outcome, 409, JSON.stringify(more))
  }
  assert.equal(second.ws.readyState, WebSocket.OPEN)
  const back = await page(s.publicPort, key, { n: 4, rejoin, got: 0 })
  assert.equal(back.outcome, 'open')
  await closed(second.ws)
  assert.equal(s.sessions.length, 1, 'one session for the meeting')
  assert.deepEqual(s.left, [])
})

test('through a real meeting session: the time limit reached while the goodbye plays lets it play to the end before the bot leaves', async t => {
  const s = await startReal(t, { maxMeetingMinutes: 0.005, reconnectMs: 60_000 }, 1500) // a 300 ms limit; lines of 1.5 s
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const live = await page(s.publicPort, s.keyOf(0), { n: 1 })
  await live.ready()
  const code = live.code()
  let audio = 0
  live.ws.on('message', (data, isBinary) => void (isBinary && (audio += (data as Buffer).length)))
  s.fluxes[0].said('Alex, please leave.')
  await until(() => audio === 1500 * 32)
  await until(() => s.timeLimits.length > 0)
  await wait(50)
  assert.deepEqual(s.left, [], 'not while the goodbye plays')
  assert.deepEqual(s.sessionLeft, [])
  assert.equal(live.ws.readyState, WebSocket.OPEN)
  assert.equal(await code, PAGE_CLOSE.over)
  await until(() => s.left.length > 0)
  assert.deepEqual(s.sessionLeft, ['bot-1'], 'the session left the call once the goodbye had played')
  assert.deepEqual(s.left, ['bot-1'], 'and the service made sure')
})

// --- Getting bots out of their calls -------------------------------------------------------------------------------

test("when a started meeting's page goes for good, the service asks its bot to leave until Recall says it has, and the meeting holds its place until then", async t => {
  // The network is down for the first tries: fetch fails, then Recall is unavailable, then busy.
  const failures: Error[] = [new TypeError('fetch failed'), new RecallError(503, 'Recall POST /bot/bot-1/leave_call/ failed (503)'), new RecallError(429, 'slow down')]
  const s = await start(t, { maxMeetings: 1, reconnectMs: 50, leaveBackoffMs: [30] }, {
    leaveCall: async () => {
      const failure = failures.shift()
      if (failure) throw failure
    },
  })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  await pageComesAndGoes(s, 0)
  const refused = await joinRequest(s.control, s.auth)
  assert.equal(refused.status, 400, 'its bot may still be in the call')
  assert.match(refused.body, /Already in 1 meeting, the most MAX_MEETINGS allows \(1 of them ending: its bot is leaving the call\)/)
  await until(() => s.left.length === 4)
  assert.deepEqual(s.left, ['bot-1', 'bot-1', 'bot-1', 'bot-1'], 'tried again after each failure, until it worked')
  await wait(20) // the last try's answer is taken in
  assert.equal((await joinRequest(s.control, s.auth)).status, 200, 'its place is free once the bot is out')
  await wait(100)
  assert.equal(s.left.length, 4, 'and nothing more is asked of Recall')
})

test('a 4xx from Recall (the bot is no longer in its call) ends the tries at once, and frees its place', async t => {
  const s = await start(t, { maxMeetings: 1, reconnectMs: 50, leaveBackoffMs: [20] }, {
    leaveCall: async botId => {
      throw new RecallError(400, `Recall POST /bot/${botId}/leave_call/ failed (400): {"detail":"Bot is not in a call"}`)
    },
  })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  await pageComesAndGoes(s, 0)
  await until(() => s.left.length > 0)
  await wait(150)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
})

test('the time limit still runs while the page is away: the session is told (it posts its line through Recall), then the bot leaves', async t => {
  const s = await start(t, { maxMeetingMinutes: 0.005, reconnectMs: 60_000 }) // 300 ms; a window far longer
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const from = Date.now()
  await pageComesAndGoes(s, 0)
  await until(() => s.left.length > 0, 300)
  assert.deepEqual(s.left, ['bot-1'])
  assert.ok(Date.now() - from < 2000, 'at the time limit, not at the end of the reconnect window')
  assert.deepEqual(s.started[0].timeLimits, [0.005], 'the session whose page is away was told')
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 9, rejoin: s.started[0].rejoin })).outcome, 403, 'and no page is let in for it again')
})

test('the bot leaves at the time limit even when its session, its page away, declines to and does not end', async t => {
  const s = await start(t, { maxMeetingMinutes: 0.005, reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  await pageComesAndGoes(s, 0)
  s.started[0].reachedTimeLimit = async () => {} // declines, and does not end
  await until(() => s.left.length > 0, 300)
  assert.deepEqual(s.left, ['bot-1'])
})

test('the time limit reached while Alex says goodbye leaves the bot in the call until the goodbye has played and its session has ended', async t => {
  const s = await start(t, { maxMeetingMinutes: 0.005, reconnectMs: 60_000 }) // 300 ms
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const live = await page(s.publicPort, s.keyOf(0), { n: 1 })
  await live.ready()
  s.started[0].leftMeeting = true // "Alex, please leave": the goodbye is playing
  await until(() => s.started[0].timeLimits.length > 0, 300)
  await wait(100)
  assert.deepEqual(s.left, [], 'not while the goodbye plays')
  assert.equal(live.ws.readyState, WebSocket.OPEN)
  s.started[0].end() // the goodbye has played, and the session has asked Recall itself
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'], 'then the service makes sure')
})

test('no page is let back in once the time limit is reached while it is away, even before the bot has left', async t => {
  const s = await start(t, { maxMeetingMinutes: 0.005, reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  await pageComesAndGoes(s, 0)
  const session = s.started[0]
  let posted = () => {}
  // Recall takes its time to post the line in the chat, and the bot leaves after it.
  session.reachedTimeLimit = async minutes => {
    session.timeLimits.push(minutes)
    await new Promise<void>(resolve => (posted = resolve))
    session.end()
  }
  await until(() => session.timeLimits.length > 0, 300)
  assert.equal((await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin: session.rejoin, got: 0 })).outcome, 403)
  assert.deepEqual(session.attached, [])
  posted()
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'])
})

test('after Alex was asked to leave, no page is let in for that meeting again, and the bot is asked to leave at once', async t => {
  const s = await start(t, { reconnectMs: 60_000 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const page = await botPage(s.publicPort, s.keyOf(0))
  assert.equal(page.outcome, 'open')
  await until(() => s.started.length === 1)
  s.started[0].leftMeeting = true // "Alex, please leave"
  s.started[0].end()
  await closed(page.ws)
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'], 'without waiting for the reconnect window')
  assert.equal((await botPage(s.publicPort, s.keyOf(0))).outcome, 403)
})

test("a page coming back within the reconnect window can't take Alex past MAX_MEETINGS: the meeting held its place", async t => {
  const s = await start(t, { maxMeetings: 1, reconnectMs: 300 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  await pageComesAndGoes(s, 0)
  assert.equal((await joinRequest(s.control, s.auth)).status, 400, 'a second meeting is refused while the first may come back')
  const back = await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin: s.started[0].rejoin, got: 0 })
  assert.equal(back.outcome, 'open')
  assert.equal((await joinRequest(s.control, s.auth)).status, 400)
  back.ws.close()
  await closed(back.ws)
  await until(() => s.left.length > 0)
  assert.equal((await joinRequest(s.control, s.auth)).status, 200, 'its place is free once its bot is out')
  assert.equal(s.bots.length, 2)
})

test('stop() asks every bot not yet out of its call to leave, one Recall is still creating included, and takes no more joins or pages', async t => {
  let release!: () => void
  const creating = new Promise<void>(resolve => (release = resolve))
  const s = await start(t, {}, {
    createBot: async n => {
      if (n === 3) await creating
      return { id: `bot-${n}` }
    },
  })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200) // bot-1: its page connects
  assert.equal((await joinRequest(s.control, s.auth)).status, 200) // bot-2: still joining
  const live = await botPage(s.publicPort, s.keyOf(0))
  assert.equal(live.outcome, 'open')
  const third = joinRequest(s.control, s.auth) // bot-3: Recall is still creating it
  await until(() => s.bots.length === 3)

  const stopped = s.service.stop()
  await wait(50)
  release()
  await stopped
  assert.deepEqual([...s.left].sort(), ['bot-1', 'bot-2', 'bot-3'])
  const late = await third
  assert.equal(late.status, 400)
  assert.match(late.body, /stopping/)
  const after = await joinRequest(s.control, s.auth)
  assert.equal(after.status, 400)
  assert.match(after.body, /The voice service is stopping/)
  assert.equal(s.bots.length, 3, 'no bot started once it was stopping')
  assert.equal((await botPage(s.publicPort, s.keyOf(1))).outcome, 503, 'no page let in either')
  assert.equal(fs.existsSync(path.join(s.dataDir, PENDING_BOTS_FILE)), false, 'all out, so nothing is left to ask at the next start')
})

test('bots are kept in pending-bots.json until they are out of their calls, and a service restarted after a crash asks them to leave', async t => {
  const s = await start(t)
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const file = path.join(s.dataDir, PENDING_BOTS_FILE)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const [saved, ...others] = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(others.length, 0)
  assert.equal(saved.key, s.keyOf(0))
  assert.equal(saved.botId, 'bot-1')
  assert.ok(saved.deadline > Date.now(), 'when its page wait ends')
  assert.deepEqual(Object.keys(saved).sort(), ['botId', 'deadline', 'key'], 'nothing of the meeting itself')

  // A crash: the process goes without stop(), so nothing asked the bot to leave.
  await s.service.close()
  assert.deepEqual(s.left, [])
  assert.ok(fs.existsSync(file))

  // The restarted service asks it to leave, though the network is down at first, and counts it until it is out.
  let down = true
  const again = await start(t, { dataDir: s.dataDir, maxMeetings: 1, leaveBackoffMs: [50] }, {
    leaveCall: async () => {
      if (down) throw new TypeError('fetch failed')
    },
  })
  await until(() => again.left.length > 0)
  assert.equal((await joinRequest(again.control, again.auth)).status, 400, 'it may still be in its call')
  assert.equal((await botPage(again.publicPort, s.keyOf(0))).outcome, 403, 'and its page is not let in')
  down = false
  await until(() => !fs.existsSync(file))
  assert.equal(fs.existsSync(file), false, 'cleared once it is out')
  assert.ok(again.left.length >= 2)
  assert.ok(again.left.every(id => id === 'bot-1'))
  assert.equal((await joinRequest(again.control, again.auth)).status, 200)
})

// --- Cost caps -----------------------------------------------------------------------------------------------------

test('MAX_MEETINGS caps the meetings Alex is in at once, through /api/join and join_meeting alike', async t => {
  const s = await start(t, { maxMeetings: 2, reconnectMs: 50 })
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const third = await joinRequest(s.control, s.auth)
  assert.equal(third.status, 400)
  assert.match(third.body, /Already in 2 meetings, the most MAX_MEETINGS allows/)

  const linked = await bridgeLink(s.control, s.auth)
  const acks: any[] = []
  linked.ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'ack') acks.push(msg)
  })
  linked.ws.send(JSON.stringify({ type: 'join_meeting', request_id: 'j1', meeting_url: ZOOM }))
  await until(() => acks.some(a => a.request_id === 'j1'))
  const ack = acks.find(a => a.request_id === 'j1')
  assert.equal(ack.ok, false)
  assert.match(ack.note, /MAX_MEETINGS/)
  assert.equal(s.bots.length, 2)

  // A meeting whose page has gone is over once its bot is out of the call, and its place is free.
  const page = await botPage(s.publicPort, s.keyOf(0))
  assert.equal(page.outcome, 'open')
  assert.equal((await joinRequest(s.control, s.auth)).status, 400, 'still two while it is on')
  page.ws.close()
  await closed(page.ws)
  await until(() => s.left.length > 0)
  await wait(20)
  linked.ws.send(JSON.stringify({ type: 'join_meeting', request_id: 'j2', meeting_url: ZOOM }))
  await until(() => acks.some(a => a.request_id === 'j2'))
  assert.equal(acks.find(a => a.request_id === 'j2').ok, true)
  assert.equal(s.bots.length, 3)
  linked.ws.close()
})

test('MAX_MEETINGS counts bots Recall is still creating', async t => {
  const s = await start(t, { maxMeetings: 1 })
  const both = await Promise.all([joinRequest(s.control, s.auth), joinRequest(s.control, s.auth)])
  assert.deepEqual(both.map(r => r.status).sort(), [200, 400])
  assert.equal(s.bots.length, 1)
})

test('MAX_MEETING_MINUTES ends a bot session, its bot is asked to leave, and its meeting takes no page after that', async t => {
  const s = await start(t, { maxMeetingMinutes: 0.002 }) // 120 ms
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const page = await botPage(s.publicPort, s.keyOf(0))
  assert.equal(page.outcome, 'open')
  await until(() => s.started[0]?.timeLimits.length > 0)
  assert.deepEqual(s.started[0].timeLimits, [0.002])
  await closed(page.ws)
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'], 'by the service too, without waiting for the reconnect window')
  assert.equal((await botPage(s.publicPort, s.keyOf(0))).outcome, 403)
})

test('the time limit counts from when the meeting first connected, not from a reconnect', async t => {
  const s = await start(t, { maxMeetingMinutes: 0.01 }) // 600 ms
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const first = await page(s.publicPort, s.keyOf(0), { n: 1 })
  const from = Date.now()
  const rejoin = await first.ready()
  await wait(350)
  first.ws.close()
  await closed(first.ws)
  await until(() => s.started[0].drops === 1)
  const second = await botPage(s.publicPort, s.keyOf(0), PAGE_TOKEN, { n: 2, rejoin, got: 0 })
  assert.equal(second.outcome, 'open')
  await until(() => s.started[0].timeLimits.length > 0)
  assert.equal(s.started.length, 1, 'the page came back to the same session')
  assert.deepEqual(s.started[0].timeLimits, [0.01])
  assert.ok(Date.now() - from < 900, `${Date.now() - from} ms: from the first connection (600 ms), not the second (950 ms or more)`)
})

test('caps from .env fall back to their defaults unless they are positive numbers', () => {
  const warned: string[] = []
  const warn = (m: string) => void warned.push(m)
  assert.equal(cap('MAX_MEETINGS', '', 3, { whole: true }, warn), 3)
  assert.equal(cap('MAX_MEETINGS', '5', 3, { whole: true }, warn), 5)
  assert.equal(warned.length, 0)
  for (const raw of ['0', '-1', 'three', '1.5', 'Infinity']) assert.equal(cap('MAX_MEETINGS', raw, 3, { whole: true }, warn), 3, raw)
  assert.equal(warned.length, 5)
  assert.equal(cap('MAX_MEETING_MINUTES', '90', 180, { max: 1440 }, warn), 90)
  assert.equal(cap('MAX_MEETING_MINUTES', '5000', 180, { max: 1440 }, warn), 1440)
  assert.match(warned.at(-1)!, /MAX_MEETING_MINUTES=5000 is more than 1440/)
})

// --- Stopping: on SIGTERM and on a crash ------------------------------------------------------------------------------

test('a crash stops the service as SIGTERM does (sessions ended, other bots asked to leave), then exits non-zero', async () => {
  for (const [why, code] of [['SIGTERM', 0], ['a crash (uncaught exception)', 1]] as const) {
    const done: string[] = []
    const exits: number[] = []
    const service = { sessions: new Set(['a session']), stop: async () => void done.push('service.stop') }
    const stop = stopper(service, {
      endSessions: async sessions => void done.push(`ended ${sessions.length}`),
      exit: c => void exits.push(c),
      exitDelayMs: 0,
    })
    stop(why, code)
    stop('SIGINT') // a second signal changes nothing
    await until(() => exits.length > 0)
    assert.deepEqual(done.sort(), ['ended 1', 'service.stop'], why)
    assert.deepEqual(exits, [code], why)
  }
  // A crash while stopping for SIGTERM still exits non-zero.
  const exits: number[] = []
  const stop = stopper({ sessions: new Set(), stop: async () => void (await wait(30)) }, { endSessions: async () => {}, exit: c => void exits.push(c), exitDelayMs: 0 })
  stop('SIGTERM')
  stop('a crash (unhandled rejection)', 1)
  await until(() => exits.length > 0)
  assert.deepEqual(exits, [1])
})

// --- Files ---------------------------------------------------------------------------------------------------------

test('the data folder, the brief and the local token are readable by the owner only', t => {
  const dataDir = tempDir(t, 'av-files-')
  // As an install from before: a world-readable folder and brief.
  fs.chmodSync(dataDir, 0o755)
  fs.writeFileSync(path.join(dataDir, 'brief.md'), 'Not for disclosure: the price.', { mode: 0o644 })
  fs.chmodSync(path.join(dataDir, 'brief.md'), 0o644)
  prepareDataDir(dataDir)
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(dataDir, 'brief.md')).mode & 0o777, 0o600)

  assert.throws(() => readLocalToken(dataDir), /local-token is missing: start the voice service once to create it/)
  const token = ensureLocalToken(dataDir)
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(fs.statSync(localTokenPath(dataDir)).mode & 0o777, 0o600)
  assert.equal(readLocalToken(dataDir), token)
  fs.chmodSync(localTokenPath(dataDir), 0o644)
  assert.equal(ensureLocalToken(dataDir), token, 'kept across restarts')
  assert.equal(fs.statSync(localTokenPath(dataDir)).mode & 0o777, 0o600, 'and made private again')
  fs.writeFileSync(localTokenPath(dataDir), 'short')
  assert.notEqual(ensureLocalToken(dataDir), 'short', 'a token cut short is made again')
})

// --- The join CLI -----------------------------------------------------------------------------------------------

function runJoin(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/cli/join.ts'), ZOOM], {
      env: { ...process.env, CONTROL_SOCKET: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', c => (out += c))
    child.stderr.on('data', c => (out += c))
    child.on('close', code => resolve({ code, out }))
  })
}

test('npm run join sends the local token over the control socket, and says what to do without one or without the service', { timeout: 30_000 }, async t => {
  const s = await start(t)
  const ok = await runJoin({ ALEX_DATA_DIR: s.dataDir })
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /Alex is joining \(bot bot-1\)/)
  assert.equal(s.bots.length, 1)
  // CONTROL_SOCKET names the socket when it is not in the data folder.
  const elsewhere = tempDir(t, 'av-cli-')
  fs.copyFileSync(localTokenPath(s.dataDir), localTokenPath(elsewhere))
  const named = await runJoin({ ALEX_DATA_DIR: elsewhere, CONTROL_SOCKET: s.control })
  assert.equal(named.code, 0, named.out)
  assert.equal(s.bots.length, 2)

  const empty = tempDir(t, 'av-no-token-')
  const missing = await runJoin({ ALEX_DATA_DIR: empty, CONTROL_SOCKET: s.control })
  assert.equal(missing.code, 1)
  assert.match(missing.out, /start the voice service once to create it/)

  await s.service.close()
  const down = await runJoin({ ALEX_DATA_DIR: s.dataDir })
  assert.equal(down.code, 1)
  assert.match(down.out, /The voice service is not running \(nothing is listening on .*control\.sock\)/)
  assert.equal(s.bots.length, 2)
})
