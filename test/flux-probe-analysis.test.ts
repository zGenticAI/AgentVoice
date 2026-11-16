// npm run flux-probe's analysis, on recorded event sequences: what the session would do with each, the mismatches,
// the suggestions' math and bounds, the cadence and the protocol checks. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wordsThatCount } from '../src/brain/attention.ts'
import { PAUSE_MAX_MS, STOP_WORDS_FINAL, STOP_WORDS_PARTIAL } from '../src/pipeline/session.ts'
import {
  type ClipAnalysis, type ClipInfo, type IdleResult, type SessionRules, analyzeClip, analyzeForce, analyzeHold, analyzeIdle, cadence,
  countingWords, cutShort, median, percentile, simulate, suggest,
} from '../src/probe/flux-analysis.ts'
import type { ProbeEvent, StreamRun } from '../src/probe/flux-stream.ts'
import { SESSION_RULES } from '../src/probe/flux-probe.ts'

const RULES: SessionRules = { pauseMaxMs: 1500, stopWordsPartial: 2, stopWordsFinal: 1, wordsThatCount }
const NOW = { pauseMaxMs: 1500, tailMs: 400, sttHoldMs: 3000, closeWaitMs: 1000 }

/** A TurnInfo message at t. */
function ev(t: number, event: string, transcript = '', extra: Record<string, unknown> = {}): ProbeEvent {
  return { t, msg: { type: 'TurnInfo', event, turn_index: 0, transcript, ...extra } }
}

function run(events: ProbeEvent[], over: Partial<StreamRun> = {}): StreamRun {
  return { opened: true, clipMs: 600, events, lastAudioT: 1600, audioMs: 2000, lateMs: 0, ...over }
}

const info = (id: string, intent: ClipInfo['intent'], source: ClipInfo['source'] = 'tts'): ClipInfo => ({ id, intent, source, label: id })

test("the probe plays the session's own rules: its constants and its attention rules", () => {
  assert.equal(SESSION_RULES.pauseMaxMs, PAUSE_MAX_MS)
  assert.equal(SESSION_RULES.stopWordsPartial, STOP_WORDS_PARTIAL)
  assert.equal(SESSION_RULES.stopWordsFinal, STOP_WORDS_FINAL)
  assert.equal(SESSION_RULES.wordsThatCount, wordsThatCount)
})

test('no StartOfTurn: the assistant does nothing, whatever Updates come', () => {
  const v = simulate([ev(-200, 'Update'), ev(50, 'Update'), ev(300, 'Update', 'Hold on what')], RULES)
  assert.equal(v.kind, 'nothing')
  assert.deepEqual(v.actions, [])
})

test('two words that count in the StartOfTurn stop the assistant at once', () => {
  const v = simulate([ev(400, 'StartOfTurn', 'Hold on, what'), ev(700, 'EndOfTurn', 'Hold on, what about it?')], RULES)
  assert.equal(v.kind, 'stop')
  assert.deepEqual(v.actions, [{ t: 400, what: 'stop', by: 'start', text: 'Hold on, what' }])
})

test('a backchannel pauses, and its EndOfTurn plays the page on', () => {
  const v = simulate([ev(450, 'StartOfTurn', 'Mm-hmm.'), ev(700, 'Update', 'Mm-hmm.'), ev(1300, 'EndOfTurn', 'Mm-hmm.', { trigger: 'model' })], RULES)
  assert.equal(v.kind, 'pause-resume')
  assert.deepEqual(v.actions, [
    { t: 450, what: 'pause', by: 'start' },
    { t: 1300, what: 'resume', by: 'end' },
  ])
})

test('a pause with no verdict plays on once PAUSE_MAX_MS has passed, even with no message then', () => {
  const v = simulate([ev(450, 'StartOfTurn', 'Yeah.'), ev(2500, 'EndOfTurn', 'Yeah.', { trigger: 'timeout' })], RULES)
  assert.equal(v.kind, 'pause-resume')
  assert.deepEqual(v.actions.map(a => [a.t, a.what, a.by]), [[450, 'pause', 'start'], [1950, 'resume', 'wait']])
  const open = simulate([ev(100, 'StartOfTurn', 'Uh')], RULES)
  assert.deepEqual(open.actions.map(a => [a.t, a.what, a.by]), [[100, 'pause', 'start'], [1600, 'resume', 'wait']], 'no EndOfTurn at all')
  const longer = simulate([ev(450, 'StartOfTurn', 'Yeah.'), ev(2500, 'EndOfTurn', 'Yeah.')], { ...RULES, pauseMaxMs: 2500 })
  assert.deepEqual(longer.actions.map(a => [a.t, a.what, a.by]), [[450, 'pause', 'start'], [2500, 'resume', 'end']], 'PAUSE_MAX_MS is the rules\'')
})

