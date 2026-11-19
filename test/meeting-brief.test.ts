// A meeting's own brief (join_meeting's brief, npm run join --brief): that meeting answers from it instead of the
// shared brief (data/brief.md), no other meeting sees it, it is kept in memory only, and once the meeting is over
// get_profile gets no brief for it at all, never the shared one in its place.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MAX_BRIEF_CHARS, briefProblem, briefTooLong } from '../src/brief.ts'
import { profileText } from '../src/channel/profile-tool.ts'
import { joinArgs } from '../src/cli/join-args.ts'
import { ROOT } from '../src/config.ts'
import { identity } from '../src/identity.ts'
import { ensureLocalToken } from '../src/local-token.ts'
import { MeetingSession, type SessionOptions } from '../src/pipeline/session.ts'
import { loadProfile } from '../src/profile.ts'
import { type ServiceConfig, type ServiceSession, createServers } from '../src/server.ts'

const PAGE_TOKEN = 'p'.repeat(48)
const ZOOM = 'https://us06web.zoom.us/j/123456789?pwd=abc'
const ACME = '# Acme\nThe pilot starts in March.'
type Ctx = TestContext
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await wait(10)
}
// A Unix socket's path is short, so the folders are made in /tmp.
function tempDir(t: Ctx): string {
  const dir = fs.mkdtempSync(path.join('/tmp', 'av-mb-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Every file under a folder, with its text. */
function filesUnder(dir: string): { file: string; text: string }[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap(entry => {
    const file = path.join(entry.parentPath, entry.name)
    return entry.isFile() ? [{ file, text: fs.readFileSync(file, 'utf8') }] : []
  })
}

/** Stands in for a MeetingSession: keeps the brief reader it was started with. */
class FakeSession implements ServiceSession {
  readonly transcript = { recent: () => '' }
  readonly over: Promise<void>
  private resolveOver!: () => void
  ended = false
  leftMeeting = false
  constructor(
    readonly ws: WebSocket,
    readonly opts: SessionOptions,
    readonly brief: () => string,
  ) {
    this.over = new Promise(resolve => (this.resolveOver = resolve))
    ws.send(JSON.stringify({ type: 'ready', rejoin: 'r'.repeat(32) }))
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

/** leaveCall: what Recall does when a bot is asked to leave (by default, it leaves at once). */
async function start(t: Ctx, overrides: Partial<ServiceConfig> = {}, leaveCall: () => Promise<void> = async () => {}) {
  const dataDir = overrides.dataDir ?? tempDir(t)
  const localToken = ensureLocalToken(dataDir)
  const control = path.join(dataDir, 'control.sock')
  const started: FakeSession[] = []
  const bots: { pageUrl: string }[] = []
  const service = createServers(
    { port: 0, host: '127.0.0.1', controlSocket: control, publicUrl: 'https://assistant.example.com', agentPageToken: PAGE_TOKEN, localToken, dataDir, maxMeetings: 3, maxMeetingMinutes: 180, ...overrides },
    {
      createBot: async plan => {
        bots.push(plan)
        return { id: `bot-${bots.length}` }
      },
      leaveCall,
      startSession: (ws, opts, { brief }) => {
        const s = new FakeSession(ws, opts, brief)
        started.push(s)
        return s
      },
    },
  )
  await service.listen()
  t.after(() => service.close())
  const publicPort = (service.publicServer.address() as AddressInfo).port
  const keyOf = (n: number) => new URL(bots[n].pageUrl).searchParams.get('key')!
  return { service, control, dataDir, localToken, publicPort, started, bots, keyOf }
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
const join = (s: { control: string; localToken: string }, body: object) =>
  request(s.control, { method: 'POST', path: '/api/join', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${s.localToken}` } })

/** A link to /bridge on the control socket, as the channel makes it: what it receives, and a request that waits for its answer. */
async function bridgeLink(t: Ctx, s: { control: string; localToken: string }) {
  const ws = new WebSocket('ws://localhost/bridge', { headers: { authorization: `Bearer ${s.localToken}` }, createConnection: () => net.connect(s.control) })
  const got: any[] = []
  ws.on('message', raw => got.push(JSON.parse(raw.toString())))
  await new Promise(r => ws.once('open', r))
  t.after(() => ws.close())
  let n = 0
  const ask = async (msg: object) => {
    const request_id = `r${++n}`
    ws.send(JSON.stringify({ ...msg, request_id }))
    await until(() => got.some(m => m.request_id === request_id))
    return got.find(m => m.request_id === request_id)
  }
  const briefOf = async (meeting: unknown) => {
    const { type, request_id: _, ...rest } = await ask({ type: 'get_brief', meeting })
    assert.equal(type, 'brief')
    return rest
  }
  return { ws, got, ask, briefOf }
}

async function openPage(port: number, key: string, more: Record<string, string | number> = { n: 1 }) {
  const params = new URLSearchParams({ key, token: PAGE_TOKEN, ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, String(v)])) })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio?${params}`)
  const messages: any[] = []
  ws.on('message', (data, isBinary) => void (isBinary || messages.push(JSON.parse(data.toString()))))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`refused: ${res.statusCode}`)))
  })
  return { ws, messages }
}

// --- The parts --------------------------------------------------------------------------------------------------------

test('the join CLI takes the link and --brief <file> or --brief=<file>, in either order, and refuses what it does not know', () => {
  assert.deepEqual(joinArgs([ZOOM]), { meetingUrl: ZOOM })
  assert.deepEqual(joinArgs([ZOOM, '--brief', 'acme.md']), { meetingUrl: ZOOM, briefFile: 'acme.md' })
  assert.deepEqual(joinArgs(['--brief=acme.md', ZOOM]), { meetingUrl: ZOOM, briefFile: 'acme.md' })
  const problem = (argv: string[]) => {
    const parsed = joinArgs(argv)
    assert.ok('problem' in parsed, JSON.stringify(argv))
    return parsed.problem
  }
  assert.match(problem([ZOOM, '--brief']), /--brief needs a file after it/)
  assert.match(problem([ZOOM, '--brief=']), /--brief needs a file after it/)
  assert.match(problem(['--brief', '--other', ZOOM]), /--brief needs a file after it/)
  assert.match(problem([ZOOM, '--breif', 'x']), /Unknown option --breif/)
  assert.match(problem([ZOOM, '--brief', 'a.md', '--brief', 'b.md']), /Give --brief once/)
  assert.match(problem([]), /Give the meeting link/)
  assert.match(problem([ZOOM, ZOOM]), /Give one meeting link/)
})

test('a brief is refused, never cut, past the limit; an empty one, or one that is not text, is refused too', () => {
  assert.equal(briefProblem('# Brief'), '')
  assert.equal(briefProblem('x'.repeat(MAX_BRIEF_CHARS)), '')
  assert.match(briefProblem('x'.repeat(MAX_BRIEF_CHARS + 1)), /16001 characters, more than the 16000 a brief may have.*never cut/)
  assert.match(briefProblem('  \n'), /empty/)
  assert.match(briefProblem(42), /has to be text/)
  assert.match(briefProblem(null), /has to be text/)
  // set_brief may still clear the shared brief: only its length is checked.
  assert.equal(briefTooLong(''), '')
  assert.match(briefTooLong('x'.repeat(MAX_BRIEF_CHARS + 1)), /never cut/)
})

test("get_profile gives a meeting's own brief, the shared one, or none, and never the shared one in place of a meeting's", t => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'brief.md'), '# Shared')
  const view = (given: Parameters<typeof profileText>[2]) => JSON.parse(profileText(identity, loadProfile(), given))
  const own = view({ for: 'this_meeting', text: ACME })
  assert.deepEqual([own.brief, own.brief_for, own.brief_file], [ACME, 'this_meeting', null])
  const shared = view({ for: 'shared', file: path.join(dir, 'brief.md') })
  assert.deepEqual([shared.brief, shared.brief_for, shared.brief_file], ['# Shared', 'shared', path.join(dir, 'brief.md')])
  assert.doesNotMatch(shared.note, /could not be had/)
  const none = view({ for: 'unavailable', why: 'Alex is not in a meeting with that key now, or it is over' })
  assert.deepEqual([none.brief, none.brief_for, none.brief_file], [null, 'unavailable', null])
  assert.match(none.note, /could not be had \(Alex is not in a meeting with that key now, or it is over\)\. Use no other brief in its place, the shared one included/)
  assert.match(none.note, /answer only from about, say anything else is one for Sam to follow up on/)
})

