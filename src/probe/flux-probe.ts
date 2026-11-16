// npm run flux-probe: streams test clips to Deepgram Flux exactly as the service would, and reports what Flux sent and
// what the session would have done with it, so the barge-in constants and word lists can be tuned against the real
// service (docs/flux-probe.md). Everything that touches the outside (Deepgram, ElevenLabs, ffmpeg, the terminal) comes
// in through ProbeDeps, so the tests run it all against fakes.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { wordsThatCount } from '../brain/attention.ts'
import { FINAL_STATUSES, FLUX_CLOSE_WAIT_MS } from '../pipeline/deepgram.ts'
import { PAUSE_MAX_MS, STOP_WORDS_FINAL, STOP_WORDS_PARTIAL, STT_HOLD_MS, TAIL_MS } from '../pipeline/session.ts'
import { BYTES_PER_MS, msOf, onsetMs, readWav, silence, syntheticClips } from './flux-audio.ts'
import {
  type Cadence, type ClipAnalysis, type ClipInfo, type ForceResult, type HoldResult, type IdleResult, type Intent, type SessionRules,
  analyzeClip, analyzeForce, analyzeHold, analyzeIdle, cadence, cutShort, suggest,
} from './flux-analysis.ts'
import { formatReport } from './flux-report.ts'
import { type Connect, STREAM_TIMING, type StreamRun, type StreamTiming, streamClip } from './flux-stream.ts'

export const USAGE =
  'Usage: npm run flux-probe [-- --mic] [--files <dir>] [--nonverbal] [--json <path>] [--idle-max <seconds>] [--only <ids>]'

/** Backchannels: said over the assistant, none of these should stop it. */
export const BACKCHANNELS: readonly string[] = [
  'Mm-hm.', 'Mm-hmm.', 'Mhm.', 'Uh-huh.', 'Yeah.', 'Yeah, yeah.', 'Okay.', 'Right.', 'Sure.', 'I see.', 'Oh, I see.',
  'Got it.', 'Sorry, go ahead.', 'Ha ha.', 'Hmm.', 'Uh.', 'Um.',
]
/** About 6 s of speech: Update cadence, and the protocol checks. */
export const LONG_SENTENCE = "Let's move the launch to next Thursday, since the design review still has open questions about the budget."
/** Interruptions: each of these should stop the assistant. The two with the name are built from the configured name. */
export function interruptions(name: string): string[] {
  return ['Wait.', 'No.', 'Thanks.', 'Hold on, what about the budget?', `${name}, never mind.`, `${name}, please leave.`, LONG_SENTENCE]
}
const INTERRUPTION_IDS = ['int-wait', 'int-no', 'int-thanks', 'int-budget', 'int-name-never-mind', 'int-name-please-leave', 'int-long']

/** ElevenLabs' model that takes audio tags, for --nonverbal only: the service never uses it. */
export const NONVERBAL_TTS_MODEL = 'eleven_v3'
export const NONVERBAL: readonly { id: string; text: string }[] = [
  { id: 'nv-coughs', text: '[coughs]' },
  { id: 'nv-laughs', text: '[laughs]' },
  { id: 'nv-clears-throat', text: '[clears throat]' },
]

/** The --mic clips: what the owner is asked to do, in a fixed 3 s window each. */
export const MIC_MS = 3000
export const MIC_PROMPTS: readonly { id: string; prompt: string; intent: Intent }[] = [
  { id: 'mic-cough', prompt: 'cough once', intent: 'noise' },
  { id: 'mic-laugh', prompt: 'laugh briefly', intent: 'noise' },
  { id: 'mic-mm-hm', prompt: "say 'mm-hm'", intent: 'backchannel' },
  { id: 'mic-yeah', prompt: "say 'yeah'", intent: 'backchannel' },
  { id: 'mic-budget', prompt: "say 'hold on, what about the budget?'", intent: 'interruption' },
]

