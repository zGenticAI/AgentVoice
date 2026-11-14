// Talking over Alex: the page pauses at once, then Alex stops for words, or carries on for a cough, a laugh or "mm-hm".
// The page's playback is followed by a clock the test moves, so what the transcript keeps of a line is exact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingSession } from '../src/pipeline/session.ts'
import { PAGE_LEAD_MS } from '../src/pipeline/playback.ts'
import { CHECKING_LINE, JOIN_LINE } from '../src/consent.ts'
import type { BrainEvent } from '../src/brain/brain.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  controls() { return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d as string)).filter(c => c.type !== 'speaking' && c.type !== 'ready') }
  kinds() { return this.controls().map(c => c.type) }
  audio() { return this.sent.filter(d => typeof d !== 'string') }
}

// Like Flux: each event carries the turn so far.
class FakeFlux extends EventEmitter {
  closed = false
  send() {}
  close() { if (!this.closed) { this.closed = true; setImmediate(() => this.emit('close', 1005, '')) } }
  turn(event: string, transcript: string) { this.emit('turn', { type: 'TurnInfo', event, turn_index: 0, transcript }) }
}

// 42 letters, and 48, the second ending on a question: both said in the time the tests give them.
const A = 'The pilot starts in March and ends in May.'
const Q = 'It ships in March. Shall I go through the steps?'
let n = 0

/**
 * A session whose brain says answers[n] to the n-th question, and whose voice for a line is voice[line] ms of audio
 * (100 unless given), sent all at once. The page's clock starts at 0 (see at). No consent line unless a test asks.
 */
function start(answers: BrainEvent[][], voice: Record<string, number>, extra: Record<string, unknown> = {}, key = `talk-over-${process.pid}-${++n}`) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  let now = 5_000_000
  const answered: string[] = []
  const session = new MeetingSession(ws as any, { meetingKey: key }, {
    brain: { async *respond(i: { latest: string }) { answered.push(i.latest); for (const e of answers.shift() ?? []) yield e } } as any,
    bridge: { ask: async () => null, notify: () => {} } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* (text: string) { yield Buffer.alloc((voice[text] ?? 100) * 32) },
    greetDelayMs: 60_000, sttFlushMs: 0, leaveDelayMs: 0, pauseMaxMs: 60_000,
    clock: () => now,
    ...extra,
  })
  const alex = () => session.transcript.lines.filter(l => l.role === 'agent').map(l => l.text)
  return { ws, flux, session, alex, answered, at: (ms: number) => (now = 5_000_000 + ms) }
}
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))

test('a cough heard as "Uh" pauses the page; the turn ending with nothing that counts resumes it, and the line is heard whole', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 500)
  s.flux.turn('StartOfTurn', 'Uh')
  assert.deepEqual(s.ws.kinds(), ['pause'])
  s.at(PAGE_LEAD_MS + 900)
  s.flux.turn('EndOfTurn', 'Uh.')
  assert.deepEqual(s.ws.kinds(), ['pause', 'resume'])
  s.at(5000)
  s.flux.turn('EndOfTurn', 'Alex, never mind.')
  await settle()
  assert.deepEqual(s.alex(), [A])
  s.session.transcript.delete()
})

test('a StartOfTurn with no words yet (Flux always sends one) pauses, like any unsure start', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(500)
  s.flux.turn('StartOfTurn', '')
  s.flux.turn('EndOfTurn', 'Mm.')
  assert.deepEqual(s.ws.kinds(), ['pause', 'resume'])
  s.session.transcript.delete()
})

