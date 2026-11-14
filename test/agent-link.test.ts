// The bot page's link to the service (createLink in public/agent.js), on fake connections and a clock the test moves:
// what each try asks for, when the page gives up on a connection and tries again, and when it stops for good.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONNECT_TIMEOUT_MS,
  FINAL_CODES,
  GIVE_UP_MS,
  PAGE_SILENCE_MS,
  RETRY_MS,
  createLink,
  retryDelay,
  type Control,
} from '../public/agent.js'
import { FakeClock, fakeSockets } from './fixtures/page-link.ts'

const URL_ = 'wss://voice.example/audio?key=meeting-key&token=page-token'

/** A link on fake connections and a fake clock. random 0: each wait is half of RETRY_MS's. */
function link(random = () => 0) {
  const clock = new FakeClock()
  const sockets = fakeSockets()
  const audio: number[] = []
  const controls: Control[] = []
  const states: string[] = []
  const l = createLink(
    URL_,
    { onAudio: data => audio.push(data.byteLength), onControl: msg => controls.push(msg), onState: s => states.push(s) },
    { WebSocket: sockets.WebSocket, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random },
  )
  return { l, clock, sockets, audio, controls, states }
}

test('the constants are those the service is built for', () => {
  assert.equal(PAGE_SILENCE_MS, 4000)
  assert.equal(CONNECT_TIMEOUT_MS, 5000)
  assert.deepEqual(RETRY_MS, [250, 500, 1000, 2000, 4000, 5000])
  assert.equal(GIVE_UP_MS, 75_000)
  assert.deepEqual([...FINAL_CODES].sort(), [4000, 4003])
})

test('one connection at a time, taking the voice as array buffers, and each piece of it goes to onAudio', () => {
  const { sockets, audio } = link()
  assert.equal(sockets.made.length, 1)
  assert.equal(sockets.last.binaryType, 'arraybuffer')
  sockets.last.ready()
  sockets.last.voice(2560)
  sockets.last.voice(640)
  assert.deepEqual(audio, [2560, 640])
  assert.equal(sockets.made.length, 1)
})

test('no frame goes out before the service says ready, nor while the link is down: it is dropped, never kept', () => {
  const { l, clock, sockets } = link()
  const frame = (n: number) => new Int16Array(1280).fill(n)
  assert.equal(l.send(frame(1)), false, 'not ready yet')
  sockets.last.readyState = 1 // open, but no 'ready' yet
  assert.equal(l.send(frame(2)), false, 'open is not ready')
  sockets.last.ready()
  assert.equal(l.send(frame(3)), true)
  assert.deepEqual(sockets.last.sent.map(f => (f as Int16Array)[0]), [3])

  sockets.last.drop()
  assert.equal(l.send(frame(4)), false, 'lost')
  clock.tick(1000)
  assert.equal(sockets.made.length, 2)
  assert.equal(l.send(frame(5)), false, 'the next try has not said ready')
  sockets.last.ready()
  assert.equal(l.send(frame(6)), true)
  assert.deepEqual(sockets.last.sent.map(f => (f as Int16Array)[0]), [6], 'nothing from while it was down')
  sockets.last.readyState = 2 // the service is closing it
  assert.equal(l.send(frame(7)), false)
  assert.deepEqual(sockets.made[0].sent.length, 1)
})

test('every try carries n, counting up for as long as the page is loaded; rejoin and got come once the service has said ready', () => {
  const { clock, sockets } = link()
  assert.deepEqual(sockets.last.query, { key: 'meeting-key', token: 'page-token', n: '1' })
  // The first try fails before 'ready' (the tunnel was not up yet, say): nothing to rejoin.
  sockets.last.drop()
  clock.tick(1000)
  assert.deepEqual(sockets.last.query, { key: 'meeting-key', token: 'page-token', n: '2' })
  sockets.last.ready('s3cret')
  sockets.last.voice(2560)
  sockets.last.voice(1280)
  sockets.last.drop()
  clock.tick(1000)
  assert.deepEqual(sockets.last.query, { key: 'meeting-key', token: 'page-token', n: '3', rejoin: 's3cret', got: '3840' })
  // A try refused (the service answers 409 or 403, which a browser sees only as 1006) is tried again, n going on.
  sockets.last.drop()
  clock.tick(1000)
  assert.deepEqual(sockets.last.query, { key: 'meeting-key', token: 'page-token', n: '4', rejoin: 's3cret', got: '3840' })
  assert.deepEqual(sockets.made.map(s => s.query.n), ['1', '2', '3', '4'])
})

