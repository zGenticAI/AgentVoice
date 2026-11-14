import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { keyterms } from '../src/config.ts'
import {
  FLUX_BACKLOG_BYTES,
  FLUX_RETRY_MS,
  type FluxSocket,
  FluxStream,
  type FluxTiming,
  type TurnInfo,
  fluxUrl,
} from '../src/pipeline/deepgram.ts'

test("the assistant's name and the owner's are always keyterms (and the company, when set), plus any extra ones from .env", () => {
  assert.deepEqual(keyterms(''), ['Alex', 'Sam'])
  assert.deepEqual(keyterms(' Recall.ai , ,Kubernetes,alex, Cloudflare Tunnel '), ['Alex', 'Sam', 'Recall.ai', 'Kubernetes', 'Cloudflare Tunnel'])
  const warned: string[] = []
  assert.equal(keyterms(Array.from({ length: 150 }, (_, i) => `term${i}`).join(','), m => warned.push(m)).length, 100)
  assert.equal(warned.length, 1)
  assert.match(warned[0], /Left out: term98, term99, /)
})

test("keyterms stay within Deepgram's token limit, so a long list can't refuse the whole stream", () => {
  const warned: string[] = []
  const phrases = Array.from({ length: 100 }, (_, i) => `the quarterly planning review number ${i}`) // 6 words each
  const kept = keyterms(phrases.join(','), m => warned.push(m))
  const tokens = kept.reduce((n, t) => n + Math.max(2, Math.ceil(t.split(/\s+/).length * 1.3)), 0)
  assert.ok(tokens <= 500, `${tokens} tokens`)
  assert.deepEqual(kept.slice(0, 2), ['Alex', 'Sam'], 'the name always comes first, then the owner')
  assert.ok(kept.length < 102)
  assert.equal(warned.length, 1)
  assert.deepEqual(keyterms('Sam, Recall.ai', m => warned.push(m)), ['Alex', 'Sam', 'Recall.ai'])
  assert.equal(warned.length, 1, 'no warning when everything fits')
})

test('each keyterm is its own query parameter on the Flux address', () => {
  const url = new URL(fluxUrl({ keyterms: ['Alex', 'Acme', 'Cloudflare Tunnel'] }))
  assert.equal(url.pathname, '/v2/listen')
  assert.equal(url.searchParams.get('model'), 'flux-general-en')
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['Alex', 'Acme', 'Cloudflare Tunnel'])
  assert.match(url.search, /keyterm=Alex&keyterm=Acme&keyterm=Cloudflare\+Tunnel/)
})

test('the Flux stream opts out of Deepgram keeping meeting audio for model improvement', () => {
  assert.equal(new URL(fluxUrl({ keyterms: [] })).searchParams.get('mip_opt_out'), 'true')
})

// FluxStream with a fake Deepgram (the connect seam) and Node's fake timers, so the reconnects, the waits and the
// "can't hear" timer are checked to the millisecond.
const KEY = 'dg-key-never-in-the-log'
process.env.DEEPGRAM_API_KEY = KEY

/** One socket to the fake Deepgram: the test opens, drops, refuses or answers it. */
class FakeDeepgram extends EventEmitter {
  sent: (Buffer | string)[] = []
  terminated = false
  // Closed by Deepgram's side, or let go by FluxStream.
  gone = false
  constructor(readonly url: string) {
    super()
  }
  send(data: Buffer | string) {
    this.sent.push(data)
  }
  terminate() {
    this.terminated = true
    this.gone = true
  }
  open() {
    this.emit('open')
  }
  say(msg: object) {
    this.emit('message', Buffer.from(JSON.stringify(msg)), false)
  }
  turn(event: string, transcript: string, extra: object = {}) {
    this.say({ type: 'TurnInfo', event, turn_index: 0, transcript, ...extra })
  }
  drop(code = 1011) {
    this.gone = true
    this.emit('close', code, Buffer.from(''))
  }
  /** A network error before the stream opened, as ws reports it. */
  fail() {
    this.gone = true
    this.emit('error', new Error('connect ECONNREFUSED'))
    this.emit('close', 1006, Buffer.from(''))
  }
  /** Deepgram answers the handshake with an HTTP status instead of opening the stream. */
  refuse(status: number, body = '') {
    const res = Object.assign(new EventEmitter(), { statusCode: status })
    this.emit('unexpected-response', {}, res)
    if (body) res.emit('data', Buffer.from(body))
    res.emit('end')
  }
  controls() {
    return this.sent.filter(d => typeof d === 'string').map(d => JSON.parse(d as string).type as string)
  }
  audio() {
    return this.sent.filter(d => typeof d !== 'string') as Buffer[]
  }
}

