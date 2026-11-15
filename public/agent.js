// The bot page's audio, inside the Recall.ai bot: streams the meeting's audio to the voice service as
// 16 kHz PCM16, and plays the assistant's voice back into the meeting. Its link to the service mends itself when the
// network drops (createLink).
const RATE = 16000
const CHUNK = 1280 // 80 ms, as Deepgram Flux recommends
// A piece of the assistant's voice starts this long after it arrives when nothing is playing (s): the service
// reckons with the same lead (PAGE_LEAD_MS in src/pipeline/playback.ts).
const LEAD = 0.05
// How long the voice fades out on a pause, and back in on resume (s): stopping a wave mid-swing clicks.
const FADE = 0.01
// WebSocket.OPEN.
const OPEN = 1

// The link to the service (createLink). The service says something every second, so a connection that has said
// nothing for this long (ms) since 'ready' is taken as dead.
export const PAGE_SILENCE_MS = 4000
// A try that hasn't said 'ready' by then (ms) is given up on: a tunnel can take a connection and never pass it on.
export const CONNECT_TIMEOUT_MS = 5000
// The wait before each try after the link is lost (ms), the last one again and again: each wait is between half and
// all of it, the first short since most drops mend at once.
export const RETRY_MS = [250, 500, 1000, 2000, 4000, 5000]
// The page stops trying this long after the link was lost (ms): the service gives a page a minute to come back, then
// ends the meeting's session and lets no page in.
export const GIVE_UP_MS = 75_000
// The close codes that mean don't come back: the meeting's session is over (4000) or could not start (4003). Any
// other close, and any refusal (which a browser only sees as 1006), the page tries again.
export const FINAL_CODES = new Set([4000, 4003])

export async function startAgent({ onState, onOutput }) {
  const params = new URLSearchParams(location.search)
  const wsUrl = new URL('/audio', location.href)
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  wsUrl.search = new URLSearchParams({ key: params.get('key') || '', token: params.get('token') || '' })

  // One context for both ways: never suspended (see createPlayer).
  const ctx = new AudioContext({ sampleRate: RATE })
  await ctx.resume()
  await ctx.audioWorklet.addModule('/pcm-worklet.js')

  // In the bot, this is the meeting's audio (without the assistant).
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  })
  const source = ctx.createMediaStreamSource(stream)
  const capture = new AudioWorkletNode(ctx, 'capture')
  source.connect(capture)

  // The assistant's voice passes through an analyser on its way out, so the bot page can draw it.
  const output = ctx.createAnalyser()
  output.fftSize = 256
  output.smoothingTimeConstant = 0.6
  output.connect(ctx.destination)
  onOutput?.(output)

  // From here on a failure is the link's to mend, and the page's to show: startAgent has started.
  const voice = connectVoice(wsUrl.href, { ctx, output, onState })

  // A frame the link can't take now is dropped: the meeting's audio is live, and none piles up meanwhile.
  const frames = createFramer(frame => voice.send(frame))
  capture.port.onmessage = ({ data }) => frames(data)

  return () => {
    voice.close()
    stream.getTracks().forEach(t => t.stop())
    ctx.close()
  }
}

// What the page shows while speech recognition can't hear the meeting: the service's fixed words for it
// (PAGE_ERRORS.hearing in src/pipeline/session.ts). It stays up until the service says it hears again.
const HEARING_LOST = "can't hear the meeting"

/**
 * Joins the link to the service (createLink) to the player (createPlayer), and tells onState what the page is doing,
 * by what matters most: 'speaking' while the voice plays, then 'reconnecting' or 'disconnected' while the link is down,
 * then the last error the service sent ('error: ' and its fixed words), then 'listening'. Nothing until the service
 * first says 'ready', or the link first fails. send(frame) sends a frame of the meeting's audio, or drops it (false)
 * while the link is not ready. env goes to createLink.
 */
export function connectVoice(url, { ctx, output, onState }, env) {
  let speaking = false
  // The link's state while it is down: '' once the service has said 'ready'.
  let down = ''
  let error = ''
  let shown = ''
  function render() {
    const state = speaking ? 'speaking' : down || (error ? 'error: ' + error : 'listening')
    if (state === shown) return
    shown = state
    onState?.(state)
  }

  const player = createPlayer(ctx, output, playing => {
    speaking = playing
    // An answer that failed is behind the page once the voice plays again; not hearing the meeting is not.
    if (playing && error !== HEARING_LOST) error = ''
    render()
  })

  const link = createLink(
    url,
    {
      onAudio: data => player.play(data),
      onControl(msg) {
        if (msg.type === 'ready') down = ''
        else if (msg.type === 'clear') player.clear()
        else if (msg.type === 'pause') player.pause()
        else if (msg.type === 'resume') player.resume()
        else if (msg.type === 'error') error = String(msg.message ?? '')
        else if (msg.type === 'hearing') error = ''
        // 'speaking': the page goes by what it plays.
        else return
        render()
      },
      onState(state) {
        down = state
        // Only the service ends a pause, and it can't now: what the page held will never play. It is thrown away, and
        // left out of got, so the service learns the page never played it.
        if (player.paused) link.discard(player.clear())
        render()
      },
    },
    env,
  )

  return { send: frame => link.send(frame), close: () => link.close() }
}