test('a single word that counts pauses, then stops at its EndOfTurn: STOP_WORDS_FINAL', () => {
  const v = simulate([ev(300, 'StartOfTurn', 'Wait'), ev(500, 'Update', 'Wait.'), ev(900, 'EndOfTurn', 'Wait.')], RULES)
  assert.equal(v.kind, 'pause-stop')
  assert.deepEqual(v.actions.map(a => [a.t, a.what, a.by]), [[300, 'pause', 'start'], [900, 'stop', 'end']])
})

test('an Update with two words that count stops a paused turn: STOP_WORDS_PARTIAL', () => {
  const v = simulate([ev(300, 'StartOfTurn', 'Wait'), ev(550, 'Update', 'Wait, what'), ev(900, 'EndOfTurn', 'Wait, what?')], RULES)
  assert.equal(v.kind, 'pause-stop')
  assert.deepEqual(v.actions.at(-1), { t: 550, what: 'stop', by: 'update', text: 'Wait, what' })
  const three = simulate([ev(300, 'StartOfTurn', 'Wait'), ev(550, 'Update', 'Wait, what')], { ...RULES, stopWordsPartial: 3 })
  assert.equal(three.kind, 'pause-resume', 'the threshold is the rules\'')
})

test('the turn is still watched after PAUSE_MAX_MS: words that come later still stop, and once stopped nothing more happens', () => {
  const v = simulate(
    [ev(100, 'StartOfTurn', 'So'), ev(1700, 'Update', 'So the budget'), ev(1900, 'EndOfTurn', 'So the budget.'), ev(2500, 'StartOfTurn', 'And')],
    RULES,
  )
  assert.equal(v.kind, 'pause-stop')
  assert.deepEqual(v.actions.map(a => [a.t, a.what, a.by]), [[100, 'pause', 'start'], [1600, 'resume', 'wait'], [1700, 'stop', 'update']])
})

test('a second turn after the page played on pauses it again', () => {
  const v = simulate([ev(100, 'StartOfTurn', 'Mm-hmm.'), ev(600, 'EndOfTurn', 'Mm-hmm.'), ev(900, 'StartOfTurn', 'Yeah.'), ev(1400, 'EndOfTurn', 'Yeah.')], RULES)
  assert.equal(v.kind, 'pause-resume')
  assert.deepEqual(v.actions.map(a => a.what), ['pause', 'resume', 'pause', 'resume'])
})

test('a clip is measured: StartOfTurn from the clip and from its sound, first word, Updates, EndOfTurn after the clip, start to end', () => {
  const events = [
    { t: -300, msg: { type: 'Connected', request_id: 'r' } },
    ev(-200, 'Update', ''),
    ev(520, 'StartOfTurn', 'Mhm.', { words: [{ word: 'mhm', start: '0.62', end: 0.9 }] }),
    ev(760, 'Update', 'Mhm.'),
    ev(1000, 'Update', 'Mhm.'),
    ev(1240, 'Update', 'Mm-hmm.'),
    ev(1830, 'EndOfTurn', 'Mm-hmm.', { trigger: 'model', end_of_turn_confidence: '0.81' }),
  ]
  const a = analyzeClip(info('bc-mhm', 'backchannel'), run(events, { clipMs: 620 }), RULES, { onsetMs: 40, leadMs: 500 })
  assert.equal(a.turns, 1)
  assert.deepEqual(a.start, { t: 520, transcript: 'Mhm.', fromOnsetMs: 480, firstWordT: 120 })
  assert.deepEqual(a.updates, ['Mhm.', 'Mm-hmm.'], 'each change once, only during the turn')
  assert.equal(a.updateCount, 4)
  assert.deepEqual(a.end, { t: 1830, afterClipMs: 1210, transcript: 'Mm-hmm.', trigger: 'model', confidence: 0.81 })
  assert.equal(a.startToEndMs, 1310)
  assert.equal(a.verdict.kind, 'pause-resume')
  assert.equal(a.mismatch, null)
  const silent = analyzeClip(info('noise-silence', 'noise', 'synthetic'), run([ev(100, 'Update')]), RULES, { onsetMs: null, leadMs: 500 })
  assert.equal(silent.start, null)
  assert.equal(silent.end, null)
  assert.equal(silent.startToEndMs, null)
  assert.equal(silent.verdict.kind, 'nothing')
})