const frame = (n: number) => Buffer.alloc(2560, n % 256)

/** A FluxStream on the fake Deepgram. Call it after t.mock.timers.enable when the test needs fake time. */
function flux(timing?: Partial<FluxTiming>) {
  const sockets: FakeDeepgram[] = []
  // How many earlier sockets were still live as each new one was opened: always 0.
  const liveAtConnect: number[] = []
  const stream = new FluxStream({
    keyterms: [],
    timing,
    connect: url => {
      liveAtConnect.push(sockets.filter(s => !s.gone).length)
      const socket = new FakeDeepgram(url)
      sockets.push(socket)
      return socket as unknown as FluxSocket
    },
  })
  const events: string[] = []
  const turns: TurnInfo[] = []
  const lost: string[] = []
  const errors: string[] = []
  stream.on('turn', turn => turns.push(turn))
  stream.on('error', err => errors.push(err.message))
  stream.on('open', () => events.push('open'))
  stream.on('lost', why => {
    lost.push(why)
    events.push('lost')
  })
  stream.on('close', () => events.push('close'))
  const last = () => sockets[sockets.length - 1]
  return { stream, sockets, liveAtConnect, last, events, turns, lost, errors }
}

function fakeTime(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: 1_000_000 })
  // The stream logs its states: kept out of the test output.
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  return (ms: number) => t.mock.timers.tick(ms)
}

test('a dropped stream is opened again on the next audio frame, and the newest 2 s of audio (no more) are sent first', t => {
  const tick = fakeTime(t)
  const f = flux()
  f.last().open()
  f.stream.send(frame(1))
  assert.equal(f.last().audio().length, 1)
  f.last().drop(1011)
  tick(1000)
  assert.equal(f.sockets.length, 1, 'nothing is tried before audio comes')
  for (let i = 0; i < 30; i++) f.stream.send(frame(100 + i))
  tick(0)
  assert.equal(f.sockets.length, 2, 'tried at once')
  f.stream.send(frame(200)) // while the new stream opens
  f.last().open()
  const sent = f.last().audio()
  assert.equal(FLUX_BACKLOG_BYTES, 64_000)
  assert.equal(sent.reduce((n, b) => n + b.length, 0), FLUX_BACKLOG_BYTES)
  assert.deepEqual(
    sent.map(b => b[0]),
    [...Array.from({ length: 24 }, (_, i) => 106 + i), 200],
    'the newest, in order',
  )
  f.stream.send(frame(201))
  assert.equal(f.last().audio().at(-1)?.[0], 201, 'then straight on')
  assert.deepEqual(f.events, ['open', 'open'])
  assert.deepEqual(f.lost, [])
})

test("no reconnect is tried while no audio comes (the page is away), and no 'lost' is emitted", t => {
  const tick = fakeTime(t)
  const f = flux()
  f.last().open()
  f.last().drop(1011)
  tick(120_000)
  assert.equal(f.sockets.length, 1)
  assert.deepEqual(f.lost, [])
  // A moment of audio (the page came back, then went again) asks for one try, and no more once it stops.
  f.stream.send(frame(1))
  tick(0)
  assert.equal(f.sockets.length, 2)
  f.last().fail()
  tick(120_000)
  assert.equal(f.sockets.length, 2)
  assert.deepEqual(f.lost, [], 'nobody was unheard for 5 s')
})