/** The protocol checks, which run after the clips. */
export const CHECKS = ['force-close', 'force-only', 'hold', 'idle'] as const
/** ForceEndTurn goes this long after the long sentence's StartOfTurn. */
export const FORCE_AFTER_MS = 1500
/** The hold and idle checks send this much of the long sentence, then nothing. */
export const HOLD_AUDIO_MS = 1000
export const IDLE_AUDIO_MS = 1000
export const IDLE_MAX_S = 90

/** A stream that fails to open, or that Flux closes partway through a clip, is tried once more after this long. */
export const RETRY_WAIT_MS = 2000
/** After this many items in a row whose streams would not open, even on a second try, the run stops. */
export const GIVE_UP_AFTER = 3

export const FFMPEG_HINT = 'ffmpeg is not installed. On macOS: brew install ffmpeg. On Linux: sudo apt install ffmpeg (or your distribution\'s package).'

export interface ProbeArgs {
  mic: boolean
  files: string | null
  nonverbal: boolean
  json: string | null
  idleMaxS: number
  only: string[] | null
  help: boolean
}

/** Reads the command line. An unknown option, or one without its value, is an error, never ignored. */
export function parseArgs(argv: string[]): { args: ProbeArgs } | { error: string } {
  const args: ProbeArgs = { mic: false, files: null, nonverbal: false, json: null, idleMaxS: IDLE_MAX_S, only: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith('--') && argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined]
    const value = (): string | null => {
      const v = inline ?? argv[++i]
      return v === undefined || (inline === undefined && v.startsWith('--')) || !v.trim() ? null : v
    }
    if (flag === '--mic' || flag === '--nonverbal' || flag === '--help' || flag === '-h') {
      if (inline !== undefined) return { error: `${flag} takes no value.\n${USAGE}` }
      if (flag === '--mic') args.mic = true
      else if (flag === '--nonverbal') args.nonverbal = true
      else args.help = true
    } else if (flag === '--files' || flag === '--json' || flag === '--only' || flag === '--idle-max') {
      const v = value()
      if (v === null) return { error: `${flag} needs a value.\n${USAGE}` }
      if (flag === '--files') args.files = v
      else if (flag === '--json') args.json = v
      else if (flag === '--only') args.only = [...(args.only ?? []), ...v.split(',').map(s => s.trim()).filter(Boolean)]
      else {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0 || n > 600) return { error: `--idle-max takes seconds, more than 0 and at most 600, not "${v}".\n${USAGE}` }
        args.idleMaxS = n
      }
    } else return { error: `Unknown option ${argv[i]}.\n${USAGE}` }
  }
  return { args }
}

/** One thing to stream: a clip, or a protocol check. */
export interface PlanItem extends ClipInfo {
  kind: 'clip' | 'check'
  /** What ElevenLabs is asked to say (tts, nonverbal). */
  text?: string
  /** The --mic prompt. */
  prompt?: string
  /** The --files path. */
  file?: string
}

/** What a WAV file is meant to be, from how its name starts (backchannel-, interruption-, noise-). */
export function intentOfFile(name: string): Intent {
  const m = /^(backchannel|bc|interruption|int|noise)[-_ .]/i.exec(name)
  if (!m) return 'unknown'
  const word = m[1].toLowerCase()
  return word.startsWith('b') ? 'backchannel' : word.startsWith('i') ? 'interruption' : 'noise'
}

