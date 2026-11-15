// A real meeting session with the speaker probe: what it tells the probe (times, word counts, the code word's index,
// never words), and when the probe's file is written: once the meeting's transcript is kept, after meeting_ended, and
// never for a meeting Alex was asked to leave or removed from.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrainEvent } from '../src/brain/brain.ts'
import type { ToSession } from '../src/bridge.ts'
import { MeetingSession, endSessions } from '../src/pipeline/session.ts'
import type { BotEnding } from '../src/recall.ts'
import { type ProbeTurn, SpeakerProbe } from '../src/speakers/probe.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
}

/** Flux, with the timing the probe asks of it: stream second s came in at 5,000,000 + s * 1000. */
class FakeFlux extends EventEmitter {
  closed = false
  send() {}
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  audioTime(seconds: number) {
    return 5_000_000 + seconds * 1000
  }
  streamSeconds() {
    return 12
  }
  turn(event: string, transcript: string, more: object = {}) {
    this.emit('turn', { type: 'TurnInfo', event, turn_index: 0, transcript, ...more })
  }
}

/** Notes every call the session makes of the probe. */
class SpyProbe {
  calls: [string, ...unknown[]][] = []
  turnStarted(rx: number) {
    this.calls.push(['turnStarted', rx])
  }
  fluxLag(ms: number) {
    this.calls.push(['fluxLag', ms])
  }
  turnEnded(t: ProbeTurn) {
    this.calls.push(['turnEnded', t])
  }
  agentAudio(from: number, until: number) {
    this.calls.push(['agentAudio', from, until])
  }
  agentStopped(at: number) {
    this.calls.push(['agentStopped', at])
  }
  discard() {
    this.calls.push(['discard'])
  }
  write(m: object) {
    this.calls.push(['write', m])
    return null
  }
  names() {
    return this.calls.map(c => c[0])
  }
}

const ended: BotEnding = { kind: 'ended', sub_code: 'call_ended_by_host' }
let meetings = 0
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms))
async function until(ok: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await settle(10)
}

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-probe-session-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function setup(
  o: {
    probe?: SpeakerProbe | SpyProbe
    how?: () => Promise<BotEnding>
    events?: BrainEvent[]
    speak?: (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer>
    meetingKey?: string
    clock?: () => number
  } = {},
) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const notified: ToSession[] = []
  const meetingKey = o.meetingKey ?? `probe-session-${process.pid}-${++meetings}`
  const session = new MeetingSession(
    ws as never,
    { meetingKey, botId: `bot-${meetingKey}`, platform: 'Zoom' },
    {
      brain: { async *respond() { for (const e of o.events ?? []) yield e } } as never,
      bridge: { notify: (m: ToSession) => void notified.push(m), ask: async () => null } as never,
      brief: () => '',
      flux: () => flux as never,
      speak: o.speak ?? (async function* () { yield Buffer.alloc(3200) }),
      recall: {
        sendChat: async () => {},
        leaveCall: async () => {},
        deleteMedia: async () => true,
        howBotEnded: o.how ?? (async () => ended),
      },
      writeMinutes: async () => Promise.reject(new Error('no minutes in these tests')),
      greetDelayMs: 60_000,
      sttFlushMs: 20,
      leaveDelayMs: 0,
      clock: o.clock,
      speakerProbe: o.probe as never,
    },
  )
  const endedEvent = () => notified.find(m => m.type === 'meeting_ended')
  return { ws, flux, session, notified, endedEvent, meetingKey }
}

