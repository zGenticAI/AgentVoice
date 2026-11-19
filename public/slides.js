// The slides page, shared as the bot's screen while the assistant presents: it shows one slide image at a time, as the
// voice service says, and tells the service once each is on screen. It is silent, and has nothing to do with the camera
// page or its audio. Slides arrive in pieces over its link (/slides-link) and are kept only while they are on screen or
// next: the service sends the slide to show and its neighbours, never the whole deck.
//
// The page never keeps a slide up without the service: when its link has been gone for BLANK_AFTER_MS, it shows its
// "paused" frame and drops every slide it holds, and when it gives up (GIVE_UP_MS) it shows "ended". On its own timers,
// so this holds when the service has stopped or the computer has slept.

// WebSocket.OPEN.
const OPEN = 1
// The service says something every second, so a link that has said nothing for this long (ms) is taken as dead.
export const SILENCE_MS = 4000
// A try that hasn't had the deck message by then (ms) is given up on.
export const CONNECT_TIMEOUT_MS = 5000
// The wait before each try after the link is lost (ms), as the camera page waits: each between half and all of it.
export const RETRY_MS = [250, 500, 1000, 2000, 4000, 5000]
// With no link for this long (ms), the page shows "paused" and drops its slides.
export const BLANK_AFTER_MS = 12_000
// It stops trying this long after the link was lost (ms), and shows "ended".
export const GIVE_UP_MS = 75_000
// Close codes that mean don't come back: the share is over (4000), or a newer link took this one's place (4001).
export const FINAL_CODES = new Set([4000, 4001])
// A piece of a slide: "AVSL", version 1, kind 1, the slide's index, the image's length and this piece's offset.
const HEADER_BYTES = 16
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_SLIDES = 100

/** The wait before try number `tries` (from 0), with equal jitter. */
export function retryDelay(tries, random = Math.random) {
  const top = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]
  return top / 2 + random() * (top / 2)
}

/**
 * Runs the page: url is the link's address (with the share's id and token), view what it shows (domView in the
 * browser, a test's stand-in otherwise). env: a test's stand-ins for the browser's WebSocket, Blob, object URLs, clock,
 * timers and random numbers. Returns close(), which stops it for good.
 */