test("a refused key or account (401, 402, 403), a bad request (400) or address (404) is final: 'lost' at once, never retried, later audio dropped", t => {
  const tick = fakeTime(t)
  for (const status of [400, 401, 402, 403, 404]) {
    const f = flux()
    f.stream.send(frame(1)) // kept while the stream opens
    f.last().refuse(status, '{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}')
    assert.deepEqual(f.lost, [`Deepgram refused the connection (${status})`], String(status))
    assert.ok(f.last().terminated, 'the handshake is let go')
    assert.ok(f.errors.some(e => e.includes(`(${status})`) && e.includes('Invalid credentials.')), "Deepgram's reason goes to the log")
    for (let i = 0; i < 100; i++) {
      f.stream.send(frame(i))
      tick(80)
    }
    tick(120_000)
    assert.equal(f.sockets.length, 1, `${status} is never tried again`)
    assert.equal(f.lost.length, 1)
    assert.equal((f.stream as any).backlogBytes, 0, 'no audio piles up')
    f.last().open() // too late: nothing listens to it
    assert.deepEqual(f.events, ['lost'])
  }
})

test("an Error Deepgram can't recover from (UNPARSABLE_CLIENT_MESSAGE) is final, and the turn it cut is still delivered", t => {
  const tick = fakeTime(t)
  const f = flux()
  f.last().open()
  f.last().turn('StartOfTurn', 'Alex, please')
  f.last().turn('Update', 'Alex, please leave')
  f.last().say({ type: 'Error', code: 'UNPARSABLE_CLIENT_MESSAGE', description: 'Could not parse the message.' })
  assert.ok(f.last().terminated)
  assert.deepEqual(f.turns.at(-1), { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'Alex, please leave', trigger: 'dropped' })
  assert.deepEqual(f.lost, ['Deepgram: UNPARSABLE_CLIENT_MESSAGE'])
  assert.ok(f.errors.includes('Deepgram: Could not parse the message. (UNPARSABLE_CLIENT_MESSAGE)'))
  f.stream.send(frame(1))
  tick(120_000)
  assert.equal(f.sockets.length, 1)
})

test('429, 5xx, network errors and unknown Error codes are retried on the schedule, and a stream that stayed up 10 s resets it', t => {
  const tick = fakeTime(t)
  const f = flux()
  // Audio comes in once; the next try is due exactly `wait` ms later, and not a millisecond before.
  const triedAfter = (wait: number) => {
    const before = f.sockets.length
    f.stream.send(frame(0))
    if (wait > 0) {
      tick(wait - 1)
      assert.equal(f.sockets.length, before, `not before ${wait} ms`)
    }
    tick(wait > 0 ? 1 : 0)
    assert.equal(f.sockets.length, before + 1, `after ${wait} ms`)
  }
  assert.deepEqual(FLUX_RETRY_MS, [0, 500, 1000, 2000, 5000, 10_000])
  f.last().open()
  tick(1000)
  f.last().drop(1011)
  triedAfter(0)
  f.last().refuse(429, '{"err_msg":"Too many requests"}')
  triedAfter(500)
  f.last().refuse(503)
  triedAfter(1000)
  f.last().fail()
  triedAfter(2000)
  f.last().open()
  f.last().say({ type: 'Error', code: 'SOMETHING_NEW', description: 'Something went wrong.' })
  assert.ok(f.last().terminated, 'a stream that sent an Error is over')
  triedAfter(5000)
  f.last().refuse(502)
  triedAfter(10_000)
  f.last().fail()
  triedAfter(30_000)
  f.last().fail()
  triedAfter(30_000)
  // Open, but not for long: still backing off.
  f.last().open()
  tick(9000)
  f.last().drop(1006)
  triedAfter(30_000)
  // Open for 10 s: the next drop starts from the first wait again.
  f.last().open()
  tick(10_000)
  f.last().drop(1011)
  triedAfter(0)
  f.last().fail()
  triedAfter(500)
  assert.deepEqual(f.liveAtConnect, Array(f.sockets.length).fill(0))
})

