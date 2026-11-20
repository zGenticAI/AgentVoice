// One whole presentation, end to end and offline: the real service (its listeners, the join, the deck on disk, the
// slide share, its public routes and the meeting session with its Presenter) with the repo's fakes around it: Recall
// answered at the HTTP level (so the share's POST and DELETE bodies are the real ones), the camera page and the slides
// page as websocket clients, speech recognition's lines, the brain and the voice. It joins with a deck on an enabled
// platform, says the consent line of a meeting with slides, starts on "<name>, start the presentation", shares and gets
// the page's acks, narrates two slides, answers a question asked mid-sentence and carries on with "Back to <title>." and
// that same sentence, goes back and carries on, pauses and carries on, stops sharing with exactly {"screenshare":true}
// and the camera untouched, starts again, and leaves on "<name>, please leave" with the share blanked first. And a deck
// join on a platform SLIDES_PLATFORMS does not list is refused before any bot is created.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { BrainEvent } from '../src/brain/brain.ts'
import type { ToSession } from '../src/bridge.ts'
import { LEAVE_LINE, SLIDES_LINES, joinChatMessage } from '../src/consent.ts'
import { identity } from '../src/identity.ts'
import { ensureLocalToken } from '../src/local-token.ts'
import { MeetingSession } from '../src/pipeline/session.ts'
import { botRequest } from '../src/recall.ts'
import { createServers } from '../src/server.ts'
import { decksDir } from '../src/slides/deck.ts'
import { joinScript } from '../src/slides/join.ts'
import type { PresenterTiming } from '../src/slides/presenter.ts'
import type { ShareTiming } from '../src/slides/share.ts'
import { SCRIPT, writeDeck } from './fixtures/slides/deck-on-disk.ts'

const PUBLIC = 'https://assistant.example.com'
const PAGE_TOKEN = 'p'.repeat(48)
const ZOOM = 'https://us06web.zoom.us/j/123456789?pwd=abc'
const MEET = 'https://meet.google.com/abc-defg-hij'
const RECALL = 'https://us-east-1.recall.ai/api/v1'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await wait(5)
  }
}

// The presenter's and the share's timings, made short; the order of things is what the test checks.
const PRESENTER: Partial<PresenterTiming> = {
  tickMs: 5,
  leadMs: 10,
  slideQuietMs: 20,
  questionQuietMs: 40,
  talkQuietMs: 40,
  carryOnWindowMs: 150,
  canSeeDelayMs: 10,
  canSeeWindowMs: 200,
  canSeeQuietMs: 40,
  pageBackMs: 20,
  voiceRetryMs: 10,
  heldLongMs: 60_000,
  qaIdleMs: 60_000,
}
const SHARE: Partial<ShareTiming> = { loadMs: 3000, ackMs: 1000, postGapMs: 0, sendKbps: 200_000, deleteBackoffMs: [20, 40], upgradeGapMs: 0 }

/** Speech recognition, as the session uses it: the test says each turn. */
class FakeFlux extends EventEmitter {
  closed = false
  send() {}
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1005, ''))
  }
  forceEndTurn() {}
  turn(event: string, transcript: string) {
    this.emit('turn', { type: 'TurnInfo', event, turn_index: 0, transcript })
  }
  /** A line said in a quiet room: its turn starts and ends. */
  said(text: string) {
    this.turn('StartOfTurn', '')
    this.turn('EndOfTurn', text)
  }
}

/** A Recall call the service made over HTTP: the share's POST and DELETE. */
interface RecallCall {
  method: string
  path: string
  body: string
}

/**
 * The slides page as the bot's browser runs it, reduced to its protocol: it links up with the address Recall was given,
 * says hello, acknowledges each slide it is told to show, and keeps the frames it is sent.
 */
