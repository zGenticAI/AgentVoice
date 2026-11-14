// A meeting's session outlives its page's connection: the page drops, and comes back to the same session with the
// secret from its 'ready' and how much of Alex's voice it got. The page's playback is followed by a clock the test
// moves, so what the transcript keeps of a line is exact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import type { BrainEvent } from '../src/brain/brain.ts'
import type { ToSession } from '../src/bridge.ts'
import { JOIN_LINE, LEAVE_LINE } from '../src/consent.ts'
import { PAGE_LEAD_MS } from '../src/pipeline/playback.ts'
import { MeetingSession, PAGE_CLOSE, PAGE_ERRORS } from '../src/pipeline/session.ts'
import type { BotEnding } from '../src/recall.ts'

/** The page's connection, as the session sees it. */
class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  closedWith: number | undefined
  terminated = false
  send(data: Buffer | string) {
    this.sent.push(data)
  }
  close(code?: number) {
    if (this.readyState === 3) return
    this.closedWith = code
    this.readyState = 3
    this.emit('close', code ?? 1005, Buffer.from(''))
  }
  terminate() {
    if (this.readyState === 3) return
    this.terminated = true
    this.readyState = 3
    this.emit('close', 1006, Buffer.from(''))
  }
  /** The connection dropped: a reset, or the server cutting off a page that went silent. */
  drop() {
    this.readyState = 3
    this.emit('close', 1006, Buffer.from(''))
  }
  /** An 80 ms frame of the meeting's audio from the page. */
  frame() {
    this.emit('message', Buffer.alloc(2560), true)
  }
  controls() {
    return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d as string))
  }
  /** The controls, without 'speaking' (which the page ignores). */
  kinds() {
    return this.controls().map(c => c.type).filter(k => k !== 'speaking')
  }
  audioBytes() {
    return this.sent.reduce((sum, d) => sum + (typeof d === 'string' ? 0 : d.length), 0)
  }
}

/** Like Flux: each event carries the turn so far; forceEndTurn ends the turn in progress. */
class FakeFlux extends EventEmitter {
  received = 0
  forced = 0
  closed = false
  send() {
    this.received++
  }
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  forceEndTurn() {
    this.forced++
  }
  turn(event: string, transcript: string) {
    this.emit('turn', { type: 'TurnInfo', event, turn_index: 0, transcript })
  }
  said(text: string) {
    this.turn('EndOfTurn', text)
  }
}

// 42 letters: said in the time the tests give it.
const A = 'The pilot starts in March and ends in May.'
const T0 = 7_000_000
let meetings = 0

