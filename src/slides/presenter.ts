// The Presenter: the assistant presenting a deck in a meeting, from the owner's script, word for word. A state machine
// owned by the meeting session (src/pipeline/session.ts) in a meeting with slides only. It never generates a word of
// narration: it says the script's sentences, one at a time, through the session's normal speech path, so talking over
// it, an answer, "never mind", "please leave" or the page going stop it as they stop an answer. It keeps its place
// outside the turn: the bookmark, the furthest point reached in order, where narration carries on.
//
//   ready ─start─▶ starting ─slide shown─▶ checking ─yes or quiet─▶ narrating(i, k)
//   narrating ─talk, question, command, page away, deaf, voice─▶ held(cause) ─its resume rule─▶ narrating
//   narrating|held ─"go back", "go to slide M" (behind, or on request)─▶ a detour ─"carry on"─▶ narrating(bookmark)
//   narrating(last) ─done─▶ qa ─2 min quiet, "stop presenting"─▶ stopped ─"start the presentation"─▶ starting
//   any ─the owner's end─▶ ended (the room can't restart it)      any ─leave, time-up, end─▶ disposed
//
// Who may do what (Decision 2a): anyone who says the name may start, pause, carry on, move between slides and stop
// sharing; only the owner can end the presentation for good, wrap up, or release the owner's own pause.
//
// The share goes through SlideSurface (src/slides/surface.ts); the presenter never sees a token and never calls Recall.
// Nothing here may take the service down: its timers and promises catch their own errors, and a fault degrades to a
// hold, with an event for the owner. The log has states and counts only: never a title, a sentence or a slide's text.
import { endsOnQuestion } from '../brain/attention.ts'
import { type HintPlatform, SLIDES_LINES, type SlidesLines } from '../consent.ts'
import { stripBlockTags } from '../untrusted.ts'
import { type SlideCommand, slideCommand, windowReply } from './commands.ts'
import { MAX_PAGE_TEXT, MAX_TITLE, type Manifest } from './manifest.ts'
import type { Script } from './script.ts'
import type { SlideSurface, StartOutcome } from './surface.ts'

/** One slide of the meeting: a page of the deck the script shows, with its sentences, in page order. */
export interface PresenterSlide {
  /** The PDF page number: "slide N" means it. */
  page: number
  /** From the deck: for "Back to <title>." and the transcript's markers. Never in the log. */
  title: string
  /** The slide's own text, from the deck: for answers about the slide on screen. Never spoken, never in the log. */
  text: string
  /** The script's sentences, said word for word. None: a silent slide (hold only). */
  sentences: readonly string[]
  /** Extra seconds of silence after it appears, and after its last sentence. */
  hold: number
  pause: number
  /** A backup slide: shown only when asked for, as a detour. */
  onRequest: boolean
}

/**
 * The meeting's slides from the parsed script and its deck: every section not excluded, for a page the deck has, in
 * page order. Their images are the deck's images of these pages, in the same order (index i is the i-th).
 */
export function presenterSlides(script: Script, manifest: Manifest): PresenterSlide[] {
  const pages = new Map(manifest.slides.map(s => [s.n, s]))
  return script.sections
    .filter(s => !s.exclude && !s.todo && pages.has(s.page))
    .sort((a, b) => a.page - b.page)
    .map(s => ({
      page: s.page,
      // A third party's PDF can carry instructions: its block tags never reach a prompt (the loader refuses them too).
      title: stripBlockTags(pages.get(s.page)!.title).slice(0, MAX_TITLE),
      text: stripBlockTags(pages.get(s.page)!.text).slice(0, MAX_PAGE_TEXT),
      sentences: [...s.sentences],
      hold: s.hold ?? 0,
      pause: s.pause ?? 0,
      onRequest: s.onRequest,
    }))
}

export type PresenterState = 'ready' | 'starting' | 'checking' | 'narrating' | 'held' | 'qa' | 'stopped' | 'ended' | 'disposed'

/**
 * Why narration is held. question: an answer runs, then "Back to <title>.". talk: someone talked over it, then "Shall
 * I carry on?". asked: "<name>, pause" or "never mind": only "carry on" resumes. owner: the owner's pause: only the
 * owner resumes. page_away: the camera page dropped, until it is back. deaf: speech recognition was lost. voice:
 * ElevenLabs failed. detour: a slide behind the bookmark, or a backup slide, is on screen.
 */
export type HoldCause = 'question' | 'talk' | 'asked' | 'owner' | 'page_away' | 'deaf' | 'voice' | 'detour'

// A new cause replaces the one held only when it says more: an owner's pause is never lifted by a question.
const PRIORITY: Record<HoldCause, number> = { talk: 0, question: 1, voice: 2, page_away: 3, deaf: 4, detour: 5, asked: 6, owner: 7 }

/** What the owner's session hears: on changes and problems only, never on every slide. */
export type PresentationEventKind =
  | 'started'
  | 'finished'
  | 'stopped'
  | 'share_failed'
  | 'not_loading'
  | 'not_seen'
  | 'stuck'
  | 'voice_failed'
  | 'deaf'
  | 'camera_suspect'
  | 'contested'
  | 'rate_limited'
  | 'held_long'

export interface PresentationEvent {
  event: PresentationEventKind
  /** The page on screen, or the bookmark's. */
  slide?: number
  /** How many slides the meeting has. */
  of: number
  /** The slide's title, from the deck: the owner's own content, for the owner's own session. */
  title?: string
  note: string
}

export interface PresenterStatus {
  state: PresenterState
  /** The page on screen, or null. */
  slide: number | null
  /** The page narration carries on from. */
  bookmark: number
  of: number
  title: string | null
  held: HoldCause | null
  detour: boolean
  share: SlideSurface['state']
}

/** For meeting_ended: how far the deck got, by page (0: it never started). */
export interface PresentationSummary {
  reached: number
  of: number
  finished: boolean
}

/**
 * What the brain answers from in a meeting with slides (src/brain/brain.ts): the outline, the same all meeting, for the
 * cached block; and the slide on screen now, for the request itself. All of it is content, never instructions.
 */
export interface SlidesForBrain {
  /** Each slide presented in order or on request: its page, title and first sentence. */
  outline: readonly { page: number; title: string; first: string; onRequest: boolean }[]
  /** The slide on screen, or null when none is (not started, stopped). */
  current: {
    page: number
    /** How many slides the meeting has. */
    of: number
    title: string
    /** The owner's script for it. */
    script: string
    /** The slide's own text, from the PDF. */
    text: string
    /** The sentence narration was at, or ''. */
    saying: string
    /** The titles of the slides before and after it, or ''. */
    before: string
    after: string
  } | null
}

