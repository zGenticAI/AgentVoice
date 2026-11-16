// npm run flux-probe's streaming, against a fake Flux on 127.0.0.1 with the real ws client: the address and key header
// the service uses, the order and pace of what it sends (silence, the clip, silence, CloseStream), ForceEndTurn's
// timing, the idle check, refusals, and whole runs (no key in anything printed or written).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { fluxUrl } from '../src/pipeline/deepgram.ts'
import { TTS_MODEL } from '../src/pipeline/tts.ts'
import { analyzeForce, analyzeHold, analyzeIdle } from '../src/probe/flux-analysis.ts'
import { MIC_PROMPTS, MIC_SILENT, NONVERBAL_TTS_MODEL, type ProbeDeps, parseArgs, runProbe } from '../src/probe/flux-probe.ts'
import { REPORT_END } from '../src/probe/flux-report.ts'
import { type Connect, streamClip } from '../src/probe/flux-stream.ts'
import { type Connection, type FluxScript, fakeFlux, tone } from './fixtures/fake-flux.ts'

const KEY = 'dg-probe-key-never-printed'
const EL_KEY = 'el-probe-key-never-printed'

/** Opens the service's own Flux address, on the fake instead of Deepgram. */
const connectTo = (origin: string): Connect => (url, headers) => new WebSocket(url.replace('wss://api.deepgram.com', origin), { headers })

async function withFlux<T>(script: FluxScript, fn: (fake: Awaited<ReturnType<typeof fakeFlux>>) => Promise<T>): Promise<T> {
  const fake = await fakeFlux(script)
  try {
    return await fn(fake)
  } finally {
    await fake.close()
  }
}

const audioOf = (conn: Connection) => conn.received.filter(r => r.kind === 'audio')
/** What the fake was sent, in order: S for a silent chunk, L for a loud one, then the text messages by type. */
const sequence = (conn: Connection) => conn.received.map(r => (r.kind === 'audio' ? (r.loud ? 'L' : 'S') : `[${r.msg.type}]`)).join('')
const between = (v: number, lo: number, hi: number, what: string) => assert.ok(v >= lo && v <= hi, `${what}: ${v} not in [${lo}, ${hi}]`)

test("each clip goes on the service's own address and key header: the lead silence, the clip, silence until its turn ended, then CloseStream", async () => {
  await withFlux({ startAfterMs: 60, endAfterQuietMs: 150 }, async fake => {
    const url = fluxUrl()
    const run = await streamClip({ url, key: KEY, audio: tone(400), connect: connectTo(fake.origin), timing: { leadMs: 160, minTailMs: 80, tailMaxMs: 2000, closeWaitMs: 500 } })
    const conn = fake.connections[0]
    const expected = new URL(url)
    assert.equal(conn.url, expected.pathname + expected.search, 'exactly fluxUrl(): model, eot_threshold, keyterms, mip_opt_out')
    assert.equal(expected.searchParams.get('mip_opt_out'), 'true')
    assert.deepEqual(expected.searchParams.getAll('keyterm'), ['Alex', 'Sam'])
    assert.equal(conn.headers.authorization, `Token ${KEY}`)
    assert.ok(!conn.url.includes(KEY), 'the key never goes in the address')
    assert.match(sequence(conn), /^SSLLLLLS+\[CloseStream\]$/, sequence(conn))
    const trailing = audioOf(conn).slice(7).reduce((n, a) => n + a.ms, 0)
    assert.ok(trailing < 600, `silence stops once the turn has ended, not after tailMaxMs: ${trailing} ms`)
    assert.equal(run.opened, true)
    assert.equal(run.clipMs, 400)
    const start = run.events.find(e => e.msg.event === 'StartOfTurn')
    const end = run.events.find(e => e.msg.event === 'EndOfTurn')
    assert.ok(start && end)
    // The clip's first chunk goes once its 80 ms have passed (t = 80); the fake starts the turn 60 ms after it arrives.
    between(start.t, 120, 260, 'StartOfTurn t, from where the clip starts')
    assert.ok(run.events[0].t < 0 && run.events[0].msg.type === 'Connected', 'messages during the lead silence have t < 0')
    assert.equal(run.close?.by, 'server')
    assert.equal(run.close?.code, 1005, 'a CloseStream close has no status')
    between((run.close?.t ?? 0) - (run.closeStreamT ?? 0), 0, 200, 'close after CloseStream')
    assert.equal(run.audioMs, audioOf(conn).reduce((n, a) => n + a.ms, 0))
  })
})