test("down for 5 s while audio comes in: 'lost' once; open again: 'open'", t => {
  const tick = fakeTime(t)
  const f = flux()
  const opened = new Set<FakeDeepgram>()
  // The page's 80 ms frames for `ms`, with each try failing as it is made, or opening.
  const audioFor = (ms: number, tries: 'fail' | 'open' = 'fail') => {
    for (let at = 0; at < ms; at += 80) {
      f.stream.send(frame(at))
      tick(80)
      const socket = f.last()
      if (socket.gone || opened.has(socket)) continue
      if (tries === 'fail') {
        socket.fail()
      } else {
        opened.add(socket)
        socket.open()
      }
    }
  }
  opened.add(f.last())
  f.last().open()
  f.last().drop(1011)
  audioFor(4960)
  assert.deepEqual(f.lost, [], 'not for a blip')
  audioFor(160)
  assert.deepEqual(f.lost, ['no stream to Deepgram for 5 s'])
  audioFor(60_000)
  assert.equal(f.lost.length, 1, 'once')
  audioFor(30_080, 'open')
  assert.deepEqual(f.events, ['open', 'lost', 'open'])
  tick(10_000)
  // A short drop says nothing, and the next loss is said again.
  f.last().drop(1011)
  audioFor(2000, 'open')
  assert.deepEqual(f.events, ['open', 'lost', 'open', 'open'])
  f.last().drop(1011)
  audioFor(6000)
  assert.deepEqual(f.events, ['open', 'lost', 'open', 'open', 'lost'])
})

test("a turn in progress when the stream drops is delivered as EndOfTurn with its last Update text (trigger 'dropped')", t => {
  const tick = fakeTime(t)
  const f = flux()
  f.last().open()
  // Flux sends Updates with no words between turns: that is not a turn.
  f.last().turn('Update', '')
  f.last().drop(1011)
  assert.deepEqual(f.turns.map(turn => turn.event), ['Update'])
  f.stream.send(frame(1))
  tick(0)
  f.last().open()
  f.last().turn('StartOfTurn', 'Alex, what is', { turn_index: 3 })
  f.last().turn('Update', 'Alex, what is the status of', { turn_index: 3 })
  f.last().drop(1006)
  assert.deepEqual(f.turns.at(-1), { type: 'TurnInfo', event: 'EndOfTurn', turn_index: 3, transcript: 'Alex, what is the status of', trigger: 'dropped' })
  // A turn that ended is not ended again by a drop.
  f.stream.send(frame(2))
  tick(500)
  f.last().open()
  f.last().turn('StartOfTurn', 'Thanks')
  f.last().turn('EndOfTurn', 'Thanks, Alex.', { trigger: 'model' })
  f.last().drop(1011)
  assert.deepEqual(
    f.turns.map(turn => `${turn.event}${turn.trigger ? ` ${turn.trigger}` : ''}`),
    ['Update', 'StartOfTurn', 'Update', 'EndOfTurn dropped', 'StartOfTurn', 'EndOfTurn model'],
  )
})

test("close() sends ForceEndTurn (only when a turn is in progress) then CloseStream, and 'close' is emitted once, only for that close and never for a drop", t => {
  const tick = fakeTime(t)
  // Drops are not the end: no 'close'.
  const dropped = flux()
  dropped.last().open()
  dropped.last().drop(1011)
  dropped.stream.send(frame(1))
  tick(0)
  dropped.last().open()
  dropped.last().drop(1005) // the code a CloseStream close has too
  tick(60_000)
  assert.deepEqual(dropped.events, ['open', 'open'])
  // Asked to close while down: 'close' comes after the call has returned, once.
  dropped.stream.send(frame(2))
  dropped.stream.close()
  assert.equal((dropped.stream as any).backlogBytes, 0, 'the audio kept for the next stream is let go')
  assert.deepEqual(dropped.events, ['open', 'open'])
  tick(0)
  dropped.stream.close()
  tick(60_000)
  assert.deepEqual(dropped.events, ['open', 'open', 'close'])
  assert.equal(dropped.sockets.length, 2, 'the try that audio had asked for is not made')

  // No turn in progress: CloseStream alone, and no audio after it.
  const idle = flux()
  idle.last().open()
  idle.last().turn('Update', '')
  idle.stream.close()
  idle.stream.send(frame(1))
  assert.deepEqual(idle.last().controls(), ['CloseStream'])
  assert.deepEqual(idle.last().audio(), [])
  idle.last().drop(1005)
  idle.stream.close()
  tick(60_000)
  assert.deepEqual(idle.events, ['open', 'close'])
  assert.equal(idle.last().terminated, false, 'Deepgram closed it in time')

  // A turn in progress: ForceEndTurn first, and its EndOfTurn comes before the stream closes.
  const talking = flux()
  talking.last().open()
  talking.last().turn('StartOfTurn', 'Alex, one more')
  talking.stream.close()
  assert.deepEqual(talking.last().controls(), ['ForceEndTurn', 'CloseStream'])
  talking.last().turn('EndOfTurn', 'Alex, one more thing.', { trigger: 'manual' })
  talking.last().drop(1005)
  assert.deepEqual(talking.turns.map(turn => turn.trigger ?? turn.event), ['StartOfTurn', 'manual'])
  assert.deepEqual(talking.events, ['open', 'close'])

  // Deepgram never closes it: cut after FLUX_CLOSE_WAIT_MS, with the turn it had not ended.
  const stuck = flux()
  const order: string[] = []
  stuck.stream.on('turn', turn => order.push(turn.trigger ?? turn.event))
  stuck.stream.on('close', () => order.push('close'))
  stuck.last().open()
  stuck.last().turn('StartOfTurn', 'Alex, and')
  stuck.stream.close()
  tick(999)
  assert.deepEqual(stuck.events, ['open'])
  tick(1)
  assert.ok(stuck.last().terminated)
  assert.deepEqual(order, ['StartOfTurn', 'dropped', 'close'], 'the last words come before the close the meeting waits for')
  assert.deepEqual(stuck.events, ['open', 'close'])
  stuck.last().drop(1006) // ws's own close after terminate
  assert.deepEqual(stuck.events, ['open', 'close'])

  // Still connecting: let go at once, and a late open changes nothing.
  const connecting = flux()
  connecting.stream.close()
  assert.ok(connecting.last().terminated)
  connecting.last().open()
  tick(0)
  assert.deepEqual(connecting.events, ['close'])

  // Refused for good: closes all the same, once.
  const refused = flux()
  refused.last().refuse(401)
  refused.stream.close()
  tick(0)
  assert.deepEqual(refused.events, ['lost', 'close'])
})

