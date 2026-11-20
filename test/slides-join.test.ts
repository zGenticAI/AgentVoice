// Joining a meeting with slides, through the service, the bridge, npm run join's own checks and npm run slides' status
// and control: SLIDES_PLATFORMS refuses a platform before any bot is created, the script is taken only without comments
// and checked against its deck, only the slides it shows are read, the answer says what to check on the platform, the
// meeting's session gets its slides, and the owner's controls reach the one meeting with slides. Recall and the meeting
// sessions are fakes; the listeners and the deck on disk are real.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'
import { SessionBridge, type ToSession } from '../src/bridge.ts'
import { joinArgs } from '../src/cli/join-args.ts'
import { slidesArgs } from '../src/cli/slides-args.ts'
import { presentationLines, statusLine } from '../src/cli/slides-status.ts'
import { ensureLocalToken } from '../src/local-token.ts'
import type { SessionOptions, SessionSlides } from '../src/pipeline/session.ts'
import type { BotPlan } from '../src/recall.ts'
import { type ServiceConfig, type ServiceSession, createServers } from '../src/server.ts'
import { type LiveSession, slidesHandlers } from '../src/sessions.ts'
import { decksDir } from '../src/slides/deck.ts'
import { SlidesRefused, joinScript, meetingDeck } from '../src/slides/join.ts'
import { shareSetting, slidesNote, slidesPlatformProblem } from '../src/slides/platforms.ts'
import type { OwnerAction, PresenterStatus } from '../src/slides/presenter.ts'
import { canonicalText, parseScript } from '../src/slides/script.ts'
import { DECK_ID, SCRIPT, writeDeck } from './fixtures/slides/deck-on-disk.ts'

