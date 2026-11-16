// npm run flux-probe's command line, its plan of clips, the costs line, the report's shape, and the CLI itself: its
// errors, and that it never prints a key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import type { ClipAnalysis } from '../src/probe/flux-analysis.ts'
import {
  BACKCHANNELS, CHECKS, IDLE_MAX_S, LONG_SENTENCE, USAGE, buildPlan, costLine, intentOfFile, interruptions, micInputs, parseArgs, redact,
  selectPlan,
} from '../src/probe/flux-probe.ts'
import { REPORT_END, type ReportInput, describeVerdict, formatReport } from '../src/probe/flux-report.ts'

const ok = (argv: string[]) => {
  const parsed = parseArgs(argv)
  assert.ok('args' in parsed, 'error' in parsed ? parsed.error : '')
  return parsed.args
}
const bad = (argv: string[]) => {
  const parsed = parseArgs(argv)
  assert.ok('error' in parsed, `${argv.join(' ')} should be refused`)
  return parsed.error
}

test('the command line: every option, with defaults', () => {
  assert.deepEqual(ok([]), { mic: false, files: null, nonverbal: false, json: null, idleMaxS: IDLE_MAX_S, only: null, help: false })
  assert.equal(IDLE_MAX_S, 90)
  assert.deepEqual(
    ok(['--mic', '--files', 'clips', '--nonverbal', '--json', 'out/probe.json', '--idle-max', '30', '--only', 'bc-mm-hm, noise', '--only', 'idle']),
    { mic: true, files: 'clips', nonverbal: true, json: 'out/probe.json', idleMaxS: 30, only: ['bc-mm-hm', 'noise', 'idle'], help: false },
  )
  assert.deepEqual(ok(['--files=my clips', '--idle-max=2.5']).files, 'my clips')
  assert.equal(ok(['--idle-max=2.5']).idleMaxS, 2.5)
  assert.equal(ok(['-h']).help, true)
})

test('the command line refuses what it does not know, and an option without its value', () => {
  assert.match(bad(['--mics']), /^Unknown option --mics\.\nUsage: npm run flux-probe/)
  assert.match(bad(['extra']), /Unknown option extra/)
  assert.match(bad(['--files']), /--files needs a value/)
  assert.match(bad(['--json', '--mic']), /--json needs a value/, 'the next option is not its value')
  assert.match(bad(['--only', '']), /--only needs a value/)
  assert.match(bad(['--idle-max', '0']), /--idle-max takes seconds/)
  assert.match(bad(['--idle-max', 'soon']), /--idle-max takes seconds/)
  assert.match(bad(['--idle-max', '601']), /--idle-max takes seconds/)
  assert.match(bad(['--mic=yes']), /--mic takes no value/)
  assert.ok(USAGE.includes('--idle-max <seconds>') && USAGE.includes('--only <ids>'))
})

test("the plan: the noise clips, the backchannels and interruptions (two with the assistant's name), then the checks", () => {
  const plan = buildPlan({ mic: false, nonverbal: false }, 'Nova')
  const ids = plan.map(p => p.id)
  assert.deepEqual(ids.slice(0, 4), ['noise-silence', 'noise-white', 'noise-cough', 'noise-breath'])
  assert.deepEqual(ids.slice(-3), [...CHECKS])
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.deepEqual(plan.filter(p => p.intent === 'backchannel').map(p => p.text), [...BACKCHANNELS])
  assert.equal(BACKCHANNELS.length, 17)
  const spoken = plan.filter(p => p.intent === 'interruption' && p.kind === 'clip')
  assert.deepEqual(spoken.map(p => p.text), ['Wait.', 'No.', 'Thanks.', 'Hold on, what about the budget?', 'Nova, never mind.', 'Nova, please leave.', LONG_SENTENCE])
  assert.deepEqual(interruptions('Nova').slice(4, 6), ['Nova, never mind.', 'Nova, please leave.'])
  assert.ok(spoken.every(p => !p.id.toLowerCase().includes('nova')), 'ids never hold the name')
  assert.ok(ids.includes('bc-mm-hm') && ids.includes('bc-sorry-go-ahead') && ids.includes('int-long'))
  const words = LONG_SENTENCE.split(' ').length
  assert.ok(words >= 16 && words <= 22, 'about 6 s of speech')
  assert.ok(!ids.some(id => id.startsWith('mic-') || id.startsWith('nv-')), 'only when asked for')
  const more = buildPlan({ mic: true, nonverbal: true }, 'Nova', ['/x/Interruption-wait.wav', '/x/noise_door.wav', '/y/noise_door.wav', '/x/other.wav'])
  assert.deepEqual(more.filter(p => p.source === 'nonverbal').map(p => p.text), ['[coughs]', '[laughs]', '[clears throat]'])
  assert.deepEqual(more.filter(p => p.source === 'mic').map(p => p.id), ['mic-cough', 'mic-laugh', 'mic-mm-hm', 'mic-yeah', 'mic-budget'])
  const files = more.filter(p => p.source === 'file')
  assert.deepEqual(files.map(p => [p.id, p.intent, p.label]), [
    ['file-interruption-wait', 'interruption', 'Interruption-wait.wav'],
    ['file-noise-door', 'noise', 'noise_door.wav'],
    ['file-noise-door-2', 'noise', 'noise_door.wav'],
    ['file-other', 'unknown', 'other.wav'],
  ])
})

