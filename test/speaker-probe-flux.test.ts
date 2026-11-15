// The speaker probe's timing from speech recognition: with trackAudio, FluxStream says when the audio at a point of its
// stream came in, so a turn's first and last word can be lined up with Recall's events. Without it, nothing is kept.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { type FluxSocket, FluxStream, type TurnInfo } from '../src/pipeline/deepgram.ts'

process.env.DEEPGRAM_API_KEY = 'dg-key-never-in-the-log'

/** One socket to a fake Deepgram. */
class FakeDeepgram extends EventEmitter {
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) {
    this.sent.push(data)
  }
  terminate() {}
  open() {
    this.emit('open')
  }
  turn(event: string, transcript: string, more: object = {}) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event, turn_index: 0, transcript, ...more })), false)
  }
  drop(code = 1011) {
    this.emit('close', code, Buffer.from(''))
  }
}

// 80 ms of 16 kHz 16-bit audio.
const frame = () => Buffer.alloc(2560)

function flux(trackAudio?: boolean) {
  const sockets: FakeDeepgram[] = []
  const stream = new FluxStream({
    keyterms: [],
    trackAudio,
    connect: () => {
      const socket = new FakeDeepgram()
      sockets.push(socket)
      return socket as unknown as FluxSocket
    },
  })
  stream.on('error', () => {})
  return { stream, sockets, last: () => sockets[sockets.length - 1] }
}

function fakeTime(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: 1_000_000 })
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  return (ms: number) => t.mock.timers.tick(ms)
}

test('with trackAudio, a point of the stream maps to when its audio came in, taking each piece as its last sample, and pieces kept for a stream still opening keep their own times', t => {
  const tick = fakeTime(t)
  const { stream, last } = flux(true)
  // Before the stream opens: kept, each with when it came.
  stream.send(frame())
  tick(80)
  stream.send(frame())
  tick(100)
  last().open()
  stream.send(frame())
  tick(80)
  stream.send(frame())
  // The first piece is the stream's first 80 ms, and came at 1,000,000: its last sample then.
  assert.equal(stream.audioTime(0.08), 1_000_000)
  assert.equal(stream.audioTime(0.04), 1_000_000 - 40)
  assert.equal(stream.audioTime(0.16), 1_000_080)
  assert.equal(stream.audioTime(0.2), 1_000_180 - 40)
  assert.equal(stream.audioTime(0.32), 1_000_260)
  assert.equal(stream.audioTime(0.33), null, 'past what came')
  assert.equal(stream.audioTime(Number.NaN), null)
  assert.equal(stream.streamSeconds(), 0.32)
})

test("a turn cut off by its stream dropping ends with its latest times, which map through that stream's; the next stream counts from 0", t => {
  const tick = fakeTime(t)
  const { stream, last } = flux(true)
  last().open()
  // 1.6 s of the stream, a frame every 80 ms: second s of it came in at 999,920 + s * 1000 (each piece as its last sample).
  for (let i = 0; i < 20; i++) {
    stream.send(frame())
    tick(80)
  }
  last().turn('StartOfTurn', 'Alpha here', { audio_window_start: 0.4, audio_window_end: 0.8, words: [{ word: 'Alpha', start: 0.48, end: 0.8 }] })
  last().turn('Update', 'Alpha here is', {
    audio_window_start: '0.4',
    audio_window_end: '1.2',
    words: [{ word: 'Alpha', confidence: 0.9, start: 0.48, end: 0.8 }, { word: 'here', start: '0.8', end: '1.12' }],
  })
  const dropped: TurnInfo[] = []
  stream.on('turn', (turn: TurnInfo) => void (turn.trigger === 'dropped' && dropped.push(turn)))
  last().drop()
  // The Update's times, and only times: its words are in the transcript already.
  assert.deepEqual(dropped, [
    {
      type: 'TurnInfo',
      event: 'EndOfTurn',
      turn_index: 0,
      transcript: 'Alpha here is',
      trigger: 'dropped',
      audio_window_start: '0.4',
      audio_window_end: '1.2',
      words: [{ start: 0.48, end: 0.8 }, { start: '0.8', end: '1.12' }],
    },
  ])
  // As MeetingSession.measure reads it: the first word's start and the last word's end, else the audio window.
  const [turn] = dropped
  const at = (seconds: unknown) => stream.audioTime(Number(seconds))
  assert.equal(at(turn.words?.[0]?.start), 1_000_400)
  assert.equal(at(turn.words?.at(-1)?.end), 1_001_040)
  assert.equal(at(turn.audio_window_start), 1_000_320)
  assert.equal(at(turn.audio_window_end), 1_001_120)
  // The next audio opens another stream: its times start again.
  tick(1000)
  stream.send(frame())
  tick(0)
  assert.equal(stream.audioTime(0.16), null)
  last().open()
  assert.equal(stream.audioTime(0.08), 1_002_600)
  assert.equal(stream.streamSeconds(), 0.08)
})

test('the times are kept for three minutes only', t => {
  const tick = fakeTime(t)
  const { stream, last } = flux(true)
  last().open()
  stream.send(frame())
  for (let i = 0; i < 181; i++) {
    tick(1000)
    // Flux answers all along, so the stream is not taken for dead.
    last().turn('Update', '')
    stream.send(frame())
  }
  assert.equal(stream.audioTime(0.04), null, 'over three minutes old')
  assert.equal(stream.audioTime(0.08 * 182), 1_181_000)
})

test('without trackAudio no times are kept, and nothing maps', t => {
  const tick = fakeTime(t)
  const { stream, last } = flux()
  stream.send(frame())
  tick(80)
  last().open()
  stream.send(frame())
  assert.equal(stream.audioTime(0.08), null)
  assert.equal(stream.streamSeconds(), 0)
  assert.deepEqual((stream as unknown as { anchors: unknown[] }).anchors, [])
  assert.deepEqual((stream as unknown as { backlogAt: unknown[] }).backlogAt, [])
  // The audio still goes, as it always did.
  assert.equal(last().sent.filter(d => typeof d !== 'string').length, 2)
})