test("mismatches: a backchannel that would stop (with Flux's spelling and the words that counted), an interruption that only pauses or is not heard, noise that starts a turn", () => {
  const rules = RULES
  const stops = analyzeClip(info('bc-got-it', 'backchannel'), run([ev(400, 'StartOfTurn', 'Okay,'), ev(1200, 'EndOfTurn', 'Okay, I got it.')]), rules, { onsetMs: 0, leadMs: 500 })
  assert.deepEqual(stops.mismatch, { kind: 'backchannel-stops', text: 'Okay, I got it.', counted: ['i'] })
  const fine = analyzeClip(info('bc-yeah', 'backchannel'), run([ev(400, 'StartOfTurn', 'Yeah.'), ev(900, 'EndOfTurn', 'Yeah.')]), rules, { onsetMs: 0, leadMs: 500 })
  assert.equal(fine.mismatch, null)
  const resumes = analyzeClip(info('int-thanks', 'interruption'), run([ev(400, 'StartOfTurn', 'Thanks.'), ev(3000, 'EndOfTurn', '')]), rules, { onsetMs: 0, leadMs: 500 })
  assert.deepEqual(resumes.mismatch, { kind: 'interruption-resumes' })
  const stopsRight = analyzeClip(info('int-wait', 'interruption'), run([ev(400, 'StartOfTurn', 'Wait.'), ev(900, 'EndOfTurn', 'Wait.')]), rules, { onsetMs: 0, leadMs: 500 })
  assert.equal(stopsRight.mismatch, null)
  const unheard = analyzeClip(info('int-no', 'interruption'), run([ev(400, 'Update', '')]), rules, { onsetMs: 0, leadMs: 500 })
  assert.deepEqual(unheard.mismatch, { kind: 'interruption-unheard' })
  const cough = analyzeClip(info('noise-cough', 'noise', 'synthetic'), run([ev(400, 'StartOfTurn', 'Uh'), ev(900, 'EndOfTurn', 'Uh.')]), rules, { onsetMs: 0, leadMs: 500 })
  assert.deepEqual(cough.mismatch, { kind: 'noise-starts', text: 'Uh' })
  const quiet = analyzeClip(info('noise-white', 'noise', 'synthetic'), run([ev(400, 'Update', '')]), rules, { onsetMs: 0, leadMs: 500 })
  assert.equal(quiet.mismatch, null)
  const unknown = analyzeClip(info('file-x', 'unknown', 'file'), run([ev(400, 'StartOfTurn', 'Hold on, what'), ev(900, 'EndOfTurn', 'Hold on.')]), rules, { onsetMs: 0, leadMs: 500 })
  assert.equal(unknown.mismatch, null, 'a file with no intent in its name has no expectation to miss')
})

test('the words that counted leave out a phrase that counts nothing as a whole', () => {
  assert.deepEqual(countingWords('Okay, I got it.', RULES), ['i'])
  assert.deepEqual(countingWords('Mm-hmm, mhmm.', RULES), [])
  assert.deepEqual(countingWords('Yeah, nope.', RULES), ['nope'])
  assert.deepEqual(countingWords('Alex, that makes sense.', RULES), ['alex'], 'the name always counts')
})

test('percentile is nearest-rank and median averages the middle two', () => {
  assert.equal(percentile([5, 1, 4, 2, 3, 6, 7, 8, 9, 10], 90), 9)
  assert.equal(percentile([700], 90), 700)
  assert.equal(percentile([100, 200], 90), 200)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.ok(Number.isNaN(median([])))
})

