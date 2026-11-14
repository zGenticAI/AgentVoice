// What the meeting has heard of the assistant. The bot page plays each piece of the assistant's voice as soon as it
// arrives, or straight after the piece before it (public/agent.js), so the service can tell from when each piece went
// out how much of a line had played when the page stopped: someone talked over the assistant or told it never mind
// (the page is told to clear), or the page went. The transcript then keeps only the words the meeting heard.

/** The page starts a piece this long after it arrives, unless the piece before it is still playing (public/agent.js). */
export const PAGE_LEAD_MS = 50
/**
 * Roughly how long one character of a line takes to say: for a line whose audio did not all go out (ElevenLabs was
 * stopped or failed partway), whose full length is not known. On the slow side, so such a line claims fewer words.
 */
export const MS_PER_CHAR = 70
/** How a line that was cut off ends in the transcript. */
export const CUT_OFF = '(cut off)'
// Rounding in the sums of milliseconds: a line whose audio has all played, to within this, was heard in full.
const ROUNDING_MS = 1

/**
 * The words of a line heard when `fraction` of it was said, as the transcript keeps them: whole words only (a word
 * cut off partway wasn't really heard), then "… (cut off)", or " (cut off)" after the end of a sentence. '' when not
 * one whole word was heard.
 */
export function heardText(text: string, fraction: number): string {
  const upTo = Math.floor(Math.min(1, Math.max(0, fraction)) * text.length)
  let end = 0
  for (const word of text.matchAll(/\S+/g)) {
    const wordEnd = word.index + word[0].length
    if (wordEnd > upTo) break
    end = wordEnd
  }
  const heard = text.slice(0, end).replace(/[\s,;:–—-]+$/u, '')
  if (!heard) return ''
  return /[.!?…]$/u.test(heard) ? `${heard} ${CUT_OFF}` : `${heard}… ${CUT_OFF}`
}

/** A line the page may still be playing. */
export interface Playing<L> {
  readonly line: L
  readonly text: string
  /** What the transcript shows for it now: the line, or the part of it heard. */
  shown: string
  /** When the page plays each run of its audio: [start, end], epoch ms, in order. */
  runs: [number, number][]
  /** Milliseconds of its audio that went out to the page. */
  sentMs: number
  /** No more of its audio goes out. */
  closed: boolean
  /** All of its audio went out to the page. */
  complete: boolean
}

/**
 * Follows the page's playback of the assistant's lines, the way the page schedules it, and tells the transcript when a
 * line was not heard to the end (amend: its new text, or '' when none of it was heard). Times are this computer's: a
 * piece arrives at the page and the page's clear arrives a network delay after they went out, the same delay for both,
 * so it cancels out. Only timings are kept here, and the lines while they may still be playing: nothing is logged.
 */
export class Playback<L> {
  // When the page will have played everything sent to it so far (epoch ms), 0 once it has nothing queued.
  private head = 0
  private lines: Playing<L>[] = []

  /** amend: changes a line in the transcript, or takes it out (''). clock: the time (epoch ms), Date.now unless a test passes one. */
  constructor(
    private readonly amend: (line: L, text: string) => void,
    private readonly clock: () => number = Date.now,
  ) {}

  /** A line starts going out to the page. Lines the page has played to the end stop being followed. */
  begin(line: L, text: string): Playing<L> {
    const now = this.clock()
    this.lines = this.lines.filter(p => !(p.closed && (p.runs.at(-1)?.[1] ?? 0) <= now))
    const playing: Playing<L> = { line, text, shown: text, runs: [], sentMs: 0, closed: false, complete: false }
    this.lines.push(playing)
    return playing
  }

  /** `ms` of audio went out to the page just now: a piece of `playing`'s line, or of audio no line is kept for (null). */
  sent(playing: Playing<L> | null, ms: number): void {
    const start = Math.max(this.head, this.clock() + PAGE_LEAD_MS)
    this.head = start + ms
    if (!playing || !this.lines.includes(playing)) return
    playing.sentMs += ms
    const last = playing.runs.at(-1)
    if (last && last[1] === start) last[1] = this.head
    else playing.runs.push([start, this.head])
  }

  /**
   * No more of a line's audio goes out: all of it did (complete), or the turn stopped or ElevenLabs failed partway. The
   * page plays what it was sent, so a line that did not all go out keeps the words its audio got to, at once.
   */
  close(playing: Playing<L>, complete: boolean): void {
    // The page was cleared while the line went out: what was heard of it was settled then.
    if (!this.lines.includes(playing)) return
    playing.closed = true
    playing.complete = complete
    if (!complete) this.settle(playing, Infinity)
  }

  /**
   * The page stopped playing just now: it was told to clear, or it has gone. Each line it had not played to the end
   * keeps only the words heard by then; a line not one word of which was heard goes. Nothing is followed after this.
   */
  stop(): void {
    const at = this.clock()
    for (const playing of this.lines) this.settle(playing, at)
    this.lines = []
    this.head = 0
  }

  /** The page was cleared with no transcript left to correct (the assistant is leaving): forgets every line. */
  reset(): void {
    this.lines = []
    this.head = 0
  }

  /** Lines the page may still be playing, for tests. */
  get following(): readonly Playing<L>[] {
    return this.lines
  }

  private settle(playing: Playing<L>, at: number): void {
    const played = playing.runs.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, at) - start), 0)
    if (playing.complete && played >= playing.sentMs - ROUNDING_MS) return
    // A line whose audio did not all go out is longer than what was sent: about this long, at least.
    const whole = playing.complete ? playing.sentMs : Math.max(playing.sentMs, playing.text.length * MS_PER_CHAR)
    const text = heardText(playing.text, whole > 0 ? played / whole : 0)
    if (text === playing.shown) return
    playing.shown = text
    this.amend(playing.line, text)
  }
}