test('forceEndTurn() sends ForceEndTurn only with an open stream and a turn in progress', t => {
  fakeTime(t)
  const f = flux()
  f.stream.forceEndTurn()
  f.last().open()
  f.stream.forceEndTurn()
  f.last().turn('Update', '')
  f.stream.forceEndTurn()
  assert.deepEqual(f.last().controls(), [])
  f.last().turn('StartOfTurn', 'Alex, can you')
  f.stream.forceEndTurn()
  assert.deepEqual(f.last().controls(), ['ForceEndTurn'])
  f.last().turn('EndOfTurn', 'Alex, can you', { trigger: 'manual' })
  f.stream.forceEndTurn()
  assert.deepEqual(f.last().controls(), ['ForceEndTurn'])
})

test('the old socket is terminated before a new one opens, and KeepAlive is never sent', t => {
  const tick = fakeTime(t)
  const f = flux()
  f.last().open()
  tick(120_000) // no audio: nothing is sent to keep the stream open
  f.last().say({ type: 'Error', code: 'INTERNAL_SERVER_ERROR', description: 'Internal error.' })
  f.stream.send(frame(1))
  tick(0)
  f.last().refuse(429)
  f.stream.send(frame(2))
  tick(500)
  f.last().open()
  f.last().drop(1011)
  f.stream.send(frame(3))
  tick(1000)
  f.last().open()
  tick(120_000)
  f.stream.close()
  tick(1000)
  assert.equal(f.sockets.length, 4)
  assert.deepEqual(f.liveAtConnect, [0, 0, 0, 0])
  for (const socket of f.sockets) assert.ok(!socket.controls().includes('KeepAlive'))
})

test('a try that throws as it starts is logged and made again on the next audio, without taking the service down', t => {
  const tick = fakeTime(t)
  const errors: string[] = []
  let calls = 0
  let socket = new FakeDeepgram('')
  const stream = new FluxStream({
    keyterms: [],
    connect: () => {
      if (++calls === 2) throw new Error('getaddrinfo EAI_AGAIN')
      socket = new FakeDeepgram('')
      return socket as unknown as FluxSocket
    },
  })
  stream.on('error', err => errors.push(err.message))
  socket.open()
  socket.drop(1011)
  stream.send(frame(1))
  assert.doesNotThrow(() => tick(0))
  assert.deepEqual(errors, ['getaddrinfo EAI_AGAIN'])
  stream.send(frame(2))
  tick(500)
  assert.equal(calls, 3)
  socket.open()
  assert.deepEqual(socket.audio().map(b => b[0]), [1, 2])
})

