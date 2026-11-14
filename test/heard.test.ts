// The transcript says what the meeting heard of Alex: a line cut off keeps only the words the page had played, and a
// line it never got to goes. The clock the session follows the page's playback by is the test's, so the cuts are exact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { MeetingSession } from '../src/pipeline/session.ts'
import { PAGE_LEAD_MS } from '../src/pipeline/playback.ts'
import { JOIN_LINE } from '../src/consent.ts'
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
  // Like Flux: a turn starts once its first words are heard, and each event carries the turn so far.
  startTurn(text = 'Wait, what about') { this.emit('turn', { type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: text }) }
  update(text: string) { this.emit('turn', { type: 'TurnInfo', event: 'Update', turn_index: 1, transcript: text }) }
}

/** How the fake ElevenLabs says each line: this many ms of audio at once, then it ends, waits to be stopped, or fails. */
type Voice = Record<string, { ms: number; then?: 'end' | 'wait' | 'fail' }>

const A = 'The pilot starts in March and ends in May.' // 42 characters: "The pilot starts in" is the first 19
const B = 'The budget review is on Friday.'
const C = 'We expect the first results in the second week of April.' // 56 characters, reckoned at 3920 ms

let meetings = 0

/**
 * A session whose brain gives these answers in turn, with a clock the test moves (ms from the start). `asked` has the
 * transcript each answer was asked for with.
 */
