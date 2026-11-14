// The transcript says what the meeting heard of Alex: a line cut off keeps only the words the page had played, and a
// line it never got to goes. The clock the session follows the page's playback by is the test's, so the cuts are exact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { MeetingSession } from '../src/pipeline/session.ts'
import { PAGE_LEAD_MS } from '../src/pipeline/playback.ts'
import type { BrainEvent } from '../src/brain/brain.ts'

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  controls() { return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d as string)) }
  cleared() { return this.controls().some(c => c.type === 'clear') }
}

class FakeFlux extends EventEmitter {
  closed = false
  send() {}
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', 1000, ''))
  }
  endTurn(text: string) { this.emit('turn', { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: text }) }
  startTurn() { this.emit('turn', { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: '' }) }
}

/** How the fake ElevenLabs says each line: this many ms of audio at once, then it ends, waits to be stopped, or fails. */
type Voice = Record<string, { ms: number; then?: 'end' | 'wait' | 'fail' }>

const A = 'The pilot starts in March and ends in May.' // 42 characters: "The pilot starts in" is the first 19
const B = 'The budget review is on Friday.'
const C = 'We expect the first results in the second week of April.' // 56 characters, reckoned at 3920 ms

let meetings = 0

/** A session whose brain gives these answers in turn, with a clock the test moves (ms from the start). */
function start(answers: BrainEvent[][], voice: Voice) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  let now = 5_000_000
  const meetingKey = `heard-${process.pid}-${++meetings}`
  const session = new MeetingSession(ws as any, { meetingKey }, {
    brain: { async *respond() { for (const e of answers.shift() ?? []) yield e } } as any,
    bridge: { ask: async () => null, notify: () => {} } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* (text: string, signal?: AbortSignal) {
      const how = voice[text] ?? { ms: 100 }
      if (how.ms) yield Buffer.alloc(how.ms * 32) // 16 kHz, 16-bit: 32 bytes a millisecond
      if (how.then === 'wait' && !signal?.aborted) await new Promise(r => signal?.addEventListener('abort', r, { once: true }))
      if (how.then === 'fail') throw new Error('ElevenLabs 500')
    },
    greetDelayMs: 60_000,
    sttFlushMs: 0,
    leaveDelayMs: 0,
    clock: () => now,
  })
  const alex = () => session.transcript.lines.filter(l => l.role === 'agent').map(l => l.text)
  const file = () => (fs.existsSync(session.transcript.file) ? fs.readFileSync(session.transcript.file, 'utf8') : '')
  return { ws, flux, session, alex, file, at: (ms: number) => (now = 5_000_000 + ms) }
}

const settle = () => new Promise(r => setTimeout(r, 20))

test('talked over, a line keeps the words the page had played, and the line queued behind it goes', async () => {
  // A has all gone out (2 s of it); B is still being made when someone talks over Alex.
  const s = start([[{ kind: 'say', text: A }, { kind: 'say', text: B }]], { [A]: { ms: 2000 }, [B]: { ms: 1000, then: 'wait' } })
  s.flux.endTurn('Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000) // half of A has played
  s.flux.startTurn()
  await settle()
  assert.ok(s.ws.cleared())
  assert.deepEqual(s.alex(), ['The pilot starts in… (cut off)'])
  assert.match(s.file(), /\] Speaker: Alex, when does the pilot run\?\n\[[\d:]+\] Alex: The pilot starts in… \(cut off\)\n$/)
  assert.doesNotMatch(s.file(), /budget/)
  assert.match(s.session.transcript.recent(), /Alex: The pilot starts in… \(cut off\)$/)
  s.session.transcript.delete()
})

test('a line the page had played to the end stays whole when the next one is cut', async () => {
  const s = start([[{ kind: 'say', text: B }, { kind: 'say', text: A }, { kind: 'say', text: 'And one more thing.' }]], {
    [B]: { ms: 1000 },
    [A]: { ms: 2000 },
    'And one more thing.': { ms: 0, then: 'wait' },
  })
  s.flux.endTurn('Alex, what is coming up?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000 + 1000) // B played, then half of A
  s.flux.startTurn()
  await settle()
  assert.deepEqual(s.alex(), [B, 'The pilot starts in… (cut off)'])
  s.session.transcript.delete()
})

test('"Alex, never mind" while the page still plays an answer that has all gone out cuts it where the page was', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: { ms: 2000 } })
  s.flux.endTurn('Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 500) // a quarter: "The pilot" is the first 9 of its 42 characters
  s.flux.endTurn('Alex, never mind.')
  await settle()
  assert.ok(s.ws.cleared())
  assert.deepEqual(s.alex(), ['The pilot… (cut off)'])
  assert.match(s.file(), /Alex: The pilot… \(cut off\)\n\[[\d:]+\] Speaker: Alex, never mind\.\n$/)
  s.session.transcript.delete()
})