export type OwnerAction = 'start' | 'pause' | 'resume' | 'next' | 'back' | 'goto' | 'restart' | 'wrap_up' | 'stop' | 'end'
export const OWNER_ACTIONS: readonly OwnerAction[] = ['start', 'pause', 'resume', 'next', 'back', 'goto', 'restart', 'wrap_up', 'stop', 'end']

/** A narration sentence: slide i of the meeting, sentence k. The session tells the presenter when one was cut short. */
export interface NarrationTag {
  i: number
  k: number
}

/** What the presenter uses of its meeting session. */
export interface PresenterHost {
  /** Runs work as the session's turn: an answer, "never mind", the goodbye or the page going stop it. */
  runTurn(work: (signal: AbortSignal) => Promise<void>): Promise<void>
  /** Says a line through the session's speech path: whether all of it went out. Throws when the voice failed. */
  say(text: string, signal: AbortSignal, tag?: NarrationTag): Promise<boolean>
  /** Stops what the session is saying now, as "never mind" would, without a hold: the owner's own moves. */
  interrupt(): void
  /** The page still has some of the voice to play, or is paused. */
  playing(): boolean
  /** How long the room has been quiet (ms): 0 while someone is in the middle of a turn. */
  quietMs(): number
  /** The camera page is there to play the voice. */
  attached(): boolean
  /** A turn is running: an answer, or a line. */
  busy(): boolean
  /** How long the page still plays the line it is playing now (ms): 0 when it plays none. */
  lineLeftMs(): number
  /** Clears what the page still has to play, without stopping the turn: the lines it did not play are cut (see cut). */
  clear(): void
  /** The session could speak now: the consent line over, the page there, hearing, and no turn running. */
  free(): boolean
  /** Opens the session's reply window: the next line is taken without the name. */
  openWindow(ms: number): void
  windowOpen(): boolean
  /**
   * Adds a marker to the transcript ("showing slide 6: Pricing"), as the assistant's, never a participant's. page: the
   * slide it is about, if one.
   */
  marker(text: string, page?: number): void
}

export const PRESENTER_TIMING = Object.freeze({
  /** How often the presenter looks at what it waits for (ms). */
  tickMs: 100,
  /** After a slide appears, before it is talked about (ms), plus its hold. */
  leadMs: 700,
  /** The room's quiet before the next slide (ms). */
  slideQuietMs: 1200,
  /** After an answer, the quiet before "Back to <title>." (ms). */
  questionQuietMs: 2000,
  /** After side talk, the quiet before "Shall I carry on?" (ms), and how long its window stays open. */
  talkQuietMs: 2500,
  carryOnWindowMs: 6000,
  /** "Can everyone see my slides?": this long after the first slide is shown, with a window this long, and the quiet after it that moves on. */
  canSeeDelayMs: 2000,
  canSeeWindowMs: 8000,
  canSeeQuietMs: 4000,
  /** After the camera page is back, before narration resumes (ms). */
  pageBackMs: 2000,
  /** Before the one retry of a sentence the voice failed on (ms). */
  voiceRetryMs: 2000,
  /** A hold longer than this resumes with "Back to <title>." (ms). */
  longHoldMs: 20_000,
  /** A hold longer than this is told to the owner (ms). */
  heldLongMs: 120_000,
  /** In questions after the last slide: the share stops after this long with nothing said to the assistant (ms). */
  qaIdleMs: 120_000,
})
export type PresenterTiming = { -readonly [K in keyof typeof PRESENTER_TIMING]: number }

export interface PresenterOptions {
  surface: SlideSurface
  /** The meeting's slides, in page order: the surface's images are in the same order. */
  slides: readonly PresenterSlide[]
  host: PresenterHost
  /** The platform, for the hint after "no" to "Can everyone see my slides?". */
  platform: HintPlatform
  /** The page to start from (join --from): its first narrated slide unless given. */
  from?: number
  lines?: SlidesLines
  timing?: Partial<PresenterTiming>
  /** The bot's id, for the log. */
  botId?: string
}

/** Waits ms, or until the signal aborts. Never rejects. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, Math.max(0, ms))
    timer.unref?.()
    signal?.addEventListener('abort', done, { once: true })
  })
}

const errorKind = (err: unknown): string => (err instanceof Error ? err.name : 'error')

/** A hold, and what was done about it. */
interface Hold {
  cause: HoldCause
  since: number
  /** "Shall I carry on?" was asked for it (once per hold). */
  asked: boolean
  /** The owner was told it is long (held_long). */
  told: boolean
}

export class Presenter {
  private state: PresenterState = 'ready'
  private holding: Hold | null = null
  /** The bookmark: the slide and sentence narration carries on from. */
  private resume: NarrationTag
  /** The furthest slide reached, by index, for the summary. */
  private furthest: number
  /** The slide on screen, by index. */
  private view: number | null = null
  /** A detour narration: the slide being narrated is not the bookmark's (restart during a detour). */
  private detourRun = false
  /** Counts the narrations started: an old one that is still winding down stops at its next step. */
  private run = 0
  /** Counts the starts: one overtaken by a stop or another start does nothing more. */
  private attempt = 0
  /** "Can everyone see my slides?" has been asked in this meeting: only after the first successful start. */
  private checked = false
  private canSeeAt = 0
  private canSeeAsked = 0
  /** A window the presenter opened with a question of its own, and until when. */
  private window: { kind: 'carry_on' | 'can_see'; until: number } | null = null
  private everStarted = false
  private finished = false
  /** The owner's own pause stands (Decision 2a): only narration the owner starts lifts it, and a stop keeps it. */
  private ownerPaused = false
  /** Speech recognition is lost now; and the fixed line that says so is still to be said (once per loss). */
  private deafNow = false
  private deafPending = false
  /** When the camera page came back (for page_away), 0 while it is away. */
  private pageBackAt = 0
  /** When the room last said something to the assistant, or a command, in questions after the last slide. */
  private lastActivity = Date.now()
  /** Lines to say once the session is free: a problem with the share said while an answer runs, say. */
  private readonly queued: string[] = []
  private readonly listeners: ((event: PresentationEvent) => void)[] = []
  private readonly timing: PresenterTiming
  private readonly lines: SlidesLines
  private readonly ticker: NodeJS.Timeout
  private readonly slides: readonly PresenterSlide[]