interface Options {
  /** What the brain says to each question, in turn. */
  answers?: BrainEvent[][]
  /** ms of voice for a line (100 unless given), in pieces of at most `piece` ms, all sent at once. */
  voice?: Record<string, number>
  piece?: number
  speak?: (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer>
  /** Recall's answer after a drop: by default it is still in the call (null) once the probe is stopped. */
  botLeftCall?: (botId: string, opts?: { signal?: AbortSignal }) => Promise<BotEnding | null>
  /** How long Recall takes to answer leave_call (ms). */
  leaveCallMs?: number
  extra?: Record<string, unknown>
}

function start(opts: Options = {}) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const meetingKey = `reconnect-${process.pid}-${++meetings}`
  const botId = `bot-${process.pid}-${meetings}`
  let now = T0
  const answers = [...(opts.answers ?? [])]
  const answered: string[] = []
  const spoken: string[] = []
  const events: ToSession[] = []
  const recall = { left: [] as string[], asked: 0, probes: [] as AbortSignal[] }
  let minutes = 0
  const piece = opts.piece ?? 1_000_000
  const session = new MeetingSession(ws as any, { meetingKey, botId, platform: 'Zoom' }, {
    brain: {
      async *respond(i: { latest: string }) {
        answered.push(i.latest)
        for (const e of answers.shift() ?? []) yield e
      },
    } as any,
    bridge: { ask: async () => null, notify: (m: ToSession) => void events.push(m) } as any,
    brief: () => '',
    flux: () => flux as any,
    speak:
      opts.speak ??
      async function* (text: string) {
        spoken.push(text)
        for (let left = opts.voice?.[text] ?? 100; left > 0; left -= piece) yield Buffer.alloc(Math.min(left, piece) * 32)
      },
    recall: {
      sendChat: async () => {},
      leaveCall: async (id: string) => {
        recall.left.push(id)
        await settle(opts.leaveCallMs ?? 0)
      },
      deleteMedia: async () => true,
      howBotEnded: async () => (recall.asked++, { kind: 'ended', sub_code: 'bot_received_leave_call' } as const),
      botLeftCall:
        opts.botLeftCall ??
        ((_id: string, { signal }: { signal?: AbortSignal } = {}) => {
          recall.probes.push(signal!)
          return new Promise<null>(resolve => signal!.addEventListener('abort', () => resolve(null)))
        }),
    },
    writeMinutes: async () => (minutes++, `/tmp/minutes-of-${botId}.md`),
    greetDelayMs: 60_000,
    sttFlushMs: 0,
    leaveDelayMs: 0,
    pauseMaxMs: 60_000,
    reconnectMs: 60_000,
    clock: () => now,
    ...opts.extra,
  })
  let over = false
  void session.over.then(() => (over = true))
  const alex = () => session.transcript.lines.filter(l => l.role === 'agent').map(l => l.text)
  const ended = () => events.find(e => e.type === 'meeting_ended') as Extract<ToSession, { type: 'meeting_ended' }> | undefined
  const secret = () => ws.controls().find(c => c.type === 'ready').rejoin as string
  /** The page comes back on a new connection, saying it got `got` bytes of Alex's voice in all. */
  const back = (got?: number) => {
    const next = new FakeSocket()
    session.attach(next as any, { got })
    return next
  }
  return {
    ws, flux, session, botId, answered, spoken, events, recall, alex, ended, secret, back,
    over: () => over,
    minutes: () => minutes,
    at: (ms: number) => (now = T0 + ms),
  }
}
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
const bytes = (ms: number) => ms * 32

test('a page that drops and comes back with its secret keeps the same session: one transcript, no second meeting_started, no minutes, no second consent line', async () => {
  const s = start({ answers: [[{ kind: 'say', text: 'Friday.' }]], extra: { greetDelayMs: 0 } })
  await settle(250) // the consent line has gone out and played
  assert.deepEqual(s.spoken, [JOIN_LINE])
  const file = s.session.transcript.file
  const rejoin = s.secret()
  s.ws.frame()
  s.ws.drop()
  assert.equal(s.session.resumes(rejoin), true)
  const page = s.back(s.ws.audioBytes())
  assert.deepEqual(page.controls()[0], { type: 'ready', sampleRate: 16000, rejoin })
  assert.equal(page.audioBytes(), 0, 'nothing is said on return')
  s.flux.said('Alex, when is the review?')
  await settle()
  assert.deepEqual(s.spoken, [JOIN_LINE, 'Friday.'], 'the consent line once')
  assert.equal(page.audioBytes(), bytes(100), "the answer goes to the page's new connection")
  assert.equal(s.ws.audioBytes(), bytes(100), 'and none to the old one')
  page.frame()
  assert.equal(s.flux.received, 2, "the meeting's audio from both connections reaches speech recognition")
  assert.equal(s.session.transcript.file, file)
  assert.equal(s.events.filter(e => e.type === 'meeting_started').length, 1)
  assert.equal(s.ended(), undefined)
  assert.equal(s.minutes(), 0)
  assert.equal(s.over(), false)
  s.session.end()
  s.session.transcript.delete()
})