test("the probe hears when each turn starts and ends, when its first and last word came in, how many words and its code word: never the words", async () => {
  const spy = new SpyProbe()
  let now = 7_000_000
  const { flux, session } = setup({ probe: spy, clock: () => now })
  flux.turn('StartOfTurn', 'Alpha')
  now += 100
  // Flux has had 12 s of the stream, and its window ends at 11.5 s: half a second behind.
  flux.turn('Update', 'Alpha here', { audio_window_end: '11.5' })
  now += 900
  // With word times: the first word's start and the last word's end, as numbers or text.
  const words = [{ word: 'Alpha', confidence: 0.9, start: 1.25, end: 1.5 }, { word: 'test', start: '3.5', end: '3.75' }]
  flux.turn('EndOfTurn', 'Alpha here is a test', { words, audio_window_start: 1, audio_window_end: '4' })
  // Without them (Flux documents only word and confidence): the turn's own audio window.
  flux.turn('StartOfTurn', 'Bravo')
  flux.turn('EndOfTurn', 'Bravo, okay.', { words: [{ word: 'Bravo', confidence: '0.8' }], audio_window_start: '6.0', audio_window_end: 8 })
  // An empty turn is no turn; an Update with no window says nothing.
  flux.turn('EndOfTurn', '')
  flux.turn('Update', 'hm')
  assert.deepEqual(spy.calls, [
    ['turnStarted', 7_000_000],
    ['fluxLag', 500],
    ['turnEnded', { rx: 7_001_000, first: 5_001_250, last: 5_003_750, words: 5, wordTimes: true, codeword: 0 }],
    ['turnStarted', 7_001_000],
    ['turnEnded', { rx: 7_001_000, first: 5_006_000, last: 5_008_000, words: 2, wordTimes: false, codeword: 1 }],
  ])
  for (const word of ['here', 'test', 'okay', 'Alpha', 'Bravo']) assert.ok(!JSON.stringify(spy.calls).includes(word), word)
  session.transcript.delete()
})

test("the probe hears when Alex's voice plays, and when it stops: cleared, or paused and played on", async () => {
  const spy = new SpyProbe()
  const slow = async function* (_text: string, signal?: AbortSignal) {
    for (let i = 0; i < 40 && !signal?.aborted; i++) {
      yield Buffer.alloc(3200)
      await settle(15)
    }
  }
  const { flux, session } = setup({ probe: spy, events: [{ kind: 'say', text: 'A long answer about the rollout.' }], speak: slow })
  flux.turn('EndOfTurn', 'Alex, tell me about the rollout')
  await until(() => spy.names().includes('agentAudio'))
  const audio = spy.calls.find(c => c[0] === 'agentAudio')!
  assert.ok((audio[2] as number) > (audio[1] as number), 'until when it plays, after now')
  // Talked over with words: cleared.
  const before = spy.calls.length
  flux.turn('StartOfTurn', 'Wait, hold on a second')
  assert.ok(spy.names().slice(before).includes('agentStopped'), spy.names().join())
  session.end()
  await settle()
  session.transcript.delete()
})

test('a pause for a cough is an end of Alex\'s voice for the probe, and playing on after it is its voice again', async () => {
  const spy = new SpyProbe()
  // Two seconds of voice, all at once: the page plays on after it has all gone out.
  const fast = async function* () {
    yield Buffer.alloc(64_000)
  }
  const { flux, session } = setup({ probe: spy, events: [{ kind: 'say', text: 'A short answer.' }], speak: fast })
  flux.turn('EndOfTurn', 'Alex, what is the plan?')
  await until(() => spy.names().includes('agentAudio'))
  await settle()
  flux.turn('StartOfTurn', 'mm')
  assert.equal(spy.names().at(-1), 'agentStopped')
  flux.turn('EndOfTurn', 'mm-hm')
  assert.equal(spy.names().at(-1), 'agentAudio', spy.names().join())
  const [, from, playsUntil] = spy.calls.at(-1) as [string, number, number]
  assert.ok(playsUntil > from, 'it plays on from where it paused')
  session.end()
  await settle()
  session.transcript.delete()
})

test('"Alex, please leave" discards what the probe measured, tells it nothing more, and never writes its file', async () => {
  const spy = new SpyProbe()
  const { flux, session, endedEvent } = setup({ probe: spy })
  flux.turn('StartOfTurn', 'Alex')
  flux.turn('EndOfTurn', 'Alex, please leave the meeting.')
  await until(() => spy.names().includes('discard'))
  assert.ok(spy.names().includes('discard'), 'what it measured goes, and Recall\'s connection with it')
  const after = spy.calls.length
  // Nothing more: no turn, no Alex audio for the goodbye.
  flux.turn('StartOfTurn', 'Bravo')
  flux.turn('EndOfTurn', 'Bravo, one more thing')
  await until(() => endedEvent() !== undefined)
  await settle()
  assert.deepEqual(spy.names().slice(after), [], spy.names().join())
  assert.ok(!spy.names().includes('write'))
  assert.equal(session.leftMeeting, true)
})