test('got counts all the voice since the page loaded: a ready does not start it again, and the same secret goes every time', () => {
  const { clock, sockets } = link()
  sockets.last.ready('s3cret')
  sockets.last.voice(1000)
  sockets.last.drop()
  clock.tick(1000)
  assert.equal(sockets.last.query.got, '1000')
  sockets.last.ready('s3cret')
  sockets.last.voice(500)
  sockets.last.drop()
  clock.tick(1000)
  assert.deepEqual([sockets.last.query.rejoin, sockets.last.query.got], ['s3cret', '1500'])
  // A ready without a secret (it shouldn't come) leaves the one the page has.
  sockets.last.say({ type: 'ready', sampleRate: 16000 })
  sockets.last.drop()
  clock.tick(1000)
  assert.deepEqual([sockets.last.query.rejoin, sockets.last.query.got], ['s3cret', '1500'])
})

test("a ready lost on the way: the next try still carries the same secret and all the voice had so far", () => {
  const { clock, sockets, controls } = link()
  sockets.last.ready('s3cret')
  sockets.last.voice(3200)
  sockets.last.drop()
  clock.tick(1000)
  // The service takes this try and says 'ready', but the connection dies before it reaches the page.
  assert.deepEqual([sockets.last.query.rejoin, sockets.last.query.got], ['s3cret', '3200'])
  sockets.last.readyState = 1
  sockets.last.drop()
  clock.tick(1000)
  assert.deepEqual([sockets.last.query.n, sockets.last.query.rejoin, sockets.last.query.got], ['3', 's3cret', '3200'])
  // And this one hangs, its 'ready' never arriving: given up on after 5 s, the next asks the same.
  sockets.last.readyState = 1
  clock.tick(CONNECT_TIMEOUT_MS + 1000)
  assert.deepEqual([sockets.last.query.n, sockets.last.query.rejoin, sockets.last.query.got], ['4', 's3cret', '3200'])
  sockets.last.ready('s3cret')
  assert.equal(controls.filter(c => c.type === 'ready').length, 2)
})

test('after a drop the page tries again after 125-250 ms, then 250-500 ms and so on, waiting 2.5-5 s at most', () => {
  for (const [random, waits] of [
    [() => 0, [125, 250, 500, 1000, 2000, 2500, 2500, 2500]],
    [() => 0.999999, [250, 500, 1000, 2000, 4000, 5000, 5000]],
  ] as const) {
    const { clock, sockets, states } = link(random)
    sockets.last.ready()
    for (const wait of waits) {
      const tries = sockets.made.length
      sockets.last.drop()
      clock.tick(Math.floor(wait) - 1)
      assert.equal(sockets.made.length, tries, `not yet, ${wait} ms`)
      clock.tick(1)
      assert.equal(sockets.made.length, tries + 1, `${wait} ms`)
    }
    assert.deepEqual(new Set(states), new Set(['reconnecting']))
  }
})

test('retryDelay is between half and all of the wait RETRY_MS gives, and its last wait goes on', () => {
  assert.equal(retryDelay(0, () => 0), 125)
  assert.equal(retryDelay(0, () => 1), 250)
  assert.equal(retryDelay(1, () => 0.5), 375)
  assert.equal(retryDelay(4, () => 0), 2000)
  assert.equal(retryDelay(5, () => 1), 5000)
  assert.equal(retryDelay(99, () => 0), 2500)
  for (let tries = 0; tries < 10; tries++) {
    const d = retryDelay(tries)
    const most = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]
    assert.ok(d >= most / 2 && d <= most, `${tries}: ${d}`)
  }
})

test('a connection that has said nothing for 4 s since ready is let go at once, without waiting for it to close', () => {
  const { clock, sockets, controls, states } = link()
  sockets.last.ready()
  // The heartbeat, and any other message, keeps it: it is not passed on.
  clock.tick(3000)
  sockets.last.say({ type: 'hb' })
  clock.tick(3000)
  sockets.last.voice(2560)
  clock.tick(3999)
  assert.equal(sockets.made.length, 1)
  assert.equal(sockets.last.closed, false)
  assert.deepEqual(states, [])
  clock.tick(1)
  // Its close may take a minute, or never come: the page doesn't wait for it.
  assert.equal(sockets.made[0].closed, true)
  assert.deepEqual(states, ['reconnecting'])
  clock.tick(125)
  assert.equal(sockets.made.length, 2)
  assert.deepEqual(controls.map(c => c.type), ['ready'])
})