test('while the page is away nothing is sent to it, and words already heard are recorded but not answered', async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }]], voice: { [A]: 2000 } })
  s.flux.said('Alex, when does the pilot run?')
  await settle()
  s.at(500)
  s.ws.frame()
  s.ws.drop()
  const sent = s.ws.sent.length
  s.flux.turn('StartOfTurn', 'Alex')
  s.flux.said('Alex, when is the review?')
  s.flux.said('Alex?')
  await settle()
  assert.deepEqual(s.answered, ['Alex, when does the pilot run?'], 'not answered')
  assert.equal(s.ws.sent.length, sent, 'nothing more to the page')
  assert.deepEqual(
    s.session.transcript.lines.map(l => l.text),
    ['Alex, when does the pilot run?', A, 'Alex, when is the review?', 'Alex?'],
    'recorded, and the answer the page plays on through the drop is followed as it plays',
  )
  // Back, having had all of it: nothing is said, and what was asked meanwhile is not answered then either.
  s.at(5000)
  const page = s.back(s.ws.audioBytes())
  s.flux.said('Thanks.')
  await settle()
  assert.deepEqual(page.kinds(), ['ready', 'hearing'])
  assert.deepEqual(s.answered, ['Alex, when does the pilot run?'])
  assert.deepEqual(s.alex(), [A])
  s.session.end()
  s.session.transcript.delete()
})

test('an answer cut by a drop: on return the transcript keeps only the audio the page says it got, and nothing more is said', async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }, { kind: 'say', text: 'Then the review.' }]], voice: { [A]: 2000, 'Then the review.': 600 }, piece: 500 })
  s.flux.said('Alex, when does the pilot run?')
  await settle()
  assert.equal(s.ws.audioBytes(), bytes(2600), 'all of it went out')
  s.at(300)
  s.ws.drop()
  // The page got the first 1000 ms of A, and played them through the drop.
  s.at(9000)
  const page = s.back(bytes(1000))
  assert.deepEqual(s.alex(), [`The pilot starts in… (cut off)`], 'the line the page never got goes')
  assert.equal(page.audioBytes(), 0)
  assert.deepEqual(page.kinds(), ['ready', 'hearing'])
  assert.deepEqual(s.spoken, [A, 'Then the review.'])
  s.session.end()
  s.session.transcript.delete()
})

test('an answer still going out when the page drops stops there: ElevenLabs is stopped, and the line keeps what the page got', async () => {
  let stopped: AbortSignal | undefined
  const speak = async function* (_text: string, signal?: AbortSignal) {
    stopped = signal
    for (let i = 0; i < 20 && !signal?.aborted; i++) {
      yield Buffer.alloc(bytes(100))
      await settle(5)
    }
  }
  const s = start({ answers: [[{ kind: 'say', text: A }]], speak })
  s.flux.said('Alex, when does the pilot run?')
  await settle(22)
  s.ws.drop()
  const sent = s.ws.audioBytes()
  assert.ok(sent > 0 && sent < bytes(2000), `${sent} bytes went out`)
  assert.equal(stopped?.aborted, true)
  await settle(40)
  s.at(9000)
  s.back(sent)
  assert.deepEqual(s.alex(), ['The… (cut off)'], 'the words of what went out, the rest of the line never did')
  s.session.end()
  s.session.transcript.delete()
})

test("a 'ready' lost in a drop: the page comes back again with the same secret and what it got, and the loss is taken off once", async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }]], voice: { [A]: 2000 }, piece: 500 })
  s.flux.said('Alex, when does the pilot run?')
  await settle()
  const rejoin = s.secret()
  s.at(300)
  s.ws.drop()
  s.at(2000)
  const lost = s.back(bytes(1000))
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  // The page never saw that connection's 'ready': it comes back with the same secret, and the same count.
  lost.drop()
  assert.equal(s.session.resumes(rejoin), true)
  s.at(4000)
  const page = s.back(bytes(1000))
  assert.equal(page.controls()[0].rejoin, rejoin)
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'], 'not cut twice')
  s.session.end()
  s.session.transcript.delete()
})

test('a drop while paused cuts the line where the page paused, and coming back takes nothing more off; no resume is sent later', async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }]], voice: { [A]: 2000 }, extra: { pauseMaxMs: 30 } })
  s.flux.said('Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000)
  s.flux.turn('StartOfTurn', 'Uh')
  assert.deepEqual(s.ws.kinds(), ['ready', 'pause'])
  s.at(PAGE_LEAD_MS + 1500)
  s.ws.drop()
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'], 'cut at the pause')
  // Back at once: the page cleared what it held as it lost its connection, and took that off what it got.
  const page = s.back(bytes(1000))
  s.flux.turn('EndOfTurn', 'Uh.')
  await settle(60) // longer than the pause would have lasted
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  assert.deepEqual(s.ws.kinds(), ['ready', 'pause'], 'no resume to the old connection')
  assert.deepEqual(page.kinds(), ['ready', 'hearing'], 'nor to the new one')
  s.session.end()
  s.session.transcript.delete()
})