test("a meeting that ends normally writes the probe's file after meeting_ended, readable by you only, named as its transcript; a later \"please leave\" deletes it", async t => {
  const dir = tempDir(t)
  const probe = new SpeakerProbe({ platform: 'zoom', botName: "Alex (Sam's AI assistant)", dir })
  const { flux, session, notified, meetingKey } = setup({ probe })
  flux.turn('StartOfTurn', 'Alpha')
  flux.turn('EndOfTurn', 'Alpha here, about the plan.', { audio_window_start: 1, audio_window_end: 3 })
  const file = path.join(dir, `${path.basename(session.transcript.file, '.md')}.json`)
  let thereAtEnd: boolean | null = null
  let thereJustAfter: boolean | null = null
  const notify = notified.push.bind(notified)
  notified.push = (...m: ToSession[]) => {
    if (m[0].type === 'meeting_ended') {
      thereAtEnd = fs.existsSync(file)
      queueMicrotask(() => (thereJustAfter = fs.existsSync(file)))
    }
    return notify(...m)
  }
  session.end()
  await until(() => fs.existsSync(file))
  assert.equal(thereAtEnd, false, 'written after meeting_ended went out, not before')
  assert.equal(thereJustAfter, false, 'and in a turn of its own, not in the one that sent it')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.ending, 'ended')
  assert.equal(written.flux.turns, 1)
  assert.equal(written.flux.timed, 1)

  // The meeting's page comes back as a new session, where someone asks Alex to leave: the file goes with the transcript.
  const later = setup({ meetingKey })
  later.flux.turn('EndOfTurn', 'Alex, please leave.')
  await until(() => !fs.existsSync(file))
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(session.transcript.file), false)
})

test('a removal Recall confirms as the meeting ends writes no file; an ending it cannot confirm, or the service stopping, keeps one that says so', async t => {
  const dir = tempDir(t)
  const make = () => new SpeakerProbe({ platform: 'google_meet', botName: "Alex (Sam's AI assistant)", dir })

  const removed = setup({ probe: make(), how: async () => ({ kind: 'removed', sub_code: 'bot_kicked_from_call' }) })
  removed.flux.turn('EndOfTurn', 'Alpha here.')
  removed.session.end()
  await until(() => removed.endedEvent() !== undefined)
  await settle()
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing for a meeting Alex was removed from')

  const unknown = setup({ probe: make(), how: async () => ({ kind: 'unknown', why: 'Recall could not be read' }) })
  unknown.flux.turn('EndOfTurn', 'Alpha here.')
  unknown.session.end()
  const unconfirmed = path.join(dir, `${path.basename(unknown.session.transcript.file, '.md')}.json`)
  await until(() => fs.existsSync(unconfirmed))
  assert.equal(JSON.parse(fs.readFileSync(unconfirmed, 'utf8')).ending, 'unconfirmed')

  // The service stops: Recall never answers, and meeting_ended goes out at the bound.
  const stopping = setup({ probe: make(), how: () => new Promise(() => {}) })
  stopping.flux.turn('EndOfTurn', 'Alpha here.')
  await endSessions([stopping.session], 50)
  const stopped = path.join(dir, `${path.basename(stopping.session.transcript.file, '.md')}.json`)
  await until(() => fs.existsSync(stopped))
  assert.equal(JSON.parse(fs.readFileSync(stopped, 'utf8')).ending, 'stopped')
  for (const s of [unknown, stopping]) s.session.transcript.delete()
})

test('with two sessions of one meeting, only the last to end writes the file', async t => {
  const dir = tempDir(t)
  const probe = new SpeakerProbe({ platform: 'zoom', botName: "Alex (Sam's AI assistant)", dir })
  const first = setup({ probe })
  const second = setup({ probe, meetingKey: first.meetingKey })
  first.flux.turn('EndOfTurn', 'Alpha here.')
  first.session.end()
  await until(() => first.endedEvent() !== undefined)
  await settle()
  assert.deepEqual(fs.readdirSync(dir), [], 'the meeting goes on in the other session')
  second.session.end()
  await until(() => fs.readdirSync(dir).length > 0)
  assert.deepEqual(fs.readdirSync(dir), [`${path.basename(second.session.transcript.file, '.md')}.json`])
  for (const s of [first, second]) s.session.transcript.delete()
})
