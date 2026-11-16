// The plain-text report npm run flux-probe prints, made to be pasted back to a Claude Code session: the settings that
// matter first, then each clip, the mismatches, the protocol checks and the suggestions. It holds no key and no
// address: only the probe's own test phrases and what Flux made of the audio.
import type { Cadence, ClipAnalysis, Constants, ForceResult, IdleResult, Suggested, Suggestions, Verdict } from './flux-analysis.ts'

export const REPORT_END = 'Paste this whole report back to your Claude Code session.'

export interface ReportInput {
  /** The assistant's name, for "<name> would ...". */
  name: string
  app: string
  node: string
  date: string
  flux: { model: string; eotThreshold: string; keyterms: number; mipOptOut: string }
  constants: Constants & { stopWordsPartial: number; stopWordsFinal: number }
  voice: string
  /** What the run used, and the most any chunk went out after its time (ms). */
  usage: { deepgramMs: number; streams: number; elevenLabsChars: number; lateMs: number }
  leadMs: number
  tailMaxMs: number
  /** How long after the StartOfTurn the force checks send ForceEndTurn. */
  forceAfterMs: number
  clips: ClipAnalysis[]
  force: ForceResult[]
  /** Null when the idle check did not run. */
  idle: IdleResult | null
  cadence: Cadence | null
  suggestions: Suggestions
  skipped: { id: string; why: string }[]
  /** Anything else the reader should know: checks that ran without speech, a folder with no WAV. */
  notes: string[]
  /** Why the run stopped before the end (a refused key, say). */
  stopped?: string
}

const q = (text: string) => JSON.stringify(text)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const ms = (n: number) => `${Math.round(n)} ms`
const s1 = (n: number) => `${(n / 1000).toFixed(1)} s`

/** What the assistant would do, in words. */
export function describeVerdict(name: string, v: Verdict): string {
  if (v.kind === 'nothing') return `${name} would do nothing (no StartOfTurn)`
  const by: Record<string, string> = { start: 'its StartOfTurn', update: 'an Update', end: 'its EndOfTurn', wait: 'PAUSE_MAX_MS running out' }
  const steps = v.actions.map(a => {
    if (a.what === 'pause') return `pause at ${a.t}`
    if (a.what === 'resume') return `play on at ${a.t} (${by[a.by]})`
    return `stop at ${a.t} (${by[a.by]}${a.text ? ` ${q(a.text)}` : ''})`
  })
  const kind = { stop: 'stop at once', 'pause-stop': 'pause, then stop', 'pause-resume': 'pause, then play on' }[v.kind]
  return `${name} would ${kind}: ${steps.join(', ')}`
}

function closeLine(c: ClipAnalysis): string {
  const { close, closeStreamT } = c
  if (!close) return 'Closed: no close seen'
  const how = `${close.code}${close.reason ? ` ${q(close.reason)}` : ''}`
  if (close.by === 'probe') return `Closed: Flux had not closed the stream, so the probe cut it (${how})`
  if (closeStreamT !== null && close.t >= closeStreamT) return `Closed: ${how}, ${ms(close.t - closeStreamT)} after CloseStream`
  return `Closed: Flux closed the stream itself at t=${close.t} (${how})`
}

function clipLines(name: string, c: ClipAnalysis): string[] {
  const sound = c.onsetMs === null ? 'no sound in it' : `sound from ${ms(c.onsetMs)}`
  const lines = [`${c.id} [${c.intent}, ${c.source}] ${c.source === 'tts' || c.source === 'nonverbal' ? q(c.label) : c.label}: ${s1(c.clipMs)}, ${sound}`]
  if (c.refused) return [...lines, `  Deepgram refused the stream (${c.refused.status})${c.refused.text ? `: ${c.refused.text}` : ''}`]
  if (c.error && !c.close) return [...lines, `  Failed: ${c.error}`]
  if (!c.start) lines.push(`  No StartOfTurn (${plural(c.updateCount, 'Update')})`)
  else {
    const from = c.start.fromOnsetMs === null ? '' : `, ${ms(c.start.fromOnsetMs)} after the sound starts`
    const word = c.start.firstWordT === null ? '' : `; Flux put its first word at t=${c.start.firstWordT}`
    lines.push(`  StartOfTurn t=${c.start.t}${from}${word}: ${q(c.start.transcript)}${c.turns > 1 ? ` (${c.turns} turns)` : ''}`)
    lines.push(`  Updates in the turn (${c.updateCount} in all): ${c.updates.length ? c.updates.map(q).join(', ') : 'none with words'}`)
    if (c.end) {
      const conf = c.end.confidence === null ? '' : `, confidence ${c.end.confidence}`
      lines.push(
        `  EndOfTurn t=${c.end.t}, ${ms(c.end.afterClipMs)} after the clip ended, trigger ${c.end.trigger || '(none)'}${conf}: ${q(c.end.transcript)}; StartOfTurn to EndOfTurn ${ms(c.startToEndMs ?? 0)}`,
      )
    } else lines.push('  No EndOfTurn')
  }
  lines.push(`  ${describeVerdict(name, c.verdict)}`)
  for (const notice of c.notices) lines.push(`  Flux sent ${notice}`)
  if (c.error) lines.push(`  Error: ${c.error}`)
  lines.push(`  ${closeLine(c)}`)
  return lines
}

