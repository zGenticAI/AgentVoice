// The bot page's audio, inside the Recall.ai bot: streams the meeting's audio to the voice service as
// 16 kHz PCM16, and plays the assistant's voice back into the meeting.
const RATE = 16000
const CHUNK = 1280 // 80 ms, as Deepgram Flux recommends

export async function startAgent({ onState, onOutput }) {
  const params = new URLSearchParams(location.search)
  const wsUrl = new URL('/audio', location.href)
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  wsUrl.search = new URLSearchParams({ key: params.get('key') || '', token: params.get('token') || '' })

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

  let pendingSamples = new Float32Array(0)
  capture.port.onmessage = ({ data }) => {
    const merged = new Float32Array(pendingSamples.length + data.length)
    merged.set(pendingSamples)
    merged.set(data, pendingSamples.length)
    pendingSamples = merged
    while (pendingSamples.length >= CHUNK && ws.readyState === WebSocket.OPEN) {
      const frame = pendingSamples.subarray(0, CHUNK)
      const pcm = new Int16Array(CHUNK)
      for (let i = 0; i < CHUNK; i++) pcm[i] = Math.max(-1, Math.min(1, frame[i])) * 0x7fff
      ws.send(pcm.buffer)
      pendingSamples = pendingSamples.slice(CHUNK)
    }
  }

  // The assistant's voice passes through an analyser on its way out, so the bot page can draw it.
  const output = ctx.createAnalyser()
  output.fftSize = 256
  output.smoothingTimeConstant = 0.6
  output.connect(ctx.destination)
  onOutput?.(output)

  // Playback: schedule each chunk right after the previous one.
  let playHead = 0
  const playing = new Set()
  function play(buffer) {
    const pcm = new Int16Array(buffer)
    const audio = ctx.createBuffer(1, pcm.length, RATE)
    const out = audio.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000
    const node = ctx.createBufferSource()
    node.buffer = audio
    node.connect(output)
    playHead = Math.max(playHead, ctx.currentTime + 0.05)
    node.start(playHead)
    playHead += audio.duration
    playing.add(node)
    node.onended = () => {
      playing.delete(node)
      if (!playing.size) onState?.('listening')
    }
    onState?.('speaking')
  }
  function clear() {
    for (const node of playing) node.stop()
    playing.clear()
    playHead = 0
    onState?.('listening')
  }

  ws.onmessage = ({ data }) => {
    if (typeof data !== 'string') return play(data)
    const msg = JSON.parse(data)
    if (msg.type === 'clear') clear()
    if (msg.type === 'ready') onState?.('listening')
    if (msg.type === 'error') onState?.('error: ' + msg.message)
  }
  ws.onclose = () => onState?.('disconnected')
  return () => {
    ws.close()
    stream.getTracks().forEach(t => t.stop())
    ctx.close()
  }
}
