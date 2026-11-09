// The service's listeners, as a stranger on the internet, a web page in a browser on this computer, or
// another program here would meet them. Recall and the meeting sessions are fakes; the listeners are real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { ROOT, cap, retiredSettings } from '../src/config.ts'
import { ensureLocalToken, localTokenPath, prepareDataDir, readLocalToken } from '../src/local-token.ts'
import { PAGE_ERRORS, type SessionOptions } from '../src/pipeline/session.ts'
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

/** Stands in for a MeetingSession: says what it was started with, and when its time ran out. */
class FakeSession implements ServiceSession {
  readonly transcript = { recent: () => '' }
  readonly timeLimits: number[] = []
  readonly startedAt = Date.now()
  ended = false
  leftMeeting = false
  constructor(
    readonly ws: WebSocket,
    readonly opts: SessionOptions,
  ) {}
  get botId() {
    return this.opts.botId
  }
  addToBrief() {
    return { ok: true }
  }
  async postChat() {
    return true
  }
  end() {
    this.ended = true
    this.ws.close()
  }
  async reachedTimeLimit(minutes: number) {
    this.timeLimits.push(minutes)
    this.end()
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
      startSession: (ws, opts) => {
        if (fakes.startSessionFails) throw fakes.startSessionFails
        const session = new FakeSession(ws, opts)
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

const botAudio = (port: number, key: string, token = PAGE_TOKEN) =>
  `ws://127.0.0.1:${port}/audio?${new URLSearchParams({ key, token })}`

/** Opens the bot page's audio for a meeting, as Recall's browser does through the tunnel. */
async function botPage(port: number, key: string, token = PAGE_TOKEN) {
  return upgrade(botAudio(port, key, token))
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise(resolve => (ws.readyState === WebSocket.CLOSED ? resolve() : ws.once('close', () => resolve())))
}

/** The bot page's audio for the nth meeting started, open, then closed again (its page went). */
async function pageComesAndGoes(s: Awaited<ReturnType<typeof start>>, n: number) {
  const page = await botPage(s.publicPort, s.keyOf(n))
  assert.equal(page.outcome, 'open')
  page.ws.close()
  await closed(page.ws)
  await until(() => s.service.sessions.size === 0)
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
  assert.deepEqual(Object.keys(JSON.parse(ok.body)).sort(), ['bot_id', 'platform', 'tip'])
  assert.equal(s.bots.length, 1)
  assert.match(s.bots[0].pageUrl, /^https:\/\/assistant\.example\.com\/agent\?key=[0-9a-f-]{36}&token=p{48}$/)

  assert.equal((await joinRequest(s.control, s.auth, '{not json')).status, 400)
  assert.equal((await joinRequest(s.control, s.auth, JSON.stringify({ meetingUrl: 'https://evil.example/j/1' }))).status, 400)
  assert.equal((await joinRequest(s.control, s.auth, JSON.stringify({ meetingUrl: 'x'.repeat(20_000) }))).status, 413)
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
  await new Promise(resolve => ws.on('close', resolve))
  t.mock.restoreAll()
  assert.deepEqual(messages, [{ type: 'error', message: PAGE_ERRORS.start }])
  assert.ok(errors.some(line => line.includes(failure.message)), 'the error itself is in the log')
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
  assert.deepEqual(control, { ok: true, session_linked: false, meetings: 0, bot_meetings: 0, max_meetings: 3 })
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

  const page = await botPage(s.publicPort, key)
  assert.equal(page.outcome, 'open')
  await until(() => s.started.length === 1)
  assert.deepEqual(s.started[0].opts, { meetingKey: key, botId: 'bot-1', platform: 'Zoom' })
  assert.equal((await botPage(s.publicPort, key)).outcome, 409, 'a second page for the same meeting at the same time')

  // A page that reconnects for the meeting is let in.
  page.ws.close()
  await closed(page.ws)
  await until(() => s.service.sessions.size === 0)
  const again = await botPage(s.publicPort, key)
  assert.equal(again.outcome, 'open')
  again.ws.close()
  await closed(again.ws)
  // Once the meeting is over (its page gone for longer than a reconnect takes), its bot is asked to leave and its key opens nothing.
  await until(() => s.left.length > 0)
  assert.deepEqual(s.left, ['bot-1'])
  assert.equal((await botPage(s.publicPort, key)).outcome, 403)
  assert.equal(s.started.length, 2)
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

test('the time limit still runs while the page is away: then the bot is asked to leave, and nothing is posted', async t => {
  const s = await start(t, { maxMeetingMinutes: 0.005, reconnectMs: 60_000 }) // 300 ms; a window far longer
  assert.equal((await joinRequest(s.control, s.auth)).status, 200)
  const from = Date.now()
  await pageComesAndGoes(s, 0)
  await until(() => s.left.length > 0, 300)
  assert.deepEqual(s.left, ['bot-1'])
  assert.ok(Date.now() - from < 2000, 'at the time limit, not at the end of the reconnect window')
  assert.deepEqual(s.started[0].timeLimits, [], 'no session was told: it had ended, and it posts nothing more')
  assert.equal((await botPage(s.publicPort, s.keyOf(0))).outcome, 403, 'and no page is let in for it again')
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
  const back = await botPage(s.publicPort, s.keyOf(0))
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
  linked.ws.on('message', raw => acks.push(JSON.parse(raw.toString())))
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
  const first = await botPage(s.publicPort, s.keyOf(0))
  const from = Date.now()
  await wait(350)
  first.ws.close()
  await closed(first.ws)
  await until(() => s.service.sessions.size === 0)
  const second = await botPage(s.publicPort, s.keyOf(0))
  assert.equal(second.outcome, 'open')
  await until(() => s.started[1]?.timeLimits.length > 0)
  assert.equal(s.started[0].timeLimits.length, 0)
  assert.deepEqual(s.started[1].timeLimits, [0.01])
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