function start(answers: BrainEvent[][], voice: Voice) {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  let now = 5_000_000
  const asked: string[] = []
  const meetingKey = `heard-${process.pid}-${++meetings}`
  const session = new MeetingSession(ws as any, { meetingKey }, {
    brain: {
      async *respond(input: { transcript: string }) {
        asked.push(input.transcript)
        for (const e of answers.shift() ?? []) yield e
      },
    } as any,
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
  return { ws, flux, session, alex, file, asked, at: (ms: number) => (now = 5_000_000 + ms) }
}

const settle = () => new Promise(r => setTimeout(r, 20))
async function until(ok: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !ok(); i++) await new Promise(r => setTimeout(r, 10))
}

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

test('talked over while ElevenLabs is still sending a line, the line keeps the words the page had played of it', async () => {
  const s = start([[{ kind: 'say', text: C }]], { [C]: { ms: 1960, then: 'wait' } })
  s.flux.endTurn('Alex, when are the first results?')
  await settle()
  s.at(PAGE_LEAD_MS + 980) // a quarter of the 3920 ms the line is reckoned to take, not half of the 1960 ms sent
  s.flux.startTurn()
  await settle()
  assert.ok(s.ws.cleared())
  assert.deepEqual(s.alex(), ['We expect the… (cut off)'])
  assert.match(s.file(), /Alex: We expect the… \(cut off\)\n$/)
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
  // The next answer is asked for with what the meeting heard, not with the line Alex meant to say.
  assert.match(s.asked[1], /\nAlex: We expect the first results… \(cut off\)\nSpeaker: Alex, and when is the budget review\?$/)
  s.session.transcript.delete()
})

test('a new question cuts only the line still going out: a line of the same answer that has all gone out stays whole', async () => {
  const s = start([[{ kind: 'say', text: B }, { kind: 'say', text: C }], [{ kind: 'say', text: A }]], {
    [B]: { ms: 1000 },
    [C]: { ms: 1960, then: 'wait' },
    [A]: { ms: 2000 },
  })
  s.flux.endTurn('Alex, what is coming up?')
  await settle()
  s.flux.endTurn('Alex, and when does the pilot run?')
  await settle()
  assert.deepEqual(s.alex(), [B, 'We expect the first results… (cut off)', A])
  assert.match(s.asked[1], /\nAlex: The budget review is on Friday\.\nAlex: We expect the first results… \(cut off\)\nSpeaker: /)
  s.session.transcript.delete()
})

test('when the page socket stops being open partway, the line keeps only the words of the audio that went out', async () => {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  let now = 11_000_000
  const session = new MeetingSession(ws as any, { meetingKey: `heard-closing-${process.pid}` }, {
    brain: { async *respond() { yield { kind: 'say', text: C } } } as any,
    bridge: { ask: async () => null, notify: () => {} } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* () {
      yield Buffer.alloc(1000 * 32)
      ws.readyState = 2 // the page is going: the rest of the line is not sent
      yield Buffer.alloc(2920 * 32)
    },
    greetDelayMs: 60_000,
    sttFlushMs: 0,
    clock: () => now,
  })
  const alex = () => session.transcript.lines.filter(l => l.role === 'agent').map(l => l.text)
  flux.endTurn('Alex, when are the first results?')
  await settle()
  // 1000 of the 3920 ms the line is reckoned to take went out: "We expect the" is 13 of its 56 characters.
  assert.deepEqual(alex(), ['We expect the… (cut off)'])
  now += PAGE_LEAD_MS + 1000 // the page played all it had, then went
  ws.emit('close')
  await settle()
  assert.deepEqual(alex(), ['We expect the… (cut off)'])
  session.transcript.delete()
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

test('the consent line queued behind an answer is said in full: it is protected until the page has played it, not until it went out', async () => {
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  const now = 13_000_000
  const session = new MeetingSession(ws as any, { meetingKey: `heard-queued-${process.pid}` }, {
    brain: { async *respond() { yield { kind: 'say', text: A } } } as any,
    bridge: { ask: async () => null, notify: () => {} } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* (text: string, signal?: AbortSignal) {
      if (text !== A) return yield Buffer.alloc(100 * 32) // the consent line, 100 ms of it here
      yield Buffer.alloc(300 * 32)
      if (!signal?.aborted) await new Promise(r => signal?.addEventListener('abort', r, { once: true }))
    },
    greetDelayMs: 50,
    sttFlushMs: 0,
    clock: () => now,
  })
  // Asked before Alex has greeted: the consent line then stops the answer, but not the page, which plays the 300 ms of
  // it that had gone out, and the consent line after that. It went out about 150 ms ago: by its own 100 ms it would be
  // over, but the page has a good 250 ms of it to go.
  flux.endTurn('Alex, when does the pilot run?')
  await new Promise(r => setTimeout(r, 200))
  flux.endTurn('Alex, never mind.')
  await settle()
  assert.equal(ws.cleared(), false, 'the page is not told to clear while it plays the consent line')
  assert.ok(session.transcript.lines.some(l => l.role === 'agent' && l.text === JOIN_LINE))
  session.transcript.delete()
})

test('a transcript that cannot be corrected (a full disk) does not stop the session from ending: the bot leaves, its media goes, and the owner hears the meeting ended', async t => {
  const write = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', function (file: fs.PathOrFileDescriptor, ...rest: unknown[]) {
    if (String(file).endsWith('.next')) {
      ;(write as Function).call(fs, file, 'part of the transcr')
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${String(file)}'`), { code: 'ENOSPC' })
    }
    return (write as Function).call(fs, file, ...rest)
  })
  const errors: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  const notified: { type: string }[] = []
  const left: string[] = []
  const deleted: string[] = []
  const minutes: string[] = []
  const ws = new FakeSocket()
  const flux = new FakeFlux()
  let now = 15_000_000
  const session = new MeetingSession(ws as any, { meetingKey: `heard-full-${process.pid}`, botId: `bot-heard-full-${process.pid}`, platform: 'Zoom' }, {
    brain: { async *respond() { yield { kind: 'say', text: A } } } as any,
    bridge: { ask: async () => null, notify: (e: { type: string }) => void notified.push(e) } as any,
    brief: () => '',
    flux: () => flux as any,
    speak: async function* () { yield Buffer.alloc(2000 * 32) },
    recall: {
      sendChat: async () => {},
      leaveCall: async (id: string) => void left.push(id),
      deleteMedia: async (id: string) => (deleted.push(id), true),
      howBotEnded: async () => ({ kind: 'ended', sub_code: 'call_ended_by_host' }) as const,
    },
    writeMinutes: async input => (minutes.push(input.transcript), '/tmp/minutes-of-the-full-disk-test.md'),
    greetDelayMs: 60_000,
    sttFlushMs: 0,
    clock: () => now,
  })
  flux.endTurn('Alex, when does the pilot run?')
  await settle()
  now += PAGE_LEAD_MS + 1000
  ws.emit('close') // the page went halfway through the answer
  await until(() => notified.some(e => e.type === 'meeting_ended'))
  assert.deepEqual(left, [session.botId])
  assert.deepEqual(deleted, [session.botId])
  assert.ok(notified.some(e => e.type === 'meeting_ended'))
  // The minutes go by what the meeting heard; the file, which could not be written again, keeps the whole line.
  assert.match(minutes[0], /Alex: The pilot starts in… \(cut off\)$/)
  assert.match(fs.readFileSync(session.transcript.file, 'utf8'), /Alex: The pilot starts in March and ends in May\.\n$/)
  assert.equal(fs.existsSync(`${session.transcript.file}.next`), false, 'no part of a copy is left beside it')
  // The log says what failed, never what was said, nor the file's name.
  assert.deepEqual(errors.filter(e => e.startsWith('[transcript]')), ['[transcript] could not correct a line in the transcript file: ENOSPC'])
  assert.equal(errors.some(e => /pilot|heard-full/.test(e)), false)
  session.transcript.delete()
})
