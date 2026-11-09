// Alex's fixed lines (the consent line, the goodbye, "let me check" and the rest in src/consent.ts),
// made once per voice by ElevenLabs and kept on disk, so they play at once instead of waiting on a new
// request every time. Only those lines are ever kept: Claude's answers are meeting content, and nothing
// from a meeting is written to disk except the transcript and the minutes.
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TTS_MODEL, synthesize } from './tts.ts'

// The page plays 16 kHz mono PCM16: 32,000 bytes a second.
const BYTES_PER_SECOND = 32_000
/** A kept line goes out in 100 ms pieces. */
export const CHUNK_BYTES = 3_200
// No more than this far ahead of what the meeting has heard (ms).
const LEAD_MS = 1_000
// warm() leaves a line ElevenLabs has not finished in this long to stream live (ms).
const WARM_TIMEOUT_MS = 30_000

type Synth = (text: string, signal?: AbortSignal) => AsyncGenerator<Buffer>

export interface LineCacheOptions {
  /** The folder the audio files go in (data/tts-cache). */
  dir: string
  /** The only texts ever kept: Alex's fixed lines. Anything else streams live and is never kept. */
  lines: readonly string[]
  /** Makes a line's audio (ElevenLabs, unless a test passes a fake). */
  synth?: Synth
  /** What the audio depends on besides the words: the voice, model and format. A new voice gives new files. */
  voiceKey?: string
  /**
   * The clock (ms), so tests can check the pacing without waiting. By default one that only goes
   * forward: the wall clock can be set back mid-line (a time sync), which would pause Alex for as long.
   */
  now?: () => number
  /** Waits ms, or until the signal aborts. Tests pass one that waits for nothing. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** What warm() did. */
export interface WarmResult {
  /** Lines that were kept already. */
  found: number
  /** Lines made just now. */
  generated: number
  /** Lines that could not be made: they stream live until they can. */
  failed: number
  /** Old files removed (another voice, wording that has changed, or a write a crash cut short). */
  removed: number
}

/** The voice, model and format Alex's audio is made with, as .env sets them. */
export function defaultVoiceKey(): string {
  return `${process.env.ELEVENLABS_VOICE_ID?.trim() ?? ''}|${TTS_MODEL}|pcm_16000`
}

/** Waits ms, or until the signal aborts, whichever is first. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// Whole 16-bit samples, and at least one: an empty or damaged file is made again rather than played.
const playable = (audio: Buffer) => audio.length > 0 && audio.length % 2 === 0

export class LineCache {
  private readonly dir: string
  private readonly lines: ReadonlySet<string>
  private readonly synth: Synth
  private readonly voiceKey: string
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly memory = new Map<string, Buffer>()

  constructor(opts: LineCacheOptions) {
    this.dir = opts.dir
    this.lines = new Set(opts.lines)
    this.synth = opts.synth ?? synthesize
    this.voiceKey = opts.voiceKey ?? defaultVoiceKey()
    this.now = opts.now ?? (() => performance.now())
    this.sleep = opts.sleep ?? wait
  }

  /**
   * Speaks a line, as synthesize does (pass it as the session's speak). A fixed line comes from memory
   * or disk; one not made yet streams live and is kept once it has streamed in full. Anything else
   * streams live and is never kept.
   */
  readonly speak = (text: string, signal?: AbortSignal): AsyncGenerator<Buffer> => this.play(text, signal)

  private async *play(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (!this.lines.has(text)) {
      yield* this.synth(text, signal)
      return
    }
    const audio = await this.load(text)
    if (audio) {
      yield* this.paced(audio, signal)
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of this.synth(text, signal)) {
      chunks.push(chunk)
      yield chunk
    }
    // Only a line that streamed in full: one cut short (talked over, or an error) would play cut short every time.
    if (!signal?.aborted) await this.store(text, Buffer.concat(chunks))
  }

