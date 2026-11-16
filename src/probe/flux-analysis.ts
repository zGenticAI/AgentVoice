// What npm run flux-probe makes of what Flux sent: per clip, what the session would have done with it while the
// assistant was talking (its real rules: wordsThatCount, the stop thresholds, PAUSE_MAX_MS), where that is not what the
// clip was meant to get, and suggestions for the constants and word lists. Pure: the tests feed it recorded events.
import type { ProbeEvent, StreamRun } from './flux-stream.ts'

/** What a clip is meant to be, said over the assistant: no reason to stop, a reason to stop, or not speech at all. */
export type Intent = 'backchannel' | 'interruption' | 'noise' | 'unknown'
/** Where its audio came from. */
export type Source = 'tts' | 'synthetic' | 'nonverbal' | 'mic' | 'file'

export interface ClipInfo {
  id: string
  intent: Intent
  source: Source
  /** What it is: the text spoken, the noise made, the prompt, the file's name. */
  label: string
}

/** The session's rules for talking over the assistant (src/pipeline/session.ts and src/brain/attention.ts). */
export interface SessionRules {
  pauseMaxMs: number
  stopWordsPartial: number
  stopWordsFinal: number
  wordsThatCount: (text: string, partial?: boolean) => number
}

/** One thing the session would do: pause the page, let it play on, or stop the assistant. */
export interface Action {
  t: number
  what: 'pause' | 'resume' | 'stop'
  /** What made it: a StartOfTurn, an Update, an EndOfTurn, or PAUSE_MAX_MS running out. */
  by: 'start' | 'update' | 'end' | 'wait'
  /** The transcript that made it, for a stop. */
  text?: string
}

/**
 * What the assistant would have done. nothing: no StartOfTurn. stop: stopped at the first StartOfTurn. pause-stop:
 * paused, then stopped. pause-resume: paused, then played on, and never stopped.
 */
export interface Verdict {
  kind: 'nothing' | 'stop' | 'pause-stop' | 'pause-resume'
  actions: Action[]
}