/**
 * The page's link to the service: one connection at a time, opened again by itself when it drops, since nothing
 * reloads the page in the bot. url is the service's /audio address, with the meeting's key and the page token. Each try
 * adds n, counting up for as long as the page is loaded, so the service can tell a try the page gave up on, arriving
 * late, from the one in use. Once the service has said 'ready', each try also adds rejoin, the secret 'ready' carried,
 * and got: the bytes of the assistant's voice the page has had since it loaded, less what it threw away itself
 * (discard). The secret lets this page, and no other, back into the meeting; got tells the service how much of what it
 * sent the meeting can have heard.
 *
 * onAudio(data): a piece of the voice. onControl(msg): every other message but the heartbeat. onState(state):
 * 'reconnecting' when the link is lost and the page will try again, 'disconnected' when it stops trying for good: the
 * service said not to come back, or GIVE_UP_MS went by. The next 'ready' (onControl) means it is back.
 *
 * env: a test's stand-ins for the browser's WebSocket, clock, timers and random numbers.
 */
export function createLink(url, { onAudio, onControl, onState }, env = {}) {
  const Socket = env.WebSocket ?? globalThis.WebSocket
  // Not the wall clock: it can jump, and fake a silence or hide one.
  const now = env.now ?? (() => performance.now())
  const later = env.setTimeout ?? ((run, ms) => setTimeout(run, ms))
  const cancel = env.clearTimeout ?? (timer => clearTimeout(timer))
  const random = env.random ?? Math.random

  // The connection in use, or the try under way; null between tries.
  let ws = null
  // It has said 'ready'.
  let ready = false
  // When the try began, and when the connection last said anything.
  let opened = 0
  let heard = 0
  // Tries since the page loaded (n), and since the last 'ready' (how long to wait before the next).
  let n = 0
  let tries = 0
  let rejoin = ''
  let got = 0
  // Timers. giveUp runs from when the link is lost until the next 'ready'.
  let watchdog, retry, giveUp

  function connect() {
    retry = undefined
    const to = new URL(url)
    to.searchParams.set('n', String(++n))
    if (rejoin) {
      to.searchParams.set('rejoin', rejoin)
      to.searchParams.set('got', String(got))
    }
    let sock
    try {
      sock = new Socket(to.href)
    } catch {
      // A browser that won't open one now: a try that failed like any other.
      return lost()
    }
    sock.binaryType = 'arraybuffer'
    ws = sock
    ready = false
    opened = heard = now()
    sock.onmessage = ({ data }) => {
      // A connection the page has let go of can still deliver what was on its way: none of it is the page's now.
      if (sock !== ws) return
      heard = now()
      if (typeof data !== 'string') {
        got += data.byteLength
        return onAudio(data)
      }
      let msg
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object' || msg.type === 'hb') return
      if (msg.type === 'ready') {
        ready = true
        // The same secret every time, so a 'ready' lost on the way changes nothing: the next try has it already.
        if (typeof msg.rejoin === 'string' && msg.rejoin) rejoin = msg.rejoin
        tries = 0
        cancel(giveUp)
        giveUp = undefined
        watch()
      }
      onControl(msg)
    }
    sock.onclose = ({ code }) => {
      if (sock === ws) lost(code)
    }
    watch()
  }

  // A connection that stops answering stays open in the browser, which can't see that it has. So the service says
  // something at least every second (a heartbeat when it has nothing else), and the page gives up on a connection that
  // has said nothing for PAGE_SILENCE_MS since 'ready', or not said 'ready' within CONNECT_TIMEOUT_MS. One timer,
  // moved on only when it fires: every message would be too often.
  function watch() {
    cancel(watchdog)
    const due = ready ? heard + PAGE_SILENCE_MS : opened + CONNECT_TIMEOUT_MS
    if (now() >= due) return lost()
    watchdog = later(watch, due - now())
  }

  // Lets the connection go without waiting for it to close, which takes a dead one a minute, and tries again, or stops.
  function lost(code) {
    letGo()
    if (FINAL_CODES.has(code)) return stop()
    giveUp ??= later(stop, GIVE_UP_MS)
    onState('reconnecting')
    retry = later(connect, retryDelay(tries++, random))
  }

  function letGo() {
    cancel(watchdog)
    const sock = ws
    ws = null
    ready = false
    sock?.close()
  }

  function stop() {
    cancel(retry)
    cancel(giveUp)
    letGo()
    onState('disconnected')
  }

  connect()
  return {
    /** Sends a frame of the meeting's audio, or drops it (false) while the link is not ready. */
    send(frame) {
      if (!ready || ws.readyState !== OPEN) return false
      ws.send(frame)
      return true
    },
    /** The page threw away this many bytes of the voice it had, unplayed: the next try's got leaves them out. */
    discard(bytes) {
      got = Math.max(0, got - Math.round(bytes))
    },
    /** Closes the link for good, and says nothing more. */
    close() {
      cancel(retry)
      cancel(giveUp)
      letGo()
    },
  }
}