  constructor(private readonly opts: PresenterOptions) {
    this.slides = opts.slides
    this.timing = { ...PRESENTER_TIMING, ...opts.timing }
    this.lines = opts.lines ?? SLIDES_LINES
    const first = this.firstNarrated()
    const from = opts.from === undefined ? -1 : this.slides.findIndex(s => s.page === opts.from)
    this.resume = { i: from >= 0 ? from : first, k: 0 }
    this.furthest = this.resume.i
    this.ticker = setInterval(() => this.tick(), this.timing.tickMs)
    this.ticker.unref()
    // What the share says by itself: each has stopped or degraded the share already.
    opts.surface.on('stuck', () => this.shareProblem('stuck', this.lines.stuck))
    opts.surface.on('contested', () => this.shareProblem('contested', this.lines.problem))
    opts.surface.on('failed', () => this.shareProblem('share_failed', this.lines.problem))
    opts.surface.on('camera_suspect', () => this.emit('camera_suspect', 'The camera page dropped right after a share change: no more shares in this meeting.'))
  }

  // --- What the owner's side reads ----------------------------------------------------------------------------------

  /** Events for the owner's session (layer B forwards them as presentation events). */
  onEvent(fn: (event: PresentationEvent) => void): void {
    this.listeners.push(fn)
  }

  status(): PresenterStatus {
    const shown = this.view === null ? null : this.slides[this.view]
    return {
      state: this.state,
      slide: shown?.page ?? null,
      bookmark: this.slides[this.bookmark()]?.page ?? 0,
      of: this.slides.length,
      title: shown?.title ?? null,
      held: this.state === 'held' ? (this.holding?.cause ?? null) : null,
      detour: this.inDetour(),
      share: this.opts.surface.state,
    }
  }

  /** What the brain answers from (SlidesForBrain): the outline, and the slide on screen now. */
  forBrain(): SlidesForBrain {
    const outline = this.slides.map(s => ({ page: s.page, title: s.title, first: s.sentences[0] ?? '', onRequest: s.onRequest }))
    const i = this.onScreen()
    if (i === null) return { outline, current: null }
    const slide = this.slides[i]
    // The sentence narration was at on this slide: the one it carries on from, or the last one heard.
    const k = Math.min(this.resume.k, slide.sentences.length - 1)
    const saying = this.resume.i === i && this.resume.k > 0 && k >= 0 ? slide.sentences[k] : ''
    return {
      outline,
      current: {
        page: slide.page,
        of: this.slides.length,
        title: slide.title,
        script: slide.sentences.join(' '),
        text: slide.text,
        saying,
        before: i > 0 ? this.titled(i - 1) : '',
        after: i + 1 < this.slides.length ? this.titled(i + 1) : '',
      },
    }
  }

  /** "slide 5, Adoption" */
  private titled(i: number): string {
    const slide = this.slides[i]
    return `slide ${slide.page}${slide.title ? `, ${slide.title}` : ''}`
  }

  /** The slide on screen (its index), while the slides are shared; null otherwise. */
  private onScreen(): number | null {
    if (this.view === null) return null
    return this.state === 'narrating' || this.state === 'held' || this.state === 'qa' || this.state === 'checking' ? this.view : null
  }

  /** For a hand-off to the owner's session: "On screen: slide N of M, <title>.", or '' when no slide is. */
  onScreenLine(): string {
    const i = this.onScreen()
    if (i === null) return ''
    const slide = this.slides[i]
    return `On screen: slide ${slide.page} of ${this.slides.length}${slide.title ? `, ${slide.title}` : ''}.`
  }

  /** How the brain's window folds the narration (Transcript.recent): every slide's but the one on screen. */
  collapse(name: string): { current: number | null; name: string; title: (page: number) => string } {
    const i = this.onScreen()
    const titles = new Map(this.slides.map(s => [s.page, s.title]))
    return { current: i === null ? null : this.slides[i].page, name, title: page => titles.get(page) ?? '' }
  }

  /** The slide narration carries on from: the next one when the bookmark's was heard in full. */
  private bookmark(): number {
    const slide = this.slides[this.resume.i]
    if (!slide || this.resume.k < slide.sentences.length) return this.resume.i
    return this.nextNarrated(this.resume.i) ?? this.resume.i
  }

  summary(): PresentationSummary {
    const reached = this.everStarted ? (this.slides[this.furthest]?.page ?? 0) : 0
    return { reached, of: this.slides.length, finished: this.finished }
  }

  get current(): PresenterState {
    return this.state
  }

  /** Narration has started at least once in this meeting: for the minutes' mention of the presentation. */
  get started(): boolean {
    return this.everStarted
  }

  // --- What the session tells it ----------------------------------------------------------------------------------

  /**
   * A line someone said, after the leave, cancel and page-away checks and before the attention rules. Returns the
   * command it carried out (for why_not_answered), or null for a line that is not one here: the session then reads it
   * as any other. awaiting: a window the session had open, in which a line needs no name.
   */
  hear(text: string, ctx: { awaiting: boolean }): string | null {
    try {
      if (this.state === 'disposed') return null
      const mine = this.window && Date.now() < this.window.until ? this.window.kind : null
      if (mine) {
        // Any line closes the window, as the session's does.
        this.window = null
        const reply = windowReply(text)
        if (mine === 'can_see' && this.state === 'checking' && reply) {
          if (reply === 'no') this.notSeen()
          else this.beginNarration()
          return `${reply} to "can everyone see my slides"`
        }
        if (mine === 'carry_on' && this.state === 'held' && reply) {
          if (reply === 'yes' && this.ownerPaused) this.say(this.lines.waitForOwner)
          else if (reply === 'yes') this.carryOn()
          else this.holdAs('asked')
          return `${reply} to "shall I carry on"`
        }
      }
      const command = slideCommand(text, { inWindow: ctx.awaiting || mine !== null })
      if (!command) return null
      return this.command(command, 'room')
    } catch (err) {
      this.fault('a line', err)
      return null
    }
  }

  /**
   * Narration must stop: set before the session stops the turn, so the place it stopped at is kept. talk: talked over;
   * question: a line said to the assistant is answered; asked: "never mind"; page_away: the camera page dropped.
   */
  hold(cause: HoldCause): void {
    if (cause === 'question' && this.state === 'qa') {
      this.lastActivity = Date.now()
      return
    }
    // Talking over the presenter's own question is the answer to it: its window decides.
    if (cause === 'talk' && (this.state === 'checking' || (this.window && Date.now() < this.window.until))) return
    if (this.state === 'checking' && cause === 'question') {
      // A question in the check window: answered, then narration starts.
      this.window = null
      this.everStarted = true
      this.emit('started', 'The presentation started.', this.resume.i)
    }
    if (this.state !== 'narrating' && this.state !== 'held' && this.state !== 'checking') return
    this.holdAs(cause)
  }