test('when the turn ended before the clip did, silence still goes on for minTailMs, so a turn its last sound starts is not missed', async () => {
  await withFlux({ startAfterMs: 40, endAfterQuietMs: 150 }, async fake => {
    const audio = Buffer.concat([tone(160), Buffer.alloc(32 * 480)])
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio, connect: connectTo(fake.origin), timing: { leadMs: 80, minTailMs: 320, tailMaxMs: 2000, closeWaitMs: 300 } })
    const end = run.events.find(e => e.msg.event === 'EndOfTurn')
    assert.ok(end && end.t < run.clipMs, 'the turn ended within the clip')
    const trailing = audioOf(fake.connections[0]).slice(1 + 8).reduce((n, a) => n + a.ms, 0)
    between(trailing, 320, 400, 'silence after the clip')
  })
})

test('audio never goes faster than real time: each chunk once its 80 ms have passed', async () => {
  await withFlux({ turns: false }, async fake => {
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio: tone(800), connect: connectTo(fake.origin), timing: { leadMs: 160, minTailMs: 80, tailMaxMs: 240, closeWaitMs: 300 } })
    const audio = audioOf(fake.connections[0])
    let sent = 0
    for (const a of audio) {
      sent += a.ms
      // By the time a chunk arrives, at most the time since the first one arrived, plus that first chunk, has gone.
      assert.ok(sent <= a.at - audio[0].at + 80 + 5, `${sent} ms of audio ${Math.round(a.at - audio[0].at)} ms after the first chunk`)
    }
    const span = audio.at(-1)!.at - audio[0].at
    between(span, sent - 80 - 5, sent + 400, 'and not much slower either')
    assert.ok(run.lateMs < 100, `late by ${run.lateMs} ms`)
  })
})

test('with no turn to end, the silence after the clip goes on for tailMaxMs, then CloseStream', async () => {
  await withFlux({ turns: false }, async fake => {
    await streamClip({ url: fluxUrl(), key: KEY, audio: tone(160), connect: connectTo(fake.origin), timing: { leadMs: 80, minTailMs: 80, tailMaxMs: 400, closeWaitMs: 300 } })
    const conn = fake.connections[0]
    assert.match(sequence(conn), /^SLLS{5}\[CloseStream\]$/, sequence(conn))
  })
})

test('force-close: ForceEndTurn goes afterStartMs after the StartOfTurn, CloseStream straight after it, and no more audio', async () => {
  // Flux takes its time to close, so audio the probe sent after CloseStream would show.
  await withFlux({ startAfterMs: 40, endAfterQuietMs: Infinity, closeDelayMs: 300, text: ms => (ms > 160 ? 'Lets move the launch' : 'Lets') }, async fake => {
    const run = await streamClip({
      url: fluxUrl(), key: KEY, audio: tone(1600), connect: connectTo(fake.origin),
      timing: { leadMs: 80, minTailMs: 80, tailMaxMs: 400, closeWaitMs: 500 }, force: { afterStartMs: 300, close: true },
    })
    const conn = fake.connections[0]
    const startSent = conn.sent.find(s => s.msg.event === 'StartOfTurn')!.at
    const texts = conn.received.filter(r => r.kind === 'text')
    assert.deepEqual(texts.map(r => r.kind === 'text' && r.msg.type), ['ForceEndTurn', 'CloseStream'])
    between(texts[0].at - startSent, 280, 400, 'ForceEndTurn after the StartOfTurn')
    between(texts[1].at - texts[0].at, 0, 10, 'CloseStream straight after it')
    assert.equal(conn.received.at(-1), texts[1], 'no audio after CloseStream')
    assert.ok(audioOf(conn).filter(a => a.loud).length < 20, 'the rest of the clip is not sent')
    const f = analyzeForce('force-close', run)
    assert.equal(f.noTurn, false)
    assert.equal(f.end?.trigger, 'manual')
    assert.equal(f.end?.transcript, 'Lets move the launch')
    between(f.end?.afterMs ?? -1, 0, 100, 'EndOfTurn after ForceEndTurn')
    assert.equal(f.endBeforeClose, true)
    assert.equal(f.close?.by, 'server')
    assert.equal(f.close?.code, 1005)
  })
})

test('force-only: ForceEndTurn alone, the clip goes on to its end, and the forced EndOfTurn is timed', async () => {
  await withFlux({ startAfterMs: 40, endAfterQuietMs: Infinity }, async fake => {
    const run = await streamClip({
      url: fluxUrl(), key: KEY, audio: tone(800), connect: connectTo(fake.origin),
      timing: { leadMs: 80, minTailMs: 80, tailMaxMs: 240, closeWaitMs: 500 }, force: { afterStartMs: 200, close: false },
    })
    const conn = fake.connections[0]
    assert.equal(audioOf(conn).filter(a => a.loud).length, 10, 'the whole clip')
    assert.match(sequence(conn), /^SL+\[ForceEndTurn\]L+S+\[CloseStream\]$/, sequence(conn))
    const f = analyzeForce('force-only', run)
    assert.equal(f.end?.trigger, 'manual')
    between(f.end?.afterMs ?? -1, 0, 100, 'EndOfTurn after ForceEndTurn')
  })
})

