// The bot page's audio, inside the Recall.ai bot: streams the meeting's audio to the voice service as
// 16 kHz PCM16, and plays the assistant's voice back into the meeting.
const RATE = 16000
const CHUNK = 1280 // 80 ms, as Deepgram Flux recommends
// A piece of the assistant's voice starts this long after it arrives when nothing is playing (s): the service
// reckons with the same lead (PAGE_LEAD_MS in src/pipeline/playback.ts).
const LEAD = 0.05
// How long the voice fades out on a pause, and back in on resume (s): stopping a wave mid-swing clicks.
const FADE = 0.01

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

  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'

  // A frame the socket can't take now is dropped: the meeting's audio is live, and none piles up meanwhile.
  const frames = createFramer(frame => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame)
  })
  capture.port.onmessage = ({ data }) => frames(data)

  // The assistant's voice passes through an analyser on its way out, so the bot page can draw it.
  const output = ctx.createAnalyser()
  output.fftSize = 256
  output.smoothingTimeConstant = 0.6
  output.connect(ctx.destination)
  onOutput?.(output)

  const player = createPlayer(ctx, output, speaking => onState?.(speaking ? 'speaking' : 'listening'))

  ws.onmessage = ({ data }) => {
    if (typeof data !== 'string') return player.play(data)
    const msg = JSON.parse(data)
    if (msg.type === 'clear') player.clear()
    if (msg.type === 'pause') player.pause()
    if (msg.type === 'resume') player.resume()
    if (msg.type === 'ready') onState?.('listening')
    if (msg.type === 'error') onState?.('error: ' + msg.message)
  }
  ws.onclose = () => {
    // Only the service ends a pause: with the socket gone, what the page held is never played.
    if (player.paused) player.clear()
    onState?.('disconnected')
  }
  return () => {
    ws.close()
    stream.getTracks().forEach(t => t.stop())
    ctx.close()
  }
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
 * a pause included). The service follows this exactly to tell what the meeting heard (src/pipeline/playback.ts), so a
 * change here must be made there too. onChange(true) as a piece is scheduled, onChange(false) once nothing is playing.
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
  let paused = false
  // While paused: what is left of each piece, in the order it plays, then each piece that arrived meanwhile.
  let held = []

  function schedule(audio, offset = 0) {
    const node = ctx.createBufferSource()
    node.buffer = audio
    node.connect(voice)
    playHead = Math.max(playHead, ctx.currentTime + LEAD)
    node.start(playHead, offset)
    const piece = { node, audio, start: playHead - offset }
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
      const offset = Math.max(0, now - piece.start)
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

  function clear() {
    for (const { node } of playing) {
      node.onended = null
      node.stop()
    }
    playing.clear()
    held = []
    paused = false
    playHead = 0
    voice.gain.cancelScheduledValues(0)
    voice.gain.setValueAtTime(1, ctx.currentTime)
    onChange(false)
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