  /** A narration line the meeting did not hear to the end: narration resumes at that sentence. */
  cut(tag: NarrationTag): void {
    if (tag.i === this.resume.i && tag.k < this.resume.k) this.resume = { i: tag.i, k: tag.k }
  }

  /** Speech recognition was lost (false) or is back (true). It never talks on when it can't hear "please leave". */
  hearing(on: boolean): void {
    if (on === !this.deafNow) return
    this.deafNow = !on
    if (!on) {
      this.emit('deaf', "Speech recognition can't hear the meeting, so the slides are paused.")
      if (this.state === 'narrating') {
        // Held at once, so nothing more goes out; and what went out already would play on, so the page is stopped at the
        // end of the sentence it plays now.
        this.deafPending = true
        this.holdAs('deaf')
        this.turn(signal => this.deafStop(signal))
      } else if (this.state === 'held' || this.state === 'checking') this.holdAs('deaf')
      return
    }
    this.deafPending = false
  }

  /** The camera page came back (after any repeat of the consent line). */
  pageBack(): void {
    this.pageBackAt = Date.now()
  }

  /** The meeting is over for the presenter: the share is blanked and revoked, with no call to Recall. */
  dispose(): void {
    if (this.state === 'disposed') return
    this.state = 'disposed'
    this.run++
    this.attempt++
    clearInterval(this.ticker)
    try {
      this.opts.surface.close()
    } catch (err) {
      console.error(`[slides] bot ${this.opts.botId ?? '-'}: closing the share failed (${errorKind(err)})`)
    }
  }

  // --- The owner's controls -----------------------------------------------------------------------------------------

  /** One of the owner's actions (slides_control, npm run slides -- control): at once, without the name. */
  owner(action: OwnerAction, slide?: number): { ok: boolean; note: string } {
    try {
      if (this.state === 'disposed') return { ok: false, note: 'The meeting is over.' }
      if (!OWNER_ACTIONS.includes(action)) return { ok: false, note: `Unknown action: use one of ${OWNER_ACTIONS.join(', ')}.` }
      if (action === 'goto') {
        if (typeof slide !== 'number' || !Number.isInteger(slide)) return { ok: false, note: 'goto needs a slide number.' }
        const i = this.slides.findIndex(s => s.page === slide)
        if (i < 0) return { ok: false, note: `Slide ${slide} is not in this meeting: it is excluded, or not in the script.` }
      }
      if (action === 'end') {
        const was = this.state
        if (was === 'ended') return { ok: true, note: 'The presentation had ended already.' }
        void this.stopFlow({ end: true, quiet: was === 'ready' || was === 'stopped' }).catch(err => this.fault('ending', err))
        return { ok: true, note: 'The presentation is over for this meeting: the room can no longer restart it.' }
      }
      if (action === 'wrap_up') {
        if (!this.presenting()) return { ok: false, note: `Nothing is being presented (${this.state}).` }
        const last = this.lastNarrated()
        this.opts.host.interrupt()
        this.resume = { i: last, k: 0 }
        this.narrateFrom({ prefix: this.lines.wrapUp })
        return this.mutedNote(false) ?? { ok: true, note: 'Jumping to the last slide.' }
      }
      if (action === 'pause') {
        if (this.state === 'qa') return { ok: true, note: 'The last slide is up, for questions: there is nothing to pause.' }
        if (!this.presenting() && this.state !== 'checking') return { ok: false, note: `Nothing is being presented (${this.state}).` }
        if (this.state === 'narrating') this.opts.host.interrupt()
        this.holdAs('owner')
        this.ownerPaused = true
        return { ok: true, note: 'Paused. Only you can resume it.' }
      }
      const command: SlideCommand = action === 'goto' ? { kind: 'goto', slide: slide! } : { kind: action }
      const view = this.view
      const done = this.command(command, 'owner')
      if (!done) return { ok: false, note: `Not now: the presentation is ${this.state}.` }
      return this.mutedNote(action === 'resume', view) ?? { ok: true, note: `Done: ${done}.` }
    } catch (err) {
      this.fault('an owner action', err)
      return { ok: false, note: 'It failed: see the service log.' }
    }
  }

  // --- Commands ---------------------------------------------------------------------------------------------------

  /** Whether a share is up and narration is under way, held or in questions. */
  private presenting(): boolean {
    return this.state === 'narrating' || this.state === 'held' || this.state === 'qa'
  }

  /** Carries out a command, from the room or the owner. What it did, or null when it is no command in this state. */
  private command(command: SlideCommand, by: 'room' | 'owner'): string | null {
    const owner = by === 'owner'
    if (this.state === 'qa') this.lastActivity = Date.now()
    switch (command.kind) {
      case 'start': {
        if (this.state === 'ended' && !owner) {
          this.say(this.lines.waitForOwner)
          return 'start (refused: the owner ended the presentation)'
        }
        // A stop keeps the owner's pause: the room may stop the slides, but not start narration again.
        if ((this.state === 'stopped' || this.state === 'ready') && this.ownerPaused && !owner) {
          this.say(this.lines.waitForOwner)
          return 'start (refused: paused by the owner)'
        }
        if (this.state !== 'ready' && this.state !== 'stopped' && this.state !== 'ended') return owner ? null : 'start (presenting already)'
        this.startFlow()
        return 'start'
      }
      case 'stop': {
        if (this.state === 'ready' || this.state === 'stopped' || this.state === 'ended') return owner ? null : 'stop (nothing shared)'
        void this.stopFlow({}).catch(err => this.fault('stopping', err))
        return 'stop'
      }
      case 'pause': {
        if (this.state === 'held' && this.holding?.cause === 'owner') return 'pause (paused by the owner already)'
        if (this.state !== 'narrating' && this.state !== 'held' && this.state !== 'checking') return null
        this.holdAs('asked')
        return 'pause'
      }
      case 'resume': {
        if (this.state === 'checking') {
          this.beginNarration()
          return 'carry on'
        }
        if (this.state !== 'held') return this.state === 'narrating' || this.state === 'qa' ? 'carry on (nothing held)' : null
        if (this.ownerPaused && !owner) {
          this.say(this.lines.waitForOwner)
          return 'carry on (refused: paused by the owner)'
        }
        this.carryOn()
        return 'carry on'
      }
      case 'next': {
        if (!this.presenting()) return null
        const from = this.view ?? this.resume.i
        if (this.inDetour() || this.state === 'qa') {
          const to = from + 1
          if (to >= this.slides.length) return 'next (no slide after it)'
          if (to === this.resume.i && this.state !== 'qa') {
            if (this.ownerPaused && !owner) {
              // Back on the bookmark's slide, still held: only the owner resumes.
              void this.showSlide(to).catch(err => this.fault('showing a slide', err))
              return 'next (back at the bookmark, paused by the owner)'
            }
            this.carryOn({ silent: true })
            return 'next (back at the bookmark)'
          }
          this.detour(to, owner)
          return 'next'
        }
        const next = this.nextNarrated(this.resume.i)
        if (next === null) return 'next (the last slide)'
        this.move(next, owner)
        return 'next'
      }
      case 'back': {
        if (!this.presenting()) return null
        const to = (this.view ?? this.resume.i) - 1
        if (to < 0) return 'back (the first slide)'
        this.detour(to, owner)
        return 'back'
      }
      case 'goto': {
        if (!this.presenting()) return null
        const i = command.slide === 'last' ? this.lastNarrated() : this.slides.findIndex(s => s.page === command.slide)
        if (i < 0) {
          this.say(`I don't have slide ${command.slide} to show.`)
          return `go to slide ${command.slide} (not in this meeting)`
        }
        const page = this.slides[i].page
        if (this.state === 'qa' || this.slides[i].onRequest || i < this.resume.i) this.detour(i, owner)
        else if (i > this.resume.i) this.move(i, owner)
        else this.restartSlide(i, owner)
        return `go to slide ${page}`
      }
      case 'restart': {
        if (this.state !== 'narrating' && this.state !== 'held') return null
        this.restartSlide(this.view ?? this.resume.i, owner)
        return 'restart the slide'
      }
    }
  }