test('Start, Update and EndOfTurn arriving after a drop pause nothing and change nothing of what the page plays', async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }]], voice: { [A]: 2000 }, extra: { pauseMaxMs: 20 } })
  s.flux.said('Alex, when does the pilot run?')
  await settle()
  s.at(500)
  s.ws.drop()
  s.flux.turn('StartOfTurn', 'Hold on what')
  s.flux.turn('Update', 'Hold on what about')
  s.flux.turn('EndOfTurn', 'Hold on, what about April?')
  await settle(40)
  assert.deepEqual(s.ws.kinds(), ['ready'], 'no pause, no clear')
  s.at(5000)
  const page = s.back(s.ws.audioBytes())
  await settle(40)
  assert.deepEqual(page.kinds(), ['ready', 'hearing'], 'nor once the page is back')
  assert.deepEqual(s.alex(), [A], 'played in full through the drop')
  assert.deepEqual(s.answered, ['Alex, when does the pilot run?'])
  s.session.end()
  s.session.transcript.delete()
})

test('a sound heard just after a drop pauses nothing, so the page coming back is never resumed, and the line counts what it played', async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }]], voice: { [A]: 2000 } })
  s.flux.said('Alex, when does the pilot run?')
  await settle()
  s.at(500)
  s.ws.drop()
  s.flux.turn('StartOfTurn', 'Uh')
  const page = s.back(s.ws.audioBytes())
  s.flux.turn('EndOfTurn', 'Uh.')
  assert.deepEqual(page.kinds(), ['ready', 'hearing'])
  s.at(5000)
  s.session.end()
  assert.deepEqual(s.alex(), [A])
  s.session.transcript.delete()
})

test('"Alex, never mind" while the page is away is honoured once it is back: it is told to clear, and the line is cut where it was then', async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }]], voice: { [A]: 2000 } })
  s.flux.said('Alex, when does the pilot run?')
  await settle()
  s.at(300)
  s.ws.drop()
  s.flux.said('Alex, never mind.')
  assert.deepEqual(s.ws.kinds(), ['ready'])
  assert.deepEqual(s.alex(), [A], 'the page plays on: nothing is cut while it is away')
  s.at(PAGE_LEAD_MS + 1000)
  const page = s.back(s.ws.audioBytes())
  assert.deepEqual(page.kinds(), ['ready', 'hearing', 'clear'])
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  s.session.end()
  s.session.transcript.delete()
})

test('the consent line cut by a drop is said again in full on return, still protected: talk-over and never-mind leave it be, and a question waits for it', async () => {
  let consents = 0
  let release = () => {}
  const spoken: string[] = []
  const speak = async function* (text: string) {
    spoken.push(text)
    if (text !== JOIN_LINE) {
      yield Buffer.alloc(bytes(100))
      return
    }
    if (++consents === 1) {
      yield Buffer.alloc(bytes(500))
      await new Promise<void>(r => (release = r))
      yield Buffer.alloc(bytes(500))
      return
    }
    yield Buffer.alloc(bytes(300))
  }
  const s = start({ answers: [[{ kind: 'say', text: 'Friday.' }]], speak, extra: { greetDelayMs: 0 } })
  await settle()
  s.flux.said('Alex, what does the brief say?') // waits for the consent line
  s.ws.drop()
  release()
  await settle()
  assert.deepEqual(s.answered, [], 'a question waiting for the consent line is dropped with it')
  s.at(1000)
  const page = s.back(bytes(500))
  assert.deepEqual(spoken, [JOIN_LINE, JOIN_LINE], 'said again at once')
  // The transcript keeps what the meeting heard of the first try, then all of the second.
  assert.deepEqual(s.alex(), ['Hello… (cut off)', JOIN_LINE])
  s.at(1100)
  s.flux.turn('StartOfTurn', 'Hold on what')
  s.flux.turn('Update', 'Hold on what is this')
  s.flux.said('Alex, never mind.')
  s.flux.said('Alex, when is the review?')
  await settle()
  assert.deepEqual(page.kinds(), ['ready', 'hearing'], 'not paused, stopped or cleared')
  assert.deepEqual(s.answered, [], 'the question waits for the end of the consent line')
  await settle(400)
  assert.deepEqual(s.answered, ['Alex, when is the review?'])
  assert.deepEqual(spoken, [JOIN_LINE, JOIN_LINE, 'Friday.'])
  assert.equal(page.audioBytes(), bytes(400))
  s.session.end()
  s.session.transcript.delete()
})