/** The wait before try `tries` after the link was lost (0 for the first, in ms): between half and all of RETRY_MS's. */
export function retryDelay(tries, random = Math.random) {
  const ms = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]
  return ms / 2 + (random() * ms) / 2
}

/**
 * Turns the capture worklet's blocks of samples (-1 to 1) into frames of CHUNK PCM16 samples, and gives each one to
 * send as soon as it is full: a frame of its own, which send may keep or drop. It fills one frame in place, so memory
 * stays the same however long the frames are dropped.
 */
export function createFramer(send) {
  const frame = new Int16Array(CHUNK)
  let filled = 0
  return samples => {
    for (let i = 0; i < samples.length; i++) {
      frame[filled++] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff
      if (filled < CHUNK) continue
      filled = 0
      send(frame.slice())
    }
  }
}

/**
 * Plays the assistant's voice through `output`: each piece straight after the one before it, or LEAD after it arrives
 * when nothing is playing. It can pause (it stops where it is, with a short fade, and holds the rest of each piece and
 * whatever arrives meanwhile), resume (it plays what it held from LEAD on, back to back) and clear (it drops everything,
 * a pause included, and says how much of the voice it dropped). The service follows this exactly to tell what the
 * meeting heard (src/pipeline/playback.ts), so a change here must be made there too. onChange(true) as a piece is
 * scheduled, onChange(false) once nothing is playing.
 *
 * It never suspends ctx to pause: the capture worklet runs on the same context, and a suspended context would stop
 * the meeting's audio reaching speech recognition. It stops the pieces instead, and starts them again from where
 * they were.
 */
export function createPlayer(ctx, output, onChange) {
  const voice = ctx.createGain()
  voice.connect(output)
  // When the last piece scheduled ends (ctx time).
  let playHead = 0
  // The pieces scheduled, each with when its first sample plays (start), even when it starts partway (offset).
  const playing = new Set()
  // How far into its audio a piece has played by `now` (s): from where it starts, which may be later than now.
  const playedTo = (piece, now) => Math.max(piece.offset, now - piece.start)
  let paused = false
  // While paused: what is left of each piece, in the order it plays, then each piece that arrived meanwhile.
  let held = []

  function schedule(audio, offset = 0) {
    const node = ctx.createBufferSource()
    node.buffer = audio
    node.connect(voice)
    playHead = Math.max(playHead, ctx.currentTime + LEAD)
    node.start(playHead, offset)
    const piece = { node, audio, start: playHead - offset, offset }
    playHead += audio.duration - offset
    playing.add(piece)
    node.onended = () => {
      playing.delete(piece)
      if (!playing.size) onChange(false)
    }
    onChange(true)
  }

  /** A piece of the voice arrived (PCM16, RATE): it plays after what is queued, or is held while paused. */
  function play(buffer) {
    const pcm = new Int16Array(buffer)
    const audio = ctx.createBuffer(1, pcm.length, RATE)
    const out = audio.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000
    if (paused) held.push({ audio, offset: 0 })
    else schedule(audio)
  }

  function pause() {
    if (paused) return
    paused = true
    const now = ctx.currentTime
    // The fade's 10 ms are played again on resume: each piece is held from now, so nothing is lost.
    voice.gain.cancelScheduledValues(0)
    voice.gain.setValueAtTime(1, now)
    voice.gain.linearRampToValueAtTime(0, now + FADE)
    for (const piece of playing) {
      piece.node.onended = null
      piece.node.stop(now + FADE)
      // A piece resumed partway that has not started again yet is held from where it was, so none of it plays twice.
      const offset = playedTo(piece, now)
      if (offset < piece.audio.duration) held.push({ audio: piece.audio, offset })
    }
    playing.clear()
    playHead = 0
    onChange(false)
  }

  function resume() {
    if (!paused) return
    paused = false
    const pieces = held
    held = []
    // The voice stays down until the first piece held starts, fades in with it, and is up for whatever comes after.
    const at = ctx.currentTime + LEAD
    voice.gain.cancelScheduledValues(0)
    voice.gain.setValueAtTime(0, ctx.currentTime)
    voice.gain.setValueAtTime(0, at)
    voice.gain.linearRampToValueAtTime(1, at + FADE)
    for (const { audio, offset } of pieces) schedule(audio, offset)
  }

  /** Drops what it has not played, and ends a pause. Returns how much of the voice it dropped, in bytes of PCM16. */
  function clear() {
    const now = ctx.currentTime
    let dropped = 0 // s
    for (const piece of playing) {
      piece.node.onended = null
      piece.node.stop()
      dropped += Math.max(0, piece.audio.duration - playedTo(piece, now))
    }
    for (const { audio, offset } of held) dropped += audio.duration - offset
    playing.clear()
    held = []
    paused = false
    playHead = 0
    voice.gain.cancelScheduledValues(0)
    voice.gain.setValueAtTime(1, now)
    onChange(false)
    return Math.round(dropped * RATE * 2)
  }

  return {
    play,
    pause,
    resume,
    clear,
    get paused() {
      return paused
    },
  }
}