  /** Narration moves on to slide i, from its start; the slides between are not narrated. */
  private move(i: number, owner: boolean): void {
    if (this.state === 'narrating' || owner) this.opts.host.interrupt()
    this.resume = { i, k: 0 }
    this.furthest = Math.max(this.furthest, i)
    // The room may move the slides while the owner has paused them, but only the owner resumes.
    if (this.ownerPaused && !owner) {
      void this.showSlide(i).catch(err => this.fault('showing a slide', err))
      return
    }
    this.narrateFrom({ prefix: owner ? `Moving to slide ${this.slides[i].page}.` : undefined })
  }

  /** Slide i is shown out of order, the bookmark kept: "Here's slide N.", then held until "carry on". */
  private detour(i: number, owner: boolean): void {
    if (this.state === 'narrating' || owner) this.opts.host.interrupt()
    const finished = this.state === 'qa'
    if (!finished) this.holdAs(this.holding?.cause === 'owner' ? 'owner' : 'detour')
    const page = this.slides[i].page
    const line = owner ? `Moving to slide ${page}.` : `Here's slide ${page}.`
    const work = async (signal: AbortSignal) => {
      await this.showSlide(i)
      if (signal.aborted) return
      // It can't hear "please leave", or has no page: the slide is shown in silence.
      if (this.deafPending) return this.deafStop(signal)
      if (!this.mute()) await this.opts.host.say(line, signal)
    }
    this.turn(work)
  }

  /** Narrates slide i again from its start: the bookmark's slide, or a detour's (then held again after it). */
  private restartSlide(i: number, owner: boolean): void {
    if (this.ownerPaused && !owner) {
      // The room may show the slide, but only the owner starts narration again.
      void this.showSlide(i).catch(err => this.fault('showing a slide', err))
      this.say(this.lines.waitForOwner)
      return
    }
    this.opts.host.interrupt()
    if (i === this.resume.i) {
      this.resume = { i, k: 0 }
      this.narrateFrom({ prefix: owner ? `Moving to slide ${this.slides[i].page}.` : undefined })
      return
    }
    this.narrateFrom({ detour: i })
  }

  // --- Starting and stopping ---------------------------------------------------------------------------------------

  /** Shares the slides from the bookmark: the consent line first, then the line, the share, and the check question. */
  private startFlow(): void {
    const attempt = ++this.attempt
    // Only the owner gets here while the owner's pause stands: the room's start is refused.
    this.ownerPaused = false
    this.state = 'starting'
    this.holding = null
    this.window = null
    void (async () => {
      // The consent line always comes first, and nothing is said over an answer.
      while (!this.opts.host.free() || this.deafNow) {
        await sleep(this.timing.tickMs)
        if (attempt !== this.attempt || this.state !== 'starting') return
      }
      this.normalise()
      if (this.state !== 'starting') return
      // Said as the share is asked for: loading can take a few seconds.
      const sharing = this.turn(signal => this.opts.host.say(this.lines.sharing, signal).then(() => {}))
      const outcome = await this.shared<StartOutcome>(() => this.opts.surface.start(this.resume.i, this.neighbours(this.resume.i)), 'failed')
      await sharing
      if (attempt !== this.attempt || this.state !== 'starting') return
      if (outcome === 'loaded') {
        this.view = this.resume.i
        this.markShown(this.resume.i, true)
        if (this.checked) return this.beginNarration()
        this.state = 'checking'
        this.canSeeAt = Date.now() + this.timing.canSeeDelayMs
        this.canSeeAsked = 0
        return
      }
      this.state = this.everStarted ? 'stopped' : 'ready'
      const failure: Record<Exclude<StartOutcome, 'loaded'>, [PresentationEventKind, string, string]> = {
        failed: ['share_failed', this.lines.shareFailed, 'Recall refused the screen share.'],
        not_loading: ['not_loading', this.lines.notLoading, 'The slides page did not load within 20 s, so the share was stopped.'],
        rate_limited: ['rate_limited', this.lines.rateLimited, 'The share was asked for too often in a short time.'],
        disabled: ['share_failed', this.lines.rateLimited, 'Sharing is off for this meeting after an earlier problem.'],
      }
      const [event, line, note] = failure[outcome]
      this.say(line)
      this.emit(event, note)
    })().catch(err => this.fault('starting', err))
  }

  /** The room said no to "Can everyone see my slides?": the platform's hint, the share stopped, the bookmark kept. */
  private notSeen(): void {
    this.attempt++
    this.state = this.everStarted ? 'stopped' : 'ready'
    this.view = null
    this.say(this.lines.hints[this.opts.platform])
    void this.shared(() => this.opts.surface.stop(), undefined).then(() => {
      this.opts.host.marker('stopped sharing the slides')
      this.emit('not_seen', 'Someone said they could not see the slides: the host may need to allow screen sharing.')
    })
  }