function mismatchLine(name: string, c: ClipAnalysis): string {
  const m = c.mismatch
  const what = `${c.id} (${c.intent} ${c.source === 'tts' ? q(c.label) : c.label})`
  if (!m) return ''
  if (m.kind === 'backchannel-stops') {
    const counted = m.counted?.length ? `; the words that counted: ${m.counted.map(q).join(', ')}` : ''
    return `${what}: ${name} would stop, on Flux's ${q(m.text ?? '')}${counted}`
  }
  if (m.kind === 'interruption-resumes') return `${what}: ${name} would only pause, then play on`
  if (m.kind === 'interruption-unheard') return `${what}: no StartOfTurn, so ${name} would not stop`
  return `${what}: Flux started a turn, ${q(m.text ?? '')}; ${describeVerdict(name, c.verdict)}`
}

function forceLine(f: ForceResult, closeWaitMs: number, afterMs: number): string {
  const head = `${f.check}:`
  if (f.refused) return `${head} Deepgram refused the stream (${f.refused.status})`
  if (!f.forced) return `${head} not done${f.error ? ` (${f.error})` : ''}`
  const what = f.check === 'force-close' ? 'ForceEndTurn and CloseStream' : 'ForceEndTurn'
  const when = f.noTurn ? `no StartOfTurn came during the sentence, so ${what} went as it ended` : `StartOfTurn at t=${f.startT}; ${what} went ${ms(afterMs)} after it`
  const end = f.end
    ? `EndOfTurn (trigger ${f.end.trigger || '(none)'}) ${ms(f.end.afterMs)} after ForceEndTurn: ${q(f.end.transcript)}`
    : 'no EndOfTurn after ForceEndTurn'
  const parts = [head, `${when}.`, `${end}.`]
  if (f.check === 'force-close') {
    if (f.close?.by === 'server') parts.push(`Flux closed the stream ${ms(f.close.afterMs)} after ForceEndTurn (${f.close.code}${f.close.reason ? ` ${q(f.close.reason)}` : ''}).`)
    else parts.push('Flux had not closed the stream by the end of the wait.')
    if (f.end) {
      parts.push(f.endBeforeClose ? 'The EndOfTurn came before the close.' : 'The EndOfTurn came after the close.')
      parts.push(
        f.end.afterMs <= closeWaitMs
          ? `Within FLUX_CLOSE_WAIT_MS (${closeWaitMs}): the service's close() keeps those words.`
          : `Later than FLUX_CLOSE_WAIT_MS (${closeWaitMs}): the service's close() would cut those words.`,
      )
    }
  }
  if (f.warnings.length) parts.push(`Warnings: ${f.warnings.join(', ')}.`)
  return parts.join(' ')
}

function idleLine(idle: IdleResult | null): string {
  if (!idle) return 'idle: not run'
  if (idle.refused) return `idle: Deepgram refused the stream (${idle.refused.status})`
  const after = idle.after.length
    ? ` TurnInfo after the last audio: ${idle.after.map(a => `${a.event}${a.trigger ? ` (${a.trigger})` : ''} at ${s1(a.afterMs)}`).join(', ')}.`
    : ' No TurnInfo after the last audio.'
  if (idle.closedAfterMs !== null) {
    return `idle: Flux closed the stream ${s1(idle.closedAfterMs)} after the last audio (${idle.code}${idle.reason ? ` ${q(idle.reason)}` : ''}).${after}`
  }
  if (idle.stillOpenAfterMs !== null) return `idle: still open after ${s1(idle.stillOpenAfterMs)} with no audio.${after}`
  return `idle: no result${idle.error ? ` (${idle.error})` : ''}`
}

function cadenceLine(c: Cadence | null): string {
  if (!c) return 'cadence: not run (it comes from int-long, the long sentence)'
  const gaps = c.medianGapMs === null ? 'too few messages for a gap' : `a TurnInfo every ${ms(c.medianGapMs)} (median), p90 ${ms(c.p90GapMs ?? 0)}, over ${c.gaps} gaps`
  const lead = c.leadingUpdates
    ? `${plural(c.leadingUpdates, 'Update')} during the lead silence, transcripts: ${c.leadingTranscripts.map(q).join(', ')}`
    : 'no Update during the lead silence'
  return `cadence (${c.clip}): ${plural(c.updates, 'Update')} during the speech; ${gaps}. ${lead}.`
}