test('"Yes, go ahead" said over the end of an answer that asks something pauses it, resumes it, and is the reply', async () => {
  const s = start([[{ kind: 'say', text: Q }], [{ kind: 'say', text: 'Step one.' }]], { [Q]: 3000 })
  s.flux.turn('EndOfTurn', 'Alex, when does it ship?')
  await settle() // all of it has gone out, which opens the reply window; the page plays it until 3050
  s.at(2500)
  s.flux.turn('StartOfTurn', 'Yes')
  s.at(2700)
  s.flux.turn('EndOfTurn', 'Yes, go ahead.')
  await settle()
  assert.deepEqual(s.ws.kinds(), ['pause', 'resume'])
  assert.deepEqual(s.answered, ['Alex, when does it ship?', 'Yes, go ahead.'], 'a sound of agreement can be the reply')
  assert.deepEqual(s.alex(), [Q, 'Step one.'])
  s.session.transcript.delete()
})

test('"Yes please" said over the end of an answer that asks something stops it there, and is still the reply', async () => {
  const s = start([[{ kind: 'say', text: Q }], [{ kind: 'say', text: 'Step one.' }]], { [Q]: 3000 })
  s.flux.turn('EndOfTurn', 'Alex, when does it ship?')
  await settle()
  s.at(2500)
  s.flux.turn('StartOfTurn', 'Yes')
  s.at(2700)
  s.flux.turn('EndOfTurn', 'Yes please.')
  await settle()
  assert.deepEqual(s.ws.kinds(), ['pause', 'clear'])
  assert.deepEqual(s.answered, ['Alex, when does it ship?', 'Yes please.'], 'stopping Alex leaves the reply window open')
  // Cut where the page paused (2450 of 3000 ms played), not where it was cleared.
  assert.deepEqual(s.alex(), ['It ships in March. Shall I go through… (cut off)', 'Step one.'])
  s.session.transcript.delete()
})

test('speech starting in the last moments of an answer lets it finish, and is the reply to its question', async () => {
  const s = start([[{ kind: 'say', text: Q }], []], { [Q]: 3000 })
  s.flux.turn('EndOfTurn', 'Alex, when does it ship?')
  await settle()
  s.at(PAGE_LEAD_MS + 3000 - 300)
  s.flux.turn('StartOfTurn', 'Yes please go')
  s.flux.turn('EndOfTurn', 'Yes please, go ahead.')
  await settle()
  assert.deepEqual(s.ws.kinds(), [])
  assert.deepEqual(s.answered, ['Alex, when does it ship?', 'Yes please, go ahead.'])
  assert.deepEqual(s.alex(), [Q])
  s.session.transcript.delete()
})

test('two words that count stop Alex, and the line keeps what was heard up to the pause, not up to the clear', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 }, { pauseMaxMs: 30 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000)
  s.flux.turn('StartOfTurn', 'Yeah')
  s.at(PAGE_LEAD_MS + 1600)
  s.flux.turn('Update', 'Yeah but what')
  assert.deepEqual(s.ws.kinds(), ['pause', 'clear'])
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  await settle(60)
  assert.deepEqual(s.ws.kinds(), ['pause', 'clear'], 'no resume after a stop')
  s.session.transcript.delete()
})

test('two words that count as the turn starts stop Alex without a pause', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000)
  s.flux.turn('StartOfTurn', 'Hold on')
  assert.deepEqual(s.ws.kinds(), ['clear'])
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  s.session.transcript.delete()
})

test('one word that counts keeps the page paused, and stops Alex when the turn ends on it', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(500)
  s.flux.turn('StartOfTurn', 'Wait')
  s.flux.turn('Update', 'Wait')
  assert.deepEqual(s.ws.kinds(), ['pause'])
  s.flux.turn('EndOfTurn', 'Wait.')
  assert.deepEqual(s.ws.kinds(), ['pause', 'clear'])
  s.session.transcript.delete()
})

test('with no words that count, the page resumes after the wait, and words that count later in the turn still stop it', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 }, { pauseMaxMs: 30 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 500)
  s.flux.turn('StartOfTurn', 'So')
  await settle(60)
  assert.deepEqual(s.ws.kinds(), ['pause', 'resume'])
  s.flux.turn('Update', 'So what about')
  assert.deepEqual(s.ws.kinds(), ['pause', 'resume', 'clear'])
  s.session.transcript.delete()
})