test('the consent line all sent but not all received is said again on return; one received in full is not, nor one confirmed before', async () => {
  for (const [got, again] of [
    [bytes(100) - 1, true],
    [undefined, true],
    [bytes(100), false],
  ] as const) {
    const s = start({ extra: { greetDelayMs: 0 } })
    await settle(250) // all 100 ms of it went out, and played
    s.ws.drop()
    s.back(got)
    assert.deepEqual(s.spoken, again ? [JOIN_LINE, JOIN_LINE] : [JOIN_LINE], String(got))
    if (got === bytes(100)) {
      // Heard: a later drop never brings it back, whatever the page got after it.
      await settle()
      s.session.attach(new FakeSocket() as any, { got: bytes(100) })
      assert.deepEqual(s.spoken, [JOIN_LINE])
    }
    s.session.end()
    s.session.transcript.delete()
  }
})

test('a consent line whose end could not go out because the connection was closing is said again, whatever the page got', async () => {
  let release = () => {}
  let consents = 0
  const speak = async function* (text: string) {
    if (text === JOIN_LINE && ++consents === 1) {
      yield Buffer.alloc(bytes(500))
      await new Promise<void>(r => (release = r))
    }
    yield Buffer.alloc(bytes(500))
  }
  const s = start({ speak, extra: { greetDelayMs: 0 } })
  await settle()
  s.ws.readyState = 2 // closing: the rest of the line can't go out
  release()
  await settle()
  s.ws.drop()
  s.back(s.ws.audioBytes())
  assert.equal(consents, 2)
  s.session.end()
  s.session.transcript.delete()
})

test('the time for the consent line coming while the page is away: it is said once the page is back', async () => {
  const s = start({ extra: { greetDelayMs: 30 } })
  s.ws.drop()
  await settle(60)
  assert.deepEqual(s.spoken, [])
  const page = s.back(0)
  assert.deepEqual(s.spoken, [JOIN_LINE])
  await settle()
  assert.equal(page.audioBytes(), bytes(100))
  s.session.end()
  s.session.transcript.delete()
})

test('a page coming back with no count of what it got is taken to have played what it had until it was last heard', async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }]], voice: { [A]: 2000 } })
  s.flux.said('Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000)
  s.ws.frame() // last heard 1000 ms into A
  s.at(1500)
  s.ws.drop()
  s.at(5000)
  s.back(undefined)
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  s.session.end()
  s.session.transcript.delete()
})

test('a page that does not come back: the session ends after the window, its lines settle as of the last frame heard, and the minutes follow', async () => {
  const s = start({ answers: [[{ kind: 'say', text: A }]], voice: { [A]: 2000 }, extra: { reconnectMs: 60 } })
  s.flux.said('Alex, when does the pilot run?')
  s.flux.said('We agreed the pilot starts in March.')
  await settle()
  s.at(PAGE_LEAD_MS + 1000)
  s.ws.frame()
  s.at(PAGE_LEAD_MS + 1900)
  s.ws.drop()
  await settle(30)
  assert.equal(s.over(), false, 'not before the window ends')
  await settle(100)
  assert.equal(s.over(), true)
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  assert.deepEqual(s.recall.left, [s.botId], 'the bot is asked to leave')
  assert.equal(s.ended()?.minutes_file, `/tmp/minutes-of-${s.botId}.md`)
  assert.equal(s.session.resumes(s.secret()), false, 'and no page comes back to it')
  assert.ok(fs.existsSync(s.session.transcript.file))
  s.session.transcript.delete()
})

