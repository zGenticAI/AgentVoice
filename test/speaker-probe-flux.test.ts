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
  turn(event: string, transcript: string) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event, turn_index: 0, transcript })), false)
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

test("a turn cut off by its stream dropping still maps through that stream's times; the next stream counts from 0", t => {
  const tick = fakeTime(t)
  const { stream, last } = flux(true)
  last().open()
  stream.send(frame())
  tick(80)
  stream.send(frame())
  last().turn('StartOfTurn', 'Alpha here')
  let mapped: number | null = null
  stream.on('turn', (turn: TurnInfo) => {
    if (turn.trigger === 'dropped') mapped = stream.audioTime(0.16)
  })
  last().drop()
  assert.equal(mapped, 1_000_080)
  // The next audio opens another stream: its times start again.
  tick(1000)
  stream.send(frame())
  tick(0)
  assert.equal(stream.audioTime(0.16), null)
  last().open()
  assert.equal(stream.audioTime(0.08), 1_001_080)
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