  /** Stops the share: said (unless quiet), then the share stopped. end: for good, by the owner. */
  private async stopFlow(opts: { end?: boolean; quiet?: boolean }): Promise<void> {
    const was = this.state
    this.attempt++
    this.run++
    this.state = opts.end ? 'ended' : 'stopped'
    this.holding = null
    this.window = null
    this.deafPending = false
    const shared = was !== 'ready' && was !== 'stopped' && was !== 'ended'
    // At once: what is still playing of the narration stops, and the bookmark stays where the meeting stopped hearing.
    if (was === 'narrating') this.opts.host.interrupt()
    if (!opts.quiet && shared) this.sayNow(this.lines.stopped)
    if (!shared) return
    this.view = null
    await this.shared(() => this.opts.surface.stop(), undefined)
    this.opts.host.marker('stopped sharing the slides')
    this.emit('stopped', opts.end ? 'The owner ended the presentation.' : 'The slides were stopped; the bookmark is kept.')
  }

  /** The share stopped itself (stuck, contested, a fault): said, and the presentation stopped with its bookmark. */
  private shareProblem(event: PresentationEventKind, line: string): void {
    try {
      const was = this.state
      if (was === 'disposed' || was === 'ready' || was === 'stopped' || was === 'ended' || was === 'starting') return
      this.run++
      this.state = 'stopped'
      this.holding = null
      this.window = null
      this.view = null
      if (was === 'narrating') this.sayNow(line)
      else this.say(line)
      this.opts.host.marker('stopped sharing the slides')
      this.emit(event, event === 'stuck' ? 'The slides page stopped showing slides, so the share was stopped.' : 'The share had a problem, so it was stopped.')
    } catch (err) {
      this.fault('a share problem', err)
    }
  }

  // --- Narration ----------------------------------------------------------------------------------------------------

  /** Narration starts after the check: the presentation's clock, and started for the owner. */
  private beginNarration(): void {
    this.window = null
    this.everStarted = true
    this.emit('started', 'The presentation started.', this.resume.i)
    this.narrateFrom({})
  }

  /** Carries on from the bookmark, with the line its hold calls for. silent: no line (a detour that reached it). */
  private carryOn(opts: { silent?: boolean } = {}): void {
    const hold = this.holding
    const long = hold !== null && Date.now() - hold.since > this.timing.longHoldMs
    const back = this.backTo()
    let prefix: string | undefined
    if (!opts.silent && hold) {
      // From a detour (held there while it narrated it again), it says where it is going back to.
      if (hold.cause === 'talk' || hold.cause === 'deaf') prefix = (long || this.inDetour()) && back ? `${this.lines.carryOn} ${back}` : this.lines.carryOn
      else if (hold.cause === 'question' || hold.cause === 'page_away' || hold.cause === 'detour' || this.inDetour()) prefix = back
      else if (long) prefix = back
    }
    this.narrateFrom({ prefix })
  }

  /** "Back to <title>." for the slide narration carries on from, or nothing when it starts a slide afresh. */
  private backTo(): string | undefined {
    const at = this.resume
    const slide = this.slides[at.i]
    if (!slide || at.k >= slide.sentences.length) return undefined
    return slide.title ? `Back to ${slide.title}.` : `Back to slide ${slide.page}.`
  }

  /** Starts narrating as the session's turn: from the bookmark, or one detour slide (detour). */
  private narrateFrom(opts: { prefix?: string; detour?: number }): void {
    const run = ++this.run
    // Only the owner's own actions get here while the owner's pause stands (the room's are refused): they lift it.
    this.ownerPaused = false
    this.state = 'narrating'
    this.holding = null
    this.window = null
    this.detourRun = opts.detour !== undefined
    this.turn(signal => (opts.detour !== undefined ? this.narrateDetour(opts.detour, run, signal, opts.prefix) : this.narrate(run, signal, opts.prefix)))
  }

  private live(run: number, signal: AbortSignal): boolean {
    return run === this.run && this.state === 'narrating' && !signal.aborted
  }

  /** A slide fully heard moves the bookmark on: to the next narrated slide, or to questions after the last. */
  private normalise(): boolean {
    const slide = this.slides[this.resume.i]
    if (!slide || this.resume.k < slide.sentences.length) return true
    const next = this.nextNarrated(this.resume.i)
    if (next === null) return false
    this.resume = { i: next, k: 0 }
    this.furthest = Math.max(this.furthest, next)
    return true
  }

  private async narrate(run: number, signal: AbortSignal, prefix?: string): Promise<void> {
    let first = true
    while (this.live(run, signal)) {
      if (!this.normalise()) return this.toQuestions()
      const { i } = this.resume
      const slide = this.slides[i]
      await this.showSlide(i)
      if (!this.live(run, signal)) return
      // It never talks when it can't hear "please leave", or has no page: an owner's move shows the slide, and waits.
      if (await this.stopMuted(signal)) return
      if (first && prefix) {
        await this.sayLine(prefix, signal)
        if (!this.live(run, signal)) return
      }
      first = false
      if (this.resume.k === 0) {
        await sleep(this.timing.leadMs + slide.hold * 1000, signal)
        if (!this.live(run, signal)) return
      }
      for (let k = this.resume.k; k < slide.sentences.length; k++) {
        if (await this.stopMuted(signal)) return
        const said = await this.sayNarration(slide.sentences[k], signal, { i, k }, run)
        if (!this.live(run, signal) || !said) return
        this.resume = { i, k: k + 1 }
      }
      // The page plays the last of it, and then the room gets a moment: never a change while someone is talking.
      await this.until(() => !this.opts.host.playing(), signal)
      if (!this.live(run, signal)) return
      const last = slide.sentences.at(-1) ?? ''
      if (slide.pause > 0) {
        if (endsOnQuestion(last)) this.opts.host.openWindow(slide.pause * 1000)
        await sleep(slide.pause * 1000, signal)
        if (!this.live(run, signal)) return
      }
      await this.until(() => this.opts.host.quietMs() >= this.timing.slideQuietMs, signal)
      if (!this.live(run, signal)) return
      const next = this.nextNarrated(i)
      if (next === null) return this.toQuestions()
      this.resume = { i: next, k: 0 }
      this.furthest = Math.max(this.furthest, next)
    }
  }

  /**
   * Speech recognition was lost while narrating: held, and the page stopped at the end of the line it is playing now.
   * What went out after it is not heard, so narration carries on from there. Then the fixed line, once per loss, and
   * held until hearing is back. As the session's turn, which waits for that line's end (a clear there keeps the turn).
   */
  private async deafStop(signal: AbortSignal): Promise<void> {
    this.holdAs('deaf')
    await sleep(this.opts.host.lineLeftMs(), signal)
    if (signal.aborted) return
    this.opts.host.clear()
    // Hearing came back meanwhile: "Shall I carry on?" says enough.
    if (!this.deafPending) return
    this.deafPending = false
    await this.sayLine(this.lines.deaf, signal)
  }