test('Recall saying the bot has left after the page went ends the session at once, without leave_call; still in the call, it waits for the page', async () => {
  let answer!: (ending: BotEnding | null) => void
  const probes: AbortSignal[] = []
  const botLeftCall = (_id: string, { signal }: { signal?: AbortSignal } = {}) => {
    probes.push(signal!)
    return new Promise<BotEnding | null>(resolve => (answer = resolve))
  }
  const s = start({ botLeftCall })
  s.flux.said('We agreed the pilot starts in March.')
  s.ws.drop()
  assert.equal(probes.length, 1, 'Recall is asked as the page drops')
  answer({ kind: 'ended', sub_code: 'call_ended_by_host' })
  await settle()
  assert.equal(s.over(), true)
  assert.deepEqual(s.recall.left, [], 'not asked to leave: it has')
  assert.equal(s.recall.asked, 0, 'how it ended is known already')
  assert.ok(s.ended()?.minutes_file, 'a normal end, with minutes')
  s.session.transcript.delete()

  const t = start({ botLeftCall })
  t.ws.drop()
  answer(null)
  await settle()
  assert.equal(t.over(), false, 'still in the call: the session waits for its page')
  const page = t.back(0)
  assert.deepEqual(page.kinds(), ['ready', 'hearing'])
  page.drop()
  assert.equal(probes.length, 3, 'asked again at the next drop')
  t.back(0)
  assert.equal(probes[2].aborted, true, 'and no longer once the page is back')
  t.session.end()
  t.session.transcript.delete()
})