const PAGE_TOKEN = 'p'.repeat(48)
const ZOOM = 'https://us06web.zoom.us/j/123456789?pwd=abc'
const MEET = 'https://meet.google.com/abc-defg-hij'
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await wait(10)
}
// A Unix socket's path is short, so the folders are made in /tmp.
function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join('/tmp', 'av-sj-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The script as npm run join and the channel send it: its canonical text, with no comment. */
const CANONICAL = canonicalText(parseScript(SCRIPT).script!)

const STATUS: PresenterStatus = { state: 'ready', slide: null, bookmark: 1, of: 4, title: null, held: null, detour: false, share: 'off' }

/** Stands in for a MeetingSession: keeps the slides it was started with, and a presenter the owner's controls reach. */
class FakeSession implements ServiceSession {
  readonly transcript = { recent: () => '' }
  readonly over: Promise<void>
  private resolveOver!: () => void
  ended = false
  leftMeeting = false
  readonly actions: { action: OwnerAction; slide?: number }[] = []
  readonly presenter: ServiceSession['presenter']
  constructor(
    readonly ws: WebSocket,
    readonly opts: SessionOptions,
    readonly slides: SessionSlides | undefined,
  ) {
    this.over = new Promise(resolve => (this.resolveOver = resolve))
    ws.send(JSON.stringify({ type: 'ready', rejoin: 'r'.repeat(32) }))
    this.presenter = slides
      ? {
          owner: (action, slide) => {
            this.actions.push({ action, ...(slide === undefined ? {} : { slide }) })
            return { ok: true, note: `did ${action}` }
          },
          status: () => STATUS,
        }
      : null
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

async function start(t: TestContext, overrides: Partial<ServiceConfig> = {}) {
  const dataDir = tempDir(t)
  const localToken = ensureLocalToken(dataDir)
  const control = path.join(dataDir, 'control.sock')
  const plans: BotPlan[] = []
  const started: FakeSession[] = []
  const recall: string[] = []
  writeDeck(decksDir(dataDir))
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
      slidesPlatforms: ['zoom'],
      ...overrides,
    },
    {
      createBot: async plan => {
        plans.push(plan)
        return { id: `bot-${plans.length}` }
      },
      leaveCall: async () => {},
      startSession: (ws, opts, ctx) => {
        const session = new FakeSession(ws, opts, ctx.slides)
        started.push(session)
        return session
      },
      screenshare: {
        start: async botId => {
          recall.push(`start ${botId}`)
          return 200
        },
        stop: async botId => {
          recall.push(`stop ${botId}`)
          return 204
        },
      },
    },
  )
  await service.listen()
  t.after(() => service.close())
  const publicPort = (service.publicServer.address() as AddressInfo).port
  const keyOf = (n: number) => new URL(plans[n].pageUrl).searchParams.get('key')!
  return { service, control, dataDir, localToken, publicPort, plans, started, recall, keyOf }
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
const auth = (s: Started) => ({ authorization: `Bearer ${s.localToken}` })
const join = (s: Started, body: object) =>
  request(s.control, { method: 'POST', path: '/api/join', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...auth(s) } })
const slidesApi = (s: Started, body?: object, headers: Record<string, string> = auth(s)) =>
  body === undefined
    ? request(s.control, { path: '/api/slides', headers })
    : request(s.control, { method: 'POST', path: '/api/slides', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })

async function openPage(port: number, key: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio?${new URLSearchParams({ key, token: PAGE_TOKEN, n: '1' })}`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`refused: ${res.statusCode}`)))
  })
  return ws
}

// --- SLIDES_PLATFORMS ------------------------------------------------------------------------------------------------

test('a deck join on a platform SLIDES_PLATFORMS does not list is refused before any bot is created, and says what to do', async t => {
  // Empty, as it is by default: presenting is off everywhere.
  const s = await start(t, { slidesPlatforms: [] })
  const refused = await join(s, { meetingUrl: ZOOM, slides: { script: CANONICAL } })
  assert.equal(refused.status, 400)
  assert.equal(refused.body, slidesPlatformProblem('zoom', []))
  assert.match(refused.body, /Presenting slides is off on Zoom/)
  assert.match(refused.body, /docs\/share-test\.md/)
  assert.match(refused.body, /add zoom to SLIDES_PLATFORMS in \.env \(it lists none yet\)/)
  assert.equal(s.plans.length, 0, 'no bot was created')
  // On only for Zoom: a Google Meet meeting is still refused, and says what is on.
  const zoomOnly = await start(t, { slidesPlatforms: ['zoom'] })
  const meet = await join(zoomOnly, { meetingUrl: MEET, slides: { script: CANONICAL } })
  assert.equal(meet.status, 400)
  assert.match(meet.body, /Presenting slides is off on Google Meet.*add google_meet to SLIDES_PLATFORMS in \.env \(it lists zoom\)/)
  assert.equal(zoomOnly.plans.length, 0)
  // The same meeting without slides joins as it always did.
  assert.equal((await join(s, { meetingUrl: ZOOM })).status, 200)
  assert.deepEqual(Object.keys(s.plans[0]).sort(), ['meetingUrl', 'pageUrl'])
})

test('the platform refusal is said before any problem with the deck, so a missing deck never hides it', async t => {
  const s = await start(t, { slidesPlatforms: [] })
  const refused = await join(s, { meetingUrl: ZOOM, slides: { script: '<!-- a raw file -->' } })
  assert.match(refused.body, /Presenting slides is off on Zoom/)
})

// --- What the service takes ------------------------------------------------------------------------------------------

test('a deck join on an enabled platform: the plan asks for the slides notice and timer, and the answer says what to check', async t => {
  const s = await start(t)
  const joined = await join(s, { meetingUrl: ZOOM, slides: { script: CANONICAL } })
  assert.equal(joined.status, 200, joined.body)
  const answer = JSON.parse(joined.body)
  assert.equal(answer.slides, true)
  assert.match(answer.slides_note, /^It has "Q4 plan": 3 slides to present, about \d+ s of your 10 min\./)
  assert.match(answer.slides_note, /says "Alex, start the presentation", or when you start it \(npm run slides -- control start/)
  assert.ok(answer.slides_note.endsWith(shareSetting('zoom')))
  assert.deepEqual(s.plans[0].slides, { minutes: 10 })
  // The share starts on cue, mid-call: nothing goes to Recall at the join.
  assert.deepEqual(s.recall, [])
  // The session gets the slides the script shows, in page order: not the excluded page, the backup one marked.
  await openPage(s.publicPort, s.keyOf(0))
  await until(() => s.started.length > 0)
  const slides = s.started[0].slides!
  assert.deepEqual(slides.slides.map(x => [x.page, x.title, x.onRequest]), [[1, 'Welcome', false], [2, 'Pricing', false], [4, 'Security', true], [5, 'Next steps', false]])
  assert.equal(slides.platform, 'zoom')
  assert.equal(slides.title, 'Q4 plan')
  assert.equal(slides.surface.count, 4)
})

test('the service takes the script only without comments, and refuses one with errors, a stale slide, or no deck, all before any bot', async t => {
  const s = await start(t)
  const cases: [unknown, RegExp][] = [
    [{ script: SCRIPT }, /still has comments in it/],
    [{ script: CANONICAL.replace('## 5 · Next steps\n', '## 5 · Next steps\ncheck: changed\n') }, /page 5, line \d+: the slide changed after this was written/],
    [{ script: CANONICAL.replace('We ship in March. Thank you.', 'TODO') }, /TODO: write the narration/],
    [{ script: CANONICAL.replace(DECK_ID, 'gone-deck-abcdef') }, /The prepared deck gone-deck-abcdef is gone .*npm run slides -- prepare <your PDF> again/],
    [{ script: CANONICAL.replace('## 5 · Next steps', '## 9 · Next steps') }, /page 9.*not in the deck: it has 5 pages/],
    [{ script: CANONICAL, from: 3 }, /Slide 3 is not one the script presents in order/],
    [{ script: CANONICAL, from: 4 }, /Slide 4 is not one the script presents in order/],
    [{ script: CANONICAL, from: 'two' }, /--from takes a slide number/],
    [{ from: 2 }, /slides_from goes with slides/],
    [{ script: 42 }, /slides has no script/],
    ['a script', /slides has to be \{script, from\}/],
  ]
  for (const [slides, why] of cases) {
    const refused = await join(s, { meetingUrl: ZOOM, slides })
    assert.equal(refused.status, 400, JSON.stringify(slides).slice(0, 60))
    assert.match(refused.body, why)
  }
  assert.equal(s.plans.length, 0)
  // Started from a later slide.
  const later = await join(s, { meetingUrl: ZOOM, slides: { script: CANONICAL, from: 2 } })
  assert.equal(later.status, 200, later.body)
  // A meeting is joined with slides or with the share test, never both.
  const both = await join(s, { meetingUrl: ZOOM, slides: { script: CANONICAL }, share_test: true })
  assert.equal(both.status, 400)
  assert.match(both.body, /with slides or with the screen-share test, not both/)
})

test("only the slides the script shows are read: an excluded page's image is never opened, and a join marks the deck as used", t => {
  const dir = tempDir(t)
  const decks = decksDir(dir)
  const deck = writeDeck(decks)
  // Page 3 is excluded: its image is changed on disk (same size, other bytes), which the loader would refuse if it read it.
  const file = path.join(deck.dir, '003.webp')
  const bytes = fs.readFileSync(file)
  fs.writeFileSync(file, Buffer.alloc(bytes.length, 7), { mode: 0o600 })
  const old = new Date('2026-01-01T00:00:00Z')
  fs.utimesSync(path.join(deck.dir, 'manifest.json'), old, old)
  const meeting = meetingDeck({ script: CANONICAL }, { decksDir: decks, retentionDays: 30 })
  assert.deepEqual(meeting.slides.map(x => x.page), [1, 2, 4, 5])
  assert.deepEqual(meeting.images, [deck.images[0], deck.images[1], deck.images[3], deck.images[4]])
  assert.ok(fs.statSync(path.join(deck.dir, 'manifest.json')).mtimeMs > old.getTime(), 'the join is a use of the deck')
  // A page the script shows that is changed is refused.
  fs.writeFileSync(path.join(deck.dir, '002.webp'), Buffer.alloc(deck.images[1].length, 7), { mode: 0o600 })
  assert.throws(() => meetingDeck({ script: CANONICAL }, { decksDir: decks, retentionDays: 30 }), (err: Error) => err instanceof SlidesRefused && /002\.webp/.test(err.message))
})

test('npm run join --slides checks the file on this computer, comments and all, and sends its canonical text without them', t => {
  const dir = tempDir(t)
  const decks = decksDir(dir)
  writeDeck(decks)
  const file = path.join(dir, 'q4-plan.script.md')
  fs.writeFileSync(file, SCRIPT)
  const place = { decksDir: decks, retentionDays: 30 }
  const ok = joinScript(file, undefined, place)
  assert.ok(ok.ok)
  assert.equal(ok.text, CANONICAL)
  assert.doesNotMatch(ok.text, /<!--|never say the discount/)
  assert.ok(ok.ok && ok.deck.slides.length === 4)
  // An excluded section marked check: changed is an error in the file, though its canonical text would not say so.
  fs.writeFileSync(file, SCRIPT.replace('## 3 · Customers\nexclude: yes', '## 3 · Customers\nexclude: yes\ncheck: changed'))
  const stale = joinScript(file, undefined, place)
  assert.ok(!stale.ok && /the slide on this page changed after the section was excluded/.test(stale.problem))
  // Only a script, by its name; and --from is checked as the service checks it.
  const other = path.join(dir, 'notes.md')
  fs.writeFileSync(other, SCRIPT)
  const named = joinScript(other, undefined, place)
  assert.ok(!named.ok && /notes\.md is not a script/.test(named.problem))
  fs.writeFileSync(file, SCRIPT)
  const from = joinScript(file, 4, place)
  assert.ok(!from.ok && /Slide 4 is not one the script presents in order/.test(from.problem))
})

test('the join arguments: --slides and --from, and what they go with', () => {
  assert.deepEqual(joinArgs([ZOOM, '--slides', 'decks/q4.script.md']), { meetingUrl: ZOOM, slidesFile: 'decks/q4.script.md' })
  assert.deepEqual(joinArgs(['--slides=decks/q4.script.md', '--from', '3', ZOOM]), { meetingUrl: ZOOM, slidesFile: 'decks/q4.script.md', from: 3 })
  assert.deepEqual(joinArgs([ZOOM, '--from', '3']), { problem: '--from goes with --slides.' })
  assert.deepEqual(joinArgs([ZOOM, '--slides', 'a.script.md', '--from', '0']), { problem: '--from needs a slide number from 1 to 100 after it.' })
  assert.deepEqual(joinArgs([ZOOM, '--slides', 'a.script.md', '--from', 'x']), { problem: '--from needs a slide number from 1 to 100 after it.' })
  assert.deepEqual(joinArgs([ZOOM, '--slides', 'a.script.md', '--share-test']), { problem: 'Use --share-test or --slides, not both.' })
  assert.deepEqual(joinArgs([ZOOM, '--slides']), { problem: '--slides needs a file after it.' })
})

test('the note names the deck, the estimate, how it starts, and the share setting of each platform', () => {
  const deck = { name: 'Q4 plan', narrated: 9, totalMs: 9 * 60_000, script: { minutes: 15 } }
  assert.equal(
    slidesNote(deck, 'zoom', 'Alex'),
    'It has "Q4 plan": 9 slides to present, about 9 min of your 15 min. It starts when someone says "Alex, start the presentation", ' +
      'or when you start it (npm run slides -- control start, or slides_control in Claude Code). Before then, make sure Alex may share its screen. ' +
      'Zoom: "Who can share?" set to "All participants" (in the meeting, the arrow beside Share, then Advanced sharing options).',
  )
  assert.match(slidesNote({ ...deck, script: { minutes: null } }, 'google_meet', 'Alex'), /about 9 min\. .*Google Meet: Host controls, "Share their screen" on .*make it a co-host\.$/)
  assert.match(slidesNote(deck, 'microsoft_teams', 'Alex'), /Microsoft Teams: Meeting options, "Who can present" includes everyone\. Or make Alex a presenter/)
})

// --- The owner's controls --------------------------------------------------------------------------------------------

test('/api/slides is the presentation of the one meeting with slides, refused from a web page or without the token', async t => {
  const s = await start(t)
  assert.equal((await slidesApi(s, undefined, { origin: 'https://evil.example', ...auth(s) })).status, 403)
  assert.equal((await slidesApi(s, undefined, {})).status, 401)
  assert.equal((await slidesApi(s, { action: 'start' }, {})).status, 401)
  assert.equal((await request(s.control, { method: 'POST', path: '/api/slides', body: '{}', headers: auth(s) })).status, 415)
  // No meeting with slides yet.
  assert.deepEqual(JSON.parse((await slidesApi(s)).body), { ok: false, note: 'Alex has no slides to present in any meeting right now' })
  // A meeting without slides, and one with.
  await join(s, { meetingUrl: ZOOM })
  await join(s, { meetingUrl: ZOOM, slides: { script: CANONICAL } })
  await openPage(s.publicPort, s.keyOf(0))
  await openPage(s.publicPort, s.keyOf(1))
  await until(() => s.started.length === 2)
  const status = JSON.parse((await slidesApi(s)).body)
  assert.deepEqual(status, { ok: true, meeting: s.keyOf(1), bot: 'bot-2', status: STATUS })
  const done = JSON.parse((await slidesApi(s, { action: 'goto', slide: 4 })).body)
  assert.deepEqual(done, { ok: true, note: 'did goto', meeting: s.keyOf(1), bot: 'bot-2', status: STATUS })
  assert.deepEqual(s.started[1].actions, [{ action: 'goto', slide: 4 }])
  // By the bot's id, which npm run join prints, or the meeting's key; never another meeting.
  assert.equal(JSON.parse((await slidesApi(s, { action: 'pause', meeting: 'bot-2' })).body).ok, true)
  assert.deepEqual(JSON.parse((await slidesApi(s, { action: 'pause', meeting: 'bot-1' })).body), {
    ok: false,
    note: 'that meeting has no slides: send Alex in with slides to present them',
  })
  assert.equal(JSON.parse((await slidesApi(s, { action: 'leave' })).body).ok, false)
  assert.equal(s.started[0].actions.length, 0)
})

test('the slide controls refuse without a key while two meetings have slides, and check the action and the slide', () => {
  const session = (key: string, bot: string, withSlides: boolean) => {
    const actions: string[] = []
    const s: LiveSession & { actions: string[] } = {
      opts: { meetingKey: key },
      botId: bot,
      transcript: { recent: () => '' },
      addToBrief: () => ({ ok: true }),
      postChat: async () => true,
      whyNotAnswered: () => ({ ok: true }),
      presenter: withSlides ? { owner: a => (actions.push(a), { ok: true, note: 'ok' }), status: () => STATUS } : null,
      actions,
    }
    return s
  }
  const a = session('k1', 'b1', true)
  const b = session('k2', 'b2', true)
  const handlers = slidesHandlers([a, b])
  assert.deepEqual(handlers.slidesStatus(), { ok: false, note: 'Alex has slides in more than one meeting right now: pass the meeting key as "meeting"' })
  assert.equal(handlers.slidesControl('next', undefined, 'k2').ok, true)
  assert.deepEqual(b.actions, ['next'])
  assert.deepEqual(handlers.slidesControl('jump', undefined, 'k2'), { ok: false, note: 'action has to be one of start, pause, resume, next, back, goto, restart, wrap_up, stop, end' })
  assert.deepEqual(handlers.slidesControl('goto', 101, 'k2'), { ok: false, note: 'slide has to be a slide number from 1 to 100' })
  assert.deepEqual(handlers.slidesStatus('k9'), { ok: false, note: 'Alex is not in that meeting right now' })
  // Only one meeting with slides: no key needed.
  assert.equal(slidesHandlers([a, session('k3', 'b3', false)]).slidesStatus().meeting, 'k1')
})

test('the bridge carries slides_status and slides_control without taking the questions, and join_meeting its slides', async () => {
  const calls: unknown[][] = []
  const bridge = new SessionBridge({
    transcript: () => '',
    postChat: async () => ({ ok: true }),
    setBrief: () => {},
    joinMeeting: async (...args: unknown[]) => {
      calls.push(args)
      return { note: 'joining', meeting: 'k1' }
    },
    slidesStatus: meeting => ({ ok: true, meeting: meeting ?? 'k1', status: STATUS }),
    slidesControl: (action, slide, meeting) => ({ ok: action === 'next', note: `${String(action)} ${String(slide)} ${String(meeting)}` }),
  })
  const sent: ToSession[] = []
  const fake = Object.assign(new (await import('node:events')).EventEmitter(), {
    readyState: 1,
    send: (raw: string) => void sent.push(JSON.parse(raw)),
  })
  bridge.attach(fake as unknown as import('ws').WebSocket)
  const say = async (msg: object) => {
    fake.emit('message', Buffer.from(JSON.stringify(msg)))
    await wait(5)
  }
  await say({ type: 'slides_status', request_id: 'r1' })
  await say({ type: 'slides_control', request_id: 'r2', action: 'next', slide: 3, meeting: 'k1' })
  await say({ type: 'join_meeting', request_id: 'r3', meeting_url: ZOOM, slides: 'the script', slides_from: 2 })
  await say({ type: 'join_meeting', request_id: 'r4', meeting_url: ZOOM })
  assert.deepEqual(sent.find(m => m.type === 'ack' && m.request_id === 'r1'), { type: 'ack', request_id: 'r1', ok: true, meeting: 'k1', slides: STATUS })
  assert.deepEqual(sent.find(m => m.type === 'ack' && m.request_id === 'r2'), { type: 'ack', request_id: 'r2', ok: true, note: 'next 3 k1' })
  assert.deepEqual(calls, [[ZOOM, undefined, { script: 'the script', from: 2 }], [ZOOM, undefined]], 'a join without slides is called as it always was')
})

test('npm run slides -- status and control: the arguments, and what they print', () => {
  assert.deepEqual(slidesArgs(['status']), { command: 'status' })
  assert.deepEqual(slidesArgs(['status', '--meeting', 'bot-2']), { command: 'status', meeting: 'bot-2' })
  assert.deepEqual(slidesArgs(['control', 'goto', '5']), { command: 'control', action: 'goto', slide: 5 })
  assert.deepEqual(slidesArgs(['control', 'pause', '--meeting=bot-2']), { command: 'control', action: 'pause', meeting: 'bot-2' })
  assert.deepEqual(slidesArgs(['control', 'goto']), { problem: 'goto takes a slide number from 1 to 100.' })
  assert.deepEqual(slidesArgs(['control', 'next', '5']), { problem: 'next takes no slide number.' })
  assert.match((slidesArgs(['control', 'leave']) as { problem: string }).problem, /control takes one of start, pause, resume, next/)
  assert.deepEqual(slidesArgs(['list', '--meeting', 'x']), { problem: 'list takes no --meeting.' })
  const held: PresenterStatus = { state: 'held', slide: 2, bookmark: 2, of: 4, title: 'Pricing', held: 'owner', detour: false, share: 'loaded' }
  assert.equal(
    statusLine(held, 'bot-2'),
    'Bot bot-2: held (you paused it: only you can resume it), slide 2 on screen ("Pricing"); it carries on from slide 2, of 4 in the meeting. The share is loaded.',
  )
  assert.deepEqual(presentationLines({ status: 200, body: JSON.stringify({ ok: false, note: 'Alex has no slides to present in any meeting right now' }) }, 'Alex'), {
    lines: ['Not done: Alex has no slides to present in any meeting right now.'],
    code: 1,
  })
  assert.deepEqual(presentationLines({ status: 401, body: 'The local token is missing' }, 'Alex').code, 1)
})