  /**
   * Sends kept audio in 100 ms pieces: the first second at once, then no more than a second ahead of
   * real time. The session treats Alex as speaking (so talking over it stops it, except during the
   * consent line, which only leaving, removal or the end of the session stop) only while it is still
   * sending. ElevenLabs streams about as fast as Alex talks, but kept audio would otherwise all go out at
   * once, and the line could no longer be cut off. Stops at once when the signal aborts.
   */
  private async *paced(audio: Buffer, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const start = this.now()
    for (let at = 0; at < audio.length; at += CHUNK_BYTES) {
      const end = Math.min(at + CHUNK_BYTES, audio.length)
      const early = (end * 1000) / BYTES_PER_SECOND - LEAD_MS - (this.now() - start)
      if (early > 0) await this.sleep(early, signal)
      if (signal?.aborted) return
      yield audio.subarray(at, end)
    }
  }

  /**
   * Makes every fixed line not kept yet, one at a time, and removes files no current line uses (another
   * voice, or wording that has changed). Never throws: a line that fails is logged and streams live instead.
   */
  async warm(): Promise<WarmResult> {
    const result: WarmResult = { found: 0, generated: 0, failed: 0, removed: this.prune() }
    for (const text of this.lines) {
      if (await this.load(text)) {
        result.found++
        continue
      }
      try {
        const chunks: Buffer[] = []
        for await (const chunk of this.synth(text, AbortSignal.timeout(WARM_TIMEOUT_MS))) chunks.push(chunk)
        const audio = Buffer.concat(chunks)
        if (!playable(audio)) throw new Error(`no usable audio came back (${audio.length} bytes)`)
        await this.store(text, audio)
        result.generated++
      } catch (err) {
        result.failed++
        console.error(`[tts] could not make "${text}" ahead of time, so it streams live: ${(err as Error).message}`)
      }
    }
    return result
  }

  /** <dir>/<sha256 of the voice and the words>.pcm */
  private file(text: string): string {
    return path.join(this.dir, `${createHash('sha256').update(`${this.voiceKey}\n${text}`).digest('hex')}.pcm`)
  }

  /** A fixed line's audio from memory, else from disk, else null (not made yet, or a file that is no good). */
  private async load(text: string): Promise<Buffer | null> {
    const kept = this.memory.get(text)
    if (kept) return kept
    const audio = await fs.promises.readFile(this.file(text)).catch(() => null)
    if (!audio || !playable(audio)) return null
    this.memory.set(text, audio)
    return audio
  }

  /** Keeps a fixed line's audio, in memory and on disk. Never throws: a line not kept is made again later. */
  private async store(text: string, audio: Buffer): Promise<void> {
    // Never anything but a fixed line: Claude's answers are meeting content.
    if (!this.lines.has(text) || !playable(audio)) return
    this.memory.set(text, audio)
    const file = this.file(text)
    const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      // Written whole under another name, then renamed, so a stop halfway never leaves half a line to play.
      await fs.promises.writeFile(temp, audio, { mode: 0o600 })
      await fs.promises.rename(temp, file)
    } catch (err) {
      await fs.promises.rm(temp, { force: true }).catch(() => {})
      console.error(`[tts] could not keep a fixed line in ${this.dir}: ${(err as Error).message}`)
    }
  }

  /**
   * Removes the kept audio no current line uses, and the temp files of any write a crash cut short
   * (store() writes under a .tmp name, then renames). Says how many files went. warm() runs it before
   * Alex says anything, so no write of this service is under way then.
   */
  private prune(): number {
    let removed = 0
    try {
      const current = new Set([...this.lines].map(text => path.basename(this.file(text))))
      for (const name of fs.readdirSync(this.dir)) {
        const unused = name.endsWith('.pcm') && !current.has(name)
        if (!unused && !name.endsWith('.tmp')) continue
        fs.rmSync(path.join(this.dir, name), { force: true })
        removed++
      }
    } catch (err) {
      // No folder yet means nothing to remove.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[tts] could not tidy ${this.dir}: ${(err as Error).message}`)
    }
    return removed
  }
}
