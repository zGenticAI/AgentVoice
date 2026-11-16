// npm run flux-probe's audio: the noise clips it makes (the same on every run, in the service's format), where sound
// starts in a clip, the WAV files it reads, and its 80 ms chunks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHUNK_BYTES, breathLike, chunks, coughLike, msOf, onsetMs, readWav, silence, syntheticClips, whiteNoise } from '../src/probe/flux-audio.ts'

const samples = (pcm: Buffer) => Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2))
const rms = (pcm: Buffer) => Math.sqrt(samples(pcm).reduce((n, s) => n + s * s, 0) / (pcm.length / 2)) / 32768

test('the synthetic clips are the same on every run, and 16 kHz mono PCM16 of the right length', () => {
  const a = syntheticClips()
  const b = syntheticClips()
  assert.deepEqual(a.map(c => c.id), ['noise-silence', 'noise-white', 'noise-cough', 'noise-breath'])
  for (const [i, clip] of a.entries()) assert.ok(clip.audio.equals(b[i].audio), `${clip.id} is deterministic`)
  assert.deepEqual(a.map(c => msOf(c.audio)), [1500, 300, 390, 800])
  for (const clip of a) assert.equal(clip.audio.length % 2, 0, 'whole samples')
  assert.equal(msOf(silence(80)), 80)
  assert.equal(silence(80).length, 2560, '16 kHz, 2 bytes a sample')
})

test('the noise clips are noise at their levels: silence is silent, white noise moderate, a breath quiet, a cough two bursts', () => {
  const [quiet, white, cough, breath] = syntheticClips().map(c => c.audio)
  assert.ok(samples(quiet).every(s => s === 0))
  assert.ok(Math.abs(rms(white) - 0.07) < 0.01, `white noise at about -23 dBFS: ${rms(white)}`)
  assert.ok(rms(breath) < rms(white) / 3, 'a breath is quieter')
  assert.ok(new Set(samples(white)).size > 1000, 'noise, not a tone')
  // Two bursts of 120 ms, 150 ms apart: exact silence between them.
  const gap = samples(cough.subarray(120 * 32, 270 * 32))
  assert.ok(gap.every(s => s === 0))
  const burst = (from: number) => rms(cough.subarray(from * 32, (from + 120) * 32))
  assert.ok(burst(0) > 0.05 && burst(270) > 0.05, `${burst(0)} ${burst(270)}`)
  // A fast attack: loudest in its first 40 ms, much quieter by its end.
  assert.ok(rms(cough.subarray(0, 40 * 32)) > 4 * rms(cough.subarray(80 * 32, 120 * 32)))
  assert.ok(whiteNoise().equals(white) && coughLike().equals(cough) && breathLike().equals(breath))
})

test('where sound starts: the first 10 ms above about -40 dBFS, or null for silence', () => {
  assert.equal(onsetMs(silence(500)), null)
  const tone = Buffer.alloc(16 * 100 * 2)
  for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(Math.sin(i / 3) * 3000), i * 2)
  assert.equal(onsetMs(Buffer.concat([silence(230), tone])), 230)
  assert.equal(onsetMs(coughLike()), 0)
  const whisper = Buffer.alloc(16 * 100 * 2)
  for (let i = 0; i < whisper.length / 2; i++) whisper.writeInt16LE(i % 2 ? 100 : -100, i * 2)
  assert.equal(onsetMs(Buffer.concat([silence(100), whisper])), null, 'under -40 dBFS is not sound')
})

/** A WAV file: a fmt chunk then a data chunk. */
function wav(pcm: Buffer, o: { rate?: number; channels?: number; bits?: number; format?: number; extensible?: boolean } = {}): Buffer {
  const { rate = 16000, channels = 1, bits = 16, format = 1 } = o
  const fmt = Buffer.alloc(o.extensible ? 40 : 16)
  fmt.writeUInt16LE(o.extensible ? 0xfffe : format, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE((rate * channels * bits) / 8, 8)
  fmt.writeUInt16LE((channels * bits) / 8, 12)
  fmt.writeUInt16LE(bits, 14)
  if (o.extensible) {
    fmt.writeUInt16LE(22, 16)
    fmt.writeUInt16LE(format, 24)
  }
  const chunk = (id: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.write(id, 0, 'latin1')
    head.writeUInt32LE(body.length, 4)
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('LIST', Buffer.from('odd')), chunk('data', pcm)])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

test('a WAV already in 16 kHz mono PCM16 is read as it is; anything else says what it is and whether ffmpeg could convert it', () => {
  const pcm = coughLike()
  const ok = readWav(wav(pcm))
  assert.ok(ok.ok && ok.pcm.equals(pcm), 'past an odd-sized chunk')
  const ext = readWav(wav(pcm, { extensible: true }))
  assert.ok(ext.ok, 'WAVE_FORMAT_EXTENSIBLE holding PCM')
  assert.deepEqual(readWav(wav(pcm, { rate: 44100, channels: 2 })), { ok: false, reason: '16-bit PCM, 2 channels, 44100 Hz', convertible: true })
  assert.deepEqual(readWav(wav(pcm, { format: 3, bits: 32 })), { ok: false, reason: 'format 3, 1 channel, 16000 Hz', convertible: true })
  assert.deepEqual(readWav(Buffer.from('ID3 an mp3 file, really')), { ok: false, reason: 'not a WAV file', convertible: false })
  // A WAV written while recording can say its data is longer than the file.
  const cut = wav(pcm).subarray(0, -101)
  const partial = readWav(cut)
  assert.ok(partial.ok && partial.pcm.length % 2 === 0 && partial.pcm.length < pcm.length)
})

test('audio goes in 80 ms chunks, the last one shorter', () => {
  const parts = chunks(silence(500))
  assert.equal(CHUNK_BYTES, 2560)
  assert.deepEqual(parts.map(msOf), [80, 80, 80, 80, 80, 80, 20])
})