/** A clip analysis with just what suggest() reads. */
function clipWith(over: Partial<ClipAnalysis>): ClipAnalysis {
  return {
    id: 'c', intent: 'backchannel', source: 'tts', label: 'c', opened: true, clipMs: 600, onsetMs: 0, turns: 1, start: null, updates: [], updateCount: 0,
    notices: [], end: null, startToEndMs: null, verdict: { kind: 'pause-resume', actions: [] }, mismatch: null, close: null, closeStreamT: null,
    cutShort: null, refused: null, error: null,
    ...over,
  }
}

test('PAUSE_MAX_MS: p90 of StartOfTurn to EndOfTurn over the backchannels that played on, plus 300, to 50 ms, within 800 to 3000', () => {
  const gaps = [600, 700, 800, 900, 1000, 1100, 1200, 1300, 1420, 2000]
  const clips = gaps.map((g, i) => clipWith({ id: `bc-${i}`, startToEndMs: g }))
  // Not counted: an interruption, a backchannel that stopped, one with no EndOfTurn.
  clips.push(clipWith({ intent: 'interruption', startToEndMs: 9000 }))
  clips.push(clipWith({ startToEndMs: 9000, verdict: { kind: 'pause-stop', actions: [] } }))
  clips.push(clipWith({ startToEndMs: null }))
  const s = suggest(clips, null, NOW)
  assert.deepEqual(s.pauseMaxMs, { value: 1700, from: 1420, clips: 10 })
  assert.deepEqual(suggest([clipWith({ startToEndMs: 200 })], null, NOW).pauseMaxMs, { value: 800, from: 200, clips: 1 }, 'never under 800')
  assert.deepEqual(suggest([clipWith({ startToEndMs: 4100 })], null, NOW).pauseMaxMs, { value: 3000, from: 4100, clips: 1 }, 'never over 3000')
  assert.ok('none' in suggest([clipWith({ intent: 'noise', startToEndMs: 500 })], null, NOW).pauseMaxMs)
})

test('TAIL_MS: the median StartOfTurn delay from the sound starting over the spoken clips, to 50 ms, within 200 to 1000', () => {
  const spoken = (fromOnsetMs: number, source: ClipInfo['source'] = 'tts') =>
    clipWith({ source, start: { t: fromOnsetMs + 40, transcript: 'x', fromOnsetMs, firstWordT: null } })
  const s = suggest([spoken(420), spoken(480), spoken(610), spoken(9000, 'synthetic'), spoken(9000, 'mic'), clipWith({ start: null })], null, NOW)
  assert.deepEqual(s.tailMs, { value: 500, from: 480, clips: 3 })
  assert.equal((suggest([spoken(90)], null, NOW).tailMs as { value: number }).value, 200)
  assert.equal((suggest([spoken(1900)], null, NOW).tailMs as { value: number }).value, 1000)
  assert.ok('none' in suggest([], null, NOW).tailMs)
})

const idleOf = (o: Partial<IdleResult>): IdleResult => ({ closedAfterMs: null, code: null, reason: '', stillOpenAfterMs: null, after: [], error: null, refused: null, ...o })