class SlidesPage {
  readonly ws: WebSocket
  readonly frames: string[] = []
  readonly shown: number[] = []
  /** Which slides' pieces arrived (by index), and how the link closed. */
  readonly pieces = new Set<number>()
  closed: number | null = null
  constructor(port: number, pageUrl: string, timeline: string[]) {
    const url = new URL(pageUrl)
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/slides-link?${new URLSearchParams({ s: url.searchParams.get('s')!, t: url.searchParams.get('t')! })}`, {
      headers: { origin: PUBLIC },
    })
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'hello', v: 1, rev: null, have: '' })))
    this.ws.on('message', (data, binary) => {
      if (binary) {
        this.pieces.add((data as Buffer).readUInt16BE(6))
        return
      }
      const msg = JSON.parse(data.toString())
      if (msg.type === 'show') {
        this.shown.push(msg.i)
        this.ws.send(JSON.stringify({ type: 'shown', i: msg.i, seq: msg.seq }))
      }
      if (msg.type === 'frame') {
        this.frames.push(msg.kind)
        timeline.push(`page: frame ${msg.kind}`)
        this.ws.send(JSON.stringify({ type: 'framed', seq: msg.seq }))
      }
    })
    this.ws.on('close', code => {
      this.closed = code
      timeline.push(`page: closed ${code}`)
    })
    this.ws.on('error', () => {})
  }
}

async function presentation(t: TestContext, opts: { platforms: string[] }) {
  const dataDir = fs.mkdtempSync(path.join('/tmp', 'av-e2e-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  writeDeck(decksDir(dataDir))
  const scriptFile = path.join(dataDir, 'q4-plan.script.md')
  fs.writeFileSync(scriptFile, SCRIPT, { mode: 0o600 })

  // What happened, in order, across the voice, Recall, the page and the room.
  const timeline: string[] = []
  const spoken: string[] = []
  const recall: RecallCall[] = []
  const pages: SlidesPage[] = []
  const plans: Parameters<typeof botRequest>[0][] = []
  const notified: ToSession[] = []
  const brainInputs: any[] = []
  const answers: BrainEvent[][] = [[{ kind: 'say', text: 'Yes, per user.' }]]
  const flux = new FakeFlux()
  let session: MeetingSession | null = null
  let publicPort = 0
  // Whether any slide share is live, as the service says, once it exists.
  let live = () => false
  // How long each line plays (ms): the sentence talked over is long enough to be cut in the middle.
  const voice: Record<string, number> = { 'Team is twelve dollars a month.': 1500, 'Business is twenty-nine.': 1500 }

  // Recall, at the HTTP level: only the share's calls come here (the session's own are fakes below). Each POST is the bot
  // loading the page it was given.
  const realFetch = globalThis.fetch
  const realKey = process.env.RECALL_API_KEY
  process.env.RECALL_API_KEY = 'test-key-not-a-real-one'
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith(RECALL)) return realFetch(input, init)
    const call = { method: init?.method ?? 'GET', path: url.slice(RECALL.length), body: String(init?.body ?? '') }
    recall.push(call)
    timeline.push(`recall: ${call.method} ${call.body}`)
    if (call.method === 'POST' && call.path.endsWith('/output_media/')) {
      const pageUrl = JSON.parse(call.body).screenshare.config.url
      setTimeout(() => pages.push(new SlidesPage(publicPort, pageUrl, timeline)), 20)
      return new Response(JSON.stringify({ id: 'bot-1' }), { status: 200 })
    }
    if (call.method === 'DELETE') {
      timeline.push(`recall: DELETE, with the share live: ${live()}`)
      return new Response(null, { status: 204 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.RECALL_API_KEY
    else process.env.RECALL_API_KEY = realKey
  })

  const service = createServers(
    {
      port: 0,
      host: '127.0.0.1',
      controlSocket: path.join(dataDir, 'control.sock'),
      publicUrl: PUBLIC,
      agentPageToken: PAGE_TOKEN,
      localToken: ensureLocalToken(dataDir),
      dataDir,
      maxMeetings: 3,
      maxMeetingMinutes: 180,
      slidesPlatforms: opts.platforms,
      slidesTiming: SHARE,
      reconnectMs: 60_000,
    },
    {
      createBot: async plan => {
        plans.push(plan)
        return { id: `bot-${plans.length}` }
      },
      leaveCall: async () => {},
      // The real session, with fakes for what it reaches outside this process.
      startSession: (ws, sessionOpts, ctx) => {
        session = new MeetingSession(ws, sessionOpts, {
          brain: {
            async *respond(i: { latest: string }) {
              brainInputs.push(i)
              for (const e of answers.shift() ?? []) yield e
            },
          } as any,
          bridge: { ask: async () => null, notify: (m: ToSession) => void notified.push(m) } as any,
          brief: ctx.brief,
          flux: () => flux as any,
          speak: async function* (text: string) {
            spoken.push(text)
            timeline.push(`say: ${text}`)
            if (text === LEAVE_LINE) timeline.push(`slides live as the goodbye starts: ${service.slides.live}`)
            yield Buffer.alloc((voice[text] ?? 20) * 32)
          },
          recall: {
            sendChat: async () => {},
            leaveCall: async () => void timeline.push('recall: leave_call'),
            deleteMedia: async () => true,
            howBotEnded: async () => ({ kind: 'ended', sub_code: 'bot_received_leave_call' }) as const,
          },
          writeMinutes: async () => '/tmp/never-written.md',
          greetDelayMs: 5,
          sttFlushMs: 0,
          leaveDelayMs: 0,
          pauseMaxMs: 60_000,
          reconnectMs: ctx.reconnectMs,
          slides: ctx.slides ? { ...ctx.slides, timing: PRESENTER } : undefined,
        })
        return session
      },
    },
  )
  await service.listen()
  t.after(() => service.close())
  publicPort = (service.publicServer.address() as AddressInfo).port
  live = () => service.slides.live
  const localToken = ensureLocalToken(dataDir)
  const join = (body: object) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { socketPath: path.join(dataDir, 'control.sock'), method: 'POST', path: '/api/join', headers: { host: 'localhost', 'content-type': 'application/json', authorization: `Bearer ${localToken}` } },
        res => {
          let text = ''
          res.on('data', c => (text += c))
          res.on('end', () => resolve({ status: res.statusCode!, body: text }))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  const after = (line: string) => spoken.slice(spoken.lastIndexOf(line) + 1)
  return { service, dataDir, scriptFile, timeline, spoken, recall, pages, plans, notified, brainInputs, flux, join, after, publicPort: () => publicPort, session: () => session }
}

test('a whole presentation, offline: join, consent, start, share and acks, narration, a question, back, pause, stop, and "please leave"', { timeout: 60_000 }, async t => {
  const p = await presentation(t, { platforms: ['zoom'] })
  const name = identity.name

  // --- Join with a deck on an enabled platform: the script as npm run join sends it, checked here first.
  const checked = joinScript(p.scriptFile, undefined, { decksDir: decksDir(p.dataDir), retentionDays: 30 })
  assert.ok(checked.ok)
  const joined = await p.join({ meetingUrl: ZOOM, slides: { script: checked.text } })
  assert.equal(joined.status, 200, joined.body)
  assert.match(JSON.parse(joined.body).slides_note, /3 slides to present/)
  // The bot is asked for the chat notice of a meeting with slides, and the camera only: the share starts on cue.
  const body = botRequest(p.plans[0]) as any
  assert.equal(body.chat.on_bot_join.message, joinChatMessage(identity, undefined, { slides: true }))
  assert.deepEqual(Object.keys(body.output_media), ['camera'])
  assert.equal(p.recall.length, 0, 'nothing is shared at the join')

  // --- The camera page connects: the consent line of a meeting with slides, said in full.
  const key = new URL(p.plans[0].pageUrl).searchParams.get('key')!
  const camera = new WebSocket(`ws://127.0.0.1:${p.publicPort()}/audio?${new URLSearchParams({ key, token: PAGE_TOKEN, n: '1' })}`)
  let cameraClosed = false
  camera.on('close', () => void (cameraClosed = true))
  camera.on('error', () => {})
  await new Promise(resolve => camera.once('open', resolve))
  await until(() => p.session()?.consentDone === true, 'the consent line')
  assert.equal(p.spoken[0], SLIDES_LINES.join)
  assert.match(SLIDES_LINES.join, new RegExp(`say "${name}, start the presentation" when you're ready`))
  const session = p.session()!
  const presenter = session.presenter!

  // --- "<name>, start the presentation": the line, the share (POST with the page's address), the page's acks, the
  // check question, silence, and the script word for word.
  p.flux.said(`${name}, start the presentation.`)
  await until(() => p.spoken.includes(SLIDES_LINES.canSee), 'the check question')
  assert.equal(p.spoken[1], SLIDES_LINES.sharing)
  const [post] = p.recall
  assert.equal(post.method, 'POST')
  assert.equal(post.path, '/bot/bot-1/output_media/')
  const posted = JSON.parse(post.body)
  assert.deepEqual(Object.keys(posted), ['screenshare'], 'only the screen share: the camera is never named')
  assert.equal(posted.screenshare.kind, 'webpage')
  assert.match(posted.screenshare.config.url, /^https:\/\/assistant\.example\.com\/slides\?s=[\w-]{22}&t=[\w-]{43}$/)
  const page = p.pages[0]
  assert.equal(page.shown[0], 0, 'the first slide shown, and acknowledged')
  await until(() => presenter.current === 'narrating', 'narration, after a quiet moment')
  await until(() => p.spoken.includes('Team is twelve dollars a month.'), 'slide 2')
  assert.deepEqual(p.after(SLIDES_LINES.canSee).slice(0, 3), ['Hello everyone.', 'This is the plan for the quarter.', 'Team is twelve dollars a month.'])
  await until(() => page.shown.includes(1), 'slide 2 shown')
  assert.ok(page.pieces.has(0) && page.pieces.has(1), 'the slides on screen went to the page')
  assert.ok(session.transcript.lines.some(l => l.speaker === 'Slides' && l.text === 'showing slide 2: Pricing' && l.role === 'agent'))

  // --- A question in the middle of a sentence: answered, then "Back to Pricing." and that same sentence.
  await wait(300)
  p.flux.turn('StartOfTurn', '')
  p.flux.turn('EndOfTurn', `${name}, is that per user?`)
  await until(() => p.spoken.includes('Back to Pricing.'), '"Back to Pricing."')
  const answered = p.spoken.indexOf('Yes, per user.')
  await until(() => p.spoken.length > answered + 2, 'the sentence again')
  assert.deepEqual(
    p.spoken.slice(answered, answered + 3),
    ['Yes, per user.', 'Back to Pricing.', 'Team is twelve dollars a month.'],
    'answered, then back to the slide, and the sentence it stopped at, said again',
  )
  // The voice runs ahead of what the meeting hears: the sentences sent after the one cut short were never heard, so the
  // transcript doesn't have them, and narration carries on from the one the meeting stopped hearing.
  const heard = session.transcript.lines.map(l => l.text)
  const asked = heard.indexOf(`${name}, is that per user?`)
  assert.ok(!heard.slice(0, asked).includes('Business is twenty-nine.'))
  assert.ok(!heard.slice(0, asked).includes('That covers pricing.'))
  assert.equal(p.brainInputs[0].slides.current.page, 2, 'the answer knew the slide on screen')

  // --- "<name>, go back", then "<name>, carry on": slide 1 as a detour, then back to the bookmark and its sentence.
  await wait(300)
  p.flux.turn('StartOfTurn', '')
  p.flux.turn('EndOfTurn', `${name}, go back.`)
  await until(() => p.spoken.includes("Here's slide 1."), '"Here\'s slide 1."')
  await until(() => page.shown.at(-1) === 0, 'slide 1 on screen again')
  assert.equal(presenter.status().detour, true)
  assert.equal(presenter.status().bookmark, 2)
  p.flux.said(`${name}, carry on.`)
  await until(() => p.after("Here's slide 1.").includes('Team is twelve dollars a month.'), 'back to the bookmark')
  assert.deepEqual(p.after("Here's slide 1.").slice(0, 2), ['Back to Pricing.', 'Team is twelve dollars a month.'])
  await until(() => page.shown.at(-1) === 1, 'slide 2 on screen again')

  // --- "<name>, pause", then "<name>, carry on": nothing said meanwhile, then the same sentence.
  await wait(300)
  const before = p.spoken.length
  p.flux.turn('StartOfTurn', '')
  p.flux.turn('EndOfTurn', `${name}, pause.`)
  await until(() => presenter.status().held === 'asked', 'held')
  await wait(200)
  assert.equal(p.spoken.length, before, 'silence while paused')
  p.flux.said(`${name}, carry on.`)
  await until(() => p.spoken.length > before, 'carried on')
  assert.equal(p.spoken[before], 'Team is twelve dollars a month.')

  // --- "<name>, stop presenting": the line, the page blanked, then a DELETE of the share only. The camera is untouched.
  await wait(300)
  p.flux.turn('StartOfTurn', '')
  p.flux.turn('EndOfTurn', `${name}, stop presenting.`)
  await until(() => p.recall.some(c => c.method === 'DELETE'), 'the DELETE')
  const del = p.recall.find(c => c.method === 'DELETE')!
  assert.equal(del.path, '/bot/bot-1/output_media/')
  assert.equal(del.body, '{"screenshare":true}', 'exactly the share: never {}, nothing, or the camera')
  // The page was blanked, and its address revoked, before the DELETE went: no slide stays up while Recall stops it.
  assert.ok(p.timeline.includes('recall: DELETE, with the share live: false'), 'blanked before the DELETE')
  await until(() => page.closed !== null, 'the first page let go')
  assert.equal(page.frames.at(-1), 'ended')
  assert.equal(page.closed, 4000)
  await until(() => p.spoken.includes(SLIDES_LINES.stopped), 'the stop line')
  assert.equal(presenter.current, 'stopped')
  assert.ok(p.recall.every(c => !/camera/.test(c.body)), 'no call names the camera')
  assert.equal(cameraClosed, false, "the camera page's connection never dropped")
  assert.equal(session.consentDone, true)

  // --- Started again, from the bookmark (no check question this time): a fresh share, with a new address.
  p.flux.said(`${name}, start the presentation.`)
  await until(() => p.pages.length === 2 && p.pages[1].shown.length > 0, 'the second share')
  await until(() => presenter.current === 'narrating', 'narrating again')
  assert.equal(p.spoken.filter(l => l === SLIDES_LINES.canSee).length, 1)
  assert.notEqual(JSON.parse(p.recall.filter(c => c.method === 'POST')[1].body).screenshare.config.url, posted.screenshare.config.url)

  // --- "<name>, please leave": the share is blanked and its address dies before the goodbye; no DELETE; nothing kept.
  const deletes = p.recall.filter(c => c.method === 'DELETE').length
  p.flux.said(`${name}, please leave.`)
  await until(() => p.notified.some(n => n.type === 'meeting_ended'), 'meeting_ended')
  assert.ok(p.timeline.includes('slides live as the goodbye starts: false'), 'the share was closed before the goodbye')
  await until(() => p.pages[1].closed !== null, 'the page let go')
  assert.equal(p.pages[1].frames.at(-1), 'ended')
  assert.equal(p.pages[1].closed, 4000, "the page is told it's over")
  assert.equal(p.recall.filter(c => c.method === 'DELETE').length, deletes, 'no DELETE: the share goes with the bot')
  assert.ok(p.spoken.includes(LEAVE_LINE))
  const ended = p.notified.find(n => n.type === 'meeting_ended') as Extract<ToSession, { type: 'meeting_ended' }>
  assert.equal(ended.transcript_file, '')
  assert.equal(ended.presentation, undefined, 'nothing of the presentation is kept after "please leave"')
  // Slide commands were never questions.
  assert.deepEqual(p.brainInputs.map(i => i.latest), [`${name}, is that per user?`])
  // And once the bot is out, the slides' routes answer as an unknown path again.
  await until(() => !p.service.slides.live, 'no share live')
  const after = await new Promise<number>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${p.publicPort()}/slides-link?s=x&t=y`, { headers: { origin: PUBLIC } })
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('error', () => {})
  })
  assert.equal(after, 404)
  camera.close()
})

test('a deck join on a platform SLIDES_PLATFORMS does not list is refused before any bot is created', { timeout: 20_000 }, async t => {
  const p = await presentation(t, { platforms: ['zoom'] })
  const checked = joinScript(p.scriptFile, undefined, { decksDir: decksDir(p.dataDir), retentionDays: 30 })
  assert.ok(checked.ok)
  const refused = await p.join({ meetingUrl: MEET, slides: { script: checked.text } })
  assert.equal(refused.status, 400)
  assert.match(refused.body, /^Presenting slides is off on Google Meet\. Run the screen-share test in a Google Meet meeting you host first \(docs\/share-test\.md\)\. Once it passes, add google_meet to SLIDES_PLATFORMS in \.env \(it lists zoom\) and restart the service\.$/)
  assert.equal(p.plans.length, 0, 'no bot')
  assert.equal(p.recall.length, 0, 'nothing went to Recall')
})
