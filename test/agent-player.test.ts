// The bot page's player (public/agent.js), on a fake Web Audio context whose clock the test moves: where each piece of
// the assistant's voice is scheduled, how a pause stops and holds it, and how a resume or a clear ends the pause. Then
// the player joined to its link (connectVoice): what the page shows, and what it does with a pause when the link goes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { connectVoice, createFramer, createPlayer } from '../public/agent.js'
import { ROOT } from '../src/env.ts'
import { Playback } from '../src/pipeline/playback.ts'
import { PAGE_ERRORS } from '../src/pipeline/session.ts'
import { FakeClock, fakeSockets } from './fixtures/page-link.ts'

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
  at(600) // before the queue would have ended (1050): what was held plays from now + LEAD, not after the old queue
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
  assert.deepEqual(runs, [[50, 300], [650, 2100]])
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

test('the page never suspends its audio, which capture shares', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'agent.js'), 'utf8')
  assert.doesNotMatch(source, /\.suspend\s*\(/)
})

test('a clear says how much of the voice it dropped: the rest of each piece not played yet, and what a pause held', () => {
  {
    const { ctx, p } = player()
    assert.equal(p.clear(), 0, 'nothing to drop')
    p.play(piece(100)) // 0.05-0.15
    p.play(piece(100)) // 0.15-0.25
    ctx.advance(0.1)
    // 50 ms of the first and all of the second, at 32 bytes a millisecond.
    assert.equal(p.clear(), 150 * 32)
  }
  {
    const { ctx, p } = player()
    p.play(piece(100)) // 0.05-0.15
    ctx.advance(0.08)
    p.pause() // holds 70 ms
    p.play(piece(200))
    assert.equal(p.clear(), 270 * 32)
  }
  {
    // Resumed, the first piece held not started again yet: all that was held is still to play.
    const { ctx, p } = player()
    p.play(piece(100)) // 0.05-0.15
    ctx.advance(0.1)
    p.pause() // holds 50 ms
    ctx.advance(1)
    p.resume() // from 1.05
    ctx.advance(1.02)
    assert.equal(p.clear(), 50 * 32)
  }
})

test('a pause just after a resume, before what was held has started again, holds it from where it was: none plays twice', () => {
  const { ctx, p, scheduled } = player()
  p.play(piece(100)) // 0.05-0.15
  ctx.advance(0.1)
  p.pause() // held from 50 ms in
  ctx.advance(1)
  p.resume() // from 1.05, 50 ms in
  ctx.advance(1.02)
  p.pause()
  ctx.advance(2)
  p.resume()
  assert.deepEqual(scheduled(), [[0.05, 0], [1.05, 0.05], [2.05, 0.05]])
})

/** The player joined to a link on fake connections: what onState says, in order. */
function voice() {
  const ctx = new FakeContext()
  const clock = new FakeClock()
  const sockets = fakeSockets()
  const states: string[] = []
  const v = connectVoice(
    'wss://voice.example/audio?key=meeting-key&token=page-token',
    { ctx: ctx as unknown as AudioContext, output: {} as AudioNode, onState: s => states.push(s) },
    { WebSocket: sockets.WebSocket, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: () => 0 },
  )
  /** Moves both clocks on to `ms` after the start (the link's in ms, the audio's in s). */
  const at = (ms: number) => {
    clock.tick(ms - clock.time)
    ctx.advance(ms / 1000)
  }
  return { v, ctx, clock, sockets, states, at }
}