test("STT_HOLD_MS comes from the hold check: whether ForceEndTurn, after that long with no audio, still ended the turn", () => {
  // One second of speech (the last audio at t=1000), STT_HOLD_MS of nothing, then ForceEndTurn at t=4000.
  const hold = (events: ProbeEvent[], over: Partial<StreamRun>) => analyzeHold(run(events, { lastAudioT: 1000, clipMs: 1000, ...over }), 3000)
  const answered = hold(
    [ev(400, 'StartOfTurn', 'Lets'), ev(4120, 'EndOfTurn', 'Lets move', { trigger: 'manual' })],
    { forceT: 4000, closeStreamT: 4130, close: { t: 4150, code: 1005, reason: '', by: 'server' } },
  )
  const fine = suggest([], { hold: answered, idle: idleOf({ closedAfterMs: 10_200 }) }, NOW).sttHold
  assert.equal(fine.ok, true)
  assert.match(fine.text, /^fine: after 3000 ms with no audio, ForceEndTurn still ended the turn, its EndOfTurn 120 ms later; Flux closed the idle check's stream 10\.2 s after its audio stopped$/)
  // A Flux that answers ForceEndTurn only while audio comes: the service's hold path would lose the turn, however long an
  // idle stream stays open.
  const unanswered = hold([ev(400, 'StartOfTurn', 'Lets')], { forceT: 4000, close: { t: 10_000, code: 1011, reason: 'NET-0001', by: 'server' } })
  const lost = suggest([], { hold: unanswered, idle: idleOf({ closedAfterMs: 10_200 }) }, NOW).sttHold
  assert.equal(lost.ok, false)
  assert.match(lost.text, /^the turn would be lost: after 3000 ms with no audio, ForceEndTurn got no EndOfTurn \(Flux closed the stream 6000 ms after it\)/)
  const quiet = hold([ev(400, 'StartOfTurn', 'Lets')], { forceT: 4000, closeStreamT: 9000, close: { t: 9010, code: 1005, reason: '', by: 'server' } })
  assert.match(suggest([], { hold: quiet }, NOW).sttHold.text, /ForceEndTurn got no EndOfTurn \(none came while the probe waited\)/)
  // The idle check alone no longer stands for the hold path.
  const idleOnly = suggest([], { idle: idleOf({ closedAfterMs: 10_200 }) }, NOW).sttHold
  assert.deepEqual(idleOnly, { ok: false, text: 'not checked: the hold check did not run' })
  assert.deepEqual(suggest([], null, NOW).sttHold, idleOnly)
  const closedFirst = hold([ev(400, 'StartOfTurn', 'Lets')], { close: { t: 3500, code: 1011, reason: 'NET-0001', by: 'server' } })
  const tooLong = suggest([], { hold: closedFirst }, NOW).sttHold
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.text, /^too long: Flux closed the stream 2\.5 s after the audio stopped, before 3000 ms with no audio had passed/)
  const itself = hold(
    [ev(400, 'StartOfTurn', 'Lets'), ev(3000, 'EndOfTurn', 'Lets', { trigger: 'timeout' })],
    { closeStreamT: 4000, close: { t: 4020, code: 1005, reason: '', by: 'server' } },
  )
  assert.deepEqual(suggest([], { hold: itself }, NOW).sttHold, {
    ok: true,
    text: 'fine: Flux ended the turn itself 2.0 s after the audio stopped, before 3000 ms with no audio, so ForceEndTurn was not needed',
  })
  const noTurn = hold([ev(400, 'Update', '')], { closeStreamT: 4000, close: { t: 4020, code: 1005, reason: '', by: 'server' } })
  assert.match(suggest([], { hold: noTurn }, NOW).sttHold.text, /^not checked: the hold check's speech started no turn/)
  const refused = analyzeHold({ opened: false, clipMs: 1000, events: [], lastAudioT: null, audioMs: 0, lateMs: 0, refused: { status: 503, text: '' } }, 3000)
  assert.match(suggest([], { hold: refused }, NOW).sttHold.text, /^not checked: the hold check did not run$/)
})

test('the hold check: when the StartOfTurn came, and when the EndOfTurn and the close came after the ForceEndTurn', () => {
  const events = [ev(400, 'StartOfTurn', 'Lets'), { t: 4010, msg: { type: 'Warning', code: 'SOMETHING' } }, ev(4120, 'EndOfTurn', 'Lets move', { trigger: 'manual' })]
  const h = analyzeHold(run(events, { lastAudioT: 1000, forceT: 4000, closeStreamT: 4130, close: { t: 4150, code: 1005, reason: '', by: 'server' } }), 3000)
  assert.equal(h.holdMs, 3000)
  assert.equal(h.startT, 400)
  assert.equal(h.forced, true)
  assert.deepEqual(h.end, { afterMs: 120, trigger: 'manual', transcript: 'Lets move' })
  assert.equal(h.endBeforeClose, true)
  assert.equal(h.close, null, "the close after the probe's CloseStream only ends the check")
  const closed = analyzeHold(run([ev(400, 'StartOfTurn', 'Lets')], { lastAudioT: 1000, forceT: 4000, close: { t: 4900, code: 1011, reason: 'NET-0001', by: 'server' } }), 3000)
  assert.deepEqual(closed.close, { afterMs: 900, code: 1011, reason: 'NET-0001' })
  assert.deepEqual(h.warnings, ['SOMETHING'])
  assert.equal(h.endedItself, null)
  assert.equal(h.closedFirst, null)
})

test('a clip whose stream Flux closed before the probe was done with it is cut short: no mismatch, and left out of the suggestions', () => {
  const opts = { onsetMs: 0, leadMs: 500, minTailMs: 1000 }
  const reset = { t: -40, code: 1006, reason: '', by: 'server' as const }
  // Reset during the lead silence: no StartOfTurn, which says nothing about the clip.
  const lead = analyzeClip(info('int-wait', 'interruption'), run([], { clipMs: 400, lastAudioT: -40, close: reset }), RULES, opts)
  assert.deepEqual(lead.cutShort, { t: -40, code: 1006, reason: '' })
  assert.equal(lead.mismatch, null, 'not "interruption-unheard"')
  // All of the clip went, but before minTailMs of silence after it: a turn its last sound starts could still have come.
  assert.ok(cutShort(run([], { clipMs: 400, close: { ...reset, t: 900 } }), 1000))
  // Closed with a turn still open: its EndOfTurn never came.
  const open = run([ev(300, 'StartOfTurn', 'Mm-hmm.')], { clipMs: 400, close: { ...reset, t: 5000 } })
  assert.deepEqual(cutShort(open, 1000), { t: 5000, code: 1006, reason: '' })
  // Not cut short: closed after the clip and minTailMs with no turn open, or after CloseStream.
  assert.equal(cutShort(run([ev(300, 'StartOfTurn', 'Mm-hmm.'), ev(900, 'EndOfTurn', 'Mm-hmm.')], { clipMs: 400, close: { ...reset, t: 1500 } }), 1000), null)
  assert.equal(cutShort(run([ev(300, 'StartOfTurn', 'Mm')], { clipMs: 400, closeStreamT: 2000, close: { t: 2010, code: 1005, reason: '', by: 'server' } }), 1000), null)
  assert.equal(cutShort(run([], { clipMs: 400, closeStreamT: 2000, close: { t: 2500, code: 1006, reason: '', by: 'probe' } }), 1000), null)
  // A backchannel cut short, and one whose stream never opened, count for nothing in the suggestions.
  const short = clipWith({ startToEndMs: 2900, start: { t: 400, transcript: 'x', fromOnsetMs: 990, firstWordT: null }, cutShort: { t: 3300, code: 1011, reason: '' } })
  const unopened = clipWith({ opened: false, startToEndMs: 2900, start: { t: 400, transcript: 'x', fromOnsetMs: 990, firstWordT: null } })
  const s = suggest([short, unopened], null, NOW)
  assert.ok('none' in s.pauseMaxMs && 'none' in s.tailMs)
})

test('spellings: a backchannel that would stop is suggested for the list its spelling belongs in, once each', () => {
  const stopped = (id: string, text: string) =>
    clipWith({ id, verdict: { kind: 'pause-stop', actions: [] }, mismatch: { kind: 'backchannel-stops', text, counted: countingWords(text, RULES) } })
  const s = suggest([stopped('bc-mhm', 'Mhmh.'), stopped('mic-mm-hm', 'Mhmh'), stopped('bc-got-it', 'Okay, I got it.'), stopped('bc-sure', 'Shure.')], null, NOW)
  assert.deepEqual(s.spellings, [
    { list: 'BACKCHANNEL_SOUND', add: 'mhmh', flux: 'Mhmh.', clip: 'bc-mhm' },
    { list: 'BACKCHANNEL_PHRASES', add: 'okay i got it', flux: 'Okay, I got it.', clip: 'bc-got-it' },
    { list: 'BACKCHANNEL_WORDS', add: 'shure', flux: 'Shure.', clip: 'bc-sure' },
  ])
})

test('a line too long to be a way of spelling a backchannel is a mismatch, but no spelling to learn', () => {
  const text = "Let's move the launch to next Thursday"
  const c = clipWith({ verdict: { kind: 'pause-stop', actions: [] }, mismatch: { kind: 'backchannel-stops', text, counted: countingWords(text, RULES) } })
  assert.deepEqual(suggest([c], null, NOW).spellings, [])
  const four = 'Yeah, I mean, sure'
  const d = clipWith({ verdict: { kind: 'pause-stop', actions: [] }, mismatch: { kind: 'backchannel-stops', text: four, counted: countingWords(four, RULES) } })
  assert.deepEqual(suggest([d], null, NOW).spellings.map(sp => [sp.list, sp.add]), [['BACKCHANNEL_PHRASES', 'yeah i mean sure']])
})

test("Flux's Error and Warning messages are kept for the clip, with their code and text", () => {
  const events = [ev(100, 'Update'), { t: 150, msg: { type: 'Warning', code: 'SOMETHING_ODD' } }, { t: 200, msg: { type: 'Error', code: 'INTERNAL_SERVER_ERROR', description: 'oops' } }]
  const a = analyzeClip(info('noise-white', 'noise', 'synthetic'), run(events), RULES, { onsetMs: 0, leadMs: 500 })
  assert.deepEqual(a.notices, ['Warning SOMETHING_ODD', 'Error INTERNAL_SERVER_ERROR: oops'])
})

test('cadence: Updates and the gaps between TurnInfo messages during the speech, and the Updates before it', () => {
  const events = [ev(-400, 'Update', ''), ev(-150, 'Update', ''), ev(100, 'Update', ''), ev(350, 'StartOfTurn', 'Lets'), ev(600, 'Update', 'Lets move'), ev(840, 'Update', 'Lets move the'), ev(1100, 'Update', 'Lets move the launch'), ev(1700, 'EndOfTurn', 'x')]
  const c = cadence('int-long', run(events, { clipMs: 1200 }), 200)
  assert.equal(c.updates, 3)
  assert.equal(c.gaps, 3)
  assert.equal(c.medianGapMs, 250)
  assert.equal(c.p90GapMs, 260)
  assert.equal(c.leadingUpdates, 2)
  assert.deepEqual(c.leadingTranscripts, [''])
})

test('force-close: when the EndOfTurn came after ForceEndTurn, and whether before the close', () => {
  const events = [ev(400, 'StartOfTurn', 'Lets move'), ev(2050, 'EndOfTurn', 'Lets move the launch', { trigger: 'manual' })]
  const f = analyzeForce('force-close', run(events, { forceT: 1900, closeStreamT: 1900, close: { t: 2100, code: 1005, reason: '', by: 'server' } }))
  assert.equal(f.startT, 400)
  assert.deepEqual(f.end, { afterMs: 150, trigger: 'manual', transcript: 'Lets move the launch' })
  assert.equal(f.endBeforeClose, true)
  assert.deepEqual(f.close, { afterMs: 200, code: 1005, reason: '', by: 'server' })
  const lost = analyzeForce('force-close', run([ev(400, 'StartOfTurn', 'Lets')], { forceT: 1900, close: { t: 1950, code: 1005, reason: '', by: 'server' } }))
  assert.equal(lost.end, null)
  assert.equal(lost.endBeforeClose, null)
  const none = analyzeForce('force-only', run([{ t: 3010, msg: { type: 'Warning', code: 'FORCE_END_TURN_NO_ACTIVE_TURN' } }], { forceT: 3000, forceNoTurn: true }))
  assert.equal(none.noTurn, true)
  assert.deepEqual(none.warnings, ['FORCE_END_TURN_NO_ACTIVE_TURN'])
  assert.equal(none.startT, null)
})

test('idle: when and how Flux closed a stream with no audio, or that it was still open, and the turn events after the audio', () => {
  const closed = analyzeIdle(run([ev(700, 'StartOfTurn', 'Lets'), ev(6000, 'EndOfTurn', 'Lets', { trigger: 'timeout' })], { lastAudioT: 1000, close: { t: 11_000, code: 1011, reason: 'NET-0001', by: 'server' } }))
  assert.equal(closed.closedAfterMs, 10_000)
  assert.equal(closed.code, 1011)
  assert.equal(closed.reason, 'NET-0001')
  assert.deepEqual(closed.after, [{ afterMs: 5000, event: 'EndOfTurn', trigger: 'timeout' }])
  const open = analyzeIdle(run([], { lastAudioT: 1000, stillOpenAfterMs: 90_000, close: { t: 91_100, code: 1005, reason: '', by: 'server' } }))
  assert.equal(open.closedAfterMs, null, 'a close after the probe gave up waiting is its own CloseStream')
  assert.equal(open.stillOpenAfterMs, 90_000)
})
