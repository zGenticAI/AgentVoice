// Stand-ins for what the bot page's link (createLink in public/agent.js) takes from the browser: a clock whose time the
// test moves, with its timers, and connections the test speaks for the service on.
import type { LinkSocket } from '../../public/agent.js'

/** A clock in ms, and timers that run only when the test moves it on, in the order they are due. */
export class FakeClock {
  time = 0
  private timers: { at: number; run: () => void; id: number }[] = []
  private ids = 0
  now = () => this.time
  setTimeout = (run: () => void, ms: number) => {
    const id = ++this.ids
    this.timers.push({ at: this.time + Math.max(0, ms), run, id })
    return id
  }
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter(t => t.id !== id)
  }
  /** Moves the clock on by ms, running each timer due on the way when it is due. */
  tick(ms: number) {
    const end = this.time + ms
    for (;;) {
      const next = this.timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!next) break
      this.timers = this.timers.filter(t => t !== next)
      this.time = next.at
      next.run()
    }
    this.time = end
  }
  /** Timers still to run. */
  get pending() {
    return this.timers.length
  }
}

/** A connection the page opened: the test says what the service says on it. */
export class FakeSocket implements LinkSocket {
  binaryType = 'blob'
  readyState = 0 // CONNECTING
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  sent: unknown[] = []
  /** The page closed it (let it go). */
  closed = false
  constructor(readonly url: string) {}
  send(data: unknown) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    if (this.readyState < 2) this.readyState = 2 // CLOSING: a dead one closes a minute later, if at all
  }
  /** The URL's query, as an object. */
  get query() {
    return Object.fromEntries(new URL(this.url).searchParams)
  }
  /** The service accepts it and says 'ready', with the meeting's rejoin secret. */
  ready(rejoin = 'secret-1') {
    this.readyState = 1 // OPEN
    this.say({ type: 'ready', sampleRate: 16000, rejoin })
  }
  /** A message from the service. */
  say(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** A piece of the voice, this many bytes long. */
  voice(bytes: number) {
    this.onmessage?.({ data: new Int16Array(bytes / 2).fill(0x2000).buffer })
  }
  /** It closes, with this code. */
  drop(code = 1006) {
    this.readyState = 3 // CLOSED
    this.onclose?.({ code })
  }
}

/** A WebSocket class for createLink's env, and every connection made with it, in order. */
export function fakeSockets() {
  const made: FakeSocket[] = []
  class WebSocket extends FakeSocket {
    constructor(url: string) {
      super(url)
      made.push(this)
    }
  }
  return {
    WebSocket,
    made,
    /** The latest connection. */
    get last(): FakeSocket {
      const sock = made.at(-1)
      if (!sock) throw new Error('no connection made')
      return sock
    },
  }
}