test("the page says 'speaking' while the voice plays, then the link's state while it is down, then the last error, then 'listening'", () => {
  const { sockets, states, at } = voice()
  assert.deepEqual(states, [], 'nothing until the service says ready')
  sockets.last.ready()
  assert.deepEqual(states, ['listening'])
  sockets.last.voice(3200) // 100 ms: 0.05-0.15
  assert.deepEqual(states, ['listening', 'speaking'])
  // The link goes while the voice plays: the page plays on, and says so.
  sockets.last.drop()
  at(100)
  assert.equal(states.at(-1), 'speaking')
  at(160)
  assert.equal(states.at(-1), 'reconnecting')
  sockets.last.ready() // the try after 125 ms
  assert.equal(states.at(-1), 'listening')
  // An error shows under the link's state and the voice, and stays until the service clears it.
  sockets.last.say({ type: 'error', message: PAGE_ERRORS.hearing })
  assert.equal(states.at(-1), "error: can't hear the meeting")
  sockets.last.drop()
  assert.equal(states.at(-1), 'reconnecting')
  at(1000)
  sockets.last.ready()
  assert.equal(states.at(-1), "error: can't hear the meeting", 'still not hearing: a reconnect is no news of that')
  sockets.last.voice(3200) // 1.05-1.15
  assert.equal(states.at(-1), 'speaking')
  at(1160)
  assert.equal(states.at(-1), "error: can't hear the meeting", 'the voice playing is no news of that either')
  sockets.last.say({ type: 'hearing' })
  assert.equal(states.at(-1), 'listening')
  sockets.last.say({ type: 'speaking', on: true })
  sockets.last.say({ type: 'hb' })
  sockets.last.drop(4000)
  assert.deepEqual(states, [
    'listening', 'speaking', 'reconnecting', 'listening', "error: can't hear the meeting", 'reconnecting',
    "error: can't hear the meeting", 'speaking', "error: can't hear the meeting", 'listening', 'disconnected',
  ])
})

test('an error about an answer goes once the voice plays again', () => {
  const { sockets, states, at } = voice()
  sockets.last.ready()
  sockets.last.say({ type: 'error', message: PAGE_ERRORS.answer })
  assert.equal(states.at(-1), "error: couldn't answer that")
  sockets.last.voice(3200)
  at(200)
  assert.deepEqual(states, ['listening', "error: couldn't answer that", 'speaking', 'listening'])
})

test("the service's pause, resume and clear reach the player, and a paused page says 'listening'", () => {
  const { ctx, sockets, states, at } = voice()
  sockets.last.ready()
  sockets.last.voice(3200) // 0.05-0.15
  at(100)
  sockets.last.say({ type: 'pause' })
  assert.equal(ctx.sources[0].stopAt, 0.11)
  assert.equal(states.at(-1), 'listening')
  at(500)
  sockets.last.say({ type: 'resume' })
  assert.deepEqual([round(ctx.sources[1].when), round(ctx.sources[1].offset)], [0.55, 0.05])
  assert.equal(states.at(-1), 'speaking')
  sockets.last.say({ type: 'clear' })
  assert.equal(ctx.sources[1].stopAt, 0)
  assert.deepEqual(states, ['listening', 'speaking', 'listening', 'speaking', 'listening'])
})

test('a page paused when its link goes throws away what it held, and tells the service it never had it (got)', () => {
  const { ctx, sockets, states, at } = voice()
  sockets.last.ready('s3cret')
  sockets.last.voice(3200) // 100 ms: 0.05-0.15
  at(100)
  sockets.last.say({ type: 'pause' }) // holds 50 ms
  sockets.last.voice(6400) // and 200 ms more
  // The link goes before the service can say resume: nothing more plays, and 250 ms of the 300 never did.
  sockets.last.drop()
  assert.equal(states.at(-1), 'reconnecting')
  at(2000)
  assert.equal(ctx.sources.length, 1, 'nothing held is played')
  assert.deepEqual([sockets.last.query.rejoin, sockets.last.query.got], ['s3cret', String(9600 - 250 * 32)])
  // The service's resume, if it comes on the next connection, has nothing to play.
  sockets.last.ready('s3cret')
  sockets.last.say({ type: 'resume' })
  assert.equal(ctx.sources.length, 1)
})

test('a page playing when its link goes plays on, and counts all it had in got', () => {
  const { ctx, sockets, states, at } = voice()
  sockets.last.ready('s3cret')
  sockets.last.voice(3200) // 0.05-0.15
  sockets.last.voice(3200) // 0.15-0.25
  at(100)
  sockets.last.drop()
  assert.equal(states.at(-1), 'speaking')
  assert.equal(ctx.sources.every(s => s.stopAt === Infinity), true, 'nothing stopped')
  at(250)
  assert.equal(states.at(-1), 'reconnecting')
  at(1000)
  assert.equal(sockets.last.query.got, '6400')
})

test("the page's frames go out only once the service has said ready, and close lets the link go", () => {
  const { v, clock, sockets } = voice()
  const frame = new Int16Array(1280)
  assert.equal(v.send(frame), false)
  sockets.last.ready()
  assert.equal(v.send(frame), true)
  assert.deepEqual(sockets.last.sent, [frame])
  v.close()
  assert.equal(sockets.last.closed, true)
  assert.equal(v.send(frame), false)
  assert.equal(clock.pending, 0)
})