test('a force check with no StartOfTurn sends ForceEndTurn as the clip ends, and keeps the Warning Flux sends', async () => {
  await withFlux({ turns: false }, async fake => {
    const run = await streamClip({
      url: fluxUrl(), key: KEY, audio: tone(240), connect: connectTo(fake.origin),
      timing: { leadMs: 80, minTailMs: 80, tailMaxMs: 240, closeWaitMs: 500 }, force: { afterStartMs: 200, close: true },
    })
    assert.match(sequence(fake.connections[0]), /^SLLL\[ForceEndTurn\]\[CloseStream\]$/)
    const f = analyzeForce('force-close', run)
    assert.equal(f.noTurn, true)
    assert.deepEqual(f.warnings, ['FORCE_END_TURN_NO_ACTIVE_TURN'])
  })
})

test('idle: only the first part of the clip goes, then nothing at all, and when and how Flux closes is kept', async t => {
  // The probe's own waits, by the timers flux-stream.ts sets: none may be left running once Flux has closed, or the CLI
  // would not exit until it ran out.
  const running = new Set<NodeJS.Timeout>()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const mine = new Error().stack?.includes('flux-stream.ts') ?? false
    const handle: NodeJS.Timeout = realSet(() => (running.delete(handle), fn(...rest)), ms)
    if (mine) running.add(handle)
    return handle
  })
  t.mock.method(globalThis, 'clearTimeout', (handle: NodeJS.Timeout) => (running.delete(handle), realClear(handle)))
  await withFlux({ idleCloseMs: 250 }, async fake => {
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio: tone(1600), connect: connectTo(fake.origin), timing: { leadMs: 80 }, idle: { audioMs: 240, maxMs: 3000 } })
    assert.equal(running.size, 0, 'no wait left running')
    const conn = fake.connections[0]
    assert.equal(sequence(conn), 'SLLL', 'no silence and no CloseStream after the audio')
    assert.equal(run.clipMs, 240)
    const idle = analyzeIdle(run)
    assert.equal(idle.code, 1011)
    assert.equal(idle.reason, 'NET-0001')
    between(idle.closedAfterMs ?? -1, 200, 400, 'closed after the last audio')
    assert.equal(idle.stillOpenAfterMs, null)
  })
})

test('idle: a stream still open when the wait runs out says so, then gets its CloseStream', async () => {
  await withFlux({}, async fake => {
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio: tone(800), connect: connectTo(fake.origin), timing: { leadMs: 80, closeWaitMs: 300 }, idle: { audioMs: 160, maxMs: 300 } })
    assert.equal(sequence(fake.connections[0]), 'SLL[CloseStream]')
    between(run.stillOpenAfterMs ?? -1, 290, 420, 'still open after')
    assert.equal(analyzeIdle(run).closedAfterMs, null)
  })
})

test('a stream Flux does not close after CloseStream is cut once closeWaitMs has passed', async () => {
  await withFlux({ turns: false, ignoreClose: true }, async fake => {
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio: tone(160), connect: connectTo(fake.origin), timing: { leadMs: 80, minTailMs: 80, tailMaxMs: 80, closeWaitMs: 200 } })
    assert.equal(run.close?.by, 'probe')
    between((run.close?.t ?? 0) - (run.closeStreamT ?? 0), 190, 400, 'cut after')
    assert.equal(run.error, undefined)
  })
})

test("a refused handshake keeps the status and Deepgram's short error text, nothing else of its answer", async () => {
  const body = JSON.stringify({ err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.', request_id: 'req-123', extra: 'x'.repeat(500) })
  await withFlux({ refuse: { status: 401, body } }, async fake => {
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio: tone(160), connect: connectTo(fake.origin) })
    assert.equal(run.opened, false)
    assert.deepEqual(run.refused, { status: 401, text: 'INVALID_AUTH: Invalid credentials.' })
    assert.equal(run.error, undefined)
    assert.deepEqual(run.events, [])
  })
  await withFlux({ refuse: { status: 402, body: '<html>payment</html>', dgError: 'Insufficient credits' } }, async fake => {
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio: tone(160), connect: connectTo(fake.origin) })
    assert.deepEqual(run.refused, { status: 402, text: 'Insufficient credits' })
  })
  await withFlux({ refuse: { status: 503, body: '<html>a proxy page, account 12345</html>' } }, async fake => {
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio: tone(160), connect: connectTo(fake.origin) })
    assert.deepEqual(run.refused, { status: 503, text: '' }, 'an answer that is not Deepgram\'s error says nothing')
  })
  const long = JSON.stringify({ err_code: 'BAD_REQUEST', err_msg: 'x'.repeat(400) })
  await withFlux({ refuse: { status: 400, body: long } }, async fake => {
    const run = await streamClip({ url: fluxUrl(), key: KEY, audio: tone(160), connect: connectTo(fake.origin) })
    assert.equal(run.refused?.text.length, 160)
  })
})