export function createSlides(url, view, env = {}) {
  const Socket = env.WebSocket ?? globalThis.WebSocket
  const BlobOf = env.Blob ?? globalThis.Blob
  const objectUrl = env.createObjectURL ?? (blob => URL.createObjectURL(blob))
  const revokeUrl = env.revokeObjectURL ?? (u => URL.revokeObjectURL(u))
  const now = env.now ?? (() => performance.now())
  const later = env.setTimeout ?? ((run, ms) => setTimeout(run, ms))
  const cancel = env.clearTimeout ?? (timer => clearTimeout(timer))
  const random = env.random ?? Math.random

  let ws = null
  // This connection has had the deck message: it is the service's.
  let linked = false
  let opened = 0
  let heard = 0
  let tries = 0
  let over = false
  let watchdog, retry, blankTimer, giveUpTimer
  // The meeting's slides: how many, and which revision the slides held are of.
  let rev = null
  let count = 0
  // Slides being assembled, and those complete (as object URLs), by index.
  const parts = new Map()
  const images = new Map()
  // The service's window: what to keep. The slide it wants shown, and the one on screen.
  let keep = new Set()
  let want = null
  let onScreen = null
  let frameNow = 'starting'
  let diagSent = false
  // One slide is decoded and swapped in at a time.
  let presenting = Promise.resolve()

  view.frame('starting')

  function send(msg) {
    if (ws && linked && ws.readyState === OPEN) ws.send(JSON.stringify(msg))
  }

  function connect() {
    retry = undefined
    let sock
    try {
      sock = new Socket(url)
    } catch {
      return lost()
    }
    sock.binaryType = 'arraybuffer'
    ws = sock
    linked = false
    opened = heard = now()
    sock.onmessage = ({ data }) => {
      if (sock !== ws || over) return
      heard = now()
      if (typeof data !== 'string') return piece(data)
      let msg
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'deck') return deck(msg)
      if (!linked) return
      if (msg.type === 'show') return show(msg)
      if (msg.type === 'frame') return frame(msg)
    }
    sock.onclose = ({ code }) => {
      if (sock === ws) lost(code)
    }
    watch()
  }

  // A connection that stops answering can look open for a minute: the page gives up on one that has said nothing for
  // SILENCE_MS, or not sent the deck within CONNECT_TIMEOUT_MS.
  function watch() {
    cancel(watchdog)
    const due = linked ? heard + SILENCE_MS : opened + CONNECT_TIMEOUT_MS
    if (now() >= due) return lost()
    watchdog = later(watch, due - now())
  }

  function letGo() {
    cancel(watchdog)
    const sock = ws
    ws = null
    linked = false
    sock?.close()
  }

  // The link is gone: try again, and, from the first loss, blank after BLANK_AFTER_MS and stop after GIVE_UP_MS.
  function lost(code) {
    letGo()
    if (over) return
    if (FINAL_CODES.has(code)) return end()
    blankTimer ??= later(blank, BLANK_AFTER_MS)
    giveUpTimer ??= later(end, GIVE_UP_MS)
    retry = later(connect, retryDelay(tries++, random))
  }

  // No slide stays up without the service.
  function blank() {
    blankTimer = undefined
    if (over) return
    showFrame('paused')
    dropAll()
  }

  function end() {
    over = true
    for (const timer of [retry, blankTimer, giveUpTimer, watchdog]) cancel(timer)
    letGo()
    showFrame('ended')
    dropAll()
  }

  function showFrame(kind) {
    frameNow = kind
    want = null
    view.frame(kind)
  }

  function dropAll() {
    for (const u of images.values()) revokeUrl(u)
    images.clear()
    parts.clear()
    onScreen = null
    view.clear()
  }

  function deck(msg) {
    const n = msg.count
    if (!Number.isInteger(n) || n < 1 || n > MAX_SLIDES || typeof msg.rev !== 'string') return
    linked = true
    tries = 0
    cancel(blankTimer)
    cancel(giveUpTimer)
    blankTimer = giveUpTimer = undefined
    if (rev !== null && msg.rev !== rev) dropAll()
    rev = msg.rev
    count = n
    send({ type: 'hello', v: 1, rev, have: haveHex() })
    if (!diagSent) {
      diagSent = true
      send({ type: 'diag', ...view.diag() })
    }
    watch()
  }

  // The slides held, as a hex bitmap: bit i of byte i >> 3.
  function haveHex() {
    const bytes = new Uint8Array(Math.ceil(count / 8))
    for (const i of images.keys()) bytes[i >> 3] |= 1 << (i & 7)
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  }

  function show(msg) {
    const { i, seq } = msg
    if (!Number.isInteger(i) || i < 0 || i >= count || !Number.isInteger(seq)) return
    keep = new Set([i, ...(Array.isArray(msg.keep) ? msg.keep.filter(k => Number.isInteger(k) && k >= 0 && k < count) : [])])
    // Only the window and the slide on screen are kept.
    for (const [k, u] of images) {
      if (!keep.has(k) && k !== onScreen) {
        revokeUrl(u)
        images.delete(k)
      }
    }
    for (const k of parts.keys()) if (!keep.has(k)) parts.delete(k)
    want = { i, seq }
    present()
  }

  function frame(msg) {
    const kinds = ['starting', 'paused', 'ended']
    if (!kinds.includes(msg.kind)) return
    showFrame(msg.kind)
    if (msg.kind === 'ended') dropAll()
    send({ type: 'framed', seq: msg.seq })
  }

  // Shows the wanted slide once it is here: decoded into the hidden image, then swapped in, then acknowledged. Until it
  // is here, the slide on screen stays.
  function present() {
    if (!want) return
    const { i, seq } = want
    if (onScreen === i && frameNow === null) return send({ type: 'shown', i, seq })
    const u = images.get(i)
    if (!u) return
    presenting = presenting.then(async () => {
      if (over || !want || want.seq !== seq) return
      try {
        await view.load(u)
      } catch {
        if (images.get(i) === u) {
          revokeUrl(u)
          images.delete(i)
        }
        return send({ type: 'bad', i })
      }
      // Still wanted, and nothing blanked the page meanwhile.
      if (over || !want || want.seq !== seq || images.get(i) !== u) return
      view.swap()
      // The slide it replaced goes too, unless it is in the window.
      const before = onScreen
      onScreen = i
      frameNow = null
      if (before !== null && before !== i && !keep.has(before) && images.has(before)) {
        revokeUrl(images.get(before))
        images.delete(before)
      }
      send({ type: 'shown', i, seq })
    })
  }

  function piece(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_BYTES || !count) return
    const head = new DataView(data, 0, HEADER_BYTES)
    const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3))
    if (magic !== 'AVSL' || head.getUint8(4) !== 1 || head.getUint8(5) !== 1) return
    const i = head.getUint16(6)
    const total = head.getUint32(8)
    const offset = head.getUint32(12)
    const payload = new Uint8Array(data, HEADER_BYTES)
    if (i >= count || total < 1 || total > MAX_IMAGE_BYTES || offset + payload.length > total) return
    let part = parts.get(i)
    if (offset === 0) {
      part = { bytes: new Uint8Array(total), got: 0 }
      parts.set(i, part)
    }
    // Pieces come in order: anything else is dropped, and the slide comes again whole.
    if (!part || part.got !== offset || part.bytes.length !== total) return void parts.delete(i)
    part.bytes.set(payload, offset)
    part.got += payload.length
    if (part.got < total) return
    parts.delete(i)
    // One it holds already (sent again after a reconnect) is kept as it is.
    if ((!keep.has(i) && want?.i !== i) || images.has(i)) return
    images.set(i, objectUrl(new BlobOf([part.bytes], { type: 'image/webp' })))
    if (want?.i === i) present()
  }

  connect()
  return {
    close() {
      if (!over) end()
    },
  }
}

/** The page's elements: two stacked images (one shown, one loading) and the three frames. */
export function domView(doc) {
  const imgs = [doc.getElementById('a'), doc.getElementById('b')]
  const frames = { starting: doc.getElementById('starting'), paused: doc.getElementById('paused'), ended: doc.getElementById('ended') }
  let front = 0
  return {
    async load(u) {
      const back = imgs[1 - front]
      back.src = u
      await back.decode()
    },
    swap() {
      imgs[front].classList.remove('on')
      front = 1 - front
      imgs[front].classList.add('on')
      for (const el of Object.values(frames)) el.classList.remove('on')
    },
    frame(kind) {
      for (const [k, el] of Object.entries(frames)) el.classList.toggle('on', k === kind)
      for (const img of imgs) img.classList.remove('on')
    },
    clear() {
      for (const img of imgs) {
        img.classList.remove('on')
        img.removeAttribute('src')
      }
    },
    diag() {
      const major = Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? 0)
      return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, visibility: doc.visibilityState, ua_major: major }
    },
  }
}

// In the bot's browser only: the page marks itself, and a test that imports this file has no document.
if (typeof document !== 'undefined' && document.body?.dataset.slidesPage === '1') {
  const params = new URLSearchParams(location.search)
  const link = new URL('/slides-link', location.href)
  link.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  link.search = new URLSearchParams({ s: params.get('s') || '', t: params.get('t') || '' }).toString()
  createSlides(link.href, domView(document))
}