/** Every clip and check this run would stream, in order: noise first, the checks last. */
export function buildPlan(args: Pick<ProbeArgs, 'mic' | 'nonverbal'>, name: string, files: string[] = []): PlanItem[] {
  const plan: PlanItem[] = syntheticClips().map(c => ({ kind: 'clip', id: c.id, intent: 'noise', source: 'synthetic', label: c.label }))
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  for (const text of BACKCHANNELS) plan.push({ kind: 'clip', id: `bc-${slug(text)}`, intent: 'backchannel', source: 'tts', label: text, text })
  interruptions(name).forEach((text, i) => plan.push({ kind: 'clip', id: INTERRUPTION_IDS[i], intent: 'interruption', source: 'tts', label: text, text }))
  if (args.nonverbal) for (const nv of NONVERBAL) plan.push({ kind: 'clip', id: nv.id, intent: 'noise', source: 'nonverbal', label: nv.text, text: nv.text })
  if (args.mic) {
    for (const m of MIC_PROMPTS) plan.push({ kind: 'clip', id: m.id, intent: m.intent, source: 'mic', label: `the microphone: ${m.prompt}`, prompt: m.prompt })
  }
  const ids = new Set(plan.map(p => p.id))
  for (const file of files) {
    const base = path.basename(file)
    let id = `file-${slug(base.replace(/\.wav$/i, '')) || 'clip'}`
    for (let n = 2; ids.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`
    ids.add(id)
    plan.push({ kind: 'clip', id, intent: intentOfFile(base), source: 'file', label: base, file })
  }
  for (const check of CHECKS) plan.push({ kind: 'check', id: check, intent: 'interruption', source: 'tts', label: LONG_SENTENCE, text: LONG_SENTENCE })
  return plan
}

/**
 * The items --only picks: by id, or by the start of ids ("bc" for every backchannel, "noise", "int", "mic", "file").
 * "cadence" is the long sentence it comes from. A selector that picks nothing is reported, not ignored.
 */
export function selectPlan(plan: PlanItem[], only: string[] | null): { items: PlanItem[]; unknown: string[] } {
  if (!only) return { items: plan, unknown: [] }
  const wanted = only.map(s => (s === 'cadence' ? 'int-long' : s))
  const picks = (id: string, sel: string) => id === sel || id.startsWith(`${sel}-`)
  return {
    items: plan.filter(p => wanted.some(sel => picks(p.id, sel))),
    unknown: only.filter((s, i) => !plan.some(p => picks(p.id, wanted[i]))),
  }
}

/** A rough length for speech ElevenLabs has yet to make (ms): about 14 characters a second. */
const spokenMs = (text: string) => Math.max(600, text.length * 70)

/** The costs line, said before anything is spent: at most this much Deepgram audio, and these ElevenLabs characters. */
export function costLine(items: PlanItem[], o: { voice: boolean; leadMs: number; tailMaxMs: number; idleMaxS: number; fileMs?: Map<string, number> }): string {
  const synthetic = new Map(syntheticClips().map(c => [c.id, msOf(c.audio)]))
  let audioMs = 0
  let streams = 0
  const chars = new Set<string>()
  let nonverbalChars = 0
  for (const item of items) {
    if ((item.source === 'tts' || item.source === 'nonverbal') && !o.voice && item.kind === 'clip') continue
    streams++
    if (item.id === 'idle' || item.id === 'hold') {
      audioMs += o.leadMs + (item.id === 'idle' ? IDLE_AUDIO_MS : HOLD_AUDIO_MS)
    } else {
      const clipMs =
        item.source === 'synthetic' ? (synthetic.get(item.id) ?? 0)
        : item.source === 'mic' ? MIC_MS
        : item.source === 'file' ? (o.fileMs?.get(item.file ?? '') ?? 0)
        : spokenMs(item.text ?? '')
      audioMs += o.leadMs + clipMs + (item.id === 'force-close' ? 0 : o.tailMaxMs)
    }
    if (o.voice && item.text && item.source === 'tts') chars.add(item.text)
    if (o.voice && item.source === 'nonverbal') nonverbalChars += (item.text ?? '').length
  }
  const ttsChars = [...chars].reduce((n, t) => n + t.length, 0)
  const idle = items.some(i => i.id === 'idle') ? ` The idle check keeps one stream open up to ${o.idleMaxS} s with ${(o.leadMs + IDLE_AUDIO_MS) / 1000} s of audio in it.` : ''
  const nv = nonverbalChars ? ` (and ${nonverbalChars} more on ElevenLabs' tagged model for --nonverbal)` : ''
  return `Cost: at most about ${(audioMs / 60000).toFixed(1)} min of Deepgram audio over ${streams} streams, and ${ttsChars} ElevenLabs characters${nv}.${idle}`
}

/** Replaces every secret in a text with [key]: nothing printed or written may hold one, whoever wrote it. */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('[key]')
  return out
}

/**
 * Runs a command and resolves with what it wrote to stdout; onFirstData is called once, as the first of it arrives.
 * Rejects with code ENOENT when the command is not installed.
 */
export function runProcess(command: string, args: string[], onFirstData?: () => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (b: Buffer) => {
      if (!out.length) onFirstData?.()
      out.push(b)
    })
    child.stderr.on('data', (b: Buffer) => (err = (err + b).slice(-400)))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`${path.basename(command)} exited with ${code}${err.trim() ? `: ${err.trim().split('\n').at(-1)}` : ''}`))
    })
  })
}

