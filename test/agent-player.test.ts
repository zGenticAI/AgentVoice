// The bot page's player (public/agent.js), on a fake Web Audio context whose clock the test moves: where each piece of
// the assistant's voice is scheduled, how a pause stops and holds it, and how a resume or a clear ends the pause.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createFramer, createPlayer } from '../public/agent.js'
import { ROOT } from '../src/env.ts'
import { Playback } from '../src/pipeline/playback.ts'

// The page's lead and fade (s), as in agent.js.
const LEAD = 0.05
const FADE = 0.01

/**
 * An AudioParam's scheduled values, and the value they give at a time, the way Web Audio works it out. Cancelled
 * events leave it where it had got to by then, as in Chromium: a gain faded out stays down until it is set again.
 */
class FakeParam {
  events: { time: number; value: number; ramp: boolean }[] = []
  // Its value before the first event: a gain's default, then wherever cancelling events left it.
  private base = 1
  constructor(private readonly now: () => number) {}
  cancelScheduledValues(time: number) {
    this.base = this.valueAt(this.now())
    this.events = this.events.filter(e => e.time < time)
  }
  setValueAtTime(value: number, time: number) { this.add({ time, value, ramp: false }) }
  linearRampToValueAtTime(value: number, time: number) { this.add({ time, value, ramp: true }) }
  private add(event: { time: number; value: number; ramp: boolean }) {
    this.events.push(event)
    this.events.sort((a, b) => a.time - b.time)
  }
  /** The value at this time (to the millionth): along a ramp, the point on it. */
  at(time: number): number {
    return round(this.valueAt(time))
  }
  private valueAt(time: number): number {
    let value = this.base
    let from = 0
    for (const e of this.events) {
      if (e.time <= time) {
        value = e.value
        from = e.time
        continue
      }
      if (e.ramp) return value + ((e.value - value) * (time - from)) / (e.time - from)
      break
    }
    return value
  }
}

class FakeBuffer {
  readonly data: Float32Array
  constructor(readonly length: number, readonly sampleRate: number) { this.data = new Float32Array(length) }
  get duration() { return this.length / this.sampleRate }
  getChannelData() { return this.data }
}

class FakeSource {
  buffer: FakeBuffer | null = null
  onended: (() => void) | null = null
  to: unknown = null
  when = NaN
  offset = NaN
  stopAt = Infinity
  stops = 0
  ended = false
  connect(to: unknown) { this.to = to }
  start(when: number, offset = 0) { this.when = when; this.offset = offset }
  stop(when = 0) { this.stopAt = when; this.stops++ }
  /** When it stops sounding: at its end, or when it was told to stop. */
  get end() { return Math.min(this.when + this.buffer!.duration - this.offset, this.stopAt) }
}