// Whole runs: tiny waits, a tone for every spoken clip, and the fake.

const TIMING = { leadMs: 80, minTailMs: 80, tailMaxMs: 240, closeWaitMs: 400, holdWaitMs: 300 }

function deps(origin: string, over: Partial<ProbeDeps> = {}) {
  const out: string[] = []
  const log: string[] = []
  const spoken: { text: string; model?: string }[] = []
  const d: ProbeDeps = {
    url: fluxUrl(),
    deepgramKey: KEY,
    secrets: [KEY, EL_KEY],
    voice: true,
    name: 'Alex',
    connect: connectTo(origin),
    speak: async function* (text, model) {
      spoken.push({ text, model })
      yield Buffer.concat([Buffer.alloc(32 * 40), tone(text.length > 40 ? 640 : 240)])
    },
    ffmpeg: async () => Promise.reject(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })),
    out: text => void out.push(text),
    log: text => void log.push(text),
    timing: TIMING,
    forceAfterMs: 100,
    holdMs: 200,
    retryWaitMs: 20,
    app: 'agent-voice test',
    date: '2026-11-16 12:00 UTC',
    ...over,
  }
  return { d, out, log, spoken }
}

const args = (...argv: string[]) => {
  const parsed = parseArgs(argv)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.args
}

test('a run says its cost first, then prints the report: settings first, each clip, the checks, the paste line last; no key anywhere, and the JSON is private', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-probe-'))
  try {
    await withFlux({ startAfterMs: 40, endAfterQuietMs: 120 }, async fake => {
      const json = path.join(dir, 'new-folder', 'probe.json')
      const { d, out, log, spoken } = deps(fake.origin, {
        // An ElevenLabs failure that quotes its key is still never printed with it.
        speak: async function* (text) {
          if (text === 'Mm-hmm.') throw new Error(`ElevenLabs 500 for key ${EL_KEY}`)
          yield tone(240)
        },
      })
      const result = await runProbe(args('--only', 'noise-white,bc-mm-hm,bc-mm-hmm,int-wait,force-close,idle', '--idle-max', '0.3', '--json', json), d)
      assert.equal(spoken.length, 0, 'not this one: it was replaced')
      assert.match(out[0], /^Cost: at most about \d+\.\d min of Deepgram audio over 6 streams, and \d+ ElevenLabs characters\. The idle check keeps one stream open up to 0\.3 s/)
      const report = out[1]
      const lines = report.split('\n')
      assert.equal(lines[0], '===== Flux probe report =====')
      assert.match(lines[2], /^Flux: model flux-general-en, eot_threshold 0\.7, 2 keyterms, mip_opt_out true/)
      assert.match(lines[3], /^Session: PAUSE_MAX_MS 1500, TAIL_MS 400, STT_HOLD_MS 3000, STOP_WORDS_PARTIAL 2, STOP_WORDS_FINAL 1, FLUX_CLOSE_WAIT_MS 1000$/)
      assert.equal(lines.at(-1), REPORT_END)
      for (const id of ['noise-white', 'bc-mm-hm', 'int-wait']) assert.match(report, new RegExp(`^${id} \\[`, 'm'))
      assert.match(report, /^bc-mm-hmm: ElevenLabs 500 for key \[key\]$/m)
      assert.match(report, /^force-close: StartOfTurn at t=\d+; ForceEndTurn and CloseStream went 100 ms after it\./m)
      assert.match(report, /^idle: still open after 0\.3 s with no audio\./m)
      assert.match(report, /^cadence: not run/m)
      assert.match(report, /^- int-wait \(interruption "Wait\."\): Alex would only pause, then play on$/m, 'the fake says "Mm-hmm." for everything')
      assert.match(report, /^ {2}Alex would pause, then play on: pause at \d+, play on at \d+ \(its EndOfTurn\)$/m)
      assert.equal(fake.connections.length, 5)
      assert.equal(result.clips.length, 3)
      for (const text of [...out, ...log, fs.readFileSync(json, 'utf8')]) {
        assert.ok(!text.includes(KEY) && !text.includes(EL_KEY), text)
      }
      assert.equal(fs.statSync(json).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(json)).mode & 0o777, 0o700)
      const data = JSON.parse(fs.readFileSync(json, 'utf8'))
      assert.ok(data.clips[0].run.events.length > 0, 'the raw events')
      assert.equal(typeof data.clips[0].run.events[0].t, 'number')
      assert.ok(data.checks.idle.result && data.checks['force-close'].run)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused key stops the run: the status and the short text, and the key is never printed even if the answer has it', async () => {
  const body = JSON.stringify({ err_code: 'INVALID_AUTH', err_msg: `Invalid credentials ${KEY}` })
  await withFlux({ refuse: { status: 401, body } }, async fake => {
    const { d, out, log } = deps(fake.origin)
    await runProbe(args('--only', 'noise-white,noise-cough,idle'), d)
    assert.equal(fake.connections.length, 1, 'no more tries')
    assert.match(out[1], /^Stopped early: Deepgram refused the stream \(401\): INVALID_AUTH: Invalid credentials \[key\]$/m)
    assert.match(out[1], /^idle: not run$/m)
    assert.doesNotMatch(out[1], /^Note: idle/m, 'a check that never ran did not run with silence either')
    for (const text of [...out, ...log]) assert.ok(!text.includes(KEY), text)
  })
})

test('without ElevenLabs: the noise clips and the checks run (with silence), and the spoken clips are skipped on one line', async () => {
  await withFlux({ turns: false }, async fake => {
    const { d, out, spoken } = deps(fake.origin, { voice: false })
    await runProbe(args('--only', 'noise-white,bc,force-only'), d)
    assert.equal(spoken.length, 0)
    assert.equal(fake.connections.length, 2)
    const report = out[1]
    assert.match(report, /^Voice: ElevenLabs is not set up/m)
    assert.match(report, /^Note: force-only: ran with silence instead of the long sentence/m)
    assert.match(report, /^bc-mm-hm, bc-mm-hmm, bc-mhm, .*bc-um: ElevenLabs is not set up \(ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID\)$/m)
    assert.match(out[0], /over 2 streams, and 0 ElevenLabs characters/)
  })
})

test('--mic without ffmpeg says how to install it and skips the microphone clips', async () => {
  await withFlux({}, async fake => {
    const asked: string[] = []
    const { d, out, log } = deps(fake.origin, { ask: async p => void asked.push(p), platform: 'linux' })
    await runProbe(args('--mic', '--only', 'mic'), d)
    assert.deepEqual(asked, [])
    assert.ok(log.some(l => /brew install ffmpeg.*apt install ffmpeg/.test(l)))
    assert.match(out[1], /^mic-cough, mic-laugh, mic-mm-hm, mic-yeah, mic-budget: ffmpeg is not installed\. On macOS: brew install ffmpeg/m)
    assert.equal(fake.connections.length, 0)
  })
})

test('--mic asks before each 3 s recording, records 16 kHz mono with ffmpeg (pulse, else alsa), and streams it', async () => {
  await withFlux({ startAfterMs: 40, endAfterQuietMs: 120 }, async fake => {
    const asked: string[] = []
    const calls: string[][] = []
    const ffmpeg = async (a: string[], onFirstData?: () => void) => {
      calls.push(a)
      if (a.includes('pulse')) throw new Error('ffmpeg exited with 1: Unknown input format: pulse')
      if (a[0] === '-version') return Buffer.from('ffmpeg version 7')
      onFirstData?.()
      return tone(1500)
    }
    const { d, out } = deps(fake.origin, { ask: async p => void asked.push(p), platform: 'linux', ffmpeg })
    await runProbe(args('--mic', '--only', 'mic-cough,mic-yeah'), d)
    assert.deepEqual(asked, [`Press Enter, wait for "Now", then ${MIC_PROMPTS[0].prompt}`, `Press Enter, wait for "Now", then ${MIC_PROMPTS[3].prompt}`])
    const recordings = calls.filter(c => c[0] !== '-version')
    assert.deepEqual(recordings.map(c => c[c.indexOf('-f') + 1]), ['pulse', 'alsa', 'alsa'], 'the input that worked is kept')
    for (const c of recordings) {
      assert.deepEqual(c.slice(c.indexOf('-t'), c.indexOf('-t') + 2), ['-t', '3'])
      assert.ok(c.join(' ').includes('-ac 1 -ar 16000 -f s16le'))
    }
    assert.equal(fake.connections.length, 2)
    assert.match(out[1], /^mic-cough \[noise, mic\] the microphone: cough once: 1\.5 s/m)
    assert.match(out[1], /^- mic-cough \(noise the microphone: cough once\): Flux started a turn/m)
    assert.match(out[1], /^Note: the microphone clips were recorded from ALSA's default device$/m)
  })
})

test('--mic says "Now" only once the recording runs, and skips a recording with no sound in it instead of analysing silence', async () => {
  await withFlux({ startAfterMs: 40, endAfterQuietMs: 120 }, async fake => {
    const timeline: string[] = []
    const ffmpeg = async (a: string[], onFirstData?: () => void) => {
      if (a[0] === '-version') return Buffer.from('ffmpeg version 7')
      timeline.push('ffmpeg starts')
      // macOS takes a while to open the microphone: nothing comes until it has.
      await new Promise(resolve => setTimeout(resolve, 30))
      timeline.push('first audio')
      onFirstData?.()
      // The cough is recorded; the budget question comes from a microphone the terminal may not use: silence.
      return a.join(' ').includes(':default') && timeline.filter(t => t === 'ffmpeg starts').length === 1 ? tone(1500) : Buffer.alloc(3000 * 32)
    }
    const { d, out } = deps(fake.origin, {
      ask: async p => void timeline.push(`ask: ${p}`),
      log: text => void timeline.push(`log: ${text}`),
      platform: 'darwin',
      ffmpeg,
    })
    await runProbe(args('--mic', '--only', 'mic-cough,mic-budget'), d)
    const cough = timeline.slice(timeline.indexOf(`ask: Press Enter, wait for "Now", then ${MIC_PROMPTS[0].prompt}`))
    assert.deepEqual(cough.slice(0, 4), [`ask: Press Enter, wait for "Now", then ${MIC_PROMPTS[0].prompt}`, 'ffmpeg starts', 'first audio', `log: Now: ${MIC_PROMPTS[0].prompt}`])
    assert.equal(fake.connections.length, 1, 'only the cough is streamed')
    assert.match(out[1], /^mic-cough \[noise, mic\]/m)
    assert.doesNotMatch(out[1], /^mic-budget \[/m)
    assert.doesNotMatch(out[1], /interruption-unheard|mic-budget \(interruption/)
    assert.match(out[1], new RegExp(`^mic-budget: ${MIC_SILENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(out[1], /^Note: the microphone clips were recorded from macOS's default input \(avfoundation :default\)$/m)
  })
})

test('a stream refused with 503 is tried again after a wait, and the rest of the run, the checks included, still runs', async () => {
  // The second handshake (noise-cough's) gets 503: Deepgram busy, not a key it refuses.
  await withFlux({ startAfterMs: 40, endAfterQuietMs: 120, refuse: { status: 503, body: '', only: [1] } }, async fake => {
    const { d, out, log } = deps(fake.origin)
    const result = await runProbe(args('--only', 'noise-white,noise-cough,force-only,hold,idle', '--idle-max', '0.3'), d)
    const report = out[1]
    assert.doesNotMatch(report, /Stopped early/)
    assert.equal(fake.connections.length, 6, 'noise-cough twice, then every check')
    assert.ok(log.some(l => /^noise-cough: Deepgram refused the stream \(503\); trying once more in 0\.02 s$/.test(l)), log.join('\n'))
    assert.match(report, /^Note: noise-cough: Deepgram refused the stream \(503\), so it was tried again on a fresh stream$/m)
    assert.match(report, /^noise-cough \[noise, synthetic\][^\n]*\n {2}StartOfTurn/m)
    assert.equal(result.runs.get('noise-cough')?.opened, true)
    assert.match(report, /^force-only: StartOfTurn at t=\d+; ForceEndTurn went 100 ms after it\./m)
    assert.match(report, /^hold: .* StartOfTurn at t=\d+\. EndOfTurn \(trigger manual\)/m)
    assert.match(report, /^idle: still open after 0\.3 s/m)
    assert.match(report, /^Used: [^\n]* over 5 streams/m, 'the refused try opened no stream')
  })
})

test('a stream that fails twice is reported as failed and the run goes on; one handshake left unanswered is tried again too', async () => {
  await withFlux({ turns: false, refuse: { status: 503, body: '', only: [1, 2] } }, async fake => {
    const { d, out } = deps(fake.origin)
    await runProbe(args('--only', 'noise-white,noise-cough,noise-breath'), d)
    assert.equal(fake.connections.length, 4)
    assert.match(out[1], /^noise-cough \[noise, synthetic\][^\n]*\n {2}Deepgram refused the stream \(503\)$/m)
    assert.match(out[1], /^Note: noise-cough: Deepgram refused the stream \(503\), so it was tried again on a fresh stream, which failed too: Deepgram refused the stream \(503\)$/m)
    assert.match(out[1], /^noise-breath \[noise, synthetic\][^\n]*\n {2}No StartOfTurn/m)
    assert.doesNotMatch(out[1], /Stopped early/)
  })
  await withFlux({ turns: false, hang: [0] }, async fake => {
    const { d, out } = deps(fake.origin, { timing: { ...TIMING, openTimeoutMs: 300 } })
    const result = await runProbe(args('--only', 'noise-white'), d)
    assert.equal(fake.connections.length, 2)
    assert.match(out[1], /^Note: noise-white: could not open a stream to Deepgram: no answer from Deepgram within 0\.3 s, so it was tried again on a fresh stream$/m)
    assert.equal(result.runs.get('noise-white')?.opened, true)
  })
})

test('a run where stream after stream will not open stops, rather than waiting out every one twice', async () => {
  await withFlux({ refuse: { status: 503, body: '' } }, async fake => {
    const { d, out } = deps(fake.origin)
    await runProbe(args('--only', 'noise,idle'), d)
    assert.equal(fake.connections.length, 6, 'three items, each tried twice')
    assert.match(out[1], /^Stopped early: 3 streams in a row would not open, even on a second try \(Deepgram refused the stream \(503\)\)$/m)
  })
})

test('a clip whose stream Flux drops partway is tried again on a fresh stream; dropped again, it is marked incomplete and left out', async () => {
  // The first stream is dropped 40 ms after it opens: during the lead silence, before any of the clip has gone.
  await withFlux({ startAfterMs: 40, endAfterQuietMs: 120, drop: { only: [0], afterMs: 40 } }, async fake => {
    const { d, out } = deps(fake.origin)
    const result = await runProbe(args('--only', 'int-wait'), d)
    assert.equal(fake.connections.length, 2)
    assert.match(out[1], /^Note: int-wait: Flux closed the stream at t=-?\d+ \(1006\) before the probe was done with it, so it was tried again on a fresh stream$/m)
    assert.equal(result.clips[0].cutShort, null)
    assert.ok(result.clips[0].start, 'the second stream heard the clip')
  })
  await withFlux({ startAfterMs: 40, endAfterQuietMs: 120, drop: { only: [0, 1], afterMs: 40 } }, async fake => {
    const { d, out } = deps(fake.origin)
    const result = await runProbe(args('--only', 'int-wait'), d)
    assert.equal(fake.connections.length, 2)
    assert.ok(result.clips[0].cutShort)
    assert.match(out[1], /^ {2}Incomplete: the stream closed at t=-?\d+ \(1006\) before the probe was done with the clip, so what Alex would do is not known; left out of the mismatches and suggestions$/m)
    assert.match(out[1], /^-- Mismatches --\n\(none\)$/m, 'not "no StartOfTurn, so Alex would not stop"')
  })
})

test("the hold check mirrors the service's hold path: a second of speech, nothing for STT_HOLD_MS, then ForceEndTurn alone", async () => {
  await withFlux({ startAfterMs: 40 }, async fake => {
    const run = await streamClip({
      url: fluxUrl(), key: KEY, audio: tone(1600), connect: connectTo(fake.origin),
      timing: { leadMs: 80, closeWaitMs: 300, holdWaitMs: 500 }, hold: { audioMs: 240, holdMs: 300 },
    })
    const conn = fake.connections[0]
    assert.equal(sequence(conn), 'SLLL[ForceEndTurn][CloseStream]', 'no audio after the second of speech, and no CloseStream with the ForceEndTurn')
    const texts = conn.received.filter(r => r.kind === 'text')
    between(texts[0].at - audioOf(conn).at(-1)!.at, 290, 420, 'ForceEndTurn after the last audio')
    const h = analyzeHold(run, 300)
    assert.equal(h.forced, true)
    assert.equal(h.end?.trigger, 'manual')
    between(h.end?.afterMs ?? -1, 0, 100, 'EndOfTurn after ForceEndTurn')
    assert.equal(h.endBeforeClose, true)
  })
})

test('a Flux that answers ForceEndTurn only while audio comes passes force-only, and the hold check says the turn would be lost', async () => {
  await withFlux({ startAfterMs: 40, endAfterQuietMs: Infinity, forceNeedsAudio: true }, async fake => {
    const { d, out } = deps(fake.origin)
    await runProbe(args('--only', 'force-only,hold'), d)
    const report = out[1]
    assert.match(report, /^force-only: StartOfTurn at t=\d+; ForceEndTurn went 100 ms after it\. EndOfTurn \(trigger manual\)/m)
    assert.match(report, /^hold: .* StartOfTurn at t=\d+\. No EndOfTurn after ForceEndTurn\.$/m)
    assert.match(report, /^STT_HOLD_MS \(now 3000\): the turn would be lost: after 200 ms with no audio, ForceEndTurn got no EndOfTurn/m)
  })
})

test('--files streams each WAV by its name, converts others with ffmpeg, and skips what it cannot read, saying why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-probe-files-'))
  const wav = (pcm: Buffer, rate: number, channels: number) => {
    const head = Buffer.alloc(44)
    head.write('RIFF', 0, 'latin1')
    head.writeUInt32LE(36 + pcm.length, 4)
    head.write('WAVEfmt ', 8, 'latin1')
    head.writeUInt32LE(16, 16)
    head.writeUInt16LE(1, 20)
    head.writeUInt16LE(channels, 22)
    head.writeUInt32LE(rate, 24)
    head.writeUInt32LE(rate * channels * 2, 28)
    head.writeUInt16LE(channels * 2, 32)
    head.writeUInt16LE(16, 34)
    head.write('data', 36, 'latin1')
    head.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([head, pcm])
  }
  fs.writeFileSync(path.join(dir, 'backchannel-mhm.wav'), wav(tone(240), 16000, 1))
  fs.writeFileSync(path.join(dir, 'noise-door.WAV'), wav(tone(240), 44100, 2))
  fs.writeFileSync(path.join(dir, 'broken.wav'), 'not audio')
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored')
  try {
    await withFlux({ startAfterMs: 40, endAfterQuietMs: 120 }, async fake => {
      const { d, out } = deps(fake.origin)
      await runProbe(args('--files', dir, '--only', 'file'), d)
      assert.equal(fake.connections.length, 1)
      assert.match(out[1], /^file-backchannel-mhm \[backchannel, file\] backchannel-mhm\.wav: 0\.2 s/m)
      assert.match(out[1], /^file-broken: not a WAV file$/m)
      assert.match(out[1], /^file-noise-door: 16-bit PCM, 2 channels, 44100 Hz, not 16 kHz mono PCM16, and ffmpeg is not installed/m)
    })
    await withFlux({ startAfterMs: 40, endAfterQuietMs: 120 }, async fake => {
      const converted: string[][] = []
      const ffmpeg = async (a: string[]) => (converted.push(a), a[0] === '-version' ? Buffer.alloc(0) : tone(240))
      const { d } = deps(fake.origin, { ffmpeg })
      const result = await runProbe(args('--files', dir, '--only', 'file-noise-door'), d)
      assert.equal(fake.connections.length, 1)
      assert.deepEqual(converted.at(-1)?.slice(converted.at(-1)!.indexOf('-i'), converted.at(-1)!.indexOf('-i') + 2), ['-i', path.join(dir, 'noise-door.WAV')])
      assert.equal(result.clips[0].intent, 'noise', 'what a file is meant to be comes from its name')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--nonverbal asks ElevenLabs for the tags on its tagged model, best effort: one it refuses is "not available"', async () => {
  await withFlux({ turns: false }, async fake => {
    const { d, out, spoken } = deps(fake.origin, {
      speak: async function* (text, model) {
        spoken.push({ text, model })
        if (text === '[laughs]') throw new Error('ElevenLabs 400 (invalid_tag)')
        yield tone(300)
      },
    })
    await runProbe(args('--nonverbal', '--only', 'nv-coughs,nv-laughs'), d)
    assert.deepEqual(spoken, [{ text: '[coughs]', model: NONVERBAL_TTS_MODEL }, { text: '[laughs]', model: NONVERBAL_TTS_MODEL }])
    assert.equal(fake.connections.length, 1)
    assert.match(out[1], /^nv-laughs: not available: ElevenLabs 400 \(invalid_tag\)$/m)
  })
})

test('a long sentence ElevenLabs could not make is asked for once; its clip is skipped and the checks run with silence, saying why', async () => {
  await withFlux({ turns: false }, async fake => {
    const { d, out, spoken } = deps(fake.origin, {
      speak: async function* (text, model) {
        spoken.push({ text, model })
        if (text.length > 40) throw new Error('ElevenLabs 500 (busy)')
        yield tone(240)
      },
    })
    await runProbe(args('--only', 'int-long,force-only'), d)
    assert.equal(spoken.length, 1)
    assert.match(out[1], /^int-long: ElevenLabs 500 \(busy\)$/m)
    assert.match(out[1], /^Note: force-only: ran with silence instead of the long sentence \(ElevenLabs 500 \(busy\)\)$/m)
    assert.doesNotMatch(out[1], /^force-only: ElevenLabs/m, 'the check is not skipped: it ran')
  })
})

test('the spoken clips use the voice and model the service uses', async () => {
  await withFlux({ turns: false }, async fake => {
    const { d, spoken } = deps(fake.origin)
    await runProbe(args('--only', 'bc-mhm'), d)
    assert.deepEqual(spoken, [{ text: 'Mhm.', model: undefined }], `so synthesize() picks ${TTS_MODEL}`)
  })
})

test('--only that matches nothing is an error, before anything is spent', async () => {
  const { d, out } = deps('ws://127.0.0.1:1')
  await assert.rejects(runProbe(args('--only', 'bc-mm-hm,nope'), d), /--only: nope matches no clip or check/)
  assert.deepEqual(out, [])
})