  /** Why it may not talk now: it can't hear "please leave", or the camera page that plays its voice is away. */
  private mute(): 'deaf' | 'page_away' | null {
    if (this.deafNow) return 'deaf'
    if (!this.opts.host.attached()) return 'page_away'
    return null
  }

  /**
   * Narration stops here when it may not talk: the fixed line first if hearing was lost and it is still to be said,
   * otherwise held in silence. The tick resumes it once it can hear, or once the page is back. True: it stopped.
   */
  private async stopMuted(signal: AbortSignal): Promise<boolean> {
    if (this.deafPending) {
      await this.deafStop(signal)
      return true
    }
    const why = this.mute()
    if (why) this.holdAs(why)
    return why !== null
  }

  /**
   * For an owner's action while it may not talk: what was done, and when it carries on. Null when it may talk, or the
   * action changed nothing. resume: it was asked to resume. view: the slide on screen before the action.
   */
  private mutedNote(resume: boolean, view: number | null = null): { ok: boolean; note: string } | null {
    const why = this.mute()
    // Narration was started: it holds at its first step. A detour, or a move in questions, shows a slide and waits.
    const carries = this.state === 'narrating'
    if (!why || (!carries && this.view === view)) return null
    const [cannot, once] = why === 'deaf' ? ["it can't hear the meeting right now", 'once it can'] : ['its camera page is away', 'once the page is back']
    if (resume && carries) return { ok: false, note: `Not yet: ${cannot}, so it carries on ${once}.` }
    const at = this.slides[this.view ?? this.bookmark()]
    return { ok: true, note: `Slide ${at.page} is on screen, but ${cannot}, so it ${carries ? `carries on ${once}` : 'said nothing'}.` }
  }

  /** One detour slide narrated from its start (restart during a detour): the bookmark stays, and it is held after. */
  private async narrateDetour(i: number, run: number, signal: AbortSignal, prefix?: string): Promise<void> {
    const slide = this.slides[i]
    await this.showSlide(i)
    if (!this.live(run, signal)) return
    if (await this.stopMuted(signal)) return
    if (prefix) await this.sayLine(prefix, signal)
    await sleep(this.timing.leadMs + slide.hold * 1000, signal)
    for (let k = 0; k < slide.sentences.length && this.live(run, signal); k++) {
      if (await this.stopMuted(signal)) return
      if (!(await this.sayNarration(slide.sentences[k], signal, undefined, run))) return
    }
    if (this.live(run, signal)) this.holdAs('detour')
  }

  /** After the last narrated slide: questions, with that slide still up. */
  private toQuestions(): void {
    if (this.state !== 'narrating') return
    this.state = 'qa'
    this.finished = true
    this.lastActivity = Date.now()
    this.emit('finished', 'The last slide has been presented: questions now, with it still on screen.')
  }