/** Runs ffmpeg: see runProcess. */
export function runFfmpeg(args: string[], onFirstData?: () => void): Promise<Buffer> {
  return runProcess('ffmpeg', args, onFirstData)
}

/** One way ffmpeg can record the microphone, and what the report calls it. */
export interface MicInput {
  args: string[]
  label: string
}

/**
 * The ways ffmpeg can record the default microphone here, in order. On macOS, ":default" is avfoundation's name for the
 * system's default input: ":0" would be whichever device it lists first, often a meeting app's virtual one.
 */
export function micInputs(platform: NodeJS.Platform): MicInput[] {
  if (platform === 'darwin') return [{ args: ['-f', 'avfoundation', '-i', ':default'], label: "macOS's default input (avfoundation :default)" }]
  if (platform === 'linux') {
    return [
      { args: ['-f', 'pulse', '-i', 'default'], label: "PulseAudio's default source" },
      { args: ['-f', 'alsa', '-i', 'default'], label: "ALSA's default device" },
    ]
  }
  return []
}

const TO_PCM = ['-ac', '1', '-ar', '16000', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1']
// Each packet goes out as soon as it is made, so the first audio, and with it the "Now" cue, comes once capture runs.
const MIC_OUT = ['-flush_packets', '1', ...TO_PCM]
export const MIC_SILENT = 'recorded no sound: check the terminal\'s microphone permission and the input device, and make the sound after "Now"'

export interface ProbeDeps {
  /** The Flux address (fluxUrl()) and the key, which goes only in the handshake's header. */
  url: string
  deepgramKey: string
  /** Every key the run knows of: none is ever printed or written. */
  secrets: string[]
  /** Whether ElevenLabs is set up (its key and voice). Without it, only the noise clips and checks without speech run. */
  voice: boolean
  /** The assistant's name. */
  name: string
  connect?: Connect
  speak?: (text: string, model?: string) => AsyncIterable<Buffer>
  /** runFfmpeg, or a test's: onFirstData once its first audio comes. */
  ffmpeg?: (args: string[], onFirstData?: () => void) => Promise<Buffer>
  /** Shows a prompt and waits for Enter. */
  ask?: (prompt: string) => Promise<void>
  platform?: NodeJS.Platform
  /** The report and the costs line. */
  out: (text: string) => void
  /** Progress. */
  log: (text: string) => void
  timing?: Partial<StreamTiming>
  forceAfterMs?: number
  /** The hold check's silence: STT_HOLD_MS. The tests shorten it. */
  holdMs?: number
  /** RETRY_WAIT_MS. The tests shorten it. */
  retryWaitMs?: number
  app?: string
  date?: string
}

/** The session's rules, as session.ts and attention.ts have them. */
export const SESSION_RULES: SessionRules = {
  pauseMaxMs: PAUSE_MAX_MS,
  stopWordsPartial: STOP_WORDS_PARTIAL,
  stopWordsFinal: STOP_WORDS_FINAL,
  wordsThatCount,
}

export interface ProbeResult {
  report: string
  clips: ClipAnalysis[]
  runs: Map<string, StreamRun>
  force: ForceResult[]
  hold: HoldResult | null
  idle: IdleResult | null
  cadence: Cadence | null
  skipped: { id: string; why: string }[]
}

async function collect(audio: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of audio) parts.push(part)
  return Buffer.concat(parts)
}