test('a try that has not said ready within 5 s is given up on, and tried again', () => {
  const { clock, sockets, states } = link()
  sockets.last.readyState = 1 // the tunnel took it, and passes nothing on
  sockets.last.say({ type: 'hb' })
  clock.tick(CONNECT_TIMEOUT_MS - 1)
  assert.equal(sockets.made[0].closed, false)
  clock.tick(1)
  assert.equal(sockets.made[0].closed, true)
  assert.deepEqual(states, ['reconnecting'])
  clock.tick(125)
  assert.deepEqual(sockets.made.map(s => s.query.n), ['1', '2'])
  // The same for a try after a drop.
  sockets.last.ready()
  sockets.last.drop()
  clock.tick(125)
  clock.tick(CONNECT_TIMEOUT_MS)
  assert.equal(sockets.made[2].closed, true)
})

test('close codes 4000 and 4003 are final: the page says disconnected and never tries again', () => {
  for (const code of [4000, 4003]) {
    for (const hadReady of [true, false]) {
      const { clock, sockets, states } = link()
      if (hadReady) sockets.last.ready()
      else sockets.last.say({ type: 'error', message: "can't start" })
      sockets.last.drop(code)
      assert.deepEqual(states, ['disconnected'], `${code}`)
      clock.tick(GIVE_UP_MS * 2)
      assert.equal(sockets.made.length, 1, `${code}`)
      assert.equal(clock.pending, 0, 'no timer left')
    }
  }
  // Any other close means try again: the service going away, an error, a close of its own.
  for (const code of [1000, 1001, 1005, 1006, 1011, 4001]) {
    const { clock, sockets, states } = link()
    sockets.last.ready()
    sockets.last.drop(code)
    clock.tick(250)
    assert.deepEqual([states, sockets.made.length], [['reconnecting'], 2], `${code}`)
  }
})

test('the page gives up 75 s after the link was lost, says disconnected, and then nothing changes anything', () => {
  const { clock, sockets, states, audio, controls } = link()
  sockets.last.ready()
  for (let s = 0; s < 10; s++) {
    clock.tick(1000)
    sockets.last.say({ type: 'hb' })
  }
  sockets.last.drop()
  // Every try is refused at once, or hangs.
  let refused = 0
  while (clock.time < 10_000 + GIVE_UP_MS - 6000) {
    clock.tick(100)
    const sock = sockets.last
    if (!sock.closed && sock.readyState === 0 && refused++ % 2 === 0) sock.drop()
  }
  assert.ok(sockets.made.length > 10, `${sockets.made.length} tries`)
  assert.deepEqual(new Set(states), new Set(['reconnecting']))
  const hung = sockets.last
  hung.readyState = 1
  clock.tick(10_000 + GIVE_UP_MS - 1 - clock.time)
  assert.equal(states.at(-1), 'reconnecting')
  const tries = sockets.made.length
  clock.tick(1)
  assert.equal(states.at(-1), 'disconnected')
  assert.equal(sockets.last.closed, true, 'the try under way is let go')
  assert.equal(clock.pending, 0)
  // Late events from any of them change nothing.
  for (const sock of sockets.made) {
    sock.ready()
    sock.voice(2560)
    sock.drop()
  }
  clock.tick(60_000)
  assert.equal(sockets.made.length, tries)
  assert.equal(states.filter(s => s === 'disconnected').length, 1)
  assert.deepEqual([audio, controls.length], [[], 1])
})