test('what a WAV file is meant to be comes from the start of its name', () => {
  assert.equal(intentOfFile('backchannel-mhm.wav'), 'backchannel')
  assert.equal(intentOfFile('bc_yeah.wav'), 'backchannel')
  assert.equal(intentOfFile('INT wait.wav'), 'interruption')
  assert.equal(intentOfFile('noise.door.wav'), 'noise')
  assert.equal(intentOfFile('noisy.wav'), 'unknown')
  assert.equal(intentOfFile('sample.wav'), 'unknown')
})

test('--only picks by id or by the start of ids; cadence is the long sentence; one that picks nothing is reported', () => {
  const plan = buildPlan({ mic: false, nonverbal: false }, 'Nova')
  const pick = (...only: string[]) => selectPlan(plan, only)
  assert.deepEqual(pick('bc-mm-hm').items.map(p => p.id), ['bc-mm-hm'], 'not bc-mm-hmm')
  assert.equal(pick('bc').items.length, 17)
  assert.deepEqual(pick('noise').items.map(p => p.id), ['noise-silence', 'noise-white', 'noise-cough', 'noise-breath'])
  assert.deepEqual(pick('cadence', 'idle').items.map(p => p.id), ['int-long', 'idle'])
  assert.deepEqual(pick('force').items.map(p => p.id), ['force-close', 'force-only'])
  assert.deepEqual(pick('bc-mm').items.map(p => p.id), ['bc-mm-hm', 'bc-mm-hmm'])
  assert.deepEqual(pick('bc-m', 'mic', 'int-wait').unknown, ['bc-m', 'mic'])
  assert.equal(selectPlan(plan, null).items, plan)
})