test('while paused, the rest of the answer still goes out and the page holds it, and the line counts it once resumed', async () => {
  let release = () => {}
  const quarter = Buffer.alloc(500 * 32)
  // A's voice in four pieces of 500 ms: the first, then the rest once the test lets them go.
  const speak = async function* () {
    yield quarter
    await new Promise<void>(r => (release = r))
    yield quarter
    yield quarter
    yield quarter
  }
  const s = start([[{ kind: 'say', text: A }]], {}, { speak })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle() // the first piece plays from 50 to 550
  s.at(300)
  s.flux.turn('StartOfTurn', 'Uh') // 250 ms played; the page holds 250
  release()
  await settle()
  assert.equal(s.ws.audio().length, 4, 'the answer went on going out while paused')
  s.at(1000)
  s.flux.turn('EndOfTurn', 'Uh.') // the page plays the 1750 ms it holds from 1050 to 2800
  s.at(1800)
  s.flux.turn('StartOfTurn', 'Alex')
  s.flux.turn('EndOfTurn', 'Alex, never mind.') // 250 + 750 of 2000 ms played
  await settle()
  assert.deepEqual(s.ws.kinds(), ['pause', 'resume', 'pause', 'clear', 'clear'])
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  assert.equal(s.ws.audio().length, 4)
  s.session.transcript.delete()
})

test('"Alex?" as the speech that paused Alex stops him, and the next line goes to him', async () => {
  const s = start([[{ kind: 'say', text: A }], [{ kind: 'say', text: 'Friday.' }]], { [A]: 2000 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(500)
  s.flux.turn('StartOfTurn', 'Alex')
  s.flux.turn('EndOfTurn', 'Alex?')
  assert.deepEqual(s.ws.kinds(), ['pause', 'clear'])
  s.flux.turn('EndOfTurn', 'When is the review?')
  await settle()
  assert.deepEqual(s.answered, ['Alex, when does the pilot run?', 'When is the review?'])
  s.session.transcript.delete()
})

test('a new question as the speech that stopped Alex is answered, with the transcript cut at the pause', async () => {
  const s = start([[{ kind: 'say', text: A }], [{ kind: 'say', text: 'Friday.' }]], { [A]: 2000 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000)
  s.flux.turn('StartOfTurn', 'Alex')
  s.at(PAGE_LEAD_MS + 1800)
  s.flux.turn('EndOfTurn', 'Alex, when is the review?')
  await settle()
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)', 'Friday.'])
  s.session.transcript.delete()
})

test('talked over while the page still plays the checking line, Alex stops waiting for the owner\'s session', async () => {
  let gaveUp = false
  const ask = (_q: unknown, _ms: unknown, signal: AbortSignal) =>
    new Promise(resolve => signal.addEventListener('abort', () => ((gaveUp = true), resolve(null))))
  const s = start([[{ kind: 'ask_session', question: 'What did the board decide?' }]], { [CHECKING_LINE]: 1500 }, {
    bridge: { ask, notify: () => {} },
  })
  s.flux.turn('EndOfTurn', 'Alex, what did the board decide?')
  await settle() // the checking line has all gone out, and the page plays it until 1550
  assert.equal(gaveUp, false)
  s.at(1000)
  s.flux.turn('StartOfTurn', 'Hold on what')
  await settle()
  assert.equal(gaveUp, true)
  assert.deepEqual(s.ws.kinds(), ['clear'])
  s.session.transcript.delete()
})

test('the consent line is never paused or stopped, whatever is said over it', async () => {
  const s = start([], { [JOIN_LINE]: 3000 }, { greetDelayMs: 0 })
  await settle()
  s.at(500)
  s.flux.turn('StartOfTurn', 'Uh')
  s.flux.turn('Update', 'Hold on what')
  s.flux.turn('EndOfTurn', 'Hold on, what is this?')
  await settle()
  assert.deepEqual(s.ws.kinds(), [])
  s.session.transcript.delete()
})

test('a pause under way when the consent line is due ends first, so the consent line never waits behind a paused page', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000, [JOIN_LINE]: 3000 }, { greetDelayMs: 40 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle(10)
  s.at(500)
  s.flux.turn('StartOfTurn', 'Uh')
  await settle(80)
  const sent = s.ws.sent.map(d => (typeof d === 'string' ? JSON.parse(d).type : 'audio')).filter(k => k !== 'speaking' && k !== 'ready')
  assert.deepEqual(sent, ['audio', 'pause', 'resume', 'audio'])
  s.session.transcript.delete()
})

test('"Alex, please leave" as the speech that paused Alex: he leaves, nothing is kept, and the goodbye is not paused', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(500)
  s.flux.turn('StartOfTurn', 'Alex')
  s.flux.turn('EndOfTurn', 'Alex, please leave.')
  await settle()
  s.flux.turn('StartOfTurn', 'Bye')
  await settle()
  assert.deepEqual(s.ws.kinds().filter(k => k !== 'clear'), ['pause'])
  assert.deepEqual(s.session.transcript.lines, [])
})