test('get_profile refuses a shared brief edited by hand past the limit, never cutting it, and says why and what to do instead', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'brief.md')
  fs.writeFileSync(file, `# Shared\n${'x'.repeat(MAX_BRIEF_CHARS)}\nNever share the price.`)
  const view = JSON.parse(profileText(identity, loadProfile(), { for: 'shared', file }))
  assert.deepEqual([view.brief, view.brief_for, view.brief_file], [null, 'shared', file], 'none of it, not the start of it')
  assert.match(view.brief_error, /The brief is 16032 characters, more than the 16000 a brief may have: shorten it \(it is never cut/)
  assert.match(view.note, /the shared brief is refused \(brief_error\).*Use no other brief in its place.*answer only from about.*tell Sam to shorten it/)
  // At the limit it is the brief, with no error.
  fs.writeFileSync(file, 'x'.repeat(MAX_BRIEF_CHARS))
  const fits = JSON.parse(profileText(identity, loadProfile(), { for: 'shared', file }))
  assert.equal(fits.brief.length, MAX_BRIEF_CHARS)
  assert.equal(fits.brief_error, undefined)
  assert.doesNotMatch(fits.note, /refused/)
})

// --- Through the service --------------------------------------------------------------------------------------------

test('a meeting joined with its own brief answers from it whatever the shared brief says, keeps it in memory only, and once over has no brief at all', async t => {
  const logged: string[] = []
  t.mock.method(console, 'log', (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  const s = await start(t)
  fs.writeFileSync(path.join(s.dataDir, 'brief.md'), '# Shared\nBob at Initech.')
  const own = await join(s, { meetingUrl: ZOOM, brief: ACME })
  assert.equal(own.status, 200, own.body)
  assert.equal(JSON.parse(own.body).brief, 'meeting')
  assert.match(JSON.parse(own.body).brief_note, /given for this meeting, and no other meeting sees it/)
  const shared = await join(s, { meetingUrl: ZOOM })
  assert.equal(JSON.parse(shared.body).brief, 'shared')
  assert.match(JSON.parse(shared.body).brief_note, /shared brief \(.*brief\.md\), read again at every answer/)

  // Nothing of it on disk: not in a file of its own, nor in the list of bots to get out after a crash.
  for (const { file, text } of filesUnder(s.dataDir)) assert.ok(!text.includes('The pilot starts in March'), file)
  assert.equal(fs.existsSync(path.join(s.dataDir, 'briefs')), false)

  await openPage(s.publicPort, s.keyOf(0))
  await openPage(s.publicPort, s.keyOf(1))
  await until(() => s.started.length === 2)
  const [acme, other] = s.started
  // set_brief for the next meeting changes the shared brief: not the brief of a meeting with its own.
  fs.writeFileSync(path.join(s.dataDir, 'brief.md'), '# Shared\nGlobex, next week.')
  assert.equal(acme.brief(), ACME)
  assert.equal(other.brief(), '# Shared\nGlobex, next week.')

  // get_profile for it, while it is on and once it is over: then no brief, not the shared one in its place.
  const link = await bridgeLink(t, s)
  assert.deepEqual(await link.briefOf(s.keyOf(0)), { brief_for: 'this_meeting', text: ACME })
  assert.deepEqual(await link.briefOf(s.keyOf(1)), { brief_for: 'shared' })
  acme.end()
  await until(() => !s.service.sessions.has(acme))
  assert.deepEqual(await link.briefOf(s.keyOf(0)), { brief_for: 'unknown_meeting' })
  assert.equal(acme.brief(), ACME, 'the session keeps its copy, for its minutes')
  t.mock.restoreAll()

  assert.ok(logged.some(line => /^\[join\] bot bot-1 is joining a Zoom meeting, with a brief of its own$/.test(line)), logged.join('\n'))
  assert.ok(logged.some(line => /^\[join\] bot bot-2 is joining a Zoom meeting$/.test(line)))
  for (const line of logged) assert.ok(!line.includes('pilot') && !line.includes('Acme'), line)
})

test('a shared brief edited by hand past the limit is refused, never cut: meetings answer as with none, the join says why, and the log has its length only', async t => {
  const logged: string[] = []
  for (const level of ['log', 'warn', 'error'] as const) t.mock.method(console, level, (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  const s = await start(t)
  const file = path.join(s.dataDir, 'brief.md')
  const long = `# Shared\n${'x'.repeat(MAX_BRIEF_CHARS)}\nNever share the price.`
  fs.writeFileSync(file, long)
  const joined = await join(s, { meetingUrl: ZOOM })
  assert.equal(joined.status, 200, joined.body)
  assert.equal(JSON.parse(joined.body).brief, 'none')
  assert.match(
    JSON.parse(joined.body).brief_note,
    /^There is no brief: the shared brief \(.*brief\.md\) is refused\. The brief is 16032 characters, more than the 16000 a brief may have: shorten it \(it is never cut.*\)\. Until then, it answers from Sam's profile alone/,
  )
  await openPage(s.publicPort, s.keyOf(0))
  await until(() => s.started.length === 1)
  const [session] = s.started
  // Its answers and its minutes read this: none of the brief, not the start of it.
  assert.equal(session.brief(), '')
  assert.equal(session.brief(), '')
  // Shortened, it is the brief again from the next answer.
  fs.writeFileSync(file, '# Shared\nShort.')
  assert.equal(session.brief(), '# Shared\nShort.')
  fs.writeFileSync(file, `${long}!`)
  assert.equal(session.brief(), '')
  t.mock.restoreAll()
  const refused = logged.filter(line => line.startsWith('[brief]'))
  assert.equal(refused.length, 2, `once for each length it had, not at every answer:\n${refused.join('\n')}`)
  assert.match(refused[0], /^\[brief\] the shared brief \(brief\.md\) is refused, so meetings without a brief of their own answer as with none\. The brief is 16032 characters/)
  assert.match(refused[1], /The brief is 16033 characters/)
  for (const line of logged) assert.ok(!line.includes('price') && !line.includes('xxxx'), line)
  for (const line of refused) assert.ok(!line.includes(s.dataDir), line)
})

test('a join with a brief that is too long, empty or not text starts no bot, by /api/join or the bridge; the longest brief fits in a request', async t => {
  const s = await start(t)
  const long = await join(s, { meetingUrl: ZOOM, brief: 'x'.repeat(MAX_BRIEF_CHARS + 1) })
  assert.equal(long.status, 400)
  assert.match(long.body, /never cut/)
  assert.equal((await join(s, { meetingUrl: ZOOM, brief: ' ' })).status, 400)
  const notText = await join(s, { meetingUrl: ZOOM, brief: { text: ACME } })
  assert.equal(notText.status, 400)
  assert.match(notText.body, /has to be text/)
  const link = await bridgeLink(t, s)
  for (const brief of [42, '', 'x'.repeat(MAX_BRIEF_CHARS + 1)]) {
    const ack = await link.ask({ type: 'join_meeting', meeting_url: ZOOM, brief })
    assert.equal(ack.ok, false, JSON.stringify(brief).slice(0, 20))
  }
  assert.equal(s.bots.length, 0, 'never joined with the shared brief instead')
  // null is JSON's way to leave it out: the shared brief (empty here, so none).
  const none = await join(s, { meetingUrl: ZOOM, brief: null })
  assert.equal(none.status, 200)
  assert.equal(JSON.parse(none.body).brief, 'none')
  // The longest brief fits in a request, whatever JSON makes of its characters, and in a bridge message.
  const most = await join(s, { meetingUrl: ZOOM, brief: '\u0001'.repeat(MAX_BRIEF_CHARS) })
  assert.equal(most.status, 200, most.body)
  const bridged = await link.ask({ type: 'join_meeting', meeting_url: ZOOM, brief: '\u0001'.repeat(MAX_BRIEF_CHARS) })
  assert.equal(bridged.ok, true, bridged.note)
  assert.match(bridged.note, /given for this meeting, and no other meeting sees it/)
  assert.deepEqual(await link.briefOf(bridged.meeting), { brief_for: 'this_meeting', text: '\u0001'.repeat(MAX_BRIEF_CHARS) })
})

test('get_brief answers unknown_meeting for a key that is made up or not a key, and for a meeting being left, while its bot is still in the call', async t => {
  // Recall can't be reached: the bots stay in their calls, and their meetings with them, while they are asked to leave.
  const s = await start(t, { pageWaitMs: 150, stopWaitMs: 50 }, () => Promise.reject(new TypeError('fetch failed')))
  assert.equal((await join(s, { meetingUrl: ZOOM, brief: ACME })).status, 200)
  const link = await bridgeLink(t, s)
  assert.deepEqual(await link.briefOf(s.keyOf(0)), { brief_for: 'this_meeting', text: ACME })
  for (const key of ['made-up', '../brief', '', 'x'.repeat(101), 42, undefined]) {
    assert.deepEqual(await link.briefOf(key), { brief_for: 'unknown_meeting' }, String(key))
  }
  // Its page never connects: its bot is asked to leave, and its brief goes then.
  await wait(300)
  assert.equal(JSON.parse((await request(s.control, { path: '/health' })).body).bot_meetings, 1, 'still being left')
  assert.deepEqual(await link.briefOf(s.keyOf(0)), { brief_for: 'unknown_meeting' })

  // The service stops: a meeting's session that ends meanwhile has no brief either, though its bot is not out yet.
  assert.equal((await join(s, { meetingUrl: ZOOM, brief: ACME })).status, 200)
  await openPage(s.publicPort, s.keyOf(1))
  await until(() => s.started.length === 1)
  void s.service.stop()
  assert.deepEqual(await link.briefOf(s.keyOf(1)), { brief_for: 'this_meeting', text: ACME }, 'on until its session ends')
  s.started[0].end()
  await until(() => !s.service.sessions.has(s.started[0]))
  assert.deepEqual(await link.briefOf(s.keyOf(1)), { brief_for: 'unknown_meeting' })
})

test('the control /health lists what the service can do, and every bridge link hears it first', async t => {
  const s = await start(t)
  assert.deepEqual(JSON.parse((await request(s.control, { path: '/health' })).body).features, ['meeting_brief', 'why_not_answered', 'share_test'])
  for (let i = 0; i < 2; i++) {
    const link = await bridgeLink(t, s)
    await until(() => link.got.length > 0)
    assert.deepEqual(link.got[0], { type: 'service', features: ['meeting_brief', 'why_not_answered', 'share_test'] })
  }
})

test('set_brief past the limit, or one that cannot be written, is refused with why, and the service stays up', async t => {
  const s = await start(t)
  const rejections: unknown[] = []
  const onRejection = (r: unknown) => void rejections.push(r)
  process.on('unhandledRejection', onRejection)
  t.after(() => process.off('unhandledRejection', onRejection))
  const link = await bridgeLink(t, s)
  const ok = await link.ask({ type: 'set_brief', markdown: '# Shared' })
  assert.equal(ok.ok, true)
  assert.equal(fs.statSync(path.join(s.dataDir, 'brief.md')).mode & 0o777, 0o600)
  const long = await link.ask({ type: 'set_brief', markdown: 'x'.repeat(MAX_BRIEF_CHARS + 1) })
  assert.equal(long.ok, false)
  assert.match(long.note, /more than the 16000/)
  assert.equal(fs.readFileSync(path.join(s.dataDir, 'brief.md'), 'utf8'), '# Shared', 'the brief it had stays')
  // As a full disk or a wrong permission would, the write fails.
  fs.rmSync(path.join(s.dataDir, 'brief.md'))
  fs.mkdirSync(path.join(s.dataDir, 'brief.md'))
  const unwritable = await link.ask({ type: 'set_brief', markdown: '# B' })
  assert.equal(unwritable.ok, false)
  assert.match(unwritable.note, /EISDIR/)
  await wait(50)
  assert.deepEqual(rejections, [])
  assert.equal((await request(s.control, { path: '/health' })).status, 200)
  assert.equal(link.ws.readyState, WebSocket.OPEN)
})

// --- Through a real meeting session -------------------------------------------------------------------------------

/** Speech recognition for a real meeting session: it hears what the test says the meeting said. */
class FakeFlux extends EventEmitter {
  closed = false
  send() {}
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  said(text: string) {
    this.emit('turn', { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: text })
  }
}

test('a real meeting session answers and writes its minutes from its own brief, across a page drop, whatever set_brief does meanwhile', async t => {
  const dataDir = tempDir(t)
  const localToken = ensureLocalToken(dataDir)
  const control = path.join(dataDir, 'control.sock')
  const bots: { pageUrl: string }[] = []
  const answeredFrom: string[] = []
  const minutesFrom: string[] = []
  const sessions: MeetingSession[] = []
  const flux = new FakeFlux()
  const service = createServers(
    { port: 0, host: '127.0.0.1', controlSocket: control, publicUrl: 'https://assistant.example.com', agentPageToken: PAGE_TOKEN, localToken, dataDir, maxMeetings: 3, maxMeetingMinutes: 180, reconnectMs: 60_000 },
    {
      createBot: async plan => (bots.push(plan), { id: `bot-${bots.length}` }),
      leaveCall: async () => {},
      startSession: (ws, opts, { bridge, brief, reconnectMs }) => {
        const session = new MeetingSession(ws, opts, {
          brain: {
            async *respond(input: { brief: string }) {
              answeredFrom.push(input.brief)
            },
          } as any,
          bridge,
          brief,
          flux: () => flux as any,
          speak: async function* () {
            yield Buffer.alloc(3200)
          },
          recall: {
            sendChat: async () => {},
            leaveCall: async () => {},
            deleteMedia: async () => true,
            howBotEnded: async () => ({ kind: 'ended', sub_code: 'call_ended_by_host' }) as const,
            botLeftCall: (_id: string, { signal }: { signal?: AbortSignal } = {}) =>
              new Promise<null>(resolve => signal?.addEventListener('abort', () => resolve(null))),
          },
          writeMinutes: async input => (minutesFrom.push(input.brief), path.join(dataDir, 'minutes.md')),
          greetDelayMs: 60_000,
          sttFlushMs: 0,
          reconnectMs,
        })
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
  const s = { control, localToken }
  fs.writeFileSync(path.join(dataDir, 'brief.md'), '# Shared\nBob at Initech.')
  assert.equal((await join(s, { meetingUrl: ZOOM, brief: ACME })).status, 200)
  const key = new URL(bots[0].pageUrl).searchParams.get('key')!

  const first = await openPage(publicPort, key, { n: 1 })
  await until(() => first.messages.some(m => m.type === 'ready'))
  const rejoin = first.messages.find(m => m.type === 'ready').rejoin
  flux.said(`${identity.name}, when does the pilot start?`)
  await until(() => answeredFrom.length === 1)
  assert.deepEqual(answeredFrom, [ACME])

  // set_brief prepares the next meeting, while this one's page drops and comes back.
  const link = await bridgeLink(t, s)
  assert.equal((await link.ask({ type: 'set_brief', markdown: '# Shared\nGlobex, next week.' })).ok, true)
  first.ws.close()
  await new Promise(r => first.ws.once('close', r))
  await wait(50)
  const back = await openPage(publicPort, key, { n: 2, rejoin, got: 0 })
  assert.equal(back.ws.readyState, WebSocket.OPEN)
  assert.equal(sessions.length, 1, 'the same session')
  flux.said(`${identity.name}, and when does it end?`)
  await until(() => answeredFrom.length === 2)
  assert.deepEqual(answeredFrom, [ACME, ACME])

  sessions[0].end()
  await until(() => minutesFrom.length === 1)
  assert.deepEqual(minutesFrom, [ACME], 'the minutes are written with its own brief too')
})

// --- npm run join and the channel ---------------------------------------------------------------------------------

/** The join CLI, against a data folder's control socket: its exit code and what it printed. */
function runJoin(dataDir: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/cli/join.ts'), ...args], {
      env: { ...process.env, CONTROL_SOCKET: '', ALEX_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', c => (out += c))
    child.stderr.on('data', c => (out += c))
    child.on('close', code => resolve({ code, out }))
  })
}

test("npm run join --brief sends the file as the meeting's brief, and refuses an older service that would ignore it", { timeout: 30_000 }, async t => {
  const s = await start(t)
  const briefFile = path.join(s.dataDir, 'acme.md')
  fs.writeFileSync(briefFile, ACME)
  const ok = await runJoin(s.dataDir, [ZOOM, '--brief', briefFile])
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /Alex is joining \(bot bot-1\)\.\nIt answers from the brief given for this meeting, and no other meeting sees it\./)
  assert.deepEqual(await (await bridgeLink(t, s)).briefOf(s.keyOf(0)), { brief_for: 'this_meeting', text: ACME })
  const missing = await runJoin(s.dataDir, [ZOOM, '--brief', path.join(s.dataDir, 'nope.md')])
  assert.equal(missing.code, 1)
  assert.match(missing.out, /Could not read the brief .*nope\.md: ENOENT/)
  fs.writeFileSync(briefFile, 'x'.repeat(MAX_BRIEF_CHARS + 1))
  const long = await runJoin(s.dataDir, [ZOOM, `--brief=${briefFile}`])
  assert.equal(long.code, 1)
  assert.match(long.out, /never cut/)
  const unknown = await runJoin(s.dataDir, [ZOOM, '--speaker'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.out, /Unknown option --speaker\.\nUsage: npm run join -- /)
  assert.equal(s.bots.length, 1)

  // An older service: its /health lists no features, and it would take the join and ignore the brief.
  const old = tempDir(t)
  fs.copyFileSync(path.join(s.dataDir, 'local-token'), path.join(old, 'local-token'))
  const asked: string[] = []
  const oldService = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`)
    res.end(req.url === '/health' ? JSON.stringify({ ok: true }) : JSON.stringify({ bot_id: 'b', tip: '' }))
  })
  await new Promise<void>(r => oldService.listen(path.join(old, 'control.sock'), r))
  t.after(() => oldService.close())
  fs.writeFileSync(briefFile, ACME)
  const refused = await runJoin(old, [ZOOM, '--brief', briefFile])
  assert.equal(refused.code, 1, refused.out)
  assert.match(refused.out, /older than this command and cannot keep a brief for one meeting/)
  assert.deepEqual(asked, ['GET /health'], 'no bot asked for')
  // Without --brief it does not ask: an older service joins as it always did.
  assert.equal((await runJoin(old, [ZOOM])).code, 0)
  assert.deepEqual(asked, ['GET /health', 'POST /api/join'])
})

/**
 * A stand-in for the voice service's /bridge for the real channel: says it can do `features` (after `delayMs`), or, with
 * null, says nothing, as a service older than features does. It answers join_meeting, and get_brief from `briefs`.
 */
async function fakeService(t: Ctx, dir: string, features: string[] | null, opts: { delayMs?: number; briefs?: Record<string, object> } = {}) {
  const token = ensureLocalToken(dir)
  const server = http.createServer()
  const wss = new WebSocketServer({ server, verifyClient: (info: { req: http.IncomingMessage }) => info.req.headers.authorization === `Bearer ${token}` })
  const socketPath = path.join(dir, `s-${Math.random().toString(36).slice(2, 8)}.sock`)
  await new Promise<void>(r => server.listen(socketPath, r))
  t.after(() => {
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    return new Promise(r => server.close(r))
  })
  const got: any[] = []
  wss.on('connection', ws => {
    if (features) setTimeout(() => ws.send(JSON.stringify({ type: 'service', features })), opts.delayMs ?? 0)
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      got.push(msg)
      if (msg.type === 'join_meeting') ws.send(JSON.stringify({ type: 'ack', request_id: msg.request_id, ok: true, note: 'Joining.', meeting: 'k1' }))
      if (msg.type === 'get_brief') {
        ws.send(JSON.stringify({ type: 'brief', request_id: msg.request_id, ...(opts.briefs?.[msg.meeting] ?? { brief_for: 'unknown_meeting' }) }))
      }
    })
  })
  return { socketPath, got, wss }
}

/** The real channel server as a subprocess, on a data folder and a socket of the test's. */
async function startChannel(t: Ctx, dir: string, socketPath: string) {
  const client = new Client({ name: 'test', version: '0' })
  t.after(() => client.close())
  await client.connect(
    new StdioClientTransport({
      command: path.join(ROOT, 'node_modules/.bin/tsx'),
      args: [path.join(ROOT, 'src/channel/server.ts')],
      env: { ...process.env, CONTROL_SOCKET: socketPath, ALEX_DATA_DIR: dir } as Record<string, string>,
    }),
  )
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] }
    return r.content[0].text
  }
}

test('join_meeting passes a brief only to a voice service that says it keeps one, waiting for it to say so, and refuses it otherwise', { timeout: 30_000 }, async t => {
  const dir = tempDir(t)
  // It says so only 300 ms after the link opens: a join_meeting made meanwhile waits, and goes.
  const late = await fakeService(t, dir, ['meeting_brief'], { delayMs: 300 })
  const callLate = await startChannel(t, dir, late.socketPath)
  await until(() => late.got.some(m => m.type === 'hello'), 1000)
  assert.match(await callLate('join_meeting', { meeting_url: ZOOM, brief: ACME }), /Joining\. Meeting key: k1/)
  assert.equal(late.got.find(m => m.type === 'join_meeting').brief, ACME)
  // A brief that isn't text, or is empty, is refused here, never dropped for the shared one.
  assert.match(await callLate('join_meeting', { meeting_url: ZOOM, brief: { text: ACME } }), /could not join: The brief has to be text/)
  assert.match(await callLate('join_meeting', { meeting_url: ZOOM, brief: '' }), /could not join: The brief is empty/)
  assert.equal(late.got.filter(m => m.type === 'join_meeting').length, 1)

  // A service older than features never says: refused, and nothing is sent; without a brief it joins as before.
  const old = await fakeService(t, dir, null)
  const callOld = await startChannel(t, dir, old.socketPath)
  await until(() => old.got.some(m => m.type === 'hello'), 1000)
  assert.match(await callOld('join_meeting', { meeting_url: ZOOM, brief: ACME }), /older than this channel and can't keep a brief for one meeting: restart the voice service/)
  assert.equal(old.got.some(m => m.type === 'join_meeting'), false)
  assert.match(await callOld('join_meeting', { meeting_url: ZOOM }), /Joining\. Meeting key: k1/)
  assert.equal(old.got.find(m => m.type === 'join_meeting').brief, undefined)
})

test("get_profile with a meeting key asks the voice service for that meeting's brief, and fails closed", { timeout: 30_000 }, async t => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'brief.md'), '# Shared')
  const briefs = { 'k-own': { brief_for: 'this_meeting', text: ACME }, 'k-shared': { brief_for: 'shared' } }
  const service = await fakeService(t, dir, ['meeting_brief'], { briefs })
  const call = await startChannel(t, dir, service.socketPath)
  await until(() => service.got.some(m => m.type === 'hello'), 1000)
  const profile = async (args: Record<string, unknown>) => JSON.parse(await call('get_profile', args))
  const view = (p: any) => [p.brief, p.brief_for, p.brief_file]
  assert.deepEqual(view(await profile({})), ['# Shared', 'shared', path.join(dir, 'brief.md')])
  assert.deepEqual(view(await profile({ meeting: 'k-own' })), [ACME, 'this_meeting', null])
  assert.deepEqual(view(await profile({ meeting: 'k-shared' })), ['# Shared', 'shared', path.join(dir, 'brief.md')])
  const gone = await profile({ meeting: 'k-gone' })
  assert.deepEqual(view(gone), [null, 'unavailable', null])
  assert.match(gone.note, /not in a meeting with that key now, or it is over\)\. Use no other brief in its place/)
  assert.deepEqual(
    service.got.filter(m => m.type === 'get_brief').map(m => m.meeting),
    ['k-own', 'k-shared', 'k-gone'],
  )
  assert.equal(service.got.some(m => m.type === 'claim'), false, 'reading the profile takes no questions')
  // A tool that claims the questions says so only when the link comes back (the voice service restarted): drop it.
  const hellos = service.got.filter(m => m.type === 'hello').length
  for (const ws of service.wss.clients) ws.terminate()
  await until(() => service.got.filter(m => m.type === 'hello').length > hellos, 500)
  assert.ok(service.got.filter(m => m.type === 'hello').length > hellos, 'linked again')
  await wait(300)
  assert.equal(service.got.some(m => m.type === 'claim'), false, 'reading the profile takes no questions, even after a relink')

  // An older service, which never says what it can do, would not answer: no brief, and it is not asked.
  const old = await fakeService(t, dir, null)
  const callOld = await startChannel(t, dir, old.socketPath)
  await until(() => old.got.some(m => m.type === 'hello'), 1000)
  const older = JSON.parse(await callOld('get_profile', { meeting: 'k-own' }))
  assert.deepEqual(view(older), [null, 'unavailable', null])
  assert.match(older.note, /older than this channel/)
  assert.equal(old.got.some(m => m.type === 'get_brief'), false)

  // No voice service at all: no brief for a meeting, and the shared one without a key, as before.
  const callNone = await startChannel(t, dir, path.join(dir, 'nothing-listens.sock'))
  assert.deepEqual(view(JSON.parse(await callNone('get_profile', { meeting: 'k-own' }))), [null, 'unavailable', null])
  assert.deepEqual(view(JSON.parse(await callNone('get_profile', {}))), ['# Shared', 'shared', path.join(dir, 'brief.md')])
})