test('removed while the page is away (bot_kicked_from_call): the transcript and minutes go, and meeting_ended says removed', async () => {
  const s = start({ botLeftCall: async () => ({ kind: 'removed', sub_code: 'bot_kicked_from_call' }) })
  s.flux.said('We agreed the pilot starts in March.')
  const file = s.session.transcript.file
  assert.ok(fs.existsSync(file))
  s.ws.drop()
  await settle()
  assert.equal(s.over(), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(s.minutes(), 0)
  assert.match(s.ended()!.no_minutes!, /was removed from the meeting/)
  assert.deepEqual(s.recall.left, [])
})

test('"Alex, please leave" heard while the page is away: the transcript goes at once, no page is let back in, no goodbye, and the bot leaves', async () => {
  const s = start()
  s.flux.said('We agreed the pilot starts in March.')
  const file = s.session.transcript.file
  const rejoin = s.secret()
  s.ws.drop()
  s.flux.said('Alex, please leave.')
  assert.equal(fs.existsSync(file), false, 'at once')
  assert.equal(s.session.resumes(rejoin), false)
  await settle()
  assert.deepEqual(s.recall.left, [s.botId])
  assert.equal(s.over(), true)
  assert.deepEqual(s.spoken, [], 'nobody could hear a goodbye')
  assert.match(s.ended()!.no_minutes!, /asked to leave/)
  assert.equal(s.minutes(), 0)
})

test('a drop during the goodbye ends the session at once, as before, and no page is let back', async () => {
  let release = () => {}
  const speak = async function* (text: string) {
    yield Buffer.alloc(bytes(200))
    if (text === LEAVE_LINE) await new Promise<void>(r => (release = r))
  }
  const s = start({ speak })
  s.flux.said('Alex, please leave.')
  await settle()
  const rejoin = s.secret()
  s.ws.drop()
  assert.equal(s.session.resumes(rejoin), false)
  await settle(1)
  assert.equal(s.over(), true, 'at once')
  release()
  await settle()
  assert.deepEqual(s.recall.left, [s.botId])
})

test("the rejoin secret is 24 random bytes, the same in every 'ready', and resumes nothing once the session has ended; another session's never does", async () => {
  const s = start()
  const other = start()
  const rejoin = s.secret()
  assert.match(rejoin, /^[\w-]{32}$/)
  assert.notEqual(rejoin, other.secret())
  assert.equal(s.session.resumes(rejoin), true)
  assert.equal(s.session.resumes(other.secret()), false)
  assert.equal(s.session.resumes(`${rejoin}A`), false)
  s.ws.frame() // the page has had its 'ready': a page without the secret can't take its place now
  assert.equal(s.session.resumes(''), false)
  s.ws.drop()
  const page = s.back(0)
  assert.equal(page.controls()[0].rejoin, rejoin)
  s.session.end()
  assert.equal(s.session.resumes(rejoin), false)
  // A page let in all the same once it is over is told so.
  const late = new FakeSocket()
  s.session.attach(late as any, { got: 0 })
  assert.equal(late.closedWith, PAGE_CLOSE.over)
  assert.deepEqual(late.kinds(), [])
  other.session.end()
  s.session.transcript.delete()
  other.session.transcript.delete()
})

test("a page whose first 'ready' never reached it comes back without a secret, and takes over while no page has sent anything", async () => {
  const s = start()
  // The first connection was let in, but its 'ready' was lost: the page heard nothing, so it sends nothing and tries again.
  assert.equal(s.session.resumes(''), true)
  const page = new FakeSocket()
  s.session.attach(page as any, {})
  assert.equal(s.ws.terminated, true, 'the connection the page gave up on is let go')
  assert.equal(page.controls()[0].type, 'ready')
  assert.equal(page.controls()[0].rejoin, s.secret())
  // Once a page has sent something, only the secret lets one in.
  page.frame()
  assert.equal(s.session.resumes(''), false)
  assert.equal(s.session.resumes(s.secret()), true)
  s.session.end()
  s.session.transcript.delete()
})

test('the same page coming back while its old connection still looks open: the old one is let go, and its late close and audio change nothing', async () => {
  const s = start({ extra: { reconnectMs: 30, sttHoldMs: 10 } })
  const page = s.back(0)
  assert.equal(s.ws.terminated, true)
  await settle(60)
  assert.equal(s.over(), false, 'no window ran for it')
  assert.equal(s.flux.forced, 0)
  s.ws.emit('message', Buffer.alloc(2560), true)
  s.ws.emit('error', new Error('a late failure')) // listened to, so it takes nothing down
  assert.equal(s.flux.received, 0, "its audio doesn't reach speech recognition")
  page.frame()
  assert.equal(s.flux.received, 1)
  s.session.end()
  s.session.transcript.delete()
})

test('a turn in progress at the drop is held for a while, then ended on the words heard so far; a page back sooner keeps it open', async () => {
  const s = start({ extra: { sttHoldMs: 30 } })
  s.ws.drop()
  await settle(15)
  s.back(0)
  await settle(40)
  assert.equal(s.flux.forced, 0, 'the page came back within the hold')
  s.session.attach(new FakeSocket() as any, { got: 0 })
  const page = new FakeSocket()
  s.session.attach(page as any, { got: 0 })
  page.drop()
  await settle(50)
  assert.equal(s.flux.forced, 1)
  // Its words are kept, and not answered while the page is away.
  s.flux.said('Alex, what about the budget?')
  await settle()
  assert.deepEqual(s.answered, [])
  assert.deepEqual(s.session.transcript.lines.map(l => l.text), ['Alex, what about the budget?'])
  s.session.end()
  s.session.transcript.delete()
})

test('no timer of a page that is away fires once the session has ended or Alex is leaving', async () => {
  const s = start({ extra: { sttHoldMs: 20, reconnectMs: 40 } })
  s.ws.drop()
  s.session.end() // the server's window, or the service stopping
  assert.equal(s.recall.probes[0].aborted, true, 'Recall is no longer asked')
  await settle(80)
  assert.equal(s.flux.forced, 0)
  assert.deepEqual(s.recall.left, [s.botId], 'asked to leave once')

  const t = start({ extra: { sttHoldMs: 20 }, leaveCallMs: 100 })
  t.ws.drop()
  t.flux.said('Alex, please leave.')
  await settle(50) // while Recall takes the leave_call
  assert.equal(t.over(), false)
  assert.equal(t.flux.forced, 0, 'nothing more is transcribed once Alex is leaving')
  await settle(100)
  assert.equal(t.over(), true)
})

test("\"can't hear the meeting\" is sent again after 'ready' on return while speech recognition is still lost, and cleared once it is back", async () => {
  const s = start()
  s.flux.emit('lost', 'no stream to Deepgram for 5 s')
  assert.deepEqual(s.ws.controls().at(-1), { type: 'error', message: PAGE_ERRORS.hearing })
  s.ws.drop()
  const page = s.back(0)
  assert.deepEqual(page.controls().slice(0, 2).map(c => c.type), ['ready', 'error'])
  assert.deepEqual(page.controls()[1], { type: 'error', message: PAGE_ERRORS.hearing })
  s.flux.emit('open')
  assert.deepEqual(page.controls().at(-1), { type: 'hearing' })
  page.drop()
  const again = s.back(0)
  assert.deepEqual(again.kinds(), ['ready', 'hearing'], 'hearing again: no error, and any error the page still shows goes')
  s.session.end()
  s.session.transcript.delete()
})

test('end() closes an attached page with 4000, so it does not come back, and resolves over', async () => {
  const s = start()
  s.ws.drop()
  const page = s.back(0)
  assert.equal(s.over(), false)
  s.session.end()
  assert.equal(page.closedWith, PAGE_CLOSE.over)
  await settle()
  assert.equal(s.over(), true)
  assert.deepEqual(PAGE_CLOSE, { over: 4000, cannotStart: 4003 })
  s.session.transcript.delete()
})

test('without a window to come back in, the page going ends the session at once, as it always has', async () => {
  const s = start({ extra: { reconnectMs: 0 } })
  s.ws.drop()
  assert.equal(s.over(), false)
  await settle()
  assert.equal(s.over(), true)
  assert.equal(s.recall.probes.length, 0, 'Recall is asked how it ended, not whether')
  s.session.transcript.delete()
})

test('Update text never reaches the transcript, with the page there or away: only the words a turn ended on', async () => {
  const s = start()
  s.flux.turn('StartOfTurn', 'We')
  s.flux.turn('Update', 'We agreed the pilot')
  s.flux.said('We agreed the pilot starts in March.')
  s.ws.drop()
  s.flux.turn('StartOfTurn', 'And')
  s.flux.turn('Update', 'And the review is')
  s.flux.said('And the review is on Friday.')
  s.flux.turn('StartOfTurn', 'Bob')
  s.flux.turn('Update', 'Bob said the budget')
  s.back(0)
  assert.deepEqual(s.session.transcript.lines.map(l => l.text), ['We agreed the pilot starts in March.', 'And the review is on Friday.'])
  s.session.end()
  s.session.transcript.delete()
})

test("a page dropping and coming back logs nothing a meeting said, nor its key or the page's secret", async t => {
  const logged: string[] = []
  for (const name of ['log', 'warn', 'error', 'info'] as const) {
    t.mock.method(console, name, (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  }
  const s = start({
    answers: [[{ kind: 'say', text: A }]],
    voice: { [A]: 2000 },
    botLeftCall: async () => ({ kind: 'ended', sub_code: 'call_ended_by_host' }),
    extra: { sttHoldMs: 5, reconnectMs: 60_000 },
  })
  const rejoin = s.secret()
  s.flux.said('Alex, when does the pilot run in Lisbon?')
  await settle()
  s.flux.turn('StartOfTurn', 'Hold on')
  s.ws.drop()
  s.flux.turn('Update', 'Hold on, Lisbon budget')
  s.flux.said('Hold on, Lisbon budget is secret.')
  await settle()
  t.mock.restoreAll()
  assert.equal(s.over(), true)
  assert.ok(logged.length > 0)
  for (const line of logged) {
    for (const secret of ['Lisbon', 'pilot', 'March', rejoin, s.session.opts.meetingKey]) assert.ok(!line.includes(secret), `${secret} in: ${line}`)
  }
  s.session.transcript.delete()
})