test('the default page has a label for every state the page is told, "Reconnecting…" among them', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'agent.html'), 'utf8')
  const labels = /const label = \{([\s\S]*?)\n {2}\}/.exec(html)?.[1] ?? ''
  for (const state of ['listening', 'speaking', 'reconnecting', 'disconnected']) assert.match(labels, new RegExp(`\\n\\s+${state}: `), state)
  assert.match(labels, /reconnecting: 'Reconnecting…'/)
})

/**
 * startAgent in a stand-in browser: the page's address, its audio context, the meeting's audio and connections the test
 * speaks for the service on. Restores the globals when done.
 */
async function startedAgent(t: { after: (fn: () => void) => void }, opts: { refuseFirst?: boolean } = {}) {
  const g = globalThis as Record<string, unknown>
  const saved = ['location', 'AudioContext', 'AudioWorkletNode', 'WebSocket'].map(k => [k, Object.getOwnPropertyDescriptor(g, k)] as const)
  const savedNavigator = Object.getOwnPropertyDescriptor(g, 'navigator')
  t.after(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d)
      else delete g[k]
    }
    if (savedNavigator) Object.defineProperty(g, 'navigator', savedNavigator)
  })
  const sockets = fakeSockets()
  let refuse = opts.refuseFirst ? 1 : 0
  g.WebSocket = class extends sockets.WebSocket {
    constructor(url: string) {
      if (refuse-- > 0) throw new Error('refused')
      super(url)
    }
  }
  g.location = new URL('https://bot.example/agent?key=meeting-key&token=page-token')
  const contexts: Page[] = []
  class Page extends FakeContext {
    closed = false
    destination = { name: 'destination' }
    audioWorklet = { addModule: async (_url: string) => {} }
    constructor(readonly options: { sampleRate: number }) {
      super()
      contexts.push(this)
    }
    async resume() {}
    createMediaStreamSource() { return { connect() {} } }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, connect() {} } }
    close() { this.closed = true }
  }
  g.AudioContext = Page
  const captures: { port: { onmessage: ((e: { data: Float32Array }) => void) | null } }[] = []
  g.AudioWorkletNode = class {
    port = { onmessage: null }
    constructor() { captures.push(this) }
  }
  const track = { stopped: false, stop() { this.stopped = true } }
  Object.defineProperty(g, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } }, configurable: true })
  const { startAgent } = await import('../public/agent.js')
  const states: string[] = []
  const stop = await startAgent({ onState: s => states.push(s) })
  // Its link runs on real timers: stopped even when the test fails, or they would keep it going another 75 s.
  t.after(stop)
  return { stop, states, sockets, ctx: contexts[0], capture: captures[0], track }
}

test("startAgent connects to the meeting's /audio, sends the meeting's audio once the service is ready, and its stop lets the link go", async t => {
  const { stop, states, sockets, ctx, capture, track } = await startedAgent(t)
  assert.equal(ctx.options.sampleRate, 16000)
  assert.equal(sockets.last.url, 'wss://bot.example/audio?key=meeting-key&token=page-token&n=1')
  const block = new Float32Array(1280).fill(0.5)
  capture.port.onmessage?.({ data: block })
  assert.deepEqual(sockets.last.sent, [], 'not before ready')
  sockets.last.ready()
  capture.port.onmessage?.({ data: block })
  assert.equal(sockets.last.sent.length, 1)
  assert.equal((sockets.last.sent[0] as Int16Array)[0], Math.trunc(0.5 * 0x7fff))
  sockets.last.voice(3200)
  assert.deepEqual(states, ['listening', 'speaking'])
  stop()
  assert.equal(sockets.last.closed, true)
  assert.equal(track.stopped, true)
  assert.equal(ctx.closed, true)
  sockets.last.drop()
  assert.deepEqual(states, ['listening', 'speaking'], 'nothing more once stopped')
})

test('startAgent starts even when its first connection fails: the page says it is reconnecting', async t => {
  const { stop, states, sockets } = await startedAgent(t, { refuseFirst: true })
  assert.deepEqual(states, ['reconnecting'])
  assert.equal(sockets.made.length, 0)
  stop()
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(sockets.made.length, 0, 'no try once stopped')
})
