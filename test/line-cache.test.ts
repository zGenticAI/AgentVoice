import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHUNK_BYTES, LineCache } from '../src/pipeline/line-cache.ts'

const HELLO = "Hello, I'm Alex, Sam's AI assistant."
const BYE = "Of course. I'm leaving now."
const LINES = [HELLO, BYE]

/** 16 kHz mono PCM16 lasting this many seconds, every byte the same so lines can be told apart. */
const pcm = (seconds: number, byte = 7) => Buffer.alloc(Math.round(seconds * 32_000), byte)

/** A fake ElevenLabs: hands back audio(text) in 1,000-byte pieces, stops when aborted, and notes every request. */
function fakeSynth(audio: (text: string) => Buffer = () => pcm(0.5)) {
  const calls: string[] = []
  async function* synth(text: string, signal?: AbortSignal) {
    calls.push(text)
    const all = audio(text)
    for (let at = 0; at < all.length && !signal?.aborted; at += 1000) yield all.subarray(at, at + 1000)
  }
  return { synth, calls }
}

/** A cache folder that does not exist yet, in a temp folder of its own. */
const cacheDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alex-tts-cache-')), 'tts-cache')

async function collect(pieces: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = []
  for await (const piece of pieces) out.push(piece)
  return Buffer.concat(out)
}

// A clock that stands still and a wait that waits for nothing: kept lines go out at once.
const noWait = { now: () => 0, sleep: async () => {} }

test('a fixed line is made once, then played from memory, and from disk after a restart', async () => {
  const dir = cacheDir()
  const { synth, calls } = fakeSynth()
  const cache = new LineCache({ dir, lines: LINES, synth, voiceKey: 'voice-a', ...noWait })
  const first = await collect(cache.speak(HELLO))
  assert.deepEqual(first, pcm(0.5))
  assert.deepEqual(await collect(cache.speak(HELLO)), first)
  assert.deepEqual(calls, [HELLO], 'ElevenLabs was asked once')
  const files = fs.readdirSync(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^[0-9a-f]{64}\.pcm$/)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600)
  // After a restart: a new cache over the same folder, with an ElevenLabs that would fail.
  const down = async function* (): AsyncGenerator<Buffer> {
    throw new Error('ElevenLabs is down')
  }
  const restarted = new LineCache({ dir, lines: LINES, synth: down, voiceKey: 'voice-a', ...noWait })
  assert.deepEqual(await collect(restarted.speak(HELLO)), first)
})

test("words that are not a fixed line (Claude's answers) stream live every time and are never written to disk", async () => {
  const dir = cacheDir()
  const answer = 'The pilot starts in March.'
  const { synth, calls } = fakeSynth(text => pcm(0.5, text === answer ? 9 : 7))
  const cache = new LineCache({ dir, lines: LINES, synth, voiceKey: 'voice-a', ...noWait })
  assert.deepEqual(await collect(cache.speak(answer)), pcm(0.5, 9))
  await collect(cache.speak(answer))
  assert.deepEqual(calls, [answer, answer], 'not kept in memory either')
  assert.equal(fs.existsSync(dir), false, 'nothing was written')
  await cache.warm()
  await collect(cache.speak(answer))
  const kept = fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name)))
  assert.equal(kept.length, LINES.length, 'only the fixed lines are kept')
  assert.ok(kept.every(audio => !audio.includes(9)), "none of them is the answer's audio")
})

test("a new voice makes the lines again by itself, and warm() removes the files nothing uses any more", async () => {
  const dir = cacheDir()
  const saved = process.env.ELEVENLABS_VOICE_ID
  try {
    // The default voice key, from ELEVENLABS_VOICE_ID, as the service uses it.
    process.env.ELEVENLABS_VOICE_ID = 'voice-a'
    const before = fakeSynth()
    const old = new LineCache({ dir, lines: LINES, synth: before.synth, ...noWait })
    assert.deepEqual(await old.warm(), { found: 0, generated: 2, failed: 0, removed: 0 })
    const oldFiles = fs.readdirSync(dir)

    process.env.ELEVENLABS_VOICE_ID = 'voice-b'
    const after = fakeSynth(() => pcm(0.5, 3))
    const cache = new LineCache({ dir, lines: LINES, synth: after.synth, ...noWait })
    assert.deepEqual(await collect(cache.speak(HELLO)), pcm(0.5, 3), 'the new voice, not the old one')
    assert.deepEqual(await cache.warm(), { found: 1, generated: 1, failed: 0, removed: 2 })
    assert.deepEqual(after.calls, [HELLO, BYE])
    const files = fs.readdirSync(dir)
    assert.equal(files.length, 2)
    assert.ok(files.every(name => !oldFiles.includes(name)), "the old voice's files are gone")

    // Wording that is no longer a fixed line goes too.
    const fewer = new LineCache({ dir, lines: [HELLO], synth: after.synth, ...noWait })
    assert.deepEqual(await fewer.warm(), { found: 1, generated: 0, failed: 0, removed: 1 })
    assert.equal(fs.readdirSync(dir).length, 1)
  } finally {
    if (saved === undefined) delete process.env.ELEVENLABS_VOICE_ID
    else process.env.ELEVENLABS_VOICE_ID = saved
  }
})