/** A Flux TurnInfo message, as far as the analysis reads it. */
interface Turn {
  t: number
  event: string
  transcript: string
  trigger?: string
  confidence?: number
  words: { start?: number }[]
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function turns(events: ProbeEvent[]): Turn[] {
  return events
    .filter(e => e.msg.type === 'TurnInfo' && typeof e.msg.event === 'string')
    .map(({ t, msg }) => ({
      t,
      event: msg.event as string,
      transcript: typeof msg.transcript === 'string' ? msg.transcript.trim() : '',
      trigger: typeof msg.trigger === 'string' ? msg.trigger : undefined,
      confidence: num(msg.end_of_turn_confidence),
      words: Array.isArray(msg.words) ? msg.words.map(w => ({ start: num((w as { start?: unknown })?.start) })) : [],
    }))
    .sort((a, b) => a.t - b.t)
}

/**
 * Plays the session's rules over a clip's events, as if the assistant were partway through a long answer the whole
 * time (session.ts turnStarted, turnGoesOn, turnEnded and the pause timer): a StartOfTurn with STOP_WORDS_PARTIAL
 * words that count stops it at once, with fewer it pauses; an Update with that many stops it; an EndOfTurn with
 * STOP_WORDS_FINAL stops it, with fewer it plays on; and a pause with no verdict plays on after PAUSE_MAX_MS, though
 * the turn is still watched. Once stopped, the assistant is quiet, so nothing more happens.
 */
export function simulate(events: ProbeEvent[], rules: SessionRules): Verdict {
  const actions: Action[] = []
  let watching = false
  let resumeAt: number | null = null
  let stopped = false
  const resume = (t: number, by: Action['by']) => {
    resumeAt = null
    actions.push({ t, what: 'resume', by })
  }
  const stop = (t: number, by: Action['by'], text: string) => {
    stopped = true
    watching = false
    resumeAt = null
    actions.push({ t, what: 'stop', by, text })
  }
  for (const turn of turns(events)) {
    if (stopped) break
    if (resumeAt !== null && resumeAt <= turn.t) resume(resumeAt, 'wait')
    const { t, transcript: text } = turn
    if (turn.event === 'StartOfTurn') {
      watching = true
      if (rules.wordsThatCount(text, true) >= rules.stopWordsPartial) stop(t, 'start', text)
      else if (resumeAt === null) {
        actions.push({ t, what: 'pause', by: 'start' })
        resumeAt = t + rules.pauseMaxMs
      }
    } else if (turn.event === 'EndOfTurn') {
      if (!watching) continue
      if (rules.wordsThatCount(text) >= rules.stopWordsFinal) stop(t, 'end', text)
      else {
        watching = false
        if (resumeAt !== null) resume(t, 'end')
      }
    } else if (watching && rules.wordsThatCount(text, true) >= rules.stopWordsPartial) {
      stop(t, 'update', text)
    }
  }
  // The pause timer still runs out after the last message.
  if (!stopped && resumeAt !== null) resume(resumeAt, 'wait')
  const first = actions[0]
  const kind = !first ? 'nothing' : first.what === 'stop' ? 'stop' : stopped ? 'pause-stop' : 'pause-resume'
  return { kind, actions }
}

/** A transcript's words, lower case, without punctuation, split at spaces and hyphens ("mm-hmm" is "mm" and "hmm"). */
function wordsIn(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-\u2010-\u2014]+/)
    .map(w => w.replace(/[^\p{L}\p{N}'\u2019]/gu, ''))
    .filter(Boolean)
}

/**
 * The words of a transcript that count (wordsThatCount), lower case, without punctuation: those that count on their
 * own, leaving out a run of two or three that counts nothing as a whole ("got it", "that makes sense").
 */
export function countingWords(text: string, rules: Pick<SessionRules, 'wordsThatCount'>): string[] {
  const words = wordsIn(text)
  const counted: string[] = []
  for (let i = 0; i < words.length; ) {
    const run = [3, 2].find(n => i + n <= words.length && rules.wordsThatCount(words.slice(i, i + n).join(' ')) === 0)
    if (run) {
      i += run
      continue
    }
    if (rules.wordsThatCount(words[i]) >= 1) counted.push(words[i])
    i++
  }
  return counted
}

/** Where a clip's verdict is not what it was meant to get. */
export interface Mismatch {
  kind: 'backchannel-stops' | 'interruption-resumes' | 'interruption-unheard' | 'noise-starts'
  /** The transcript that stopped the assistant (backchannel-stops), or that started the turn (noise-starts). */
  text?: string
  /** For backchannel-stops: the words of it that counted. */
  counted?: string[]
}

export interface ClipAnalysis extends ClipInfo {
  clipMs: number
  /** Where sound starts in the clip (ms), or null. */
  onsetMs: number | null
  /** StartOfTurn messages. */
  turns: number
  start: {
    t: number
    transcript: string
    /** From the sound's onset in the clip, when it has one. */
    fromOnsetMs: number | null
    /** Where Flux put the turn's first word (t), when it gave word times. */
    firstWordT: number | null
  } | null
  /** The transcripts Updates carried during a turn, each change once, in order. */
  updates: string[]
  updateCount: number
  /** Flux's Error and Warning messages, as "Error CODE: description". */
  notices: string[]
  end: { t: number; afterClipMs: number; transcript: string; trigger: string; confidence: number | null } | null
  /** From the first StartOfTurn to the EndOfTurn after it. */
  startToEndMs: number | null
  verdict: Verdict
  mismatch: Mismatch | null
  close: StreamRun['close'] | null
  closeStreamT: number | null
  refused: StreamRun['refused'] | null
  error: string | null
}

/** One clip's run, analysed. `leadMs` is the silence the run sent before the clip (word times count from there). */
export function analyzeClip(info: ClipInfo, run: StreamRun, rules: SessionRules, opts: { onsetMs: number | null; leadMs: number }): ClipAnalysis {
  const all = turns(run.events)
  const starts = all.filter(e => e.event === 'StartOfTurn')
  const first = starts[0]
  const end = first ? all.find(e => e.event === 'EndOfTurn' && e.t >= first.t) : undefined
  const updates: string[] = []
  let open = false
  let updateCount = 0
  for (const e of all) {
    if (e.event === 'StartOfTurn') open = true
    else if (e.event === 'EndOfTurn') open = false
    else if (e.event === 'Update') {
      updateCount++
      if (open && e.transcript && updates.at(-1) !== e.transcript) updates.push(e.transcript)
    }
  }
  const verdict = simulate(run.events, rules)
  const firstWord = first?.words[0]?.start
  return {
    ...info,
    clipMs: run.clipMs,
    onsetMs: opts.onsetMs,
    turns: starts.length,
    start: first
      ? {
          t: first.t,
          transcript: first.transcript,
          fromOnsetMs: opts.onsetMs === null ? null : first.t - opts.onsetMs,
          firstWordT: firstWord === undefined ? null : Math.round(firstWord * 1000 - opts.leadMs),
        }
      : null,
    updates,
    updateCount,
    notices: run.events
      .filter(e => e.msg.type === 'Error' || e.msg.type === 'Warning')
      .map(e => `${e.msg.type} ${String(e.msg.code ?? 'no code')}${typeof e.msg.description === 'string' ? `: ${e.msg.description}` : ''}`),
    end: end
      ? { t: end.t, afterClipMs: end.t - run.clipMs, transcript: end.transcript, trigger: end.trigger ?? '', confidence: end.confidence ?? null }
      : null,
    startToEndMs: first && end ? end.t - first.t : null,
    verdict,
    mismatch: mismatchOf(info.intent, verdict, first?.transcript ?? '', rules),
    close: run.close ?? null,
    closeStreamT: run.closeStreamT ?? null,
    refused: run.refused ?? null,
    error: run.error ?? null,
  }
}

function mismatchOf(intent: Intent, verdict: Verdict, startText: string, rules: SessionRules): Mismatch | null {
  const stop = verdict.actions.find(a => a.what === 'stop')
  if (intent === 'backchannel' && stop) {
    const text = stop.text ?? ''
    return { kind: 'backchannel-stops', text, counted: countingWords(text, rules) }
  }
  if (intent === 'interruption' && verdict.kind === 'pause-resume') return { kind: 'interruption-resumes' }
  if (intent === 'interruption' && verdict.kind === 'nothing') return { kind: 'interruption-unheard' }
  if (intent === 'noise' && verdict.kind !== 'nothing') return { kind: 'noise-starts', text: startText }
  return null
}

/** The value at or below which p% of the values lie (nearest rank). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]
}

/** The middle value; the mean of the two middle ones for an even count. */
export function median(values: number[]): number {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** How often Flux answers during speech, and what it sends before any. */
export interface Cadence {
  clip: string
  /** Update messages between the speech's onset and the clip's end. */
  updates: number
  /** Gaps between consecutive TurnInfo messages in that span (ms). */
  gaps: number
  medianGapMs: number | null
  p90GapMs: number | null
  /** Updates during the lead silence, and the transcripts they carried. */
  leadingUpdates: number
  leadingTranscripts: string[]
}

export function cadence(clip: string, run: StreamRun, onsetMs: number | null): Cadence {
  const all = turns(run.events)
  const during = all.filter(e => e.t >= (onsetMs ?? 0) && e.t <= run.clipMs)
  const gaps = during.slice(1).map((e, i) => e.t - during[i].t)
  const leading = all.filter(e => e.t < 0 && e.event === 'Update')
  return {
    clip,
    updates: during.filter(e => e.event === 'Update').length,
    gaps: gaps.length,
    medianGapMs: gaps.length ? median(gaps) : null,
    p90GapMs: gaps.length ? percentile(gaps, 90) : null,
    leadingUpdates: leading.length,
    leadingTranscripts: [...new Set(leading.map(e => e.transcript))],
  }
}

/** What Flux did with ForceEndTurn (and CloseStream, for force-close). Times are ms after the ForceEndTurn. */
export interface ForceResult {
  check: 'force-close' | 'force-only'
  /** t of the first StartOfTurn, or null when none came before the commands. */
  startT: number | null
  forced: boolean
  noTurn: boolean
  end: { afterMs: number; trigger: string; transcript: string } | null
  /** Whether that EndOfTurn came before the stream closed. */
  endBeforeClose: boolean | null
  close: { afterMs: number; code: number; reason: string; by: 'server' | 'probe' } | null
  /** Warning codes Flux sent after the ForceEndTurn (FORCE_END_TURN_NO_ACTIVE_TURN, say). */
  warnings: string[]
  error: string | null
  refused: StreamRun['refused'] | null
}

export function analyzeForce(check: ForceResult['check'], run: StreamRun): ForceResult {
  const all = turns(run.events)
  const forceT = run.forceT
  const after = run.events.filter(e => forceT !== undefined && e.t >= forceT)
  const end = forceT === undefined ? undefined : all.find(e => e.event === 'EndOfTurn' && e.t >= forceT)
  const closeT = run.close?.t
  return {
    check,
    startT: all.find(e => e.event === 'StartOfTurn')?.t ?? null,
    forced: forceT !== undefined,
    noTurn: run.forceNoTurn === true,
    end: end && forceT !== undefined ? { afterMs: end.t - forceT, trigger: end.trigger ?? '', transcript: end.transcript } : null,
    endBeforeClose: end ? closeT === undefined || end.t <= closeT : null,
    close:
      run.close && forceT !== undefined
        ? { afterMs: run.close.t - forceT, code: run.close.code, reason: run.close.reason, by: run.close.by }
        : null,
    warnings: after.filter(e => e.msg.type === 'Warning').map(e => String(e.msg.code ?? e.msg.description ?? 'a warning')),
    error: run.error ?? null,
    refused: run.refused ?? null,
  }
}

/** How Flux treated a stream that stopped getting audio. Times are ms after the last audio. */
export interface IdleResult {
  closedAfterMs: number | null
  code: number | null
  reason: string
  stillOpenAfterMs: number | null
  /** The TurnInfo events that came after the last audio, with their trigger (an EndOfTurn on timeout, say). */
  after: { afterMs: number; event: string; trigger: string }[]
  error: string | null
  refused: StreamRun['refused'] | null
}

export function analyzeIdle(run: StreamRun): IdleResult {
  const last = run.lastAudioT ?? 0
  const byServer = run.close?.by === 'server' && run.stillOpenAfterMs === undefined
  return {
    closedAfterMs: byServer && run.close ? run.close.t - last : null,
    code: byServer && run.close ? run.close.code : null,
    reason: byServer && run.close ? run.close.reason : '',
    stillOpenAfterMs: run.stillOpenAfterMs ?? null,
    after: turns(run.events)
      .filter(e => e.t > last)
      .map(e => ({ afterMs: e.t - last, event: e.event, trigger: e.trigger ?? '' })),
    error: run.error ?? null,
    refused: run.refused ?? null,
  }
}

/** The constants the suggestions are about, as the service has them now. */
export interface Constants {
  pauseMaxMs: number
  tailMs: number
  sttHoldMs: number
  /** How long the service waits for Flux to close after CloseStream (deepgram.ts FLUX_CLOSE_WAIT_MS). */
  closeWaitMs: number
}

export type Suggested = { value: number; from: number; clips: number } | { none: string }

export interface Spelling {
  list: 'BACKCHANNEL_SOUND' | 'BACKCHANNEL_WORDS' | 'BACKCHANNEL_PHRASES'
  /** What to add, lower case. */
  add: string
  /** How Flux wrote the line, and for which clip. */
  flux: string
  clip: string
}

export interface Suggestions {
  pauseMaxMs: Suggested
  tailMs: Suggested
  sttHold: { ok: boolean; text: string; value?: number }
  spellings: Spelling[]
}

const roundTo50 = (ms: number) => Math.round(ms / 50) * 50
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// PAUSE_MAX_MS: room over the slowest usual backchannel, so its own EndOfTurn resumes the page.
export const PAUSE_MARGIN_MS = 300
export const PAUSE_BOUNDS: readonly [number, number] = [800, 3000]
export const TAIL_BOUNDS: readonly [number, number] = [200, 1000]
// STT_HOLD_MS needs this much room before an idle stream closes: the ForceEndTurn's answer has to come back first.
export const HOLD_MARGIN_MS = 1000

// A line longer than this is Flux hearing something else, not a way to spell a backchannel.
const MAX_PHRASE_WORDS = 4

/** A sound such as "mhm" or "uhhuh", which BACKCHANNEL_SOUND's pattern would take, rather than a word. */
const SOUNDLIKE = (w: string) => /^[mhnuao]+$/.test(w) && /[mh]/.test(w)

/**
 * The suggestions: never applied, only printed.
 * - PAUSE_MAX_MS: the p90 of StartOfTurn to EndOfTurn over the backchannel clips the page resumed for, plus 300 ms,
 *   within [800, 3000], to 50 ms.
 * - TAIL_MS: the median StartOfTurn delay from the speech's onset over the spoken (ElevenLabs) clips, within
 *   [200, 1000], to 50 ms.
 * - STT_HOLD_MS: whether a turn held that long can still be ended before Flux closes a stream with no audio.
 * - The spellings Flux used for backchannels that would stop the assistant, and which list each would go in.
 */
export function suggest(clips: ClipAnalysis[], idle: IdleResult | null, now: Constants): Suggestions {
  const resumed = clips.filter(c => c.intent === 'backchannel' && c.verdict.kind === 'pause-resume' && c.startToEndMs !== null)
  const gaps = resumed.map(c => c.startToEndMs as number)
  const pauseMaxMs: Suggested = gaps.length
    ? { value: clamp(roundTo50(percentile(gaps, 90) + PAUSE_MARGIN_MS), ...PAUSE_BOUNDS), from: percentile(gaps, 90), clips: gaps.length }
    : { none: 'no backchannel clip paused and then played on with an EndOfTurn' }

  const spoken = clips.filter(c => c.source === 'tts' && c.start?.fromOnsetMs != null)
  const delays = spoken.map(c => c.start?.fromOnsetMs as number)
  const tailMs: Suggested = delays.length
    ? { value: clamp(roundTo50(median(delays)), ...TAIL_BOUNDS), from: median(delays), clips: delays.length }
    : { none: 'no spoken clip got a StartOfTurn' }

  let sttHold: Suggestions['sttHold']
  if (!idle || idle.refused || (idle.closedAfterMs === null && idle.stillOpenAfterMs === null)) {
    sttHold = { ok: false, text: 'not checked: the idle check did not run to the end' }
  } else if (idle.closedAfterMs === null) {
    const open = idle.stillOpenAfterMs as number
    sttHold =
      open >= now.sttHoldMs + HOLD_MARGIN_MS
        ? { ok: true, text: `fine: Flux kept a stream with no audio open for ${secs(open)}` }
        : {
            ok: false,
            text: `not checked: the stream was still open when the wait ran out after ${secs(open)}, too soon to tell (run with --idle-max ${Math.ceil((now.sttHoldMs + HOLD_MARGIN_MS) / 1000)} or more)`,
          }
  } else if (now.sttHoldMs + HOLD_MARGIN_MS <= idle.closedAfterMs) {
    sttHold = {
      ok: true,
      text: `fine: Flux closed a stream with no audio after ${secs(idle.closedAfterMs)}, and ${now.sttHoldMs} + ${HOLD_MARGIN_MS} ms to end the turn fits`,
    }
  } else {
    const value = Math.max(0, Math.floor((idle.closedAfterMs - HOLD_MARGIN_MS) / 50) * 50)
    sttHold = {
      ok: false,
      value,
      text: `too long: Flux closed a stream with no audio after ${secs(idle.closedAfterMs)}, before ${now.sttHoldMs} + ${HOLD_MARGIN_MS} ms; STT_HOLD_MS ≈ ${value}`,
    }
  }

  const spellings: Spelling[] = []
  const seen = new Set<string>()
  for (const c of clips) {
    if (c.mismatch?.kind !== 'backchannel-stops') continue
    const counted = c.mismatch.counted ?? []
    const words = wordsIn(c.mismatch.text ?? '')
    let found: Pick<Spelling, 'list' | 'add'>[] = []
    if (counted.length && counted.every(SOUNDLIKE)) found = counted.map(add => ({ list: 'BACKCHANNEL_SOUND', add }))
    else if (words.length > MAX_PHRASE_WORDS) found = []
    else if (words.length > 1) found = [{ list: 'BACKCHANNEL_PHRASES', add: words.join(' ') }]
    else found = counted.map(add => ({ list: 'BACKCHANNEL_WORDS', add }))
    for (const f of found) {
      const key = `${f.list} ${f.add}`
      if (seen.has(key)) continue
      seen.add(key)
      spellings.push({ ...f, flux: c.mismatch.text ?? '', clip: c.id })
    }
  }
  return { pauseMaxMs, tailMs, sttHold, spellings }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
