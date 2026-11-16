// Audio for npm run flux-probe: the noise clips it makes itself, the WAV files it reads, where speech starts in a
// clip, and the 80 ms chunks it streams. All 16 kHz mono PCM16 little-endian: what the service sends Deepgram.
import { SAMPLE_RATE } from '../pipeline/deepgram.ts'

/** Bytes of audio per millisecond: 16 kHz, 16-bit mono. */
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
/** The bot page sends a chunk every 80 ms (public/agent.js), so the probe does too. */
export const CHUNK_MS = 80
export const CHUNK_BYTES = CHUNK_MS * BYTES_PER_MS

/** How long a buffer of audio plays (ms). */
export function msOf(pcm: Buffer): number {
  return pcm.length / BYTES_PER_MS
}

/** Silence of this length (ms), in whole samples. */
export function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((ms * SAMPLE_RATE) / 1000) * 2)
}

/** The audio cut into pieces of at most CHUNK_BYTES, each a view of it: the last may be shorter. */
export function chunks(pcm: Buffer, size = CHUNK_BYTES): Buffer[] {
  const out: Buffer[] = []
  for (let at = 0; at < pcm.length; at += size) out.push(pcm.subarray(at, Math.min(pcm.length, at + size)))
  return out
}

// A seeded generator (mulberry32), so every run sends Deepgram the same noise and a result can be compared.
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const samplesIn = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000)

function noise(ms: number, seed: number): Float64Array {
  const next = random(seed)
  const out = new Float64Array(samplesIn(ms))
  for (let i = 0; i < out.length; i++) out[i] = next() * 2 - 1
  return out
}

/** A band-pass filter (the RBJ cookbook's, constant peak gain), so noise sounds like a throat rather than hiss. */
function bandPass(x: Float64Array, centreHz: number, q: number): Float64Array {
  const w = (2 * Math.PI * centreHz) / SAMPLE_RATE
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  const [b0, b2, a1, a2] = [alpha / a0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0]
  const y = new Float64Array(x.length)
  let [x1, x2, y1, y2] = [0, 0, 0, 0]
  for (let i = 0; i < x.length; i++) {
    y[i] = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = y[i]
  }
  return y
}

function rms(x: Float64Array): number {
  let sum = 0
  for (const v of x) sum += v * v
  return x.length ? Math.sqrt(sum / x.length) : 0
}

/** Scales a signal to this RMS level (1 is full scale). */
function toLevel(x: Float64Array, level: number): Float64Array {
  const now = rms(x)
  return now ? x.map(v => (v * level) / now) : x
}

function toPcm(x: Float64Array): Buffer {
  const out = Buffer.alloc(x.length * 2)
  x.forEach((v, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2))
  return out
}

/** Short ramps at both ends: a hard edge is a click, which is a sound of its own. */
function ramped(x: Float64Array, ms: number): Float64Array {
  const n = Math.min(samplesIn(ms), Math.floor(x.length / 2))
  for (let i = 0; i < n; i++) {
    const g = i / n
    x[i] *= g
    x[x.length - 1 - i] *= g
  }
  return x
}

/** 300 ms of white noise at about -23 dBFS RMS, a moderate level next to speech. */
export function whiteNoise(): Buffer {
  return toPcm(ramped(toLevel(noise(300, 1), 0.07), 5))
}

/**
 * Something like a cough: two ~120 ms bursts of noise in the voice's band, each with a fast attack and a fast decay,
 * 150 ms apart.
 */
export function coughLike(): Buffer {
  const burst = (seed: number) => {
    const x = toLevel(bandPass(noise(120, seed), 700, 0.8), 0.25)
    const attack = samplesIn(8)
    const decay = samplesIn(35)
    return x.map((v, i) => v * (i < attack ? i / attack : Math.exp(-(i - attack) / decay)))
  }
  const gap = new Float64Array(samplesIn(150))
  return toPcm(Float64Array.from([...burst(2), ...gap, ...burst(3)]))
}

/** Something like a breath: 800 ms of quiet, filtered noise (about -34 dBFS) that swells and fades. */
export function breathLike(): Buffer {
  const x = toLevel(bandPass(noise(800, 4), 1200, 0.5), 0.02)
  return toPcm(x.map((v, i) => v * Math.sin((Math.PI * i) / x.length)))
}

/** The synthetic clips: what Flux does with sounds that are not speech. Made in code, the same on every run. */
export function syntheticClips(): { id: string; label: string; audio: Buffer }[] {
  return [
    { id: 'noise-silence', label: '1.5 s of silence', audio: silence(1500) },
    { id: 'noise-white', label: '300 ms of white noise', audio: whiteNoise() },
    { id: 'noise-cough', label: 'a cough-like double burst', audio: coughLike() },
    { id: 'noise-breath', label: 'a breath-like 800 ms of filtered noise', audio: breathLike() },
  ]
}

/**
 * Where sound starts in a clip (ms, to 10 ms): the first 10 ms with an RMS level above about -40 dBFS. Null for a
 * clip with none. ElevenLabs puts a little silence before the first word, which is not Flux's delay.
 */
export function onsetMs(pcm: Buffer, thresholdDb = -40): number | null {
  const frame = 10 * BYTES_PER_MS
  const threshold = 10 ** (thresholdDb / 20) * 32768
  for (let at = 0; at + 2 <= pcm.length; at += frame) {
    const end = Math.min(pcm.length, at + frame) & ~1
    let sum = 0
    for (let i = at; i < end; i += 2) sum += pcm.readInt16LE(i) ** 2
    if (Math.sqrt(sum / ((end - at) / 2)) > threshold) return at / BYTES_PER_MS
  }
  return null
}

export type WavResult =
  | { ok: true; pcm: Buffer }
  | { ok: false; reason: string; convertible: boolean }

/**
 * The audio of a WAV file, if it is already 16 kHz mono PCM16. Otherwise why not, and whether ffmpeg could make it so
 * (any WAV it can read: not a file that isn't a WAV at all).
 */
export function readWav(file: Buffer): WavResult {
  if (file.length < 12 || file.toString('latin1', 0, 4) !== 'RIFF' || file.toString('latin1', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'not a WAV file', convertible: false }
  }
  let format: { code: number; channels: number; rate: number; bits: number } | null = null
  for (let at = 12; at + 8 <= file.length; ) {
    const id = file.toString('latin1', at, at + 4)
    const size = file.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ' && body + 16 <= file.length) {
      let code = file.readUInt16LE(body)
      // WAVE_FORMAT_EXTENSIBLE keeps the real format at the start of its sub-format GUID.
      if (code === 0xfffe && size >= 26 && body + 26 <= file.length) code = file.readUInt16LE(body + 24)
      format = { code, channels: file.readUInt16LE(body + 2), rate: file.readUInt32LE(body + 4), bits: file.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      if (!format) return { ok: false, reason: 'its data comes before its format', convertible: true }
      const { code, channels, rate, bits } = format
      if (code !== 1 || channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
        const kind = code === 1 ? `${bits}-bit PCM` : `format ${code}`
        return { ok: false, reason: `${kind}, ${channels} channel${channels === 1 ? '' : 's'}, ${rate} Hz`, convertible: true }
      }
      // A WAV written while recording may say 0 or more than it has: take what is there, in whole samples.
      const end = size && body + size <= file.length ? body + size : file.length
      return { ok: true, pcm: Buffer.from(file.subarray(body, body + ((end - body) & ~1))) }
    }
    at = body + size + (size % 2)
  }
  return { ok: false, reason: 'no audio in it', convertible: false }
}