test('warm() also removes the temp files of a write a crash cut short, and leaves the kept lines alone', async () => {
  const dir = cacheDir()
  await new LineCache({ dir, lines: [HELLO], synth: fakeSynth().synth, voiceKey: 'v', ...noWait }).warm()
  const [kept] = fs.readdirSync(dir)
  // What store() leaves if the service is killed between writing a line and renaming it into place.
  fs.writeFileSync(path.join(dir, `${kept}.1a2b3c4d.tmp`), pcm(0.2))
  fs.writeFileSync(path.join(dir, `${'0'.repeat(64)}.pcm.5e6f7a8b.tmp`), pcm(0.2))
  const again = fakeSynth()
  assert.deepEqual(await new LineCache({ dir, lines: [HELLO], synth: again.synth, voiceKey: 'v', ...noWait }).warm(), {
    found: 1,
    generated: 0,
    failed: 0,
    removed: 2,
  })
  assert.deepEqual(fs.readdirSync(dir), [kept])
  assert.deepEqual(again.calls, [], 'the kept line was not made again')
})

test('an empty file is ignored, and the line is made again when Alex says it', async () => {
  const dir = cacheDir()
  await new LineCache({ dir, lines: [HELLO], synth: fakeSynth().synth, voiceKey: 'v', ...noWait }).warm()
  const [name] = fs.readdirSync(dir)
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(0))
  const again = fakeSynth()
  const cache = new LineCache({ dir, lines: [HELLO], synth: again.synth, voiceKey: 'v', ...noWait })
  assert.deepEqual(await collect(cache.speak(HELLO)), pcm(0.5))
  assert.deepEqual(again.calls, [HELLO], 'made again')
  assert.equal(fs.statSync(path.join(dir, name)).size, pcm(0.5).length, 'and kept whole')
})

test('a file with an odd number of bytes is ignored, and warm() makes the line again', async () => {
  const dir = cacheDir()
  await new LineCache({ dir, lines: [HELLO], synth: fakeSynth().synth, voiceKey: 'v', ...noWait }).warm()
  const [name] = fs.readdirSync(dir)
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(3201, 1))
  const again = fakeSynth()
  const cache = new LineCache({ dir, lines: [HELLO], synth: again.synth, voiceKey: 'v', ...noWait })
  assert.deepEqual(await cache.warm(), { found: 0, generated: 1, failed: 0, removed: 0 })
  assert.deepEqual(again.calls, [HELLO])
  assert.equal(fs.statSync(path.join(dir, name)).size, pcm(0.5).length)
  assert.deepEqual(await collect(cache.speak(HELLO)), pcm(0.5))
})

test('a kept line goes out in 100 ms pieces: the first second at once, then no more than a second ahead of real time', async () => {
  const dir = cacheDir()
  let clock = 0
  const cache = new LineCache({
    dir,
    lines: [HELLO],
    synth: fakeSynth(() => pcm(3)).synth,
    voiceKey: 'v',
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
  })
  await cache.warm()
  const sentAt: number[] = []
  for await (const piece of cache.speak(HELLO)) {
    assert.equal(piece.length, CHUNK_BYTES)
    sentAt.push(clock)
  }
  assert.equal(sentAt.length, 30)
  assert.deepEqual(sentAt.slice(0, 10), Array(10).fill(0), 'the first second at once')
  // Piece i plays from i * 100 ms to (i + 1) * 100 ms, and goes out a second before it ends.
  for (let i = 10; i < 30; i++) assert.equal(Math.round(sentAt[i]), (i + 1) * 100 - 1000, `piece ${i}`)
})