test('a leave heard by another session of the meeting ends a pause in this one, and no resume follows', async () => {
  const key = `talk-over-${process.pid}-${++n}`
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 }, { pauseMaxMs: 30 }, key)
  const other = start([], {}, {}, key)
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(500)
  s.flux.turn('StartOfTurn', 'Uh')
  other.flux.turn('EndOfTurn', 'Alex, please leave.')
  await settle(60)
  assert.deepEqual(s.ws.kinds(), ['pause', 'clear'])
})

test('the page going while paused: the line keeps what was heard up to the pause, and no resume is sent later', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 }, { pauseMaxMs: 20 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000)
  s.flux.turn('StartOfTurn', 'Uh')
  s.at(PAGE_LEAD_MS + 1900)
  s.ws.emit('close')
  await settle(50)
  assert.deepEqual(s.ws.kinds(), ['pause'])
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  s.session.transcript.delete()
})

test('speech heard once the page has started to go pauses nothing, so the line keeps what the page played until it went', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 }, { pauseMaxMs: 20 })
  s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
  await settle()
  s.ws.readyState = 2 // closing: no pause can reach the page now
  s.at(PAGE_LEAD_MS + 450)
  s.flux.turn('StartOfTurn', 'Uh')
  s.flux.turn('Update', 'Uh')
  s.at(PAGE_LEAD_MS + 1450)
  s.ws.readyState = 3
  s.ws.emit('close')
  await settle(50)
  assert.deepEqual(s.alex(), ['The pilot starts in March and… (cut off)'])
  s.session.transcript.delete()
})

test('pausing, resuming and stopping log nothing a meeting said', async () => {
  const logged: unknown[][] = []
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  for (const name of ['log', 'error', 'warn', 'info'] as const) console[name] = (...args: unknown[]) => void logged.push(args)
  try {
    const s = start([[{ kind: 'say', text: A }]], { [A]: 2000 }, { pauseMaxMs: 20 })
    s.flux.turn('EndOfTurn', 'Alex, when does the pilot run?')
    await settle()
    s.at(300)
    s.flux.turn('StartOfTurn', 'Uh')
    await settle(40)
    s.flux.turn('EndOfTurn', 'Uh huh.')
    s.at(600)
    s.flux.turn('StartOfTurn', 'Hmm')
    s.flux.turn('Update', 'Hmm hold on what')
    s.flux.turn('EndOfTurn', 'Hmm, hold on, what about April?')
    await settle()
    assert.deepEqual(s.ws.kinds(), ['pause', 'resume', 'pause', 'clear'])
    s.session.transcript.delete()
  } finally {
    Object.assign(console, saved)
  }
  assert.deepEqual(logged, [])
})