class FakeContext {
  currentTime = 0
  sources: FakeSource[] = []
  readonly gain = { gain: new FakeParam(() => this.currentTime), to: null as unknown, connect(to: unknown) { this.to = to } }
  createBuffer(_channels: number, length: number, sampleRate: number) { return new FakeBuffer(length, sampleRate) }
  createBufferSource() {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
  createGain() { return this.gain }
  /** Moves the clock to `time` (s): each piece that has stopped sounding by then ends, and says so, as in a browser. */
  advance(time: number) {
    this.currentTime = time
    for (const s of this.sources) {
      if (s.ended || s.end > time) continue
      s.ended = true
      s.onended?.()
    }
  }
}

/** A piece of voice this long (ms), PCM16 at 16 kHz, every sample `level`. */
const piece = (ms: number, level = 0x4000) => new Int16Array(ms * 16).fill(level).buffer

function player() {
  const ctx = new FakeContext()
  const output = { name: 'analyser' }
  const changes: boolean[] = []
  const p = createPlayer(ctx as unknown as AudioContext, output as unknown as AudioNode, speaking => changes.push(speaking))
  // Each piece scheduled: [when it starts, from how far into its audio (s)], rounded to the microsecond.
  const scheduled = () => ctx.sources.map(s => [round(s.when), round(s.offset)])
  return { ctx, output, p, changes, scheduled }
}
const round = (s: number) => Math.round(s * 1e6) / 1e6

test('pieces play through the voice gain, back to back, from 50 ms after the first arrives', () => {
  const { ctx, output, p, changes, scheduled } = player()
  assert.equal(ctx.gain.to, output)
  p.play(piece(100))
  p.play(piece(100))
  ctx.advance(0.02)
  p.play(piece(100))
  assert.deepEqual(scheduled(), [[0.05, 0], [0.15, 0], [0.25, 0]])
  assert.ok(ctx.sources.every(s => s.to === ctx.gain))
  assert.equal(ctx.sources[0].buffer!.data[0], 0.5, 'PCM16 is played as -1 to 1')
  assert.deepEqual(changes, [true, true, true])
  ctx.advance(0.3)
  assert.deepEqual(changes, [true, true, true], 'still playing')
  ctx.advance(0.35)
  assert.deepEqual(changes, [true, true, true, false])
  // Nothing queued: the next piece plays 50 ms after it arrives.
  ctx.advance(1)
  p.play(piece(100))
  assert.deepEqual(scheduled().at(-1), [1.05, 0])
})

test('a pause fades the voice out over 10 ms and stops each piece there, holding the rest from where it paused', () => {
  const { ctx, p, changes, scheduled } = player()
  p.play(piece(100)) // 0.05-0.15
  p.play(piece(100)) // 0.15-0.25
  p.play(piece(100)) // 0.25-0.35
  ctx.advance(0.2) // the first has played; the second is halfway
  p.pause()
  assert.equal(p.paused, true)
  assert.equal(ctx.gain.gain.at(0.2), 1)
  assert.equal(ctx.gain.gain.at(0.205), 0.5)
  assert.equal(ctx.gain.gain.at(0.21), 0)
  assert.deepEqual(ctx.sources.slice(1).map(s => round(s.stopAt)), [0.21, 0.21])
  ctx.advance(0.5)
  assert.deepEqual(changes, [true, true, true, false], 'the pieces stopped by the pause say nothing more')
  p.resume()
  // The second from 50 ms in, then the third whole, back to back from 50 ms after the resume.
  assert.deepEqual(scheduled().slice(3), [[0.55, 0.05], [0.6, 0]])
  assert.equal(ctx.gain.gain.at(0.54), 0)
  assert.equal(ctx.gain.gain.at(0.555), 0.5)
  assert.equal(ctx.gain.gain.at(0.6), 1)
  assert.deepEqual(changes, [true, true, true, false, true, true])
  ctx.advance(0.8)
  assert.equal(changes.at(-1), false)
})

test('audio that arrives while paused waits behind what was held, and plays after it on resume', () => {
  const { ctx, p, changes, scheduled } = player()
  p.play(piece(100)) // 0.05-0.15
  ctx.advance(0.08)
  p.pause()
  p.play(piece(100, 0x2000))
  p.play(piece(200, 0x1000))
  assert.equal(ctx.sources.length, 1, 'nothing is scheduled while paused')
  assert.deepEqual(changes, [true, false])
  ctx.advance(1)
  p.resume()
  assert.deepEqual(scheduled().slice(1), [[1.05, 0.03], [1.12, 0], [1.22, 0]])
  assert.deepEqual(ctx.sources.slice(1).map(s => s.buffer!.data[0]), [0.5, 0.25, 0.125])
  // Then what arrives plays after them.
  p.play(piece(100))
  assert.deepEqual(scheduled().at(-1), [1.42, 0])
})

test('a clear while paused drops what was held and ends the pause, and the next piece plays at full volume', () => {
  const { ctx, p, changes, scheduled } = player()
  p.play(piece(100))
  ctx.advance(0.1)
  p.pause()
  p.play(piece(100))
  ctx.advance(0.3) // faded out long ago
  p.clear()
  assert.equal(p.paused, false)
  assert.deepEqual(changes, [true, false, false])
  p.resume() // a resume that comes after the clear has nothing to play
  assert.equal(ctx.sources.length, 1)
  ctx.advance(0.5)
  p.play(piece(100))
  assert.deepEqual(scheduled().at(-1), [0.55, 0])
  assert.equal(ctx.gain.gain.at(0.55), 1)
})

test('a clear stops every piece at once, and none of them reports the page idle later', () => {
  const { ctx, p, changes } = player()
  p.play(piece(100))
  p.play(piece(100))
  ctx.advance(0.1)
  p.clear()
  assert.deepEqual(ctx.sources.map(s => s.stopAt), [0, 0])
  p.play(piece(100)) // 0.15-0.25
  ctx.advance(0.2)
  assert.deepEqual(changes, [true, true, false, true], 'still playing the new piece')
})

test('pausing or resuming twice changes nothing more', () => {
  const { ctx, p, changes, scheduled } = player()
  p.play(piece(100)) // 0.05-0.15
  ctx.advance(0.1)
  p.pause()
  ctx.advance(0.12)
  p.pause()
  assert.equal(ctx.sources[0].stops, 1)
  ctx.advance(1)
  p.resume()
  p.resume()
  assert.deepEqual(scheduled(), [[0.05, 0], [1.05, 0.05]])
  assert.deepEqual(changes, [true, false, true])
})

test('a resume with nothing held leaves the voice up for what comes next', () => {
  const { ctx, p, scheduled } = player()
  p.pause()
  ctx.advance(0.5)
  p.resume()
  assert.equal(p.paused, false)
  ctx.advance(0.6)
  p.play(piece(100))
  assert.deepEqual(scheduled(), [[0.65, 0]])
  assert.equal(ctx.gain.gain.at(0.65), 1)
})

test('the page plays a pause the way the service reckons it does (src/pipeline/playback.ts)', () => {
  const { ctx, p } = player()
  let now = 0
  const model = new Playback<string>(() => {}, () => now)
  const line = model.begin('a', 'The pilot starts in March and ends in May.')
  const send = (ms: number) => {
    p.play(piece(ms))
    model.sent(line, ms)
  }
  const at = (ms: number) => {
    now = ms
    ctx.advance(ms / 1000)
  }
  send(500)
  at(20)
  send(500)
  at(300)
  p.pause()
  model.pause()
  send(400)
  at(1000)
  p.resume()
  model.resume()
  at(1200)
  send(300)
  // What the page plays, in ms: each piece from when it starts, until it ends or is stopped (a pause's fade is not
  // counted: the service takes the pause as the cut), with pieces that follow on joined up.
  const runs: [number, number][] = []
  for (const s of ctx.sources) {
    const start = Math.round(s.when * 1000)
    const end = Math.round(Math.min(s.when + s.buffer!.duration - s.offset, s.stopAt - FADE) * 1000)
    if (end <= start) continue // stopped by the pause before it started
    const last = runs.at(-1)
    if (last && last[1] === start) last[1] = end
    else runs.push([start, end])
  }
  assert.deepEqual(runs, line.runs)
  assert.deepEqual(runs, [[50, 300], [1050, 2500]])
})

test('the meeting audio goes out in frames of 1280 samples, in order, however the worklet splits it', () => {
  const frames: Int16Array[] = []
  const frame = createFramer(f => frames.push(f))
  // The worklet hands over 128 samples at a time: 30 blocks make 3 frames. Sample n is (n % 1000) / 1000.
  const pcm = (n: number) => Math.trunc(((n % 1000) / 1000) * 0x7fff)
  for (let b = 0; b < 30; b++) frame(Float32Array.from({ length: 128 }, (_, i) => ((b * 128 + i) % 1000) / 1000))
  assert.deepEqual(frames.map(f => f.length), [1280, 1280, 1280])
  for (let k = 0; k < 3; k++) assert.deepEqual([frames[k][0], frames[k][1279]], [pcm(k * 1280), pcm(k * 1280 + 1279)], `frame ${k}`)
  assert.notEqual(frames[0].buffer, frames[1].buffer, 'each frame is a copy of its own')
  frame(Float32Array.from([2, -2]))
  frame(new Float32Array(1278))
  assert.deepEqual([...frames[3].slice(0, 3)], [0x7fff, -0x7fff, 0], 'loud samples are clipped')
})

test('the page never suspends its audio, which capture shares, and handles pause and resume', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'agent.js'), 'utf8')
  assert.doesNotMatch(source, /\.suspend\s*\(/)
  assert.match(source, /msg\.type === 'pause'\) player\.pause\(\)/)
  assert.match(source, /msg\.type === 'resume'\) player\.resume\(\)/)
})