test("the costs line: at most how much Deepgram audio, and ElevenLabs' characters, before anything is spent", () => {
  const plan = buildPlan({ mic: false, nonverbal: true }, 'Nova')
  const o = { voice: true, leadMs: 500, tailMaxMs: 7000, idleMaxS: 90 }
  const pick = (...only: string[]) => selectPlan(plan, only).items
  // 300 ms of white noise: 0.5 + 0.3 + 7 s.
  assert.match(costLine(pick('noise-white'), o), /^Cost: at most about 0\.1 min of Deepgram audio over 1 streams, and 0 ElevenLabs characters\.$/)
  // "Okay." is 5 characters; the long sentence counts once, for its clip and the checks.
  const line = costLine(pick('bc-okay', 'int-long', 'force-close', 'idle'), o)
  assert.match(line, new RegExp(`over 4 streams, and ${5 + LONG_SENTENCE.length} ElevenLabs characters\\. The idle check keeps one stream open up to 90 s with 1\\.5 s of audio in it\\.$`))
  assert.match(costLine(pick('nv-coughs'), o), /and 0 ElevenLabs characters \(and 8 more on ElevenLabs' tagged model for --nonverbal\)/)
  assert.match(costLine(pick('bc', 'noise-white'), { ...o, voice: false }), /over 1 streams, and 0 ElevenLabs characters/, 'without a voice, no spoken clips')
  const all = costLine(plan, o)
  const minutes = Number(/about (\d+\.\d) min/.exec(all)?.[1])
  assert.ok(minutes > 3 && minutes < 8, `${minutes} min for a full run`)
})

test('redact takes every key out of a text, wherever it is', () => {
  assert.equal(redact('a sk-123456 b sk-123456 el-999999', ['sk-123456', 'el-999999', '']), 'a [key] b [key] [key]')
  assert.equal(redact('abc', ['ab']), 'abc', 'too short to be a key: left alone')
})

test('the microphone is recorded through avfoundation on macOS, pulse then alsa on Linux, and nothing elsewhere', () => {
  assert.deepEqual(micInputs('darwin'), [['-f', 'avfoundation', '-i', ':0']])
  assert.deepEqual(micInputs('linux'), [['-f', 'pulse', '-i', 'default'], ['-f', 'alsa', '-i', 'default']])
  assert.deepEqual(micInputs('win32'), [])
})

function clip(over: Partial<ClipAnalysis>): ClipAnalysis {
  return {
    id: 'bc-yeah', intent: 'backchannel', source: 'tts', label: 'Yeah.', clipMs: 420, onsetMs: 30, turns: 1,
    start: { t: 400, transcript: 'Yeah.', fromOnsetMs: 370, firstWordT: 60 }, updates: ['Yeah.'], updateCount: 9, notices: [],
    end: { t: 1500, afterClipMs: 1080, transcript: 'Yeah.', trigger: 'model', confidence: 0.82 }, startToEndMs: 1100,
    verdict: { kind: 'pause-resume', actions: [{ t: 400, what: 'pause', by: 'start' }, { t: 1500, what: 'resume', by: 'end' }] },
    mismatch: null, close: { t: 2600, code: 1005, reason: '', by: 'server' }, closeStreamT: 2580, refused: null, error: null,
    ...over,
  }
}

function report(over: Partial<ReportInput> = {}): string {
  return formatReport({
    name: 'Nova', app: 'agent-voice 0.1.0', node: 'v24.0.0', date: '2026-11-16 12:00 UTC',
    flux: { model: 'flux-general-en', eotThreshold: '0.7', keyterms: 3, mipOptOut: 'true' },
    constants: { pauseMaxMs: 1500, tailMs: 400, sttHoldMs: 3000, closeWaitMs: 1000, stopWordsPartial: 2, stopWordsFinal: 1 },
    voice: 'ElevenLabs', usage: { deepgramMs: 120_000, streams: 1, elevenLabsChars: 5, lateMs: 3 }, leadMs: 500, tailMaxMs: 7000, forceAfterMs: 1500,
    clips: [clip({})], force: [], idle: null, cadence: null,
    suggestions: { pauseMaxMs: { none: 'none' }, tailMs: { value: 400, from: 370, clips: 1 }, sttHold: { ok: false, text: 'not checked' }, spellings: [] },
    skipped: [], notes: [],
    ...over,
  })
}

test('the report: the settings that matter first, each clip with what the assistant would do, the paste line last', () => {
  const text = report()
  const lines = text.split('\n')
  assert.equal(lines[0], '===== Flux probe report =====')
  assert.equal(lines[1], 'agent-voice 0.1.0, Node v24.0.0, 2026-11-16 12:00 UTC')
  assert.match(lines[2], /^Flux: model flux-general-en, eot_threshold 0\.7, 3 keyterms, mip_opt_out true/)
  assert.match(lines[3], /^Session: PAUSE_MAX_MS 1500, TAIL_MS 400, STT_HOLD_MS 3000, STOP_WORDS_PARTIAL 2, STOP_WORDS_FINAL 1, FLUX_CLOSE_WAIT_MS 1000$/)
  assert.match(text, /^Used: about 2\.0 min of Deepgram audio over 1 stream, 5 ElevenLabs characters; the audio went at most 3 ms behind real time, never ahead$/m)
  assert.equal(lines.at(-1), REPORT_END)
  assert.equal(REPORT_END, 'Paste this whole report back to your Claude Code session.')
  assert.match(text, /^bc-yeah \[backchannel, tts\] "Yeah\.": 0\.4 s, sound from 30 ms$/m)
  assert.match(text, /^ {2}StartOfTurn t=400, 370 ms after the sound starts; Flux put its first word at t=60: "Yeah\."$/m)
  assert.match(text, /^ {2}EndOfTurn t=1500, 1080 ms after the clip ended, trigger model, confidence 0\.82: "Yeah\."; StartOfTurn to EndOfTurn 1100 ms$/m)
  assert.match(text, /^ {2}Nova would pause, then play on: pause at 400, play on at 1500 \(its EndOfTurn\)$/m)
  assert.match(text, /^ {2}Closed: 1005, 20 ms after CloseStream$/m)
  assert.match(text, /^TAIL_MS ≈ 400 \(now 400\): median StartOfTurn delay from the sound starting 370 ms over 1 spoken clip, within 200 to 1000$/m)
  assert.match(text, /^PAUSE_MAX_MS \(now 1500\): no suggestion, none$/m)
  assert.match(text, /^-- Mismatches --\n\(none\)$/m)
  assert.match(text, /^Spellings to add: none \(no backchannel clip would stop Nova\)$/m)
})

test('the report lists the spellings to learn, or says why there are none when a backchannel would still stop', () => {
  const stops = clip({ mismatch: { kind: 'backchannel-stops', text: "Let's move the launch", counted: ['move', 'launch'] } })
  const none = report({ clips: [stops] })
  assert.match(none, /^Spellings to add: none: Flux heard more than a backchannel in each that would stop Nova \(see Mismatches\)$/m)
  assert.match(none, /^- bc-yeah \(backchannel "Yeah\."\): Nova would stop, on Flux's "Let's move the launch"; the words that counted: "move", "launch"$/m)
  const spelled = report({
    clips: [stops],
    suggestions: {
      pauseMaxMs: { none: 'none' }, tailMs: { none: 'none' }, sttHold: { ok: true, text: 'fine' },
      spellings: [{ list: 'BACKCHANNEL_SOUND', add: 'mhmh', flux: 'Mhmh.', clip: 'bc-mhm' }],
    },
  })
  assert.match(spelled, /^Spellings of backchannels that would stop Nova, for src\/brain\/attention\.ts:\n {2}BACKCHANNEL_SOUND: "mhmh" \(Flux wrote "Mhmh\." for bc-mhm\)$/m)
})

test("the report shows Flux's Error and Warning messages, a refusal, and skips grouped by their reason", () => {
  const text = report({
    clips: [clip({ notices: ['Error INTERNAL_SERVER_ERROR: oops'] }), clip({ id: 'bc-ok', refused: { status: 401, text: 'INVALID_AUTH: Invalid credentials.' } })],
    skipped: [{ id: 'bc-a', why: 'no voice' }, { id: 'nv-coughs', why: 'not available: ElevenLabs 400' }, { id: 'bc-b', why: 'no voice' }],
    notes: ['force-close: ran with silence'],
    stopped: 'Deepgram refused the stream (401)',
  })
  assert.match(text, /^ {2}Flux sent Error INTERNAL_SERVER_ERROR: oops$/m)
  assert.match(text, /^ {2}Deepgram refused the stream \(401\): INVALID_AUTH: Invalid credentials\.$/m)
  assert.match(text, /^bc-a, bc-b: no voice$/m)
  assert.match(text, /^nv-coughs: not available: ElevenLabs 400$/m)
  assert.match(text, /^Stopped early: Deepgram refused the stream \(401\)$/m)
  assert.match(text, /^Note: force-close: ran with silence$/m)
})

test("what the assistant would do, in words, for each verdict", () => {
  assert.equal(describeVerdict('Nova', { kind: 'nothing', actions: [] }), 'Nova would do nothing (no StartOfTurn)')
  assert.equal(describeVerdict('Nova', { kind: 'stop', actions: [{ t: 300, what: 'stop', by: 'start', text: 'Hold on what' }] }), 'Nova would stop at once: stop at 300 (its StartOfTurn "Hold on what")')
  assert.equal(
    describeVerdict('Nova', { kind: 'pause-resume', actions: [{ t: 300, what: 'pause', by: 'start' }, { t: 1800, what: 'resume', by: 'wait' }] }),
    'Nova would pause, then play on: pause at 300, play on at 1800 (PAUSE_MAX_MS running out)',
  )
  assert.equal(
    describeVerdict('Nova', { kind: 'pause-stop', actions: [{ t: 300, what: 'pause', by: 'start' }, { t: 900, what: 'stop', by: 'end', text: 'Wait.' }] }),
    'Nova would pause, then stop: pause at 300, stop at 900 (its EndOfTurn "Wait.")',
  )
})

/** Runs the CLI as npm run flux-probe would, with this environment on top of the test's. */
function cli(argv: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/cli/flux-probe.ts'), ...argv], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000,
  })
}

test('the CLI refuses an unknown option, says when DEEPGRAM_API_KEY is missing, and prints no key when a run fails', () => {
  const unknown = cli(['--bogus'], { DEEPGRAM_API_KEY: 'dg-cli-key-never-printed' })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown option --bogus\.\nUsage: npm run flux-probe/)
  const help = cli(['--help'], {})
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^Usage: npm run flux-probe/)
  const missing = cli([], { DEEPGRAM_API_KEY: ' ' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /DEEPGRAM_API_KEY is not set/)
  // A folder that is not there fails before anything is sent anywhere, and the error has no key in it.
  const key = 'dg-cli-key-never-printed'
  const noFolder = cli(['--files', `/nonexistent/${key}`, '--only', 'noise-white'], { DEEPGRAM_API_KEY: key, ELEVENLABS_API_KEY: '' })
  assert.equal(noFolder.status, 1)
  assert.match(noFolder.stderr, /flux-probe: --files: \/nonexistent\/\[key\] is not a folder/)
  assert.ok(!`${noFolder.stdout}${noFolder.stderr}`.includes(key))
})