test('the pacing clock only goes forward: the system clock stepping back in the middle of a line does not hold Alex up', async t => {
  const dir = cacheDir()
  const waits: number[] = []
  // The computer's clock is set back an hour (a time sync) just after the line starts: reads from -1 on
  // stand still until the line starts, then the first read is the start and every later one an hour before it.
  const wall = Date.now()
  let reads = -1
  t.mock.method(Date, 'now', () => (reads < 0 ? wall : reads++ ? wall - 3_600_000 : wall))
  // The default clock, and a wait that notes how long it was asked to wait and returns at once.
  const cache = new LineCache({ dir, lines: [HELLO], synth: fakeSynth(() => pcm(1.5)).synth, voiceKey: 'v', sleep: async ms => void waits.push(ms) })
  await cache.warm()
  reads = 0
  assert.equal((await collect(cache.speak(HELLO))).length, pcm(1.5).length)
  assert.ok(waits.length > 0, 'it was paced')
  // The last of 15 pieces ends at 1.5 s and goes out a second before: no wait is longer than half a second.
  assert.ok(Math.max(...waits) <= 500, `waited ${Math.max(...waits)} ms at most`)
})

test('talking over Alex stops a kept line at once, even while it waits to send the next piece', async () => {
  const dir = cacheDir()
  // The real wait, and a clock that stands still: the piece after the first second is due in 100 ms.
  const cache = new LineCache({ dir, lines: [HELLO], synth: fakeSynth(() => pcm(3)).synth, voiceKey: 'v', now: () => 0 })
  await cache.warm()
  const talkedOver = new AbortController()
  const pieces = cache.speak(HELLO, talkedOver.signal)
  for (let i = 0; i < 10; i++) assert.equal((await pieces.next()).done, false)
  const next = pieces.next()
  const at = Date.now()
  talkedOver.abort()
  assert.equal((await next).done, true, 'nothing more is sent')
  assert.ok(Date.now() - at < 80, 'at once, not when the next piece was due')
})

test('a fixed line that streamed live is kept once it has streamed in full, but not when it was cut short', async () => {
  const dir = cacheDir()
  const { synth, calls } = fakeSynth()
  const cache = new LineCache({ dir, lines: LINES, synth, voiceKey: 'v', ...noWait })

  // Talked over after the first piece: the session stops reading, as say() does.
  const talkedOver = new AbortController()
  for await (const _piece of cache.speak(HELLO, talkedOver.signal)) {
    talkedOver.abort()
    if (talkedOver.signal.aborted) break
  }
  // Talked over, and ElevenLabs stopped the stream itself.
  const stopped = new AbortController()
  for await (const _piece of cache.speak(HELLO, stopped.signal)) stopped.abort()
  assert.equal(fs.existsSync(dir), false, 'a line cut short is never kept')

  // ElevenLabs failing halfway: not kept either.
  const failing = async function* (): AsyncGenerator<Buffer> {
    yield pcm(0.1)
    throw new Error('ElevenLabs 500')
  }
  const broken = new LineCache({ dir, lines: LINES, synth: failing, voiceKey: 'v', ...noWait })
  await assert.rejects(collect(broken.speak(HELLO)), /ElevenLabs 500/)
  assert.equal(fs.existsSync(dir), false)

  // Streamed in full: kept, and the next time it comes from the cache.
  assert.deepEqual(await collect(cache.speak(HELLO)), pcm(0.5))
  assert.equal(fs.readdirSync(dir).length, 1)
  assert.deepEqual(await collect(cache.speak(HELLO)), pcm(0.5))
  assert.deepEqual(calls, [HELLO, HELLO, HELLO], 'asked twice when cut short, once in full, then not again')
})

test('warm() resolves even when ElevenLabs fails, and logs which lines will stream live', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  const dir = cacheDir()
  const partly = async function* (text: string): AsyncGenerator<Buffer> {
    if (text === BYE) throw new Error('ElevenLabs 401: invalid key')
    yield pcm(0.5)
  }
  const cache = new LineCache({ dir, lines: LINES, synth: partly, voiceKey: 'v', ...noWait })
  assert.deepEqual(await cache.warm(), { found: 0, generated: 1, failed: 1, removed: 0 })
  assert.equal(errors.mock.callCount(), 1)
  assert.match(String(errors.mock.calls[0].arguments[0]), /^\[tts\] could not make "Of course\. I'm leaving now\." ahead of time, so it streams live: ElevenLabs 401/)

  // No key at all (synthesize throws before any audio), or no audio back: still resolves.
  const missing = (): AsyncGenerator<Buffer> => {
    throw new Error('ELEVENLABS_API_KEY is not set')
  }
  assert.deepEqual(await new LineCache({ dir: cacheDir(), lines: LINES, synth: missing, voiceKey: 'v', ...noWait }).warm(), {
    found: 0,
    generated: 0,
    failed: 2,
    removed: 0,
  })
  const silent = fakeSynth(() => Buffer.alloc(0))
  assert.deepEqual(await new LineCache({ dir: cacheDir(), lines: LINES, synth: silent.synth, voiceKey: 'v', ...noWait }).warm(), {
    found: 0,
    generated: 0,
    failed: 2,
    removed: 0,
  })
})