  /** A narration sentence, with one retry after a failed voice; then the kept line and a voice hold. False: stop. */
  private async sayNarration(text: string, signal: AbortSignal, tag: NarrationTag | undefined, run: number): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        const complete = await this.opts.host.say(text, signal, tag)
        // Not all of it went out (the page went as it was said): not heard, so the bookmark stays at it.
        if (!complete && !signal.aborted && run === this.run) this.holdAs(this.mute() ?? 'page_away')
        return complete && !signal.aborted
      } catch (err) {
        if (signal.aborted || run !== this.run) return false
        console.error(`[slides] bot ${this.opts.botId ?? '-'}: a sentence could not be said (${errorKind(err)})`)
        if (attempt === 1) {
          await sleep(this.timing.voiceRetryMs, signal)
          if (!this.live(run, signal)) return false
          continue
        }
        this.holdAs('voice')
        // The kept line plays without ElevenLabs.
        await this.sayLine(this.lines.voice, signal)
        this.emit('voice_failed', "The voice failed twice, so the slides are paused until someone says carry on, or you resume.")
        return false
      }
    }
  }

  /** A line, its failure only logged. */
  private async sayLine(text: string, signal: AbortSignal): Promise<void> {
    try {
      await this.opts.host.say(text, signal)
    } catch (err) {
      if (!signal.aborted) console.error(`[slides] bot ${this.opts.botId ?? '-'}: a line could not be said (${errorKind(err)})`)
    }
  }

  /** Shows slide i (unless on screen), waits for the page to say it is shown (at most a few seconds), and marks it. */
  private async showSlide(i: number): Promise<void> {
    if (this.view === i) return
    this.view = i
    const shown = await this.shared<'shown' | 'timeout'>(() => this.opts.surface.show(i, this.neighbours(i)), 'timeout')
    if (this.view === i && this.state !== 'disposed') this.markShown(i, shown === 'shown')
  }

  private markShown(i: number, confirmed: boolean): void {
    const slide = this.slides[i]
    this.opts.host.marker(`showing slide ${slide.page}${slide.title ? `: ${slide.title}` : ''}${confirmed ? '' : ' (not confirmed)'}`, slide.page)
  }

  /** What to send after slide i: the one before it and the next narrated one, and the bookmark's during a detour. */
  private neighbours(i: number): number[] {
    const next = this.nextNarrated(i)
    const around = [i - 1, ...(next === null ? [] : [next])]
    if (i !== this.resume.i) around.push(this.resume.i)
    return around.filter(n => n >= 0 && n < this.slides.length && n !== i)
  }

  private inDetour(): boolean {
    return this.view !== null && this.view !== this.resume.i && (this.state === 'held' || this.detourRun)
  }

  // --- Holds, windows and the tick --------------------------------------------------------------------------------

  private holdAs(cause: HoldCause): void {
    if (this.state === 'checking' || this.state === 'narrating') {
      this.run++
      this.state = 'held'
      this.holding = { cause, since: Date.now(), asked: false, told: false }
      this.window = null
      return
    }
    if (this.state !== 'held') return
    // The same cause again changes nothing: "Shall I carry on?" is still asked only once.
    if (!this.holding || PRIORITY[cause] > PRIORITY[this.holding.cause]) {
      const since = this.holding?.since ?? Date.now()
      this.holding = { cause, since, asked: false, told: this.holding?.told ?? false }
    }
  }

  /** Waits until ok() holds, or the signal aborts. */
  private async until(ok: () => boolean, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !ok()) await sleep(this.timing.tickMs, signal)
  }

  /** A call to the share, which never throws or rejects here: a failure is logged as its kind, and gives the fallback. */
  private shared<T>(call: () => Promise<T>, fallback: T): Promise<T> {
    return Promise.resolve()
      .then(call)
      .catch(err => {
        console.error(`[slides] bot ${this.opts.botId ?? '-'}: the share failed (${errorKind(err)})`)
        return fallback
      })
  }

  /** Runs work as the session's turn, catching what it throws. */
  private turn(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return this.opts.host
      .runTurn(async signal => {
        try {
          await work(signal)
        } catch (err) {
          if (!signal.aborted) this.fault('narration', err)
        }
      })
      .catch(err => this.fault('a turn', err))
  }

  /**
   * Says a line: while narrating, between two sentences, and narration then carries on where it was; otherwise once the
   * session is free (an answer it is giving is never cut for it).
   */
  private say(text: string): void {
    if (this.state === 'narrating' && !this.detourRun) return this.narrateFrom({ prefix: text })
    if (this.opts.host.free()) this.sayNow(text)
    else this.queued.push(text)
  }

  /** Says a line now, as the session's turn: whatever it was saying stops. */
  private sayNow(text: string): void {
    this.turn(signal => this.sayLine(text, signal))
  }

  /** Looks at what the presenter is waiting for: resumes, its questions, windows, and the end of questions. */
  private tick(): void {
    try {
      if (this.state === 'disposed') return
      const now = Date.now()
      const host = this.opts.host
      if (this.queued.length && host.free() && this.state !== 'narrating') return this.sayNow(this.queued.shift()!)
      if (this.window && now >= this.window.until) {
        // Silence is a yes, once the room is quiet: someone mid-sentence may still be answering.
        if (host.quietMs() === 0) return
        const kind = this.window.kind
        this.window = null
        if (kind === 'can_see' && this.state === 'checking') return this.beginNarration()
        if (kind === 'carry_on' && this.state === 'held' && (this.holding?.cause === 'talk' || this.holding?.cause === 'deaf') && !this.deafNow) return this.carryOn()
      }
      if (this.state === 'checking') return this.checkTick(now)
      if (this.state === 'qa') {
        // Quiet, so it needs neither hearing nor the page: only no turn running (an answer resets lastActivity).
        if (now - this.lastActivity >= this.timing.qaIdleMs && !host.busy()) {
          this.lastActivity = now
          void this.stopFlow({ quiet: true }).catch(err => this.fault('stopping after questions', err))
        }
        return
      }
      if (this.state !== 'held' || !this.holding) return
      const hold = this.holding
      if (!hold.told && now - hold.since >= this.timing.heldLongMs) {
        hold.told = true
        this.emit('held_long', `The slides have been held for over ${Math.round(this.timing.heldLongMs / 60_000)} minutes (${hold.cause}).`)
      }
      if (!host.free() || this.window) return
      if (hold.cause === 'question') {
        if (!host.windowOpen() && !host.playing() && host.quietMs() >= this.timing.questionQuietMs) this.carryOn()
      } else if (hold.cause === 'page_away') {
        if (this.pageBackAt && now - this.pageBackAt >= this.timing.pageBackMs) this.carryOn()
      } else if ((hold.cause === 'talk' && host.quietMs() >= this.timing.talkQuietMs) || (hold.cause === 'deaf' && !this.deafNow)) {
        if (!hold.asked && !host.playing()) this.askCarryOn(hold)
      }
    } catch (err) {
      this.fault('the tick', err)
    }
  }

  private checkTick(now: number): void {
    const host = this.opts.host
    if (this.canSeeAt && now >= this.canSeeAt && host.free()) {
      this.canSeeAt = 0
      this.checked = true
      const asking = ++this.run
      this.turn(async signal => {
        await this.sayLine(this.lines.canSee, signal)
        if (signal.aborted || asking !== this.run || this.state !== 'checking') return
        this.canSeeAsked = Date.now()
        this.window = { kind: 'can_see', until: Date.now() + this.timing.canSeeWindowMs }
        host.openWindow(this.timing.canSeeWindowMs)
      })
      return
    }
    // Quiet for a while after the line has played: they can see it.
    if (this.canSeeAsked && !host.playing() && host.free() && host.quietMs() >= this.timing.canSeeQuietMs && now - this.canSeeAsked >= this.timing.canSeeQuietMs) {
      this.beginNarration()
    }
  }

  /** "Shall I carry on?", once per hold, with a window in which yes, no or silence decides. */
  private askCarryOn(hold: Hold): void {
    hold.asked = true
    const run = this.run
    this.turn(async signal => {
      await this.sayLine(this.lines.shallCarryOn, signal)
      if (signal.aborted || run !== this.run || this.state !== 'held' || this.holding !== hold) return
      this.window = { kind: 'carry_on', until: Date.now() + this.timing.carryOnWindowMs }
      this.opts.host.openWindow(this.timing.carryOnWindowMs)
    })
  }

  // --- Slides in order ----------------------------------------------------------------------------------------------

  private firstNarrated(): number {
    const i = this.slides.findIndex(s => !s.onRequest)
    return i < 0 ? 0 : i
  }

  private lastNarrated(): number {
    for (let i = this.slides.length - 1; i >= 0; i--) if (!this.slides[i].onRequest) return i
    return Math.max(0, this.slides.length - 1)
  }

  private nextNarrated(i: number): number | null {
    for (let j = i + 1; j < this.slides.length; j++) if (!this.slides[j].onRequest) return j
    return null
  }

  // --- Events and faults --------------------------------------------------------------------------------------------

  private emit(event: PresentationEventKind, note: string, at: number | null = this.view ?? this.resume.i): void {
    const slide = at === null ? undefined : this.slides[at]
    const message: PresentationEvent = { event, of: this.slides.length, note, ...(slide ? { slide: slide.page, title: slide.title } : {}) }
    console.log(`[slides] bot ${this.opts.botId ?? '-'}: ${event} (${this.state})`)
    for (const fn of this.listeners) {
      try {
        fn(message)
      } catch (err) {
        console.error(`[slides] bot ${this.opts.botId ?? '-'}: an event listener failed (${errorKind(err)})`)
      }
    }
  }

  /** A fault of the presenter's own: logged as its kind only, and narration held, never thrown on. */
  private fault(what: string, err: unknown): void {
    console.error(`[slides] bot ${this.opts.botId ?? '-'}: ${what} failed (${errorKind(err)})`)
    try {
      if (this.state === 'narrating' || this.state === 'checking') {
        this.holdAs('voice')
        this.emit('voice_failed', 'The presentation hit a fault of its own, so it is paused until someone says carry on, or you resume.')
      }
    } catch {
      // Nothing more to do: the meeting goes on.
    }
  }
}