function suggestedLine(label: string, now: number, s: Suggested, how: (from: string, clips: number) => string): string {
  if ('none' in s) return `${label} (now ${now}): no suggestion, ${s.none}`
  return `${label} ≈ ${s.value} (now ${now}): ${how(ms(s.from), s.clips)}`
}

export function formatReport(r: ReportInput): string {
  const c = r.constants
  const out: string[] = [
    '===== Flux probe report =====',
    `${r.app}, Node ${r.node}, ${r.date}`,
    `Flux: model ${r.flux.model}, eot_threshold ${r.flux.eotThreshold}, ${r.flux.keyterms} keyterm${r.flux.keyterms === 1 ? '' : 's'}, mip_opt_out ${r.flux.mipOptOut}, linear16 at 16 kHz in 80 ms chunks, real time`,
    `Session: PAUSE_MAX_MS ${c.pauseMaxMs}, TAIL_MS ${c.tailMs}, STT_HOLD_MS ${c.sttHoldMs}, STOP_WORDS_PARTIAL ${c.stopWordsPartial}, STOP_WORDS_FINAL ${c.stopWordsFinal}, FLUX_CLOSE_WAIT_MS ${c.closeWaitMs}`,
    `Voice: ${r.voice}`,
    `Used: about ${(r.usage.deepgramMs / 60000).toFixed(1)} min of Deepgram audio over ${plural(r.usage.streams, 'stream')}, ${r.usage.elevenLabsChars} ElevenLabs characters; the audio went at most ${ms(r.usage.lateMs)} behind real time, never ahead`,
    `Each clip: ${ms(r.leadMs)} of silence, the clip, then silence until its turn ended (or ${s1(r.tailMaxMs)}), then CloseStream. t is ms from where the clip's audio starts; each 80 ms chunk goes once its 80 ms have passed.`,
    `"${r.name} would" plays the session's rules as if ${r.name} were partway through a long answer.`,
  ]
  if (r.stopped) out.push(`Stopped early: ${r.stopped}`)
  for (const note of r.notes) out.push(`Note: ${note}`)
  out.push('', '-- Clips --')
  for (const clip of r.clips) out.push(...clipLines(r.name, clip))
  if (!r.clips.length) out.push('(none run)')

  out.push('', '-- Mismatches --')
  const mismatches = r.clips.filter(clip => clip.mismatch).map(clip => mismatchLine(r.name, clip))
  out.push(...(mismatches.length ? mismatches.map(m => `- ${m}`) : ['(none)']))

  out.push('', '-- Protocol --')
  for (const f of r.force) out.push(forceLine(f, c.closeWaitMs, r.forceAfterMs))
  out.push(idleLine(r.idle), cadenceLine(r.cadence))

  const s = r.suggestions
  out.push('', '-- Suggestions (not applied: change the constants and word lists by hand if they look right) --')
  out.push(
    suggestedLine('PAUSE_MAX_MS', c.pauseMaxMs, s.pauseMaxMs, (from, n) =>
      `p90 of StartOfTurn to EndOfTurn ${from} over ${plural(n, 'backchannel clip')} that played on, plus 300 ms, within 800 to 3000`),
    suggestedLine('TAIL_MS', c.tailMs, s.tailMs, (from, n) =>
      `median StartOfTurn delay from the sound starting ${from} over ${plural(n, 'spoken clip')}, within 200 to 1000`),
    `STT_HOLD_MS (now ${c.sttHoldMs}): ${s.sttHold.text}`,
  )
  if (s.spellings.length) {
    out.push(`Spellings of backchannels that would stop ${r.name}, for src/brain/attention.ts:`)
    for (const sp of s.spellings) out.push(`  ${sp.list}: ${q(sp.add)} (Flux wrote ${q(sp.flux)} for ${sp.clip})`)
  } else if (r.clips.some(clip => clip.mismatch?.kind === 'backchannel-stops')) {
    out.push(`Spellings to add: none: Flux heard more than a backchannel in each that would stop ${r.name} (see Mismatches)`)
  } else out.push(`Spellings to add: none (no backchannel clip would stop ${r.name})`)

  if (r.skipped.length) {
    // One line for each reason: without ElevenLabs, every spoken clip is skipped for the same one.
    out.push('', '-- Skipped --')
    const byWhy = new Map<string, string[]>()
    for (const k of r.skipped) byWhy.set(k.why, [...(byWhy.get(k.why) ?? []), k.id])
    for (const [why, ids] of byWhy) out.push(`${ids.join(', ')}: ${why}`)
  }
  out.push('', REPORT_END)
  return out.join('\n')
}