test('"Alex, never mind" after the page has played the answer to the end changes nothing in the transcript', async () => {
  const s = start([[{ kind: 'say', text: A }]], { [A]: { ms: 2000 } })
  s.flux.endTurn('Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 2500)
  s.flux.endTurn('Alex, never mind.')
  await settle()
  assert.deepEqual(s.alex(), [A])
  s.session.transcript.delete()
})

test('when ElevenLabs fails partway, the line keeps only the words its audio got to', async () => {
  const s = start([[{ kind: 'say', text: C }]], { [C]: { ms: 1960, then: 'fail' } })
  s.flux.endTurn('Alex, when are the first results?')
  await settle()
  // Half of the 3920 ms the line is reckoned to take went out, and the page plays all of that.
  assert.deepEqual(s.alex(), ['We expect the first results… (cut off)'])
  assert.ok(s.ws.controls().some(c => c.type === 'error'), 'the page says the answer failed')
  assert.equal(s.ws.cleared(), false)
  s.session.transcript.delete()
})

test('when ElevenLabs fails before any audio, the line goes: nobody heard it', async () => {
  const s = start([[{ kind: 'say', text: C }]], { [C]: { ms: 0, then: 'fail' } })
  s.flux.endTurn('Alex, when are the first results?')
  await settle()
  assert.deepEqual(s.alex(), [])
  assert.doesNotMatch(s.file(), /Alex:/)
  s.session.transcript.delete()
})

test('a new question stops the answer without clearing the page: the answer keeps what had gone out, and then the next', async () => {
  const s = start([[{ kind: 'say', text: C }], [{ kind: 'say', text: B }]], { [C]: { ms: 1960, then: 'wait' }, [B]: { ms: 1000 } })
  s.flux.endTurn('Alex, when are the first results?')
  await settle()
  s.flux.endTurn('Alex, and when is the budget review?')
  await settle()
  assert.equal(s.ws.cleared(), false, 'the page plays out what it had')
  assert.deepEqual(s.alex(), ['We expect the first results… (cut off)', B])
  s.session.transcript.delete()
})

test('when the page goes, what it had not played was not heard: the minutes are written from the cut transcript', async () => {
  const minutes: string[] = []
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  let now = 7_000_000
  const session = new MeetingSession(ws as any, { meetingKey: `heard-end-${process.pid}`, botId: `bot-heard-end-${process.pid}`, platform: 'Zoom' }, {
    brain: { async *respond() { yield { kind: 'say', text: A } } } as any,
    bridge: { ask: async () => null, notify: () => {} } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* () { yield Buffer.alloc(2000 * 32) },
    recall: {
      sendChat: async () => {},
      leaveCall: async () => {},
      deleteMedia: async () => true,
      howBotEnded: async () => ({ kind: 'ended', sub_code: 'call_ended_by_host' }) as const,
    },
    writeMinutes: async input => (minutes.push(input.transcript), '/tmp/minutes-of-the-heard-test.md'),
    greetDelayMs: 60_000,
    sttFlushMs: 0,
    clock: () => now,
  })
  flux.endTurn('Alex, when does the pilot run?')
  await settle()
  now += PAGE_LEAD_MS + 1000
  ws.emit('close') // the host ended the meeting for everyone
  await settle()
  assert.equal(minutes.length, 1)
  assert.match(minutes[0], /Alex: The pilot starts in… \(cut off\)$/)
  assert.match(fs.readFileSync(session.transcript.file, 'utf8'), /Alex: The pilot starts in… \(cut off\)\n$/)
  session.transcript.delete()
})

test('the consent line is never cut: talking over it does not stop it, so the transcript keeps it whole', async () => {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  let now = 9_000_000
  const session = new MeetingSession(ws as any, { meetingKey: `heard-consent-${process.pid}` }, {
    brain: { async *respond() {} } as any,
    bridge: { ask: async () => null, notify: () => {} } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* () { yield Buffer.alloc(3000 * 32) },
    greetDelayMs: 0,
    clock: () => now,
  })
  await settle()
  now += 500
  flux.startTurn()
  await settle()
  assert.equal(ws.controls().some(c => c.type === 'clear'), false)
  const said = session.transcript.lines.filter(l => l.role === 'agent').map(l => l.text)
  assert.equal(said.length, 1)
  assert.doesNotMatch(said[0], /cut off/)
  session.transcript.delete()
})

test('after "Alex, please leave" the transcript is gone, and nothing about the cut line brings it back', async () => {
  const s = start([[{ kind: 'say', text: A }, { kind: 'say', text: B }]], { [A]: { ms: 2000 }, [B]: { ms: 1000, then: 'wait' } })
  s.flux.endTurn('Alex, when does the pilot run?')
  await settle()
  s.at(PAGE_LEAD_MS + 1000)
  s.flux.endTurn('Alex, please leave.')
  await settle()
  assert.equal(fs.existsSync(s.session.transcript.file), false)
  assert.equal(fs.existsSync(`${s.session.transcript.file}.next`), false)
  assert.deepEqual(s.session.transcript.lines, [])
})