const isMissing = (err: unknown) => (err as { code?: unknown })?.code === 'ENOENT'
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)))

/** A refusal that trying again cannot fix: the same statuses FluxStream gives up on. */
const isFinal = (run: StreamRun) => run.refused !== undefined && FINAL_STATUSES.has(run.refused.status)

function openFailure(run: StreamRun): string {
  return run.refused
    ? `Deepgram refused the stream (${run.refused.status})${run.refused.text ? `: ${run.refused.text}` : ''}`
    : `could not open a stream to Deepgram: ${run.error ?? 'no reason given'}`
}

/**
 * The whole probe: makes or records the audio, streams each clip on its own fresh stream (one at a time), runs the
 * checks, prints the report, and writes the JSON when asked. A stream that fails to open, or that Flux closes partway
 * through a clip, is tried once more; the run stops early only for a refusal that trying again cannot fix, or when
 * stream after stream will not open.
 */
export async function runProbe(args: ProbeArgs, deps: ProbeDeps): Promise<ProbeResult> {
  const say = (text: string) => deps.out(redact(text, deps.secrets))
  const log = (text: string) => deps.log(redact(text, deps.secrets))
  const timing: StreamTiming = { ...STREAM_TIMING, ...deps.timing }
  const forceAfterMs = deps.forceAfterMs ?? FORCE_AFTER_MS
  const holdMs = deps.holdMs ?? STT_HOLD_MS
  const retryWaitMs = deps.retryWaitMs ?? RETRY_WAIT_MS
  const ffmpeg = deps.ffmpeg ?? runFfmpeg
  const skipped: { id: string; why: string }[] = []

  const notes: string[] = []
  let files: string[] = []
  if (args.files) {
    if (!fs.statSync(args.files, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--files: ${args.files} is not a folder`)
    files = fs.readdirSync(args.files).filter(f => /\.wav$/i.test(f)).sort().map(f => path.join(args.files as string, f))
    if (!files.length) notes.push(`--files: no .wav file in ${args.files}`)
  }
  const { items, unknown } = selectPlan(buildPlan(args, deps.name, files), args.only)
  if (unknown.length) {
    throw new Error(`--only: ${unknown.join(', ')} matches no clip or check. Use ids such as bc-mm-hm, int-wait, noise-cough or force-close, or their start (bc, int, noise, nv, mic, file).`)
  }
  const fileMs = new Map(files.map(f => [f, Math.max(0, (fs.statSync(f).size - 44) / BYTES_PER_MS)]))
  say(costLine(items, { voice: deps.voice, leadMs: timing.leadMs, tailMaxMs: timing.tailMaxMs, idleMaxS: args.idleMaxS, fileMs }))

  // The audio first, so the streams go one after another with nothing to wait for.
  const audio = new Map<string, Buffer>()
  let ttsChars = 0
  const spoken = new Map<string, Buffer>()
  let voiceGone = deps.voice ? '' : 'ElevenLabs is not set up (ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID)'
  const speak = async (text: string, model?: string): Promise<Buffer> => {
    if (!deps.speak) throw new Error('no voice')
    const pcm = await collect(deps.speak(text, model))
    ttsChars += text.length
    return pcm
  }
  // Why a text could not be spoken: the long sentence is asked for once, though its clip and the checks all use it.
  const unspoken = new Map<string, string>()
  for (const item of items.filter(i => i.source === 'tts')) {
    const text = item.text ?? ''
    if (spoken.has(text) || unspoken.has(text) || voiceGone) continue
    try {
      log(`Speaking ${item.id}`)
      spoken.set(text, await speak(text))
    } catch (err) {
      const why = (err as Error).message
      unspoken.set(text, why)
      // A key ElevenLabs refuses is refused for every clip: no point asking again.
      if (/ElevenLabs 40[123]\b/.test(why)) voiceGone = why
    }
  }
  const synthetic = new Map(syntheticClips().map(c => [c.id, c.audio]))
  for (const item of items) {
    if (item.source === 'tts' && item.kind === 'clip') {
      const pcm = spoken.get(item.text ?? '')
      if (pcm) audio.set(item.id, pcm)
      else skipped.push({ id: item.id, why: unspoken.get(item.text ?? '') ?? voiceGone })
    } else if (item.source === 'synthetic') {
      const pcm = synthetic.get(item.id)
      if (pcm) audio.set(item.id, pcm)
    }
  }

  for (const item of items.filter(i => i.source === 'nonverbal')) {
    if (voiceGone) {
      skipped.push({ id: item.id, why: `not available: ${voiceGone}` })
      continue
    }
    try {
      log(`Speaking ${item.id} (best effort)`)
      const pcm = await speak(item.text ?? '', NONVERBAL_TTS_MODEL)
      if (msOf(pcm) < 100) skipped.push({ id: item.id, why: 'not available: ElevenLabs sent no audio for the tag' })
      else audio.set(item.id, pcm)
    } catch (err) {
      skipped.push({ id: item.id, why: `not available: ${(err as Error).message}` })
    }
  }

  const micItems = items.filter(i => i.source === 'mic')
  if (micItems.length) {
    const inputs = micInputs(deps.platform ?? process.platform)
    let ffmpegGone = ''
    try {
      await ffmpeg(['-version'])
    } catch (err) {
      ffmpegGone = isMissing(err) ? FFMPEG_HINT : `ffmpeg does not run: ${(err as Error).message}`
    }
    if (!inputs.length) ffmpegGone = 'the microphone clips need macOS or Linux'
    if (ffmpegGone) {
      log(ffmpegGone)
      for (const item of micItems) skipped.push({ id: item.id, why: ffmpegGone })
    } else {
      log(`The microphone clips: ${MIC_MS / 1000} s each. The microphone takes a moment to start: make each sound only once "Now" shows.`)
      let working = 0
      let recordedFrom = ''
      for (const item of micItems) {
        await (deps.ask ?? (async () => {}))(`Press Enter, wait for "Now", then ${item.prompt}`)
        let lastError = ''
        for (let i = working; i < inputs.length; i++) {
          try {
            // A sound made before capture runs is lost, so the cue waits for ffmpeg's first audio.
            const cue = () => log(`Now: ${item.prompt}`)
            const pcm = await ffmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputs[i].args, '-t', String(MIC_MS / 1000), ...MIC_OUT], cue)
            if (msOf(pcm) < MIC_MS / 2) throw new Error(`only ${Math.round(msOf(pcm))} ms of audio came`)
            working = i
            lastError = ''
            recordedFrom = inputs[i].label
            // Silence from a microphone the terminal may not use, or from a virtual device, would read as Flux ignoring the sound.
            if (onsetMs(pcm) === null) skipped.push({ id: item.id, why: MIC_SILENT })
            else audio.set(item.id, pcm.subarray(0, pcm.length & ~1))
            break
          } catch (err) {
            lastError = (err as Error).message
          }
        }
        if (lastError) skipped.push({ id: item.id, why: `could not record: ${lastError}` })
      }
      if (recordedFrom) notes.push(`the microphone clips were recorded from ${recordedFrom}`)
    }
  }

  let ffmpegChecked: boolean | null = null
  for (const item of items.filter(i => i.source === 'file')) {
    const wav = readWav(fs.readFileSync(item.file as string))
    if (wav.ok) {
      audio.set(item.id, wav.pcm)
      continue
    }
    if (!wav.convertible) {
      skipped.push({ id: item.id, why: wav.reason })
      continue
    }
    if (ffmpegChecked === null) ffmpegChecked = await ffmpeg(['-version']).then(() => true, () => false)
    if (!ffmpegChecked) {
      skipped.push({ id: item.id, why: `${wav.reason}, not 16 kHz mono PCM16, and ${FFMPEG_HINT}` })
      continue
    }
    try {
      audio.set(item.id, await ffmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', item.file as string, ...TO_PCM]))
    } catch (err) {
      skipped.push({ id: item.id, why: `${wav.reason}, and ffmpeg could not convert it: ${(err as Error).message}` })
    }
  }

  // Each clip on its own fresh stream, then the checks.
  const runs = new Map<string, StreamRun>()
  // Every stream tried, a first try that was tried again included: what the run used.
  const tried: StreamRun[] = []
  const retried: { id: string; why: string; run: StreamRun }[] = []
  const clips: ClipAnalysis[] = []
  const force: ForceResult[] = []
  let hold: HoldResult | null = null
  let idle: IdleResult | null = null
  let stopped = ''
  const sentence = spoken.get(LONG_SENTENCE) ?? null
  const stream = (item: PlanItem): Promise<StreamRun> => {
    const base = { url: deps.url, key: deps.deepgramKey, connect: deps.connect, timing }
    if (item.kind === 'clip') return streamClip({ ...base, audio: audio.get(item.id) as Buffer })
    // Without a voice there is no sentence to speak: what Flux does with the commands and no turn is still worth seeing.
    if (item.id === 'idle') {
      return streamClip({ ...base, audio: sentence ?? silence(IDLE_AUDIO_MS), idle: { audioMs: IDLE_AUDIO_MS, maxMs: args.idleMaxS * 1000 } })
    }
    if (item.id === 'hold') return streamClip({ ...base, audio: sentence ?? silence(HOLD_AUDIO_MS), hold: { audioMs: HOLD_AUDIO_MS, holdMs } })
    return streamClip({ ...base, audio: sentence ?? silence(3000), force: { afterStartMs: forceAfterMs, close: item.id === 'force-close' } })
  }
  // Why a stream says nothing: it did not open, or Flux closed a clip's stream before the probe was done with it.
  const failure = (item: PlanItem, run: StreamRun): string => {
    if (!run.opened) return openFailure(run)
    const short = item.kind === 'clip' ? cutShort(run, timing.minTailMs) : null
    return short ? `Flux closed the stream at t=${short.t} (${short.code}) before the probe was done with it` : ''
  }
  const record = (item: PlanItem, run: StreamRun) => {
    runs.set(item.id, run)
    if (item.kind === 'clip') {
      const opts = { onsetMs: onsetMs(audio.get(item.id) as Buffer), leadMs: timing.leadMs, minTailMs: timing.minTailMs }
      clips.push(analyzeClip(item, run, SESSION_RULES, opts))
    } else if (item.id === 'idle') idle = analyzeIdle(run)
    else if (item.id === 'hold') hold = analyzeHold(run, holdMs)
    else force.push(analyzeForce(item.id as ForceResult['check'], run))
  }
  const toStream = items.filter(i => i.kind === 'check' || audio.has(i.id))
  let unopened = 0
  for (const [n, item] of toStream.entries()) {
    log(`[${n + 1}/${toStream.length}] ${item.id}`)
    let run = await stream(item)
    tried.push(run)
    const why = failure(item, run)
    // Deepgram fails a handshake, or drops a stream, now and then (FluxStream tries again too): one blip must not cost
    // the rest of the run, the checks at its end included. A refusal that trying again cannot fix is not tried again.
    if (why && !isFinal(run)) {
      log(`${item.id}: ${why}; trying once more in ${retryWaitMs / 1000} s`)
      retried.push({ id: item.id, why, run })
      await sleep(retryWaitMs)
      run = await stream(item)
      tried.push(run)
      const again = failure(item, run)
      notes.push(`${item.id}: ${why}, so it was tried again on a fresh stream${again ? `, which failed too: ${again}` : ''}`)
    }
    record(item, run)
    if (isFinal(run)) {
      stopped = openFailure(run)
      log(stopped)
      break
    }
    // A network that is down fails every stream: no point waiting out each one's handshake twice.
    unopened = run.opened ? 0 : unopened + 1
    if (unopened >= GIVE_UP_AFTER) {
      stopped = `${GIVE_UP_AFTER} streams in a row would not open, even on a second try (${openFailure(run)})`
      log(stopped)
      break
    }
  }
  const checksRun = items.filter(i => i.kind === 'check' && runs.get(i.id)?.opened).map(i => i.id)
  if (!sentence && checksRun.length) {
    const checks = checksRun.join(', ')
    notes.push(`${checks}: ran with silence instead of the long sentence (${unspoken.get(LONG_SENTENCE) ?? voiceGone})`)
  }

  const long = clips.find(c => c.id === 'int-long')
  const longRun = runs.get('int-long')
  const cadenceResult = long && longRun?.opened && !long.cutShort ? cadence('int-long', longRun, long.onsetMs) : null
  const constants = { pauseMaxMs: PAUSE_MAX_MS, tailMs: TAIL_MS, sttHoldMs: STT_HOLD_MS, closeWaitMs: FLUX_CLOSE_WAIT_MS }
  const suggestions = suggest(clips, { hold, idle }, constants)
  const url = new URL(deps.url)
  const flux = {
    model: url.searchParams.get('model') ?? '?',
    eotThreshold: url.searchParams.get('eot_threshold') ?? '?',
    keyterms: url.searchParams.getAll('keyterm').length,
    mipOptOut: url.searchParams.get('mip_opt_out') ?? 'not set',
  }
  const report = formatReport({
    name: deps.name,
    app: deps.app ?? 'agent-voice',
    node: process.version,
    date: deps.date ?? `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    flux,
    constants: { ...constants, stopWordsPartial: STOP_WORDS_PARTIAL, stopWordsFinal: STOP_WORDS_FINAL },
    voice: deps.voice
      ? 'ElevenLabs, with the voice and model the service uses'
      : 'ElevenLabs is not set up (ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID): no spoken clips, and the checks ran without speech',
    usage: {
      deepgramMs: tried.reduce((n, r) => n + r.audioMs, 0),
      streams: tried.filter(r => r.opened).length,
      elevenLabsChars: ttsChars,
      lateMs: Math.max(0, ...tried.map(r => r.lateMs)),
    },
    leadMs: timing.leadMs,
    tailMaxMs: timing.tailMaxMs,
    forceAfterMs,
    clips,
    force,
    hold,
    idle,
    cadence: cadenceResult,
    suggestions,
    skipped,
    notes,
    stopped: stopped || undefined,
  })
  say(report)

  if (args.json) {
    const data = {
      probe: 'flux',
      version: 1,
      date: new Date().toISOString(),
      flux,
      constants,
      timing: { ...timing, forceAfterMs, holdMs, idleMaxS: args.idleMaxS, retryWaitMs },
      clips: clips.map(c => ({ ...c, run: runs.get(c.id) })),
      checks: Object.fromEntries(
        CHECKS.filter(c => runs.has(c)).map(c => [c, { run: runs.get(c), result: c === 'idle' ? idle : c === 'hold' ? hold : force.find(f => f.check === c) }]),
      ),
      // The first tries of what was tried again.
      retried,
      cadence: cadenceResult,
      suggestions,
      skipped,
      stopped: stopped || null,
    }
    writePrivate(args.json, redact(`${JSON.stringify(data, null, 2)}\n`, deps.secrets))
    log(`Wrote the raw events and the analysis to ${args.json} (readable only by you)`)
  }
  return { report, clips, runs, force, hold, idle, cadence: cadenceResult, skipped }
}

/** Writes a file only its owner can read (0600), making its folder, if it has to, only its owner can open (0700). */
export function writePrivate(file: string, text: string): void {
  const dir = path.dirname(path.resolve(file))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, text, { mode: 0o600 })
  // The mode applies only when the file is made: an older file of the same name is made private too.
  fs.chmodSync(file, 0o600)
}