test('a missing DEEPGRAM_API_KEY still stops the stream from starting, as it stops the meeting session', t => {
  t.after(() => void (process.env.DEEPGRAM_API_KEY = KEY))
  delete process.env.DEEPGRAM_API_KEY
  let tried = 0
  const connect = () => (tried++, new FakeDeepgram('') as unknown as FluxSocket)
  assert.throws(() => new FluxStream({ keyterms: [], connect }), /DEEPGRAM_API_KEY is not set/)
  assert.equal(tried, 0)
})

test('a refused handshake is let go with the real ws client: no socket left connecting and no audio piling up', async () => {
  // A stand-in for Deepgram that refuses every stream: 401 first, then 503.
  let status = 401
  const server = http.createServer()
  server.on('upgrade', (_req, socket) => {
    const body = status === 401 ? '{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}' : 'unavailable'
    socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const opened: WebSocket[] = []
  const open = () => {
    const errors: string[] = []
    const lost: string[] = []
    const stream = new FluxStream({
      keyterms: [],
      timing: { retryMs: [0], slowRetryMs: 5 },
      connect: () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        opened.push(ws)
        return ws
      },
    })
    stream.on('error', err => errors.push(err.message))
    stream.on('lost', why => lost.push(why))
    return { stream, errors, lost }
  }
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  try {
    const final = open()
    for (let i = 0; i < 20 && !final.lost.length; i++) await sleep(10)
    await sleep(20)
    assert.deepEqual(final.lost, ['Deepgram refused the connection (401)'])
    assert.ok(final.errors.some(e => e.includes('Invalid credentials.')), final.errors.join('\n'))
    assert.equal(opened[0].readyState, WebSocket.CLOSED, 'not left connecting')
    for (let i = 0; i < 100; i++) final.stream.send(frame(i))
    assert.equal((final.stream as any).backlogBytes, 0)

    status = 503
    const retried = open()
    for (let i = 0; i < 100; i++) {
      retried.stream.send(frame(i))
      await sleep(2)
    }
    await sleep(50)
    assert.ok(opened.length > 3, `${opened.length} tries`)
    assert.deepEqual(retried.lost, [])
    assert.ok((retried.stream as any).backlogBytes <= FLUX_BACKLOG_BYTES)
    retried.stream.close()
    await sleep(50)
    for (const ws of opened) assert.equal(ws.readyState, WebSocket.CLOSED)
  } finally {
    server.close()
  }
})

test('nothing FluxStream logs or reports holds what was said, its address or its key', t => {
  const tick = fakeTime(t)
  const logged: string[] = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => void logged.push(args.map(String).join(' ')))
  }
  const words = 'the launch code is tango seven'
  const f = flux()
  f.stream.on('turn', () => {})
  f.last().open()
  f.last().turn('StartOfTurn', words)
  f.last().turn('Update', words)
  f.last().emit('message', Buffer.from(`${words}, not JSON`), false)
  f.stream.send(frame(1))
  f.last().drop(1011) // while audio comes in: a warning
  for (let at = 0; at < 6000; at += 80) {
    f.stream.send(frame(at))
    tick(80)
    if (!f.last().gone) f.last().fail()
  }
  tick(30_000)
  f.stream.send(frame(2))
  tick(30_000)
  f.last().open()
  f.last().turn('StartOfTurn', words)
  tick(10_000)
  f.last().drop(1011) // after the page went quiet: just a note
  f.stream.send(frame(3))
  tick(0)
  f.last().refuse(401, '{"err_msg":"Invalid credentials."}')
  f.stream.close()
  tick(0)
  const reported = [...logged, ...f.errors, ...f.lost]
  assert.ok(logged.some(line => line.includes('[stt] Deepgram dropped the stream (1011)')), logged.join('\n'))
  assert.ok(f.turns.some(turn => turn.trigger === 'dropped' && turn.transcript === words))
  for (const line of reported) {
    assert.doesNotMatch(line, /launch code|tango|wss:|deepgram\.com|keyterm|listen\?/, line)
    assert.ok(!line.includes(KEY), line)
  }
})