test('the tries and the give-up clock start again only on ready, not when a connection opens', () => {
  const { clock, sockets, states } = link()
  sockets.last.ready()
  sockets.last.drop()
  clock.tick(125) // try 2
  // It opens, and closes before 'ready': the next wait goes on from the last (250 ms), and so does the give-up clock.
  sockets.last.readyState = 1
  sockets.last.drop()
  clock.tick(249)
  assert.equal(sockets.made.length, 2)
  clock.tick(1) // try 3
  assert.equal(sockets.made.length, 3)
  // Refused, again and again, for a minute.
  while (clock.time < 60_000) {
    clock.tick(100)
    if (!sockets.last.closed && sockets.last.readyState === 0) sockets.last.drop()
  }
  while (sockets.last.closed) clock.tick(100)
  // Then back: the next drop waits 125 ms again, and has 75 s from then.
  sockets.last.ready()
  clock.tick(1000 - (clock.time % 1000))
  const droppedAt = clock.time
  sockets.last.drop()
  const tries = sockets.made.length
  clock.tick(125)
  assert.equal(sockets.made.length, tries + 1)
  while (clock.time < droppedAt + GIVE_UP_MS - 500) {
    clock.tick(500)
    if (!sockets.last.closed && sockets.last.readyState === 0) sockets.last.drop()
  }
  assert.ok(clock.time > GIVE_UP_MS + 60_000, 'well past 75 s after the first drop')
  assert.ok(!states.includes('disconnected'), 'still trying')
  clock.tick(droppedAt + GIVE_UP_MS - 1 - clock.time)
  assert.equal(states.at(-1), 'reconnecting')
  clock.tick(1)
  assert.equal(states.at(-1), 'disconnected')
})

test('what a connection the page let go of still delivers is ignored: its voice, its messages and its close', () => {
  const { clock, sockets, audio, controls, states } = link()
  const first = sockets.last
  first.ready('s3cret')
  first.voice(1000)
  clock.tick(PAGE_SILENCE_MS) // let go
  clock.tick(125)
  const second = sockets.last
  assert.notEqual(second, first)
  first.voice(2560)
  first.say({ type: 'pause' })
  first.ready('other')
  first.drop()
  assert.deepEqual(audio, [1000])
  assert.deepEqual(controls.map(c => c.type), ['ready'])
  assert.deepEqual(states, ['reconnecting'])
  assert.equal(sockets.made.length, 2, 'its close starts no try')
  second.ready('s3cret')
  second.drop()
  clock.tick(125)
  assert.deepEqual([sockets.last.query.rejoin, sockets.last.query.got], ['s3cret', '1000'])
})

test('every message but the heartbeat goes to onControl, ready included; one that is not JSON is ignored', () => {
  const { sockets, controls } = link()
  sockets.last.ready()
  sockets.last.say({ type: 'hb' })
  sockets.last.say({ type: 'pause' })
  sockets.last.onmessage?.({ data: 'not json' })
  sockets.last.onmessage?.({ data: 'null' })
  sockets.last.say({ type: 'error', message: "can't hear the meeting" })
  assert.deepEqual(controls, [
    { type: 'ready', sampleRate: 16000, rejoin: 'secret-1' },
    { type: 'pause' },
    { type: 'error', message: "can't hear the meeting" },
  ])
})

test('discard leaves the bytes the page threw away out of got, which never goes below 0', () => {
  const { l, clock, sockets } = link()
  sockets.last.ready()
  sockets.last.voice(3200)
  l.discard(1000.4)
  sockets.last.drop()
  clock.tick(125)
  assert.equal(sockets.last.query.got, '2200')
  sockets.last.ready()
  sockets.last.voice(800)
  l.discard(99_999)
  sockets.last.drop()
  clock.tick(250)
  assert.equal(sockets.last.query.got, '0')
})

test('close lets the connection go, and nothing more happens: no try, no state', () => {
  {
    const { l, clock, sockets, states } = link()
    sockets.last.ready()
    l.close()
    assert.equal(sockets.last.closed, true)
    assert.equal(clock.pending, 0)
    sockets.last.drop()
    clock.tick(GIVE_UP_MS * 2)
    assert.deepEqual([states, sockets.made.length], [[], 1])
  }
  {
    // Between tries.
    const { l, clock, sockets, states } = link()
    sockets.last.drop()
    l.close()
    clock.tick(GIVE_UP_MS * 2)
    assert.deepEqual([states, sockets.made.length, clock.pending], [['reconnecting'], 1, 0])
  }
})

test('a browser that will not open a connection now is a try that failed: the page tries again', () => {
  const clock = new FakeClock()
  const sockets = fakeSockets()
  let refuse = 2
  class Picky extends sockets.WebSocket {
    constructor(url: string) {
      if (refuse-- > 0) throw new Error('refused')
      super(url)
    }
  }
  const states: string[] = []
  createLink(URL_, { onAudio() {}, onControl() {}, onState: s => states.push(s) }, {
    WebSocket: Picky, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: () => 0,
  })
  assert.deepEqual(states, ['reconnecting'])
  clock.tick(125 + 250)
  assert.equal(sockets.made.length, 1)
  assert.equal(sockets.last.query.n, '3')
})
